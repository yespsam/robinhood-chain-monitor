import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drainAlertOutbox, isTerminalAlertSuppression, sendAlerts } from "../src/alerts.js";
import {
  isOfficialFlapQuotePairUpdate,
  isOfficialPonFunUpdate,
  isMonitoringSourceEnabled,
  isPonFunSource,
  isStrictFlapQuoteAsset,
  isStrictFlapQuoteAssetUpdate,
  isStrictFlapPortalQuoteAssetUpdate,
  isTelegramNewsUpdateAllowed,
  isThreePlatformSource,
} from "../src/source-controls.js";
import { classifyFocusLaunchpadText, createTwitterMonitor } from "../src/twitter-monitor.js";

const focusConfig = { monitorScope: "focus3", ponsMonitorEnabled: false };
const binanceFocusConfig = { ...focusConfig, binanceMonitorEnabled: true };
const aiFocusConfig = { ...focusConfig, xaiOfficialMonitorEnabled: true };
const ponFocusConfig = { ...focusConfig, ponMonitorEnabled: true };

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

const FLAP_BSTOCK_PAIRS_TWEET_ID = "2095124685788979225";
const FLAP_BSTOCK_PAIRS_TEXT = `Leveraged bStocks are coming to Flap. 🦋

Flap is expanding the programmable asset layer with two new bStock trading pairs:

SOXLB — Bull Semiconductors 3X ETF
SOXSB — Bear Semiconductors 3X ETF

Creators can now launch tokens paired directly against leveraged semiconductor exposure — and build their own token economies on top.

On Flap, the trading pair is only the foundation.

You can program mechanisms including:

1.Creator wallet — direct tax fees to creators, or a self-build distribution contract
2.Holder Dividends — continuously distribute dividends to token holders
3.Burn — use accumulated tax fees to burn tokens and reduce supply
4.Liquidity — automatically route trading taxes back into liquidity pool
5.Custom Tax Strategies — combine multiple mechanisms into one token economy

With these, you can build entirely different markets around the same underlying asset.

Different assets. Different mechanisms.

Build on http://Flap.sh 🦋`;

const exactFlapQuotePairEvent = (text = FLAP_BSTOCK_PAIRS_TEXT) => ({
  type: "twitter_update",
  project: {
    id: "flap",
    handle: "flapdotsh",
    xUserId: "1749114887807320064",
    match: "official_x",
  },
  tweet: {
    id: FLAP_BSTOCK_PAIRS_TWEET_ID,
    text,
    handle: "flapdotsh",
    xUserId: "1749114887807320064",
    authorId: "1749114887807320064",
    url: `https://x.com/flapdotsh/status/${FLAP_BSTOCK_PAIRS_TWEET_ID}`,
    sourceVerifiedBy: "official_x_oembed",
    isReply: false,
  },
  signal: classifyFocusLaunchpadText(text),
});

const FLAP_BOARD_URL = "https://flap.sh/board";
const FLAP_QUOTE_ADDRESS = "0xe28c09e21db5bb63c4821c3f44c26ee5aee8280f";
const strictFlapQuoteAsset = (overrides = {}) => ({
  identity: `chain-56:quote:${FLAP_QUOTE_ADDRESS}`,
  kind: "quote_asset",
  category: null,
  vaultFactory: null,
  quoteAddress: FLAP_QUOTE_ADDRESS,
  quoteSymbol: "SOXSB",
  quoteName: "Bear Semiconductors 3X ETF Tokenized Stock (bStock)",
  sourceUrl: FLAP_BOARD_URL,
  chainId: 56,
  ...overrides,
});

const strictFlapQuoteAssetEvent = (pool = strictFlapQuoteAsset(), changeOverrides = {}) => ({
  type: "platform_capability_update",
  platform: { id: "flap", name: "Flap" },
  source: FLAP_BOARD_URL,
  sources: [FLAP_BOARD_URL],
  url: FLAP_BOARD_URL,
  changes: { newFlapPools: [pool], ...changeOverrides },
});

const strictFlapPortalQuoteAssetEvent = () => {
  const portal = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
  const transactionHash = `0x${"ab".repeat(32)}`;
  const blockNumber = 119_700_000;
  const blockHash = `0x${"cd".repeat(32)}`;
  const finalizedHead = blockNumber + 2;
  const finalizedHeadHash = `0x${"ef".repeat(32)}`;
  const logIndex = 7;
  const blockTimestamp = "2026-09-03T00:00:00.000Z";
  const configuration = {
    enabled: true,
    enabledRaw: 1,
    defaultCurve: 2,
    alternativeCurve: 3,
    nativeToQuoteSwapType: 1,
    dexId: 4,
  };
  const asset = {
    identity: `chain-56:quote:${FLAP_QUOTE_ADDRESS}`,
    kind: "quote_asset",
    category: null,
    vaultFactory: null,
    quoteAddress: FLAP_QUOTE_ADDRESS,
    quoteName: "Bear Semiconductors 3X ETF Tokenized Stock (bStock)",
    quoteSymbol: "SOXSB",
    quoteDecimals: 18,
    decimals: 18,
    enabled: true,
    configuration,
    chainId: 56,
    portal,
    codeHash: `0x${"12".repeat(32)}`,
    codeBytes: 512,
    verifiedAtBlock: finalizedHead,
    verifiedAtBlockHash: finalizedHeadHash,
    sourceUrl: FLAP_BOARD_URL,
  };
  const abiWord = (value) => value.toString(16).padStart(64, "0");
  const logData = `0x${asset.quoteAddress.slice(2).padStart(64, "0")}${[
    configuration.enabledRaw,
    configuration.defaultCurve,
    configuration.alternativeCurve,
    configuration.nativeToQuoteSwapType,
    configuration.dexId,
  ].map(abiWord).join("")}`;
  const evidence = {
    chainId: 56,
    portal,
    portalRuntimeCodeHash: "0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3",
    portalVersion: "v5.22.0",
    portalImplementation: "0xE3CfDbb959e4EFb6fFD22E8659e8CBeEeD362019",
    portalImplementationCodeHash: "0x357c9245739d6af7c4727744d479ec7d8c4ae461c2fb37d56eafb9d7dc9ccbaa",
    eventSignature: "QuoteTokenConfigurationSet(address,(uint8,uint8,uint8,uint8,uint8))",
    topic0: "0x9a1f38e55c729ebf0c45d240a00b09f0a79a715df7cfd6e8942bd3f8da839199",
    logIndex,
    logData,
    eventConfiguration: { ...configuration },
    finalizedConfiguration: { ...configuration },
    configurationVerifiedAtBlock: finalizedHead,
    metadataVerifiedAtBlock: finalizedHead,
    metadataCodeHash: asset.codeHash,
    receiptVerified: true,
    transactionVerified: true,
    canonicalBlockVerified: true,
    confirmations: 5,
    requiredConfirmations: 3,
    finalizedHead,
    finalizedHeadHash,
  };
  const explorerUrl = `https://bscscan.com/tx/${transactionHash}`;
  return {
    type: "platform_capability_update",
    kind: "flap_quote_asset_enabled",
    changeType: "added",
    eventKey: `flap-quote:56:${transactionHash}:${logIndex}`,
    platform: { id: "flap", name: "Flap", website: "https://flap.sh", board: FLAP_BOARD_URL },
    chain: { id: 56, chainId: 56, name: "BNB Chain", environment: "mainnet" },
    chainId: 56,
    portal,
    source: {
      id: "flap_portal_quote_configuration",
      name: "Flap official Portal + Board",
      url: FLAP_BOARD_URL,
      docsUrl: "https://docs.flap.sh/flap/developers/deployed-contract-addresses",
      official: true,
      trust: "official_docs_bound_fingerprinted_portal_receipt",
    },
    sourceUrl: FLAP_BOARD_URL,
    url: explorerUrl,
    explorerUrl,
    observedAt: "2026-09-03T00:00:05.000Z",
    occurredAt: blockTimestamp,
    blockTimestamp,
    transactionHash,
    blockNumber,
    blockHash,
    logIndex,
    receiptProof: {
      status: 1,
      transactionHash,
      transactionIndex: 2,
      blockNumber,
      blockHash,
      logIndex,
      logMatched: true,
    },
    transactionProof: {
      hash: transactionHash,
      from: "0x1111111111111111111111111111111111111111",
      to: "0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2",
      nonce: 9,
      blockNumber,
      blockHash,
    },
    blockProof: {
      number: blockNumber,
      hash: blockHash,
      timestamp: blockTimestamp,
      canonical: true,
      confirmations: 5,
      requiredConfirmations: 3,
    },
    onchainProof: evidence,
    evidence: structuredClone(evidence),
    changes: {
      newFlapPools: [asset],
      updatedFlapPools: [],
      removedFlapPools: [],
      flapPoolChanges: [],
      newQuoteTokens: [asset.quoteSymbol],
      newQuoteConfigs: [{ symbol: asset.quoteSymbol, address: asset.quoteAddress, ...configuration }],
      newContracts: [asset.quoteAddress],
    },
    signal: {
      strong: true,
      platformStructural: true,
      category: "Flap quote asset enabled",
      headline: `Flap enabled ${asset.quoteSymbol} as a BSC quote asset`,
      quotePairChange: {
        stage: "live",
        assetClass: "quote_asset",
        assets: [{
          symbol: asset.quoteSymbol,
          name: asset.quoteName,
          address: asset.quoteAddress,
          decimals: asset.quoteDecimals,
        }],
      },
    },
    strong: true,
    reorgOrphanedEventKeys: [],
    risk: "A Portal quote configuration is platform capability evidence, not proof of token safety, liquidity depth, backing, or favorable execution.",
  };
};

const strictFlapPortalDelayedRecoveryEvent = () => {
  const event = strictFlapPortalQuoteAssetEvent();
  const originalEventKey = event.eventKey;
  const recoveredAt = new Date(Date.parse(event.occurredAt) + 20 * 60_000).toISOString();
  event.eventKey = `${originalEventKey}:delayed-recovery:v1`;
  event.originalEventKey = originalEventKey;
  event.observedAt = recoveredAt;
  event.delayedRecovery = {
    version: 1,
    reason: "monitoring_gap_recovery",
    sourceOccurredAt: event.occurredAt,
    originalBlockNumber: event.blockNumber,
    originalBlockHash: event.blockHash,
    originalTransactionHash: event.transactionHash,
    originalLogIndex: event.logIndex,
    recoveredAt,
    lagMs: 20 * 60_000,
    cursor: {
      nextBlockAtRecovery: event.blockNumber,
      eventBlock: event.blockNumber,
    },
  };
  return event;
};

const strictFlapPortalFirstObservedAfterGapEvent = ({ successfulReaders = 0 } = {}) => {
  const event = strictFlapPortalQuoteAssetEvent();
  const asset = event.changes.newFlapPools[0];
  const originalEventKey = event.eventKey;
  const recoveredAt = new Date(Date.parse(event.occurredAt) + 20 * 60_000).toISOString();
  event.kind = "flap_quote_asset_first_observed_after_gap";
  event.changeType = "observed";
  event.eventKey = `${originalEventKey}:first-observed-after-gap:v1`;
  event.originalEventKey = originalEventKey;
  event.observedAt = recoveredAt;
  event.priorTransitionProof = "unavailable";
  event.priorStateRead = {
    blockNumber: event.blockNumber - 1,
    method: "getQuoteTokenConfiguration(address)",
    requiredIndependentReaders: 2,
    successfulReaders,
    matchingUnavailableReaders: 2 - successfulReaders,
    failureClass: "archive_state_unavailable",
  };
  event.changes = {
    newFlapPools: [],
    updatedFlapPools: [asset],
    removedFlapPools: [],
    flapPoolChanges: [],
    newQuoteTokens: [],
    newQuoteConfigs: [],
    newContracts: [],
  };
  event.signal = {
    strong: false,
    platformStructural: true,
    category: "Flap quote asset first observed after gap",
    headline: `Flap first observed ${asset.quoteSymbol} currently enabled after a monitoring gap`,
    quotePairChange: {
      stage: "observed",
      assetClass: "quote_asset",
      assets: [{
        symbol: asset.quoteSymbol,
        name: asset.quoteName,
        address: asset.quoteAddress,
        decimals: asset.quoteDecimals,
      }],
    },
  };
  event.strong = false;
  event.delayedRecovery = {
    version: 1,
    reason: "first_observed_after_gap",
    sourceOccurredAt: event.occurredAt,
    originalBlockNumber: event.blockNumber,
    originalBlockHash: event.blockHash,
    originalTransactionHash: event.transactionHash,
    originalLogIndex: event.logIndex,
    recoveredAt,
    lagMs: 20 * 60_000,
    cursor: {
      nextBlockAtRecovery: event.blockNumber,
      eventBlock: event.blockNumber,
    },
  };
  event.risk = "Historical archive state was unavailable from the required independent readers. This confirms only that the quote asset is enabled now; it does not prove a new 0-to-1 activation, token safety, liquidity, backing, or favorable execution.";
  return event;
};

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

test("focus3 admits the real Flap bStock quote-pair tweet only through exact X identity and recomputed structure", () => {
  const exact = exactFlapQuotePairEvent();
  assert.equal(isOfficialFlapQuotePairUpdate(exact), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, exact), true);
  assert.deepEqual(exact.signal.quotePairChange, {
    assetClass: "bstock_quote",
    stage: "announced",
    assets: [
      { symbol: "SOXLB", name: "Bull Semiconductors 3X ETF" },
      { symbol: "SOXSB", name: "Bear Semiconductors 3X ETF" },
    ],
  });

  const dotted = exactFlapQuotePairEvent(`Flap is expanding with one new bStock trading pair:
BRK.B — Berkshire Class B Stock
The BRK.B bStock quote pair is coming to Flap.sh.`);
  assert.deepEqual(dotted.signal.quotePairChange, {
    assetClass: "bstock_quote",
    stage: "announced",
    assets: [{ symbol: "BRK.B", name: "Berkshire Class B Stock" }],
  });
  assert.equal(isOfficialFlapQuotePairUpdate(dotted), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, dotted), true);

  const mutations = [
    ["project id", (event) => { event.project.id = "fourmeme"; }],
    ["project handle", (event) => { event.project.handle = "flapdotsh_"; }],
    ["project numeric id", (event) => { event.project.xUserId = "1749114887807320065"; }],
    ["project trust mode", (event) => { event.project.match = "display_name"; }],
    ["tweet handle", (event) => { event.tweet.handle = "flapdotsh_"; }],
    ["tweet numeric id", (event) => { event.tweet.xUserId = "1749114887807320065"; }],
    ["author id", (event) => { event.tweet.authorId = "1749114887807320065"; }],
    ["status URL", (event) => { event.tweet.url = `https://x.com/attacker/status/${FLAP_BSTOCK_PAIRS_TWEET_ID}`; }],
    ["oEmbed proof", (event) => { event.tweet.sourceVerifiedBy = "copied_json"; }],
    ["reply flag", (event) => { event.tweet.isReply = true; }],
    ["recomputed symbol", (event) => { event.signal.quotePairChange.assets[0].symbol = "FAKEB"; }],
    ["recomputed name", (event) => { event.signal.quotePairChange.assets[0].name = "Fake ETF"; }],
    ["recomputed stage", (event) => { event.signal.quotePairChange.stage = "live"; event.signal.reason = "flap_bstock_quote_pair_live"; }],
    ["asset order", (event) => { event.signal.quotePairChange.assets.reverse(); }],
    ["extra structural field", (event) => { event.signal.quotePairChange.assets[0].address = FLAP_QUOTE_ADDRESS; }],
    ["tweet body after classification", (event) => { event.tweet.text = event.tweet.text.replace("SOXLB", "FAKEB"); }],
  ];
  for (const [label, mutate] of mutations) {
    const forged = structuredClone(exact);
    mutate(forged);
    assert.equal(isOfficialFlapQuotePairUpdate(forged), false, label);
    assert.equal(isMonitoringSourceEnabled(focusConfig, forged), false, label);
  }

  const marketing = exactFlapQuotePairEvent(`Flap introduces two new bStock trading pairs:
SOXLB — Bull Semiconductors 3X ETF
SOXSB — Bear Semiconductors 3X ETF
Trade & Win for a 50,000 USDT prize pool.`);
  assert.equal(marketing.signal.relevant, false);
  assert.equal(isMonitoringSourceEnabled(focusConfig, marketing), false);

  const impersonator = exactFlapQuotePairEvent();
  impersonator.project = {
    id: "fourmeme",
    handle: "fourdotmemezh",
    xUserId: "1816036559864619011",
    match: "official_x",
  };
  impersonator.tweet.handle = "fourdotmemezh";
  impersonator.tweet.xUserId = "1816036559864619011";
  impersonator.tweet.authorId = "1816036559864619011";
  impersonator.tweet.url = `https://x.com/fourdotmemezh/status/${FLAP_BSTOCK_PAIRS_TWEET_ID}`;
  assert.equal(isMonitoringSourceEnabled(focusConfig, impersonator), false);
});

test("focus3 Flap board stock-quote exception requires a complete BSC quote_asset and coherent optional proof", () => {
  const pool = strictFlapQuoteAsset();
  const exact = strictFlapQuoteAssetEvent(pool);
  assert.equal(isStrictFlapQuoteAsset(pool), true);
  assert.equal(isStrictFlapQuoteAssetUpdate(exact), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, exact), true);
  for (const quoteSymbol of ["Brk.B", "X", "A$", "Mixed_Case$1", "A12345678901234567890123"]) {
    const variant = strictFlapQuoteAsset({ quoteSymbol });
    assert.equal(isStrictFlapQuoteAsset(variant), true, quoteSymbol);
    assert.equal(isMonitoringSourceEnabled(focusConfig, strictFlapQuoteAssetEvent(variant)), true, quoteSymbol);
  }

  const beforeMetadata = { ...pool, quoteSymbol: null };
  delete beforeMetadata.quoteName;
  const metadataBackfill = strictFlapQuoteAssetEvent(pool, {
    newFlapPools: [],
    updatedFlapPools: [pool],
    flapPoolChanges: [{ identity: pool.identity, before: beforeMetadata, after: pool }],
  });
  assert.equal(isStrictFlapQuoteAssetUpdate(metadataBackfill), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, metadataBackfill), true);

  const transactionHash = `0x${"a1".repeat(32)}`;
  const proof = {
    portal: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
    transactionHash,
    blockNumber: 61_234_567,
    receiptVerified: true,
  };
  const provedPool = strictFlapQuoteAsset({ ...proof, onchainProof: { ...proof } });
  const proved = strictFlapQuoteAssetEvent(provedPool);
  assert.equal(isStrictFlapQuoteAsset(provedPool), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, proved), true);

  const poolMutations = [
    ["kind", (item) => { item.kind = "vault_factory"; }],
    ["chain", (item) => { item.chainId = 2818; }],
    ["board URL", (item) => { item.sourceUrl = "https://flap.sh/morph/board"; }],
    ["identity", (item) => { item.identity = `chain-56:quote:0x${"1".repeat(40)}`; }],
    ["address", (item) => { delete item.quoteAddress; }],
    ["symbol", (item) => { delete item.quoteSymbol; }],
    ["leading punctuation symbol", (item) => { item.quoteSymbol = ".SOXSB"; }],
    ["name", (item) => { delete item.quoteName; }],
    ["unknown metadata", (item) => { item.stockMarketing = true; }],
  ];
  for (const [label, mutate] of poolMutations) {
    const item = structuredClone(pool);
    mutate(item);
    assert.equal(isStrictFlapQuoteAsset(item), false, label);
    assert.equal(isMonitoringSourceEnabled(focusConfig, strictFlapQuoteAssetEvent(item)), false, label);
  }

  const eventMutations = [
    ["platform", (event) => { event.platform.id = "fourmeme"; }],
    ["source", (event) => { event.source = "https://docs.flap.sh/flap"; }],
    ["event URL", (event) => { event.url = "https://docs.flap.sh/flap"; }],
    ["sources", (event) => { event.sources.push("https://attacker.example/board"); }],
    ["stock module piggyback", (event) => { event.changes.newModules = ["RWA stock issuance"]; }],
  ];
  for (const [label, mutate] of eventMutations) {
    const event = structuredClone(exact);
    mutate(event);
    assert.equal(isStrictFlapQuoteAssetUpdate(event), false, label);
    assert.equal(isMonitoringSourceEnabled(focusConfig, event), false, label);
  }

  for (const [label, mutate] of [
    ["unofficial portal", (item) => { item.portal = item.onchainProof.portal = `0x${"2".repeat(40)}`; }],
    ["transaction mismatch", (item) => { item.onchainProof.transactionHash = `0x${"b2".repeat(32)}`; }],
    ["block mismatch", (item) => { item.onchainProof.blockNumber += 1; }],
    ["unverified receipt", (item) => { item.receiptVerified = item.onchainProof.receiptVerified = false; }],
    ["proof extension", (item) => { item.onchainProof.logIndex = 0; }],
  ]) {
    const item = structuredClone(provedPool);
    mutate(item);
    assert.equal(isStrictFlapQuoteAsset(item), false, label);
    assert.equal(isMonitoringSourceEnabled(focusConfig, strictFlapQuoteAssetEvent(item)), false, label);
  }
});

test("focus3 accepts the direct Flap Portal quote event only when board metadata and receipt, transaction, and block proofs agree", () => {
  const exact = strictFlapPortalQuoteAssetEvent();
  assert.equal(isStrictFlapPortalQuoteAssetUpdate(exact), true);
  assert.equal(isStrictFlapQuoteAssetUpdate(exact), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, exact), true);
  for (const quoteSymbol of ["Brk.B", "X", "A$", "Mixed_Case$1", "A12345678901234567890123"]) {
    const variant = structuredClone(exact);
    variant.changes.newFlapPools[0].quoteSymbol = quoteSymbol;
    variant.changes.newQuoteTokens = [quoteSymbol];
    variant.changes.newQuoteConfigs[0].symbol = quoteSymbol;
    variant.signal.headline = `Flap enabled ${quoteSymbol} as a BSC quote asset`;
    variant.signal.quotePairChange.assets[0].symbol = quoteSymbol;
    assert.equal(isStrictFlapPortalQuoteAssetUpdate(variant), true, quoteSymbol);
  }

  const mutations = [
    ["platform", (event) => { event.platform.id = "fourmeme"; }],
    ["platform attacker link", (event) => { event.platform.twitter = "https://attacker.example"; }],
    ["chain extension", (event) => { event.chain.explorer = "https://attacker.example"; }],
    ["top-level extension", (event) => { event.attackerUrl = "https://attacker.example"; }],
    ["missing producer field", (event) => { delete event.reorgOrphanedEventKeys; }],
    ["malformed orphan key", (event) => { event.reorgOrphanedEventKeys = ["flap-quote:56:attacker:7"]; }],
    ["chain", (event) => { event.chainId = 2818; }],
    ["source URL", (event) => { event.source.url = "https://attacker.example/board"; }],
    ["portal", (event) => { event.portal = "0x2222222222222222222222222222222222222222"; }],
    ["receipt transaction", (event) => { event.receiptProof.transactionHash = `0x${"34".repeat(32)}`; }],
    ["transaction block", (event) => { event.transactionProof.blockNumber += 1; }],
    ["block hash", (event) => { event.blockProof.hash = `0x${"56".repeat(32)}`; }],
    ["onchain portal", (event) => {
      event.onchainProof.portal = "0x2222222222222222222222222222222222222222";
      event.evidence.portal = event.onchainProof.portal;
    }],
    ["receipt verification", (event) => {
      event.onchainProof.receiptVerified = false;
      event.evidence.receiptVerified = false;
    }],
    ["ABI quote address word", (event) => {
      const forgedAddressWord = "2".repeat(40).padStart(64, "0");
      event.onchainProof.logData = `0x${forgedAddressWord}${event.onchainProof.logData.slice(66)}`;
      event.evidence.logData = event.onchainProof.logData;
    }],
    ["ABI configuration word", (event) => {
      event.onchainProof.logData = `${event.onchainProof.logData.slice(0, -64)}${"5".padStart(64, "0")}`;
      event.evidence.logData = event.onchainProof.logData;
    }],
    ["confirmation arithmetic", (event) => {
      event.onchainProof.confirmations += 1;
      event.evidence.confirmations += 1;
      event.blockProof.confirmations += 1;
    }],
    ["pool metadata", (event) => { delete event.changes.newFlapPools[0].quoteName; }],
    ["leading punctuation symbol", (event) => {
      event.changes.newFlapPools[0].quoteSymbol = ".SOXSB";
      event.changes.newQuoteTokens = [".SOXSB"];
      event.changes.newQuoteConfigs[0].symbol = ".SOXSB";
      event.signal.headline = "Flap enabled .SOXSB as a BSC quote asset";
      event.signal.quotePairChange.assets[0].symbol = ".SOXSB";
    }],
    ["quote config", (event) => { event.changes.newQuoteConfigs[0].dexId += 1; }],
    ["signal structure", (event) => { event.signal.quotePairChange.assets[0].name = "Forged ETF"; }],
    ["stock module piggyback", (event) => { event.changes.newModules = ["RWA stock issuance"]; }],
  ];
  for (const [label, mutate] of mutations) {
    const event = structuredClone(exact);
    mutate(event);
    assert.equal(isStrictFlapPortalQuoteAssetUpdate(event), false, label);
    assert.equal(isStrictFlapQuoteAssetUpdate(event), false, label);
    assert.equal(isMonitoringSourceEnabled(focusConfig, event), false, label);
  }
});

test("focus3 authenticates the exact Flap Portal delayed-recovery envelope and its original proof", () => {
  const exact = strictFlapPortalDelayedRecoveryEvent();
  assert.equal(isStrictFlapPortalQuoteAssetUpdate(exact), true);
  assert.equal(isMonitoringSourceEnabled(focusConfig, exact), true);

  const mutations = [
    ["derived event key", (event) => { event.eventKey = event.originalEventKey; }],
    ["original event key", (event) => { event.originalEventKey = `${event.originalEventKey}:forged`; }],
    ["source occurrence", (event) => { event.delayedRecovery.sourceOccurredAt = event.observedAt; }],
    ["original block", (event) => { event.delayedRecovery.originalBlockNumber += 1; }],
    ["original block hash", (event) => { event.delayedRecovery.originalBlockHash = `0x${"91".repeat(32)}`; }],
    ["original transaction", (event) => { event.delayedRecovery.originalTransactionHash = `0x${"92".repeat(32)}`; }],
    ["original log", (event) => { event.delayedRecovery.originalLogIndex += 1; }],
    ["recovered instant", (event) => { event.delayedRecovery.recoveredAt = event.occurredAt; }],
    ["lag equation", (event) => { event.delayedRecovery.lagMs += 1; }],
    ["lag threshold", (event) => {
      event.observedAt = new Date(Date.parse(event.occurredAt) + 15 * 60_000).toISOString();
      event.delayedRecovery.recoveredAt = event.observedAt;
      event.delayedRecovery.lagMs = 15 * 60_000;
    }],
    ["cursor event block", (event) => { event.delayedRecovery.cursor.eventBlock += 1; }],
    ["recovery extension", (event) => { event.delayedRecovery.attackerUrl = "https://attacker.example"; }],
    ["cursor extension", (event) => { event.delayedRecovery.cursor.attacker = true; }],
    ["original CA binding", (event) => { event.signal.quotePairChange.assets[0].address = "0x2222222222222222222222222222222222222222"; }],
  ];
  for (const [label, mutate] of mutations) {
    const event = structuredClone(exact);
    mutate(event);
    assert.equal(isStrictFlapPortalQuoteAssetUpdate(event), false, label);
    assert.equal(isMonitoringSourceEnabled(focusConfig, event), false, label);
  }

  const staleWithoutEnvelope = strictFlapPortalQuoteAssetEvent();
  staleWithoutEnvelope.observedAt = new Date(Date.parse(staleWithoutEnvelope.occurredAt) + 20 * 60_000).toISOString();
  assert.equal(isStrictFlapPortalQuoteAssetUpdate(staleWithoutEnvelope), false);
});

test("focus3 admits only the exact stale Flap first-observed fallback when prior archive-state quorum is unavailable", () => {
  for (const successfulReaders of [0, 1]) {
    const exact = strictFlapPortalFirstObservedAfterGapEvent({ successfulReaders });
    assert.equal(isStrictFlapPortalQuoteAssetUpdate(exact), true, `successfulReaders=${successfulReaders}`);
    assert.equal(isStrictFlapQuoteAssetUpdate(exact), true, `successfulReaders=${successfulReaders}`);
    assert.equal(isMonitoringSourceEnabled(focusConfig, exact), true, `successfulReaders=${successfulReaders}`);
  }

  const exact = strictFlapPortalFirstObservedAfterGapEvent();
  const mutations = [
    ["fresh age", (event) => {
      event.observedAt = new Date(Date.parse(event.occurredAt) + 15 * 60_000).toISOString();
      event.delayedRecovery.recoveredAt = event.observedAt;
      event.delayedRecovery.lagMs = 15 * 60_000;
    }],
    ["added kind", (event) => { event.kind = "flap_quote_asset_enabled"; }],
    ["added change claim", (event) => { event.changeType = "added"; }],
    ["live stage", (event) => { event.signal.quotePairChange.stage = "live"; }],
    ["strong promotion", (event) => { event.strong = event.signal.strong = true; }],
    ["new pool claim", (event) => {
      event.changes.newFlapPools = event.changes.updatedFlapPools;
      event.changes.updatedFlapPools = [];
    }],
    ["new quote claim", (event) => { event.changes.newQuoteTokens = ["SOXSB"]; }],
    ["new config claim", (event) => { event.changes.newQuoteConfigs = [{ symbol: "SOXSB" }]; }],
    ["new contract claim", (event) => { event.changes.newContracts = [FLAP_QUOTE_ADDRESS]; }],
    ["transition proof", (event) => { event.priorTransitionProof = "enabled"; }],
    ["prior block", (event) => { event.priorStateRead.blockNumber += 1; }],
    ["prior method", (event) => { event.priorStateRead.method = "eth_call"; }],
    ["reader quorum", (event) => { event.priorStateRead.requiredIndependentReaders = 1; }],
    ["two successful readers", (event) => {
      event.priorStateRead.successfulReaders = 2;
      event.priorStateRead.matchingUnavailableReaders = 0;
    }],
    ["reader count mismatch", (event) => { event.priorStateRead.matchingUnavailableReaders = 1; }],
    ["transport failure", (event) => { event.priorStateRead.failureClass = "transport_unavailable"; }],
    ["archive disagreement", (event) => { event.priorStateRead.failureClass = "archive_state_disagreement"; }],
    ["prior proof extension", (event) => { event.priorStateRead.sourceUrl = "https://attacker.example"; }],
    ["ordinary activation risk", (event) => {
      event.risk = "A Portal quote configuration is platform capability evidence, not proof of token safety, liquidity depth, backing, or favorable execution.";
    }],
    ["wrong recovery reason", (event) => { event.delayedRecovery.reason = "monitoring_gap_recovery"; }],
    ["wrong derived key", (event) => { event.eventKey = `${event.originalEventKey}:delayed-recovery:v1`; }],
  ];
  for (const [label, mutate] of mutations) {
    const forged = structuredClone(exact);
    mutate(forged);
    assert.equal(isStrictFlapPortalQuoteAssetUpdate(forged), false, label);
    assert.equal(isMonitoringSourceEnabled(focusConfig, forged), false, label);
  }

  const ordinaryFresh = strictFlapPortalQuoteAssetEvent();
  ordinaryFresh.kind = "flap_quote_asset_first_observed_after_gap";
  ordinaryFresh.changeType = "observed";
  assert.equal(isStrictFlapPortalQuoteAssetUpdate(ordinaryFresh), false, "a normal fresh event cannot opt into the weak lane");
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

test("verified Binance CMS and WebSocket announcements defer stock/RWA semantics to central relevance", () => {
  const title = "Binance Futures Will Launch Multiple USDⓈ-Margined TradFi Perpetual Contracts";
  const official = [
    {
      type: "binance_official_update",
      title,
      source: {
        id: "binance_exchange_cms",
        url: "https://www.binance.com/en/support/announcement/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      url: "https://www.binance.com/en/support/announcement/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      detailSource: "https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      type: "binance_official_update",
      title,
      source: {
        id: "binance_announcement_websocket",
        url: "https://developers.binance.com/en/docs/products/announcements/announcement",
      },
      url: "https://www.binance.com/en/support/announcement/detail/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  ];
  for (const event of official) assert.equal(isMonitoringSourceEnabled(binanceFocusConfig, event), true, event.source.id);

  assert.equal(isMonitoringSourceEnabled(binanceFocusConfig, {
    ...official[0],
    detailSource: "https://binance.com.evil.example/copied-detail",
  }), false, "a copied official source id with hostile provenance remains fail-closed");
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
      stage: "observed",
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
  invalid((candidate) => { candidate.news.category = "AI Agent"; });
  invalid((candidate) => { candidate.news.stage = "edited"; });
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

test("focus3 admits only the exact pon.fun producer and immutable official-X identity", () => {
  const tx = `0x${"a".repeat(64)}`;
  const coin = "0x1111111111111111111111111111111111111111";
  const stockToken = "0x2222222222222222222222222222222222222222";
  const vault = "0x3333333333333333333333333333333333333333";
  const curve = "0x4444444444444444444444444444444444444444";
  const creator = "0x5555555555555555555555555555555555555555";
  const factory = "0xF698d13348686C1529c2DC54847C123424d9DAE0";
  const risk = "PON coins are not the referenced stocks; backing, oracle, liquidity, sellability and admin controls remain risks.";
  const market = {
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
  ].map((key) => [key, market[key]]));
  const creation = Object.fromEntries([
    "ticker", "symbol", "name", "coin", "vault", "curve", "creator", "creatorFeeBps",
  ].map((key) => [key, market[key]]));
  const event = {
    type: "pon_fun_update",
    kind: "market_created",
    eventKey: `pon-fun:market_created:4663:${tx}:7`,
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
      url: `https://robinhoodchain.blockscout.com/tx/${tx}`,
      official: true,
      trust: "official_site_bound_onchain_fingerprinted",
    },
    sourceTrust: "official_site_bound_onchain_fingerprinted",
    chainId: 4663,
    factory,
    title: "pon.fun 新市场：NVDAx / NVDA",
    summary: "A new pon.fun MarketCreated event matches the official markets API, token list and Factory getters.",
    observedAt: "2026-09-02T04:00:01.000Z",
    strong: true,
    risk,
    transactionHash: tx,
    blockNumber: 52_000_001,
    blockHash: `0x${"b".repeat(64)}`,
    blockTimestamp: "2026-09-02T04:00:00.000Z",
    explorerUrl: `https://robinhoodchain.blockscout.com/tx/${tx}`,
    token: coin,
    contractAddress: coin,
    ticker: market.ticker,
    symbol: market.symbol,
    market,
    currentSnapshot: structuredClone(market),
    changes: { market: { before: null, after: marketCore } },
    creation,
    evidence: {
      chainId: 4663,
      factory,
      factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
      topic0: "0x8ada27e0afa58f4d4be8c4edbf4bfd49d9d586ce8a714938b12f51b7855893bb",
      logIndex: 7,
      receiptVerified: true,
      api: {
        healthUrl: "https://www.pon.fun/api/health",
        marketsUrl: "https://www.pon.fun/api/markets",
        tokenListUrl: "https://www.pon.fun/tokenlist.json",
      },
    },
  };
  assert.equal(isOfficialPonFunUpdate(event), true);
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, event), true, "the exact Pon RWA event is the only stock/RWA exception");
  assert.equal(isMonitoringSourceEnabled({ ...ponFocusConfig, ponMonitorEnabled: false }, event), false);

  const reject = (mutate, label) => {
    const candidate = structuredClone(event);
    mutate(candidate);
    assert.equal(isMonitoringSourceEnabled(ponFocusConfig, candidate), false, label);
  };
  reject((candidate) => { candidate.platform.id = "pon-fun"; }, "platform id is exact");
  reject((candidate) => { candidate.source.id = "pon_fun_api"; }, "source id is exact");
  reject((candidate) => { candidate.source.trust = "official_verified"; }, "trust must preserve its narrow meaning");
  reject((candidate) => { candidate.evidence.factoryCodeHash = `0x${"c".repeat(64)}`; }, "factory fingerprint is pinned");
  reject((candidate) => { candidate.evidence.topic0 = `0x${"d".repeat(64)}`; }, "kind and topic must agree");
  reject((candidate) => { candidate.source.url = `https://evil.example/tx/${tx}`; }, "chain evidence URL is exact");
  reject((candidate) => { candidate.chainId = "4663"; }, "numeric chain fields do not accept coercible strings");
  reject((candidate) => { candidate.blockNumber = "52000001"; }, "blockNumber is an integer, not numeric text");
  reject((candidate) => { candidate.evidence.chainId = "4663"; }, "evidence chainId is typed");
  reject((candidate) => { candidate.evidence.logIndex = "7"; }, "logIndex is typed");
  reject((candidate) => { candidate.source.untrusted = true; }, "source provenance has a closed schema");
  reject((candidate) => { candidate.evidence.api.untrusted = true; }, "API provenance has a closed schema");
  reject((candidate) => { candidate.untrusted = true; }, "top-level producer schema is closed");
  reject((candidate) => { candidate.platform.model = "generic launchpad"; }, "platform model is pinned");
  reject((candidate) => { candidate.risk = "risk-free"; }, "risk framing is pinned");
  reject((candidate) => { candidate.currentSnapshot.name = "Forged market"; }, "MarketCreated current snapshot must equal the verified market");
  reject((candidate) => { candidate.creation.creatorFeeBps += 1; }, "MarketCreated creation proof must equal the market core");
  reject((candidate) => { candidate.changes.market.after.symbol = "FAKE"; }, "MarketCreated changes must equal the verified market core");
  reject((candidate) => { candidate.contractAddress = stockToken; }, "MarketCreated contract address must equal its coin");

  const controlEvent = (kind, topic0, title, summary, fields) => {
    const candidate = structuredClone(event);
    for (const key of ["token", "contractAddress", "ticker", "symbol", "market", "currentSnapshot", "changes", "creation"]) {
      delete candidate[key];
    }
    candidate.kind = kind;
    candidate.eventKey = `pon-fun:${kind}:4663:${tx}:7`;
    candidate.evidence.topic0 = topic0;
    candidate.title = title;
    candidate.summary = summary;
    return Object.assign(candidate, fields);
  };
  const zero = "0x0000000000000000000000000000000000000000";
  const oracleBefore = "0x6666666666666666666666666666666666666666";
  const oracleAfter = "0x7777777777777777777777777777777777777777";
  const configBefore = {
    oracle: oracleBefore,
    swapRouter: vault,
    positionManager: curve,
    protocolTreasury: creator,
  };
  const configAfter = { ...configBefore, oracle: oracleAfter };
  const configEvent = controlEvent(
    "factory_config",
    "0x8d4f9022ab10978259dead0fa01463e75fda43dfe57f0445e69b010074c016fd",
    "pon.fun Factory 配置更新",
    "Factory emitted ConfigSet; oracle/router/position manager/treasury values are shown exactly.",
    { previousSnapshot: configBefore, currentSnapshot: configAfter, changes: { oracle: { before: oracleBefore, after: oracleAfter } } },
  );
  const curveBefore = {
    p0: "200000000000000",
    slope: "7250000000000000000000000",
    curveCap: "800000000000000000000000000",
    lpPoolFee: 10_000,
    maxSlippageBps: 300,
    autoAcquire: true,
  };
  const curveAfter = { ...curveBefore, lpPoolFee: 3_000 };
  const curveEvent = controlEvent(
    "curve_params",
    "0x25482d70bd81eb7de3dfac5c42283fda45887a7d1fb434a68c2a13e45baf29f3",
    "pon.fun 曲线参数更新",
    "Factory emitted CurveParamsSet; launch pricing and LP parameters changed.",
    { previousSnapshot: curveBefore, currentSnapshot: curveAfter, changes: { lpPoolFee: { before: 10_000, after: 3_000 } } },
  );
  const listingBefore = { ticker: "NVDA", stockToken, poolFee: 3_000, active: true };
  const listingAfter = { ...listingBefore, poolFee: 10_000 };
  const listingEvent = controlEvent(
    "stock_listing",
    "0x7740fd3f56c396ca150bbd7ec72ee92798920ea8eb3f25f9a03582dc9bb564b1",
    "pon.fun 股票映射更新：NVDA",
    "Factory emitted StockListed for a stock-token oracle mapping.",
    {
      ticker: "NVDA",
      contractAddress: stockToken,
      previousSnapshot: listingBefore,
      currentSnapshot: listingAfter,
      changes: { poolFee: { before: 3_000, after: 10_000 } },
    },
  );
  const retiredListingEvent = structuredClone(listingEvent);
  retiredListingEvent.contractAddress = zero;
  retiredListingEvent.currentSnapshot = { ...listingAfter, stockToken: zero, active: false };
  retiredListingEvent.changes = {
    stockToken: { before: stockToken, after: zero },
    poolFee: { before: 3_000, after: 10_000 },
    active: { before: true, after: false },
  };
  const pauseEvent = controlEvent(
    "factory_paused",
    "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
    "pon.fun Factory 已暂停",
    "Factory emitted Paused; new launches may be unavailable.",
    {
      previousSnapshot: { paused: false },
      currentSnapshot: { paused: true, account: creator },
      changes: { paused: { before: false, after: true } },
    },
  );
  const unpauseEvent = controlEvent(
    "factory_unpaused",
    "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa",
    "pon.fun Factory 已恢复",
    "Factory emitted Unpaused; factory operations were unpaused.",
    {
      previousSnapshot: { paused: true },
      currentSnapshot: { paused: false, account: creator },
      changes: { paused: { before: true, after: false } },
    },
  );
  const ownershipStartedEvent = controlEvent(
    "ownership_transfer_started",
    "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700",
    "pon.fun Factory 所有权转移已发起",
    "Factory emitted OwnershipTransferStarted; a pending admin authority was nominated.",
    {
      previousSnapshot: { owner: creator, pendingOwner: zero },
      currentSnapshot: { owner: creator, pendingOwner: oracleAfter },
      changes: { pendingOwner: { before: zero, after: oracleAfter } },
    },
  );
  const ownershipTransferredEvent = controlEvent(
    "ownership_transferred",
    "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
    "pon.fun Factory 所有权已转移",
    "Factory emitted OwnershipTransferred; admin authority changed and the pending owner was cleared.",
    {
      previousSnapshot: { owner: creator, pendingOwner: oracleAfter },
      currentSnapshot: { owner: oracleAfter, pendingOwner: zero },
      changes: {
        owner: { before: creator, after: oracleAfter },
        pendingOwner: { before: oracleAfter, after: zero },
      },
    },
  );
  const exactControlEvents = [
    configEvent,
    curveEvent,
    listingEvent,
    retiredListingEvent,
    pauseEvent,
    unpauseEvent,
    ownershipStartedEvent,
    ownershipTransferredEvent,
  ];
  for (const candidate of exactControlEvents) {
    assert.equal(isOfficialPonFunUpdate(candidate), true, `${candidate.kind} producer schema is accepted`);
    const badTitle = structuredClone(candidate);
    badTitle.title += "!";
    assert.equal(isOfficialPonFunUpdate(badTitle), false, `${candidate.kind} title is closed`);
  }
  const configAfterReorg = structuredClone(configEvent);
  configAfterReorg.previousSnapshot = null;
  configAfterReorg.changes = Object.fromEntries(Object.entries(configAfter).map(([key, after]) => [key, { before: null, after }]));
  assert.equal(isOfficialPonFunUpdate(configAfterReorg), true, "a reorg-cleared config snapshot stays explicit and fail closed");
  const curveAfterReorg = structuredClone(curveEvent);
  curveAfterReorg.previousSnapshot = null;
  curveAfterReorg.changes = Object.fromEntries(Object.entries(curveAfter).map(([key, after]) => [key, { before: null, after }]));
  assert.equal(isOfficialPonFunUpdate(curveAfterReorg), true, "a reorg-cleared curve snapshot stays explicit and fail closed");
  for (const [label, source, mutate] of [
    ["config before/after", configEvent, (candidate) => { candidate.currentSnapshot.oracle = coin; }],
    ["curve before/after", curveEvent, (candidate) => { candidate.changes.lpPoolFee.after = 5_000; }],
    ["listing ticker", listingEvent, (candidate) => { candidate.ticker = "AAPL"; }],
    ["active listing zero token", listingEvent, (candidate) => { candidate.currentSnapshot.stockToken = zero; candidate.contractAddress = zero; }],
    ["pause kind/state", pauseEvent, (candidate) => { candidate.currentSnapshot.paused = false; }],
    ["unpause change", unpauseEvent, (candidate) => { candidate.changes.paused.before = false; }],
    ["pending owner", ownershipStartedEvent, (candidate) => { candidate.currentSnapshot.owner = oracleAfter; }],
    ["completed owner", ownershipTransferredEvent, (candidate) => { candidate.currentSnapshot.pendingOwner = creator; }],
  ]) {
    const candidate = structuredClone(source);
    mutate(candidate);
    assert.equal(isOfficialPonFunUpdate(candidate), false, label);
  }

  const lifecyclePrevious = { ...market, baseline: true, firstSeenAt: "2026-09-02T03:00:00.000Z" };
  const lifecycleCurrent = { ...market, graduated: true, lpDeployed: true };
  const lifecycleEvent = {
    ...structuredClone(event),
    kind: "market_lifecycle",
    eventKey: `pon-fun:market-lifecycle:${coin}:rev:1:api:52000008:binding:52000010`,
    title: "pon.fun 市场状态更新：NVDAx",
    summary: "The official market lifecycle changed after its Factory identity was re-verified on-chain.",
    source: { ...event.source, url: "https://www.pon.fun/api/markets" },
    market: lifecycleCurrent,
    previousSnapshot: lifecyclePrevious,
    currentSnapshot: structuredClone(lifecycleCurrent),
    changes: {
      graduated: { before: false, after: true },
      lpDeployed: { before: false, after: true },
    },
    evidence: {
      chainId: 4663,
      factory,
      factoryCodeHash: event.evidence.factoryCodeHash,
      bindingVerifiedAtBlock: 52_000_010,
      bindingVerifiedAtBlockHash: `0x${"c".repeat(64)}`,
      apiHealthBlock: 52_000_008,
      transitionRevision: 1,
      api: structuredClone(event.evidence.api),
    },
  };
  for (const key of ["transactionHash", "blockNumber", "blockHash", "blockTimestamp", "explorerUrl", "creation"]) delete lifecycleEvent[key];
  assert.equal(isOfficialPonFunUpdate(lifecycleEvent), true, "market lifecycle schema is exact");
  for (const [label, mutate] of [
    ["unsupported lifecycle change", (candidate) => { candidate.changes.marketCap = { before: 15, after: 20 }; }],
    ["lifecycle before mismatch", (candidate) => { candidate.changes.graduated.before = true; }],
    ["lifecycle snapshot mismatch", (candidate) => { candidate.currentSnapshot.lpDeployed = false; }],
    ["lifecycle revision mismatch", (candidate) => { candidate.evidence.transitionRevision = 2; }],
  ]) {
    const candidate = structuredClone(lifecycleEvent);
    mutate(candidate);
    assert.equal(isOfficialPonFunUpdate(candidate), false, label);
  }

  const ponfunToken = "0x7673dc6d2357bdc2e04fd80c169f2bef56622d9a";
  const platformPrevious = { address: ponfunToken, symbol: "PONFUN", name: "Ponfun", supply: "1000000000" };
  const platformCurrent = { ...platformPrevious, supply: "900000000" };
  const platformEvent = {
    ...structuredClone(lifecycleEvent),
    kind: "platform_token_update",
    eventKey: `pon-fun:platform-token:${ponfunToken}:rev:2:api:52000008:binding:52000010`,
    title: "pon.fun 平台代币资料更新",
    summary: "The official PONFUN token metadata changed while the platform Factory identity remained verified.",
    source: { ...event.source, url: "https://www.pon.fun/api/ponfun" },
    token: ponfunToken,
    contractAddress: ponfunToken,
    symbol: "PONFUN",
    previousSnapshot: platformPrevious,
    currentSnapshot: platformCurrent,
    changes: { supply: { before: "1000000000", after: "900000000" } },
    evidence: {
      chainId: 4663,
      factory,
      factoryCodeHash: event.evidence.factoryCodeHash,
      bindingVerifiedAtBlock: 52_000_010,
      bindingVerifiedAtBlockHash: `0x${"c".repeat(64)}`,
      apiHealthBlock: 52_000_008,
      transitionRevision: 2,
      platformToken: {
        token: ponfunToken,
        codePresent: true,
        codeHash: `0x${"d".repeat(64)}`,
        name: "Ponfun",
        symbol: "PONFUN",
        decimals: 18,
        totalSupplyRaw: "900000000000000000000000000",
        verifiedBlock: 52_000_010,
        verifiedBlockHash: `0x${"c".repeat(64)}`,
      },
      api: {
        healthUrl: "https://www.pon.fun/api/health",
        platformTokenUrl: "https://www.pon.fun/api/ponfun",
      },
    },
  };
  for (const key of ["ticker", "market"]) delete platformEvent[key];
  assert.equal(isOfficialPonFunUpdate(platformEvent), true, "platform token snapshot and ERC-20 proof are exact");
  for (const [label, mutate] of [
    ["platform before mismatch", (candidate) => { candidate.changes.supply.before = "1"; }],
    ["platform snapshot identity", (candidate) => { candidate.previousSnapshot.symbol = "PON"; }],
    ["platform unsupported change", (candidate) => { candidate.changes.decimals = { before: 18, after: 9 }; }],
    ["platform proof mismatch", (candidate) => { candidate.evidence.platformToken.name = "Fake"; }],
  ]) {
    const candidate = structuredClone(platformEvent);
    mutate(candidate);
    assert.equal(isOfficialPonFunUpdate(candidate), false, label);
  }

  const xTarget = {
    id: "ponfun",
    name: "pon.fun",
    website: "https://www.pon.fun",
    twitter: "https://x.com/pondotfun",
    handle: "pondotfun",
    xUserId: "2094048312772993024",
    match: "official_x",
    signalProfile: "pon_fun",
  };
  const xEvent = {
    type: "twitter_update",
    project: xTarget,
    tweet: {
      id: "2095000000000000000",
      handle: "pondotfun",
      xUserId: "2094048312772993024",
      authorId: "2094048312772993024",
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
      url: "https://x.com/pondotfun/status/2095000000000000000",
      createdAt: "2026-09-02T04:00:00.000Z",
      text: `$PONFUN is live\nhttps://robinhoodchain.blockscout.com/address/${coin}`,
    },
    signal: {
      relevant: true,
      strong: true,
      labels: ["pon.fun 平台币重大事件"],
      ponFunOfficial: true,
      ponKind: "platform_token_update",
      ponStage: "platform_token_live",
      ponAsset: "PONFUN",
      ponPriority: "T1",
      tokenAddress: coin,
      majorProductUpdate: true,
      platformStructural: true,
      reason: "official_platform_token_launch_with_exact_ca",
    },
    observedAt: "2026-09-02T04:00:01.000Z",
  };
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, xTarget), true, "the exact target can be scheduled");
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, xEvent), true, "numeric ID plus oEmbed can publish");
  const ownershipStarted = structuredClone(xEvent);
  ownershipStarted.signal = {
    ...ownershipStarted.signal,
    ponKind: "ownership_transfer_started",
    ponStage: "ownership_transfer_started",
    labels: ["pon.fun 重大结构更新"],
    reason: "official_factory_config_or_major_product_change",
  };
  ownershipStarted.tweet.text = "Factory ownership transfer initiated and pending to 0x1111111111111111111111111111111111111111";
  delete ownershipStarted.signal.tokenAddress;
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, ownershipStarted), true, "a pending owner is not mislabeled as a completed transfer");

  const delayedX = structuredClone(xEvent);
  delayedX.tweet.createdAt = "2026-09-02T03:40:00.000Z";
  delayedX.observedAt = "2026-09-02T04:00:01.000Z";
  delayedX.delayedRecovery = {
    version: 1,
    reason: "monitoring_gap_recovery",
    gapSince: "2026-09-02T03:45:00.000Z",
    sourceOccurredAt: delayedX.tweet.createdAt,
    recoveredAt: delayedX.observedAt,
    lagMs: 20 * 60_000 + 1_000,
    cursor: {
      latestIdAtRecovery: "2094999999999999999",
      tweetId: delayedX.tweet.id,
    },
  };
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, delayedX), true, "an exact old T1 post can use the bounded delayed-recovery schema");
  const delayedMarket = structuredClone(delayedX);
  delayedMarket.tweet.text = `A new market is live: ${coin}`;
  delayedMarket.signal = {
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
  };
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, delayedMarket), false, "ordinary markets cannot borrow delayed-recovery freshness");

  const delayedChain = structuredClone(pauseEvent);
  delayedChain.title = "pon.fun 延迟恢复摘要：pon.fun Factory 已暂停";
  delayedChain.summary = "A still-relevant structural change was recovered after a monitoring gap; the original finalized proof and change are preserved.";
  delayedChain.originalEventKey = `pon-fun:factory_paused:4663:${tx.toLowerCase()}:7`;
  delayedChain.eventKey = `${delayedChain.originalEventKey}:delayed-recovery:v1`;
  delayedChain.blockTimestamp = "2026-09-02T01:00:00.000Z";
  delayedChain.observedAt = "2026-09-02T04:00:01.000Z";
  delayedChain.delayedRecovery = {
    version: 1,
    reason: "monitoring_gap_recovery",
    gapSince: "2026-09-02T01:15:00.000Z",
    sourceOccurredAt: delayedChain.blockTimestamp,
    recoveredAt: delayedChain.observedAt,
    lagMs: 3 * 60 * 60_000 + 1_000,
    cursor: { nextBlockAtRecovery: 52_000_100, eventBlock: delayedChain.blockNumber },
  };
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, delayedChain), true, "a proven chain control event can publish one bounded recovery summary");
  const delayedCreated = structuredClone(delayedChain);
  delayedCreated.kind = "market_created";
  delayedCreated.evidence.topic0 = "0x8ada27e0afa58f4d4be8c4edbf4bfd49d9d586ce8a714938b12f51b7855893bb";
  delayedCreated.originalEventKey = `pon-fun:market_created:4663:${tx.toLowerCase()}:7`;
  delayedCreated.eventKey = `${delayedCreated.originalEventKey}:delayed-recovery:v1`;
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, delayedCreated), false, "ordinary MarketCreated never enters delayed recovery");
  for (const [label, mutate] of [
    ["wrong numeric ID", (candidate) => { candidate.tweet.authorId = "2094048312772993025"; }],
    ["lookalike handle", (candidate) => { candidate.tweet.handle = "pondotfun_"; }],
    ["lookalike URL", (candidate) => { candidate.tweet.url = `https://x.com/pondotfun_/status/${candidate.tweet.id}`; }],
    ["different status ID with the same prefix", (candidate) => { candidate.tweet.url += "1"; }],
    ["missing oEmbed", (candidate) => { delete candidate.tweet.sourceVerifiedBy; }],
    ["missing exact numeric verifier", (candidate) => { delete candidate.tweet.identityVerifiedBy; }],
    ["missing complete text", (candidate) => { delete candidate.tweet.text; }],
    ["signal not reproducible from text", (candidate) => { candidate.signal.ponStage = "paused"; candidate.signal.ponKind = "factory_paused"; }],
    ["missing source timestamp", (candidate) => { delete candidate.tweet.createdAt; }],
    ["missing observation timestamp", (candidate) => { delete candidate.observedAt; }],
    ["numeric rather than string tweet ID", (candidate) => { candidate.tweet.id = 209500; candidate.tweet.url = "https://x.com/pondotfun/status/209500"; }],
    ["coercible numeric author identity", (candidate) => { candidate.tweet.authorId = 2094048312772993024n; }],
  ]) {
    const candidate = structuredClone(xEvent);
    mutate(candidate);
    assert.equal(isMonitoringSourceEnabled(ponFocusConfig, candidate), false, label);
  }

  for (const [label, mutate] of [
    ["string lag", (candidate) => { candidate.delayedRecovery.lagMs = String(candidate.delayedRecovery.lagMs); }],
    ["string cursor ID", (candidate) => { candidate.delayedRecovery.cursor.latestIdAtRecovery = 2094999999999999999n; }],
    ["recovery older than seven days", (candidate) => {
      candidate.tweet.createdAt = "2026-08-24T04:00:00.000Z";
      candidate.delayedRecovery.sourceOccurredAt = candidate.tweet.createdAt;
      candidate.delayedRecovery.lagMs = Date.parse(candidate.observedAt) - Date.parse(candidate.tweet.createdAt);
    }],
  ]) {
    const candidate = structuredClone(delayedX);
    mutate(candidate);
    assert.equal(isMonitoringSourceEnabled(ponFocusConfig, candidate), false, label);
  }

  for (const [label, mutate] of [
    ["string lag", (candidate) => { candidate.delayedRecovery.lagMs = String(candidate.delayedRecovery.lagMs); }],
    ["string recovery cursor", (candidate) => { candidate.delayedRecovery.cursor.nextBlockAtRecovery = "52000100"; }],
    ["extra recovery field", (candidate) => { candidate.delayedRecovery.untrusted = true; }],
  ]) {
    const candidate = structuredClone(delayedChain);
    mutate(candidate);
    assert.equal(isMonitoringSourceEnabled(ponFocusConfig, candidate), false, label);
  }

  assert.equal(isPonFunSource({ type: "token_launch", tokenSymbol: "PON", title: "ordinary RWA stock token" }), false);
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, { type: "token_launch", tokenSymbol: "PON", title: "ordinary RWA stock token" }), false);
  assert.equal(isMonitoringSourceEnabled(ponFocusConfig, { id: "pons", website: "https://ponsfamily.com" }), false, "legacy Pons stays independently disabled");
});
