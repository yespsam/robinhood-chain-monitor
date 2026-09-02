import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AlertDeliveryError,
  alertEventKey,
  classifyAlertFreshness,
  drainAlertOutbox,
  focusNoveltyKeys,
  isActionableLaunchpadCandidate,
  isBscLaunchpadEvent,
  isImportantRobinhoodEvent,
  isRelevantAlert,
  isStrongAlert,
  isTerminalAlertSuppression,
  officialTokenDedupKey,
  ponFunNoveltyKeys,
  sendAlerts,
  startAlertOutboxWorker,
  telegramButtons,
} from "../src/alerts.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";

function publicTelegramNewsEvent({
  messageId = "271828",
  contentDigest = "a".repeat(64),
  sourceOccurredAt = new Date().toISOString(),
  news = {},
  ...overrides
} = {}) {
  const canonicalMessageId = String(messageId);
  return {
    type: "telegram_news_update",
    eventKey: `telegram-news:-1002540748528:${canonicalMessageId}:${contentDigest.slice(0, 16)}`,
    chatId: "-1002540748528",
    username: "maxguruai",
    messageId,
    messageUrl: `https://t.me/maxguruai/${canonicalMessageId}`,
    sourceOccurredAt,
    observedAt: new Date().toISOString(),
    contentDigest,
    strong: false,
    sourceTrust: "public_telegram_observed",
    channel: {
      chatId: "-1002540748528",
      username: "maxguruai",
      title: "Max Guru AI",
      visibility: "public",
    },
    source: {
      id: "telegram_public_channel",
      trust: "public_telegram_observed",
      url: "https://t.me/s/maxguruai",
    },
    news: {
      category: "crypto",
      headline: "Flap introduces Vault V2",
      summary: "The public channel observed a Flap Vault V2 update.",
      externalUrls: ["https://example.com/flap-vault-v2"],
      storyKey: "flap:vault-v2",
      confidence: "observed",
      ...news,
    },
    ...overrides,
  };
}

test("Telegram public news stays ordinary and deduplicates only exact message revisions", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-telegram-news-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    telegramNewsMonitorEnabled: true,
    telegramStrongAlerts: true,
    alertChineseTranslationEnabled: false,
  };
  const first = publicTelegramNewsEvent({
    // Even hostile producer-supplied first-party metadata must not enter the
    // official canonical novelty namespace.
    platform: { id: "flap", name: "Flap" },
    canonicalSignalId: "flap:concept:vault:v2",
    canonicalSignalIds: ["flap:concept:vault:v2"],
  });
  const originalFirst = structuredClone(first);
  const eventId = "telegram-news:-1002540748528:271828:aaaaaaaaaaaaaaaa";

  assert.equal(alertEventKey(first), eventId);
  assert.equal(isRelevantAlert(first), true);
  assert.equal(isStrongAlert({ ...first, strong: true }), false, "this source can never become a strong alert");
  assert.deepEqual(focusNoveltyKeys(first), []);
  assert.deepEqual(telegramButtons(first), {
    inline_keyboard: [[{ text: "查看原消息", url: "https://t.me/maxguruai/271828" }]],
  });
  assert.deepEqual(telegramButtons({ ...first, messageUrl: "https://evil.example/message" }), { inline_keyboard: [] });

  const delivered = await sendAlerts(config, first);
  assert.equal(delivered.status, "delivered");
  assert.deepEqual(first, originalFirst, "queue metadata and rendering must not mutate the source event");
  assert.equal(delivered.eventId, eventId);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].disable_notification, true);
  assert.deepEqual(payloads[0].reply_markup.inline_keyboard, [[{
    text: "查看原消息",
    url: "https://t.me/maxguruai/271828",
  }]]);
  assert.match(payloads[0].text, /Telegram 公共频道新闻/);
  assert.match(payloads[0].text, /非官方来源/);

  const exactRepeat = await sendAlerts(config, structuredClone(first));
  assert.equal(exactRepeat.status, "delivered");
  assert.equal(exactRepeat.eventId, eventId);
  assert.equal(payloads.length, 1, "the exact same message revision is idempotent");

  const revision = publicTelegramNewsEvent({
    contentDigest: "b".repeat(64),
    news: { summary: "The public channel edited the same message with additional details." },
  });
  assert.equal((await sendAlerts(config, revision)).status, "delivered");
  assert.equal(payloads.length, 2, "an actual content edit is a distinct revision");

  const official = {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh" },
    changes: { newModules: ["Vault V2"] },
    observedAt: new Date().toISOString(),
    url: "https://docs.flap.sh/vault-v2",
  };
  assert.equal((await sendAlerts(config, official)).status, "delivered", "public-channel news must not suppress an official source");
  assert.equal(payloads.length, 3);

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.deepEqual(outbox.events[eventId].event.canonicalSignalIds, []);
  assert.equal(outbox.events[eventId].event.canonicalSignalId, null);
  assert.equal(outbox.events[eventId].semanticDuplicateOf, null);
  const revisionId = "telegram-news:-1002540748528:271828:bbbbbbbbbbbbbbbb";
  assert.equal(outbox.events[revisionId].semanticDuplicateOf, null);
});

test("Telegram news freshness uses source time with 10-minute realtime and 2-hour maximum windows", () => {
  const event = publicTelegramNewsEvent({ sourceOccurredAt: "2026-08-24T04:00:00.000Z" });
  const realtime = classifyAlertFreshness({}, event, "2026-08-24T04:10:00.000Z");
  const late = classifyAlertFreshness({}, event, "2026-08-24T06:00:00.000Z");
  const suppressed = classifyAlertFreshness({}, event, "2026-08-24T06:00:00.001Z");

  assert.equal(realtime.scope, "telegram_news");
  assert.equal(realtime.basis, "sourceOccurredAt");
  assert.equal(realtime.decision, "realtime");
  assert.equal(realtime.lagMs, 600_000);
  assert.equal(late.decision, "late");
  assert.equal(suppressed.decision, "suppress");
  assert.equal(isStrongAlert({ ...event, freshness: late }), false);
});

test("Binance connector and SDK code noise is filtered unless the producer proves a product feature", () => {
  const base = {
    type: "github_module_update",
    repository: "binance/binance-connector-go",
    launchpad: "Binance",
    sourceTrust: "official_verified",
    modeChange: { candidate: false },
  };
  const maintenance = {
    ...base,
    strong: false,
    binanceChange: { scheme: "binance_connector_diff_v1", classification: "sdk_maintenance", substantive: false, productFeature: false },
  };
  const schema = {
    ...base,
    strong: true,
    binanceChange: { scheme: "binance_connector_diff_v1", classification: "api_or_schema_change", substantive: true, productFeature: false },
  };
  assert.equal(isRelevantAlert(maintenance), false);
  assert.equal(isStrongAlert(maintenance), false);
  assert.equal(isRelevantAlert(schema), false);
  assert.equal(isStrongAlert(schema), false);
  const productFeature = {
    ...base,
    strong: true,
    binanceChange: { scheme: "binance_connector_diff_v1", classification: "product_feature", substantive: true, productFeature: true },
  };
  assert.equal(isRelevantAlert(productFeature), true);
  assert.equal(isStrongAlert(productFeature), true);
});

test("central Binance relevance admits announcement classes and only genuine developer product features", () => {
  const source = {
    id: "binance_exchange_cms",
    url: "https://www.binance.com/en/support/announcement/example",
  };
  for (const category of ["新币上线", "新合约上线", "Alpha 上新", "活动公告", "普通公告", "产品更新"]) {
    assert.equal(isRelevantAlert({
      type: "binance_official_update",
      kind: "announcement",
      title: `Binance ${category}`,
      signal: { category, relevant: true },
      source,
    }), true, category);
  }

  const developerBase = {
    type: "binance_official_update",
    kind: "developer_update",
    source: { id: "binance_developer_docs", url: "https://developers.binance.com/en/docs/products/wallet/change-log.md" },
  };
  assert.equal(isRelevantAlert({
    ...developerBase,
    developerChange: { classification: "product_feature", productFeature: true },
  }), true);
  assert.equal(isRelevantAlert({
    ...developerBase,
    developerChange: { classification: "sdk_maintenance", productFeature: false },
  }), false);
});

test("focus3 merges the same official Binance feature across CMS and X", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-binance-cross-source-"));
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: telegramCalls } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    binanceMonitorEnabled: true,
    alertChineseTranslationEnabled: false,
  };
  const cms = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:cross-source-web3-api",
    project: { id: "binance-wallet", name: "Binance Wallet" },
    signal: { relevant: true, strong: true, scope: "wallet", labels: ["Wallet API/开发能力"] },
    title: "Binance Wallet introduces a new Web3 API module",
    source: { id: "binance_wallet_cms", url: "https://www.binance.com/en/support/announcement/cross-source-web3-api" },
    url: "https://www.binance.com/en/support/announcement/cross-source-web3-api",
    publishedAt: now,
    observedAt: now,
    strong: true,
  };
  const x = {
    type: "twitter_update",
    project: {
      id: "binance-wallet",
      name: "Binance Wallet",
      handle: "BinanceWallet",
      twitter: "https://x.com/BinanceWallet",
      xUserId: "1400391752368992260",
      match: "official_x",
      signalProfile: "binance",
    },
    tweet: {
      id: "2085000000000000000",
      handle: "BinanceWallet",
      text: "A new Binance Wallet Web3 API module is now live",
      createdAt: now,
      url: "https://x.com/BinanceWallet/status/2085000000000000000",
    },
    signal: { relevant: true, strong: true, labels: ["Wallet API/开发能力"] },
    observedAt: now,
  };
  assert.equal((await sendAlerts(config, cms)).status, "delivered");
  const duplicate = await sendAlerts(config, x);
  assert.equal(duplicate.status, "suppressed");
  assert.equal(duplicate.disposition, "terminal");
  assert.equal(duplicate.terminal, true);
  assert.equal(isTerminalAlertSuppression(duplicate), true);
  assert.equal(telegramCalls, 1);
});

test("Agent Native dedup keeps docs and launch stages distinct while filtering unrelated developer noise", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-binance-agent-native-dedup-"));
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: telegramCalls } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    binanceMonitorEnabled: true,
    alertChineseTranslationEnabled: false,
  };
  const developer = (eventKey, addedSignals) => ({
    type: "binance_official_update",
    kind: "developer_update",
    eventKey,
    project: { id: "binance", name: "Binance", website: "https://www.binance.com", twitter: "https://x.com/binance" },
    title: "Developer 文档目录 官方更新",
    signal: {
      category: addedSignals.some((item) => /Agent|MCP/i.test(item)) ? "agent_native" : "官方开发文档",
      relevant: true,
      strong: true,
    },
    addedSignals,
    keyChanges: addedSignals,
    comparisonBasis: "exact_snapshot",
    source: { id: "binance_developer_docs", name: "Binance Developer 官方文档", url: "https://developers.binance.com/en/docs/llms.txt" },
    url: "https://developers.binance.com/en/docs/llms.txt",
    observedAt: now,
    strong: true,
  });
  const docs = developer("binance-developer:agent-mcp", ["[Binance MCP Server](/en/docs/agent-native/mcp-server/agentic.md)"]);
  const x = {
    type: "twitter_update",
    project: { id: "binance", name: "Binance", handle: "binance", twitter: "https://x.com/binance", xUserId: "877807935493033984", match: "official_x", signalProfile: "binance" },
    tweet: { id: "2090380033013764166", handle: "binance", text: "Meet Agent OS - a new way to build, deploy and use AI agents on Binance.", createdAt: now, url: "https://x.com/binance/status/2090380033013764166" },
    signal: { relevant: true, strong: true, labels: ["Agent OS"] },
    observedAt: now,
  };
  const cms = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:agent-os-launch",
    project: { id: "binance", name: "Binance" },
    title: "Binance Agent OS officially launched and is now available",
    keyChanges: ["Agent OS officially launched"],
    source: { id: "binance_exchange_cms", url: "https://www.binance.com/en/support/announcement/agent-os-launch" },
    url: "https://www.binance.com/en/support/announcement/agent-os-launch",
    publishedAt: now,
    observedAt: now,
    strong: true,
  };
  const unrelated = developer("binance-developer:websocket", ["Spot WebSocket API added session.logon"]);

  assert.equal((await sendAlerts(config, docs)).status, "delivered");
  assert.equal((await sendAlerts(config, x)).status, "delivered", "a formal launch must not be hidden by an earlier docs entry");
  const duplicate = await sendAlerts(config, cms);
  assert.equal(duplicate.status, "suppressed", "the same launch stage should merge across official sources");
  assert.equal(duplicate.reason, "semantic_duplicate");
  const unrelatedResult = await sendAlerts(config, unrelated);
  assert.equal(unrelatedResult.status, "suppressed", "ordinary Developer API deltas are outside the requested Binance scope");
  assert.equal(unrelatedResult.reason, "not_relevant");
  assert.equal(telegramCalls, 2);
});

test("focus3 assigns stable cross-source novelty ids and sends only the first source", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-novelty-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const github = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-skills",
    sourceTrust: "official_verified",
    commit: "vault-v2-first",
    committedAt: new Date().toISOString(),
    message: "feat: add Vault V2 module",
    files: [{ filename: "contracts/VaultV2.sol", status: "added", additions: 10, deletions: 0 }],
    modeChange: { candidate: true },
    newContracts: [],
    url: "https://github.com/flap-sh/flap-skills/commit/vault-v2-first",
  };
  const twitter = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { id: "vault-v2-announce", handle: "flapdotsh", text: "Flap adds a new Vault V2 module", createdAt: new Date().toISOString(), url: "https://x.com/flapdotsh/status/vault-v2-announce" },
    signal: { relevant: true, strong: true, platformStructural: true, labels: ["新发射/新模式"] },
  };
  assert.ok(focusNoveltyKeys(github).some((key) => key === "flap:concept:vault:v2"));
  assert.ok(focusNoveltyKeys(twitter).some((key) => key === "flap:concept:vault:v2"));
  assert.equal((await sendAlerts(config, github)).status, "delivered");
  const duplicate = await sendAlerts(config, twitter);
  assert.equal(duplicate.status, "suppressed");
  assert.equal(payloads.length, 1);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const duplicateEntry = outbox.events[duplicate.eventId];
  assert.equal(duplicateEntry.destinations.telegram.disabledReason, "semantic_duplicate");
  assert.equal(duplicateEntry.semanticDuplicateOf, "github:flap-sh/flap-skills:vault-v2-first");
});

test("Flap Vault subtypes stay independent and deduplicate the same subtype across official sources", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-flap-vault-subtypes-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const capability = (subtype) => ({
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh" },
    changes: { newModules: [`Vault ${subtype}`] },
    observedAt: now,
    url: "https://flap.sh/board",
  });
  const index = capability("INDEX");
  const staking = capability("STAKING");
  const github = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/FlapVaultExample",
    sourceTrust: "official_verified",
    commit: "staking-vault-module",
    committedAt: now,
    message: "feat: add VaultStaking module",
    files: [{ filename: "src/VaultStaking.sol", status: "added" }],
    modeChange: { candidate: true },
  };
  const twitter = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { id: "staking-vault-x", handle: "flapdotsh", text: "Flap launches the STAKING Vault", createdAt: now },
    signal: { relevant: true, strong: true, platformStructural: true, labels: ["新发射/新模式"] },
  };

  assert.deepEqual(focusNoveltyKeys(index), ["flap:concept:vault:index"]);
  assert.deepEqual(focusNoveltyKeys(staking), ["flap:concept:vault:staking"]);
  assert.deepEqual(focusNoveltyKeys(capability("NFT")), ["flap:concept:vault:nft"]);
  assert.deepEqual(focusNoveltyKeys(capability("DISTRIBUTION")), ["flap:concept:vault:distribution"]);
  assert.deepEqual(focusNoveltyKeys(github), ["flap:concept:vault:staking"]);
  assert.deepEqual(focusNoveltyKeys(twitter), ["flap:concept:vault:staking"]);

  const deliveredIndex = await sendAlerts(config, index);
  assert.equal(deliveredIndex.status, "delivered");
  await mutateOutboxEntry(dataDir, deliveredIndex.eventId, (entry) => {
    entry.event.canonicalSignalId = "flap:concept:vault";
    entry.event.canonicalSignalIds = ["flap:concept:vault"];
  });
  assert.equal((await sendAlerts(config, staking)).status, "delivered", "a legacy INDEX key must not hide STAKING");
  assert.equal((await sendAlerts(config, github)).status, "delivered", "every distinct GitHub revision remains alertable");
  assert.equal((await sendAlerts(config, twitter)).status, "suppressed");
  assert.equal(payloads.length, 3);
});

test("GitHub revisions use structured delta novelty while exact event keys remain idempotent", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-github-revision-delta-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    telegramStrongAlerts: true,
    alertChineseTranslationEnabled: false,
  };
  const github = (repository, commit, changeEvidence, files) => ({
    type: "github_module_update",
    launchpad: "Flap",
    repository,
    sourceTrust: "official_verified",
    commit,
    headCommit: commit.replace("revision-", "head-"),
    committedAt: now,
    message: "feat: update launcher module",
    files,
    changeEvidence,
    modeChange: { candidate: true },
    developmentStage: "pull_request",
    pullRequest: { number: 42, state: "open", authorAssociation: "NONE" },
    url: `https://github.com/${repository}/commit/${commit}`,
  });
  const first = github(
    "flap-sh/contracts",
    "revision-one",
    [{ file: "contracts/Launcher.sol", kind: "function", subject: "launch", before: "launch()", after: "launch(address quote)" }],
    [{ filename: "contracts/Launcher.sol", status: "modified", additions: 2, deletions: 1 }],
  );
  const second = github(
    "flap-sh/contracts",
    "revision-two",
    [{ subject: "launch", after: "launch(address quote, uint256 tax)", file: "contracts/Launcher.sol", before: "launch(address quote)", kind: "function" }],
    [{ deletions: 1, additions: 3, status: "changed", filename: "./contracts/Launcher.sol" }],
  );
  const otherRepository = github(
    "flap-sh/router",
    "revision-three",
    [{ file: "src/Router.sol", kind: "config_value", subject: "factory", before: "v1", after: "v2" }],
    [{ filename: "src/Router.sol", status: "added", additions: 9, deletions: 0 }],
  );

  const firstResult = await sendAlerts(config, first);
  const secondResult = await sendAlerts(config, second);
  const thirdResult = await sendAlerts(config, otherRepository);
  assert.equal(firstResult.status, "delivered");
  assert.equal(secondResult.status, "delivered", "a same-title commit with a different structured delta must deliver");
  assert.equal(thirdResult.status, "delivered", "a different repository, commit, and delta must deliver");
  assert.equal(payloads.length, 3);
  assert.ok(payloads.every((payload) => payload.disable_notification === true), "untrusted open PRs are ordinary notifications");

  const exactRepeat = await sendAlerts(config, second);
  assert.equal(exactRepeat.status, "delivered");
  assert.equal(exactRepeat.eventId, secondResult.eventId);
  assert.equal(payloads.length, 3, "an exact event key must not send twice");

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entries = [firstResult, secondResult, thirdResult].map((result) => outbox.events[result.eventId]);
  const githubKeys = entries.map((entry) => entry.event.canonicalSignalIds.find((key) => key.startsWith("github:update:")));
  assert.ok(githubKeys.every((key) => /^github:update:[a-f0-9]{32}$/.test(key)));
  assert.equal(new Set(githubKeys).size, 3);
  assert.ok(entries.every((entry) => entry.semanticDuplicateOf === null));
  assert.equal(outbox.events[secondResult.eventId].duplicateCount, 1);
});

test("Flap quote-token prose and structured pools receive stable identities and a bilingual pool card", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-flap-new-pool-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const translationFetch = async (url) => {
    const parsed = new URL(url);
    const source = parsed.searchParams.get("q");
    const translated = parsed.searchParams.get("tl") === "zh-CN"
      ? `${source} 中文`
      : source
        .replaceAll("官方能力更新", "official capability update")
        .replaceAll("具体更新", "Update")
        .replaceAll("新底池", "NEW POOL")
        .replaceAll("状态", "Status")
        .replaceAll("官方页面已记录；链上部署/实际启用尚未确认", "Official page recorded; on-chain activation is not independently verified")
        .replaceAll("时间", "Time");
    return { ok: true, status: 200, text: async () => JSON.stringify([[[translated, "source"]], null, "auto"]) };
  };
  const factory = "0x1111111111111111111111111111111111111111";
  const quoteAddress = "0x2222222222222222222222222222222222222222";
  const twitter = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: {
      id: "babab-quote-x",
      handle: "flapdotsh",
      text: "FLAP Quote Token updates on @BNBCHAIN\n\nBABAB is now live on Flap.",
      createdAt: new Date().toISOString(),
    },
    signal: {
      relevant: true,
      strong: true,
      platformStructural: true,
      labels: ["税收/募资/报价代币"],
      headline: "FLAP Quote Token updates on @BNBCHAIN",
      keyChanges: ["BABAB is now live on Flap."],
    },
  };
  const event = {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh", twitter: "https://x.com/flapdotsh" },
    changes: {
      newFlapPools: [
        { identity: `vault:STAKING:${factory}`, kind: "vault_factory", category: "STAKING", vaultFactory: factory, quoteAddress: null, quoteSymbol: null, sourceUrl: "https://flap.sh/board" },
        { identity: `quote:${quoteAddress}`, kind: "quote_asset", category: null, vaultFactory: null, quoteAddress, quoteSymbol: "BABAB", sourceUrl: "https://flap.sh/board" },
      ],
    },
    observedAt: new Date().toISOString(),
    url: "https://flap.sh/board",
  };
  const before = structuredClone(event);
  const poolKeys = focusNoveltyKeys(event);

  assert.deepEqual(focusNoveltyKeys(twitter), ["flap:quote:babab"]);
  assert.ok(poolKeys.includes(`flap:pool:staking:factory:${factory}`));
  assert.ok(poolKeys.includes(`flap:pool:quote-asset:quote:${quoteAddress}`));
  assert.ok(poolKeys.includes("flap:quote:babab"));
  assert.ok(poolKeys.includes(`flap:quote-address:${quoteAddress}`));
  assert.notDeepEqual(poolKeys, focusNoveltyKeys({
    ...event,
    changes: { newFlapPools: [{ kind: "quote_asset", category: null, vaultFactory: null, quoteAddress: "0x3333333333333333333333333333333333333333", quoteSymbol: "OTHER" }] },
  }));
  assert.equal(isStrongAlert(event), true);

  const result = await sendAlerts({
    ...alertConfig(dataDir),
    ponsMonitorEnabled: false,
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationFetchImpl: translationFetch,
    alertTranslationTimeoutMs: 3_000,
  }, event);
  assert.equal(result.status, "delivered");
  assert.deepEqual(event, before, "rendering and semantic identity must not mutate the source event");
  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  assert.match(payload.text, /^🔴 强提醒 \| STRONG ALERT/);
  assert.match(payload.text, /🇨🇳 中文[\s\S]*新增 STAKING Vault Factory 登记；具体用途与链上启用待核/);
  assert.doesNotMatch(payload.text.split("🇬🇧 English")[0], /\/\s*NEW POOL/);
  assert.match(payload.text, /🇬🇧 English[\s\S]*Registered a STAKING Vault Factory; its purpose and on-chain activation remain unverified/i);
  assert.equal(payload.text.split(factory).length - 1, 2, "Factory remains byte-for-byte in both language blocks");
  assert.equal(payload.text.split(quoteAddress).length - 1, 2, "Quote address remains byte-for-byte in both language blocks");
  const buttons = payload.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.text === "📋 复制底池 Factory" && button.copy_text?.text === factory));
  assert.ok(buttons.some((button) => button.text === "📋 复制报价合约" && button.copy_text?.text === quoteAddress));

  const nextQuote = "0x4444444444444444444444444444444444444444";
  const updatedEvent = {
    ...event,
    observedAt: new Date(Date.now() + 1_000).toISOString(),
    changes: {
      updatedFlapPools: [{
        identity: `vault:STAKING:${factory}`,
        kind: "vault_factory",
        category: "STAKING",
        vaultFactory: factory,
        quoteAddress: nextQuote,
        sourceUrl: "https://flap.sh/board",
      }],
      flapPoolChanges: [{
        identity: `vault:STAKING:${factory}`,
        before: { kind: "vault_factory", category: "STAKING", vaultFactory: factory, quoteAddress },
        after: { kind: "vault_factory", category: "STAKING", vaultFactory: factory, quoteAddress: nextQuote },
      }],
    },
  };
  const updatedResult = await sendAlerts({
    ...alertConfig(dataDir),
    ponsMonitorEnabled: false,
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationFetchImpl: translationFetch,
    alertTranslationTimeoutMs: 3_000,
  }, updatedEvent);
  assert.equal(updatedResult.status, "delivered", "a structured update has its own semantic revision identity");
  assert.equal(payloads.length, 2);
  assert.match(payloads[1].text, new RegExp(`STAKING Quote ${quoteAddress}→${nextQuote}`));
  assert.ok(payloads[1].text.split(quoteAddress).length - 1 >= 2, "old quote remains in both language blocks");
  assert.ok(payloads[1].text.split(nextQuote).length - 1 >= 2, "new quote remains in both language blocks");
  assert.ok(payloads[1].reply_markup.inline_keyboard.flat()
    .some((button) => button.text === "📋 复制报价合约" && button.copy_text?.text === nextQuote));
});

test("focus3 keeps distinct feature activations alertable and deduplicates repeats of the same activation", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-activation-lane-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const announcement = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-skills",
    sourceTrust: "official_verified",
    commit: "vault-v3-announcement",
    committedAt: now,
    message: "feat: add Vault V3 module",
    modeChange: { candidate: true },
  };
  const activation = (eventKey, token, featureActivationKey) => ({
    type: "bsc_launchpad_update",
    kind: "new_mode",
    eventKey,
    featureActivationKey,
    platform: { id: "flap", name: "Flap", trust: "official_verified" },
    mode: { fingerprint: "vault-v3-mode", componentMode: "Vault V3" },
    tokens: [{ token, metadata: { name: "First Vault Token", symbol: "FVT" } }],
    structural: { eligible: true },
    strong: true,
    blockTimestamp: now,
    observedAt: now,
  });

  const firstActivation = activation(
    "bsc-mode:flap:vault-v3:first",
    "0x1111111111111111111111111111111111111111",
    "template:5724:vault-v3-revision-a",
  );
  const repeatedActivation = activation(
    "bsc-mode:flap:vault-v3:repeat",
    "0x2222222222222222222222222222222222222222",
    firstActivation.featureActivationKey,
  );
  const secondActivation = activation(
    "bsc-mode:flap:vault-v3:second-activation",
    "0x3333333333333333333333333333333333333333",
    "template:5724:vault-v3-revision-b",
  );
  const repeatedSecondActivation = activation(
    "bsc-mode:flap:vault-v3:second-repeat",
    "0x4444444444444444444444444444444444444444",
    secondActivation.featureActivationKey,
  );
  assert.deepEqual(focusNoveltyKeys(announcement), ["flap:concept:vault:v3"]);
  const firstKeys = focusNoveltyKeys(firstActivation);
  const secondKeys = focusNoveltyKeys(secondActivation);
  assert.ok(firstKeys.includes("flap:concept:vault:v3"));
  assert.ok(firstKeys.some((key) => key.startsWith("flap:feature-activation:")));
  assert.notDeepEqual(firstKeys, secondKeys, "the exact activation participates in semantic identity");
  assert.equal((await sendAlerts(config, announcement)).status, "delivered");
  assert.equal((await sendAlerts(config, firstActivation)).status, "delivered", "the first token activation is a separate milestone");
  const repeated = await sendAlerts(config, repeatedActivation);
  assert.equal(repeated.status, "suppressed");
  assert.equal((await sendAlerts(config, secondActivation)).status, "delivered", "a same-named later activation remains alertable");
  const repeatedSecond = await sendAlerts(config, repeatedSecondActivation);
  assert.equal(repeatedSecond.status, "suppressed");
  assert.equal(payloads.length, 3);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[repeated.eventId].semanticDuplicateOf, "bsc-mode:flap:vault-v3:first");
  assert.equal(outbox.events[repeatedSecond.eventId].semanticDuplicateOf, "bsc-mode:flap:vault-v3:second-activation");
});

test("focus3 deduplicates the same new-chain signal across GitHub and X but keeps testnet and mainnet distinct", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-new-chain-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const baseMainnet = { id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "supported" };
  const github = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/contracts",
    sourceTrust: "official_verified",
    commit: "base-mainnet-first",
    committedAt: now,
    message: "feat: add Base chain support",
    files: [{ filename: "deployments/base/addresses.json", status: "added", additions: 8, deletions: 0 }],
    chainSupportChange: { candidate: true, chains: [baseMainnet], stage: "commit" },
    strong: true,
    url: "https://github.com/flap-sh/contracts/commit/base-mainnet-first",
  };
  const twitter = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { id: "base-mainnet-x", handle: "flapdotsh", text: "Flap adds support for Base mainnet", createdAt: now, url: "https://x.com/flapdotsh/status/base-mainnet-x" },
    signal: { relevant: true, strong: true, platformStructural: true, labels: ["新增链支持"], chainSupport: [baseMainnet] },
  };
  assert.deepEqual(focusNoveltyKeys(github), ["flap:chain:base:mainnet"]);
  assert.deepEqual(focusNoveltyKeys(twitter), ["flap:chain:base:mainnet"]);
  assert.deepEqual(focusNoveltyKeys({
    ...twitter,
    signal: { ...twitter.signal, chainSupport: [{ ...baseMainnet, environment: "unknown" }] },
  }), ["flap:chain:base:mainnet"]);
  assert.deepEqual(focusNoveltyKeys({
    ...twitter,
    signal: { ...twitter.signal, chainSupport: [{ ...baseMainnet, environment: "testnet" }] },
  }), ["flap:chain:base:testnet"]);
  assert.deepEqual(focusNoveltyKeys({
    ...twitter,
    signal: { ...twitter.signal, chainSupport: [{ ...baseMainnet, stage: "deployed" }] },
  }), ["flap:chain:base:mainnet:deployed"]);
  assert.equal((await sendAlerts(config, github)).status, "delivered");
  assert.equal((await sendAlerts(config, twitter)).status, "suppressed");
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /新链/);
  assert.match(payloads[0].text, /Base \(8453\) · 主网 · 已支持/);
});

test("platform capability chain additions are strong and render a concise Chinese card", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-platform-new-chain-"));
  let payload;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 88 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "platform_capability_update",
    platform: { id: "fourmeme", name: "Four.Meme", website: "https://four.meme" },
    changes: { newChains: [{ id: "arbitrum", name: "Arbitrum", chainId: 42161, environment: "testnet" }] },
    observedAt: new Date().toISOString(),
    url: "https://four.meme/docs/networks",
  };
  assert.equal(isStrongAlert(event), true);
  assert.equal((await sendAlerts({ ...alertConfig(dataDir), monitorScope: "focus3", alertChineseTranslationEnabled: false }, event)).status, "delivered");
  assert.match(payload.text, /官方能力更新/);
  assert.match(payload.text, /具体更新: 新增 Arbitrum测试网支持（Chain ID 42161）/);
  assert.match(payload.text, /状态: 官方文档已记录；链上部署\/实际启用尚未确认/);
  assertCompactCard(payload);
});

test("platform capability cards show exact before-to-after values and deployment stage", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-platform-exact-change-"));
  let payload;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 89 } }) };
  });
  t.mock.method(console, "info", () => {});
  const before = { symbol: "USD1", fees: { buyFee: "0.01", sellFee: "0.01" } };
  const after = { symbol: "USD1", fees: { buyFee: "0.005", sellFee: "0.01" } };
  const event = {
    type: "platform_capability_update",
    platform: { id: "fourmeme", name: "Four.Meme", website: "https://four.meme" },
    previous: { quoteConfigs: [before] },
    changes: {
      updatedQuoteConfigs: [after],
      quoteConfigChanges: [{ symbol: "USD1", before, after }],
      packageVersionChanges: [{ name: "@four-meme/four-meme-ai", fromVersion: "1.0.8", toVersion: "1.1.0" }],
      chainStageChanges: [{ name: "Base", fromStage: "supported", toStage: "deployed", after: { id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "deployed" } }],
    },
    sources: ["https://four.meme/meme-api/v1/public/config"],
    url: "https://four.meme/meme-api/v1/public/config",
    observedAt: new Date().toISOString(),
  };

  const result = await sendAlerts({ ...alertConfig(dataDir), monitorScope: "focus3", alertChineseTranslationEnabled: false }, event);
  assert.equal(result.status, "delivered");
  assert.match(payload.text, /USD1 配置调整：买费 0\.01→0\.005/);
  assert.match(payload.text, /@four-meme\/four-meme-ai：1\.0\.8→1\.1\.0/);
  assert.match(payload.text, /Base主网状态：已支持→已部署/);
  assert.match(payload.text, /状态: 官方 API显示为已部署；尚未独立核验链上入口/);
  assert.doesNotMatch(payload.text, /观察|可能改变/);
  assertCompactCard(payload);
});

test("official repository and X cards state the concrete change instead of generic labels", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-concrete-official-update-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };

  await sendAlerts(config, {
    type: "github_repository_discovered",
    launchpad: "Uniswap",
    repository: "Uniswap/liquidity-launcher-v2",
    sourceTrust: "official_verified",
    repositoryMetadata: { description: "Contracts and SDK for Liquidity Launcher V2", createdAt: new Date().toISOString() },
    url: "https://github.com/Uniswap/liquidity-launcher-v2",
    observedAt: new Date().toISOString(),
  });
  await sendAlerts(config, {
    type: "twitter_update",
    project: { id: "fourmeme", name: "Four.Meme" },
    tweet: { handle: "fourdotmemezh", id: "royalty-update", text: "Royalty is now live", createdAt: new Date().toISOString() },
    signal: {
      relevant: true,
      strong: true,
      platformStructural: true,
      labels: ["税收/募资/报价代币"],
      keyChanges: ["Royalty 正式上线", "新增生态回购金库", "X 认证账号可管理版税金库", "开放自定义版税模板", "外盘交易零平台费"],
    },
  });

  const repository = payloads.find((item) => item.text.includes("官方新增仓库"));
  assert.match(repository.text, /具体更新: 官方组织新增 GitHub 仓库 liquidity-launcher-v2/);
  assert.match(repository.text, /用途: Contracts and SDK for Liquidity Launcher V2/);
  assert.match(repository.text, /官方归属已确认/);
  assert.doesNotMatch(repository.text, /Factory:|待官方来源交叉认证/);
  const twitter = payloads.find((item) => item.text.includes("Four.Meme 官方动态"));
  assert.match(twitter.text, /具体更新: Royalty 正式上线/);
  assert.match(twitter.text, /关键变化: 新增生态回购金库；X 认证账号可管理版税金库；开放自定义版税模板；另有1项/);
  assert.doesNotMatch(twitter.text, /事件: 税收|内容: Royalty/);
  assertCompactCard(repository);
  assertCompactCard(twitter);
});

test("an implementation-only BSC observation is not mislabeled as a new launch mode", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-opaque-implementation-"));
  let payload;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 90 } }) };
  });
  t.mock.method(console, "info", () => {});
  const implementation = "0x1111111111111111111111111111111111111111";
  const event = {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    eventKey: "bsc-mode:flap:opaque-implementation-test",
    platform: { id: "flap", name: "Flap", trust: "official_verified" },
    attribution: { status: "verified", platform: { id: "flap", name: "Flap" } },
    launcher: "0x2222222222222222222222222222222222222222",
    transactionHash: "0xabcdef1234567890",
    structural: { eligible: true },
    strong: true,
    mode: {
      selector: "0x12345678",
      implementation,
      novelty: { implementation, launcherCodeHash: "0xcode", poolKinds: [], creationTopics: [] },
    },
    blockTimestamp: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  };

  assert.equal((await sendAlerts({ ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false }, event)).status, "delivered");
  assert.match(payload.text, /Flap Factory 实现版本变化/);
  assert.match(payload.text, /具体更新: 首次观察到实现 0x111111…111111 通过官方 Factory 产生活动/);
  assert.match(payload.text, /具体功能差异尚未解析，不直接称为“新模式”/);
  assert.doesNotMatch(payload.text, /BSC 发射台新模式|核心:.*CA/);
  assertCompactCard(payload);
});

test("Uniswap cards use the official title, concrete release notes, and verified stage", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-uniswap-concrete-update-"));
  let payload;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 91 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "uniswap_official_update",
    kind: "github_release",
    repository: "Uniswap/liquidity-launcher",
    tag: "v2.0.0",
    title: "Liquidity Launcher v2.0.0",
    summary: "Adds InstantLaunchStrategy and FeeSplitter for new launches.",
    labels: ["Uniswap 新发射/新模式", "github_release"],
    stage: "github_release",
    stageLabel: "GitHub 代码版本发布（未确认产品上线）",
    deploymentConfirmed: false,
    strong: true,
    url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v2.0.0",
    publishedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  };

  assert.equal((await sendAlerts({ ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false }, event)).status, "delivered");
  assert.match(payload.text, /具体更新: Liquidity Launcher v2\.0\.0/);
  assert.match(payload.text, /内容: Adds InstantLaunchStrategy and FeeSplitter for new launches/);
  assert.match(payload.text, /状态: GitHub 代码版本发布（未确认产品上线）/);
  assert.doesNotMatch(payload.text, /官方发布高信号更新|协议级更新/);
  assertCompactCard(payload);
});

test("focus3 derives semantic identities from pre-upgrade delivered outbox entries", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-legacy-novelty-"));
  let payloadCount = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    payloadCount += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloadCount } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const first = await sendAlerts(config, {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-skills",
    sourceTrust: "official_verified",
    commit: "legacy-vault-v2",
    committedAt: now,
    message: "feat: add Vault V2 module",
    modeChange: { candidate: true },
  });
  await mutateOutboxEntry(dataDir, first.eventId, (entry) => {
    delete entry.event.canonicalSignalId;
    delete entry.event.canonicalSignalIds;
  });
  const duplicate = await sendAlerts(config, {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { id: "legacy-vault-v2-x", handle: "flapdotsh", text: "Flap adds a new Vault V2 module", createdAt: now },
    signal: { relevant: true, strong: true, platformStructural: true, labels: ["新发射/新模式"] },
  });
  assert.equal(duplicate.status, "suppressed");
  assert.equal(payloadCount, 1);
});

test("focus3 keeps unseen features in a mixed update and only suppresses later repeats", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-mixed-novelty-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const vault = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-skills",
    sourceTrust: "official_verified",
    commit: "vault-v2-before-mixed",
    committedAt: now,
    message: "feat: add Vault V2 module",
    files: [{ filename: "contracts/VaultV2.sol", status: "added" }],
    modeChange: { candidate: true },
  };
  const mixed = {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh" },
    changes: { newModules: ["Vault V2", "Tax Mode"] },
    observedAt: now,
    url: "https://docs.flap.sh/flap",
  };
  const taxRepeat = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { id: "tax-mode-after-mixed", handle: "flapdotsh", text: "Flap introduces a new Tax Mode module", createdAt: now },
    signal: { relevant: true, strong: true, platformStructural: true, labels: ["新发射/新模式"] },
  };

  assert.deepEqual(focusNoveltyKeys(mixed), ["flap:concept:tax-mode", "flap:concept:vault:v2"]);
  assert.equal((await sendAlerts(config, vault)).status, "delivered");
  assert.equal((await sendAlerts(config, mixed)).status, "delivered", "Tax Mode is unseen and must keep the mixed alert deliverable");
  assert.equal((await sendAlerts(config, taxRepeat)).status, "suppressed");
  assert.equal(payloads.length, 2);
});

test("focus3 suppresses a mixed update when its features were covered by separate earlier alerts", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-covered-mixed-"));
  let payloadCount = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    payloadCount += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloadCount } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const capability = (module, suffix) => ({
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh" },
    changes: { newModules: [module] },
    observedAt: now,
    url: `https://docs.flap.sh/flap?change=${suffix}`,
  });

  assert.equal((await sendAlerts(config, capability("Vault V2", "vault"))).status, "delivered");
  assert.equal((await sendAlerts(config, capability("Tax Mode", "tax"))).status, "delivered");
  const covered = await sendAlerts(config, {
    ...capability("Vault V2", "mixed"),
    changes: { newModules: ["Vault V2", "Tax Mode"] },
  });
  assert.equal(covered.status, "suppressed");
  assert.equal(payloadCount, 2);
});

test("focus3 maps readable chain mode names to the same cross-source identity", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-chain-mode-"));
  let payloadCount = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    payloadCount += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloadCount } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const chain = {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    platform: { id: "flap", name: "Flap" },
    mode: { fingerprint: "vault-mode-fingerprint", componentMode: "Vault V2" },
    structural: { eligible: true },
    strong: true,
    observedAt: now,
  };
  const twitter = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { id: "vault-v2-after-chain", handle: "flapdotsh", text: "Flap adds a new Vault V2 module", createdAt: now },
    signal: { relevant: true, strong: true, platformStructural: true, labels: ["新发射/新模式"] },
  };

  assert.deepEqual(focusNoveltyKeys(chain), ["flap:concept:vault:v2"]);
  assert.deepEqual(focusNoveltyKeys({ ...chain, mode: { fingerprint: "opaque-mode" } }), ["flap:mode:opaque-mode"]);
  assert.deepEqual(focusNoveltyKeys({
    ...chain,
    mode: { fingerprint: "creator-mode-fingerprint", componentMode: "Creator Mode", selectorName: "newTokenV6" },
  }), ["flap:module:creator-mode"]);
  assert.deepEqual(focusNoveltyKeys({
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { text: "Flap introduces a new Creator Mode module" },
  }), ["flap:module:creator-mode"]);
  assert.deepEqual(focusNoveltyKeys({
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/contracts",
    files: [{ filename: "contracts/VaultV2.sol", status: "added" }],
  }), ["flap:concept:vault:v2"]);
  assert.deepEqual(focusNoveltyKeys({
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/contracts",
    message: "feat: add Vault V2.0.0 module",
  }), ["flap:concept:vault:v2"]);
  assert.equal((await sendAlerts(config, chain)).status, "delivered");
  assert.equal((await sendAlerts(config, twitter)).status, "suppressed");
  assert.equal(payloadCount, 1);
});

test("focus3 keeps distinct generic proxy upgrades separate and deduplicates only the same fingerprint", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-focus-proxy-upgrades-"));
  let payloadCount = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    payloadCount += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloadCount } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), monitorScope: "focus3", ponsMonitorEnabled: false, alertChineseTranslationEnabled: false };
  const upgrade = (fingerprint, transactionHash) => ({
    type: "bsc_launchpad_update",
    kind: "new_mode",
    platform: { id: "flap", name: "Flap" },
    mode: {
      selector: "proxy-upgrade",
      selectorName: "Upgraded / ImplementationUpdated",
      componentMode: "Factory/Manager",
      fingerprint,
    },
    structural: { eligible: true },
    strong: true,
    transactionHash,
    observedAt: new Date().toISOString(),
  });

  const first = upgrade("implementation-a", "0xupgrade-a");
  const second = upgrade("implementation-b", "0xupgrade-b");
  const repeatedSecond = upgrade("implementation-b", "0xupgrade-b-repeat");
  assert.deepEqual(focusNoveltyKeys(first), ["flap:mode:implementation-a"]);
  assert.deepEqual(focusNoveltyKeys(second), ["flap:mode:implementation-b"]);
  assert.equal((await sendAlerts(config, first)).status, "delivered");
  assert.equal((await sendAlerts(config, second)).status, "delivered");
  assert.equal((await sendAlerts(config, repeatedSecond)).status, "suppressed");
  assert.equal(payloadCount, 2);
});

const platformUpdate = {
  type: "platform_capability_update",
  platform: { name: "Four.Meme", website: "https://four.meme", twitter: "https://x.com/four_meme_" },
  changes: {
    newQuoteTokens: ["UUSD"],
    removedQuoteTokens: [],
    newModules: [],
    newVersions: [],
    newContracts: [],
    newPages: [],
    newAnnouncements: [],
  },
  url: "https://four.meme/en/create-token",
};

const alertConfig = (dataDir) => ({
  dataDir,
  blockedContracts: new Set(),
  telegramToken: "test-bot-token-secret",
  telegramChatId: "1234567890",
  telegramStrongAlerts: false,
  alertTelegramDeliveryMaxAgeMs: 7_200_000,
  webhookUrl: "",
});

function ponDelayedPausedEvent({
  recoveredAtMs = Date.now(),
  transactionHash = `0x${"a".repeat(64)}`,
  blockNumber = 52_000_001,
} = {}) {
  const sourceOccurredAt = new Date(recoveredAtMs - 3 * 60 * 60_000).toISOString();
  const recoveredAt = new Date(recoveredAtMs).toISOString();
  const gapSince = new Date(recoveredAtMs - 2 * 60 * 60_000).toISOString();
  const factory = "0xf698d13348686c1529c2dc54847c123424d9dae0";
  const originalEventKey = `pon-fun:factory_paused:4663:${transactionHash}:0`;
  const explorerUrl = `https://robinhoodchain.blockscout.com/tx/${transactionHash}`;
  return {
    type: "pon_fun_update",
    kind: "factory_paused",
    eventKey: `${originalEventKey}:delayed-recovery:v1`,
    originalEventKey,
    platform: {
      id: "ponfun",
      name: "pon.fun",
      website: "https://www.pon.fun/",
      twitter: "https://x.com/pondotfun",
      chainId: 4663,
      model: "stock-backed penny meme launchpad; the coin is not the stock",
    },
    source: {
      id: "pon_fun_official_api_onchain",
      name: "pon.fun official API + fingerprinted Factory",
      url: explorerUrl,
      official: true,
      trust: "official_site_bound_onchain_fingerprinted",
    },
    sourceTrust: "official_site_bound_onchain_fingerprinted",
    chainId: 4663,
    factory,
    title: "pon.fun 延迟恢复摘要：pon.fun Factory 已暂停",
    summary: "A still-relevant structural change was recovered after a monitoring gap; the original finalized proof and change are preserved.",
    observedAt: recoveredAt,
    strong: true,
    risk: "PON coins are not the referenced stocks; backing, oracle, liquidity, sellability and admin controls remain risks.",
    previousSnapshot: { paused: false },
    currentSnapshot: { paused: true, account: "0x1111111111111111111111111111111111111111" },
    changes: { paused: { before: false, after: true } },
    transactionHash,
    blockNumber,
    blockHash: `0x${"b".repeat(64)}`,
    blockTimestamp: sourceOccurredAt,
    explorerUrl,
    evidence: {
      chainId: 4663,
      factory,
      factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
      topic0: "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
      logIndex: 0,
      receiptVerified: true,
      api: {
        healthUrl: "https://www.pon.fun/api/health",
        marketsUrl: "https://www.pon.fun/api/markets",
        tokenListUrl: "https://www.pon.fun/tokenlist.json",
      },
    },
    delayedRecovery: {
      version: 1,
      reason: "monitoring_gap_recovery",
      gapSince,
      sourceOccurredAt,
      recoveredAt,
      lagMs: 3 * 60 * 60_000,
      cursor: { nextBlockAtRecovery: blockNumber + 10, eventBlock: blockNumber },
    },
  };
}

function ponDelayedOfficialXEvent({ recoveredAtMs = Date.now() } = {}) {
  const sourceOccurredAt = new Date(recoveredAtMs - 20 * 60_000).toISOString();
  const recoveredAt = new Date(recoveredAtMs).toISOString();
  const text = "pon.fun Factory configuration updated";
  return {
    type: "twitter_update",
    project: {
      id: "ponfun",
      name: "pon.fun",
      website: "https://www.pon.fun",
      twitter: "https://x.com/pondotfun",
      handle: "pondotfun",
      xUserId: "2094048312772993024",
      match: "official_x",
      signalProfile: "pon_fun",
    },
    tweet: {
      id: "2095100000000000100",
      handle: "pondotfun",
      authorId: "2094048312772993024",
      xUserId: "2094048312772993024",
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
      url: "https://x.com/pondotfun/status/2095100000000000100",
      createdAt: sourceOccurredAt,
      text,
      expandedUrls: [],
    },
    signal: {
      relevant: true,
      strong: true,
      labels: ["pon.fun 重大结构更新"],
      ponFunOfficial: true,
      ponKind: "factory_config",
      ponStage: "factory_config",
      ponAsset: "PONFUN",
      ponPriority: "T1",
      platformStructural: true,
      majorProductUpdate: true,
      reason: "official_factory_config_or_major_product_change",
    },
    observedAt: recoveredAt,
    delayedRecovery: {
      version: 1,
      reason: "monitoring_gap_recovery",
      gapSince: new Date(recoveredAtMs - 15 * 60_000).toISOString(),
      sourceOccurredAt,
      recoveredAt,
      lagMs: 20 * 60_000,
      cursor: {
        latestIdAtRecovery: "2095100000000000000",
        tweetId: "2095100000000000100",
      },
    },
  };
}

async function mutateOutboxEntry(dataDir, eventId, mutation) {
  const file = path.join(dataDir, "alert-outbox.json");
  const outbox = JSON.parse(await fs.readFile(file, "utf8"));
  mutation(outbox.events[eventId]);
  await fs.writeFile(file, `${JSON.stringify(outbox, null, 2)}\n`);
  return outbox.events[eventId];
}

function assertCompactCard(payload, maximumLines = 7) {
  assert.ok(payload.text.length <= 700, `card is ${payload.text.length} characters`);
  assert.ok(payload.text.split("\n").length <= maximumLines, `card has ${payload.text.split("\n").length} lines`);
}

test("only first factory launch or first new mode is strong", () => {
  assert.equal(isStrongAlert({ type: "token_launch", factoryStatus: "new_candidate", modeStatus: "baseline_mode", confidence: "high", tokens: [{ metadata: { website: "https://new-launchpad.test" } }], security: { decision: "pass", metrics: { liquidityConfirmed: true } }, launcherAnalysis: { classification: "reusable_launchpad_candidate", argumentBytes: 128, codeSize: 12_000, usesCreate2: true, selectorSimilarity: 0, infrastructure: { weth: true, factory: true, router: true } } }), true);
  assert.equal(isStrongAlert({ type: "token_launch", factoryStatus: "new_candidate", modeStatus: "baseline_mode", confidence: "high", tokens: [{ metadata: {} }], launcherAnalysis: { classification: "single_project_launcher", argumentBytes: 0, codeSize: 5_000, usesCreate2: true, selectorSimilarity: 0 } }), false);
  assert.equal(isStrongAlert({ type: "token_launch", factoryStatus: "rediscovered", modeStatus: "known_mode", gmgnStatus: "gmgn_gap_candidate", confidence: "high" }), false);
  assert.equal(isStrongAlert({ type: "token_launch", factoryStatus: "rediscovered", modeStatus: "new_mode_candidate" }), false);
  assert.equal(isStrongAlert({ type: "token_launch", factoryStatus: "known", modeStatus: "new_mode_candidate", launchpad: { id: "flap", match: "exact_factory" } }), true);
  assert.equal(isStrongAlert({ type: "token_launch", ponsVersionFirstToken: true, launchpad: { id: "pons" }, modeStatus: "baseline_mode" }), false);
  assert.equal(isStrongAlert({ type: "github_module_update", sourceTrust: "unverified_candidate", modeChange: { candidate: true } }), false);
  assert.equal(isStrongAlert({ type: "github_module_update", sourceTrust: "official_verified", modeChange: { candidate: true } }), true);
  assert.equal(isStrongAlert({ type: "github_repository_discovered", sourceTrust: "unverified_candidate" }), false);
  assert.equal(isStrongAlert({ type: "github_repository_discovered", sourceTrust: "official_verified" }), false);
  assert.equal(isStrongAlert({ type: "github_repository_discovered", launchpad: "Flap", sourceTrust: "official_verified" }), true);
  assert.equal(isStrongAlert({ type: "github_repository_verified" }), true);
  assert.equal(isStrongAlert({ type: "pons_v2_factory_status_update" }), true);
});

test("only organization-associated open GitHub pull requests are strong", () => {
  const base = {
    type: "github_module_update",
    launchpad: "Flap",
    sourceTrust: "official_verified",
    modeChange: { candidate: true },
    developmentStage: "pull_request",
    pullRequest: { number: 9, state: "open" },
  };
  for (const authorAssociation of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(isRelevantAlert({ ...base, pullRequest: { ...base.pullRequest, authorAssociation } }), true);
    assert.equal(isStrongAlert({ ...base, pullRequest: { ...base.pullRequest, authorAssociation } }), true);
  }
  for (const authorAssociation of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", ""]) {
    const event = { ...base, pullRequest: { ...base.pullRequest, authorAssociation } };
    assert.equal(isRelevantAlert(event), true, `${authorAssociation || "missing"} PR remains deliverable`);
    assert.equal(isStrongAlert(event), false, `${authorAssociation || "missing"} PR must not be loud`);
  }
  assert.equal(isStrongAlert({ ...base, pullRequest: { ...base.pullRequest, state: "closed", authorAssociation: "NONE" } }), true);
  assert.equal(isStrongAlert({ ...base, pullRequest: { ...base.pullRequest }, authorAssociation: "member" }), true);
});

test("Pons ordinary first-token events remain irrelevant even with a legacy priority flag", () => {
  const event = {
    type: "token_launch",
    ponsVersionFirstToken: true,
    factoryStatus: "new_candidate",
    modeStatus: "baseline_mode",
    confidence: "high",
    launcher: "0x1111111111111111111111111111111111111111",
    launchpad: { id: "pons", name: "pons", website: "https://ponsfamily.com", match: "exact_factory" },
    launcherAnalysis: { classification: "known_launchpad", argumentBytes: 128, codeSize: 12_000, selectorSimilarity: 0.8 },
    tokens: [{ token: "0x2222222222222222222222222222222222222222", metadata: { name: "First", symbol: "FIRST" } }],
    explorerUrl: "https://robinhoodchain.blockscout.com/tx/0xabc",
  };
  assert.equal(isRelevantAlert(event), false);
  assert.equal(isStrongAlert(event), false);
});

test("rejects one-off launch contracts and requires structural launchpad evidence", () => {
  const base = { type: "token_launch", factoryStatus: "new_candidate", confidence: "high", tokens: [{ metadata: { website: "https://candidate.test" } }], security: { decision: "pass", metrics: { liquidityConfirmed: true } } };
  assert.equal(isActionableLaunchpadCandidate({ ...base, launcherAnalysis: { classification: "single_project_launcher", argumentBytes: 0, codeSize: 10_000, usesCreate2: true, selectorSimilarity: 0.8 } }), false);
  assert.equal(isActionableLaunchpadCandidate({ ...base, launcherAnalysis: { classification: "reusable_launchpad_candidate", argumentBytes: 320, codeSize: 4_000, usesCreate2: false, selectorSimilarity: 0.05 } }), false);
  assert.equal(isActionableLaunchpadCandidate({ ...base, launcherAnalysis: { classification: "reusable_launchpad_candidate", argumentBytes: 320, codeSize: 4_000, usesCreate2: true, selectorSimilarity: 0.05 } }), false);
  assert.equal(isActionableLaunchpadCandidate({ ...base, launcherAnalysis: { classification: "reusable_launchpad_candidate", argumentBytes: 320, codeSize: 12_000, usesCreate2: true, selectorSimilarity: 0.8 } }), true);
  assert.equal(isActionableLaunchpadCandidate({ ...base, tokens: [{ metadata: {} }], launcherAnalysis: { classification: "reusable_launchpad_candidate", argumentBytes: 320, codeSize: 12_000, usesCreate2: true, selectorSimilarity: 0.8 } }), false);
  assert.equal(isActionableLaunchpadCandidate({ ...base, security: { decision: "block", metrics: { liquidityConfirmed: false } }, launcherAnalysis: { classification: "reusable_launchpad_candidate", argumentBytes: 320, codeSize: 12_000, usesCreate2: true, selectorSimilarity: 0.8 } }), false);
});

test("Robinhood chain notifications require important, verified evidence", () => {
  assert.equal(isImportantRobinhoodEvent({ type: "contract_deployed", earlyLaunchpad: { candidate: true, score: 100 } }), false);
  assert.equal(isImportantRobinhoodEvent({ type: "official_activity", activity: "buy" }), false);
  assert.equal(isImportantRobinhoodEvent({ type: "official_activity", activity: "buy", tradeVerified: true }), true);
  assert.equal(isImportantRobinhoodEvent({ type: "early_activity_alert", activity: "volume_anomaly", stage: 1, entry: { securityDecision: "pass" } }), false);
  assert.equal(isImportantRobinhoodEvent({ type: "early_activity_alert", activity: "volume_anomaly", stage: 2, entry: { securityDecision: "block" } }), false);
  assert.equal(isImportantRobinhoodEvent({ type: "early_activity_alert", activity: "volume_anomaly", stage: 2, entry: { securityDecision: "pass" } }), true);
  assert.equal(isRelevantAlert({ type: "token_launch", factoryStatus: "rediscovered", modeStatus: "new_mode_candidate" }), false);
  assert.equal(isRelevantAlert({ type: "token_launch", factoryStatus: "known", modeStatus: "new_mode_candidate", launchpad: { id: "flap", match: "exact_factory" } }), true);
});

test("focuses platform notifications on Flap and Four.Meme", () => {
  const flapCode = { type: "github_module_update", launchpad: "Flap", sourceTrust: "official_verified", modeChange: { candidate: false } };
  const bankrCode = { type: "github_module_update", launchpad: "Bankr", sourceTrust: "configured_source", modeChange: { candidate: false } };
  assert.equal(isRelevantAlert(flapCode), true);
  assert.equal(isStrongAlert(flapCode), true);
  assert.equal(isRelevantAlert(bankrCode), false);
  assert.equal(isRelevantAlert({ type: "twitter_update", project: { id: "flap" }, signal: { labels: ["代币事件"] } }), false);
  assert.equal(isRelevantAlert({ type: "twitter_update", project: { id: "flap" }, signal: { labels: ["税收/募资/报价代币"] } }), true);
  const flapAgentSkill = {
    type: "twitter_update",
    project: { id: "flap", criticalProfile: "focus_launchpad" },
    tweet: {
      id: "2091136006741500374",
      text: "Flap token-launch skill is now available through Binance Agentic Wallet.",
      url: "https://x.com/flapdotsh/status/2091136006741500374",
    },
    signal: {
      relevant: true,
      strong: true,
      platformStructural: true,
      labels: ["Agent/Skill 集成"],
      reason: "agentic_skill_integration",
    },
  };
  assert.equal(isRelevantAlert(flapAgentSkill), true);
  assert.equal(isStrongAlert(flapAgentSkill), true);
  assert.equal(isRelevantAlert({ type: "twitter_update", project: { id: "flap" }, tweet: { createdAt: "2020-01-01T00:00:00Z" }, signal: { labels: ["税收/募资/报价代币"] } }), true, "content relevance stays separate from durable freshness suppression");
  assert.equal(isStrongAlert({ type: "platform_capability_update", platform: { id: "flap" }, changes: { removedModules: ["old"] } }), true);
  assert.equal(isStrongAlert({ type: "github_module_update", launchpad: "Four.meme", sourceTrust: "unverified_candidate", modeChange: { candidate: false } }), true);
});

test("Binance official capability events are relevant without taking Flap/Four priority semantics", () => {
  const quiet = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    project: { id: "binance-wallet", name: "Binance Wallet", website: "https://web3.binance.com", twitter: "https://x.com/BinanceWallet" },
    signal: { labels: ["Binance Wallet 新功能"] },
    title: "Binance Wallet Launches Web3 API",
    url: "https://www.binance.com/en/support/announcement/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    strong: false,
  };
  assert.equal(isRelevantAlert(quiet), true);
  assert.equal(isStrongAlert(quiet), false);
  assert.equal(isStrongAlert({ ...quiet, kind: "meme_rush_capability", strong: true }), true);
  assert.match(telegramButtons(quiet).inline_keyboard[0][0].url, /binance\.com/);

  const fromX = {
    type: "twitter_update",
    project: { id: "binance-wallet" },
    tweet: {
      handle: "BinanceWallet",
      id: "123",
      text: "New Wallet API",
      expandedUrls: [quiet.url],
    },
    signal: { labels: ["Binance Wallet 新功能"] },
  };
  assert.equal(alertEventKey(fromX), alertEventKey(quiet), "X and CMS links to the same official article must share one dedup key");

  const code = { type: "github_module_update", launchpad: "Binance Wallet", sourceTrust: "official_verified", modeChange: { candidate: false } };
  assert.equal(isRelevantAlert(code), false);
  assert.equal(isStrongAlert(code), false);
  assert.equal(isRelevantAlert({
    ...code,
    strong: true,
    binanceChange: { classification: "product_feature", productFeature: true },
  }), true);
});

test("X, xAI and Grok official events use strict strong-alert cards and official links", () => {
  const event = {
    type: "ai_official_update",
    kind: "release_notes",
    product: { id: "grok", name: "Grok" },
    source: { id: "xai_release_notes", name: "xAI Release Notes", url: "https://docs.x.ai/developers/release-notes" },
    entryId: "grok-5",
    title: "Grok 5 is now available on the xAI API",
    summary: "Adds a new reasoning model with configurable effort.",
    identifiers: ["grok-5"],
    stage: "available",
    url: "https://docs.x.ai/developers/release-notes#grok-5",
    publishedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    strong: true,
  };
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  assert.equal(alertEventKey(event), "ai:xai_release_notes:grok-5");
  const buttons = telegramButtons(event).inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.url === event.url));
  assert.ok(buttons.some((button) => button.url.includes("docs.x.ai")));
  assert.equal(isRelevantAlert({ ...event, strong: false }), false);
  assert.equal(isStrongAlert({ ...event, strong: false }), false);

  const fromX = {
    type: "twitter_update",
    project: { id: "xai", name: "xAI", signalProfile: "ai" },
    tweet: { handle: "SpaceXAI", id: "123", text: event.title, createdAt: event.publishedAt },
    signal: { relevant: true, strong: true, labels: ["Grok 新模型/能力"] },
  };
  assert.equal(isRelevantAlert(fromX), true);
  assert.equal(isStrongAlert(fromX), true);
  assert.equal(isRelevantAlert({ ...fromX, signal: { relevant: false, strong: false, labels: [] } }), false);
});

test("the first Grok product event wins across release notes and official X", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-grok-cross-source-"));
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: telegramCalls } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    xaiOfficialMonitorEnabled: true,
    alertChineseTranslationEnabled: false,
  };
  const release = {
    type: "ai_official_update",
    kind: "xai_release_notes",
    eventKey: "ai-official:xai_release_notes:grok-5",
    project: { id: "xai", name: "xAI / Grok", website: "https://x.ai", twitter: "https://x.com/SpaceXAI", socials: ["https://x.com/SpaceXAI", "https://x.com/grok"] },
    product: { id: "grok", name: "xAI / Grok" },
    source: { id: "xai_release_notes", name: "xAI Release Notes", url: "https://docs.x.ai/developers/release-notes.md", official: true, trust: "official_verified" },
    entryId: "grok-5",
    title: "Grok 5 is now available",
    summary: "We released the new Grok 5 reasoning model.",
    identifiers: ["grok 5"],
    stage: "available",
    url: "https://docs.x.ai/developers/release-notes.md#grok-5",
    publishedAt: now,
    observedAt: now,
    strong: true,
  };
  const fromX = {
    type: "twitter_update",
    project: { id: "xai", name: "xAI", website: "https://x.ai", docs: "https://docs.x.ai", twitter: "https://x.com/SpaceXAI", handle: "SpaceXAI", xUserId: "1661523610111193088", match: "official_x", signalProfile: "ai" },
    tweet: { id: "2085000000000000000", handle: "SpaceXAI", xUserId: "1661523610111193088", text: "Grok 5 is now available", createdAt: now, url: "https://x.com/SpaceXAI/status/2085000000000000000" },
    signal: { relevant: true, strong: true, labels: ["Grok 新模型/能力"] },
    observedAt: now,
  };
  assert.equal((await sendAlerts(config, release)).status, "delivered");
  const duplicate = await sendAlerts(config, fromX);
  assert.equal(duplicate.status, "suppressed");
  assert.equal(duplicate.reason, "semantic_duplicate");
  assert.equal(duplicate.persisted, true);
  assert.equal(telegramCalls, 1);
});

test("Uniswap official protocol updates are strong while ordinary X chatter stays silent", () => {
  const event = {
    type: "uniswap_official_update",
    kind: "github_release",
    eventKey: "uniswap:github-release:liquidity-launcher:v3.2.0",
    title: "Liquidity Launcher v3.2.0",
    summary: "Adds InstantLaunchStrategy and FeeSplitter",
    labels: ["新发射机制", "新协议版本"],
    repository: "Uniswap/liquidity-launcher",
    tag: "v3.2.0",
    url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v3.2.0",
    strong: true,
  };
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  assert.match(telegramButtons(event).inline_keyboard[0][0].url, /github\.com\/Uniswap/);
  assert.equal(isRelevantAlert({
    type: "twitter_update",
    project: { id: "uniswap", name: "Uniswap" },
    signal: { relevant: false, strong: false, labels: [] },
  }), false);
  assert.equal(isRelevantAlert({
    type: "github_module_update",
    launchpad: "Uniswap",
    sourceTrust: "official_verified",
    uniswapOfficial: true,
    strong: true,
  }), true);
  assert.equal(isStrongAlert({ type: "github_repository_discovered", launchpad: "Uniswap", sourceTrust: "official_verified" }), true);
});

test("Binance Meme Rush alerts explain the concrete production mode identifier", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-binance-mode-"));
  let requestBody;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 101 } }) };
  });
  t.mock.method(console, "info", () => {});

  await sendAlerts(alertConfig(dataDir), {
    type: "binance_official_update",
    kind: "meme_rush_capability",
    eventKey: "binance-meme-rush-baseline-gap:56:2004",
    project: { id: "binance-wallet", name: "Binance Wallet", website: "https://web3.binance.com", twitter: "https://x.com/BinanceWallet" },
    signal: { relevant: true, labels: ["Meme Rush 新平台/新模式"] },
    changes: {
      newProtocols: [{ chainId: "56", protocol: "2004", name: "OpenFour (Four.Meme)", tokenVersions: ["openfour.meme.TaxToken"] }],
      newVersions: [],
      newSchemaKeys: [],
    },
    baselineDiscovery: true,
    strong: true,
    url: "https://www.binance.com/en/skills/detail/binance-web3/meme-rush",
  });

  assert.match(requestBody.text, /实时补漏确认/);
  assert.match(requestBody.text, /OpenFour \(Four\.Meme\) 56\/2004/);
  assert.match(requestBody.text, /新模式 openfour\.meme\.TaxToken/);
  assertCompactCard(requestBody);
});

test("BSC launchpad confirmations are strong, concise, and include copy plus GMGN actions", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-bsc-launchpad-"));
  let requestBody;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 102 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "bsc_launchpad_update",
    kind: "new_launchpad",
    eventKey: "bsc-launchpad:56:0x1111111111111111111111111111111111111111",
    chainId: 56,
    launcher: "0x1111111111111111111111111111111111111111",
    launchCount: 2,
    uniqueTokens: 2,
    tokens: [{ token: "0x2222222222222222222222222222222222222222", metadata: { name: "Sample", symbol: "SMP" } }],
    pools: [],
    mode: { selector: "0x12345678", fingerprint: "mode-a", poolKinds: ["PancakeSwap V2"] },
    structural: { usesCreate2: true },
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
    explorerUrl: "https://bscscan.com/tx/0xabc",
    launcherUrl: "https://bscscan.com/address/0x1111111111111111111111111111111111111111",
  };

  assert.equal(isBscLaunchpadEvent(event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  const markup = telegramButtons(event);
  assert.equal(markup.inline_keyboard[0][0].copy_text.text, event.launcher);
  assert.match(markup.inline_keyboard.flat().find((button) => button.text === "📈 打开 GMGN").url, /gmgn\.ai\/bsc\/token/);

  await sendAlerts(alertConfig(dataDir), event);
  assert.match(requestBody.text, /BSC 新发射台确认/);
  assert.match(requestBody.text, /2 个独立代币/);
  assert.match(requestBody.text, /风险:/);
  assert.doesNotMatch(requestBody.text, /安全矩阵|社交覆盖|过滤:/);
  assertCompactCard(requestBody);
});

test("Flap and Four.Meme first-token cards only claim safety after pass plus confirmed liquidity in bilingual rendering", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-bsc-first-token-safety-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const translationFetch = async () => { throw new Error("simulated translation outage"); };
  const now = new Date().toISOString();
  const firstToken = ({ platform, token, eventKey, security }) => ({
    type: "bsc_launchpad_update",
    kind: "new_mode",
    eventKey,
    featureFirstToken: true,
    featureActivationKey: `${platform.id}:feature:first-token-safety`,
    platform,
    mode: { fingerprint: `${platform.id}-first-token-safety`, componentMode: "Safety Gate Mode" },
    tokens: [{ token, metadata: { name: "Safety Test", symbol: "SAFE" } }],
    structural: { eligible: true },
    security,
    strong: true,
    blockTimestamp: now,
    observedAt: now,
  });
  const blocked = firstToken({
    platform: { id: "flap", name: "Flap", trust: "official_verified" },
    token: "0x1111111111111111111111111111111111111111",
    eventKey: "bsc-mode:flap:first-token-safety-blocked",
    security: { decision: "block", metrics: { liquidityConfirmed: false } },
  });
  const passed = firstToken({
    platform: { id: "fourmeme", name: "Four.Meme", trust: "official_verified" },
    token: "0x2222222222222222222222222222222222222222",
    eventKey: "bsc-mode:fourmeme:first-token-safety-passed",
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
  });

  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationFetchImpl: translationFetch,
    alertTranslationTimeoutMs: 3_000,
  };
  assert.equal((await sendAlerts(config, blocked)).status, "delivered");
  assert.equal((await sendAlerts(config, passed)).status, "delivered");
  assert.equal(payloads.length, 2);

  const blockedCard = payloads.find((payload) => payload.text.includes("Flap"));
  assert.match(blockedCard.text, /^🔴 强提醒 \| STRONG ALERT/);
  assert.match(blockedCard.text, /🇨🇳 中文[\s\S]*本地安全门已拦截/);
  assert.match(blockedCard.text, /🇬🇧 English[\s\S]*Blocked by local safety gate/);
  assert.doesNotMatch(blockedCard.text, /首个通过本地权限与交易安全初筛的代币/);

  const passedCard = payloads.find((payload) => payload.text.includes("Four.Meme"));
  assert.match(passedCard.text, /🇨🇳 中文[\s\S]*安全初筛通过，非买入建议/);
  assert.match(passedCard.text, /🇬🇧 English[\s\S]*Safety screening passed; not a buy recommendation/);
  assert.doesNotMatch(passedCard.text, /本地安全门已拦截|Blocked by local safety gate/);
});

test("early activity escalation keys preserve the first Stage 2 alert", () => {
  const base = { type: "early_activity_alert", activity: "volume_anomaly", entry: { token: "0xabc" }, additions: {} };
  assert.notEqual(alertEventKey({ ...base, stage: 1 }), alertEventKey({ ...base, stage: 2 }));
});

test("official token activity deduplicates incoming and outgoing under one key", () => {
  const incoming = officialTokenDedupKey({ type: "official_activity", activity: "buy", actor: "0xABC", token: "0xDEF" });
  const outgoing = officialTokenDedupKey({ type: "official_activity", activity: "sell", actor: "0xabc", token: "0xdef" });
  assert.equal(incoming, outgoing);
  assert.equal(officialTokenDedupKey({ type: "token_launch", token: "0xdef" }), null);
});

test("Telegram token alerts include a native one-click copy button", () => {
  const token = "0x1111111111111111111111111111111111111111";
  const markup = telegramButtons({
    type: "token_launch",
    tokens: [{ token, metadata: {} }],
    explorerUrl: "https://explorer.example/tx/1",
  });
  assert.deepEqual(markup.inline_keyboard[0][0], {
    text: "📋 一键复制合约",
    copy_text: { text: token },
  });
});

test("sendAlerts durably queues a Telegram failure with redacted diagnostics", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-failure-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("simulated failure for test-bot-token-secret");
  });

  t.mock.method(console, "error", () => {});
  const result = await sendAlerts(alertConfig(dataDir), platformUpdate);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = Object.values(outbox.events)[0];
  assert.equal(result.status, "queued");
  assert.equal(entry.destinations.telegram.status, "failed");
  assert.match(entry.destinations.telegram.lastError, /simulated failure/);
  assert.doesNotMatch(entry.destinations.telegram.lastError, /test-bot-token-secret/);
});

test("critical Binance delivery stays within a fake-clock five-second budget and bypasses slow translation", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-critical-binance-budget-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.now();
  let translationCalls = 0;
  let telegramPayload;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramPayload = JSON.parse(options.body);
    nowMs += 3_200;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 5001 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:critical-budget",
    project: { id: "binance", name: "Binance" },
    title: "Binance Agent OS officially launched",
    keyChanges: ["Agent OS officially launched"],
    strong: true,
    source: { id: "binance_exchange_cms", url: "https://www.binance.com/en/support/announcement/critical-budget" },
    url: "https://www.binance.com/en/support/announcement/critical-budget",
    publishedAt: new Date(nowMs - 1_000).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
  };
  const result = await sendAlerts({
    ...alertConfig(dataDir),
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertNow: () => nowMs,
    alertTranslationFetchImpl: async () => {
      translationCalls += 1;
      return new Promise(() => {});
    },
    alertTranslationTimeoutMs: 60_000,
  }, event);
  assert.equal(result.status, "delivered");
  assert.equal(translationCalls, 0, "strong-alert rendering must use the local bilingual fast path");
  assert.equal(telegramPayload.disable_notification, false);
  assert.match(telegramPayload.text, /🇨🇳 中文[\s\S]+🇬🇧 English/);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const receipt = outbox.events[result.eventId].destinations.telegram.receipt;
  assert.equal(receipt.messageId, 5001);
  assert.equal(receipt.translation.zh.provider, "local_structured");
  assert.equal(receipt.translation.en.provider, "local_structured");
  assert.equal(receipt.timing.enqueueToClaimMs, 0);
  assert.equal(receipt.timing.claimPersistMs, 0);
  assert.equal(receipt.timing.renderMs, 0);
  assert.equal(receipt.timing.telegramMs, 3_200);
  assert.equal(receipt.timing.totalMs, 3_200);
  assert.equal(receipt.timing.sourceToTelegramMs, 3_200);
  assert.equal(receipt.timing.budgetMs, 5_000);
  assert.equal(receipt.timing.withinBudget, true);
  assert.equal(receipt.timing.withinEndToEndBudget, true);
  assert.equal(receipt.timing.slaBreached, false);
});

test("critical delivery shares the producer deadline after 3.2 seconds of source work", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-shared-source-deadline-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.now();
  const sourceStartedAtMs = nowMs - 3_200;
  let telegramCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    nowMs += 1_500;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 5002 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:shared-source-deadline",
    project: { id: "binance", name: "Binance" },
    title: "Binance Agent OS officially launched",
    keyChanges: ["Agent OS officially launched"],
    strong: true,
    source: { id: "binance_exchange_cms", url: "https://www.binance.com/en/support/announcement/shared-source-deadline" },
    url: "https://www.binance.com/en/support/announcement/shared-source-deadline",
    publishedAt: new Date(nowMs - 1_000).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
    deliverySla: {
      startedAt: new Date(sourceStartedAtMs).toISOString(),
      deadlineAt: new Date(sourceStartedAtMs + 5_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "binance_monitor_source_processing",
    },
  };
  const result = await sendAlerts({
    ...alertConfig(dataDir),
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertNow: () => nowMs,
  }, event);
  assert.equal(result.status, "delivered");
  assert.equal(telegramCalls, 1);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const timing = outbox.events[result.eventId].destinations.telegram.receipt.timing;
  assert.equal(timing.sourceSlaAccepted, true);
  assert.equal(timing.deliverySlaBasis, "binance_monitor_source_processing");
  assert.equal(timing.deliveryAttempt, "realtime");
  assert.equal(timing.telegramTimeoutMs, 1_550, "3.2s source work leaves 1.55s plus the 250ms completion reserve");
  assert.equal(timing.totalMs, 1_500);
  assert.equal(timing.sourceToTelegramMs, 4_700);
  assert.equal(timing.pollAllowanceMs, 0);
  assert.equal(timing.worstCaseEndToEndMs, 4_700);
  assert.equal(timing.withinEndToEndBudget, true);
  assert.equal(timing.slaBreached, false);
  assert.equal(timing.breachMs, 0);
});

test("critical delivery includes the producer polling allowance in the end-to-end budget", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-source-poll-allowance-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.now();
  const sourceStartedAtMs = nowMs - 2_200;
  t.mock.method(globalThis, "fetch", async () => {
    nowMs += 1_500;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 5005 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:source-poll-allowance",
    project: { id: "binance", name: "Binance" },
    title: "Binance Agent OS officially launched",
    keyChanges: ["Agent OS officially launched"],
    strong: true,
    source: { id: "binance_exchange_cms", url: "https://www.binance.com/en/support/announcement/source-poll-allowance" },
    url: "https://www.binance.com/en/support/announcement/source-poll-allowance",
    publishedAt: new Date(nowMs - 1_000).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
    deliverySla: {
      startedAt: new Date(sourceStartedAtMs).toISOString(),
      deadlineAt: new Date(sourceStartedAtMs + 4_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 1_000,
      basis: "binance_x_poll_cycle",
    },
  };
  const result = await sendAlerts({
    ...alertConfig(dataDir),
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertNow: () => nowMs,
  }, event);
  assert.equal(result.status, "delivered");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const timing = outbox.events[result.eventId].destinations.telegram.receipt.timing;
  assert.equal(timing.telegramTimeoutMs, 1_550);
  assert.equal(timing.pollAllowanceMs, 1_000);
  assert.equal(timing.sourceToTelegramMs, 3_700);
  assert.equal(timing.worstCaseEndToEndMs, 4_700);
  assert.equal(timing.withinEndToEndBudget, true);
});

test("expired source deadline skips realtime Telegram but a durable retry can deliver as an SLA breach", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-expired-source-deadline-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.now();
  const sourceStartedAtMs = nowMs - 6_000;
  let telegramCalls = 0;
  const warnings = [];
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    nowMs += 300;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 5003 } }) };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", (message) => warnings.push(String(message)));
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:expired-source-deadline",
    project: { id: "binance", name: "Binance" },
    title: "Binance Agent OS officially launched",
    keyChanges: ["Agent OS officially launched"],
    strong: true,
    source: { id: "binance_exchange_cms", url: "https://www.binance.com/en/support/announcement/expired-source-deadline" },
    url: "https://www.binance.com/en/support/announcement/expired-source-deadline",
    publishedAt: new Date(nowMs - 1_000).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
    deliverySla: {
      startedAt: new Date(sourceStartedAtMs).toISOString(),
      deadlineAt: new Date(sourceStartedAtMs + 5_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "binance_monitor_source_processing",
    },
  };
  const config = {
    ...alertConfig(dataDir),
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertNow: () => nowMs,
  };

  const queued = await sendAlerts(config, event);
  assert.equal(queued.status, "queued");
  assert.equal(telegramCalls, 0, "an already-expired realtime attempt must not call Telegram");
  let outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  let destination = outbox.events[queued.eventId].destinations.telegram;
  assert.equal(destination.status, "failed");
  assert.equal(destination.receipt, null);
  assert.equal(destination.lastTiming.deliveryAttempt, "realtime");
  assert.equal(destination.lastTiming.withinEndToEndBudget, false);
  assert.equal(destination.lastTiming.slaBreached, true);
  assert.match(destination.lastError, /delivery budget exhausted/);

  nowMs += 5_000;
  const delivered = await sendAlerts(config, event);
  assert.equal(delivered.status, "delivered");
  assert.equal(telegramCalls, 1, "the durable retry must not be permanently blocked by the original deadline");
  outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  destination = outbox.events[queued.eventId].destinations.telegram;
  assert.equal(destination.status, "delivered");
  assert.equal(destination.receipt.messageId, 5003);
  assert.equal(destination.receipt.timing.deliveryAttempt, "retry");
  assert.equal(destination.receipt.timing.withinBudget, true);
  assert.equal(destination.receipt.timing.withinEndToEndBudget, false);
  assert.equal(destination.receipt.timing.slaBreached, true);
  assert.ok(destination.receipt.timing.breachMs > 0);
  assert.ok(warnings.some((message) => /late delivery.*breachMs=/i.test(message)));
});

test("an expired Flap WebSocket SLA remains durable and records a late retry breach", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-bsc-websocket-sla-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.now();
  const sourceStartedAtMs = nowMs - 6_000;
  let telegramCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    nowMs += 250;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 5056 } }) };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const event = {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    eventKey: "bsc-flap-feature-token:websocket-sla-retry",
    chainId: 56,
    launcher: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
    transactionHash: `0x${"a".repeat(64)}`,
    blockNumber: 100,
    featureFirstToken: true,
    featurePlatform: "flap",
    featureActivationKey: "flap:websocket-sla-retry",
    platform: { id: "flap", name: "Flap", trust: "official_verified" },
    tokens: [{ token: "0x1111111111111111111111111111111111111111", metadata: { name: "First", symbol: "FIRST" } }],
    pools: [],
    mode: { fingerprint: "flap-websocket-sla-retry", componentMode: "Vault V4", selector: "0x8cb5772c" },
    structural: { eligible: true, mechanismEvidence: true },
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
    blockTimestamp: new Date(nowMs - 1_000).toISOString(),
    observedAt: new Date(nowMs - 1_000).toISOString(),
    strong: true,
    deliverySla: {
      startedAt: new Date(sourceStartedAtMs).toISOString(),
      deadlineAt: new Date(sourceStartedAtMs + 5_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "bsc_websocket_ingest",
    },
  };
  const config = {
    ...alertConfig(dataDir),
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertNow: () => nowMs,
  };

  const queued = await sendAlerts(config, event);
  assert.equal(queued.status, "queued");
  assert.equal(telegramCalls, 0);
  let outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  let destination = outbox.events[queued.eventId].destinations.telegram;
  assert.equal(destination.lastTiming.deliverySlaBasis, "bsc_websocket_ingest");
  assert.equal(destination.lastTiming.deliveryAttempt, "realtime");
  assert.equal(destination.lastTiming.slaBreached, true);

  nowMs += 5_000;
  const delivered = await sendAlerts(config, event);
  assert.equal(delivered.status, "delivered");
  assert.equal(telegramCalls, 1);
  outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  destination = outbox.events[queued.eventId].destinations.telegram;
  assert.equal(destination.receipt.timing.deliverySlaBasis, "bsc_websocket_ingest");
  assert.equal(destination.receipt.timing.deliveryAttempt, "retry");
  assert.equal(destination.receipt.timing.withinEndToEndBudget, false);
  assert.equal(destination.receipt.timing.slaBreached, true);
  assert.ok(destination.receipt.timing.breachMs > 0);
});

test("an invalid producer SLA cannot extend the alert pipeline deadline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-invalid-source-deadline-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.now();
  const pipelineStartedAtMs = nowMs;
  t.mock.method(globalThis, "fetch", async () => {
    nowMs += 100;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 5004 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:invalid-source-deadline",
    project: { id: "binance", name: "Binance" },
    title: "Binance Agent OS officially launched",
    keyChanges: ["Agent OS officially launched"],
    strong: true,
    source: { id: "binance_exchange_cms", url: "https://www.binance.com/en/support/announcement/invalid-source-deadline" },
    url: "https://www.binance.com/en/support/announcement/invalid-source-deadline",
    publishedAt: new Date(nowMs - 1_000).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
    deliverySla: {
      startedAt: new Date(nowMs).toISOString(),
      deadlineAt: new Date(nowMs + 60_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "forged_extended_deadline",
    },
  };
  const result = await sendAlerts({
    ...alertConfig(dataDir),
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertNow: () => nowMs,
  }, event);
  assert.equal(result.status, "delivered");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const timing = outbox.events[result.eventId].destinations.telegram.receipt.timing;
  assert.equal(timing.sourceSlaAccepted, false);
  assert.equal(timing.deliverySlaBasis, "alert_pipeline");
  assert.equal(timing.deliveryDeadlineAt, new Date(pipelineStartedAtMs + 5_000).toISOString());
  assert.equal(timing.attemptDeadlineAt, new Date(pipelineStartedAtMs + 5_000).toISOString());
});

test("critical Telegram rejection remains durably failed and never masquerades as delivered", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-critical-binance-rejected-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.now();
  t.mock.method(globalThis, "fetch", async () => {
    nowMs += 900;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, description: "temporary upstream rejection" }) };
  });
  t.mock.method(console, "error", () => {});
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-announcement:critical-rejected",
    project: { id: "binance", name: "Binance" },
    title: "Binance Agent OS officially launched",
    keyChanges: ["Agent OS officially launched"],
    strong: true,
    source: { id: "binance_exchange_cms", url: "https://www.binance.com/en/support/announcement/critical-rejected" },
    url: "https://www.binance.com/en/support/announcement/critical-rejected",
    publishedAt: new Date(nowMs - 1_000).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
  };
  const result = await sendAlerts({
    ...alertConfig(dataDir),
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertNow: () => nowMs,
  }, event);
  assert.equal(result.status, "queued");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events[result.eventId];
  assert.equal(entry.status, "pending");
  assert.equal(entry.deliveredAt, null);
  assert.equal(entry.destinations.telegram.status, "failed");
  assert.equal(entry.destinations.telegram.attempts, 1);
  assert.equal(entry.destinations.telegram.receipt, null);
  assert.match(entry.destinations.telegram.lastError, /temporary upstream rejection/);
  assert.equal(entry.destinations.telegram.lastTiming.totalMs, 900);
  assert.equal(entry.destinations.telegram.lastTiming.withinBudget, true);
  assert.ok(Date.parse(entry.destinations.telegram.nextAttemptAt) > nowMs);
});

test("outbox retries honor a contract added to the hot blocklist after enqueue", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-retry-blocklist-"));
  const blocked = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("temporary Telegram outage");
  });
  t.mock.method(console, "error", () => {});
  const config = alertConfig(dataDir);
  const event = {
    ...platformUpdate,
    changes: { ...platformUpdate.changes, newContracts: [blocked] },
  };

  const queued = await sendAlerts(config, event);
  assert.equal(queued.status, "queued");
  config.blockedContracts.add(blocked);
  await mutateOutboxEntry(dataDir, queued.eventId, (entry) => {
    entry.destinations.telegram.nextAttemptAt = null;
  });

  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(fetchCalls, 1, "the retry worker must not send the newly blocked contract");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events[queued.eventId];
  assert.equal(entry.status, "suppressed");
  assert.equal(entry.destinations.telegram.status, "disabled");
  assert.equal(entry.destinations.telegram.disabledReason, "blocked_event");
});

test("sendAlerts queues Telegram HTTP 200 responses whose API payload is not ok", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-api-failure-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: false, description: "chat not found" }),
  }));

  t.mock.method(console, "error", () => {});
  const result = await sendAlerts(alertConfig(dataDir), platformUpdate);
  assert.equal(result.status, "queued");
  assert.match(result.failures[0].message, /chat not found/);
});

test("Telegram non-JSON HTTP 200 is queued instead of advancing as delivered", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-non-json-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, text: async () => "proxy ok" }));
  t.mock.method(console, "error", () => {});
  const result = await sendAlerts(alertConfig(dataDir), platformUpdate);
  assert.equal(result.status, "queued");
  assert.match(result.failures[0].message, /non-JSON/);
});

test("sendAlerts rejects relevant events when no alert destination is configured", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-unconfigured-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = {
    ...alertConfig(dataDir),
    telegramToken: "",
    telegramChatId: "",
    webhookUrl: "",
  };

  await assert.rejects(
    sendAlerts(config, platformUpdate),
    (error) => {
      assert.ok(error instanceof AlertDeliveryError);
      assert.match(error.message, /no alert destinations configured/);
      assert.deepEqual(error.destinations, ["configuration"]);
      return true;
    },
  );
});

test("sendAlerts resolves with an auditable result after Telegram delivery succeeds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-success-"));
  const logs = [];
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 4321 } }),
    };
  });
  t.mock.method(console, "info", (...args) => logs.push(args.join(" ")));

  const result = await sendAlerts(alertConfig(dataDir), platformUpdate);

  assert.equal(fetchCalls, 1);
  assert.equal(result.status, "delivered");
  assert.equal(result.eventType, "platform_capability_update");
  assert.deepEqual(result.destinations, ["telegram"]);
  assert.deepEqual(result.receipts, [{ destination: "telegram", messageId: 4321 }]);
  assert.match(result.deliveredAt, /^\d{4}-\d{2}-\d{2}T/);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[result.eventId].destinations.telegram.receipt.renderVersion, 2);
  assert.match(outbox.events[result.eventId].destinations.telegram.receipt.renderedText, /具体更新:/);
  assert.ok(logs.some((line) => line.includes("event=platform_capability_update destinations=telegram")));
  assert.ok(logs.every((line) => !line.includes("test-bot-token-secret") && !line.includes("1234567890")));
});

test("official-token dedup state is committed atomically only after successful delivery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-dedup-"));
  let shouldFail = true;
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    if (shouldFail) throw new Error("temporary Telegram outage");
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 77 } }) };
  });
  t.mock.method(console, "info", () => {});
  const event = {
    type: "official_activity",
    activity: "buy",
    tradeVerified: true,
    project: "Robinhood",
    role: "official",
    actor: "0x1111111111111111111111111111111111111111",
    token: "0x2222222222222222222222222222222222222222",
    tokenMetadata: { symbol: "TEST", decimals: 18 },
    amount: "1000000000000000000",
    explorerUrl: "https://explorer.example/tx/1",
  };
  const config = alertConfig(dataDir);
  const stateFile = path.join(dataDir, "alert-state.json");

  t.mock.method(console, "error", () => {});
  assert.equal((await sendAlerts(config, event)).status, "queued");
  await assert.rejects(fs.access(stateFile), { code: "ENOENT" });

  shouldFail = false;
  await mutateOutboxEntry(dataDir, alertEventKey(event), (entry) => {
    entry.destinations.telegram.nextAttemptAt = null;
  });
  const result = await sendAlerts(config, event);
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const files = await fs.readdir(dataDir);

  assert.equal(result.status, "delivered");
  assert.ok(Number(state.officialTokens[officialTokenDedupKey(event)]) > 0);
  assert.equal(files.some((file) => file.endsWith(".tmp")), false);

  assert.equal((await sendAlerts(config, event)).status, "suppressed");
  assert.equal(fetchCalls, 2);
});

test("focus platform alerts always sound while non-focus informational alerts stay silent", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-notification-strength-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});

  const config = { ...alertConfig(dataDir), telegramStrongAlerts: true };
  await sendAlerts(config, platformUpdate);
  await sendAlerts(config, {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    changes: { removedModules: ["legacy"] },
    url: "https://docs.flap.sh/flap",
  });
  await sendAlerts(config, {
    type: "launchpad_site_update",
    launchpad: { id: "noxa", name: "Noxa" },
    newContracts: ["0x1111111111111111111111111111111111111111"],
    newKeywords: [],
    newSocials: [],
    url: "https://noxa.fi",
  });

  assert.equal(payloads[0].disable_notification, false);
  assert.equal(payloads[1].disable_notification, false);
  assert.equal(payloads[2].disable_notification, true);
  assert.match(payloads[0].text, /^🔴 强提醒｜/);
  assert.doesNotMatch(payloads[0].text, /强提醒[^\n]*\n\n/);
  payloads.forEach((payload) => assertCompactCard(payload));
  assert.equal(telegramButtons({ type: "twitter_update", tweet: { handle: "flapdotsh", id: "123", url: "/flapdotsh/status/123" } }).inline_keyboard[0][0].url, "https://x.com/flapdotsh/status/123");
});

test("outbox retries only the failed destination after partial delivery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-partial-"));
  const calls = { telegram: 0, webhook: 0 };
  let webhookFails = true;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("api.telegram.org")) {
      calls.telegram += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 88 } }) };
    }
    calls.webhook += 1;
    if (webhookFails) throw new Error("webhook temporarily down");
    return { ok: true, status: 204, text: async () => "" };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), webhookUrl: "https://webhook.test/alerts" };
  assert.equal((await sendAlerts(config, platformUpdate)).status, "queued");
  assert.deepEqual(calls, { telegram: 1, webhook: 1 });

  webhookFails = false;
  const deferred = await sendAlerts(config, platformUpdate);
  assert.equal(deferred.status, "queued");
  assert.deepEqual(calls, { telegram: 1, webhook: 1 }, "a duplicate observation must respect the persisted retry deadline");
  await mutateOutboxEntry(dataDir, alertEventKey(platformUpdate), (entry) => {
    entry.destinations.webhook.nextAttemptAt = null;
  });
  const retried = await sendAlerts(config, platformUpdate);
  assert.equal(retried.status, "delivered");
  assert.deepEqual(calls, { telegram: 1, webhook: 2 });
  assert.equal(await drainAlertOutbox(config), 0);
});

test("Telegram cards keep decisions, evidence, risk and actions without audit-field walls", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-complete-context-"));
  const payloads = [];
  const now = Date.now();
  const timestamp = (offset) => new Date(now + offset).toISOString();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = alertConfig(dataDir);
  const profile = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    twitter: "https://x.com/flapdotsh",
    docs: "https://docs.flap.sh/flap",
    model: "Portal/VaultPortal standard and tax-token modes",
    match: "exact_factory",
  };

  await sendAlerts(config, {
    type: "launchpad_site_update",
    launchpad: profile,
    newSocials: [],
    newContracts: [],
    newKeywords: ["v2"],
    newFeatures: [],
    newPages: [],
    newAssets: [],
    url: profile.website,
    observedAt: timestamp(0),
  });
  await sendAlerts(config, {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/skills",
    sourceTrust: "official_verified",
    verification: { status: "official_verified", evidence: { url: "https://flap.sh/github" } },
    commit: "abcdef1234567890",
    author: "alice",
    committedAt: timestamp(-75_000),
    message: "refresh showcase and docs",
    files: [
      { filename: "showcase/scene.tsx", status: "added", additions: 10, deletions: 0 },
      { filename: "docs/guide.md", status: "modified", additions: 2, deletions: 1 },
      { filename: "showcase/old.gltf", status: "removed", additions: 0, deletions: 4 },
    ],
    changeEvidence: [{ file: "showcase/scene.tsx", kind: "config_value", subject: "vaultMode", before: "v2", after: "v3" }],
    newContracts: [],
    modeChange: { candidate: false },
    url: "https://github.com/flap-sh/skills/commit/abcdef1234567890",
    observedAt: timestamp(0),
  });
  await sendAlerts(config, {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/feed-fallback",
    sourceTrust: "official_verified",
    verification: { status: "official_verified", evidence: { url: "https://flap.sh/github" } },
    commit: "feedfeed12345678",
    author: "bob",
    message: "add a new vault contract",
    files: [{ filename: "contracts/Vault.sol", status: "added", additions: 0, deletions: 0 }],
    diffStatsAvailable: false,
    newContracts: [],
    modeChange: { candidate: true, reason: "new_contract_file" },
    url: "https://github.com/flap-sh/feed-fallback/commit/feedfeed12345678",
    observedAt: timestamp(0),
  });
  await sendAlerts(config, {
    type: "early_activity_alert",
    activity: "volume_anomaly",
    stage: 2,
    entry: {
      token: "0x1111111111111111111111111111111111111111",
      name: "Austin",
      symbol: "AUSTIN",
      launcher: "0x2222222222222222222222222222222222222222",
      firstSeenAt: timestamp(-120_000),
      launchExplorerUrl: "https://robinhoodchain.blockscout.com/tx/0xearly",
      launchpad: profile,
      mode: { selector: "0x12345678", poolKinds: ["Uniswap V3"] },
      pool: { pool: "0x3333333333333333333333333333333333333333", kind: "Uniswap V3", fee: 3000 },
      quoteToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      quoteSymbol: "WETH",
      metadata: { website: "https://austin.example", twitter: "https://x.com/austin" },
      securityDecision: "pass",
      security: {
        decision: "pass",
        metrics: {
          liquidityConfirmed: true,
          capabilities: {},
          coverage: { bytecodeCapabilities: "static_selector_scan", owner: "not_exposed_or_unreadable", proxy: "eip1967_slot_clear", liquidity: "confirmed_nonzero", sellability: "not_checked", buySellTax: "not_checked", holderConcentration: "not_checked", lpLockOrBurn: "not_checked" },
        },
      },
    },
    buysInMinute: 42,
    sellsInMinute: 13,
    swapsInMinute: 55,
    volumeInMinute: 1.25,
    swapsInFiveMinutes: 81,
    buysInFiveMinutes: 60,
    sellsInFiveMinutes: 21,
    volumeInFiveMinutes: 3.5,
    previousVolumeInMinute: 0.5,
    volumeAcceleration: 2.5,
    latestSwapAt: timestamp(-5_000),
    activityCoverage: "rolling_window_exact_block_timestamps",
    stageCriteria: { swaps: 50, volume: 0.6 },
    observedAt: timestamp(0),
  });
  await sendAlerts(config, {
    type: "token_launch",
    factoryStatus: "known",
    modeStatus: "new_mode_candidate",
    launchpad: profile,
    launcher: "0x4444444444444444444444444444444444444444",
    tokens: [{ token: "0x5555555555555555555555555555555555555555", metadata: { name: "Mode Test", symbol: "MODE" } }],
    mode: { selector: "0x99999999", poolKinds: ["Uniswap V4"] },
    modeDifference: { previous: [{ selector: "0x11111111", poolKinds: ["Uniswap V3"] }], current: { selector: "0x99999999", poolKinds: ["Uniswap V4"] } },
    timestamp: timestamp(-60_000),
    observedAt: timestamp(0),
    transactionHash: "0xlaunch",
    explorerUrl: "https://robinhoodchain.blockscout.com/tx/0xlaunch",
  });
  await sendAlerts(config, {
    type: "twitter_update",
    project: profile,
    tweet: { handle: "flapdotsh", id: "12345", text: "A new tax-token mode is live", createdAt: timestamp(-90_000), likes: 7, reposts: 2, replies: 1, expandedUrls: ["https://github.com/flap-sh/new-mode"] },
    signal: { labels: ["税收/募资/报价代币"] },
    observedAt: timestamp(0),
  });

  const site = payloads.find((payload) => payload.text.includes("官网变化"));
  assert.match(site.text, /页面首次出现 v2（具体功能尚未解析）/);
  assert.match(site.text, /状态: 官方页面已变化；链上部署\/实际启用尚未确认/);
  assert.doesNotMatch(site.text, /当前官方 X:|当前官方文档:|社交覆盖:/);
  assert.ok(site.reply_markup.inline_keyboard.flat().some((button) => button.text === "🌐 官方主页"));
  assert.ok(site.reply_markup.inline_keyboard.flat().some((button) => button.text === "📘 官方文档"));
  assertCompactCard(site);

  const github = payloads.find((payload) => payload.text.includes("官方代码更新"));
  assert.match(github.text, /具体更新: refresh showcase and docs/);
  assert.match(github.text, /范围: 展示、文档、前端/);
  assert.match(github.text, /关键差异: vaultMode v2→v3/);
  assert.match(github.text, /showcase\/scene\.tsx/);
  assert.match(github.text, /状态: 代码已进入官方仓库；是否发布、部署或启用尚未确认/);
  assert.match(github.text, /证据: flap-sh\/skills#abcdef12/);
  assert.match(github.text, /时间: .*延迟1分钟/);
  assert.doesNotMatch(github.text, /文件:|作者 |认证证据:/);
  assertCompactCard(github);
  const githubFallback = payloads.find((payload) => payload.text.includes("flap-sh/feed-fallback"));
  assert.match(githubFallback.text, /具体更新: add a new vault contract/);
  assert.match(githubFallback.text, /状态: 代码已进入官方仓库；是否发布、部署或启用尚未确认/);
  assert.doesNotMatch(githubFallback.text, /代码行统计未取得|文件列表/);
  assertCompactCard(githubFallback);

  const early = payloads.find((payload) => payload.text.includes("早期量能异动"));
  assert.match(early.text, /CA 0x1111/);
  assert.match(early.text, /Uniswap V3 fee 3000/);
  assert.match(early.text, /买 42 \/ 卖 13/);
  assert.match(early.text, /门槛 ≥50笔\/≥0\.6 WETH/);
  assert.match(early.text, /5分钟: 买 60 \/ 卖 21 · 共 81 笔/);
  assert.match(early.text, /加速2\.5倍/);
  assert.match(early.text, /风险: .*可卖/);
  assert.doesNotMatch(early.text, /Launcher:|币龄:|安全矩阵|社交覆盖|口径:/);
  assertCompactCard(early);

  const launch = payloads.find((payload) => payload.text.includes("Mode Test"));
  assert.match(launch.text, /结论: 不买（安全检查未完成）/);
  assert.match(launch.text, /时间: .*延迟1分钟/);
  assert.match(launch.text, /新模式: 0x99999999\/Uniswap V4/);
  assert.doesNotMatch(launch.text, /官网:|官方 X:|文档:|安全矩阵:/);
  assert.equal(launch.reply_markup.inline_keyboard.flat().some((button) => /GMGN/.test(button.text)), false);
  assert.ok(launch.reply_markup.inline_keyboard.flat().some((button) => button.text === "📘 官方文档"));
  assertCompactCard(launch);

  const twitter = payloads.find((payload) => payload.text.includes("官方动态"));
  assert.match(twitter.text, /时间: .*延迟1分钟/);
  assert.match(twitter.text, /具体更新: A new tax-token mode is live/);
  assert.match(twitter.text, /状态: 官方 X 明示已上线；链上\/合约启用尚未独立核验/);
  assert.doesNotMatch(twitter.text, /外链: https:|互动:/);
  assert.ok(twitter.reply_markup.inline_keyboard.flat().some((button) => button.text === "🌐 项目官网"));
  assert.ok(twitter.reply_markup.inline_keyboard.flat().some((button) => button.text === "🔗 外链"));
  assertCompactCard(twitter);
  assert.ok(payloads.every((payload) => payload.text.length <= 700));
});

test("BSC and Fomo cards distinguish market facts from unchecked security coverage", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-complete-market-"));
  const payloads = [];
  const now = Date.now();
  const timestamp = (offset) => new Date(now + offset).toISOString();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = alertConfig(dataDir);
  const coverage = { bytecodeCapabilities: "static_selector_scan", owner: "detected", proxy: "eip1967_slot_clear", liquidity: "confirmed_nonzero", sellability: "not_checked", buySellTax: "not_checked", holderConcentration: "not_checked", lpLockOrBurn: "not_checked" };

  await sendAlerts(config, {
    type: "bsc_launchpad_update",
    kind: "new_launchpad",
    eventKey: "bsc-launchpad:56:complete-context",
    launcher: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    deployer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    launchCount: 2,
    uniqueTokens: 2,
    timestamp: timestamp(-45_000),
    observedAt: timestamp(0),
    tokens: [{ token: "0xcccccccccccccccccccccccccccccccccccccccc", creator: "0xdddddddddddddddddddddddddddddddddddddddd", metadata: { name: "Cyber Cat", symbol: "CCAT", website: "https://cat.example", twitter: "https://x.com/cybercat" } }],
    pools: [{ pool: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", kind: "PancakeSwap V2", fee: 25, token0: "0xcccccccccccccccccccccccccccccccccccccccc", token1: "0xffffffffffffffffffffffffffffffffffffffff" }],
    mode: { selector: "0x12345678", fingerprint: "mode-a", poolKinds: ["PancakeSwap V2"] },
    structural: { usesCreate2: true },
    marketContext: { liquidityUsd: 7241.02 },
    security: { decision: "pass", metrics: { owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", liquidityConfirmed: true, capabilities: { mint: false, blacklist: false }, coverage } },
    explorerUrl: "https://bscscan.com/tx/0xbsc",
  });

  const txHash = `0x${"1".repeat(64)}`;
  const transactionUrl = `https://basescan.org/tx/${txHash}`;
  await sendAlerts(config, {
    type: "fomo_family_top_call",
    eventKey: "fomo-call:test:complete-context",
    qualified: true,
    signalKind: "top_blogger_first_buy",
    activity: "buy",
    callId: txHash,
    source: { id: "cope_capital", trust: "authorized_public_api" },
    chain: { id: "8453", name: "Base", slug: "base", gmgn: "base" },
    token: "0x1212121212121212121212121212121212121212",
    tokenSymbol: "CALL",
    caller: { handle: "caller", followers: 120000, trafficRank: 4 },
    walletAddress: "0x3434343434343434343434343434343434343434",
    amountUsd: 750,
    paymentAmount: 0.25,
    paymentSymbol: "WETH",
    paymentVerification: "transaction_native_value",
    valuationBasis: "native_usd_oracle",
    transactionHash: txHash,
    transactionUrl,
    blockNumber: 123456,
    executionPool: "0x5656565656565656565656565656565656565656",
    executionDex: "uniswap-v3",
    publishedAt: timestamp(-30_000),
    observedAt: timestamp(0),
    candidatePoolSize: 86,
    monitoredTopCount: 20,
    positionProof: { status: "verified", complete: false, phase: "previous_block", previousBalanceRaw: "0" },
    coverage: {
      candidatePoolSize: 86,
      monitoredTopCount: 20,
      targetChains: ["solana", "base", "bsc"],
      configuredChains: ["base", "bsc"],
      missingChains: ["solana"],
    },
    market: { pairAddress: "0x5656565656565656565656565656565656565656", pairCreatedAt: now - 180_000, priceUsd: 0.00001234, liquidityUsd: 25000, volumeM5: 9000, marketCap: 420000, fdv: 600000, sellsM5: 3 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true, capabilities: {}, coverage } },
    explorerUrl: "https://basescan.org/token/0x1212121212121212121212121212121212121212",
  });

  const bsc = payloads.find((payload) => payload.text.includes("BSC 新发射台"));
  assert.match(bsc.text, /PancakeSwap V2 fee 25/);
  assert.match(bsc.text, /流动性 \$7,241\.02 USD/);
  assert.match(bsc.text, /风险: .*可卖/);
  assert.match(bsc.text, /延迟45秒/);
  assert.doesNotMatch(bsc.text, /创建者:|社交:|安全矩阵|权限:/);
  assert.ok(bsc.reply_markup.inline_keyboard.flat().some((button) => button.text === "📋 复制池地址"));
  assertCompactCard(bsc);

  const fomo = payloads.find((payload) => payload.text.includes("FOMO BSC KOL"));
  assert.match(fomo.text, /前一区块零仓位首仓候选/);
  assert.match(fomo.text, /支付 0\.25 WETH（已核验）/);
  assert.match(fomo.text, /流动性 \$25,000 · 5分钟量 \$9,000 · 市值 \$420,000/);
  assert.match(fomo.text, /风险: 仅前一区块零仓位，精确首仓待核验/);
  assert.doesNotMatch(fomo.text, /覆盖:|Tx:|钱包:|DEX |检查矩阵:/);
  assert.equal(fomo.reply_markup.inline_keyboard.flat().find((button) => button.text === "🔍 查看交易").url, transactionUrl);
  assertCompactCard(fomo);
  assert.ok(payloads.every((payload) => payload.text.length <= 700));
});

test("GMGN-attributed Fomo card labels the wallet as observed and never as Fomo-verified", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-gmgn-attributed-fomo-"));
  const payloads = [];
  const observedAt = new Date(Date.now() - 30_000).toISOString();
  const wallet = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const transactionHash = `0x${"3".repeat(64)}`;
  const blockNumber = 12_345_678;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});

  const result = await sendAlerts({
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    fomoCallEnabled: true,
    fomoCallAllowGmgnObservedWallets: true,
    fomoCallGmgnAttributionMaxAgeMs: 86_400_000,
    alertChineseTranslationEnabled: false,
  }, {
    type: "fomo_family_top_call",
    eventKey: "fomo-call:gmgn-attributed-card",
    signalKind: "top_blogger_first_buy",
    activity: "buy",
    qualified: true,
    strong: true,
    source: { id: "gmgn_kol_onchain", name: "GMGN BSC KOL feed", trust: "public_onchain_attributed" },
    chain: { id: 56, name: "BSC", slug: "bsc", gmgn: "bsc" },
    token,
    tokenSymbol: "CALL",
    walletAddress: wallet,
    caller: {
      handle: "caller",
      followers: 12_345,
      trafficRank: 1,
      followersSyncedAt: observedAt,
      identitySource: "gmgn+fxtwitter",
      twitter: "https://x.com/caller",
      xProfileId: "123456789",
    },
    walletAttribution: {
      scheme: "gmgn_x_maker_observation_v1",
      status: "observed",
      verified: false,
      candidateSource: "gmgn_bsc_kol_feed",
      ambiguousIdentity: false,
      ambiguousWallets: false,
      ambiguousHandles: false,
      monitoringWallet: wallet,
      xHandle: "caller",
      fomoTagged: true,
      tags: ["kol", "fomo"],
      observedAt,
      source: "gmgn_bsc_kol_feed",
      xProfileId: "123456789",
      xFollowersCheckedAt: observedAt,
      bscActivityCheckedAt: observedAt,
      bscTransactionCount: 1,
    },
    transactionHash,
    transactionUrl: `https://bscscan.com/tx/${transactionHash}`,
    blockNumber,
    positionProof: {
      status: "verified",
      complete: true,
      phase: "previous_block",
      previousBalanceRaw: "0",
      wallet,
      token,
      transactionHash,
      blockNumber,
    },
    amountUsd: 500,
    publishedAt: observedAt,
    observedAt,
    market: { liquidityUsd: 25_000, volumeM5: 9_000, marketCap: 420_000, sellsM5: 3 },
    security: {
      decision: "pass",
      metrics: { liquidityConfirmed: true, sellObserved: true },
    },
    explorerUrl: `https://bscscan.com/token/${token}`,
  });

  assert.equal(result.status, "delivered");
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /GMGN.*非 Fomo 验证/);
  assert.doesNotMatch(payloads[0].text, /钱包已验证绑定/);
  assertCompactCard(payloads[0]);
});

test("freshness classification uses absolute instants across timezones and exact boundaries", () => {
  const event = {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    timestamp: "2026-08-06T12:00:00+08:00",
  };
  const realtime = classifyAlertFreshness({}, event, "2026-08-06T04:10:00Z");
  const late = classifyAlertFreshness({}, event, "2026-08-06T06:00:00Z");
  const suppressed = classifyAlertFreshness({}, event, "2026-08-06T06:00:00.001Z");

  assert.equal(realtime.sourceOccurredAt, "2026-08-06T04:00:00.000Z");
  assert.equal(realtime.discoveredAt, "2026-08-06T04:10:00.000Z");
  assert.equal(realtime.lagMs, 600_000);
  assert.equal(realtime.decision, "realtime");
  assert.equal(late.lagMs, 7_200_000);
  assert.equal(late.decision, "late");
  assert.equal(suppressed.decision, "suppress");
  assert.equal(classifyAlertFreshness({}, { type: "launchpad_site_update", observedAt: "2020-01-01T00:00:00Z" }, Date.now()), null);
});

test("pon.fun delayed recovery uses the verified recovery instant while retaining original lag", () => {
  const recoveredAt = "2026-09-02T04:00:00.000Z";
  const sourceOccurredAt = "2026-09-02T01:00:00.000Z";
  const delayedRecovery = {
    version: 1,
    reason: "monitoring_gap_recovery",
    gapSince: "2026-09-02T01:10:00.000Z",
    sourceOccurredAt,
    recoveredAt,
    lagMs: 3 * 60 * 60_000,
    cursor: { nextBlockAtRecovery: 52_000_100, eventBlock: 52_000_001 },
  };
  const chain = classifyAlertFreshness({}, {
    type: "pon_fun_update",
    kind: "factory_config",
    platform: { id: "ponfun" },
    blockTimestamp: sourceOccurredAt,
    observedAt: recoveredAt,
    delayedRecovery,
  }, Date.parse(recoveredAt) + 1_000);
  const twitter = classifyAlertFreshness({}, {
    type: "twitter_update",
    project: { id: "ponfun", signalProfile: "pon_fun" },
    signal: { ponFunOfficial: true },
    tweet: { createdAt: sourceOccurredAt },
    observedAt: recoveredAt,
    delayedRecovery: {
      ...delayedRecovery,
      cursor: { latestIdAtRecovery: "2095099999999999999", tweetId: "2095100000000000000" },
    },
  }, Date.parse(recoveredAt) + 1_000);
  assert.equal(chain.scope, "pon_delayed_recovery");
  assert.equal(twitter.scope, "pon_delayed_recovery");
  assert.equal(chain.basis, "delayedRecovery.recoveredAt_continuous_recovery");
  assert.equal(twitter.basis, "delayedRecovery.recoveredAt_continuous_recovery");
  assert.equal(chain.decision, "realtime");
  assert.equal(twitter.decision, "realtime");
  assert.equal(chain.sourceOccurredAt, recoveredAt);
  assert.equal(twitter.sourceOccurredAt, recoveredAt);
  assert.equal(delayedRecovery.lagMs, 3 * 60 * 60_000);
});

test("pon.fun chain and X delayed recoveries pass the closed gate as T2 bilingual do-not-chase alerts", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-pon-delayed-e2e-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const recoveredAtMs = Date.parse("2026-09-02T04:00:00.000Z");
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    ponMonitorEnabled: true,
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertNow: () => recoveredAtMs,
  };
  const chainRecovery = ponDelayedPausedEvent({ recoveredAtMs });
  const staleOriginal = structuredClone(chainRecovery);
  staleOriginal.eventKey = staleOriginal.originalEventKey;
  delete staleOriginal.originalEventKey;
  delete staleOriginal.delayedRecovery;
  staleOriginal.title = "pon.fun Factory 已暂停";
  staleOriginal.summary = "Factory emitted Paused; new launches may be unavailable.";

  assert.equal(isMonitoringSourceEnabled(config, staleOriginal), true);
  const originalResult = await sendAlerts(config, staleOriginal);
  assert.equal(originalResult.status, "suppressed");
  assert.equal(originalResult.reason, "freshness_too_old");
  assert.equal(payloads.length, 0);

  assert.equal(isMonitoringSourceEnabled(config, chainRecovery), true);
  const chainResult = await sendAlerts(config, chainRecovery);
  assert.equal(chainResult.status, "delivered");
  const xRecovery = ponDelayedOfficialXEvent({ recoveredAtMs });
  assert.equal(isMonitoringSourceEnabled(config, xRecovery), true);
  const xResult = await sendAlerts(config, xRecovery);
  assert.equal(xResult.status, "delivered");
  assert.equal(payloads.length, 2);

  for (const payload of payloads) {
    assert.equal(payload.disable_notification, true);
    assert.ok(payload.text.length <= 600, `delayed recovery card is ${payload.text.length} characters: ${payload.text}`);
    assert.match(payload.text, /^平台：pon\.fun · T2/m);
    assert.match(payload.text, /^Platform: pon\.fun · T2/m);
    assert.match(payload.text, /监控恢复补报/);
    assert.match(payload.text, /勿追价/);
    assert.match(payload.text, /Delayed recovery/);
    assert.match(payload.text, /do not chase/);
  }

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[chainResult.eventId].event.tradingPriority.tier, "T2");
  assert.equal(outbox.events[xResult.eventId].event.tradingPriority.tier, "T2");
  assert.equal(outbox.events[chainResult.eventId].event.freshness.basis, "delayedRecovery.recoveredAt_continuous_recovery");
  assert.equal(outbox.events[xResult.eventId].event.freshness.basis, "delayedRecovery.recoveredAt_continuous_recovery");
});

test("pon.fun delayed recovery stays deliverable after the generic two-hour TTL but expires after seven days", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-pon-delayed-ttl-"));
  let clockMs = Date.parse("2026-09-02T04:00:00.000Z");
  let deliveryOnline = false;
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(Date, "now", () => clockMs);
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    if (!deliveryOnline) throw new Error("simulated Telegram outage");
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: fetchCalls } }) };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    ponMonitorEnabled: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertNow: () => clockMs,
  };

  const delayed = ponDelayedPausedEvent({ recoveredAtMs: clockMs });
  assert.equal((await sendAlerts(config, delayed)).status, "queued");
  assert.equal(fetchCalls, 1);
  deliveryOnline = true;
  clockMs += 3 * 60 * 60_000;
  const pendingOutbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(
    isMonitoringSourceEnabled(config, pendingOutbox.events[delayed.eventKey].event),
    true,
    JSON.stringify(pendingOutbox.events[delayed.eventKey].event, null, 2),
  );
  assert.equal(await drainAlertOutbox(config), 1);
  assert.equal(fetchCalls, 2, "the recovery summary remains deliverable after the ordinary two-hour queue TTL");
  let outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[delayed.eventKey].status, "delivered");

  deliveryOnline = false;
  const expired = ponDelayedPausedEvent({
    recoveredAtMs: clockMs,
    transactionHash: `0x${"c".repeat(64)}`,
    blockNumber: 52_000_101,
  });
  assert.equal((await sendAlerts(config, expired)).status, "queued");
  assert.equal(fetchCalls, 3);
  await mutateOutboxEntry(dataDir, expired.eventKey, (entry) => {
    entry.createdAt = new Date(clockMs - 7 * 24 * 60 * 60_000 - 1).toISOString();
    entry.destinations.telegram.nextAttemptAt = null;
  });
  deliveryOnline = true;
  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(fetchCalls, 3, "an over-seven-day recovery summary is not sent");
  outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[expired.eventKey].status, "suppressed");
  assert.equal(outbox.events[expired.eventKey].destinations.telegram.disabledReason, "delivery_ttl_expired");
  assert.equal(outbox.events[expired.eventKey].destinations.telegram.deliveryMaxAgeMs, 7 * 24 * 60 * 60_000);
});

test("GitHub repository discovery uses repository creation time instead of pretending recovery is realtime", () => {
  const stale = classifyAlertFreshness({}, {
    type: "github_repository_discovered",
    repositoryMetadata: { createdAt: "2026-08-01T00:00:00Z" },
    observedAt: "2026-08-18T09:00:00Z",
  }, "2026-08-18T09:00:00Z");
  assert.equal(stale.scope, "github");
  assert.equal(stale.basis, "repositoryMetadata.createdAt");
  assert.equal(stale.decision, "suppress");

  const missing = classifyAlertFreshness({}, {
    type: "github_repository_discovered",
    observedAt: "2026-08-18T09:00:00Z",
  }, "2026-08-18T09:00:00Z");
  assert.equal(missing.decision, "unassessed");
  assert.equal(missing.sourceOccurredAt, null, "observedAt must not become a fake source timestamp");
});

test("Binance Meme Rush baseline freshness trusts protocol create time but never observedAt", () => {
  const discoveredAt = "2026-08-06T08:00:00.000Z";
  const stale = classifyAlertFreshness({}, {
    type: "binance_official_update",
    kind: "meme_rush_capability",
    baselineDiscovery: true,
    changes: { newProtocols: [{ latestCreateTime: Date.parse("2026-08-05T12:00:00.000Z") }] },
    observedAt: discoveredAt,
  }, discoveredAt);
  const missing = classifyAlertFreshness({}, {
    type: "binance_official_update",
    kind: "meme_rush_capability",
    baselineDiscovery: true,
    changes: { newProtocols: [{ protocol: "2004" }] },
    observedAt: "2020-01-01T00:00:00.000Z",
  }, discoveredAt);
  const ordinaryDelta = classifyAlertFreshness({}, {
    type: "binance_official_update",
    kind: "meme_rush_capability",
    baselineDiscovery: false,
    changes: { newProtocols: [{ latestCreateTime: Date.parse("2020-01-01T00:00:00.000Z") }] },
  }, discoveredAt);

  assert.equal(stale.scope, "binance_announcement");
  assert.equal(stale.basis, "changes.newProtocols.latestCreateTime");
  assert.equal(stale.decision, "suppress");
  assert.equal(missing.decision, "unassessed");
  assert.equal(missing.sourceOccurredAt, null);
  assert.equal(missing.lagMs, null);
  assert.equal(ordinaryDelta, null);
});

test("30h BSC and 22h BNBS discoveries are audited without Telegram delivery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-stale-chain-"));
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("stale chain events must not reach Telegram");
  });
  const now = Date.now();
  const config = { ...alertConfig(dataDir), telegramStrongAlerts: true };
  const stale = [
    ["bsc-30h", "Unknown BSC Launchpad", 30],
    ["bnbs-22h", "BNBS Launchpad", 22],
  ];

  for (const [id, name, hours] of stale) {
    const result = await sendAlerts(config, {
      type: "bsc_launchpad_update",
      kind: "new_launchpad",
      eventKey: `bsc-launchpad:56:${id}`,
      platform: { id, name },
      timestamp: new Date(now - hours * 60 * 60_000).toISOString(),
      observedAt: new Date(now).toISOString(),
      launcher: `0x${String(hours).padStart(40, "0")}`,
      tokens: [],
      pools: [],
      mode: { selector: "0x12345678" },
    });
    assert.equal(result.status, "suppressed");
    assert.equal(result.freshness.decision, "suppress");
  }

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.version, 2);
  assert.equal(Object.keys(outbox.events).length, 2);
  for (const entry of Object.values(outbox.events)) {
    assert.equal(entry.status, "suppressed");
    assert.equal(entry.destinations.telegram.status, "disabled");
    assert.equal(entry.destinations.telegram.disabledReason, "freshness_too_old");
    assert.equal(entry.event.freshness.scope, "bsc_chain");
    assert.equal(entry.event.freshness.decision, "suppress");
    assert.ok(entry.event.freshness.lagMs > 2 * 60 * 60_000);
  }
  assert.equal(fetchCalls, 0);
});

test("1h X and GitHub updates become silent backfills while 3h updates are audit-only", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-stale-social-code-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), telegramStrongAlerts: true, alertChineseTranslationEnabled: false };
  const now = Date.now();
  const twitterEvent = (id, hours) => ({
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: { handle: "flapdotsh", id, text: "New launch mode deployed", createdAt: new Date(now - hours * 60 * 60_000).toISOString() },
    signal: { labels: ["新发射/新模式"] },
    observedAt: new Date(now).toISOString(),
  });
  const githubEvent = (commit, hours) => ({
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/contracts",
    sourceTrust: "official_verified",
    commit,
    committedAt: new Date(now - hours * 60 * 60_000).toISOString(),
    observedAt: new Date(now).toISOString(),
    message: "Add a new launch mode",
    files: [{ filename: "contracts/Mode.sol", status: "added", additions: 10, deletions: 0 }],
    modeChange: { candidate: true },
    url: `https://github.com/flap-sh/contracts/commit/${commit}`,
  });

  assert.equal((await sendAlerts(config, twitterEvent("late-x", 1))).status, "delivered");
  assert.equal((await sendAlerts(config, twitterEvent("stale-x", 3))).status, "suppressed");
  assert.equal((await sendAlerts(config, githubEvent("late-github", 1))).status, "delivered");
  assert.equal((await sendAlerts(config, githubEvent("stale-github", 3))).status, "suppressed");

  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.equal(payload.disable_notification, true);
    assert.match(payload.text, /^🕘 迟到补扫（延迟1小时）｜/);
    assert.doesNotMatch(payload.text, /🔴 强提醒/);
  }
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events["twitter:flapdotsh:stale-x"].event.freshness.scope, "twitter");
  assert.equal(outbox.events["twitter:flapdotsh:stale-x"].status, "suppressed");
  assert.equal(outbox.events["github:flap-sh/contracts:stale-github"].event.freshness.scope, "github");
  assert.equal(outbox.events["github:flap-sh/contracts:stale-github"].status, "suppressed");
});

test("a realtime chain event keeps strong delivery and records its freshness evidence", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-realtime-chain-"));
  let payload;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 909 } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), telegramStrongAlerts: true };
  const result = await sendAlerts(config, {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    eventKey: "bsc-mode:realtime-test",
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    observedAt: new Date().toISOString(),
    launcher: "0x1111111111111111111111111111111111111111",
    platform: { id: "fourmeme", name: "Four.Meme" },
    tokens: [],
    pools: [],
    mode: { selector: "proxy-upgrade", componentMode: "Factory" },
  });

  assert.equal(result.status, "delivered");
  assert.equal(payload.disable_notification, false);
  assert.match(payload.text, /^🔴 强提醒｜/);
  assert.doesNotMatch(payload.text, /迟到补扫/);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events["bsc-mode:realtime-test"];
  assert.equal(entry.event.freshness.decision, "realtime");
  assert.match(entry.event.freshness.sourceOccurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(entry.event.freshness.discoveredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(entry.event.freshness.lagMs >= 5 * 60_000);
});

test("a 20h Binance publication is audit-only while a freshly timestamped revision still delivers", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-revision-freshness-"));
  let payload;
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    fetchCalls += 1;
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 404 } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), alertChineseTranslationEnabled: false };
  const published = await sendAlerts(config, {
    type: "binance_official_update",
    kind: "announcement",
    changeType: "published",
    eventKey: "binance-announcement:published-freshness-test",
    project: { id: "binance", name: "Binance" },
    signal: { labels: ["现货首发"] },
    title: "Binance Will List a New Spot Asset",
    publishedAt: new Date(Date.now() - 20 * 60 * 60_000).toISOString(),
    observedAt: new Date().toISOString(),
    url: "https://www.binance.com/en/support/announcement/detail/published-freshness-test",
    strong: true,
  });
  assert.equal(published.status, "suppressed");
  assert.equal(published.freshness.scope, "binance_announcement");
  assert.equal(published.freshness.decision, "suppress");

  const result = await sendAlerts(config, {
    type: "binance_official_update",
    kind: "announcement",
    changeType: "revised",
    eventKey: "binance-announcement:revision-freshness-test",
    project: { id: "binance", name: "Binance" },
    signal: { labels: ["安全/紧急事件"] },
    title: "Security announcement materially revised",
    publishedAt: new Date(Date.now() - 20 * 60 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    url: "https://www.binance.com/en/support/announcement/detail/revision-freshness-test",
    strong: true,
  });

  assert.equal(result.status, "delivered");
  assert.equal(fetchCalls, 1, "the stale publication must not reach Telegram");
  assert.match(payload.text, /公告修订/);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events["binance-announcement:published-freshness-test"].status, "suppressed");
  assert.equal(outbox.events["binance-announcement:published-freshness-test"].destinations.telegram.status, "disabled");
  assert.equal(outbox.events["binance-announcement:revision-freshness-test"].event.freshness.basis, "updatedAt");
  assert.equal(outbox.events["binance-announcement:revision-freshness-test"].event.freshness.decision, "realtime");
});

test("Telegram delivery TTL stops a failed Binance revision retry after two hours", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-delivery-ttl-revision-"));
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("simulated Telegram outage");
  });
  t.mock.method(console, "error", () => {});
  const config = { ...alertConfig(dataDir), alertChineseTranslationEnabled: false };
  const eventId = "binance-announcement:revision-delivery-ttl";
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    changeType: "revised",
    eventKey: eventId,
    project: { id: "binance", name: "Binance" },
    signal: { labels: ["安全/紧急事件"] },
    title: "Security announcement materially revised",
    publishedAt: new Date(Date.now() - 20 * 60 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    url: "https://www.binance.com/en/support/announcement/detail/revision-delivery-ttl",
    strong: true,
  };

  assert.equal((await sendAlerts(config, event)).status, "queued", "a new revision gets one immediate delivery attempt");
  assert.equal(fetchCalls, 1);
  const queuedAt = new Date(Date.now() - config.alertTelegramDeliveryMaxAgeMs - 60_000).toISOString();
  await mutateOutboxEntry(dataDir, eventId, (entry) => {
    entry.createdAt = queuedAt;
    entry.destinations.telegram.nextAttemptAt = null;
  });

  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(fetchCalls, 1, "an expired Telegram destination must not be retried");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events[eventId];
  assert.equal(entry.status, "suppressed");
  assert.equal(entry.event.freshness.basis, "updatedAt", "revision freshness uses the official update timestamp");
  assert.equal(entry.destinations.telegram.status, "disabled");
  assert.equal(entry.destinations.telegram.disabledReason, "delivery_ttl_expired");
  assert.equal(entry.destinations.telegram.deliveryQueuedAt, queuedAt);
  assert.equal(entry.destinations.telegram.deliveryMaxAgeMs, config.alertTelegramDeliveryMaxAgeMs);
  assert.equal(entry.destinations.telegram.attempts, 1);
});

test("Fomo Telegram delivery TTL is fixed at five minutes from source time", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-fomo-delivery-ttl-"));
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("simulated Telegram outage");
  });
  t.mock.method(console, "error", () => {});
  const now = new Date().toISOString();
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    fomoCallEnabled: true,
    fomoPublishedCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoXCallEnabled: true,
    fomoPublishedCallMaxAgeMs: 120_000,
    alertChineseTranslationEnabled: false,
  };
  const event = {
    type: "fomo_family_top_call",
    signalKind: "fomo_published_call",
    eventKey: "fomo-published-call:alert-dedup-five-minute-ttl",
    callId: "alert-dedup-five-minute-ttl",
    stableId: "alert-dedup-five-minute-ttl",
    qualified: true,
    strong: true,
    source: { id: "fomo_family_official_thesis", trust: "official_authenticated_api" },
    sourceTrust: "official_authenticated_api",
    chain: { id: 56, chainId: 56, slug: "bsc" },
    token: "0x2222222222222222222222222222222222222222",
    contractAddress: "0x2222222222222222222222222222222222222222",
    caller: { handle: "alpha", twitter: "https://x.com/alpha", followers: 125_000 },
    thesis: { id: "alert-dedup-five-minute-ttl", text: "Buying the BSC token.", handle: "alpha", createdAt: now },
    publishedAt: now,
    observedAt: now,
    market: { liquidityUsd: 65_000 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
  };

  const queued = await sendAlerts(config, event);
  assert.equal(queued.status, "queued");
  const sourceAt = new Date(Date.now() - 5 * 60_000 - 1_000).toISOString();
  await mutateOutboxEntry(dataDir, queued.eventId, (entry) => {
    entry.createdAt = new Date().toISOString();
    entry.event.publishedAt = sourceAt;
    entry.event.observedAt = sourceAt;
    entry.event.thesis.createdAt = sourceAt;
    entry.destinations.telegram.nextAttemptAt = null;
  });

  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(fetchCalls, 1);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const expired = outbox.events[queued.eventId];
  assert.equal(expired.status, "suppressed");
  assert.equal(expired.destinations.telegram.disabledReason, "delivery_ttl_expired");
  assert.equal(expired.destinations.telegram.deliveryTimeBasis, "source_time");
  assert.equal(expired.destinations.telegram.deliveryMaxAgeMs, 300_000);
});

test("Telegram delivery TTL also expires an unassessed Pons alert without trusting observedAt", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-delivery-ttl-unassessed-"));
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("simulated Telegram outage");
  });
  t.mock.method(console, "error", () => {});
  const config = { ...alertConfig(dataDir), alertChineseTranslationEnabled: false };
  const factory = "0x6666666666666666666666666666666666666666";
  const eventId = `pons-v2-factory:${factory}`;

  assert.equal((await sendAlerts(config, {
    type: "pons_v2_factory_discovered",
    factory,
    source: "official_v2_hook",
    observedAt: new Date().toISOString(),
    verification: { launchEnabled: true, selectorMatches: ["launchEnabled()"] },
  })).status, "queued");
  await mutateOutboxEntry(dataDir, eventId, (entry) => {
    entry.createdAt = new Date(Date.now() - config.alertTelegramDeliveryMaxAgeMs - 60_000).toISOString();
    entry.destinations.telegram.nextAttemptAt = null;
  });

  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(fetchCalls, 1);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events[eventId];
  assert.equal(entry.event.freshness.decision, "unassessed");
  assert.equal(entry.event.freshness.sourceOccurredAt, null, "observedAt is not promoted to source time");
  assert.equal(entry.destinations.telegram.status, "disabled");
  assert.equal(entry.destinations.telegram.disabledReason, "delivery_ttl_expired");
});

test("a fresh pending Telegram destination remains retryable before delivery TTL", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-delivery-ttl-fresh-"));
  let shouldFail = true;
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    if (shouldFail) throw new Error("simulated Telegram outage");
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 515 } }) };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const config = { ...alertConfig(dataDir), alertChineseTranslationEnabled: false };
  const eventId = "binance-announcement:fresh-delivery-retry";
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    changeType: "revised",
    eventKey: eventId,
    project: { id: "binance", name: "Binance" },
    signal: { labels: ["安全/紧急事件"] },
    title: "Fresh material revision",
    observedAt: new Date().toISOString(),
    url: "https://www.binance.com/en/support/announcement/detail/fresh-delivery-retry",
  };

  assert.equal((await sendAlerts(config, event)).status, "queued");
  await mutateOutboxEntry(dataDir, eventId, (entry) => {
    entry.createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
    entry.destinations.telegram.nextAttemptAt = null;
  });
  shouldFail = false;

  assert.equal(await drainAlertOutbox(config), 1);
  assert.equal(fetchCalls, 2);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[eventId].status, "delivered");
  assert.equal(outbox.events[eventId].destinations.telegram.status, "delivered");
  assert.notEqual(outbox.events[eventId].destinations.telegram.disabledReason, "delivery_ttl_expired");
});

test("a duplicate cannot reset the first Telegram delivery TTL anchor", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-delivery-ttl-duplicate-"));
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("simulated Telegram outage");
  });
  t.mock.method(console, "error", () => {});
  const config = { ...alertConfig(dataDir), alertChineseTranslationEnabled: false };
  const eventId = "binance-announcement:duplicate-delivery-ttl";
  const first = {
    type: "binance_official_update",
    kind: "announcement",
    changeType: "revised",
    eventKey: eventId,
    project: { id: "binance", name: "Binance" },
    signal: { labels: ["安全/紧急事件"] },
    title: "First revision payload",
    observedAt: new Date().toISOString(),
    url: "https://www.binance.com/en/support/announcement/detail/duplicate-delivery-ttl",
  };

  assert.equal((await sendAlerts(config, first)).status, "queued");
  const firstCreatedAt = new Date(Date.now() - config.alertTelegramDeliveryMaxAgeMs - 60_000).toISOString();
  await mutateOutboxEntry(dataDir, eventId, (entry) => {
    entry.createdAt = firstCreatedAt;
    entry.destinations.telegram.nextAttemptAt = null;
  });

  const duplicate = await sendAlerts(config, {
    ...first,
    title: "Later duplicate payload",
    alertQueuedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  });
  assert.equal(duplicate.status, "suppressed");
  assert.equal(fetchCalls, 1, "the duplicate cannot force another Telegram request");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events[eventId];
  assert.equal(entry.createdAt, firstCreatedAt);
  assert.equal(entry.event.title, first.title);
  assert.equal(entry.duplicateCount, 1);
  assert.equal(entry.destinations.telegram.disabledReason, "delivery_ttl_expired");
  assert.equal(entry.destinations.telegram.deliveryQueuedAt, firstCreatedAt);
});

test("Telegram delivery TTL leaves a pending webhook eligible for retry", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-delivery-ttl-webhook-"));
  const calls = { telegram: 0, webhook: 0 };
  let webhookFails = true;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("api.telegram.org")) {
      calls.telegram += 1;
      throw new Error("simulated Telegram outage");
    }
    calls.webhook += 1;
    if (webhookFails) throw new Error("simulated webhook outage");
    return { ok: true, status: 204, text: async () => "" };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const config = {
    ...alertConfig(dataDir),
    alertChineseTranslationEnabled: false,
    webhookUrl: "https://webhook.test/delivery-ttl",
  };
  const eventId = "binance-announcement:delivery-ttl-webhook";
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    changeType: "revised",
    eventKey: eventId,
    project: { id: "binance", name: "Binance" },
    signal: { labels: ["安全/紧急事件"] },
    title: "Revision with two destinations",
    observedAt: new Date().toISOString(),
    url: "https://www.binance.com/en/support/announcement/detail/delivery-ttl-webhook",
  };

  assert.equal((await sendAlerts(config, event)).status, "queued");
  await mutateOutboxEntry(dataDir, eventId, (entry) => {
    entry.createdAt = new Date(Date.now() - config.alertTelegramDeliveryMaxAgeMs - 60_000).toISOString();
    entry.destinations.telegram.nextAttemptAt = null;
    entry.destinations.webhook.nextAttemptAt = null;
  });
  webhookFails = false;

  assert.equal(await drainAlertOutbox(config), 1);
  assert.deepEqual(calls, { telegram: 1, webhook: 2 });
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[eventId].destinations.telegram.status, "disabled");
  assert.equal(outbox.events[eventId].destinations.telegram.disabledReason, "delivery_ttl_expired");
  assert.equal(outbox.events[eventId].destinations.webhook.status, "delivered");
});

test("duplicate event keys retain the first forensic payload instead of overwriting it", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-duplicate-evidence-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("suppressed duplicate must not be delivered");
  });
  const config = alertConfig(dataDir);
  const base = {
    type: "bsc_launchpad_update",
    kind: "new_launchpad",
    eventKey: "bsc-launchpad:56:forensic-duplicate",
    timestamp: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
    observedAt: new Date().toISOString(),
    launcher: "0x2222222222222222222222222222222222222222",
    tokens: [],
    pools: [],
    mode: { selector: "0x12345678" },
  };

  await sendAlerts(config, { ...base, evidenceTag: "first" });
  await sendAlerts(config, { ...base, evidenceTag: "second", launcher: "0x3333333333333333333333333333333333333333" });

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events[base.eventKey];
  assert.equal(entry.event.evidenceTag, "first");
  assert.equal(entry.event.launcher, base.launcher);
  assert.equal(entry.duplicateCount, 1);
  assert.equal(entry.duplicateObservations.length, 1);
  assert.equal(entry.duplicateObservations[0].decision, "suppress");
  assert.match(entry.duplicateObservations[0].payloadDigest, /^[a-f0-9]{64}$/);
});

test("a stale duplicate cannot disable retry delivery for the first realtime payload", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-duplicate-delivery-eligibility-"));
  let fetchCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("simulated Telegram outage");
  });
  t.mock.method(console, "error", () => {});
  const config = alertConfig(dataDir);
  const eventKey = "bsc-launchpad:56:duplicate-delivery-eligibility";
  const first = {
    type: "bsc_launchpad_update",
    kind: "new_launchpad",
    eventKey,
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    observedAt: new Date().toISOString(),
    launcher: "0x4444444444444444444444444444444444444444",
    tokens: [],
    pools: [],
    mode: { selector: "0x12345678" },
    evidenceTag: "first-realtime",
  };

  assert.equal((await sendAlerts(config, first)).status, "queued");
  assert.equal((await sendAlerts(config, {
    ...first,
    timestamp: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
    launcher: "0x5555555555555555555555555555555555555555",
    evidenceTag: "late-duplicate",
  })).status, "queued");

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = outbox.events[eventKey];
  assert.equal(entry.event.evidenceTag, "first-realtime");
  assert.equal(entry.event.launcher, first.launcher);
  assert.equal(entry.event.freshness.decision, "realtime");
  assert.equal(entry.duplicateObservations[0].decision, "suppress");
  assert.equal(entry.status, "pending");
  assert.equal(entry.destinations.telegram.status, "failed");
  assert.notEqual(entry.destinations.telegram.disabledReason, "freshness_too_old");
  assert.equal(fetchCalls, 1, "the duplicate must not bypass the first failed attempt's retry backoff");
});

test("an idle outbox drain does not rewrite a terminal-only outbox", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-idle-outbox-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, result: { message_id: 616 } }),
  }));
  t.mock.method(console, "info", () => {});
  const config = alertConfig(dataDir);

  assert.equal((await sendAlerts(config, platformUpdate)).status, "delivered");
  const file = path.join(dataDir, "alert-outbox.json");
  const before = await fs.stat(file);

  assert.equal(await drainAlertOutbox(config), 0);
  const after = await fs.stat(file);
  assert.equal(after.ino, before.ino, "atomic outbox writer must not replace an unchanged idle file");
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("an idle outbox drain still persists retention pruning", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-outbox-prune-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, "alert-outbox.json");
  await fs.writeFile(file, `${JSON.stringify({
    version: 2,
    events: {
      "expired-terminal": {
        id: "expired-terminal",
        status: "suppressed",
        suppressedAt: "2020-01-01T00:00:00.000Z",
        destinations: {},
      },
    },
  }, null, 2)}\n`);
  const before = await fs.stat(file);

  assert.equal(await drainAlertOutbox(alertConfig(dataDir)), 0);
  const after = await fs.stat(file);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.events["expired-terminal"], undefined);
  assert.notEqual(after.ino, before.ino, "pruning must still replace the persisted outbox");
});

test("the outbox worker does not repeatedly parse an unchanged idle file", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-idle-worker-"));
  const file = path.join(dataDir, "alert-outbox.json");
  await fs.writeFile(file, `${JSON.stringify({
    version: 2,
    events: {
      terminal: {
        id: "terminal",
        status: "delivered",
        deliveredAt: new Date().toISOString(),
        destinations: {},
      },
    },
  })}\n`);
  const originalReadFile = fs.readFile.bind(fs);
  let outboxReads = 0;
  t.mock.method(fs, "readFile", async (...args) => {
    if (String(args[0]) === file) outboxReads += 1;
    return originalReadFile(...args);
  });
  const worker = startAlertOutboxWorker({ ...alertConfig(dataDir), alertRetryIntervalMs: 60_000 });
  t.after(() => {
    worker.stop();
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 1_000;
  while (outboxReads < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(outboxReads, 1, "startup performs one recovery inspection");

  assert.equal(await worker.run(), 0);
  assert.equal(outboxReads, 1, "unchanged idle signature skips JSON parsing until maintenance is due");
});

test("the outbox worker stop is idempotent, drains its active run, and prevents later runs", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-worker-stop-"));
  const file = path.join(dataDir, "alert-outbox.json");
  await fs.writeFile(file, `${JSON.stringify({ version: 2, events: {} })}\n`);
  const originalReadFile = fs.readFile.bind(fs);
  let outboxReads = 0;
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  t.mock.method(fs, "readFile", async (...args) => {
    if (String(args[0]) === file) {
      outboxReads += 1;
      await readGate;
    }
    return originalReadFile(...args);
  });

  const worker = startAlertOutboxWorker({ ...alertConfig(dataDir), alertRetryIntervalMs: 60_000 });
  t.after(async () => {
    releaseRead();
    await worker.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 1_000;
  while (outboxReads < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(outboxReads, 1, "the startup run reached the active durability read");

  const firstStop = worker.stop();
  assert.equal(worker.stop(), firstStop, "repeated stops share one drain boundary");
  let stopped = false;
  void firstStop.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop waits for the active outbox operation");

  releaseRead();
  await firstStop;
  assert.equal(stopped, true);
  const readsAtStop = outboxReads;
  assert.equal(await worker.run({ force: true }), 0);
  assert.equal(outboxReads, readsAtStop, "a stopped worker cannot begin another delivery drain");
});

test("pon.fun producer events pass the closed gate, render durably, and deduplicate by lifecycle stage", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-pon-shared-e2e-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const now = new Date().toISOString();
  const factory = "0xF698d13348686C1529c2DC54847C123424d9DAE0";
  const coin = "0x1111111111111111111111111111111111111111";
  const stockToken = "0x2222222222222222222222222222222222222222";
  const vault = "0x3333333333333333333333333333333333333333";
  const curve = "0x4444444444444444444444444444444444444444";
  const creator = "0x5555555555555555555555555555555555555555";
  const tx = `0x${"a".repeat(64)}`;
  const ponRisk = "PON coins are not the referenced stocks; backing, oracle, liquidity, sellability and admin controls remain risks.";
  const platform = {
    id: "ponfun",
    name: "pon.fun",
    website: "https://www.pon.fun/",
    twitter: "https://x.com/pondotfun",
    chainId: 4663,
    model: "stock-backed penny meme launchpad; the coin is not the stock",
  };
  const source = (url) => ({
    id: "pon_fun_official_api_onchain",
    name: "pon.fun official API + fingerprinted Factory",
    url,
    official: true,
    trust: "official_site_bound_onchain_fingerprinted",
  });
  const api = {
    healthUrl: "https://www.pon.fun/api/health",
    marketsUrl: "https://www.pon.fun/api/markets",
    tokenListUrl: "https://www.pon.fun/tokenlist.json",
  };
  const marketSnapshot = {
    ticker: "NVDA",
    symbol: "NVDAx",
    name: "NVIDIA Pon Market",
    coin,
    vault,
    curve,
    creator,
    creatorFeeBps: 200,
    createdAt: 1_788_277_484,
    stockToken,
    poolFee: 3_000,
    graduated: false,
    lpDeployed: false,
    backingPct: 95.8,
    progressBps: 100,
    marketCap: 15,
    reserve: 10,
    vol24: 5,
  };
  const marketCore = Object.fromEntries([
    "ticker", "symbol", "name", "coin", "vault", "curve", "creator", "creatorFeeBps", "createdAt",
  ].map((key) => [key, marketSnapshot[key]]));
  const creation = Object.fromEntries([
    "ticker", "symbol", "name", "coin", "vault", "curve", "creator", "creatorFeeBps",
  ].map((key) => [key, marketSnapshot[key]]));
  const market = {
    type: "pon_fun_update",
    kind: "market_created",
    eventKey: `pon-fun:market_created:4663:${tx}:7`,
    platform,
    source: source(`https://robinhoodchain.blockscout.com/tx/${tx}`),
    sourceTrust: "official_site_bound_onchain_fingerprinted",
    chainId: 4663,
    factory,
    title: "pon.fun 新市场：NVDAx / NVDA",
    summary: "A new pon.fun MarketCreated event matches the official markets API, token list and Factory getters.",
    observedAt: now,
    strong: true,
    risk: ponRisk,
    token: coin,
    contractAddress: coin,
    ticker: "NVDA",
    symbol: "NVDAx",
    market: marketSnapshot,
    currentSnapshot: structuredClone(marketSnapshot),
    changes: { market: { before: null, after: marketCore } },
    creation,
    transactionHash: tx,
    blockNumber: 52_000_001,
    blockHash: `0x${"b".repeat(64)}`,
    blockTimestamp: now,
    explorerUrl: `https://robinhoodchain.blockscout.com/tx/${tx}`,
    evidence: {
      chainId: 4663,
      factory,
      factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
      topic0: "0x8ada27e0afa58f4d4be8c4edbf4bfd49d9d586ce8a714938b12f51b7855893bb",
      logIndex: 7,
      receiptVerified: true,
      api,
    },
  };
  const config = {
    ...alertConfig(dataDir),
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    ponMonitorEnabled: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
  };

  assert.equal(isMonitoringSourceEnabled(config, market), true);
  assert.deepEqual(ponFunNoveltyKeys(market), [`pon:${coin}:created`]);
  assert.deepEqual(focusNoveltyKeys(market), [], "Pon never enters the generic focus novelty namespace");
  const first = await sendAlerts(config, market);
  assert.equal(first.status, "delivered");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].disable_notification, true, "ordinary MarketCreated is T2");
  assert.ok(payloads[0].text.length <= 600);
  assert.match(payloads[0].text, /^🔔 监控提醒 \| MONITOR ALERT/m);
  assert.match(payloads[0].text, /^平台：pon\.fun · T2/m);
  assert.match(payloads[0].text, /^更新了什么：/m);
  assert.match(payloads[0].text, /^Platform: pon\.fun · T2/m);
  assert.match(payloads[0].text, /^What changed: /m);

  const officialX = {
    type: "twitter_update",
    project: {
      id: "ponfun",
      name: "pon.fun",
      website: "https://www.pon.fun",
      twitter: "https://x.com/pondotfun",
      handle: "pondotfun",
      xUserId: "2094048312772993024",
      match: "official_x",
      signalProfile: "pon_fun",
    },
    tweet: {
      id: "2095100000000000000",
      handle: "pondotfun",
      authorId: "2094048312772993024",
      xUserId: "2094048312772993024",
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
      url: "https://x.com/pondotfun/status/2095100000000000000",
      createdAt: now,
      text: `A new market is live: ${coin}`,
    },
    signal: {
      relevant: true,
      strong: false,
      labels: ["pon.fun 市场/RWA 更新"],
      ponFunOfficial: true,
      ponKind: "market_created",
      ponStage: "created",
      ponAsset: coin,
      tokenAddress: coin,
      ponPriority: "T2",
      platformStructural: false,
      majorProductUpdate: false,
      reason: "official_market_or_stock_information",
    },
    observedAt: now,
  };
  assert.equal(isMonitoringSourceEnabled(config, officialX), true);
  assert.deepEqual(ponFunNoveltyKeys(officialX), [`pon:${coin}:created`]);
  const duplicate = await sendAlerts(config, officialX);
  assert.equal(duplicate.status, "suppressed");
  assert.equal(duplicate.reason, "semantic_duplicate");
  assert.equal(payloads.length, 1);

  let lifecycleRevision = 0;
  const lifecycle = (stage, changes) => {
    const transitionRevision = ++lifecycleRevision;
    const apiHealthBlock = 52_000_000 + transitionRevision;
    const bindingVerifiedAtBlock = 52_000_001;
    const previousSnapshot = {
      ...marketSnapshot,
      ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, value.before])),
      baseline: true,
      firstSeenAt: now,
    };
    const currentSnapshot = {
      ...marketSnapshot,
      ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, value.after])),
    };
    return {
      type: "pon_fun_update",
      kind: "market_lifecycle",
      eventKey: `pon-fun:market-lifecycle:${coin.toLowerCase()}:rev:${transitionRevision}:api:${apiHealthBlock}:binding:${bindingVerifiedAtBlock}`,
      platform,
      source: source("https://www.pon.fun/api/markets"),
      sourceTrust: "official_site_bound_onchain_fingerprinted",
      chainId: 4663,
      factory,
      title: "pon.fun 市场状态更新：NVDAx",
      summary: "The official market lifecycle changed after its Factory identity was re-verified on-chain.",
      observedAt: now,
      strong: true,
      risk: ponRisk,
      token: coin,
      contractAddress: coin,
      ticker: "NVDA",
      symbol: "NVDAx",
      market: currentSnapshot,
      previousSnapshot,
      currentSnapshot: structuredClone(currentSnapshot),
      changes,
      evidence: {
        chainId: 4663,
        factory,
        factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
        bindingVerifiedAtBlock,
        bindingVerifiedAtBlockHash: `0x${"7".repeat(64)}`,
        apiHealthBlock,
        transitionRevision,
        api,
      },
    };
  };
  const graduated = lifecycle("graduated", { graduated: { before: false, after: true } });
  const lpDeployed = lifecycle("lp-deployed", { lpDeployed: { before: false, after: true } });
  assert.equal(isMonitoringSourceEnabled(config, graduated), true);
  for (const [label, mutate] of [
    ["revision key", (candidate) => { candidate.eventKey = candidate.eventKey.replace(":rev:1:", ":rev:2:"); }],
    ["typed revision", (candidate) => { candidate.evidence.transitionRevision = "1"; }],
    ["typed API block", (candidate) => { candidate.evidence.apiHealthBlock = String(candidate.evidence.apiHealthBlock); }],
    ["binding hash", (candidate) => { candidate.evidence.bindingVerifiedAtBlockHash = "0x1234"; }],
    ["extra evidence", (candidate) => { candidate.evidence.untrusted = true; }],
  ]) {
    const candidate = structuredClone(graduated);
    mutate(candidate);
    assert.equal(isMonitoringSourceEnabled(config, candidate), false, `market lifecycle rejects ${label} mismatch`);
  }
  assert.deepEqual(ponFunNoveltyKeys(graduated), [`pon:${coin}:graduated`]);
  assert.deepEqual(ponFunNoveltyKeys(lpDeployed), [`pon:${coin}:lp_deployed`]);
  assert.equal((await sendAlerts(config, graduated)).status, "delivered");
  assert.equal((await sendAlerts(config, lpDeployed)).status, "delivered");
  assert.equal(payloads.length, 3, "created, graduated and LP deployed remain independent stages");

  const poolFeeFirst = {
    ...lifecycle("pool-fee", { poolFee: { before: 3_000, after: 10_000 } }),
  };
  const poolFeeRepeated = {
    ...lifecycle("pool-fee", { poolFee: { before: 3_000, after: 10_000 } }),
  };
  assert.notDeepEqual(
    ponFunNoveltyKeys(poolFeeFirst),
    ponFunNoveltyKeys(poolFeeRepeated),
    "a later repeat of the same mutable lifecycle transition needs its own durable revision identity",
  );

  const delisted = {
    ...market,
    kind: "stock_listing",
    eventKey: `pon-fun:stock-listing:4663:${`0x${"9".repeat(64)}`}:0`,
    transactionHash: `0x${"9".repeat(64)}`,
    currentSnapshot: { ticker: "NVDA", stockToken: coin, poolFee: 3_000, active: false },
    changes: { active: { before: true, after: false } },
    evidence: {
      ...market.evidence,
      topic0: "0x7740fd3f56c396ca150bbd7ec72ee92798920ea8eb3f25f9a03582dc9bb564b1",
      logIndex: 0,
      receiptVerified: true,
    },
  };
  assert.equal(ponFunNoveltyKeys(delisted).some((key) => key.includes(":stock_delisted")), true);
  assert.equal(ponFunNoveltyKeys(delisted).some((key) => key.includes(":tx:")), true);

  const factoryConfig = ({ transactionHash, logIndex, changes }) => {
    const defaults = {
      oracle: `0x${"1".repeat(40)}`,
      swapRouter: vault,
      positionManager: curve,
      protocolTreasury: creator,
    };
    const previousSnapshot = {
      ...defaults,
      ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, value.before])),
    };
    const currentSnapshot = {
      ...defaults,
      ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, value.after])),
    };
    return {
      type: "pon_fun_update",
      kind: "factory_config",
      eventKey: `pon-fun:factory_config:4663:${transactionHash.toLowerCase()}:${logIndex}`,
      platform,
      source: source(`https://robinhoodchain.blockscout.com/tx/${transactionHash}`),
      sourceTrust: "official_site_bound_onchain_fingerprinted",
      chainId: 4663,
      factory,
      title: "pon.fun Factory 配置更新",
      summary: "Factory emitted ConfigSet; oracle/router/position manager/treasury values are shown exactly.",
      observedAt: now,
      strong: true,
      risk: ponRisk,
      previousSnapshot,
      currentSnapshot,
      changes,
      transactionHash,
      blockNumber: 52_000_010 + logIndex,
      blockHash: `0x${String(logIndex + 1).repeat(64)}`,
      blockTimestamp: now,
      explorerUrl: `https://robinhoodchain.blockscout.com/tx/${transactionHash}`,
      evidence: {
        chainId: 4663,
        factory,
        factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
        topic0: "0x8d4f9022ab10978259dead0fa01463e75fda43dfe57f0445e69b010074c016fd",
        logIndex,
        receiptVerified: true,
        api,
      },
    };
  };
  const configA = factoryConfig({
    transactionHash: `0x${"c".repeat(64)}`,
    logIndex: 0,
    changes: { oracle: { before: `0x${"1".repeat(40)}`, after: `0x${"2".repeat(40)}` } },
  });
  const configB = factoryConfig({
    transactionHash: `0x${"d".repeat(64)}`,
    logIndex: 1,
    changes: { oracle: { before: `0x${"1".repeat(40)}`, after: `0x${"2".repeat(40)}` } },
  });
  const configBChanged = factoryConfig({
    transactionHash: configB.transactionHash,
    logIndex: configB.evidence.logIndex,
    changes: { oracle: { before: `0x${"2".repeat(40)}`, after: `0x${"3".repeat(40)}` } },
  });
  const configC = factoryConfig({
    transactionHash: `0x${"e".repeat(64)}`,
    logIndex: 2,
    changes: configBChanged.changes,
  });
  assert.notDeepEqual(ponFunNoveltyKeys(configA), ponFunNoveltyKeys(configB), "different tx/log proofs need distinct control-event identities");
  assert.notDeepEqual(ponFunNoveltyKeys(configB), ponFunNoveltyKeys(configBChanged), "different normalized changes need distinct control-event identities");
  assert.equal((await sendAlerts(config, configA)).status, "delivered");
  assert.equal((await sendAlerts(config, configB)).status, "delivered");
  assert.equal((await sendAlerts(config, configC)).status, "delivered");
  assert.equal(payloads.length, 6, "three independently proven config revisions remain alertable inside six hours");

  const platformToken = "0x7673dc6d2357bdc2e04fd80c169f2bef56622d9a";
  let platformRevision = 0;
  const platformTokenUpdate = (before, after) => {
    const beforeSupply = String(before);
    const afterSupply = String(after);
    const changes = { supply: { before: beforeSupply, after: afterSupply } };
    const transitionRevision = ++platformRevision;
    const apiHealthBlock = 52_000_010 + transitionRevision;
    const bindingVerifiedAtBlock = 52_000_020;
    const bindingVerifiedAtBlockHash = `0x${"8".repeat(64)}`;
    return {
      type: "pon_fun_update",
      kind: "platform_token_update",
      eventKey: `pon-fun:platform-token:${platformToken}:rev:${transitionRevision}:api:${apiHealthBlock}:binding:${bindingVerifiedAtBlock}`,
      platform,
      source: source("https://www.pon.fun/api/ponfun"),
      sourceTrust: "official_site_bound_onchain_fingerprinted",
      chainId: 4663,
      factory,
      title: "pon.fun 平台代币资料更新",
      summary: "The official PONFUN token metadata changed while the platform Factory identity remained verified.",
      observedAt: now,
      strong: true,
      risk: ponRisk,
      token: platformToken,
      contractAddress: platformToken,
      symbol: "PONFUN",
      previousSnapshot: { address: platformToken, name: "Ponfun", symbol: "PONFUN", supply: beforeSupply },
      currentSnapshot: { address: platformToken, name: "Ponfun", symbol: "PONFUN", supply: afterSupply },
      changes,
      evidence: {
        chainId: 4663,
        factory,
        factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
        bindingVerifiedAtBlock,
        bindingVerifiedAtBlockHash,
        apiHealthBlock,
        transitionRevision,
        platformToken: {
          token: platformToken,
          codePresent: true,
          codeHash: `0x${"6".repeat(64)}`,
          name: "Ponfun",
          symbol: "PONFUN",
          decimals: 18,
          totalSupplyRaw: (BigInt(after) * 10n ** 18n).toString(),
          verifiedBlock: bindingVerifiedAtBlock,
          verifiedBlockHash: bindingVerifiedAtBlockHash,
        },
        api: { healthUrl: "https://www.pon.fun/api/health", platformTokenUrl: "https://www.pon.fun/api/ponfun" },
      },
    };
  };
  const firstBurn = platformTokenUpdate(1_000_000_000, 900_000_000);
  const secondBurn = platformTokenUpdate(900_000_000, 800_000_000);
  assert.equal(isMonitoringSourceEnabled(config, firstBurn), true);
  for (const [label, mutate] of [
    ["total supply", (candidate) => { candidate.evidence.platformToken.totalSupplyRaw = "1"; }],
    ["code hash", (candidate) => { candidate.evidence.platformToken.codeHash = "0x1234"; }],
    ["verified block hash", (candidate) => { candidate.evidence.platformToken.verifiedBlockHash = `0x${"9".repeat(64)}`; }],
    ["typed decimals", (candidate) => { candidate.evidence.platformToken.decimals = "18"; }],
    ["fixed token", (candidate) => { candidate.evidence.platformToken.token = coin; }],
  ]) {
    const candidate = structuredClone(firstBurn);
    mutate(candidate);
    assert.equal(isMonitoringSourceEnabled(config, candidate), false, `platform token rejects ${label} mismatch`);
  }
  assert.notDeepEqual(ponFunNoveltyKeys(firstBurn), ponFunNoveltyKeys(secondBurn), "separate normalized supply deltas need distinct identities");
  assert.deepEqual(
    ponFunNoveltyKeys({ ...firstBurn, changes: { supply: { after: "900000000", before: "1000000000" } } }),
    ponFunNoveltyKeys(firstBurn),
    "equivalent field ordering and numeric representations normalize to one change identity",
  );
  assert.equal((await sendAlerts(config, firstBurn)).status, "delivered");
  assert.equal((await sendAlerts(config, secondBurn)).status, "delivered");
  assert.equal(payloads.length, 8, "separate supply revisions remain alertable inside six hours");

  const laterStageObservation = {
    ...officialX,
    tweet: {
      ...officialX.tweet,
      id: "2095100000000000001",
      text: "pon.fun Factory configuration updated",
      url: "https://x.com/pondotfun/status/2095100000000000001",
    },
    signal: {
      ...officialX.signal,
      ponKind: "factory_config",
      ponStage: "factory_config",
      ponAsset: "PONFUN",
      tokenAddress: undefined,
      ponPriority: "T1",
      labels: ["pon.fun 重大结构更新"],
      platformStructural: true,
      majorProductUpdate: true,
      strong: true,
      reason: "official_factory_config_or_major_product_change",
    },
  };
  assert.match(ponFunNoveltyKeys(laterStageObservation).join("\n"), /:x-tweet:2095100000000000001$/m);
  const laterStageResult = await sendAlerts(config, laterStageObservation);
  assert.equal(laterStageResult.status, "delivered", `a stage-only X post remains independently alertable without shared exact evidence: ${JSON.stringify(laterStageResult)}`);
  const separateStageObservation = {
    ...laterStageObservation,
    tweet: {
      ...laterStageObservation.tweet,
      id: "2095100000000000002",
      text: "pon.fun Factory treasury configuration migrated",
      url: "https://x.com/pondotfun/status/2095100000000000002",
    },
    signal: {
      ...laterStageObservation.signal,
      claims: ["pon.fun Factory treasury configuration migrated"],
      keyChanges: ["pon.fun Factory treasury configuration migrated"],
    },
  };
  assert.notDeepEqual(ponFunNoveltyKeys(laterStageObservation), ponFunNoveltyKeys(separateStageObservation));
  assert.equal((await sendAlerts(config, separateStageObservation)).status, "delivered", "two distinct official X control updates cannot collapse to their shared stage");
  assert.equal(payloads.length, 10);

  const claimFallbackObservation = {
    ...separateStageObservation,
    tweet: { ...separateStageObservation.tweet, id: null },
  };
  assert.match(ponFunNoveltyKeys(claimFallbackObservation).join("\n"), /:x-claim:[a-f0-9]{24}$/m, "a normalized claim digest is the fallback when a tweet ID is unavailable");

  const exactTxObservation = {
    ...laterStageObservation,
    tweet: {
      ...laterStageObservation.tweet,
      id: "2095100000000000003",
      text: `pon.fun Factory configuration updated in ${configA.transactionHash}`,
      url: "https://x.com/pondotfun/status/2095100000000000003",
    },
    signal: {
      ...laterStageObservation.signal,
      transactionHash: configA.transactionHash,
    },
  };
  assert.equal((await sendAlerts(config, exactTxObservation)).status, "suppressed", "a shared exact transaction still folds an X observation into its chain event");
  assert.equal(payloads.length, 10);

  const configAddress = configA.changes.oracle.after;
  const exactCaObservation = {
    ...laterStageObservation,
    tweet: {
      ...laterStageObservation.tweet,
      id: "2095100000000000004",
      text: `pon.fun Factory oracle configuration updated to ${configAddress}`,
      url: "https://x.com/pondotfun/status/2095100000000000004",
    },
    signal: {
      ...laterStageObservation.signal,
      tokenAddress: configAddress,
    },
  };
  const sharedCaKey = `pon:PONFUN:factory_config:ca:${configAddress.toLowerCase()}`;
  assert.equal(ponFunNoveltyKeys(configA).includes(sharedCaKey), true);
  assert.equal(ponFunNoveltyKeys(exactCaObservation).includes(sharedCaKey), true);
  assert.equal((await sendAlerts(config, exactCaObservation)).status, "suppressed", "a shared exact CA still folds an X observation into its chain event");
  assert.equal(payloads.length, 10);

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[first.eventId].event.tradingPriority.tier, "T2");
  assert.deepEqual(outbox.events[first.eventId].event.canonicalSignalIds, [`pon:${coin}:created`]);
  assert.equal(outbox.events[first.eventId].renderBundle.version, 17);
  assert.equal(outbox.events[duplicate.eventId].semanticDuplicateOf, first.eventId);
});
