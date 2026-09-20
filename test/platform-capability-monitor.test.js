import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PLATFORM_CAPABILITY_TARGETS,
  atomicWriteJson,
  contractDiscoveryChainId,
  crawlSitemap,
  diffCapabilities,
  extractChainCapabilities,
  extractFlapMarketCapabilities,
  extractFourMemeConfigCapabilities,
  extractFourMemeLiveCapabilities,
  extractNpmPackageCapabilities,
  extractPlatformCapabilities,
  fetchPlatformSource,
  isExcludedFlapQuoteAsset,
  orderedFlapQuoteMetadataRpcUrls,
  resolveFlapQuoteAssetMetadataAcrossRpcUrls,
  createPlatformCapabilityMonitor,
  runPlatformCapabilityCheck,
} from "../src/platform-capability-monitor.js";
import { focusNoveltyKeys, sendAlerts } from "../src/alerts.js";
import { buildBilingualAlertBundle, renderBilingualTelegramText } from "../src/bilingual-alert-renderer.js";
import { withTradingPriority } from "../src/trading-priority.js";

const response = (body, { ok = true, status = 200, url = "https://test.invalid", headers = {} } = {}) => {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok,
    status,
    url,
    headers: { get: (name) => normalizedHeaders.get(String(name).toLowerCase()) || null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
};

const quietLogger = { error() {} };
const capabilities = (overrides = {}) => ({
  quoteTokens: [],
  quoteConfigs: [],
  flapPools: [],
  contracts: [],
  versions: [],
  modules: [],
  chains: [],
  pages: [],
  pageMetadata: [],
  announcements: [],
  campaigns: [],
  packages: [],
  sourceFingerprints: [],
  ...overrides,
});

test("contract discovery routing normalizes numeric chain identity for a strict BSC gate", () => {
  assert.equal(contractDiscoveryChainId({ chainId: 56 }), 56);
  assert.equal(contractDiscoveryChainId({ chainId: "2818" }), 2818);
  assert.equal(contractDiscoveryChainId({}), null);
  assert.equal(contractDiscoveryChainId({ chainId: "bsc" }), null);
});

test("uses browser-compatible headers for public launchpad capability pages", async () => {
  let request;
  await fetchPlatformSource(
    { id: "fourmeme", pagePattern: /$a/ },
    { kind: "live", url: "https://four.meme/en", key: "live:https://four.meme/en" },
    async (url, options) => {
      request = { url, options };
      return response("<main>Four.Meme</main>", { url });
    },
  );
  assert.equal(request.options.headers["accept-language"], "en-US,en;q=0.9");
  assert.match(request.options.headers["user-agent"], /Mozilla\/5\.0/);
});

test("extracts quote tokens, deployments, versions and platform modules", () => {
  const text = "Multi-Token Trading supports $BNB, $USDT and $USD1. Portal 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0 v5.8.6 VaultFactoryBaseV2 https://docs.test/product-update/7";
  const result = extractPlatformCapabilities(text, /product-update/);
  assert.deepEqual(result.quoteTokens, ["BNB", "USD1", "USDT"]);
  assert.equal(result.contracts[0], "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0");
  assert.ok(result.versions.includes("v5.8.6"));
  assert.ok(result.modules.includes("Vault V2"));
  assert.equal(result.pages.length, 1);
});

test("recognizes Flap Vault V3 ERC20 quote support without treating image hardening as a new module", () => {
  const docs = `VaultBaseV3 — ERC20 quote token support. A quote-agnostic vault exposes
    vaultQuoteToken() and isQuoteTokenSupported(). Factory factorySpecVersion v2.3.`;
  const result = extractPlatformCapabilities(docs, /$a/);
  assert.deepEqual(result.modules, ["Vault V3（ERC20 报价资产）"]);

  const imageFix = extractPlatformCapabilities(
    "fix: validate remote image URL and add regression tests for img src security",
    /$a/,
  );
  assert.deepEqual(imageFix.modules, []);
});

test("generic capability pages reject ordinary token contract addresses", () => {
  const token = "0x1111111111111111111111111111111111111111";
  const factory = "0x2222222222222222222222222222222222222222";
  const result = extractPlatformCapabilities(`New token CA ${token}. Vault Factory ${factory}`, /$a/);
  assert.deepEqual(result.contracts, [factory]);
});

test("extracts explicit chain support, testnet deployments and unfamiliar chainId configs", () => {
  const result = extractChainCapabilities(`
    Flap platform supports BNB Chain mainnet (chainId: 56).
    Flap contracts are deployed on Base Sepolia testnet (chainId: 84532).
    {"networkName":"MegaETH","chainId":4326,"rpcUrl":"https://rpc.megaeth.example"}
  `);
  assert.deepEqual(result.map(({ name, chainId, environment, stage }) => ({ name, chainId, environment, stage })), [
    { name: "Base", chainId: 84532, environment: "testnet", stage: "deployed" },
    { name: "BNB Chain", chainId: 56, environment: "mainnet", stage: "supported" },
    { name: "MegaETH", chainId: 4326, environment: "unknown", stage: "configured" },
  ]);
});

test("chain extraction rejects icons, ordering, token cards and future-only copy", () => {
  const text = `
    Add a Base icon, update the Solana logo, and alphabetically reorder BSC and Ethereum assets.
    Base support is coming soon on the roadmap.
    {"tokenAddress":"0x1111111111111111111111111111111111111111","symbol":"CARD","chainId":8453,"marketCap":12}
  `;
  assert.deepEqual(extractChainCapabilities(text), []);
});

test("chain capability diff is order-independent and distinguishes a real deployment stage", () => {
  const baseSupported = { name: "Base", chainId: 8453, environment: "mainnet", stage: "supported", evidence: "supported_network" };
  const bnbSupported = { name: "BNB Chain", chainId: 56, environment: "mainnet", stage: "supported", evidence: "supported_network" };
  const reordered = diffCapabilities(
    capabilities({ chains: [bnbSupported, baseSupported] }),
    capabilities({ chains: [baseSupported, bnbSupported] }),
  );
  assert.deepEqual(reordered.newChains, []);
  assert.deepEqual(reordered.removedChains, []);

  const baseDeployed = { ...baseSupported, stage: "deployed", evidence: "mainnet_deployment" };
  const deployed = diffCapabilities(capabilities({ chains: [baseSupported] }), capabilities({ chains: [baseDeployed] }));
  assert.deepEqual(deployed.newChains, []);
  assert.deepEqual(deployed.removedChains, []);
  assert.deepEqual(deployed.chainStageChanges.map(({ name, fromStage, toStage, direction }) => ({ name, fromStage, toStage, direction })), [{
    name: "Base",
    fromStage: "supported",
    toStage: "deployed",
    direction: "upgrade",
  }]);
  assert.equal(deployed.chainStageChanges[0].before.stage, "supported");
  assert.equal(deployed.chainStageChanges[0].after.stage, "deployed");
});

test("structured config and package updates retain exact before and after values", () => {
  const quoteBefore = {
    symbol: "USD1",
    address: "0x1111111111111111111111111111111111111111",
    fees: { buyFee: "0.01", sellFee: "0.01" },
    source: { kind: "api", url: "https://test.invalid/config" },
  };
  const quoteAfter = {
    ...quoteBefore,
    fees: { buyFee: "0.005", sellFee: "0.01" },
  };
  const packageBefore = {
    name: "@four-meme/four-meme-ai",
    version: "1.0.8",
    source: { kind: "package", url: "https://test.invalid/package" },
  };
  const packageAfter = { ...packageBefore, version: "1.1.0" };
  const changes = diffCapabilities(
    capabilities({ quoteConfigs: [quoteBefore], packages: [packageBefore] }),
    capabilities({ quoteConfigs: [quoteAfter], packages: [packageAfter] }),
  );

  assert.deepEqual(changes.updatedQuoteConfigs, [quoteAfter], "legacy consumers still receive the current config");
  assert.deepEqual(changes.quoteConfigChanges, [{ symbol: "USD1", before: quoteBefore, after: quoteAfter }]);
  assert.deepEqual(changes.updatedPackages, [packageAfter], "legacy consumers still receive the current package");
  assert.deepEqual(changes.packageVersionChanges, [{
    name: "@four-meme/four-meme-ai",
    fromVersion: "1.0.8",
    toVersion: "1.1.0",
    before: packageBefore,
    after: packageAfter,
  }]);
});

test("detects additions, removals and re-additions without an additive merge", () => {
  const first = capabilities({ quoteTokens: ["BNB", "USD1"] });
  const removed = capabilities({ quoteTokens: ["BNB"] });
  const removal = diffCapabilities(first, removed);
  assert.deepEqual(removal.removedQuoteTokens, ["USD1"]);
  assert.deepEqual(removal.newQuoteTokens, []);
  const readded = diffCapabilities(removed, first);
  assert.deepEqual(readded.newQuoteTokens, ["USD1"]);
  assert.deepEqual(readded.removedQuoteTokens, []);
});

test("Flap board ignores rotating token cards while preserving stable vault categories", () => {
  const html = 'src="/payment-token-catalog/aaplb.svg" src="/spyb.svg" vaultFactoryCategory:[\\"index\\",\\"nft\\"]';
  const result = extractFlapMarketCapabilities(html);
  assert.deepEqual(result.quoteTokens, []);
  assert.deepEqual(result.modules, ["Vault INDEX", "Vault NFT"]);
});

test("Flap board extracts only structured factory/category and quote-address pool identities", () => {
  const ordinaryToken = "0x1111111111111111111111111111111111111111";
  const factory = "0x2222222222222222222222222222222222222222";
  const quote = "0x3333333333333333333333333333333333333333";
  const payload = JSON.stringify({
    initialBoard: {
      category: "trending",
      items: [
        { coin: { address: ordinaryToken, symbol: "TREND" }, listed: true, quoteToken: quote },
        {
          coin: { address: "0x4444444444444444444444444444444444444444", symbol: "VAULT" },
          vault: { vaultFactory: factory, vaultFactoryCategory: ["staking"] },
        },
      ],
    },
  });
  const result = extractFlapMarketCapabilities(payload);

  assert.deepEqual(result.modules, ["Vault STAKING"]);
  assert.deepEqual(result.flapPools, [
    {
      identity: `quote:${quote}`,
      kind: "quote_asset",
      category: null,
      vaultFactory: null,
      quoteAddress: quote,
      quoteSymbol: null,
      sourceUrl: "https://flap.sh/board",
    },
    {
      identity: `vault:STAKING:${factory}`,
      kind: "vault_factory",
      category: "STAKING",
      vaultFactory: factory,
      quoteAddress: null,
      quoteSymbol: null,
      sourceUrl: "https://flap.sh/board",
    },
  ]);
  assert.equal(JSON.stringify(result).includes(ordinaryToken), false, "a rotating coin address is not a platform pool");
});

test("Flap Morph board keeps chain-scoped pool identity and provenance", () => {
  const quote = "0x3333333333333333333333333333333333333333";
  const result = extractFlapMarketCapabilities(
    JSON.stringify({ initialBoard: { quoteToken: quote } }),
    "https://flap.sh/morph/board",
    2818,
  );
  assert.deepEqual(result.flapPools, [{
    identity: `chain-2818:quote:${quote}`,
    kind: "quote_asset",
    category: null,
    vaultFactory: null,
    quoteAddress: quote,
    quoteSymbol: null,
    sourceUrl: "https://flap.sh/morph/board",
    chainId: 2818,
  }]);
});

test("Flap quote metadata identifies tokenized stocks without classifying ordinary quote assets", () => {
  const stockAddress = "0x3f53de71c126bdabae20f9cd64848d317f6c3238";
  const result = extractFlapMarketCapabilities(JSON.stringify({
    initialBoard: {
      items: [{
        quoteToken: stockAddress,
        quoteTokenInfo: {
          address: stockAddress,
          symbol: "GOOGLB",
          name: "Alphabet Class A Tokenized Stock (bStock)",
          assetClass: "RWA stock",
        },
      }],
    },
  }));
  const pool = result.flapPools[0];
  assert.equal(pool.quoteAddress, stockAddress);
  assert.equal(pool.quoteSymbol, "GOOGLB");
  assert.equal(pool.quoteName, "Alphabet Class A Tokenized Stock (bStock)");
  assert.equal(isExcludedFlapQuoteAsset(pool), true);
  assert.equal(isExcludedFlapQuoteAsset({
    quoteAddress: "0x1111111111111111111111111111111111111111",
    quoteSymbol: "USDX",
    quoteName: "USD experimental quote token",
  }), false);
});

test("Flap keeps generic stock modules out of capability alerts", () => {
  const factory = "0x1111111111111111111111111111111111111111";
  const result = extractFlapMarketCapabilities(JSON.stringify({
    initialBoard: {
      items: [{ vault: { vaultFactory: factory, vaultFactoryCategory: ["stock", "rwa_stock", "index"] } }],
    },
  }));
  assert.deepEqual(result.modules, ["Vault INDEX"]);
});

test("Flap quote metadata resolver deduplicates RPCs, validates evidence, and falls back in order", async () => {
  const primary = "https://primary.invalid";
  const fallback = "https://fallback.invalid";
  const rpcUrls = orderedFlapQuoteMetadataRpcUrls(primary, [primary, fallback, " "]);
  assert.deepEqual(rpcUrls, [primary, fallback]);
  const providerRequests = [];
  const providers = new Map(rpcUrls.map((url) => [url, {
    id: url,
    send: async (method) => {
      assert.equal(method, "eth_chainId");
      return "0x38";
    },
    getCode: async () => "0x6000",
  }]));
  const metadata = await resolveFlapQuoteAssetMetadataAcrossRpcUrls({
    address: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf",
    chainId: 56,
    rpcUrls,
    providerForUrl: (url) => {
      providerRequests.push(url);
      return providers.get(url);
    },
    readMetadata: async (provider) => provider.id === primary
      ? null
      : { name: "Semicon Bull 3X ETF", symbol: "SOXLB", decimals: 18 },
    attemptTimeoutMs: 100,
    totalTimeoutMs: 500,
  });
  assert.deepEqual(providerRequests, [primary, fallback]);
  assert.deepEqual(metadata, { name: "Semicon Bull 3X ETF", symbol: "SOXLB", decimals: 18 });

  await assert.rejects(
    resolveFlapQuoteAssetMetadataAcrossRpcUrls({
      address: "0xe28cd11c99af2df76bb8ada4cd0ef3904378280f",
      chainId: 56,
      rpcUrls: [primary],
      providerForUrl: () => providers.get(primary),
      readMetadata: async () => null,
      attemptTimeoutMs: 100,
      totalTimeoutMs: 100,
    }),
    (error) => error.code === "FLAP_QUOTE_METADATA_UNAVAILABLE"
      && error.details?.attemptedEndpoints === 1
      && error.details?.failures?.[0]?.message === "quote token name is unavailable or invalid",
  );
});

test("Flap BSC SOX quotes hold raw discoveries and emit one readable Board observation after metadata recovery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-sox-metadata-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 4,
    marketSources: [{ url: board, chainId: 56 }],
    pagePattern: /$a/,
  };
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const soxlb = "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf";
  const soxsb = "0xe28cd11c99af2df76bb8ada4cd0ef3904378280f";
  const names = new Map([
    [soxlb, { name: "Semicon Bull 3X ETF", symbol: "SOXLB", decimals: 18 }],
    [soxsb, { name: "Direxion Semiconductor Bear 3X ETF", symbol: "SOXSB", decimals: 18 }],
  ]);
  let current = Date.parse("2026-09-02T12:00:00.000Z");
  let newQuotes = [];
  const metadataAttempts = new Map();
  const alerts = [];
  const activations = [];
  const check = async () => {
    const checked = await runPlatformCapabilityCheck({ dataDir }, {
      targets: [target],
      fetchImpl: async (url) => response(JSON.stringify({
        initialBoard: {
          items: [
            { quoteToken: { address: oldQuote, name: "Existing quote", symbol: "OLD" } },
            ...newQuotes.map((quoteToken) => ({ quoteToken })),
          ],
        },
      }), { url }),
      resolveFlapQuoteAssetMetadata: async ({ address, chainId }) => {
        assert.equal(chainId, 56);
        const attempts = Number(metadataAttempts.get(address) || 0) + 1;
        metadataAttempts.set(address, attempts);
        if (attempts === 1) throw Object.assign(new Error("all metadata RPCs timed out"), {
          code: "FLAP_QUOTE_METADATA_UNAVAILABLE",
        });
        return names.get(address);
      },
      sendAlertsImpl: async (_config, event) => {
        alerts.push(event);
        return { status: "delivered", eventId: event.eventKey };
      },
      onFlapFeatureActivation: async (records) => activations.push(...records),
      logger: quietLogger,
      now: () => new Date(current),
    });
    current += 1_500;
    return checked;
  };

  await check();
  newQuotes = [soxlb, soxsb];
  const firstObservedAt = new Date(current).toISOString();
  await check();
  await check();
  assert.equal(alerts.length, 0, "an address without name+symbol must remain a durable pending intent");
  assert.equal(activations.length, 0, "known stock/ETF quote addresses must never start first-token activation");
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(Object.keys(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending).sort(), [
    `chain-56:quote:${soxlb}`,
    `chain-56:quote:${soxsb}`,
  ]);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending[`chain-56:quote:${soxlb}`].firstObservedAt, firstObservedAt);

  await check();
  assert.equal(alerts.length, 2);
  assert.equal(alerts.every(({ kind }) => kind === "flap_quote_asset_board_observed"), true);
  assert.equal(alerts.every(({ changeType }) => changeType === "observed"), true);
  assert.equal(alerts.every(({ sourceOccurredAt }) => sourceOccurredAt === firstObservedAt), true);
  assert.equal(alerts.every(({ observedAt }) => observedAt === new Date(Date.parse(firstObservedAt) + 3_000).toISOString()), true);
  assert.equal(alerts.every(({ signal }) => signal.quotePairChange.stage === "observed"), true);
  assert.deepEqual(alerts.flatMap(({ changes }) => changes.newFlapPools.map(({ quoteSymbol }) => quoteSymbol)).sort(), ["SOXLB", "SOXSB"]);
  assert.equal(alerts.every(({ changes }) => changes.updatedFlapPools.length === 0), true);
  assert.equal(alerts.every(({ changes }) => changes.flapPoolChanges.length === 0), true);
  assert.equal(new Set(alerts.map(({ eventKey }) => eventKey)).size, 2, "each pending identity owns one stable delivery key");
  assert.equal(activations.length, 0, "metadata backfill must remain notification-only for stock/ETF quotes");
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(state.flap.capabilities.flapPools
    .filter(({ quoteAddress }) => names.has(quoteAddress))
    .map(({ quoteSymbol }) => quoteSymbol).sort(), ["SOXLB", "SOXSB"]);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataRetries, undefined);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);

  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(alerts.length, 2);
  assert.equal(metadataAttempts.get(soxlb), 2);
  assert.equal(metadataAttempts.get(soxsb), 2);
  assert.equal(state.flap.capabilities.flapPools.find(({ quoteAddress }) => quoteAddress === soxlb).quoteName, "Semicon Bull 3X ETF");
});

test("Flap rollout legacy null metadata is repaired silently without an enabled-now event", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-legacy-metadata-repair-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const soxlb = "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 4,
    marketSources: [{ url: board, chainId: 56 }],
    pagePattern: /$a/,
  };
  let current = Date.parse("2026-09-03T06:00:00.000Z");
  let metadataReads = 0;
  const alerts = [];
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { quoteToken: soxlb } }), { url }),
    resolveFlapQuoteAssetMetadata: async () => {
      metadataReads += 1;
      return { name: "Semicon Bull 3X ETF", symbol: "SOXLB", decimals: 18 };
    },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
    logger: quietLogger,
    now: () => new Date(current),
  }).finally(() => { current += 1_500; });

  await check();
  assert.equal(metadataReads, 0, "the first deployment observation is a quiet legacy baseline");
  await check();
  assert.equal(metadataReads, 1);
  assert.equal(alerts.length, 0, "legacy null -> metadata must never be announced as a current activation");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.capabilities.flapPools[0].quoteSymbol, "SOXLB");
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataRetries, undefined);
});

test("Flap repairs metadata-only changes on an existing complete quote without a first-observed alert or activation", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-existing-metadata-repair-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const quote = "0x1212121212121212121212121212121212121212";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 4, marketSources: [{ url: board, chainId: 56 }], pagePattern: /$a/ };
  let metadata = { address: quote, name: "Original Quote", symbol: "ORIG" };
  const alerts = [];
  const activations = [];
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: [{ quoteToken: metadata }] } }), { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(structuredClone(event)),
    onFlapFeatureActivation: async (records) => activations.push(...records),
    logger: quietLogger,
    now: () => new Date("2026-09-03T07:30:00.000Z"),
  });

  await check();
  metadata = { address: quote, name: "Corrected Quote", symbol: "Brk.B", assetClass: "quote asset" };
  await check();
  await check();

  assert.equal(alerts.length, 0, "metadata corrections never claim the Board first confirmed an existing identity");
  assert.equal(activations.length, 0, "metadata-only repairs never activate downstream trading correlation");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const pool = state.flap.capabilities.flapPools.find(({ quoteAddress }) => quoteAddress === quote);
  assert.equal(pool.quoteName, "Corrected Quote");
  assert.equal(pool.quoteSymbol, "Brk.B");
});

test("Flap partial metadata accumulates exponential backoff and a non-due restart does not call or log", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-partial-metadata-backoff-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const quote = "0x924f000000000000000000000000000000004444";
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 4, marketSources: [{ url: board, chainId: 56 }], pagePattern: /$a/ };
  let current = Date.parse("2026-09-03T07:00:00.000Z");
  let quotes = [oldQuote];
  let reads = 0;
  const errors = [];
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: quotes.map((address) => ({
      quoteToken: address === oldQuote ? { address, name: "Old", symbol: "OLD" } : address,
    })) } }), { url }),
    resolveFlapQuoteAssetMetadata: async () => {
      reads += 1;
      return { name: "Partial only" };
    },
    sendAlertsImpl: async (_config, event) => {
      throw new Error(`unexpected alert ${event.eventKey}`);
    },
    logger: { error: (message) => errors.push(message) },
    now: () => new Date(current),
  });

  await check();
  current += 1_500;
  quotes = [oldQuote, quote];
  await check();
  current += 1_500;
  await check();
  current += 1_500;
  assert.equal(reads, 1);
  await check();
  current += 1_500;
  assert.equal(reads, 2);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const identity = `chain-56:quote:${quote}`;
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataRetries[identity].attempts, 2);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataRetries[identity].nextAttemptAt, "2026-09-03T07:00:19.500Z");
  const logged = errors.length;

  // A new process reads the durable retry deadline. It must not turn a partial
  // response into attempts=1 again or hammer the RPC/log while not due.
  await check();
  assert.equal(reads, 2);
  assert.equal(errors.length, logged);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataRetries[identity].attempts, 2);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending[identity].status, "pending_metadata");
});

test("Flap pending metadata keeps one stable event through queued and policy-suppressed restarts until delivered", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-metadata-delivery-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const quote = "0x3333333333333333333333333333333333333333";
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 4, marketSources: [{ url: board, chainId: 56 }], pagePattern: /$a/ };
  let current = Date.parse("2026-09-03T08:00:00.000Z");
  let quotes = [oldQuote];
  let metadataReads = 0;
  const events = [];
  const deliveries = [
    { status: "queued", eventId: "queued-owner" },
    { status: "suppressed", reason: "policy_suppressed", persisted: true, eventId: "queued-owner" },
    { status: "delivered", eventId: "queued-owner" },
  ];
  const activations = [];
  const check = async () => {
    const result = await runPlatformCapabilityCheck({ dataDir }, {
      targets: [target],
      fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: quotes.map((address) => ({
        quoteToken: address === oldQuote ? { address, name: "Old", symbol: "OLD" } : address,
      })) } }), { url }),
      resolveFlapQuoteAssetMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) throw new Error("temporary metadata outage");
        return { name: "Readable quote", symbol: "Brk.B", decimals: 18 };
      },
      sendAlertsImpl: async (_config, event) => {
        events.push(structuredClone(event));
        return deliveries.shift();
      },
      onFlapFeatureActivation: async (records) => activations.push(...records),
      logger: quietLogger,
      now: () => new Date(current),
    });
    current += 1_500;
    return result;
  };

  await check();
  quotes = [oldQuote, quote];
  const firstObservedAt = new Date(current).toISOString();
  await check();
  await check();
  assert.equal(events.length, 0);
  await check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const identity = `chain-56:quote:${quote}`;
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending[identity].firstObservedAt, firstObservedAt);
  assert.equal(activations.length, 0, "a queued user notification must not activate downstream work twice");

  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.ok(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending[identity]);
  assert.equal(activations.length, 0, "terminal policy suppression is not a committed user notification");

  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);
  assert.equal(activations.length, 0, "Board metadata delivery is notification-only and cannot arm quote tracking");
  assert.equal(metadataReads, 2, "complete durable metadata is reused across delivery restarts");
  assert.equal(new Set(events.map(({ eventKey }) => eventKey)).size, 1);
  assert.equal(new Set(events.map(({ sourceOccurredAt }) => sourceOccurredAt)).size, 1);
  assert.equal(events[0].sourceOccurredAt, firstObservedAt);
  assert.equal(events.every(({ kind }) => kind === "flap_quote_asset_board_observed"), true);
  assert.equal(events.every((event) => event.changes.newFlapPools[0].quoteSymbol === "Brk.B"), true,
    "the producer preserves the resolver's valid mixed-case ticker");
  const rendered = renderBilingualTelegramText(await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    withTradingPriority(events[0], { nowMs: Date.parse(events[0].observedAt) }),
    "Flap Board quote observation",
  ), false);
  assert.match(rendered, /Brk\.B/u);
  assert.doesNotMatch(rendered, /BRK\.B/u, "the rendered evidence preserves the producer ticker byte-for-byte");

  await check();
  assert.equal(events.length, 3, "delivered pending intent must not be regenerated");
});

test("Flap pending metadata uses one stable event key per quote when assets resolve in different rounds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-metadata-identity-events-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const quoteA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const quoteB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 4, marketSources: [{ url: board, chainId: 56 }], pagePattern: /$a/ };
  let current = Date.parse("2026-09-03T08:30:00.000Z");
  let quotes = [oldQuote];
  const metadataCalls = new Map();
  const events = [];
  const activations = [];
  const check = async () => {
    const result = await runPlatformCapabilityCheck({ dataDir }, {
      targets: [target],
      fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: quotes.map((address) => ({
        quoteToken: address === oldQuote ? { address, name: "Old", symbol: "OLD" } : address,
      })) } }), { url }),
      resolveFlapQuoteAssetMetadata: async ({ address }) => {
        const calls = Number(metadataCalls.get(address) || 0) + 1;
        metadataCalls.set(address, calls);
        if (address === quoteB && calls === 1) throw new Error("quote B metadata delayed one round");
        return address === quoteA
          ? { name: "Quote A", symbol: "QA", decimals: 18 }
          : { name: "Quote B", symbol: "QB", decimals: 18 };
      },
      sendAlertsImpl: async (_config, event) => {
        events.push(structuredClone(event));
        const symbol = event.changes.newFlapPools[0].quoteSymbol;
        const attempts = events.filter((item) => item.changes.newFlapPools[0].quoteSymbol === symbol).length;
        return symbol === "QA" && attempts === 1
          ? { status: "queued", eventId: event.eventKey }
          : { status: "delivered", eventId: event.eventKey };
      },
      onFlapFeatureActivation: async (records) => activations.push(...records),
      logger: quietLogger,
      now: () => new Date(current),
    });
    current += 1_500;
    return result;
  };

  await check();
  quotes = [oldQuote, quoteA, quoteB];
  await check();
  await check();
  assert.deepEqual(events.map((event) => event.changes.newFlapPools[0].quoteSymbol), ["QA"]);

  await check();
  assert.deepEqual(events.map((event) => event.changes.newFlapPools[0].quoteSymbol), ["QA", "QA", "QB"]);
  const aKeys = events.filter((event) => event.changes.newFlapPools[0].quoteSymbol === "QA").map(({ eventKey }) => eventKey);
  const bKeys = events.filter((event) => event.changes.newFlapPools[0].quoteSymbol === "QB").map(({ eventKey }) => eventKey);
  assert.equal(new Set(aKeys).size, 1, "quote A keeps its event key when quote B joins the next round");
  assert.equal(new Set(bKeys).size, 1);
  assert.notEqual(aKeys[0], bKeys[0]);
  assert.equal(events.every((event) => event.changes.newFlapPools.length === 1), true);
  assert.deepEqual(activations, [], "Board quote identities never arm direct lifecycle tracking");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);

  await check();
  assert.equal(events.length, 3, "delivered identity events are not regenerated");
  assert.deepEqual(activations, []);
});

test("Flap metadata pending crosses the real source gate, outbox, renderer, and fake Telegram exactly once after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-metadata-real-delivery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const soxsb = "0xe28cd11c99af2df76bb8ada4cd0ef3904378280f";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 4,
    marketSources: [{ url: board, chainId: 56 }],
    pagePattern: /$a/,
  };
  let current = Date.parse("2026-09-03T09:00:00.000Z");
  let quotes = [oldQuote];
  let metadataReads = 0;
  const producerEvents = [];
  const telegramPayloads = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\/bottest-token\/sendMessage$/);
    telegramPayloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 5581 } }),
    };
  });
  t.mock.method(console, "info", () => {});
  const config = {
    dataDir,
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    telegramToken: "test-token",
    telegramChatId: "-1001",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertNow: () => current,
  };
  const check = async () => {
    const result = await runPlatformCapabilityCheck(config, {
      targets: [target],
      fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: quotes.map((address) => ({
        quoteToken: address === oldQuote ? { address, name: "Old Quote", symbol: "OLD" } : address,
      })) } }), { url }),
      resolveFlapQuoteAssetMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) throw new Error("temporary RPC outage");
        return { name: "Direxion Semiconductor Bear 3X ETF", symbol: "SOXSB", decimals: 18 };
      },
      sendAlertsImpl: async (sendConfig, event) => {
        producerEvents.push(structuredClone(event));
        return sendAlerts(sendConfig, event);
      },
      onFlapFeatureActivation: async () => assert.fail("bStock Board observations must never activate auto correlation"),
      logger: quietLogger,
      now: () => new Date(current),
    });
    current += 1_500;
    return result;
  };

  await check();
  quotes = [oldQuote, soxsb];
  const firstObservedAt = new Date(current).toISOString();
  await check();
  await check();
  assert.equal(telegramPayloads.length, 0);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending[`chain-56:quote:${soxsb}`].firstObservedAt, firstObservedAt);

  // This call represents a fresh process: all producer and outbox ownership is
  // recovered from disk, then complete metadata is admitted through the real
  // source gate and delivered by the actual alert pipeline.
  current += 3 * 60 * 60_000;
  await check();
  assert.equal(producerEvents.length, 1);
  assert.equal(telegramPayloads.length, 1);
  assert.equal(producerEvents[0].sourceOccurredAt, firstObservedAt);
  assert.equal(producerEvents[0].kind, "flap_quote_asset_board_observed");
  assert.match(telegramPayloads[0].text, /^🆕 新底池 \| NEW POOL/u);
  assert.match(telegramPayloads[0].text, /项目：Flap[^\n]*SOXSB[^\n]*新报价底池/u);
  assert.match(telegramPayloads[0].text, /Project: Flap[^\n]*SOXSB[^\n]*new quote pool/i);
  assert.match(telegramPayloads[0].text, /事件：Flap Board 新增报价资产/u);
  assert.doesNotMatch(telegramPayloads[0].text, /风险|Risk|勿追价|do not chase|非自动交易|no automatic trading/iu);
  assert.doesNotMatch(telegramPayloads[0].text, /quote pools enabled|报价底池已启用/i);

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entries = Object.values(outbox.events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, producerEvents[0].eventKey);
  assert.equal(entries[0].status, "delivered");
  assert.equal(entries[0].deliveryDisposition.reason, "flap_board_quote_observed");
  assert.equal(entries[0].event.tradingPriority.tier, "T2");
  assert.deepEqual(entries[0].event.canonicalSignalIds, [
    `flap:quote-pair:soxsb:ca:${soxsb}:observed`,
  ]);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);

  await check();
  assert.equal(producerEvents.length, 1);
  assert.equal(telegramPayloads.length, 1, "a restart after delivery must not POST again");
});

test("Flap suppresses a quote-linked vault until metadata proves an unknown address is bStock", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-linked-vault-metadata-pending-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const stockQuote = "0x7777777777777777777777777777777777777777";
  const vaultFactory = "0x8888888888888888888888888888888888888888";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 4, marketSources: [{ url: board, chainId: 56 }], pagePattern: /$a/ };
  let current = Date.parse("2026-09-03T09:30:00.000Z");
  let includeStock = false;
  let metadataReads = 0;
  const alerts = [];
  const activations = [];
  const check = async () => {
    const result = await runPlatformCapabilityCheck({ dataDir }, {
      targets: [target],
      fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: [
        { quoteToken: { address: oldQuote, name: "Old Quote", symbol: "OLD" } },
        ...(includeStock ? [{
          quoteToken: stockQuote,
          vaultFactory,
          vaultFactoryCategory: ["INDEX"],
        }] : []),
      ] } }), { url }),
      resolveFlapQuoteAssetMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) throw new Error("temporary metadata outage");
        return { name: "Unknown Leveraged ETF", symbol: "UX3", decimals: 18, assetClass: "ETF bStock" };
      },
      sendAlertsImpl: async (_config, event) => {
        alerts.push(structuredClone(event));
        return { status: "delivered", eventId: event.eventKey };
      },
      onFlapFeatureActivation: async (records) => activations.push(...records),
      logger: quietLogger,
      now: () => new Date(current),
    });
    current += 1_500;
    return result;
  };

  await check();
  includeStock = true;
  await check();
  await check();
  assert.equal(alerts.filter(({ kind }) => kind === "flap_quote_asset_board_observed").length, 0);
  assert.equal(alerts.every(({ changes }) => !(changes.newFlapPools || []).some((pool) => (
    pool.quoteAddress === stockQuote || pool.vaultFactory === vaultFactory
  ))), true, "raw quote and its linked vault stay outside the first alert");
  assert.equal(activations.length, 0);

  await check();
  const boardAlerts = alerts.filter(({ kind }) => kind === "flap_quote_asset_board_observed");
  assert.equal(boardAlerts.length, 1);
  assert.deepEqual(boardAlerts[0].changes.newFlapPools.map(({ kind, quoteAddress, quoteSymbol }) => ({ kind, quoteAddress, quoteSymbol })), [{
    kind: "quote_asset",
    quoteAddress: stockQuote,
    quoteSymbol: "UX3",
  }]);
  assert.equal(activations.length, 0, "metadata-discovered bStock/ETF never activates automatic correlation");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.ok(state.flap.capabilities.flapPools.some((pool) => pool.vaultFactory === vaultFactory));
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);
});

test("Flap observes stock and genuine quote pools after metadata but Board activates neither", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-stock-quote-filter-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 3, marketSources: [board], pagePattern: /$a/ };
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const stockQuote = "0x2222222222222222222222222222222222222222";
  const realQuote = "0x3333333333333333333333333333333333333333";
  let quotes = [oldQuote];
  const alerts = [];
  const activations = [];
  const metadataReads = [];
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(JSON.stringify({
      initialBoard: {
        items: quotes.map((quoteToken) => ({
          quoteToken: quoteToken === oldQuote
            ? { address: oldQuote, name: "Existing quote", symbol: "OLD" }
            : quoteToken,
        })),
      },
    }), { url }),
    resolveFlapQuoteAssetMetadata: async ({ address, chainId }) => {
      metadataReads.push({ address, chainId });
      return address === stockQuote
        ? { name: "Example Tokenized Stock", symbol: "EXMB", assetClass: "RWA stock" }
        : { name: "Real quote asset", symbol: "USDQ" };
    },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
    onFlapFeatureActivation: async (records) => activations.push(...records),
    logger: quietLogger,
    now: () => new Date("2026-08-18T10:00:00Z"),
  });

  await check();
  quotes = [oldQuote, stockQuote, realQuote];
  await check();
  await check();

  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.flatMap(({ changes }) => changes.newFlapPools.map(({ quoteAddress }) => quoteAddress)).sort(), [
    stockQuote,
    realQuote,
  ].sort());
  assert.equal(alerts.every(({ kind, changes }) => (
    kind === "flap_quote_asset_board_observed" && changes.newFlapPools.length === 1
  )), true);
  assert.deepEqual(activations, [], "the Board top list is metadata evidence, not an activation source");
  assert.deepEqual(metadataReads.map(({ address, chainId }) => ({ address, chainId })).sort((a, b) => a.address.localeCompare(b.address)), [
    { address: stockQuote, chainId: 56 },
    { address: realQuote, chainId: 56 },
  ]);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const storedStock = state.flap.capabilities.flapPools.find(({ quoteAddress }) => quoteAddress === stockQuote);
  assert.equal(storedStock.quoteName, "Example Tokenized Stock");
  assert.equal(isExcludedFlapQuoteAsset(storedStock), true);

  await check();
  assert.equal(alerts.length, 2, "both delivered quote observations are checkpointed and do not repeat");
});

test("Flap Board HTTP 200 with an empty schema fails closed and preserves its last good baseline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-board-schema-empty-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const docs = "https://docs.flap.sh/flap/developers/vault";
  const sourceKey = `market:${board}`;
  const factory = "0x2222222222222222222222222222222222222222";
  const quote = "0x3333333333333333333333333333333333333333";
  const validBoard = JSON.stringify({
    initialBoard: {
      items: [{ quoteToken: quote, vault: { vaultFactory: factory, vaultFactoryCategory: ["index"] } }],
    },
  });
  const emptyBoard = JSON.stringify({ initialBoard: { items: [] } });
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 3,
    sources: [docs],
    marketSources: [board],
    pagePattern: /$a/,
  };
  let boardBody = emptyBoard;
  let current = Date.parse("2026-08-11T00:00:00.000Z");
  let boardCalls = 0;
  const alerts = [];
  const check = () => runPlatformCapabilityCheck(
    { dataDir, platformCapabilityPollIntervalMs: 10_000 },
    {
      targets: [target],
      fetchImpl: async (url) => {
        if (url === board) {
          boardCalls += 1;
          return response(boardBody, { url });
        }
        return response("VaultFactoryBaseV2", { url });
      },
      sendAlertsImpl: async (_config, event) => alerts.push(event),
      logger: quietLogger,
      now: () => new Date(current),
    },
  );

  await check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal("flap" in state, false, "an empty required Board must not create a partial cold-start baseline");
  assert.equal(state._health.platforms.flap.status, "partial");
  assert.equal(state._health.platforms.flap.failureKind, "schema_empty");

  current += 10_000;
  boardBody = validBoard;
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const baselineCapabilities = JSON.parse(JSON.stringify(state.flap.capabilities));
  const baselineBoardCapabilities = JSON.parse(JSON.stringify(state.flap.sources[sourceKey].capabilities));
  const baselineSuccessAt = state.flap.sources[sourceKey].lastSuccessAt;
  assert.equal(alerts.length, 0, "the first complete snapshot remains a quiet baseline");

  current += 10_000;
  boardBody = emptyBoard;
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.sourceHealth[sourceKey].status, "degraded");
  assert.equal(state.flap.sourceHealth[sourceKey].failureKind, "schema_empty");
  assert.match(state.flap.sourceHealth[sourceKey].lastError, /schema_empty/);
  assert.equal(state.flap.sources[sourceKey].lastSuccessAt, baselineSuccessAt);
  assert.deepEqual(state.flap.sources[sourceKey].capabilities, baselineBoardCapabilities);
  assert.deepEqual(state.flap.capabilities, baselineCapabilities);
  assert.equal(state._health.platforms.flap.status, "partial");
  assert.equal(state._health.platforms.flap.failureKind, "schema_empty");
  const boardCallsAfterFailure = boardCalls;

  current += 5_000;
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(boardCalls, boardCallsAfterFailure, "the empty-schema source respects its 10-second backoff");
  assert.equal(state._health.platforms.flap.status, "partial", "a source in backoff must not be relabeled healthy");
  assert.equal(state._health.platforms.flap.failureKind, "schema_empty");

  current += 5_000;
  boardBody = validBoard;
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(boardCalls, boardCallsAfterFailure + 1);
  assert.equal(state.flap.sourceHealth[sourceKey].status, "healthy");
  assert.equal(state._health.platforms.flap.status, "healthy");
  assert.equal(alerts.length, 0);
});

test("an exact optional Flap Morph board may stay healthy while empty and reveals its first pool without backoff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-morph-empty-board-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/morph/board";
  const quote = "0x3333333333333333333333333333333333333333";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 4,
    marketSources: [{ url: board, chainId: 2818, requiredForBaseline: false }],
    sources: [],
    pagePattern: /$a/,
  };
  let current = Date.parse("2026-08-12T00:00:00.000Z");
  let firstPool = false;
  const alerts = [];
  const deliveries = [];
  const config = {
    dataDir,
    platformCapabilityPollIntervalMs: 10_000,
    monitorScope: "focus3",
    telegramToken: "test-token",
    telegramChatId: "-1001",
    telegramStrongAlerts: true,
  };
  t.mock.method(globalThis, "fetch", async () => assert.fail("focus3 must not POST a Morph quote event"));
  const emptyMorphBoard = '<title>Flap — The Programmable Token Launchpad</title><a href="/morph/board"><button aria-label="Current chain: MORPH">MORPH</button></a>';
  const check = () => runPlatformCapabilityCheck(config, {
    targets: [target],
    fetchImpl: async () => response(firstPool
      ? `${emptyMorphBoard}<script>${JSON.stringify({ initialBoard: { quoteToken: { address: quote, name: "Morph Quote", symbol: "MQUOTE" } } })}</script>`
      : emptyMorphBoard, { url: board }),
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      const delivery = await sendAlerts(config, event);
      deliveries.push(delivery);
      return delivery;
    },
    logger: quietLogger,
    now: () => new Date(current),
  });

  await check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.sourceHealth[`market:${board}`].status, "healthy");
  assert.equal(state.flap.capabilities.flapPools.length, 0);

  current += 10_000;
  firstPool = true;
  await check();
  assert.equal(alerts.length, 0, "the first observation remains a pending candidate");
  current += 10_000;
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.capabilities.flapPools[0].identity, `chain-2818:quote:${quote}`);
  assert.equal(alerts.length, 1, "the stable first Morph pool is detected on consecutive fast polls");
  assert.equal(alerts[0].kind, undefined, "Morph remains on its generic platform-capability lane");
  assert.equal(alerts[0].source, board);
  assert.equal(alerts[0].changes.newFlapPools[0].sourceUrl, board);
  assert.deepEqual(deliveries.map(({ status, reason }) => ({ status, reason })), [{
    status: "suppressed",
    reason: "monitoring_source_disabled",
  }]);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined,
    "the BSC-only pending lane never captures Morph");

  current += 10_000;
  await check();
  assert.equal(alerts.length, 1, "the terminal focus3 policy result does not create a Morph retry loop");
});

test("an old optional Flap Morph schema-empty backoff is migrated on the next startup check", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-morph-backoff-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/morph/board";
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  const emptyCapabilities = {
    quoteTokens: [], quoteConfigs: [], flapPools: [], contracts: [], versions: [], modules: [], chains: [],
    pages: [], pageMetadata: [], announcements: [], campaigns: [], packages: [], sourceFingerprints: [],
  };
  await fs.writeFile(stateFile, `${JSON.stringify({
    flap: {
      capabilitySchemaVersion: 4,
      capabilities: emptyCapabilities,
      sources: {
        [`market:${board}`]: {
          key: `market:${board}`,
          url: board,
          kind: "market",
          requiredForBaseline: false,
          initialized: false,
          status: "degraded",
          failureKind: "schema_empty",
          consecutiveFailures: 459,
          nextAttemptAt: "2026-08-12T00:02:00.000Z",
        },
      },
    },
    _health: { platforms: { flap: { status: "partial", nextAttemptAt: null } } },
  })}\n`);
  let calls = 0;
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 4,
    marketSources: [{ url: board, chainId: 2818, requiredForBaseline: false }],
    sources: [],
    pagePattern: /$a/,
  };
  const body = '<title>Flap — The Programmable Token Launchpad</title><a href="/morph/board"><button aria-label="Current chain: MORPH">MORPH</button></a>';
  await runPlatformCapabilityCheck({ dataDir, platformCapabilityPollIntervalMs: 10_000 }, {
    targets: [target],
    fetchImpl: async () => { calls += 1; return response(body, { url: board }); },
    sendAlertsImpl: async () => assert.fail("migration must not alert"),
    logger: quietLogger,
    now: () => new Date("2026-08-12T00:00:00.000Z"),
  });
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(calls, 1, "the old 120-second source backoff must not suppress the fixed parser");
  assert.equal(state.flap.sourceHealth[`market:${board}`].status, "healthy");
  assert.equal(state.flap.sourceHealth[`market:${board}`].nextAttemptAt, null);
});

test("Flap pools require two observations, retain pagination misses, and detect a factory swap in the same category", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-pool-stability-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 3, marketSources: [board], pagePattern: /$a/ };
  const factoryA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const factoryB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const quoteA = "0xcccccccccccccccccccccccccccccccccccccccc";
  const quoteB = "0xdddddddddddddddddddddddddddddddddddddddd";
  let minute = 0;
  let items = [{ coin: { address: "0x1111111111111111111111111111111111111111" }, quoteToken: quoteA,
    vault: { vaultFactory: factoryA, vaultFactoryCategory: ["index"] } }];
  const alerts = [];
  const activations = [];
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items } }), { url }),
    resolveFlapQuoteAssetMetadata: async ({ address }) => ({
      name: address === quoteB ? "Quote B" : "Quote A",
      symbol: address === quoteB ? "QUOTEB" : "QUOTEA",
      decimals: 18,
    }),
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
    onFlapFeatureActivation: async (records) => activations.push(records),
    logger: quietLogger,
    now: () => new Date(`2026-08-10T10:${String(minute++).padStart(2, "0")}:00.000Z`),
  });

  await check();
  assert.equal(alerts.length, 0, "cold-start board contents are a quiet baseline");

  items = [
    ...items,
    { coin: { address: "0x2222222222222222222222222222222222222222" }, quoteToken: quoteB,
      vault: { vaultFactory: factoryB, vaultFactoryCategory: ["index"] } },
  ];
  await check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(alerts.length, 0);
  assert.equal(state.flap.boardCandidateState.flapPools[`vault:INDEX:${factoryB}`].observations, 1);
  assert.equal(state.flap.capabilities.flapPools.some(({ vaultFactory }) => vaultFactory === factoryB), false);

  await check();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].changes.newFlapPools.map(({ identity }) => identity), [
    `chain-56:quote:${quoteB}`,
  ]);
  assert.equal(alerts[0].changes.newModules.length, 0, "the factory identity detects a change even when its category already exists");
  assert.equal(activations.length, 0, "stable Board top-list observations do not arm quote tracking");

  await check();
  assert.equal(alerts.length, 1);
  assert.equal(activations.length, 0);

  items = [];
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(alerts.length, 1, "a pagination miss does not emit removals");
  assert.equal(state.flap.capabilities.flapPools.some(({ vaultFactory }) => vaultFactory === factoryB), true);

});

test("Flap Board keeps the legacy activation hook for confirmed vault factories only", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-vault-activation-only-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const quote = "0x1111111111111111111111111111111111111111";
  const oldFactory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const newFactory = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 3,
    marketSources: [board],
    pagePattern: /$a/,
  };
  let items = [{
    quoteToken: { address: quote, name: "Existing Quote", symbol: "OLDQ" },
    vault: { vaultFactory: oldFactory, vaultFactoryCategory: ["index"] },
  }];
  const activations = [];
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items } }), { url }),
    sendAlertsImpl: async (_config, event) => ({ status: "delivered", eventId: event.eventKey }),
    onFlapFeatureActivation: async (records) => activations.push(...records),
    logger: quietLogger,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });

  await check();
  items = [...items, {
    quoteToken: { address: quote, name: "Existing Quote", symbol: "OLDQ" },
    vault: { vaultFactory: newFactory, vaultFactoryCategory: ["yield"] },
  }];
  await check();
  assert.equal(activations.length, 0, "one Board observation cannot confirm a vault factory");
  await check();

  assert.equal(activations.length, 1);
  assert.equal(activations[0].identity, `vault:YIELD:${newFactory}`);
  assert.equal(activations[0].vaultFactory, newFactory);
  assert.equal(activations[0].quoteAddress, quote);
  assert.equal(activations[0].confirmed, true);
  assert.ok(activations[0].observations >= 2);
});

test("Flap Board quote observations never call the legacy activation hook", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-pool-activation-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const target = { id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 3, marketSources: [board], pagePattern: /$a/ };
  const oldQuote = "0x1111111111111111111111111111111111111111";
  const newQuote = "0x2222222222222222222222222222222222222222";
  let quotes = [oldQuote];
  let activationAttempts = 0;
  const alerts = [];
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: quotes.map((quoteToken) => ({ quoteToken })) } }), { url }),
    resolveFlapQuoteAssetMetadata: async ({ address }) => ({
      name: address === newQuote ? "New Quote" : "Old Quote",
      symbol: address === newQuote ? "NEWQ" : "OLDQ",
      decimals: 18,
    }),
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
    onFlapFeatureActivation: async () => {
      activationAttempts += 1;
      throw new Error("Board quote observations must not reach this hook");
    },
    logger: quietLogger,
    now: () => new Date("2026-08-10T11:00:00.000Z"),
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  quotes = [oldQuote, newQuote];
  await runPlatformCapabilityCheck({ dataDir }, options);
  await runPlatformCapabilityCheck({ dataDir }, options);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(activationAttempts, 0);
  assert.equal(state.flap.capabilities.flapPools.some(({ quoteAddress }) => quoteAddress === newQuote), true,
    "resolved Board metadata still commits durably");
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);

  await runPlatformCapabilityCheck({ dataDir }, options);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(activationAttempts, 0);
  assert.equal(state.flap.capabilities.flapPools.some(({ quoteAddress }) => quoteAddress === newQuote), true);
  assert.equal(state.flap.boardCandidateState.flapQuoteMetadataNotificationPending, undefined);
  await runPlatformCapabilityCheck({ dataDir }, options);
  assert.equal(activationAttempts, 0);
  assert.equal(alerts.length, 1, "the delivered Board observation is checkpointed exactly once");
});

test("Flap v3 migration seeds existing structured pools without activating historical items", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-pool-v3-migration-"));
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const factory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const quote = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const legacyCapabilities = capabilities({ modules: ["Vault INDEX"] });
  delete legacyCapabilities.flapPools;
  await fs.writeFile(stateFile, `${JSON.stringify({
    flap: { capabilitySchemaVersion: 2, capabilities: legacyCapabilities, checkedAt: "2026-08-10T08:00:00.000Z" },
  })}\n`);
  const alerts = [];
  const activations = [];
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [{ id: "flap", name: "Flap", website: "https://flap.sh", capabilitySchemaVersion: 3, marketSources: [board], pagePattern: /$a/ }],
    fetchImpl: async (url) => response(JSON.stringify({ initialBoard: { items: [{ quoteToken: quote,
      vault: { vaultFactory: factory, vaultFactoryCategory: ["index"] } }] } }), { url }),
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
    onFlapFeatureActivation: async (records) => activations.push(...records),
    logger: quietLogger,
    now: () => new Date("2026-08-10T08:01:00.000Z"),
  });

  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(alerts.length, 0);
  assert.equal(activations.length, 0);
  assert.deepEqual(state.flap.capabilities.flapPools.map(({ identity }) => identity), [
    `quote:${quote}`,
    `vault:INDEX:${factory}`,
  ]);
  assert.equal(state.flap.boardCandidateState.flapPools[`quote:${quote}`].confirmed, true);
});

test("Flap v3 to v4 migration silences only chain-scoped BSC pool equivalents and retains real pools plus Morph chain discovery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-pool-v4-chain-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const morphBoard = "https://flap.sh/morph/board";
  const docs = "https://docs.flap.sh/flap/developers/networks";
  const oldFactory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const oldQuote = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const newBscQuote = "0xcccccccccccccccccccccccccccccccccccccccc";
  const newMorphQuote = "0xdddddddddddddddddddddddddddddddddddddddd";
  const secondMorphQuote = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const oldBoard = JSON.stringify({ initialBoard: { items: [{
    quoteToken: oldQuote,
    vault: { vaultFactory: oldFactory, vaultFactoryCategory: ["index"] },
  }] } });
  const upgradedBscBoard = JSON.stringify({ initialBoard: { items: [
    {
      quoteToken: oldQuote,
      vault: { vaultFactory: oldFactory, vaultFactoryCategory: ["index"] },
    },
    { quoteToken: { address: newBscQuote, name: "New BSC Quote", symbol: "BSCQ" } },
  ] } });
  const morphPayload = JSON.stringify({ initialBoard: { items: [
    { quoteToken: { address: newMorphQuote, name: "New Morph Quote", symbol: "MORPHQ" } },
    { quoteToken: { address: secondMorphQuote, name: "Second Morph Quote", symbol: "MORPH2" } },
  ] } });
  const alerts = [];
  let upgraded = false;
  let minute = 0;
  const targetV3 = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 3,
    marketSources: [board],
    sources: [docs],
    pagePattern: /$a/,
  };
  const targetV4 = {
    ...targetV3,
    capabilitySchemaVersion: 4,
    marketSources: [
      { url: board, chainId: 56, requiredForBaseline: true },
      { url: morphBoard, chainId: 2818, requiredForBaseline: false },
    ],
    schemaMigration: { sourceFingerprints: [board, morphBoard, docs] },
  };
  const check = (target) => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => {
      if (url === board) return response(upgraded ? upgradedBscBoard : oldBoard, { url });
      if (url === morphBoard) return response(morphPayload, { url });
      return response(upgraded
        ? "Flap supports BNB Chain mainnet (chainId: 56) and Morph mainnet (chainId: 2818)."
        : "Flap supports BNB Chain mainnet (chainId: 56).", { url });
    },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
    logger: quietLogger,
    now: () => new Date(`2026-08-12T00:${String(minute++).padStart(2, "0")}:00.000Z`),
  });

  await check(targetV3);
  assert.equal(alerts.length, 0);

  upgraded = true;
  await check(targetV4);
  const boardAlerts = alerts.filter(({ kind }) => kind === "flap_quote_asset_board_observed");
  const chainAlerts = alerts.filter(({ kind }) => kind !== "flap_quote_asset_board_observed");
  const chainPoolAlerts = chainAlerts.filter(({ changes }) => changes.newFlapPools.length);
  const [chainResidual] = chainAlerts.filter(({ changes }) => !changes.newFlapPools.length);
  assert.equal(boardAlerts.length, 1);
  assert.deepEqual(boardAlerts.flatMap(({ changes }) => changes.newFlapPools.map(({ identity }) => identity)), [
    `chain-56:quote:${newBscQuote}`,
  ]);
  assert.equal(chainAlerts.length, 3, "each new pool owns one alert and unrelated chain facts own one residual alert");
  assert.equal(chainPoolAlerts.length, 2);
  assert.equal(chainPoolAlerts.every(({ changes }) => changes.newFlapPools.length === 1), true);
  assert.deepEqual(chainPoolAlerts.flatMap(({ changes }) => changes.newFlapPools.map(({ identity }) => identity)).sort(), [
    `chain-2818:quote:${newMorphQuote}`,
    `chain-2818:quote:${secondMorphQuote}`,
  ].sort());
  assert.deepEqual(chainResidual.changes.newChains.map(({ name, chainId }) => ({ name, chainId })), [
    { name: "Morph", chainId: 2818 },
  ]);
  assert.equal(new Set(chainAlerts.map(({ eventKey }) => eventKey)).size, 3);
  assert.equal(boardAlerts.some(({ changes }) => changes.newFlapPools.some(({ identity }) => identity === `chain-56:quote:${oldQuote}`)), false);
  assert.equal(boardAlerts.some(({ changes }) => changes.newFlapPools.some(({ identity }) => identity === `chain-56:vault:INDEX:${oldFactory}`)), false);

  // Reproduce the already-persisted production v4 shape from before the
  // cleanup: both scoped and legacy identities, including candidate records.
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  let state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const scopedOldQuote = state.flap.capabilities.flapPools.find(({ identity }) => identity === `chain-56:quote:${oldQuote}`);
  const scopedOldVault = state.flap.capabilities.flapPools.find(({ identity }) => identity === `chain-56:vault:INDEX:${oldFactory}`);
  state.flap.capabilities.flapPools.push(
    { ...scopedOldQuote, identity: `quote:${oldQuote}`, chainId: undefined },
    { ...scopedOldVault, identity: `vault:INDEX:${oldFactory}`, chainId: undefined },
  );
  state.flap.boardCandidateState.flapPools[`quote:${oldQuote}`] = {
    ...state.flap.boardCandidateState.flapPools[`chain-56:quote:${oldQuote}`],
  };
  state.flap.boardCandidateState.flapPools[`vault:INDEX:${oldFactory}`] = {
    ...state.flap.boardCandidateState.flapPools[`chain-56:vault:INDEX:${oldFactory}`],
  };
  await fs.writeFile(stateFile, `${JSON.stringify(state)}\n`);

  await check(targetV4);
  assert.equal(alerts.length, 4, "the migrated checkpoint and genuine discoveries remain stable on the next poll");
  state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const expectedScopedIdentities = [
    `chain-2818:quote:${newMorphQuote}`,
    `chain-2818:quote:${secondMorphQuote}`,
    `chain-56:quote:${newBscQuote}`,
    `chain-56:quote:${oldQuote}`,
    `chain-56:vault:INDEX:${oldFactory}`,
  ].sort();
  assert.deepEqual(state.flap.capabilities.flapPools.map(({ identity }) => identity).sort(), expectedScopedIdentities);
  assert.deepEqual(Object.keys(state.flap.boardCandidateState.flapPools).sort(), expectedScopedIdentities);
});

test("Flap v4 silently aliases a legacy-only BSC pool while absent and does not rediscover its scoped reappearance", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-v4-legacy-alias-"));
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const quote = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const activeQuote = "0xffffffffffffffffffffffffffffffffffffffff";
  const payload = JSON.stringify({ initialBoard: { items: [{ quoteToken: quote }, { quoteToken: activeQuote }] } });
  const withoutHistoricalPayload = JSON.stringify({ initialBoard: { quoteToken: activeQuote } });
  const alerts = [];
  let boardVisible = true;
  let current = Date.parse("2026-08-12T01:00:00.000Z");
  const targetV3 = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 3,
    marketSources: [board],
    pagePattern: /$a/,
  };
  const targetV4 = {
    ...targetV3,
    capabilitySchemaVersion: 4,
    marketSources: [{ url: board, chainId: 56, requiredForBaseline: true }],
  };
  const check = (target) => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(boardVisible
      ? payload
      : withoutHistoricalPayload, { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date(current),
  });

  await check(targetV3);
  let state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.deepEqual(state.flap.capabilities.flapPools.map(({ identity }) => identity).sort(), [
    `quote:${activeQuote}`,
    `quote:${quote}`,
  ].sort());

  // Model a production checkpoint already labeled v4 but still containing
  // only the pre-chain-scoping identity. The cached Board snapshot supplies
  // provenance while the live Board temporarily omits the historical pool.
  state.flap.capabilitySchemaVersion = 4;
  await fs.writeFile(stateFile, `${JSON.stringify(state)}\n`);
  boardVisible = false;
  current += 60_000;
  await check(targetV4);

  state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const scopedIdentity = `chain-56:quote:${quote}`;
  const activeScopedIdentity = `chain-56:quote:${activeQuote}`;
  const scopedIdentities = [activeScopedIdentity, scopedIdentity].sort();
  assert.equal(alerts.length, 0);
  assert.deepEqual(state.flap.capabilities.flapPools.map(({ identity }) => identity).sort(), scopedIdentities);
  assert.deepEqual(Object.keys(state.flap.boardCandidateState.flapPools).sort(), scopedIdentities);

  boardVisible = true;
  current += 60_000;
  await check(targetV4);
  state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(alerts.length, 0, "the scoped form of the same historical pool is not rediscovered");
  assert.deepEqual(state.flap.capabilities.flapPools.map(({ identity }) => identity).sort(), scopedIdentities);
  assert.deepEqual(Object.keys(state.flap.boardCandidateState.flapPools).sort(), scopedIdentities);
});

test("Flap board-only categories require two observations and board removal stays silent", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-board-stability-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    marketSources: [board],
    pagePattern: /$a/,
  };
  const alerts = [];
  let categories = ["index"];
  let minute = 0;
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(`vaultFactoryCategory:[${categories.map((value) => `\\"${value}\\"`).join(",")}]`, { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date(`2026-08-01T00:${String(minute++).padStart(2, "0")}:00.000Z`),
  });

  await check();
  categories = ["index", "nft"];
  await check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(alerts.length, 0);
  assert.deepEqual(state.flap.capabilities.modules, ["Vault INDEX"]);
  assert.equal(state.flap.boardCandidateState.modules["Vault NFT"].consecutiveObservations, 1);
  assert.equal(state.flap.boardCandidateState.modules["Vault NFT"].confirmed, false);

  categories = ["index"];
  await check();
  categories = ["index", "nft"];
  await check();
  assert.equal(alerts.length, 0);
  await check();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].changes.newModules, ["Vault NFT"]);

  categories = ["index"];
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(alerts.length, 1);
  assert.deepEqual(state.flap.capabilities.modules, ["Vault INDEX", "Vault NFT"]);
  categories = ["index", "nft"];
  await check();
  assert.equal(alerts.length, 1);
});

test("Flap docs evidence confirms a matching board capability immediately", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-board-docs-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const docs = "https://docs.flap.sh/flap/developers/vault";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    sources: [docs],
    marketSources: [board],
    pagePattern: /$a/,
  };
  const alerts = [];
  let documented = false;
  let boardCategory = "index";
  const fetchImpl = async (url) => response(
    url === board ? `vaultFactoryCategory:[\\"${boardCategory}\\"]` : documented ? "VaultFactoryBaseV2" : "No vault release yet",
    { url },
  );
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target], fetchImpl, sendAlertsImpl: async (_config, event) => alerts.push(event), logger: quietLogger,
    now: () => new Date("2026-08-01T01:00:00.000Z"),
  });
  documented = true;
  boardCategory = "v2";
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target], fetchImpl, sendAlertsImpl: async (_config, event) => alerts.push(event), logger: quietLogger,
    now: () => new Date("2026-08-01T01:01:00.000Z"),
  });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].changes.newModules, ["Vault V2"]);
  assert.equal(alerts[0].sources.includes(docs), true);
});

test("Flap sitemap coverage includes all developer and skill pages", () => {
  const target = PLATFORM_CAPABILITY_TARGETS.find(({ id }) => id === "flap");
  assert.equal(target.pagePattern.test("https://docs.flap.sh/flap/developers/basic-and-mechanism/protocol-economics"), true);
  assert.equal(target.pagePattern.test("https://docs.flap.sh/flap/developers/bot/index-token-created-events"), true);
  assert.equal(target.pagePattern.test("https://docs.flap.sh/flap/skills"), true);
  assert.equal(target.pagePattern.test("https://docs.flap.sh/flap/use-flap-as-user/stocks"), false);
  for (const source of [...target.sources, ...target.marketSources]) {
    const sourceUrl = typeof source === "string" ? source : source.url;
    assert.equal(target.schemaMigration.sourceFingerprints.includes(sourceUrl), true);
  }
  assert.equal(target.marketSources.some((source) => source.url === "https://flap.sh/morph/board" && source.chainId === 2818), true);
  for (const source of target.sources) assert.equal(target.schemaMigration.added.pages.includes(source), true);
});

test("Four.meme capability sources exclude stock issuance pages while retaining core fast sources", () => {
  const target = PLATFORM_CAPABILITY_TARGETS.find(({ id }) => id === "fourmeme");
  assert.equal(target.capabilitySchemaVersion, 4);
  assert.equal(target.sources.some((url) => /\/stock-meme(?:\/|$)/i.test(url)), false);
  assert.equal(target.pagePattern.test("https://four-meme.gitbook.io/four.meme/stock-meme/about-stock-meme-en"), false);
  assert.equal(target.pagePattern.test("https://four-meme.gitbook.io/four.meme/product-update/new-mode"), true);
  assert.equal(target.pagePattern.test("https://four.meme/en/agentic"), true);
  assert.equal(target.apiSources.some(({ url, parser }) => url.endsWith("/meme-api/v1/public/config") && parser === "fourmeme-config"), true);
  assert.equal(target.packageSources.some(({ parser }) => parser === "fourmeme-npm"), true);
  assert.equal(target.liveSources.includes("https://four.meme/en/create-token"), true);
});

test("extracts robust Four.meme runtime modes, announcements and camelCase named contracts", () => {
  const html = String.raw`href=\"/en/agentic\" \"AIAgentMode\":\"AI\" \"X Mode\" \"Register 8004\"
    {\"title\":\"New Mode\",\"createdAt\":1,\"announcementId\":\"100000077\"}
    {\"contractName\":\"tokenCreatorTax\",\"chain\":\"BSC\",\"contractAddress\":\"0xfc9b9a6e296c72bbf2fc8ea2090a4d9539bca1b2\"}
    \"rebateKeeperAddress\":\"0x208bf3e7da9639f1eaefa2de78c23396b0682025\"`;
  const result = extractFourMemeLiveCapabilities(html);
  assert.ok(result.modules.includes("Agentic"));
  assert.ok(result.modules.includes("AI Agent Mode"));
  assert.ok(result.modules.includes("X Mode"));
  assert.ok(result.modules.includes("EIP-8004"));
  assert.ok(result.modules.includes("Contract TOKEN_CREATOR_TAX"));
  assert.ok(result.modules.includes("Contract REBATE_KEEPER"));
  assert.deepEqual(result.contracts, [
    "0x208bf3e7da9639f1eaefa2de78c23396b0682025",
    "0xfc9b9a6e296c72bbf2fc8ea2090a4d9539bca1b2",
  ]);
  assert.deepEqual(result.announcements, ["100000077:New Mode"]);
});

test("Four.meme live parser rejects rotating token cards and user addresses", () => {
  const html = String.raw`
    {\"name\":\"A normal launched token\",\"address\":\"0x1111111111111111111111111111111111114444\"}
    \"creatorAddress\":\"0x2222222222222222222222222222222222224444\"
    {\"contractName\":\"tokenManagerV4\",\"contractAddress\":\"0x3333333333333333333333333333333333333333\"}`;
  const result = extractFourMemeLiveCapabilities(html);
  assert.deepEqual(result.contracts, ["0x3333333333333333333333333333333333333333"]);
  assert.deepEqual(result.modules.filter((item) => item.startsWith("Contract ")), ["Contract TOKEN_MANAGER_V4"]);
});

test("capability parser upgrades silently remove old board noise and then stay stable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-schema-upgrade-"));
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  const board = "https://flap.sh/board";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    capabilitySchemaVersion: 2,
    marketSources: [board],
    pagePattern: /$a/,
    schemaMigration: {
      sourceFingerprints: [board],
      removed: { quoteTokens: [board] },
    },
  };
  const oldCapabilities = capabilities({
    quoteTokens: ["AAPLB"],
    modules: ["Vault INDEX"],
    sourceFingerprints: [{ url: board, kind: "market", fingerprint: "old-board-fingerprint" }],
    sourceProvenance: {
      quoteTokens: { AAPLB: [board] },
      contracts: {}, versions: {}, modules: { "Vault INDEX": [board] }, pages: {}, announcements: {}, campaigns: {},
    },
  });
  await fs.writeFile(stateFile, `${JSON.stringify({ flap: { capabilities: oldCapabilities, checkedAt: "2026-07-31T00:00:00Z" } })}\n`);
  const alerts = [];
  let asset = "aaplb";
  const fetchImpl = async (url) => response(`src="/payment-token-catalog/${asset}.svg" vaultFactoryCategory:[\\"index\\"]`, { url });
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target], fetchImpl, sendAlertsImpl: async (_config, event) => alerts.push(event), logger: quietLogger,
    now: () => new Date("2026-07-31T00:01:00Z"),
  });
  let state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(alerts.length, 0);
  assert.equal(state.flap.capabilitySchemaVersion, 2);
  assert.deepEqual(state.flap.capabilities.quoteTokens, []);
  asset = "qqqb";
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target], fetchImpl, sendAlertsImpl: async (_config, event) => alerts.push(event), logger: quietLogger,
    now: () => new Date("2026-07-31T00:02:00Z"),
  });
  state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(alerts.length, 0);
  assert.deepEqual(state.flap.capabilities.modules, ["Vault INDEX"]);
});

test("Four.meme parser upgrade silently removes homepage token-card contracts", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fourmeme-schema-upgrade-"));
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  const homepage = "https://four.meme/en";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const target = {
    id: "fourmeme",
    name: "Four.meme",
    website: homepage,
    capabilitySchemaVersion: 2,
    liveSources: [homepage],
    pagePattern: /$a/,
    schemaMigration: {
      sourceFingerprints: [homepage],
      removed: { contracts: [homepage], modules: [homepage] },
    },
  };
  const noisyContract = "0x1111111111111111111111111111111111114444";
  const oldCapabilities = capabilities({
    contracts: [noisyContract],
    modules: ["Contract TOKEN"],
    sourceFingerprints: [{ url: homepage, kind: "live", fingerprint: "old-homepage-fingerprint" }],
    sourceProvenance: {
      quoteTokens: {}, contracts: { [noisyContract]: [homepage] }, versions: {},
      modules: { "Contract TOKEN": [homepage] }, pages: {}, announcements: {}, campaigns: {},
    },
  });
  await fs.writeFile(stateFile, `${JSON.stringify({ fourmeme: { capabilities: oldCapabilities, checkedAt: "2026-07-31T00:00:00Z" } })}\n`);
  const alerts = [];
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(`{\"name\":\"Rotating token\",\"address\":\"${noisyContract}\"}`, { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date("2026-07-31T00:01:00Z"),
  });
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(alerts.length, 0);
  assert.equal(state.fourmeme.capabilitySchemaVersion, 2);
  assert.deepEqual(state.fourmeme.capabilities.contracts, []);
  assert.deepEqual(state.fourmeme.capabilities.modules, []);
});

test("false runtime booleans do not become modules", () => {
  const result = extractFourMemeLiveCapabilities(String.raw`{\"alphaMode\":false,\"rushMode\":\"false\",\"taxMode\":0,\"CreatorMode\":null,\"AIAgentMode\":false}`);
  assert.equal(result.modules.includes("Alpha Mode"), false);
  assert.equal(result.modules.includes("Rush Mode"), false);
  assert.equal(result.modules.includes("Tax Mode"), false);
  assert.equal(result.modules.includes("Creator Mode"), false);
  assert.equal(result.modules.includes("AI Agent Mode"), false);
});

test("official config accepts only MEME/BSC/PUBLISH and preserves structured provenance", () => {
  const data = {
    code: 0,
    data: [
      {
        symbol: "UUSD", nativeSymbol: "UUSD", symbolAddress: "0x61a10e8556bed032ea176330e7f17d6a12a10000",
        deployCost: "0", buyFee: "0.01", sellFee: "0.01", minTradeFee: "0", b0Amount: "4000",
        totalBAmount: "12000", totalAmount: "1000000000", saleRate: "0.8", reservedNumber: 10,
        tradeLevel: ["50", "250", "500"], status: "PUBLISH", networkCode: "BSC", platform: "MEME",
      },
      {
        symbol: "NVDAB", nativeSymbol: "NVDAB", symbolAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
        deployCost: "0", buyFee: "0.01", sellFee: "0.01", minTradeFee: "0", b0Amount: "8",
        totalBAmount: "60", totalAmount: "1000000000", saleRate: "0.8", reservedNumber: 10,
        tradeLevel: ["0.5", "2", "5"], status: "PUBLISH", networkCode: "BSC", platform: "MEME",
      },
      { symbol: "CAKE", status: "INIT", networkCode: "BSC", platform: "MEME", symbolAddress: "0x0000000000000000000000000000000000000001" },
      { symbol: "BNB_MPC", status: "HIDE", networkCode: "BSC", platform: "MEME", symbolAddress: "0x0000000000000000000000000000000000000002" },
      { symbol: "ETH", status: "PUBLISH", networkCode: "ETH", platform: "MEME", symbolAddress: "0x0000000000000000000000000000000000000003" },
      { symbol: "OTHER", status: "PUBLISH", networkCode: "BSC", platform: "OTHER", symbolAddress: "0x0000000000000000000000000000000000000004" },
    ],
  };
  const result = extractFourMemeConfigCapabilities(data);
  assert.deepEqual(result.quoteTokens, ["NVDAB", "UUSD"]);
  assert.equal(result.quoteConfigs[0].address, "0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
  assert.equal(result.quoteConfigs[0].fees.buyFee, "0.01");
  assert.equal(result.quoteConfigs[0].thresholds.totalBAmount, "60");
  assert.equal(result.quoteConfigs[0].source.url, "https://four.meme/meme-api/v1/public/config");
  assert.deepEqual(result.chains.map(({ name, chainId, environment, stage }) => ({ name, chainId, environment, stage })), [
    { name: "BNB Chain", chainId: 56, environment: "mainnet", stage: "supported" },
    { name: "Ethereum", chainId: 1, environment: "mainnet", stage: "supported" },
  ]);
});

test("official config schema guard rejects API errors and empty publish sets", () => {
  assert.throws(() => extractFourMemeConfigCapabilities({ code: 500, data: [] }), /code=0/);
  assert.throws(() => extractFourMemeConfigCapabilities({ code: 0, data: [{ symbol: "UUSD", status: "INIT", networkCode: "BSC", platform: "MEME" }] }), /no MEME\/BSC PUBLISH/);
  assert.throws(() => extractFourMemeConfigCapabilities({ code: 0, data: [{
    symbol: "SPCXB",
    symbolAddress: `0x${"0".repeat(40)}`,
    status: "PUBLISH",
    networkCode: "BSC",
    platform: "MEME",
  }] }), /non-zero symbolAddress/);
  assert.deepEqual(extractFourMemeConfigCapabilities({ code: 0, data: [{
    symbol: "BNB",
    symbolAddress: `0x${"0".repeat(40)}`,
    status: "PUBLISH",
    networkCode: "BSC",
    platform: "MEME",
  }] }).quoteConfigs, [], "the native BNB sentinel is not an ERC-20 pool identity");
});

test("new Four.meme quote pools emit one alert per pool before one activation handoff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fourmeme-quote-activation-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const configUrl = "https://four.meme/meme-api/v1/public/config";
  const target = {
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    apiSources: [{ url: configUrl, parser: "fourmeme-config", authoritativeQuotes: true, requiredForBaseline: true }],
    pagePattern: /$a/,
  };
  const bnb = {
    symbol: "BNB",
    nativeSymbol: "BNB",
    symbolAddress: "0x0000000000000000000000000000000000000000",
    deployCost: "0.01",
    buyFee: "0.01",
    sellFee: "0.01",
    status: "PUBLISH",
    networkCode: "BSC",
    platform: "MEME",
  };
  const spcxb = {
    symbol: "SPCXB",
    nativeSymbol: "SPCXB",
    symbolAddress: "0xbe9d5f8c23dad991aa03f9c8d9fe14aafc28a001",
    deployCost: "0",
    buyFee: "0.01",
    sellFee: "0.01",
    minTradeFee: "0",
    totalBAmount: "60",
    totalAmount: "1000000000",
    saleRate: "0.8",
    status: "PUBLISH",
    networkCode: "BSC",
    platform: "MEME",
  };
  const nvdab = {
    ...spcxb,
    symbol: "NVDAB",
    nativeSymbol: "NVDAB",
    symbolAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
  };
  const eth = {
    symbol: "ETH",
    nativeSymbol: "ETH",
    symbolAddress: "0x0000000000000000000000000000000000000003",
    status: "PUBLISH",
    networkCode: "ETH",
    platform: "MEME",
  };
  let payload = { code: 0, data: [bnb] };
  const alerts = [];
  const activationBatches = [];
  const discoveries = [];
  let activeDeliveries = 0;
  let maximumActiveDeliveries = 0;
  const deliverySla = {
    startedAt: "2026-08-10T09:02:52.000Z",
    deadlineAt: "2026-08-10T09:02:55.500Z",
    budgetMs: 5_000,
    pollAllowanceMs: 1_500,
    basis: "critical_source_poll",
  };
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(payload, { url }),
    sendAlertsImpl: async (_config, event) => {
      alerts.push(structuredClone(event));
      activeDeliveries += 1;
      maximumActiveDeliveries = Math.max(maximumActiveDeliveries, activeDeliveries);
      await new Promise((resolve) => setImmediate(resolve));
      activeDeliveries -= 1;
      return { status: "queued", persisted: true, eventId: event.eventKey };
    },
    onFourMemeFeatureActivation: async (records) => {
      assert.equal(activeDeliveries, 0, "activation waits for every durable alert handoff");
      activationBatches.push(structuredClone(records));
    },
    onContractDiscovery: async (signal) => discoveries.push(signal),
    logger: quietLogger,
    now: () => new Date("2026-08-10T09:02:52.000Z"),
    sourceLane: "fast",
    deliverySla,
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  payload = { code: 0, data: [bnb, spcxb, nvdab, eth] };
  await runPlatformCapabilityCheck({ dataDir }, options);

  const quoteAlerts = alerts.filter((event) => event.changes.newQuoteConfigs.length);
  const residualAlerts = alerts.filter((event) => !event.changes.newQuoteConfigs.length);
  assert.equal(alerts.length, 3, "two quote pools plus one residual chain change are independent alerts");
  assert.equal(quoteAlerts.length, 2);
  assert.equal(residualAlerts.length, 1, "unrelated changes stay in at most one residual event");
  assert.deepEqual(quoteAlerts.map((event) => event.changes.newQuoteConfigs[0].symbol).sort(), ["NVDAB", "SPCXB"]);
  assert.equal(quoteAlerts.every((event) => event.changes.newQuoteConfigs.length === 1), true);
  assert.equal(quoteAlerts.every((event) => (
    event.changes.newQuoteTokens.length === 1
      && event.changes.newQuoteTokens[0] === event.changes.newQuoteConfigs[0].symbol
  )), true);
  assert.deepEqual(quoteAlerts.map((event) => focusNoveltyKeys(event)), [
    ["fourmeme:quote:nvdab"],
    ["fourmeme:quote:spcxb"],
  ]);
  assert.equal(quoteAlerts.every((event) => (
    withTradingPriority(event, { nowMs: Date.parse(event.observedAt) }).tradingPriority.tier === "T1"
  )), true);
  assert.deepEqual(residualAlerts[0].changes.newQuoteTokens, []);
  assert.deepEqual(residualAlerts[0].changes.newQuoteConfigs, []);
  assert.deepEqual(residualAlerts[0].changes.newChains.map((chain) => chain.chainId), [1]);
  assert.equal(new Set(alerts.map((event) => event.eventKey)).size, 3);
  assert.equal(alerts.every((event) => JSON.stringify(event.deliverySla) === JSON.stringify(deliverySla)), true);
  assert.equal(maximumActiveDeliveries, 3, "all events start within the shared source SLA instead of serializing delivery");

  assert.equal(activationBatches.length, 1);
  assert.equal(activationBatches[0].length, 2);
  assert.equal(activationBatches[0].every((record) => record.changeType === "new_published_quote"), true);
  assert.deepEqual(activationBatches[0].map((record) => record.quoteConfig.symbol).sort(), ["NVDAB", "SPCXB"]);
  assert.deepEqual(activationBatches[0].map((record) => record.quoteConfig.address).sort(), [
    nvdab.symbolAddress,
    spcxb.symbolAddress,
  ].sort());
  assert.deepEqual(discoveries, [], "quote-token addresses are not launchpad contracts or factories");

  const audit = (await fs.readFile(path.join(dataDir, "platform-capability-events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const committed = audit.filter((entry) => entry.delivery.status === "checkpoint_committed");
  assert.deepEqual(new Set(committed.map((entry) => entry.eventKey)), new Set(alerts.map((event) => event.eventKey)));
});

test("Four.meme quote alert identity survives a failed singleton handoff when more pools join the retry", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fourmeme-quote-retry-identity-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const configUrl = "https://four.meme/meme-api/v1/public/config";
  const target = {
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    apiSources: [{ url: configUrl, parser: "fourmeme-config", authoritativeQuotes: true, requiredForBaseline: true }],
    pagePattern: /$a/,
  };
  const quote = (symbol, symbolAddress) => ({
    symbol,
    nativeSymbol: symbol,
    symbolAddress,
    deployCost: "0",
    buyFee: "0.01",
    sellFee: "0.01",
    totalBAmount: "60",
    totalAmount: "1000000000",
    saleRate: "0.8",
    status: "PUBLISH",
    networkCode: "BSC",
    platform: "MEME",
  });
  const bnb = quote("BNB", "0x0000000000000000000000000000000000000000");
  const spcxb = quote("SPCXB", "0xbe9d5f8c23dad991aa03f9c8d9fe14aafc28a001");
  const nvdab = quote("NVDAB", "0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
  const soxlb = quote("SOXLB", "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf");
  let payload = { code: 0, data: [bnb] };
  let phase = 0;
  const attempts = [];
  const activationBatches = [];
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(payload, { url }),
    sendAlertsImpl: async (_config, event) => {
      const symbol = event.changes.newQuoteConfigs[0]?.symbol || null;
      attempts.push({ phase, symbol, event: structuredClone(event) });
      if (phase === 1) {
        return {
          status: "suppressed",
          reason: "semantic_duplicate",
          persisted: true,
          canonicalOwnerDelivered: false,
          eventId: event.eventKey,
        };
      }
      return { status: "queued", persisted: true, eventId: event.eventKey };
    },
    onFourMemeFeatureActivation: async (records) => activationBatches.push(structuredClone(records)),
    logger: quietLogger,
    now: () => new Date("2026-08-10T09:10:00.000Z"),
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  phase = 1;
  payload = { code: 0, data: [bnb, spcxb] };
  await runPlatformCapabilityCheck({ dataDir }, options);

  const firstAttempt = attempts.find((attempt) => attempt.phase === 1);
  assert.equal(firstAttempt.symbol, "SPCXB");
  assert.deepEqual(firstAttempt.event.changes.newQuoteTokens, ["SPCXB"]);
  assert.equal(firstAttempt.event.changes.newQuoteConfigs.length, 1, "a singleton still uses the per-pool projection");
  assert.deepEqual(firstAttempt.event.changes.changedSources, []);
  assert.equal(activationBatches.length, 0, "a pending semantic owner cannot arm first-token tracking");
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(state.fourmeme.capabilities.quoteTokens, [], "the old non-ERC20 baseline remains retryable");

  phase = 2;
  payload = { code: 0, data: [bnb, spcxb, nvdab, soxlb] };
  await runPlatformCapabilityCheck({ dataDir }, options);

  const retryAttempts = attempts.filter((attempt) => attempt.phase === 2);
  assert.deepEqual(retryAttempts.map(({ symbol }) => symbol).sort(), ["NVDAB", "SOXLB", "SPCXB"]);
  assert.equal(retryAttempts.every(({ event }) => event.changes.newQuoteConfigs.length === 1), true);
  assert.equal(
    retryAttempts.find(({ symbol }) => symbol === "SPCXB").event.eventKey,
    firstAttempt.event.eventKey,
    "later siblings do not perturb the original pool event key",
  );
  assert.equal(new Set(retryAttempts.map(({ event }) => event.eventKey)).size, 3);
  assert.equal(activationBatches.length, 1);
  assert.deepEqual(activationBatches[0].map((record) => record.quoteConfig.symbol).sort(), ["NVDAB", "SOXLB", "SPCXB"]);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(state.fourmeme.capabilities.quoteTokens, ["NVDAB", "SOXLB", "SPCXB"]);

  const audit = (await fs.readFile(path.join(dataDir, "platform-capability-events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const firstAttemptCheckpoints = audit.filter((entry) => entry.eventKey === firstAttempt.event.eventKey
    && entry.delivery.status === "checkpoint_committed");
  assert.equal(firstAttemptCheckpoints.length, 1, "only the durably accepted retry commits the child checkpoint");
});

test("Four.meme v3 migration silently removes quote assets that v2 misclassified as factories", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fourmeme-v3-quote-migration-"));
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const configUrl = "https://four.meme/meme-api/v1/public/config";
  const address = "0x55d398326f99059ff775485246999027b3197955";
  const target = {
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    capabilitySchemaVersion: 3,
    apiSources: [{ url: configUrl, parser: "fourmeme-config", authoritativeQuotes: true, requiredForBaseline: true }],
    pagePattern: /$a/,
    schemaMigration: {
      removed: { contracts: [configUrl] },
    },
  };
  const oldQuote = {
    symbol: "USDT",
    nativeSymbol: "USDT",
    address,
    status: "PUBLISH",
    platform: "MEME",
    networkCode: "BSC",
    fees: { deployCost: "0", buyFee: "0.01", sellFee: "0.01", minTradeFee: "0" },
    thresholds: { b0Amount: "4000", totalBAmount: "12000", totalAmount: "1000000000", saleRate: "0.8", reservedNumber: 10, tradeLevel: ["50", "250", "500"] },
    source: { kind: "api", url: configUrl },
  };
  const oldCapabilities = capabilities({
    quoteTokens: ["USDT"],
    quoteConfigs: [oldQuote],
    contracts: [address],
    chains: [{
      name: "BNB Chain",
      chainId: 56,
      environment: "mainnet",
      stage: "supported",
      evidence: "published_network_config",
      sources: [{ kind: "api", url: configUrl }],
      source: { kind: "api", url: configUrl },
    }],
    sourceProvenance: {
      quoteTokens: { USDT: [configUrl] },
      contracts: { [address]: [configUrl] },
      versions: {}, modules: {}, pages: {}, announcements: {}, campaigns: {},
    },
  });
  await fs.writeFile(stateFile, `${JSON.stringify({
    fourmeme: { capabilitySchemaVersion: 2, capabilities: oldCapabilities, checkedAt: "2026-08-10T08:00:00Z" },
  })}\n`);
  const payload = {
    code: 0,
    data: [{
      symbol: "USDT", nativeSymbol: "USDT", symbolAddress: address,
      deployCost: "0", buyFee: "0.01", sellFee: "0.01", minTradeFee: "0",
      b0Amount: "4000", totalBAmount: "12000", totalAmount: "1000000000", saleRate: "0.8",
      reservedNumber: 10, tradeLevel: ["50", "250", "500"],
      status: "PUBLISH", networkCode: "BSC", platform: "MEME",
    }],
  };
  const alerts = [];
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(payload, { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date("2026-08-10T09:00:00Z"),
  });

  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(alerts.length, 0);
  assert.equal(state.fourmeme.capabilitySchemaVersion, 3);
  assert.deepEqual(state.fourmeme.capabilities.contracts, []);
  assert.deepEqual(state.fourmeme.capabilities.quoteTokens, ["USDT"]);
});

test("npm latest parser records only auditable package metadata and guards schema", () => {
  const result = extractNpmPackageCapabilities({
    name: "@four-meme/four-meme-ai",
    version: "1.0.8",
    homepage: "https://four.meme/en/agentic",
    repository: { url: "git+https://github.com/four-meme-community/four-meme-ai.git" },
    scripts: { postinstall: "ignored" },
  });
  assert.deepEqual(result.versions, ["v1.0.8"]);
  assert.deepEqual(result.packages[0], {
    name: "@four-meme/four-meme-ai",
    version: "1.0.8",
    homepage: "https://four.meme/en/agentic",
    repository: "https://github.com/four-meme-community/four-meme-ai",
    source: { kind: "package", url: "https://registry.npmjs.org/@four-meme%2Ffour-meme-ai/latest" },
  });
  assert.throws(() => extractNpmPackageCapabilities({ name: "lookalike", version: "1.0.8" }), /unexpected name/);
});

test("recursively crawls sitemap indexes and tracks canonical page lastmod", async () => {
  const documents = new Map([
    ["https://docs.test/sitemap.xml", `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://docs.test/sub.xml</loc></sitemap></sitemapindex>`],
    ["https://docs.test/sub.xml", `<urlset>
      <url><loc>https://docs.test/product-update/7/</loc><lastmod>2026-07-30T00:00:00Z</lastmod></url>
      <url><loc>https://docs.test/unrelated</loc><lastmod>2026-07-29</lastmod></url>
    </urlset>`],
  ]);
  const fetchImpl = async (url) => response(documents.get(url), { url });
  const pages = await crawlSitemap("https://docs.test/sitemap.xml", fetchImpl, /product-update/);
  assert.deepEqual(pages, [{
    url: "https://docs.test/product-update/7",
    lastmod: "2026-07-30T00:00:00Z",
    source: {
      kind: "sitemap",
      url: "https://docs.test/sitemap.xml",
      sitemap: "https://docs.test/sub.xml",
      path: ["https://docs.test/sitemap.xml", "https://docs.test/sub.xml"],
    },
  }]);
});

test("nested sitemap requests share the source deadline instead of resetting the timeout", async (t) => {
  let elapsedMs = 0;
  const signalBudgets = new WeakMap();
  const requests = [];

  t.mock.method(Date, "now", () => 1_000_000 + elapsedMs);
  t.mock.method(performance, "now", () => elapsedMs);
  t.mock.method(AbortSignal, "timeout", (timeoutMs) => {
    const signal = new AbortController().signal;
    signalBudgets.set(signal, timeoutMs);
    return signal;
  });

  const rootUrl = "https://docs.test/sitemap.xml";
  const childUrl = "https://docs.test/child.xml";
  await fetchPlatformSource(
    { id: "deadline-test", pagePattern: /product-update/ },
    { kind: "docs", url: rootUrl, key: `docs:${rootUrl}` },
    async (url, options) => {
      requests.push({ url, signal: options.signal });
      if (url === rootUrl) {
        return {
          ...response("", { url }),
          text: async () => {
            elapsedMs = 4_000;
            return `<sitemapindex><sitemap><loc>${childUrl}</loc></sitemap></sitemapindex>`;
          },
        };
      }
      return response(
        "<urlset><url><loc>https://docs.test/product-update/first</loc></url></urlset>",
        { url },
      );
    },
    5_000,
  );

  assert.equal(requests.length, 2);
  const [rootRequest, childRequest] = requests;
  const childBudget = signalBudgets.get(childRequest.signal);
  assert.ok(
    childRequest.signal === rootRequest.signal || (Number.isFinite(childBudget) && childBudget <= 1_000),
    `child sitemap received a fresh ${childBudget ?? "unknown"}ms timeout instead of the remaining shared deadline`,
  );
  assert.notEqual(childBudget, 20_000, "nested sitemap must never regain the default 20s timeout");
});

const docsTarget = {
  id: "test",
  name: "Test",
  website: "https://test.invalid",
  sources: ["https://test.invalid/a", "https://test.invalid/b"],
  pagePattern: /product-update/,
};

const run = async (dataDir, fetchImpl, sendAlertsImpl, extra = {}) => runPlatformCapabilityCheck(
  { dataDir },
  {
    targets: [docsTarget],
    fetchImpl,
    sendAlertsImpl,
    logger: quietLogger,
    now: extra.now || (() => new Date("2026-07-31T00:00:00.000Z")),
    ...extra,
  },
);

test("chain baseline is silent, re-adds stay deduplicated, and support-to-deployment alerts once", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-chain-dedup-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const target = {
    id: "chain-test",
    name: "Chain Test",
    website: "https://test.invalid",
    sources: ["https://test.invalid/networks"],
    pagePattern: /$a/,
  };
  const alerts = [];
  let body = "Flap platform supports BNB Chain mainnet (chainId: 56).";
  let minute = 0;
  const check = () => runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response(body, { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date(`2026-08-08T00:${String(minute++).padStart(2, "0")}:00.000Z`),
  });

  await check();
  assert.equal(alerts.length, 0, "the first complete chain snapshot is a silent baseline");

  body = "Add a BNB Chain icon and alphabetically reorder the network logos.";
  await check();
  assert.equal(alerts.length, 0, "presentation churn and a chain removal must stay silent");

  body = "Flap platform supports BNB Chain mainnet (chainId: 56).";
  await check();
  assert.equal(alerts.length, 0, "an already-seen chain reappearing is not new");

  body = "Flap platform supports BNB Chain mainnet (chainId: 56). Flap launchpad supports Base mainnet (chainId: 8453).";
  await check();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].changes.newChains.map(({ name, stage }) => ({ name, stage })), [{ name: "Base", stage: "supported" }]);

  await check();
  assert.equal(alerts.length, 1, "the same chain capability must not repeat");

  body = "Flap platform supports BNB Chain mainnet (chainId: 56). Flap contracts are deployed on Base mainnet (chainId: 8453).";
  await check();
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[1].changes.newChains, []);
  assert.deepEqual(alerts[1].changes.chainStageChanges.map(({ name, fromStage, toStage, direction }) => ({ name, fromStage, toStage, direction })), [{
    name: "Base",
    fromStage: "supported",
    toStage: "deployed",
    direction: "upgrade",
  }]);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(state["chain-test"].capabilities.chains.map(({ name, stage }) => ({ name, stage })), [
    { name: "Base", stage: "deployed" },
    { name: "BNB Chain", stage: "supported" },
  ]);
});

test("adding the chains field to a legacy checkpoint silently seeds durable history", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-chain-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  const legacyCapabilities = capabilities();
  delete legacyCapabilities.chains;
  await fs.writeFile(stateFile, `${JSON.stringify({ legacy: { capabilities: legacyCapabilities, checkedAt: "2026-08-07T00:00:00.000Z" } })}\n`);
  const target = {
    id: "legacy",
    name: "Legacy",
    website: "https://test.invalid",
    sources: ["https://test.invalid/networks"],
    pagePattern: /$a/,
  };
  const alerts = [];
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl: async (url) => response("Flap platform supports BNB Chain mainnet (chainId: 56).", { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(alerts.length, 0);
  assert.deepEqual(state.legacy.capabilities.chains.map(({ name }) => name), ["BNB Chain"]);
  assert.deepEqual(state.legacy.observedChains.map(({ name }) => name), ["BNB Chain"]);
});

test("partial failure preserves only the failed source while successful removals and re-adds remain visible", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-partial-"));
  const alerts = [];
  try {
    let mode = "baseline";
    const fetchImpl = async (url) => {
      if (mode === "partial" && url.endsWith("/b")) throw new Error("source b down");
      const token = url.endsWith("/a")
        ? (mode === "removed" || mode === "partial" ? "" : "Raised token supports $USD1.")
        : "Raised token supports $BNB.";
      return response(token, { url });
    };
    await run(dataDir, fetchImpl, async (_config, event) => alerts.push(event));
    mode = "partial";
    await run(dataDir, fetchImpl, async (_config, event) => alerts.push(event));
    let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    assert.deepEqual(state.test.capabilities.quoteTokens, ["BNB"]);
    assert.equal(state.test.sourceHealth["docs:https://test.invalid/b"].consecutiveFailures, 1);
    assert.equal(state.test.sources["docs:https://test.invalid/b"].checkedAt, "2026-07-31T00:00:00.000Z");
    assert.deepEqual(alerts.at(-1).changes.removedQuoteTokens, ["USD1"]);
    mode = "baseline";
    await run(dataDir, fetchImpl, async (_config, event) => alerts.push(event));
    state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    assert.deepEqual(state.test.capabilities.quoteTokens, ["BNB", "USD1"]);
    assert.deepEqual(alerts.at(-1).changes.newQuoteTokens, ["USD1"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("one policy-blocked source backs off independently while healthy sources keep polling", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-source-backoff-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let current = Date.parse("2026-08-01T00:00:00.000Z");
  let blockB = false;
  const requests = [];
  const errors = [];
  const fetchImpl = async (url) => {
    requests.push({ url, current });
    if (blockB && url.endsWith("/b")) return response("forbidden", { ok: false, status: 403, url });
    return response(url.endsWith("/a") ? "Raised token supports $USD1." : "Raised token supports $BNB.", { url });
  };
  const check = () => runPlatformCapabilityCheck(
    { dataDir, platformCapabilityPollIntervalMs: 30_000 },
    {
      targets: [docsTarget],
      fetchImpl,
      sendAlertsImpl: async () => {},
      logger: { error(message) { errors.push(message); } },
      now: () => new Date(current),
    },
  );

  await check();
  blockB = true;
  current += 30_000;
  await check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const sourceKey = "docs:https://test.invalid/b";
  assert.equal(state.test.sourceHealth[sourceKey].lastErrorStatus, 403);
  assert.equal(Date.parse(state.test.sourceHealth[sourceKey].nextAttemptAt) - current, 15 * 60_000);
  const requestsAfterFailure = requests.length;
  const errorsAfterFailure = errors.length;

  current += 30_000;
  await check();
  assert.equal(requests.length, requestsAfterFailure + 1, "only the healthy source should be requested during source backoff");
  assert.equal(requests.at(-1).url.endsWith("/a"), true);
  assert.equal(errors.length, errorsAfterFailure, "a skipped source must not repeat its prior error log");

  blockB = false;
  current += 14 * 60_000 + 30_000;
  await check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.test.sourceHealth[sourceKey].status, "healthy");
  assert.equal(state.test.sourceHealth[sourceKey].nextAttemptAt, null);
});

test("all-source failure never creates or advances a capability baseline", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-all-fail-"));
  try {
    const goodFetch = async (url) => response(url.endsWith("/a") ? "Raised token supports $USD1." : "Raised token supports $BNB.", { url });
    await run(dataDir, goodFetch, async () => {});
    const before = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    await run(dataDir, async () => { throw new Error("offline"); }, async () => {}, { now: () => new Date("2026-08-01T00:00:00.000Z") });
    const after = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    assert.deepEqual(after.test.capabilities, before.test.capabilities);
    assert.equal(after.test.checkedAt, before.test.checkedAt);
    assert.equal(after.test.sourceHealth["docs:https://test.invalid/a"].consecutiveFailures, 1);

    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-no-baseline-"));
    try {
      await run(emptyDir, async () => { throw new Error("offline"); }, async () => {});
      const emptyState = JSON.parse(await fs.readFile(path.join(emptyDir, "platform-capability-state.json"), "utf8"));
      assert.equal("test" in emptyState, false);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("all-source outage uses compact platform backoff and probes again when due", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-outage-backoff-"));
  try {
    let fetches = 0;
    let offline = true;
    const errors = [];
    const fetchImpl = async (url) => {
      fetches += 1;
      if (offline) throw new Error("fetch failed");
      return response("Raised token supports $BNB.", { url });
    };
    const check = (timestamp, extra = {}) => runPlatformCapabilityCheck(
      { dataDir, platformCapabilityPollIntervalMs: 30_000 },
      {
        targets: [docsTarget],
        fetchImpl,
        sendAlertsImpl: async () => {},
        logger: { error(message) { errors.push(message); } },
        now: () => new Date(timestamp),
        ...extra,
      },
    );

    await check("2026-08-01T00:00:00.000Z");
    assert.equal(fetches, 2);
    assert.equal(errors.length, 1, "one platform outage must produce one compact log line");
    let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    assert.equal(state._health.platforms.test.nextAttemptAt, "2026-08-01T00:00:30.000Z");
    assert.equal("test" in state, false, "failed cold start must not create a capability baseline");

    await check("2026-08-01T00:00:10.000Z");
    assert.equal(fetches, 2, "backoff must skip every source instead of creating more sockets");
    offline = false;
    await check("2026-08-01T00:00:30.000Z");
    assert.equal(fetches, 4);
    state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    assert.equal(state._health.platforms.test.status, "healthy");
    assert.equal(state._health.platforms.test.nextAttemptAt, null);
    assert.deepEqual(state.test.capabilities.quoteTokens, ["BNB"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup recovery bypasses only transport backoff and preserves HTTP policy cooldowns", async (t) => {
  const policyDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-policy-backoff-"));
  const transportDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-transport-restart-"));
  t.after(() => Promise.all([
    fs.rm(policyDir, { recursive: true, force: true }),
    fs.rm(transportDir, { recursive: true, force: true }),
  ]));
  const check = (dataDir, fetchImpl, timestamp, extra = {}) => runPlatformCapabilityCheck(
    { dataDir, platformCapabilityPollIntervalMs: 30_000 },
    {
      targets: [docsTarget],
      fetchImpl,
      sendAlertsImpl: async () => {},
      logger: quietLogger,
      now: () => new Date(timestamp),
      ...extra,
    },
  );

  let policyFetches = 0;
  const policyFetch = async (url) => {
    policyFetches += 1;
    return response("rate limited", { ok: false, status: 429, url });
  };
  await check(policyDir, policyFetch, "2026-08-01T00:00:00.000Z");
  let state = JSON.parse(await fs.readFile(path.join(policyDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state._health.platforms.test.failureKind, "policy_or_source");
  assert.equal(state._health.platforms.test.lastErrorStatus, 429);
  await check(policyDir, policyFetch, "2026-08-01T00:00:10.000Z", { ignoreTransportBackoff: true });
  assert.equal(policyFetches, 2, "startup must not bypass a persisted HTTP 429 cooldown");

  let transportFetches = 0;
  const transportFetch = async (url) => {
    transportFetches += 1;
    if (transportFetches <= 2) throw new Error("fetch failed: EADDRNOTAVAIL");
    return response("Raised token supports $BNB.", { url });
  };
  await check(transportDir, transportFetch, "2026-08-01T00:00:00.000Z");
  state = JSON.parse(await fs.readFile(path.join(transportDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state._health.platforms.test.failureKind, "transport");
  await check(transportDir, transportFetch, "2026-08-01T00:00:10.000Z", { ignoreTransportBackoff: true });
  assert.equal(transportFetches, 4, "startup should immediately probe a persisted transport outage");
  state = JSON.parse(await fs.readFile(path.join(transportDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state._health.platforms.test.status, "healthy");
});

test("delivery rejection records an audit failure and leaves the old snapshot for retry", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-delivery-"));
  try {
    let body = "Raised token supports $BNB.";
    const fetchImpl = async (url) => response(body, { url });
    await run(dataDir, fetchImpl, async () => {});
    const before = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    body = "Raised token supports $BNB and $USD1.";
    await run(dataDir, fetchImpl, async () => { throw new Error("telegram timeout"); });
    const after = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    assert.deepEqual(after.test, before.test);
    const audit = (await fs.readFile(path.join(dataDir, "platform-capability-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(audit.map((item) => item.delivery.status), ["pending", "failed"]);
    assert.equal(audit[0].eventKey, audit[1].eventKey);
    assert.equal(audit[0].delivery.baselineCommitted, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("official Flap contract changes with explicit BSC evidence register discovery and retain the old baseline when registration fails", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-contract-discovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    sources: ["https://docs.test/deployments"],
    pagePattern: /$a/,
  };
  const address = "0x1111111111111111111111111111111111111111";
  const alerts = [];
  const discoveries = [];
  let body = "Flap deployment documentation.";
  let failDiscovery = true;
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(body, { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    onContractDiscovery: async (signal) => {
      discoveries.push(signal);
      if (failDiscovery) throw new Error("BSC registry unavailable");
    },
    logger: quietLogger,
    now: () => new Date("2026-08-08T03:00:00.000Z"),
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  body = `BSC mainnet chainId: 56 Vault Factory ${address}`;
  await runPlatformCapabilityCheck({ dataDir }, options);

  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(state.flap.capabilities.contracts, [], "a failed discovery must not consume the new contract baseline");
  assert.equal(alerts.length, 1);
  assert.equal(discoveries.length, 1);
  assert.deepEqual(discoveries[0], {
    addresses: [address],
    platformName: "Flap",
    sourceTrust: "official_verified",
    sourceId: "platform-capability:flap",
    sourceUrl: "https://docs.test/deployments",
    chainId: 56,
    observedAt: "2026-08-08T03:00:00.000Z",
  });

  failDiscovery = false;
  await runPlatformCapabilityCheck({ dataDir }, options);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(state.flap.capabilities.contracts, [address]);
  assert.equal(alerts.length, 2, "the unchanged source must be retried until discovery registration succeeds");
  assert.equal(discoveries.length, 2);
  const audit = (await fs.readFile(path.join(dataDir, "platform-capability-events.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(audit.some((entry) => entry.delivery.status === "discovery_failed" && entry.delivery.baselineCommitted === false), true);
  assert.equal(audit.at(-1).delivery.status, "checkpoint_committed");
});

test("Flap contract discovery preserves an explicit Morph chain instead of relabeling it as BSC", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-morph-contract-discovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sourceUrl = "https://docs.test/morph/deployments";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh/morph/board",
    sources: [{ url: sourceUrl, chainId: 2818 }],
    pagePattern: /$a/,
  };
  const address = "0x2222222222222222222222222222222222222222";
  const discoveries = [];
  let body = "Flap Morph deployment documentation.";
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(body, { url }),
    sendAlertsImpl: async () => {},
    onContractDiscovery: async (signal) => discoveries.push(signal),
    logger: quietLogger,
    now: () => new Date("2026-08-12T03:00:00.000Z"),
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  body = `Morph Portal ${address}`;
  await runPlatformCapabilityCheck({ dataDir }, options);

  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].chainId, 2818);
  assert.deepEqual(discoveries[0].addresses, [address]);
});

test("Flap contract present in BSC and Morph sources is not injected into either chain", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-ambiguous-contract-discovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const bscUrl = "https://docs.test/bsc/deployments";
  const morphUrl = "https://docs.test/morph/deployments";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    sources: [{ url: bscUrl, chainId: 56 }, { url: morphUrl, chainId: 2818 }],
    pagePattern: /$a/,
  };
  const address = "0x3333333333333333333333333333333333333333";
  const bodies = new Map([[bscUrl, "BSC deployments"], [morphUrl, "Morph deployments"]]);
  const discoveries = [];
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(bodies.get(url), { url }),
    sendAlertsImpl: async () => {},
    onContractDiscovery: async (signal) => discoveries.push(signal),
    logger: quietLogger,
    now: () => new Date("2026-08-12T03:01:00.000Z"),
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  bodies.set(bscUrl, `BSC Vault Factory ${address}`);
  bodies.set(morphUrl, `Morph Portal ${address}`);
  await runPlatformCapabilityCheck({ dataDir }, options);

  assert.deepEqual(discoveries, []);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.deepEqual(state.flap.capabilities.contracts, [address], "ambiguous discovery is skipped but the observed capability is checkpointed");
});

test("Flap contract without source-level chain evidence is not injected into BSC", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-unscoped-contract-discovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sourceUrl = "https://docs.test/deployments";
  const target = {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    sources: [sourceUrl],
    pagePattern: /$a/,
  };
  const address = "0x5555555555555555555555555555555555555555";
  const discoveries = [];
  let body = "Flap deployment documentation.";
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(body, { url }),
    sendAlertsImpl: async () => {},
    onContractDiscovery: async (signal) => discoveries.push(signal),
    logger: quietLogger,
    now: () => new Date("2026-08-12T03:01:30.000Z"),
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  body = `Vault Factory ${address}`;
  await runPlatformCapabilityCheck({ dataDir }, options);

  assert.deepEqual(discoveries, []);
});

test("Four.meme platform contracts remain explicitly routed to BSC", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fourmeme-contract-discovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sourceUrl = "https://docs.test/fourmeme/deployments";
  const target = {
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    sources: [sourceUrl],
    pagePattern: /$a/,
  };
  const address = "0x4444444444444444444444444444444444444444";
  const discoveries = [];
  let body = "Four.meme deployment documentation.";
  const options = {
    targets: [target],
    fetchImpl: async (url) => response(body, { url }),
    sendAlertsImpl: async () => {},
    onContractDiscovery: async (signal) => discoveries.push(signal),
    logger: quietLogger,
    now: () => new Date("2026-08-12T03:02:00.000Z"),
  };

  await runPlatformCapabilityCheck({ dataDir }, options);
  body = `Four.meme Launcher ${address}`;
  await runPlatformCapabilityCheck({ dataDir }, options);

  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].chainId, 56);
  assert.deepEqual(discoveries[0].addresses, [address]);
});

test("legacy Four.meme migration catches up every structured capability exactly once", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-migrate-"));
  const stateFile = path.join(dataDir, "platform-capability-state.json");
  const target = {
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    sources: ["https://docs.test/history"],
    liveSources: ["https://four.meme/en/agentic"],
    apiSources: [{ url: "https://four.meme/config", parser: "fourmeme-config", authoritativeQuotes: true, requiredForBaseline: true }],
    pagePattern: /product-update/,
  };
  const api = {
    code: 0,
    data: [
      { symbol: "BNB", symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", status: "PUBLISH", networkCode: "BSC", platform: "MEME" },
      { symbol: "UUSD", symbolAddress: "0x61a10e8556bed032ea176330e7f17d6a12a10000", status: "PUBLISH", networkCode: "BSC", platform: "MEME" },
      { symbol: "NVDAB", symbolAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", status: "PUBLISH", networkCode: "BSC", platform: "MEME" },
      { symbol: "CAKE", symbolAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", status: "INIT", networkCode: "BSC", platform: "MEME" },
    ],
  };
  const oldCapabilities = capabilities({ quoteTokens: ["BNB", "CAKE"], modules: ["Historical Mode"] });
  await fs.writeFile(stateFile, `${JSON.stringify({ fourmeme: { capabilities: oldCapabilities, checkedAt: "2026-07-30T00:00:00.000Z" } })}\n`);
  const alerts = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/config")) return response(api, { url });
    if (url.includes("agentic")) return response("Agent Skill Creator Mode", { url });
    return response("Multi-Token Trading supports $BNB and $CAKE. Product history.", { url });
  };
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl,
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  assert.equal(alerts.length, 4);
  const quoteAlerts = alerts.filter((event) => event.changes.newQuoteConfigs.length);
  const [residual] = alerts.filter((event) => !event.changes.newQuoteConfigs.length);
  assert.deepEqual(quoteAlerts.map((event) => event.changes.newQuoteConfigs[0].symbol), ["BNB", "NVDAB", "UUSD"]);
  assert.deepEqual(quoteAlerts.map((event) => event.changes.newQuoteTokens), [[], ["NVDAB"], ["UUSD"]]);
  assert.deepEqual(residual.changes.removedQuoteTokens, ["CAKE"]);
  assert.ok(residual.changes.newModules.includes("Agentic"));
  assert.ok(residual.changes.newModules.includes("Creator Mode"));
  assert.ok(residual.changes.removedModules.includes("Historical Mode"));
  assert.equal(new Set(alerts.map((event) => event.eventKey)).size, 4);
  await runPlatformCapabilityCheck({ dataDir }, {
    targets: [target],
    fetchImpl,
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
    now: () => new Date("2026-07-31T00:01:00.000Z"),
  });
  assert.equal(alerts.length, 4);
  const migrated = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.deepEqual(migrated.fourmeme.capabilities.quoteTokens, ["BNB", "NVDAB", "UUSD"]);
  assert.ok(migrated.fourmeme.sources);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("semantic fingerprints ignore copy churn while sitemap lastmod edits alert", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fingerprint-"));
  const baseTarget = {
    id: "fingerprint",
    name: "Fingerprint",
    website: "https://test.invalid",
    sources: ["https://docs.test/sitemap.xml"],
    pagePattern: /product-update/,
  };
  const extendedTarget = { ...baseTarget, liveSources: ["https://test.invalid/campaign"] };
  let lastmod = "2026-07-30";
  let campaign = "Campaign copy A";
  const fetchImpl = async (url) => {
    if (url.includes("campaign")) return response(`<main>${campaign}</main>`, { url });
    return response(`<urlset><url><loc>https://docs.test/product-update/7/</loc><lastmod>${lastmod}</lastmod></url></urlset>`, { url });
  };
  const alerts = [];
  await runPlatformCapabilityCheck({ dataDir }, { targets: [baseTarget], fetchImpl, sendAlertsImpl: async (_c, event) => alerts.push(event), logger: quietLogger });
  await runPlatformCapabilityCheck({ dataDir }, { targets: [extendedTarget], fetchImpl, sendAlertsImpl: async (_c, event) => alerts.push(event), logger: quietLogger });
  assert.equal(alerts.length, 0);
  campaign = "Campaign copy B";
  lastmod = "2026-07-31";
  await runPlatformCapabilityCheck({ dataDir }, { targets: [extendedTarget], fetchImpl, sendAlertsImpl: async (_c, event) => alerts.push(event), logger: quietLogger });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].changes.changedSources.includes("https://test.invalid/campaign"), false);
  assert.ok(alerts[0].changes.updatedPages.includes("https://docs.test/product-update/7"));
  assert.ok(alerts[0].changes.newContentFingerprints.length >= 1);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("a source fingerprint change without a semantic capability change stays silent", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fingerprint-only-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const target = {
    id: "fingerprint-only",
    name: "Fingerprint Only",
    website: "https://test.invalid",
    sources: ["https://test.invalid/docs"],
    pagePattern: /$a/,
  };
  const alerts = [];
  const options = {
    targets: [target],
    fetchImpl: async (url) => response("VaultFactoryBaseV2", { url }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    logger: quietLogger,
  };
  await runPlatformCapabilityCheck({ dataDir }, options);

  const stateFile = path.join(dataDir, "platform-capability-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  state["fingerprint-only"].capabilities.sourceFingerprints[0].fingerprint = "legacy-fingerprint";
  await fs.writeFile(stateFile, `${JSON.stringify(state)}\n`);

  await runPlatformCapabilityCheck({ dataDir }, options);
  assert.equal(alerts.length, 0);
});

test("one failed child sitemap preserves its cached pages while healthy children keep updating", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-sitemap-partial-"));
  const target = {
    id: "partial-sitemap",
    name: "Partial Sitemap",
    website: "https://docs.test",
    sources: ["https://docs.test/root.xml"],
    pagePattern: /product-update/,
  };
  let failB = false;
  let lastmodA = "2026-07-30";
  const fetchImpl = async (url) => {
    if (url.endsWith("root.xml")) return response(`<sitemapindex><sitemap><loc>https://docs.test/a.xml</loc></sitemap><sitemap><loc>https://docs.test/b.xml</loc></sitemap></sitemapindex>`, { url });
    if (url.endsWith("a.xml")) return response(`<urlset><url><loc>https://docs.test/product-update/a</loc><lastmod>${lastmodA}</lastmod></url></urlset>`, { url });
    if (failB) throw new Error("b sitemap down");
    return response(`<urlset><url><loc>https://docs.test/product-update/b</loc><lastmod>2026-07-30</lastmod></url></urlset>`, { url });
  };
  const alerts = [];
  try {
    await runPlatformCapabilityCheck({ dataDir }, { targets: [target], fetchImpl, sendAlertsImpl: async (_c, event) => alerts.push(event), logger: quietLogger });
    failB = true;
    lastmodA = "2026-07-31";
    await runPlatformCapabilityCheck({ dataDir }, { targets: [target], fetchImpl, sendAlertsImpl: async (_c, event) => alerts.push(event), logger: quietLogger });
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
    assert.deepEqual(state["partial-sitemap"].capabilities.pages, [
      "https://docs.test/product-update/a",
      "https://docs.test/product-update/b",
    ]);
    assert.equal(state["partial-sitemap"].sourceHealth["docs:https://docs.test/root.xml"].partialFailures.length, 1);
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].changes.removedPages, []);
    assert.ok(alerts[0].changes.updatedPages.includes("https://docs.test/product-update/a"));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("atomic JSON writer writes a temporary file before rename", async () => {
  const calls = [];
  const fakeFs = {
    async mkdir(directory) { calls.push(["mkdir", directory]); },
    async writeFile(file, contents) { calls.push(["write", file, contents]); },
    async rename(from, to) { calls.push(["rename", from, to]); },
    async unlink(file) { calls.push(["unlink", file]); },
  };
  await atomicWriteJson("/tmp/platform-atomic/state.json", { ok: true }, fakeFs);
  assert.equal(calls[0][0], "mkdir");
  assert.match(calls[1][1], /state\.json\..+\.tmp$/);
  assert.deepEqual(calls[2], ["rename", calls[1][1], "/tmp/platform-atomic/state.json"]);
  assert.equal(calls.some(([operation]) => operation === "unlink"), false);
});

test("scheduled platform ticks coalesce into one non-concurrent catch-up cycle", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-scheduler-coalesce-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let intervalTick;
  t.mock.method(globalThis, "setInterval", (callback) => {
    intervalTick = callback;
    return { unref() {} };
  });

  let requests = 0;
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const monitor = createPlatformCapabilityMonitor({
    dataDir,
    platformCapabilityPollIntervalMs: 10,
    platformCapabilityConcurrency: 1,
  }, {
    targets: [{
      id: "scheduler-test",
      name: "Scheduler Test",
      website: "https://scheduler.test",
      sources: ["https://scheduler.test/docs"],
      pagePattern: /$a/,
    }],
    logger: quietLogger,
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      requests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (requests === 1) {
          markFirstStarted();
          await firstBlocked;
        }
        return response("VaultFactoryBaseV2", { url });
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

  assert.equal(requests, 2, "many overlapping timer ticks collapse into one immediate follow-up");
  assert.equal(maximumActive, 1, "the catch-up cycle must never overlap the active cycle");
});

const fastFlapTarget = (marketSources, sources = []) => ({
  id: "flap",
  name: "Flap",
  website: "https://flap.sh",
  capabilitySchemaVersion: 4,
  marketSources,
  sources,
  pagePattern: /$a/,
});

const fastFourTarget = () => ({
  id: "fourmeme",
  name: "Four.meme",
  website: "https://four.meme",
  capabilitySchemaVersion: 4,
  apiSources: [{
    url: "https://four.meme/meme-api/v1/public/config",
    parser: "fourmeme-config",
    authoritativeQuotes: true,
    requiredForBaseline: true,
  }],
  pagePattern: /$a/,
});

const flapBoardPayload = (factory, quote) => JSON.stringify({
  initialBoard: {
    items: [{
      coin: { address: "0x1111111111111111111111111111111111111111" },
      quoteToken: quote,
      vault: { vaultFactory: factory, vaultFactoryCategory: ["index"] },
    }],
  },
});

const fourConfigPayload = (items) => ({ code: 0, data: items.map(({ symbol, address }) => ({
  symbol,
  nativeSymbol: symbol,
  symbolAddress: address,
  deployCost: "0",
  buyFee: "0.01",
  sellFee: "0.01",
  totalBAmount: "18",
  totalAmount: "1000000000",
  saleRate: "0.8",
  status: "PUBLISH",
  networkCode: "BSC",
  platform: "MEME",
})) });

test("structured fast lane staggers three URLs at 500ms with a persistent 1500ms per-source ceiling", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fast-rate-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let current = Date.parse("2026-08-20T10:00:00.000Z");
  const requests = [];
  const lastRequest = new Map();
  let synthetic429s = 0;
  let stateWrites = 0;
  const bscBoard = "https://flap.sh/board";
  const morphBoard = "https://flap.sh/morph/board";
  const configUrl = "https://four.meme/meme-api/v1/public/config";
  const bodies = new Map([
    [bscBoard, flapBoardPayload("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
    [morphBoard, flapBoardPayload("0xcccccccccccccccccccccccccccccccccccccccc", "0xdddddddddddddddddddddddddddddddddddddddd")],
    [configUrl, fourConfigPayload([{ symbol: "BNB", address: "0x0000000000000000000000000000000000000000" }])],
  ]);
  const monitor = createPlatformCapabilityMonitor({
    dataDir,
    platformCapabilityFastSchedulerIntervalMs: 500,
    platformCapabilityFastSourceIntervalMs: 1_500,
    platformCapabilityFastRequestTimeoutMs: 2_000,
  }, {
    autoStart: false,
    targets: [
      fastFlapTarget([{ url: bscBoard, chainId: 56 }, { url: morphBoard, chainId: 2818, requiredForBaseline: false }]),
      fastFourTarget(),
    ],
    now: () => new Date(current),
    logger: quietLogger,
    sendAlertsImpl: async () => {},
    atomicWriteJsonImpl: async (...args) => {
      stateWrites += 1;
      return atomicWriteJson(...args);
    },
    fetchImpl: async (url, options) => {
      const previous = lastRequest.get(url);
      if (Number.isFinite(previous) && current - previous < 1_500) {
        synthetic429s += 1;
        return response("rate limited", { ok: false, status: 429, url, headers: { "retry-after": "60" } });
      }
      lastRequest.set(url, current);
      requests.push({ url, at: current });
      const etag = `\"${Buffer.from(url).toString("hex").slice(0, 16)}\"`;
      if (options.headers["if-none-match"] === etag) return response("", { ok: false, status: 304, url, headers: { etag } });
      return response(bodies.get(url), { url, headers: { etag } });
    },
  });

  for (let tick = 0; tick < 240; tick += 1) {
    await monitor.checkFast();
    current += 500;
  }

  assert.equal(synthetic429s, 0);
  assert.equal(requests.length, 240, "the lane emits one request per 500ms tick, never a burst");
  for (const url of [bscBoard, morphBoard, configUrl]) {
    const sourceRequests = requests.filter((item) => item.url === url);
    assert.equal(sourceRequests.length, 80);
    assert.equal(sourceRequests.slice(1).every((item, index) => item.at - sourceRequests[index].at >= 1_500), true);
  }
  assert.ok(stateWrites <= 15, `240 unchanged source polls should need at most 15 bounded telemetry checkpoints, received ${stateWrites}`);
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const persistedFastSources = [
    durable.flap.sources[`market:${bscBoard}`],
    durable.flap.sources[`market:${morphBoard}`],
    durable.fourmeme.sources[`api:${configUrl}`],
  ];
  assert.equal(persistedFastSources.every((source) => (
    current - Date.parse(source.checkedAt) <= 30_000
  )), true, "each stable fast source keeps a persisted telemetry checkpoint no older than 30 seconds");
});

test("a blocked slow documentation fetch cannot delay the structured fast lane", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fast-independent-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const docs = "https://docs.flap.sh/slow";
  let releaseDocs;
  const docsBlocked = new Promise((resolve) => { releaseDocs = resolve; });
  let markDocsStarted;
  const docsStarted = new Promise((resolve) => { markDocsStarted = resolve; });
  const requested = [];
  const monitor = createPlatformCapabilityMonitor({
    dataDir,
    platformCapabilityPollIntervalMs: 5_000,
    platformCapabilityConcurrency: 1,
  }, {
    autoStart: false,
    targets: [fastFlapTarget([{ url: board, chainId: 56 }], [docs])],
    now: () => new Date("2026-08-20T10:00:00.000Z"),
    logger: quietLogger,
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === docs) {
        markDocsStarted();
        await docsBlocked;
        return response("VaultFactoryBaseV2", { url });
      }
      return response(flapBoardPayload("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), { url, headers: { etag: "\"board-a\"" } });
    },
  });

  const slowCheck = monitor.check();
  await docsStarted;
  await monitor.checkFast();
  assert.deepEqual(requested, [docs, board]);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.flap.sources[`market:${board}`].initialized, true);
  releaseDocs();
  await slowCheck;
});

test("Flap fast confirmation keeps the first observation deadline and deduplicates conditional 304s", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fast-flap-sla-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const board = "https://flap.sh/board";
  const factoryA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const factoryB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const quoteA = "0xcccccccccccccccccccccccccccccccccccccccc";
  const quoteB = "0xdddddddddddddddddddddddddddddddddddddddd";
  let current = Date.parse("2026-08-20T10:00:00.000Z");
  let requestCount = 0;
  let stateWrites = 0;
  const alerts = [];
  const dependencies = {
    autoStart: false,
    targets: [fastFlapTarget([{ url: board, chainId: 56 }])],
    now: () => new Date(current),
    logger: quietLogger,
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
    resolveFlapQuoteAssetMetadata: async ({ address }) => ({
      name: address === quoteA ? "Quote A" : "Quote B",
      symbol: address === quoteA ? "QA" : "QB",
      decimals: 18,
    }),
    atomicWriteJsonImpl: async (...args) => {
      stateWrites += 1;
      return atomicWriteJson(...args);
    },
    fetchImpl: async (url, options) => {
      requestCount += 1;
      if (requestCount === 1) return response(flapBoardPayload(factoryA, quoteA), { url, headers: { etag: "\"a\"" } });
      if (requestCount === 2) return response(JSON.stringify({
        initialBoard: { items: [
          JSON.parse(flapBoardPayload(factoryA, quoteA)).initialBoard.items[0],
          JSON.parse(flapBoardPayload(factoryB, quoteB)).initialBoard.items[0],
        ] },
      }), { url, headers: { etag: "\"b\"" } });
      assert.equal(options.headers["if-none-match"], "\"b\"");
      return response("", { ok: false, status: 304, url, headers: { etag: "\"b\"" } });
    },
  };
  const monitor = createPlatformCapabilityMonitor({ dataDir }, dependencies);

  await monitor.checkFast();
  current += 1_500;
  await monitor.checkFast();
  assert.equal(alerts.length, 0, "the first changed Board observation remains pending");
  assert.equal(stateWrites, 2, "the first pending observation must be durable before restart");
  monitor.stop();
  current += 1_500;
  const restarted = createPlatformCapabilityMonitor({ dataDir }, dependencies);
  await restarted.checkFast();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].deliverySla, {
    startedAt: "2026-08-20T10:00:01.500Z",
    deadlineAt: "2026-08-20T10:00:05.000Z",
    budgetMs: 5_000,
    pollAllowanceMs: 1_500,
    basis: "critical_source_poll",
  });
  current += 1_500;
  await restarted.checkFast();
  assert.equal(alerts.length, 1, "unchanged conditional observations never repeat the event");
  assert.equal(stateWrites, 3, "confirmed candidate heartbeats must not rewrite the full state");
  restarted.stop();
});

test("Four.meme config fast updates share the producer deadline and remain silent on 304", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fast-four-sla-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let current = Date.parse("2026-08-20T10:00:00.000Z");
  let requestCount = 0;
  const alerts = [];
  const bnb = { symbol: "BNB", address: "0x0000000000000000000000000000000000000000" };
  const usd1 = { symbol: "USD1", address: "0x1111111111111111111111111111111111111111" };
  const monitor = createPlatformCapabilityMonitor({ dataDir }, {
    autoStart: false,
    targets: [fastFourTarget()],
    now: () => new Date(current),
    logger: quietLogger,
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    fetchImpl: async (url, options) => {
      requestCount += 1;
      if (requestCount === 1) return response(fourConfigPayload([bnb]), { url, headers: { etag: "\"a\"" } });
      if (requestCount === 2) return response(fourConfigPayload([bnb, usd1]), { url, headers: { etag: "\"b\"" } });
      assert.equal(options.headers["if-none-match"], "\"b\"");
      return response("", { ok: false, status: 304, url, headers: { etag: "\"b\"" } });
    },
  });

  await monitor.checkFast();
  current += 1_500;
  await monitor.checkFast();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].deliverySla, {
    startedAt: "2026-08-20T10:00:01.500Z",
    deadlineAt: "2026-08-20T10:00:05.000Z",
    budgetMs: 5_000,
    pollAllowanceMs: 1_500,
    basis: "critical_source_poll",
  });
  current += 1_500;
  await monitor.checkFast();
  assert.equal(alerts.length, 1);
});

test("Four.meme optional web 403s use a persistent quiet circuit without degrading healthy fast coverage", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-four-optional-circuit-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const liveUrl = "https://four.meme/en/agentic";
  const bnb = { symbol: "BNB", address: "0x0000000000000000000000000000000000000000" };
  const usd1 = { symbol: "USD1", address: "0x1111111111111111111111111111111111111111" };
  const target = { ...fastFourTarget(), liveSources: [liveUrl] };
  let current = Date.parse("2026-08-20T10:00:00.000Z");
  let configRows = [bnb];
  let configBlocked = false;
  let liveBlocked = true;
  let liveRequests = 0;
  const alerts = [];
  const errors = [];
  const dependencies = {
    targets: [target],
    now: () => new Date(current),
    logger: { error(message) { errors.push(message); } },
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    fetchImpl: async (url) => {
      if (url === liveUrl) {
        liveRequests += 1;
        return liveBlocked
          ? response("forbidden", { ok: false, status: 403, url })
          : response("Agentic launch is now live", { url });
      }
      return configBlocked
        ? response("forbidden", { ok: false, status: 403, url })
        : response(fourConfigPayload(configRows), { url });
    },
  };
  const check = (sourceLane, extra = {}) => runPlatformCapabilityCheck(
    { dataDir, platformCapabilityPollIntervalMs: 30_000 },
    { ...dependencies, sourceLane, ...extra },
  );

  await check("fast");
  await check("slow");
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const liveKey = `live:${liveUrl}`;
  assert.equal(state._health.platforms.fourmeme.status, "healthy");
  assert.equal(state._health.platforms.fourmeme.coverageStatus, "complete");
  assert.equal(state._health.platforms.fourmeme.optionalCircuitOpenCount, 1);
  assert.equal(state.fourmeme.sourceHealth[liveKey].circuitOpen, true);
  assert.equal(state.fourmeme.sourceHealth[liveKey].backoffMs, 15 * 60_000);
  assert.equal(errors.length, 1, "opening the optional circuit logs once");
  assert.match(errors[0], /optional web HTTP 403 circuit opened/);

  current += 15 * 60_000;
  await check("slow");
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.fourmeme.sourceHealth[liveKey].backoffMs, 60 * 60_000);
  assert.equal(errors.length, 1, "an open circuit does not repeat the same 403 log");

  current += 30 * 60_000;
  await check("slow", { ignoreTransportBackoff: true });
  assert.equal(liveRequests, 2, "restart probing never bypasses a persisted HTTP policy circuit");
  configRows = [bnb, usd1];
  await check("fast");
  assert.equal(alerts.length, 1, "the structured fast lane still discovers a new quote while the page circuit is open");
  assert.deepEqual(alerts[0].changes.newQuoteTokens, ["USD1"]);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state._health.platforms.fourmeme.status, "healthy");

  current = Date.parse(state.fourmeme.sourceHealth[liveKey].nextAttemptAt);
  liveBlocked = false;
  await check("slow");
  assert.equal(alerts.length, 2, "a due recovery probe still discovers a page-only capability");
  assert.deepEqual(alerts[1].changes.newModules, ["Agentic"]);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.fourmeme.sourceHealth[liveKey].status, "healthy");
  assert.equal(state.fourmeme.sourceHealth[liveKey].circuitOpen, false);

  current += 1_500;
  configBlocked = true;
  await check("fast");
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state._health.platforms.fourmeme.status, "partial", "required fast coverage remains an honest partial state");
  assert.equal(state._health.platforms.fourmeme.coverageStatus, "partial");
});

test("fast source Retry-After circuit persists per URL across monitor restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-fast-circuit-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let current = Date.parse("2026-08-20T10:00:00.000Z");
  let requests = 0;
  let stateWrites = 0;
  const bnb = { symbol: "BNB", address: "0x0000000000000000000000000000000000000000" };
  const dependencies = {
    autoStart: false,
    targets: [fastFourTarget()],
    now: () => new Date(current),
    logger: quietLogger,
    sendAlertsImpl: async () => {},
    atomicWriteJsonImpl: async (...args) => {
      stateWrites += 1;
      return atomicWriteJson(...args);
    },
    fetchImpl: async (url, options) => {
      requests += 1;
      if (requests === 1) return response(fourConfigPayload([bnb]), { url, headers: { etag: "\"a\"" } });
      if (requests === 2) return response("rate limited", { ok: false, status: 429, url, headers: { "retry-after": "1800" } });
      assert.equal(options.headers["if-none-match"], "\"a\"");
      return response("", { ok: false, status: 304, url, headers: { etag: "\"a\"" } });
    },
  };
  const first = createPlatformCapabilityMonitor({ dataDir }, dependencies);
  await first.checkFast();
  current += 1_500;
  await first.checkFast();
  assert.equal(stateWrites, 2, "baseline and 429 circuit must each be persisted immediately");
  first.stop();

  let state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  const sourceKey = "api:https://four.meme/meme-api/v1/public/config";
  assert.equal(state.fourmeme.sourceHealth[sourceKey].sourceRateLimited, true);
  assert.equal(state.fourmeme.sourceHealth[sourceKey].retryAfterMs, 1_800_000);
  assert.equal(Date.parse(state.fourmeme.sourceHealth[sourceKey].nextAttemptAt) - current, 1_800_000);

  current += 1_500;
  const restarted = createPlatformCapabilityMonitor({ dataDir }, dependencies);
  await restarted.checkFast();
  assert.equal(requests, 2, "a restart must not bypass the persisted URL circuit");
  assert.equal(stateWrites, 2, "a skipped source inside its persisted circuit must not rewrite telemetry");
  current = Date.parse(state.fourmeme.sourceHealth[sourceKey].nextAttemptAt);
  await restarted.checkFast();
  assert.equal(requests, 3);
  assert.equal(stateWrites, 3, "circuit recovery must become durable immediately");
  state = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(state.fourmeme.sourceHealth[sourceKey].status, "healthy");
  assert.equal(state.fourmeme.sourceHealth[sourceKey].sourceRateLimited, false);
});

test("platform stop drains slow and fast lanes and cancels their queued reruns", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-stop-drain-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const docs = "https://docs.flap.sh/stop-drain";
  const board = "https://flap.sh/board";
  const factory = "0x1111111111111111111111111111111111111111";
  const quote = "0x2222222222222222222222222222222222222222";
  const intervalTicks = [];
  t.mock.method(globalThis, "setInterval", (callback) => {
    intervalTicks.push(callback);
    return { unref() {} };
  });
  t.mock.method(globalThis, "clearInterval", () => {});
  const requests = new Map([[docs, 0], [board, 0]]);
  const releases = new Map();
  const starts = new Map();
  for (const url of requests.keys()) {
    let release;
    releases.set(url, new Promise((resolve) => { release = resolve; }));
    releases.set(`${url}:resolve`, release);
    let markStarted;
    starts.set(url, new Promise((resolve) => { markStarted = resolve; }));
    starts.set(`${url}:resolve`, markStarted);
  }
  const monitor = createPlatformCapabilityMonitor({
    dataDir,
    platformCapabilityPollIntervalMs: 10_000,
    platformCapabilityFastSchedulerIntervalMs: 500,
    platformCapabilityFastSourceIntervalMs: 1_500,
  }, {
    targets: [{
      id: "flap",
      name: "Flap",
      website: "https://flap.sh",
      capabilitySchemaVersion: 4,
      marketSources: [{ url: board, chainId: 56 }],
      sources: [docs],
      pagePattern: /$a/,
    }],
    logger: quietLogger,
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      requests.set(url, requests.get(url) + 1);
      starts.get(`${url}:resolve`)();
      await releases.get(url);
      return url === board
        ? response(flapBoardPayload(factory, quote), { url })
        : response("VaultFactoryBaseV2", { url });
    },
  });

  await Promise.all([starts.get(docs), starts.get(board)]);
  intervalTicks[0]();
  intervalTicks[1]();
  const stopping = monitor.stop();
  assert.equal(monitor.stop(), stopping, "repeated stops share one drain boundary");
  intervalTicks[0]();
  intervalTicks[1]();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releases.get(`${docs}:resolve`)();
  releases.get(`${board}:resolve`)();
  await stopping;
  assert.deepEqual(Object.fromEntries(requests), { [docs]: 1, [board]: 1 });
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, "platform-capability-state.json"), "utf8"));
  assert.equal(durable.flap.sources[`market:${board}`].status, "healthy");
});
