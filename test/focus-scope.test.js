import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drainAlertOutbox, isTerminalAlertSuppression, sendAlerts } from "../src/alerts.js";
import {
  isMonitoringSourceEnabled,
  isTelegramNewsUpdateAllowed,
  isThreePlatformSource,
} from "../src/source-controls.js";
import { createTwitterMonitor } from "../src/twitter-monitor.js";

const focusConfig = { monitorScope: "focus3", ponsMonitorEnabled: false };
const binanceFocusConfig = { ...focusConfig, binanceMonitorEnabled: true };
const aiFocusConfig = { ...focusConfig, xaiOfficialMonitorEnabled: true };

const aiXTargets = [
  { id: "x", name: "X", website: "https://x.com", docs: "https://help.x.com/en/using-x", twitter: "https://x.com/X", handle: "X", xUserId: "783214", match: "official_x", signalProfile: "ai" },
  { id: "xai", name: "xAI", website: "https://x.ai", docs: "https://docs.x.ai", twitter: "https://x.com/SpaceXAI", handle: "SpaceXAI", xUserId: "1661523610111193088", match: "official_x", signalProfile: "ai" },
  { id: "grok", name: "Grok", website: "https://grok.com", docs: "https://docs.x.ai", twitter: "https://x.com/grok", handle: "grok", xUserId: "1720665183188922368", match: "official_x", signalProfile: "ai" },
  { id: "x-api", name: "X API", website: "https://docs.x.com", docs: "https://docs.x.com/changelog", twitter: "https://x.com/API", handle: "API", xUserId: "6253282", match: "official_x", signalProfile: "ai" },
];

const aiTwitterEvent = (target) => ({
  type: "twitter_update",
  project: {
    ...target,
  },
  tweet: {
    handle: target.handle,
    xUserId: target.xUserId,
    authorId: target.xUserId,
    url: `https://x.com/${target.handle}/status/1234567890`,
  },
});

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("focus3 accepts only structural first-party updates from Flap, Four.Meme, and Pools.trade", () => {
  const allowed = [
    {
      type: "bsc_launchpad_update",
      kind: "new_mode",
      platform: { id: "flap", name: "Flap" },
      structural: { eligible: true },
      strong: true,
    },
    {
      type: "bsc_launchpad_update",
      kind: "new_launchpad",
      officialFirstToken: true,
      platform: { id: "flap", name: "Flap" },
      structural: { eligible: true },
      strong: true,
    },
    {
      type: "platform_capability_update",
      platform: { id: "fourmeme", name: "Four.meme" },
      changes: { newModules: ["OpenFour V2"] },
    },
    {
      type: "platform_capability_update",
      platform: { id: "fourmeme", name: "Four.meme" },
      changes: { newChains: [{ name: "Base", chainId: 8453, environment: "mainnet" }] },
    },
    {
      type: "github_module_update",
      launchpad: "Flap",
      repository: "flap-sh/flap-skills",
      sourceTrust: "official_verified",
      modeChange: { candidate: true },
    },
    {
      type: "github_module_update",
      launchpad: "UniswapX",
      repository: "Uniswap/UniswapX",
      sourceTrust: "official_verified",
      uniswapOfficial: true,
      strong: true,
      chainSupportChange: {
        candidate: true,
        chains: [{ name: "Base", chainId: 8453, environment: "mainnet" }],
      },
    },
    {
      type: "github_monitor_gap",
      launchpad: "Flap",
      repository: "flap-sh/flap-skills",
      sourceTrust: "official_verified",
      priority: true,
      pollingClass: "core_priority",
    },
    {
      type: "github_monitor_gap",
      launchpad: "Four.meme",
      repository: "four-meme-community/openfour-docs",
      sourceTrust: "official_verified",
      priority: true,
      pollingClass: "core_priority",
    },
    {
      type: "github_monitor_gap",
      launchpad: "Uniswap",
      repository: "Uniswap/contracts",
      sourceTrust: "official_verified",
      uniswapOfficial: true,
    },
    {
      type: "uniswap_official_update",
      kind: "github_release",
      strong: true,
      repository: "Uniswap/liquidity-launcher",
      title: "Liquidity Launcher v4 adds a new instant launch strategy",
    },
    {
      type: "twitter_update",
      project: { id: "uniswap-pools", signalProfile: "uniswap-pools" },
      signal: { relevant: true, strong: true, labels: ["Uniswap 新发射/新模式"] },
      tweet: { text: "Pools.trade adds a new Crowd Launch mode" },
    },
    {
      type: "twitter_update",
      project: { id: "flap" },
      signal: { relevant: true, strong: true, platformStructural: true, labels: ["新发射/新模式"] },
      tweet: { text: "Flap adds a new Vault V2 module" },
    },
    {
      type: "twitter_update",
      project: { id: "flap", criticalProfile: "focus_launchpad" },
      signal: { relevant: true, strong: true, platformStructural: true, labels: ["Agent/Skill 集成"] },
      tweet: { text: "Flap token-launch skill is now available through Binance Agentic Wallet." },
    },
    {
      type: "twitter_update",
      project: { id: "flap" },
      signal: { relevant: true, strong: true, platformStructural: true, labels: ["新增链支持"], chainSupport: [{ name: "Base", chainId: 8453 }] },
      tweet: { text: "Flap is now live on Base" },
    },
    {
      type: "uniswap_official_update",
      kind: "blog",
      strong: true,
      chainSupport: [{ name: "Base", chainId: 8453 }],
      title: "Uniswap launches on Base",
      url: "https://blog.uniswap.org/uniswap-on-base",
    },
    {
      type: "launchpad_site_update",
      launchpad: { id: "uniswap-pools", name: "Pools.trade", website: "https://pools.trade" },
      newChains: [{ name: "Base", chainId: 8453, environment: "mainnet" }],
      chainSupport: [{ name: "Base", chainId: 8453, environment: "mainnet" }],
    },
    {
      type: "token_launch",
      modeStatus: "new_mode_confirmed",
      modeConfirmation: { observations: 2 },
      launchpad: { id: "flap", match: "exact_factory" },
    },
  ];
  for (const event of allowed) assert.equal(isMonitoringSourceEnabled(focusConfig, event), true, JSON.stringify(event));
});

test("focus3 rejects other platforms, ordinary activity, campaigns, untrusted gaps, and broad Uniswap chatter", () => {
  const rejected = [
    { type: "binance_official_update", platform: { id: "binance" }, strong: true },
    { type: "fomo_family_top_call", platform: { id: "fourmeme" }, qualified: true },
    { type: "official_activity", project: "Uniswap", activity: "buy" },
    { type: "early_activity_alert", entry: { launchpad: { id: "flap" } }, activity: "volume_anomaly", stage: 3 },
    { type: "bsc_launchpad_update", kind: "new_mode", platform: { id: "bullshot" }, structural: { eligible: true }, strong: true },
    { type: "bsc_launchpad_update", kind: "new_launchpad", platform: { id: "flap" }, structural: { eligible: true }, strong: true },
    { type: "bsc_launchpad_update", kind: "new_launchpad", officialFirstToken: false, platform: { id: "flap" }, structural: { eligible: true }, strong: true },
    { type: "bsc_launchpad_update", kind: "new_launchpad", officialFirstToken: true, platform: { id: "flap" }, structural: { eligible: false }, strong: true },
    { type: "bsc_launchpad_update", kind: "new_launchpad", officialFirstToken: true, platform: { id: "flap" }, structural: { eligible: true }, strong: false },
    { type: "bsc_launchpad_update", kind: "new_mode", platform: { id: "flap" }, structural: { eligible: false }, strong: true },
    { type: "platform_capability_update", platform: { id: "fourmeme" }, changes: { newCampaigns: ["meme contest"] } },
    { type: "platform_capability_update", platform: { id: "fourmeme" }, changes: { newModules: ["RWA stock-meme issuance"] } },
    { type: "github_monitor_gap", launchpad: "Flap", repository: "flap-sh/flap-skills" },
    { type: "github_monitor_gap", launchpad: "Four.meme", repository: "Four-Meme/Four-Smart-Contracts", sourceTrust: "unverified_candidate", priority: true, pollingClass: "core_priority" },
    { type: "github_monitor_gap", launchpad: "Flap", repository: "flap-sh/experimental-launcher", sourceTrust: "official_verified", priority: false, pollingClass: "organization_dynamic" },
    { type: "github_monitor_gap", launchpad: "Uniswap", repository: "Uniswap/random-docs", sourceTrust: "official_verified", uniswapOfficial: true },
    { type: "github_repository_verified", launchpad: "Flap", repository: "flap-sh/flap-skills", sourceTrust: "official_verified" },
    { type: "github_repository_discovered", launchpad: "Four.meme", repository: "four-meme-community/stock-meme-launcher", sourceTrust: "official_verified" },
    { type: "launchpad_site_update", launchpad: { id: "flap" }, newKeywords: ["v2"] },
    { type: "launchpad_site_update", launchpad: { id: "flap" }, newFeatures: ["fair_launch", "tokenomics"] },
    { type: "launchpad_site_update", launchpad: { id: "fourmeme" }, url: "https://four.meme/en/stock-meme", newContracts: ["0x1111111111111111111111111111111111111111"] },
    { type: "github_module_update", launchpad: "Four.meme", repository: "Four-Meme/Four-Smart-Contracts", sourceTrust: "unverified_candidate", modeChange: { candidate: true } },
    { type: "github_module_update", launchpad: "Four.meme", repository: "four-meme-community/openfour-contracts", sourceTrust: "official_verified", strong: true, modeChange: { candidate: true }, message: "feat: add tokenized equity issuance module" },
    { type: "github_module_update", launchpad: "UniswapX", repository: "Uniswap/UniswapX", sourceTrust: "official_verified", strong: true, modeChange: { candidate: true } },
    { type: "uniswap_official_update", kind: "governance", strong: true, title: "Activate v4 protocol fees", labels: ["Uniswap 治理/费用"], url: "https://gov.uniswap.org/t/fees/1" },
    { type: "uniswap_official_update", kind: "blog", strong: true, title: "Permissioned pools for tokenized securities", labels: ["Uniswap 新底池/Hook"], url: "https://blog.uniswap.org/permissioned-pools" },
    { type: "token_launch", modeStatus: "known_mode", launchpad: { id: "uniswap-pools" } },
    { type: "token_launch", modeStatus: "new_mode_candidate", launchpad: { id: "flap", match: "exact_factory" } },
    { type: "token_launch", modeStatus: "new_mode_confirmed", modeConfirmation: { observations: 1 }, launchpad: { id: "flap", match: "exact_factory" } },
    { type: "github_module_update", launchpad: "Uniswap", repository: "Uniswap/universal-router", sourceTrust: "official_verified", strong: true, modeChange: { candidate: true }, message: "feat: add new router" },
    { type: "uniswap_official_update", kind: "blog", strong: true, title: "New pool for DOG token", url: "https://blog.uniswap.org/new-pool-for-dog" },
    { type: "uniswap_official_update", kind: "blog", strong: true, title: "New pool mechanism for tokenized stocks", url: "https://blog.uniswap.org/tokenized-stocks-pool" },
    { type: "uniswap_official_update", kind: "blog", strong: true, title: "Security-token launchpad is live", url: "https://blog.uniswap.org/security-token-launchpad" },
    { type: "twitter_update", project: { id: "flap" }, signal: { labels: ["活动/费用变更"] }, tweet: { text: "New community campaign" } },
    { type: "twitter_update", project: { id: "flap" }, signal: { relevant: true, labels: ["新发射/新模式"] }, tweet: { text: "New launch: $DOG" } },
    { type: "twitter_update", project: { id: "fourmeme" }, signal: { relevant: true, labels: ["合约/部署"] }, tweet: { text: "Contract address: 0x1111111111111111111111111111111111111111" } },
    { type: "twitter_update", project: { id: "fourmeme" }, signal: { relevant: true, strong: true, platformStructural: true, labels: ["新发射/新模式"] }, tweet: { text: "Four.Meme introduces a new RWA stock launch mode" } },
    { type: "bsc_launchpad_update", kind: "new_mode", platform: { id: "fourmeme" }, structural: { eligible: true }, strong: true, mode: { template: { name: "Tokenized Stocks", description: "股票发行" } } },
  ];
  for (const event of rejected) assert.equal(isMonitoringSourceEnabled(focusConfig, event), false, JSON.stringify(event));
});

test("focus3 polls audited Uniswap core repositories but still requires an actionable high-signal event", () => {
  for (const repository of ["Uniswap/contracts", "Uniswap/UniswapX", "Uniswap/protocol-fees"]) {
    assert.equal(isMonitoringSourceEnabled(focusConfig, {
      repository,
      launchpad: "Uniswap",
      sourceTrust: "official_verified",
      uniswapOfficial: true,
      baselineOnly: true,
    }), true, repository);
  }

  assert.equal(isMonitoringSourceEnabled(focusConfig, {
    type: "github_module_update",
    launchpad: "UniswapX",
    repository: "Uniswap/UniswapX",
    sourceTrust: "official_verified",
    uniswapOfficial: true,
    strong: true,
    modeChange: { candidate: true },
    message: "feat: add UniswapX reactor version",
  }), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, {
    type: "github_module_update",
    launchpad: "Uniswap",
    repository: "Uniswap/contracts",
    sourceTrust: "official_verified",
    uniswapOfficial: true,
    strong: false,
    modeChange: { candidate: false },
    message: "chore: refresh dependencies",
  }), false);
});

test("focus3 admits only provenance-bound official Binance sources after an explicit opt-in", () => {
  const internalEvents = [
    ["binance_exchange_cms", "https://www.binance.com/en/support/announcement/example"],
    ["binance_announcement_websocket", "https://developers.binance.com/en/docs/products/announcements/announcement"],
    ["binance_wallet_cms", "https://web3.binance.com/en/example"],
    ["binance_square_cms", "https://www.binance.com/en/square/post/example"],
    ["binance_developer_docs", "https://developers.binance.com/en/docs/products/wallet/change-log.md"],
    ["meme_rush_api", "https://web3.binance.com/en"],
    ["launchpool_api", "https://www.binance.info/en/launchpool"],
  ].map(([id, url]) => ({
    type: "binance_official_update",
    source: { id, name: "untrusted display text is irrelevant", url },
    url,
  }));
  internalEvents.push({
    type: "binance_official_update",
    source: { id: "binance_exchange_cms", host: "www.binance.com" },
  });
  const xTargets = [
    {
      id: "binance",
      name: "Binance",
      handle: "binance",
      twitter: "https://x.com/binance",
      xUserId: "877807935493033984",
      match: "official_x",
      signalProfile: "binance",
    },
    {
      id: "binance-wallet",
      name: "Binance Wallet",
      handle: "BinanceWallet",
      twitter: "https://x.com/BinanceWallet",
      xUserId: "1400391752368992260",
      match: "official_x",
      signalProfile: "binance",
    },
    {
      id: "binance-futures",
      name: "Binance Futures",
      handle: "BinanceFutures",
      twitter: "https://x.com/BinanceFutures",
      xUserId: "1426142483822518274",
      match: "official_x",
      signalProfile: "binance",
    },
  ];
  const xEvent = {
    type: "twitter_update",
    project: xTargets[1],
    tweet: {
      handle: "BinanceWallet",
      url: "https://x.com/BinanceWallet/status/1234567890",
    },
  };
  const githubTargets = [
    { repository: "binance/binance-skills-hub", launchpad: "untrusted display", sourceTrust: "official_verified" },
    { type: "github_module_update", repository: "Binance/binance-web3-connector-js", launchpad: "untrusted display", sourceTrust: "official_verified" },
    {
      type: "github_module_update",
      repository: "binance/binance-connector-go",
      launchpad: "Binance",
      sourceTrust: "official_verified",
      strong: false,
      binanceChange: { scheme: "binance_connector_diff_v1", classification: "sdk_maintenance", substantive: false, productFeature: false },
    },
  ];

  for (const source of [...internalEvents, ...xTargets, xEvent, ...githubTargets]) {
    assert.equal(isMonitoringSourceEnabled(binanceFocusConfig, source), true, JSON.stringify(source));
    assert.equal(isMonitoringSourceEnabled(focusConfig, source), false, `not opted in: ${JSON.stringify(source)}`);
    assert.equal(isMonitoringSourceEnabled({ ...focusConfig, binanceMonitorEnabled: "true" }, source), false, `non-boolean opt-in: ${JSON.stringify(source)}`);
  }
});

test("focus3 Binance opt-in rejects display-name spoofing, hostile repositories, and non-official X identities", () => {
  const rejected = [
    {
      type: "github_monitor_gap",
      repository: "binance/binance-skills-hub",
      launchpad: "Binance Wallet",
      sourceTrust: "official_verified",
      priority: true,
      pollingClass: "core_priority",
    },
    {
      type: "binance_official_update",
      source: { id: "copied_binance_source", name: "Binance 官方公告", url: "https://www.binance.com/en/support/announcement/example" },
      url: "https://www.binance.com/en/support/announcement/example",
    },
    {
      type: "binance_official_update",
      source: { id: "binance_exchange_cms", name: "Binance 官方公告", url: "https://binance.com.evil.example/update" },
      url: "https://binance.com.evil.example/update",
    },
    {
      type: "binance_official_update",
      source: { id: "binance_exchange_cms", name: "Binance 官方公告", url: "https://www.binance.com/en/support/announcement/example" },
      url: "https://evil.example/copied-update",
    },
    { name: "Binance", id: "not-binance", handle: "attacker", twitter: "https://x.com/attacker" },
    {
      type: "twitter_update",
      project: {
        id: "binance",
        name: "Binance",
        handle: "binance_support",
        twitter: "https://x.com/binance_support",
        match: "official_x",
        signalProfile: "binance",
      },
    },
    {
      type: "twitter_update",
      project: {
        id: "binance-wallet",
        name: "Binance Wallet",
        handle: "BinanceWallet",
        twitter: "https://x.com/attacker",
        match: "official_x",
        signalProfile: "binance",
      },
    },
    {
      type: "twitter_update",
      project: {
        id: "binance",
        name: "Binance",
        handle: "binance",
        twitter: "https://x.com/binance",
        match: "website_discovery",
        signalProfile: "binance",
      },
    },
    {
      type: "twitter_update",
      project: {
        id: "binance-wallet",
        name: "Binance Wallet",
        handle: "BinanceWallet",
        twitter: "https://x.com/BinanceWallet",
        match: "official_x",
        signalProfile: "binance",
      },
      tweet: { handle: "attacker", url: "https://x.com/attacker/status/1234567890" },
    },
    { repository: "attacker/binance-skills-hub", launchpad: "Binance Wallet", sourceTrust: "official_verified" },
    { repository: "binance/binance-skills-hub", launchpad: "Binance Wallet", sourceTrust: "unverified_candidate" },
    { type: "twitter_update", repository: "binance/binance-skills-hub", sourceTrust: "official_verified", project: { handle: "attacker" } },
    {
      type: "github_module_update",
      repository: "binance/binance-connector-java",
      launchpad: "Binance",
      sourceTrust: "official_verified",
      strong: true,
      message: "Release stocks v1.0.0",
      files: [{ filename: "clients/stocks/src/main/java/StocksRestApi.java", status: "added" }],
      binanceChange: { scheme: "binance_connector_diff_v1", classification: "api_or_schema_change", substantive: true, productFeature: false },
    },
  ];

  for (const source of rejected) {
    assert.equal(isMonitoringSourceEnabled(binanceFocusConfig, source), false, JSON.stringify(source));
  }
});

test("focus3 admits a fresh Binance organization repository discovery only with complete official proof", () => {
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const valid = {
    type: "github_repository_discovered",
    repository: "binance/agent-native-sdk",
    sourceTrust: "official_verified",
    officialOrganization: "binance",
    officialEvidence: { source: "official_binance_github", url: "https://github.com/binance" },
    repositoryMetadata: { createdAt: fresh },
    createdAt: fresh,
    url: "https://github.com/binance/agent-native-sdk",
  };
  assert.equal(isMonitoringSourceEnabled(binanceFocusConfig, valid), true);
  const rejected = [
    { ...valid, officialOrganization: undefined },
    { ...valid, officialEvidence: undefined },
    { ...valid, officialEvidence: { ...valid.officialEvidence, url: "https://github.com/binance/agent-native-sdk" } },
    { ...valid, repository: "attacker/agent-native-sdk", url: "https://github.com/attacker/agent-native-sdk" },
    { ...valid, url: "https://github.com/binance/other" },
    { ...valid, repositoryMetadata: { createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() } },
  ];
  for (const source of rejected) assert.equal(isMonitoringSourceEnabled(binanceFocusConfig, source), false, JSON.stringify(source));
});

test("focus3 admits exact official X/xAI transports, bare X targets, and the 13 audited GitHub repositories", () => {
  const project = (id) => id === "x"
    ? { id: "x", name: "X", website: "https://x.com", twitter: "https://x.com/X" }
    : { id: "xai", name: "xAI / Grok", website: "https://x.ai", twitter: "https://x.com/SpaceXAI", socials: ["https://x.com/SpaceXAI", "https://x.com/grok"] };
  const internal = (id, transport, url) => ({
    type: "ai_official_update",
    kind: id,
    project: project(id === "x_api_changelog" ? "x" : "xai"),
    source: { id, name: "display text is not trusted", url: transport, official: true, trust: "official_verified" },
    url,
  });
  const internalEvents = [
    internal("x_api_changelog", "https://docs.x.com/changelog/rss.xml", "https://docs.x.com/changelog#jul-21-2026"),
    internal("x_api_changelog", "https://docs.x.com/changelog/rss.xml", "https://docs.x.com/changelog"),
    internal("xai_release_notes", "https://docs.x.ai/developers/release-notes.md", "https://docs.x.ai/developers/release-notes.md#grok-bot"),
    internal("xai_release_notes", "https://docs.x.ai/developers/release-notes.md", "https://docs.x.ai/developers/model-capabilities/audio/speech-to-text#smart-turn"),
    internal("xai_release_notes", "https://docs.x.ai/developers/release-notes.md", "https://docs.x.ai/grok-bot/get-started"),
    internal("xai_release_notes", "https://docs.x.ai/developers/release-notes.md", "https://x.ai/news/grok-4-5"),
    internal("xai_news", "https://r.jina.ai/http://x.ai/news", "https://x.ai/news/grok-4-5"),
    internal("xai_news", "https://r.jina.ai/https://x.ai/news", "https://x.ai/news/grok-voice-think-fast-2"),
  ];
  const repositoryProducts = new Map([
    ["xai-org/grok-build", [{ id: "grok", name: "xAI / Grok" }, "xAI / Grok"]],
    ["xai-org/grok-build-plugin-cc", [{ id: "grok", name: "xAI / Grok" }, "xAI / Grok"]],
    ["xai-org/plugin-marketplace", [{ id: "grok", name: "xAI / Grok" }, "xAI / Grok"]],
    ["xai-org/xai-sdk-python", [{ id: "grok", name: "xAI / Grok" }, "xAI / Grok"]],
    ["xai-org/xai-proto", [{ id: "grok", name: "xAI / Grok" }, "xAI / Grok"]],
    ["xai-org/x-algorithm", [{ id: "x", name: "X" }, "X"]],
    ["xai-org/grok-prompts", [{ id: "grok", name: "xAI / Grok" }, "xAI / Grok"]],
    ["xdevplatform/chat-xdk", [{ id: "x-api", name: "X API / Developer Platform" }, "X"]],
    ["xdevplatform/xurl", [{ id: "x-api", name: "X API / Developer Platform" }, "X"]],
    ["xdevplatform/xmcp", [{ id: "x-api", name: "X API / Developer Platform" }, "X"]],
    ["xdevplatform/xdk", [{ id: "x-api", name: "X API / Developer Platform" }, "X"]],
    ["xdevplatform/xdk-python", [{ id: "x-api", name: "X API / Developer Platform" }, "X"]],
    ["xdevplatform/xdk-typescript", [{ id: "x-api", name: "X API / Developer Platform" }, "X"]],
  ]);
  const bareRepositories = [...repositoryProducts].map(([repository, [product, launchpad]]) => ({
    repository,
    product,
    launchpad,
    sourceTrust: "official_verified",
    baselineOnly: true,
    xaiOfficial: true,
    officialEvidence: { source: "official_x_github_allowlist", url: `https://github.com/${repository}` },
  }));
  const commit = "a".repeat(40);
  const repositoryEvents = bareRepositories.map(({ officialEvidence, ...repository }) => ({
    ...repository,
    type: "github_module_update",
    strong: true,
    productChange: { candidate: true, category: "api" },
    commit,
    verification: { status: "official_verified", evidence: officialEvidence },
    url: `https://github.com/${repository.repository}/commit/${commit}`,
  }));
  const twitterEvents = aiXTargets.map(aiTwitterEvent);

  for (const source of [...internalEvents, ...aiXTargets, ...twitterEvents, ...bareRepositories, ...repositoryEvents]) {
    assert.equal(isMonitoringSourceEnabled(aiFocusConfig, source), true, JSON.stringify(source));
    assert.equal(isThreePlatformSource(source), false, `AI lane leaked into general focus3: ${JSON.stringify(source)}`);
    assert.equal(isMonitoringSourceEnabled({ ...aiFocusConfig, xaiOfficialMonitorEnabled: false }, source), false, `disabled AI lane: ${JSON.stringify(source)}`);
  }
});

test("focus3 AI lane rejects forged or mixed transports, item URLs, identities, and audited repository claims", () => {
  const validInternal = {
    type: "ai_official_update",
    kind: "x_api_changelog",
    project: { id: "x", name: "X", website: "https://x.com", twitter: "https://x.com/X" },
    source: { id: "x_api_changelog", url: "https://docs.x.com/changelog/rss.xml", official: true, trust: "official_verified" },
    url: "https://docs.x.com/changelog#jul-21-2026",
  };
  const validX = aiTwitterEvent(aiXTargets[0]);
  const commit = "a".repeat(40);
  const validRepository = {
    type: "github_module_update",
    repository: "xdevplatform/xdk",
    product: { id: "x-api", name: "X API / Developer Platform" },
    launchpad: "X",
    sourceTrust: "official_verified",
    xaiOfficial: true,
    strong: true,
    productChange: { candidate: true },
    commit,
    verification: { status: "official_verified", evidence: { source: "official_x_github_allowlist", url: "https://github.com/xdevplatform/xdk" } },
    url: `https://github.com/xdevplatform/xdk/commit/${commit}`,
  };
  const rejected = [
    { ...validInternal, kind: "xai_news" },
    { ...validInternal, source: { ...validInternal.source, id: "copied_x_api_changelog" } },
    { ...validInternal, source: { ...validInternal.source, official: false } },
    { ...validInternal, source: { ...validInternal.source, trust: "display_name_verified" } },
    { ...validInternal, source: { ...validInternal.source, url: "https://docs.x.com/changelog" } },
    { ...validInternal, source: { ...validInternal.source, url: "https://docs.x.com.evil.example/changelog/rss.xml" } },
    { ...validInternal, source: { ...validInternal.source, url: "https://docs.x.com:443/changelog/rss.xml" } },
    { ...validInternal, source: { ...validInternal.source, url: "https://docs.x.com/changelog/rss.xml?copy=1" } },
    { ...validInternal, source: { ...validInternal.source, url: "https://user@docs.x.com/changelog/rss.xml" } },
    { ...validInternal, url: "https://docs.x.com/changelog?date=jul-21-2026" },
    { ...validInternal, url: "https://docs.x.com/changelog#latest" },
    { ...validInternal, url: "https://docs.x.com/developers/changelog#jul-21-2026" },
    { ...validInternal, url: "https://x.ai/news/grok-4-5" },
    { ...validInternal, platform: { id: "flap" } },
    {
      type: "ai_official_update",
      kind: "xai_release_notes",
      project: { id: "xai", website: "https://x.ai", twitter: "https://x.com/SpaceXAI" },
      source: { id: "xai_release_notes", url: "https://docs.x.ai/developers/release-notes.md", official: true, trust: "official_verified" },
      url: "https://docs.x.ai/build/overview",
    },
    {
      type: "ai_official_update",
      kind: "xai_news",
      project: { id: "xai", website: "https://x.ai", twitter: "https://x.com/SpaceXAI" },
      source: { id: "xai_news", url: "https://r.jina.ai/http://x.ai/news", official: true, trust: "official_verified" },
      url: "https://x.ai/news",
    },
    {
      type: "ai_official_update",
      kind: "xai_news",
      project: { id: "xai", website: "https://x.ai", twitter: "https://x.com/SpaceXAI" },
      source: { id: "xai_news", url: "https://r.jina.ai/http://x.ai.evil.example/news", official: true, trust: "official_verified" },
      url: "https://x.ai/news/fake",
    },
    { ...validX, project: { ...validX.project, id: "x-official" }, platform: { id: "flap" } },
    { ...validX, project: { ...validX.project, handle: "XSupport", twitter: "https://x.com/XSupport" }, platform: { id: "flap" } },
    { ...validX, project: { ...validX.project, xUserId: "783215" }, platform: { id: "flap" } },
    { ...validX, project: { ...validX.project, match: "display_name" }, platform: { id: "flap" } },
    { ...validX, project: { ...validX.project, signalProfile: "uniswap" }, platform: { id: "flap" } },
    { ...validX, platform: { id: "flap" } },
    { ...validX, tweet: { handle: "attacker", url: "https://x.com/attacker/status/1234567890" }, platform: { id: "flap" } },
    { ...validX, tweet: { handle: "X", url: "https://x.com.evil.example/X/status/1234567890" }, platform: { id: "flap" } },
    { ...validX, tweet: { handle: "X", url: "https://x.com/X/status/1234567890" } },
    { ...aiXTargets[0], twitter: "https://x.com/X?copied=1" },
    { ...aiXTargets[0], twitter: "https://x.com:443/X" },
    { ...aiXTargets[0], website: "https://evil.example/copied-x" },
    { ...validRepository, product: { id: "grok", name: "xAI / Grok" } },
    { ...validRepository, sourceTrust: "unverified_candidate" },
    { ...validRepository, xaiOfficial: false },
    { ...validRepository, productChange: { candidate: false } },
    { ...validRepository, verification: { status: "official_verified", evidence: { source: "official_x_github_allowlist", url: "https://github.com/xdevplatform" } } },
    { ...validRepository, url: `https://github.com/xai-org/xdk/commit/${commit}` },
    { ...validRepository, url: `https://github.com:443/xdevplatform/xdk/commit/${commit}` },
    { ...validRepository, commit: "not-a-full-sha" },
    { ...validRepository, platform: { id: "flap" } },
    { ...validRepository, repository: "attacker/xdk", launchpad: "Flap", product: { id: "x-api", name: "X API / Developer Platform" } },
    { type: "platform_capability_update", project: { id: "attacker", name: "xAI Official" }, platform: { id: "flap" }, changes: { newModules: ["copied module"] } },
  ];

  for (const source of rejected) {
    assert.equal(isMonitoringSourceEnabled(aiFocusConfig, source), false, JSON.stringify(source));
  }
});

test("focus3 AI lane admits future official-organization repositories only through a strict dynamic proof", () => {
  const dynamicBare = (repository) => {
    const owner = repository.split("/")[0];
    return {
      repository,
      product: owner === "xdevplatform"
        ? { id: "x-api", name: "X API / Developer Platform" }
        : { id: "grok", name: "xAI / Grok" },
      launchpad: owner === "xdevplatform" ? "X" : "xAI / Grok",
      officialOrganization: owner,
      sourceTrust: "official_verified",
      xaiOfficial: true,
      officialEvidence: { source: "official_x_github_organization", url: `https://github.com/${owner}` },
    };
  };
  const commit = "b".repeat(40);
  const bare = [
    dynamicBare("xai-org/grok-vision-agent"),
    dynamicBare("xdevplatform/next-api-sdk"),
    dynamicBare("xai-org/website"),
  ];
  const moduleEvent = {
    ...dynamicBare("xai-org/grok-vision-agent"),
    type: "github_module_update",
    strong: true,
    productChange: { candidate: true, category: "model" },
    commit,
    verification: { status: "official_verified", evidence: { source: "official_x_github_organization", url: "https://github.com/xai-org" } },
    url: `https://github.com/xai-org/grok-vision-agent/commit/${commit}`,
  };
  delete moduleEvent.officialEvidence;
  const discovered = {
    ...dynamicBare("xdevplatform/next-api-sdk"),
    type: "github_repository_discovered",
    strong: true,
    repositoryMetadata: { description: "Next X API SDK", topics: ["xdk", "api"] },
    url: "https://github.com/xdevplatform/next-api-sdk",
  };
  for (const source of [...bare, moduleEvent, discovered]) {
    assert.equal(isMonitoringSourceEnabled(aiFocusConfig, source), true, JSON.stringify(source));
    assert.equal(isThreePlatformSource(source), false, JSON.stringify(source));
  }

  const rejected = [
    dynamicBare("attacker/grok-agent"),
    { ...dynamicBare("xai-org/grok-agent"), officialOrganization: "xdevplatform" },
    { ...dynamicBare("xai-org/grok-agent"), sourceTrust: "unverified_candidate" },
    { ...dynamicBare("xai-org/grok-agent"), xaiOfficial: false },
    { ...dynamicBare("xai-org/grok-agent"), officialEvidence: { source: "official_x_github_allowlist", url: "https://github.com/xai-org" } },
    { ...dynamicBare("xai-org/grok-agent"), officialEvidence: { source: "official_x_github_organization", url: "https://github.com/xai-org/grok-agent" } },
    { ...dynamicBare("xai-org/website"), type: "github_repository_discovered", strong: true, repositoryMetadata: { description: "Corporate website", topics: ["website"] }, url: "https://github.com/xai-org/website" },
    { ...discovered, strong: false },
    { ...discovered, url: "https://github.com/xdevplatform/copied-api-sdk" },
    { ...moduleEvent, verification: { status: "official_verified", evidence: { source: "official_x_github_organization", url: "https://github.com/xdevplatform" } } },
    { ...moduleEvent, url: `https://github.com/xai-org/copied-agent/commit/${commit}` },
    { ...moduleEvent, officialOrganization: "xai-org.evil.example" },
    { ...moduleEvent, launchpad: "Flap" },
  ];
  for (const source of rejected) {
    assert.equal(isMonitoringSourceEnabled(aiFocusConfig, source), false, JSON.stringify(source));
  }
});

test("focus3 allows only strictly verified BSC Fomo calls when the Fomo monitor is enabled", () => {
  const enabled = { ...focusConfig, fomoCallEnabled: true };
  const now = new Date().toISOString();
  const wallet = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const transactionHash = `0x${"7".repeat(64)}`;
  const blockNumber = 12_345_678;
  const strictCall = {
    type: "fomo_family_top_call",
    signalKind: "top_blogger_first_buy",
    activity: "buy",
    chain: { id: 56, slug: "bsc" },
    qualified: true,
    strong: true,
    source: { id: "fomoscan_onchain", trust: "public_onchain_verified" },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    market: { liquidityUsd: 10_000 },
    token,
    transactionHash,
    blockNumber,
    positionProof: { status: "verified", complete: true, phase: "previous_block", previousBalanceRaw: "0", wallet, token, transactionHash, blockNumber },
    walletAddress: wallet,
    walletBinding: { status: "verified", verified: true, proofSource: "fomoscan", wallet, handle: "caller", twitterHandle: "caller", xProfileId: "123456789", checkedAt: now },
    caller: { handle: "caller", followers: 10_000, followersSyncedAt: now, xProfileId: "123456789", identitySource: "fomoscan+fxtwitter", twitter: "https://x.com/caller" },
  };

  assert.equal(isMonitoringSourceEnabled(enabled, strictCall), true);
  assert.equal(isMonitoringSourceEnabled(enabled, {
    ...strictCall,
    source: { id: "fomoscan_onchain", trust: "authorized_public_api" },
    positionProof: { ...strictCall.positionProof, phase: "immediately_before_transaction", totalWalletPreRaw: "0" },
    walletBinding: strictCall.walletBinding,
  }), true);

  const rejected = [
    [{ ...focusConfig, fomoCallEnabled: false }, strictCall],
    [focusConfig, strictCall],
    [enabled, { ...strictCall, chain: { id: 8453, slug: "bsc" } }],
    [enabled, { ...strictCall, chain: { id: 56, slug: "base" } }],
    [enabled, { ...strictCall, qualified: false }],
    [enabled, { ...strictCall, strong: false }],
    [enabled, { ...strictCall, source: { id: "fomoscan_onchain", trust: "unverified_candidate" } }],
    [enabled, { ...strictCall, security: { decision: "block" } }],
    [enabled, { ...strictCall, positionProof: { status: "unverified", phase: "previous_block", previousBalanceRaw: "0" } }],
    [enabled, { ...strictCall, positionProof: { status: "verified", phase: "previous_block", previousBalanceRaw: "1" } }],
    [enabled, { ...strictCall, positionProof: { status: "verified", phase: "current", previousBalanceRaw: "0" } }],
    [enabled, { ...strictCall, walletBinding: { status: "unverified", proofSource: "fomoscan" } }],
    [enabled, { ...strictCall, walletBinding: { status: "verified", proofSource: "other" } }],
    [enabled, { ...strictCall, walletBinding: { status: "verified", verified: false, proofSource: "fomoscan" } }],
    [enabled, { ...strictCall, walletBinding: { ...strictCall.walletBinding, wallet: "0x2222222222222222222222222222222222222222" } }],
    [enabled, { ...strictCall, walletBinding: { ...strictCall.walletBinding, handle: "someone_else" } }],
    [enabled, { ...strictCall, caller: { ...strictCall.caller, identitySource: "fomoscan" } }],
    [enabled, { ...strictCall, caller: { ...strictCall.caller, twitter: null } }],
    [enabled, { ...strictCall, caller: { followers: 9_999 } }],
  ];
  for (const [config, event] of rejected) {
    assert.equal(isMonitoringSourceEnabled(config, event), false, JSON.stringify(event));
  }
});

test("focus3 admits fresh GMGN-attributed BSC Fomo KOL wallets only with a complete aligned first-buy proof", () => {
  const enabled = {
    ...focusConfig,
    fomoCallEnabled: true,
    fomoCallAllowGmgnObservedWallets: true,
    fomoCallGmgnAttributionMaxAgeMs: 86_400_000,
  };
  const wallet = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const transactionHash = `0x${"3".repeat(64)}`;
  const blockNumber = 12_345_678;
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const strictCall = {
    type: "fomo_family_top_call",
    signalKind: "top_blogger_first_buy",
    activity: "buy",
    chain: { id: 56, slug: "bsc" },
    qualified: true,
    strong: true,
    source: { id: "gmgn_kol_onchain", trust: "public_onchain_attributed" },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    market: { liquidityUsd: 10_000 },
    walletAddress: wallet,
    token,
    transactionHash,
    blockNumber,
    caller: {
      handle: "caller",
      followers: 10_000,
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
  };

  assert.equal(isMonitoringSourceEnabled(enabled, strictCall), true);

  const rejected = [];
  const reject = (label, mutate) => {
    const event = structuredClone(strictCall);
    mutate(event);
    rejected.push([label, event]);
  };

  reject("attributed wallet differs from the event wallet", (event) => {
    event.walletAttribution.monitoringWallet = "0x4444444444444444444444444444444444444444";
  });
  reject("proof wallet differs from the event and attributed wallet", (event) => {
    event.positionProof.wallet = "0x4444444444444444444444444444444444444444";
  });
  reject("X handle differs from the caller", (event) => {
    event.walletAttribution.xHandle = "someone_else";
  });
  reject("X URL handle differs from the caller", (event) => {
    event.caller.twitter = "https://x.com/someone_else";
  });
  reject("GMGN observation lacks the fomo tag", (event) => {
    event.walletAttribution.tags = ["kol"];
  });
  reject("GMGN attribution is older than 24 hours", (event) => {
    event.walletAttribution.observedAt = new Date(Date.now() - 86_400_001).toISOString();
  });
  reject("source id is not the GMGN BSC KOL lane", (event) => {
    event.source.id = "fomoscan_onchain";
  });
  reject("source trust overstates an observed attribution", (event) => {
    event.source.trust = "public_onchain_verified";
  });
  reject("previous-block proof is incomplete", (event) => {
    event.positionProof.complete = false;
  });
  reject("proof token differs from the event token", (event) => {
    event.positionProof.token = "0x5555555555555555555555555555555555555555";
  });
  reject("proof transaction differs from the event transaction", (event) => {
    event.positionProof.transactionHash = `0x${"6".repeat(64)}`;
  });
  reject("proof block differs from the event block", (event) => {
    event.positionProof.blockNumber += 1;
  });
  reject("X account is below 10k followers", (event) => {
    event.caller.followers = 9_999;
  });

  assert.equal(isMonitoringSourceEnabled({ ...enabled, fomoCallAllowGmgnObservedWallets: false }, strictCall), false);
  assert.equal(isMonitoringSourceEnabled({ ...enabled, fomoCallAllowGmgnObservedWallets: undefined }, strictCall), false);
  for (const [label, event] of rejected) {
    assert.equal(isMonitoringSourceEnabled(enabled, event), false, label);
  }
});

test("focus3 repository identity is owner-bound and cannot be inherited by a display name", () => {
  assert.equal(isThreePlatformSource({ repository: "flap-sh/new-launch-module", sourceTrust: "official_verified" }), true);
  assert.equal(isThreePlatformSource({ repository: "four-meme-community/openfour-docs", sourceTrust: "official_verified" }), true);
  assert.equal(isThreePlatformSource({ repository: "Uniswap/new-hook-launcher", sourceTrust: "official_verified" }), true);
  for (const repository of ["Uniswap/deployments", "Uniswap/networks", "Uniswap/chain-registry", "Uniswap/network-tools", "Uniswap/deploy-v4"]) {
    assert.equal(isThreePlatformSource({ repository, sourceTrust: "official_verified", uniswapOfficial: true }), true, repository);
  }
  assert.equal(isThreePlatformSource({ repository: "attacker/flap-launcher", launchpad: "Flap", sourceTrust: "official_verified" }), false);
  assert.equal(isThreePlatformSource({ repository: "Uniswap/UniswapX", uniswapOfficial: true, sourceTrust: "official_verified" }), true);
  assert.equal(isThreePlatformSource({
    repository: "Uniswap/UniswapX",
    uniswapOfficial: true,
    sourceTrust: "official_verified",
    chainSupportChange: { candidate: true, chains: [{ name: "Base", chainId: 8453 }] },
  }), true);
  assert.equal(isThreePlatformSource({
    repository: "attacker/deployments",
    uniswapOfficial: true,
    sourceTrust: "official_verified",
    chainSupportChange: { candidate: true, chains: [{ name: "Base", chainId: 8453 }] },
  }), false);
  assert.equal(isThreePlatformSource({ name: "Uniswap giveaway mirror" }), false);
});

test("a rejected focus3 event creates no outbox", async (t) => {
  const dataDir = await temporaryDirectory(t, "focus3-no-outbox-");
  const result = await sendAlerts({ ...focusConfig, dataDir }, {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    platform: { id: "unknown" },
    structural: { eligible: true },
    strong: true,
    observedAt: new Date().toISOString(),
  });
  assert.equal(result.status, "suppressed");
  assert.equal(result.reason, "monitoring_source_disabled");
  assert.equal(result.disposition, "terminal");
  assert.equal(result.terminal, true);
  assert.equal(isTerminalAlertSuppression(result), true);
  await assert.rejects(fs.access(path.join(dataDir, "alert-outbox.json")), { code: "ENOENT" });
});

test("focus3 outbox drain suppresses a previously queued non-focus event", async (t) => {
  const dataDir = await temporaryDirectory(t, "focus3-outbox-drain-");
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dataDir, "alert-outbox.json"), `${JSON.stringify({
    version: 2,
    events: {
      junk: {
        id: "junk",
        eventType: "binance_official_update",
        event: { type: "binance_official_update", platform: { id: "binance" }, strong: true, observedAt: now },
        status: "pending",
        destinations: { telegram: { status: "pending", attempts: 0, nextAttemptAt: null } },
        createdAt: now,
        updatedAt: now,
      },
    },
  }, null, 2)}\n`);
  const count = await drainAlertOutbox({ ...focusConfig, dataDir, alertTelegramDeliveryMaxAgeMs: 7_200_000 });
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(count, 0);
  assert.equal(saved.events.junk.status, "suppressed");
  assert.equal(saved.events.junk.destinations.telegram.status, "disabled");
});

test("focus3 X polling ignores dynamic and website-discovered handles", async (t) => {
  const dataDir = await temporaryDirectory(t, "focus3-twitter-");
  await fs.writeFile(path.join(dataDir, "site-watchlist.json"), `${JSON.stringify([
    { id: "auto-flap", name: "Flap", website: "https://flap.sh", twitter: "https://x.com/evilhandle" },
  ])}\n`);
  await fs.writeFile(path.join(dataDir, "site-state.json"), `${JSON.stringify({
    flap: { signals: { socials: ["https://x.com/anotherfake"] } },
  })}\n`);
  const requested = [];
  const monitor = createTwitterMonitor({
    ...focusConfig,
    dataDir,
    twitterDirectXEnabled: false,
    twitterApiBase: "https://timeline.example",
    twitterFallbackApiBases: [],
    twitterStandardPollConcurrency: 10,
  }, {
    autoStart: false,
    logger: { error() {} },
    fetchImpl: async (url) => {
      requested.push(String(url));
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "<html></html>" };
    },
    sendAlertsImpl: async () => {},
  });
  await monitor.check();
  monitor.stop();
  const joined = requested.join(" ").toLowerCase();
  assert.match(joined, /flapdotsh/);
  assert.match(joined, /fourdotmemezh/);
  assert.match(joined, /uniswap/);
  assert.match(joined, /tradepools/);
  assert.doesNotMatch(joined, /evilhandle|anotherfake|binance|ponsdotfamily/);
});

test("public Telegram news is an opt-in fail-closed lane with exact provenance and safe links", () => {
  const now = Date.parse("2026-08-24T04:00:00.000Z");
  const contentDigest = "a".repeat(64);
  const event = {
    type: "telegram_news_update",
    eventKey: `telegram-news:-1002540748528:31415:${contentDigest.slice(0, 16)}`,
    chatId: "-1002540748528",
    username: "maxguruai",
    messageId: "31415",
    messageUrl: "https://t.me/maxguruai/31415",
    sourceOccurredAt: "2026-08-24T03:55:00.000Z",
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
      headline: "A monitored public-channel update",
      summary: "The source message links to a public HTTPS article.",
      externalUrls: ["https://example.com/news?id=31415"],
      storyKey: "maxguruai:31415",
      confidence: "observed",
    },
  };
  const invalid = (mutation) => {
    const candidate = structuredClone(event);
    mutation(candidate);
    assert.equal(isTelegramNewsUpdateAllowed(candidate, now), false);
  };

  assert.equal(isTelegramNewsUpdateAllowed(event, now), true);
  assert.equal(isThreePlatformSource(event), false, "a public group is not a first-party focus3 source");
  invalid((candidate) => { candidate.eventKey = "telegram-news:collision"; });
  invalid((candidate) => { candidate.chatId = "-1000000000000"; });
  invalid((candidate) => { candidate.channel.visibility = "private"; });
  invalid((candidate) => { candidate.username = "MaxGuruAI"; });
  invalid((candidate) => { candidate.messageId = "031415"; });
  invalid((candidate) => { candidate.messageUrl += "?single"; });
  invalid((candidate) => { candidate.source.id = "telegram_forward"; });
  invalid((candidate) => { candidate.source.trust = "official_verified"; });
  invalid((candidate) => { candidate.sourceTrust = "official_verified"; });
  invalid((candidate) => { candidate.source.url = "https://t.me/maxguruai"; });
  invalid((candidate) => { candidate.strong = true; });
  invalid((candidate) => { candidate.news.confidence = "verified"; });
  invalid((candidate) => { candidate.news.externalUrls = ["http://example.com/news"]; });
  invalid((candidate) => { candidate.news.externalUrls = ["https://127.0.0.1/private"]; });
  invalid((candidate) => { candidate.news.externalUrls = ["https://user:pass@example.com/news"]; });
  invalid((candidate) => { candidate.sourceOccurredAt = "2026-08-24T01:59:59.999Z"; });
  invalid((candidate) => { candidate.sourceOccurredAt = "2026-08-24T04:01:00.001Z"; });

  const live = structuredClone(event);
  live.sourceOccurredAt = new Date().toISOString();
  assert.equal(isMonitoringSourceEnabled({ ...focusConfig, telegramNewsMonitorEnabled: false }, live), false);
  assert.equal(isMonitoringSourceEnabled({ ...focusConfig, telegramNewsMonitorEnabled: true }, live), true);
});
