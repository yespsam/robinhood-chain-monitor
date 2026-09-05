import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Interface, keccak256 } from "ethers";
import {
  BSC_EXCLUDED_CONTROLLERS,
  BSC_LAUNCHPAD_CATALOG,
  BSC_PAIR_CREATED_TOPIC,
  BSC_TRANSFER_TOPIC,
  BSC_UPGRADE_TOPICS,
  BSC_UPGRADED_TOPIC,
  BSC_WBNB,
  BSC_ZERO_TOPIC,
  BULLSHOT_CREATED_TOPIC,
  FLAP_COMPONENTS,
  FLAP_OFFICIAL_VAULT_FACTORIES,
  FLAP_TOKEN_CREATED_TOPIC,
  FLAP_VAULT_TOKEN_CREATED_TOPIC,
  FOUR_MEME_TOKEN_CREATE_TOPIC,
  FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC,
  OPENFOUR_TOKEN_CREATED_TOPIC,
  MOONSALE_TOKEN_CREATED_TOPIC,
  ONEVONE_TOURNAMENT_CREATED_TOPIC,
  PANCAKE_INFINITY_CL_INITIALIZE_TOPIC,
  RUG_LAUNCH_SUCCEEDED_TOPIC,
  bscRealtimeProcessLimit,
  bscDeepRpcPriority,
  commitBscDecision,
  compactBscNearHeadRecoveryGaps,
  compactFocus3LiveCoverageState,
  createBscLaunchpadMonitor,
  createRpcPool,
  evaluateBscObservation,
  findTokenCorrelatedEmitters,
  hasBscLaunchArgumentEvidence,
  isErc20MintLog,
  isBscArchiveStateUnavailable,
  isExcludedFourMemeTemplate,
  isOfficialFourMemeClassicTokenRecord,
  matchKnownOfficialFastMode,
  matchFlapFeatureActivation,
  modeComponentNovelty,
  nextRugspullCatalogCursor,
  parseDappBayLaunchpadCatalog,
  parseFourMemeAddressPayload,
  parseFourMemeQuotePayload,
  parseFourMemeTemplatePayload,
  parseFlapCreationHotCandidates,
  parseBscScanCreationTransaction,
  readBscLaunchpadDurableState,
  parseKnownBscLaunchEvidence,
  parseKnownBscLaunchTokens,
  parseOfficialRugspullCatalog,
  parseBscPoolLogs,
  platformForAddress,
  selectBscRealtimeEntries,
  shouldYieldBscNearHeadRecovery,
  bscNearHeadRecoveryPermittedLagBlocks,
  shouldReplayFourMemeActivation,
  suppressExcludedFourMemeTemplateActivations,
  waifuModeFingerprint,
} from "../src/bsc-launchpad-monitor.js";
import { classifyAlertFreshness, sendAlerts } from "../src/alerts.js";
import {
  isStrictBscOpenFourFirstTokenUpdate,
  isStrictFlapTrackedPoolTokenUpdate,
} from "../src/source-controls.js";

const old = Date.parse("2026-08-02T00:00:00Z");
const current = Date.parse("2026-08-02T01:00:00Z");

function state(initializedAt = new Date(old).toISOString()) {
  return { initializedAt, launchers: {}, seenTransactions: {}, coverageGaps: [] };
}

function observation({
  launcher = "0x1111111111111111111111111111111111111111",
  token = "0x2222222222222222222222222222222222222222",
  transactionHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  fingerprint = "mode-a",
  selector = "0x12345678",
  customTopics = [],
  tokenSelectorHash = "token-template-a",
  blockNumber = 100,
  security = { decision: "pass", metrics: { liquidityConfirmed: true } },
  platform = null,
  deployer = null,
  causalTokenEvent = true,
} = {}) {
  return {
    launcher,
    transactionHash,
    blockNumber,
    platform,
    tokens: [{ token, metadata: { name: "Sample", symbol: "SMP", decimals: 18 } }],
    pools: [{ kind: "PancakeSwap V2", pool: "0x3333333333333333333333333333333333333333" }],
    mode: { fingerprint, selector, poolKinds: ["PancakeSwap V2"], creationTopics: customTopics, customTopics, tokenSelectorHash, launcherCodeHash: "launcher-code-a", implementation: "0x7777777777777777777777777777777777777777" },
    structural: { eligible: true, mechanismEvidence: true, usesCreate2: true, codeSize: 12_000, argumentBytes: 128 },
    deployer: deployer || `0x${transactionHash.slice(2, 42)}`,
    causalTokenEvent,
    security,
    sampleToken: token,
    observedAt: "2026-08-02T01:00:00.000Z",
  };
}

function openFourTokenCreatedEvidence({
  token,
  transactionHash,
  blockHash,
  blockNumber,
  transactionIndex,
  logIndex,
  presetId = 2n,
  quoteAsset = "0x0000000000000000000000000000000000000000",
} = {}) {
  const iface = new Interface(["event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)"]);
  const zero = "0x0000000000000000000000000000000000000000";
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [
    1n, presetId, "0x1111111111111111111111111111111111111111", token,
    "Open", "OPEN", 1n, 1n, 1n, 1n, quoteAsset,
    zero, zero, zero, zero, zero, zero, "ipfs://meta", 0n, "0x",
  ]);
  return parseKnownBscLaunchEvidence([{
    address: "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3",
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockHash,
    blockNumber,
    transactionIndex,
    index: logIndex,
  }]);
}

function testBscWalFrame(revision, ops) {
  const framedOps = ops.some((operation) => operation.path?.length === 1 && operation.path[0] === "journalRevision")
    ? ops
    : [...ops, { op: "set", path: ["journalRevision"], value: revision }];
  const core = { version: 1, revision, ops: framedOps };
  const payload = JSON.stringify(core);
  return `${JSON.stringify({
    ...core,
    payloadLength: Buffer.byteLength(payload),
    sha256: createHash("sha256").update(payload).digest("hex"),
  })}\n`;
}

function disabledJournalTimerDependencies() {
  return {
    journalSetTimeoutImpl: () => ({ unref() {} }),
    journalClearTimeoutImpl() {},
  };
}

const EIP1967_IMPLEMENTATION_SLOT_TEST = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

test("an ordinary token code hash change cannot create a new launch mode by itself", () => {
  const previous = [{ shape: {
    selector: "0x12345678",
    launcherCodeHash: "launcher-a",
    tokenCodeHash: "token-a",
    poolKinds: ["PancakeSwap V2"],
    creationTopics: ["topic-a"],
  } }];
  const tokenOnly = modeComponentNovelty(previous, {
    selector: "0x12345678",
    launcherCodeHash: "launcher-a",
    tokenCodeHash: "token-b",
    poolKinds: ["PancakeSwap V2"],
    creationTopics: ["topic-a"],
  });
  const actualMode = modeComponentNovelty(previous, {
    selector: "0x87654321",
    launcherCodeHash: "launcher-a",
    tokenCodeHash: "token-b",
    poolKinds: ["PancakeSwap V2"],
    creationTopics: ["topic-a"],
  });
  assert.equal(tokenOnly.tokenCodeHash, "token-b");
  assert.equal(tokenOnly.meaningful, false);
  assert.equal(actualMode.meaningful, true);
});

test("Flap's current official BSC components and registered VaultFactories are exact", () => {
  assert.equal(FLAP_COMPONENTS.get("0x024f18294970b5c76c0691b87f138a0317156422")?.mode, "Tax Token V3");
  assert.equal(FLAP_COMPONENTS.get("0x88881b6f03090462a969ec7f48385744eeb63333")?.mode, "Standard Token V3");
  assert.equal(FLAP_COMPONENTS.get("0x6255fbd731272a517022e99f6cacf6a5de9414ee")?.mode, "Candy Box");
  assert.equal(FLAP_OFFICIAL_VAULT_FACTORIES.get("0xfab75dc774cb9b38b91749b8833360b46a52345f"), "Split Vault");
  assert.equal(FLAP_OFFICIAL_VAULT_FACTORIES.get("0x025549f52b03cf36f9e1a337c02d3aa7af66ab32"), "Gift Vault (FlapXVault)");
});

test("only an independently verified new Flap VaultFactory is structural novelty", () => {
  const previous = [{ shape: { selector: "0x8cb5772c", vaultFactory: "0x1111111111111111111111111111111111111111" } }];
  const verified = modeComponentNovelty(previous, {
    selector: "0x8cb5772c",
    componentMode: "Vault V4",
    componentModeAlertEligible: true,
    vaultFactory: "0x2222222222222222222222222222222222222222",
    vaultFactoryOfficial: true,
    vaultFactoryAlertEligible: true,
  });
  assert.equal(verified.vaultFactory, "0x2222222222222222222222222222222222222222");
  assert.equal(verified.componentMode, "Vault V4");
  assert.equal(verified.meaningful, true);

  const permissionless = modeComponentNovelty(previous, {
    selector: "0x8cb5772c",
    componentMode: "Unverified Vault",
    componentModeAlertEligible: false,
    vaultFactory: "0x3333333333333333333333333333333333333333",
    vaultFactoryOfficial: false,
    vaultFactoryAlertEligible: false,
  });
  assert.equal(permissionless.vaultFactory, null);
  assert.equal(permissionless.componentMode, null);
  assert.equal(permissionless.meaningful, false);
});

test("Flap feature matching requires an official creation event plus the exact Board-confirmed quote or VaultFactory", () => {
  const token = "0x1111111111111111111111111111111111111111";
  const quote = "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec";
  const vaultFactory = "0x0253481ed4bd401c232f8e2ba90d5e9d8d351a44";
  const observedAt = "2026-08-10T13:56:43.000Z";
  const snapshot = { officialSources: { flap: { featureActivations: {
    [`quote:${quote}`]: {
      key: `quote:${quote}`,
      type: "quote_pool",
      quoteAddress: quote,
      quoteSymbol: "BABAB",
      fingerprint: "quote-fingerprint",
      active: true,
      allowReplay: true,
      firstObservedAt: "2026-08-10T13:55:00.000Z",
      confirmedAt: "2026-08-10T13:55:30.000Z",
      replayCompletedAt: observedAt,
      sourceUrl: "https://flap.sh/board",
    },
    [`vault:STAKING:${vaultFactory}`]: {
      key: `vault:STAKING:${vaultFactory}`,
      type: "vault_factory",
      category: "STAKING",
      vaultFactory,
      active: true,
      allowReplay: true,
      firstObservedAt: "2026-08-10T13:55:00.000Z",
      confirmedAt: "2026-08-10T13:55:30.000Z",
      replayCompletedAt: observedAt,
      sourceUrl: "https://flap.sh/board",
    },
  } } } };
  const quoteMatch = matchFlapFeatureActivation(snapshot, {
    token,
    observedAt,
    exactCreationEvidence: [{ topic: FLAP_TOKEN_CREATED_TOPIC, token }],
    relevantPools: [{
      token0: token,
      token1: quote,
      factory: "0x4dB4FcFeBBF3F0CBD20eFFF444B133b96abdA2D6",
      verifiedDex: false,
    }],
  });
  assert.equal(quoteMatch.quoteAsset, quote);
  assert.equal(quoteMatch.quoteSymbol, "BABAB");
  assert.equal(quoteMatch.featureActivationKey, `quote:${quote}`);
  assert.equal(quoteMatch.featureSourceUrl, "https://flap.sh/board");
  assert.equal(matchFlapFeatureActivation(snapshot, {
    token,
    observedAt,
    exactCreationEvidence: [],
    relevantPools: [{ token0: token, token1: quote, verifiedDex: false }],
  }), null, "an arbitrary pair without Flap's exact creation event is not feature evidence");

  const vaultMatch = matchFlapFeatureActivation(snapshot, {
    token,
    observedAt,
    exactCreationEvidence: [{ topic: FLAP_VAULT_TOKEN_CREATED_TOPIC, token, vaultFactory }],
    relevantPools: [],
  });
  assert.equal(vaultMatch.vaultFactory, vaultFactory);
  assert.equal(vaultMatch.vaultCategory, "STAKING");
  assert.equal(vaultMatch.featureActivationKey, `vault:STAKING:${vaultFactory}`);
});

test("Flap's hot index accepts only exact official creation events and binds quote evidence from the same receipt", () => {
  const portal = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const token = "0x1111111111111111111111111111111111111111";
  const quote = "0x2222222222222222222222222222222222222222";
  const creator = "0x3333333333333333333333333333333333333333";
  const pair = "0x4444444444444444444444444444444444444444";
  const transactionHash = `0x${"5".repeat(64)}`;
  const observedAt = "2026-08-10T13:58:00.000Z";
  const creationInterface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const pairInterface = new Interface(["event PairCreated(address indexed token0,address indexed token1,address pair,uint256)"]);
  const creation = creationInterface.encodeEventLog(creationInterface.getEvent("TokenCreated"), [1n, creator, 1n, token, "First", "FIRST", "ipfs://first"]);
  const pairCreated = pairInterface.encodeEventLog(pairInterface.getEvent("PairCreated"), [token, quote, pair, 1n]);
  const creationLog = {
    address: portal,
    topics: creation.topics,
    data: creation.data,
    transactionHash,
    blockNumber: 100,
    transactionIndex: 3,
    logIndex: 1,
  };
  const pairLog = {
    address: "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
    topics: pairCreated.topics,
    data: pairCreated.data,
    transactionHash,
    blockNumber: 100,
    transactionIndex: 3,
    logIndex: 2,
  };
  const candidates = parseFlapCreationHotCandidates([creationLog, pairLog], {
    transactionHash,
    blockNumber: 100,
    transactionIndex: 3,
    observedAt,
    indexedAt: observedAt,
    current: Date.parse(observedAt),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].topic, FLAP_TOKEN_CREATED_TOPIC);
  assert.deepEqual(candidates[0].quoteAssets, [quote]);
  assert.deepEqual(parseFlapCreationHotCandidates([pairLog], {
    transactionHash,
    blockNumber: 100,
    observedAt,
    current: Date.parse(observedAt),
  }), [], "PairCreated by itself is never a Flap creation candidate");
  assert.deepEqual(parseFlapCreationHotCandidates([{ ...creationLog, address: creator }], {
    transactionHash,
    blockNumber: 100,
    observedAt,
    current: Date.parse(observedAt),
  }), [], "a copied Flap topic from a non-official emitter is rejected");
});

function knownOfficialFastFixture({ platformId = "flap", directToken = false } = {}) {
  const controllerAddress = platformId === "flap"
    ? "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0"
    : "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
  const token = "0x1111111111111111111111111111111111111111";
  const controllerImplementation = "0x2222222222222222222222222222222222222222";
  const tokenImplementation = directToken ? null : "0x024f18294970b5c76c0691b87f138a0317156422";
  const tokenCode = directToken
    ? "0x60016000556002600055"
    : `0x363d3d373d3d3d363d73${tokenImplementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const fingerprint = `${platformId}-ordinary-mode`;
  const topic = platformId === "flap" ? FLAP_TOKEN_CREATED_TOPIC : FOUR_MEME_TOKEN_CREATE_TOPIC;
  const launchTypes = platformId === "flap" ? [] : ["fourmeme_curve"];
  const shape = {
    selector: platformId === "flap" ? "0x8cb5772c" : "0x519ebb10",
    selectorName: platformId === "flap" ? "newTokenV6" : null,
    poolKinds: [],
    verifiedPoolFactories: [],
    creationTopics: [topic],
    customTopics: [topic],
    launcherCodeHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tokenCodeHash: directToken ? keccak256(tokenCode) : "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tokenSelectorHash: directToken ? keccak256(tokenCode) : "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tokenImplementation,
    implementation: controllerImplementation,
    componentMode: platformId === "flap" ? "Tax V3" : "fourmeme_curve",
    launchTypes,
    fingerprint,
  };
  const mode = {
    fingerprint,
    lastSeenBlock: 100,
    transactions: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    structuralTransactions: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    causalTransactions: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    mechanismTransactions: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    shape,
  };
  const state = { launchers: { [controllerAddress]: { modes: { [fingerprint]: mode } } }, officialUpgrades: {} };
  const controller = {
    address: controllerAddress,
    platform: { id: platformId, trust: platformId === "flap" ? "official_verified" : "official_shared" },
    kind: "official_direct",
    causalTokenEvent: true,
  };
  const descriptor = {
    selector: shape.selector,
    poolKinds: [],
    verifiedPoolFactories: [],
    creationTopics: [topic],
    launchTypes,
    argumentEvidence: true,
    exactCreationTokens: [token],
  };
  let reads = 0;
  const provider = {
    async getCode(address) {
      reads += 1;
      if (address.toLowerCase() === token) return tokenCode;
      if (address.toLowerCase() === controllerAddress) return "0x6000600055";
      throw new Error(`full implementation code must not be fetched: ${address}`);
    },
    async getStorage(address, slot) {
      reads += 1;
      if (address.toLowerCase() === controllerAddress && slot === EIP1967_IMPLEMENTATION_SLOT_TEST) {
        return `0x${"0".repeat(24)}${controllerImplementation.slice(2)}`;
      }
      return "0x";
    },
  };
  const warmedFingerprints = new Set([`${controllerAddress}:${fingerprint}`]);
  return { state, controller, token, descriptor, provider, warmedFingerprints, shape, controllerAddress, getReads: () => reads };
}

async function waitUntil(predicate, timeoutMs = 3_500) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function completeRealtimeTailPasses(monitor, count = 2, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let completed = 0;
  while (completed < count && Date.now() < deadline) {
    const result = await monitor.scanRealtimeTail();
    if (result?.skipped === false) completed += 1;
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(completed, count, `expected ${count} completed realtime-tail passes`);
}

test("realtime BSC work outranks recovery without reversing first-launch order", () => {
  const entry = (transactionHash, blockNumber, reasons) => ({ transactionHash, blockNumber, reasons: new Set(reasons) });
  const entries = [
    entry("recovery-old", 10, ["gap_recovery"]),
    entry("live-new", 102, ["zero_mint"]),
    entry("recovery-new", 100, ["gap_recovery"]),
    entry("live-old", 101, ["known_launch"]),
    entry("live-seen", 99, ["pool_created"]),
    entry("unconfirmed", 103, ["official_upgrade"]),
  ];
  const selected = selectBscRealtimeEntries(entries, 102, { "live-seen": 99 }, 10);
  assert.deepEqual(selected.map((item) => item.transactionHash), [
    "live-old",
    "live-new",
    "recovery-old",
    "recovery-new",
  ]);
});

test("same-block realtime candidates follow transaction and log order, not hash order", () => {
  const entries = [
    { transactionHash: "0x00", blockNumber: 100, transactionIndex: 9, logIndex: 0, reasons: new Set(["known_launch"]) },
    { transactionHash: "0xff", blockNumber: 100, transactionIndex: 2, logIndex: 8, reasons: new Set(["known_launch"]) },
    { transactionHash: "0xaa", blockNumber: 100, transactionIndex: 2, logIndex: 3, reasons: new Set(["known_launch"]) },
  ];
  assert.deepEqual(
    selectBscRealtimeEntries(entries, 100, {}, 10).map((entry) => entry.transactionHash),
    ["0xaa", "0xff", "0x00"],
  );
});

test("near-head BSC candidates outrank an old durable realtime backlog", () => {
  const entry = (transactionHash, blockNumber) => ({
    transactionHash,
    blockNumber,
    reasons: new Set(["http_tail"]),
  });
  const selected = selectBscRealtimeEntries([
    entry("oldest", 100),
    entry("old", 101),
    entry("fresh-second", 998),
    entry("fresh-first", 997),
  ], 1_000, {}, 3, 10);
  assert.deepEqual(selected.map((item) => item.transactionHash), [
    "fresh-first",
    "oldest",
    "old",
  ]);
});

test("a continuous fresh BSC stream reserves bounded capacity for the oldest durable work", () => {
  const old = Array.from({ length: 20 }, (_, index) => ({
    transactionHash: `old-${index}`,
    blockNumber: 100 + index,
    reasons: new Set(["near_head_gap_recovery"]),
  }));
  let pending = [...old];
  const processedOld = [];
  for (let round = 0; round < 10; round += 1) {
    const fresh = Array.from({ length: 12 }, (_, index) => ({
      transactionHash: `fresh-${round}-${index}`,
      blockNumber: 990 + index,
      reasons: new Set(["http_tail"]),
    }));
    const selected = selectBscRealtimeEntries([...pending, ...fresh], 1_000, {}, 12, 64);
    for (const entry of selected.filter((entry) => entry.transactionHash.startsWith("old-"))) {
      processedOld.push(entry.transactionHash);
      pending = pending.filter((candidate) => candidate.transactionHash !== entry.transactionHash);
    }
  }
  assert.deepEqual(processedOld, old.map((entry) => entry.transactionHash),
    "two oldest slots per full fresh batch drain the complete initial backlog in bounded rounds");
});

test("near-head recovery only yields to an active or more-than-one-batch-lagging tail", () => {
  assert.equal(shouldYieldBscNearHeadRecovery({
    realtimeTailRunning: true,
    realtimeTailNextBlock: 101,
    confirmedBlock: 100,
    permittedLagBlocks: 10,
  }), true);
  assert.equal(shouldYieldBscNearHeadRecovery({
    realtimeTailNextBlock: 90,
    confirmedBlock: 100,
    permittedLagBlocks: 10,
  }), true, "eleven missing blocks must retain realtime priority");
  assert.equal(shouldYieldBscNearHeadRecovery({
    realtimeTailNextBlock: 91,
    confirmedBlock: 100,
    permittedLagBlocks: 10,
  }), false, "one bounded tail batch may run beside the isolated recovery lane");
  assert.equal(shouldYieldBscNearHeadRecovery({
    realtimeTailNextBlock: null,
    confirmedBlock: 100,
    permittedLagBlocks: 10,
  }), true, "an invalid durable cursor must fail closed");
});

test("near-head recovery gets a short live window instead of requiring an exact BSC catch-up", () => {
  assert.equal(bscNearHeadRecoveryPermittedLagBlocks({
    realtimeTailBatchSize: 10,
    realtimeTailMaxLagBlocks: 128,
    expectedBlockTimeMs: 450,
  }), 100, "a healthy but latency-bound public tail must not starve recovery forever");
  assert.equal(bscNearHeadRecoveryPermittedLagBlocks({
    realtimeTailBatchSize: 10,
    realtimeTailMaxLagBlocks: 64,
    expectedBlockTimeMs: 100,
  }), 44, "the repair window must preserve two tail batches below the stale-tail handoff threshold");
});

test("BSC realtime queue uses full capacity near head and throttles ordinary backlog", () => {
  const entry = (transactionHash, blockNumber) => ({
    transactionHash,
    blockNumber,
    reasons: new Set(["http_tail"]),
  });
  const options = { nearHeadWindowBlocks: 64, normalLimit: 12, backlogLimit: 2 };
  assert.equal(bscRealtimeProcessLimit([entry("old", 100)], 1_000, {}, options), 2);
  assert.equal(bscRealtimeProcessLimit([entry("old", 100), entry("fresh", 999)], 1_000, {}, options), 12);
  assert.equal(bscRealtimeProcessLimit([entry("seen-fresh", 999)], 1_000, { "seen-fresh": 999 }, options), 2);
});

test("focus3 deep RPC priority requires two healthy tail batches and has capacity to drain production arrivals", () => {
  const base = {
    realtimeTailNextBlock: 1_001,
    confirmedBlock: 1_000,
    realtimeTailStatus: "healthy",
    nearHeadGapCount: 1,
  };
  assert.equal(bscDeepRpcPriority({ ...base, consecutiveHealthyTailBatches: 1 }).tailReady, false);
  const healthy = bscDeepRpcPriority({ ...base, consecutiveHealthyTailBatches: 2 });
  assert.equal(healthy.tailReady, true);
  assert.equal(healthy.deepIntervalMs, 750);
  assert.equal(healthy.oldDeepIntervalMs, 30_000);
  assert.equal(bscDeepRpcPriority({
    ...base,
    realtimeTailNextBlock: 979,
    consecutiveHealthyTailBatches: 2,
  }).allowFreshQueue, false, "more than twenty missing tail blocks close every ordinary deep lane");
  assert.equal(bscDeepRpcPriority({
    ...base,
    realtimeTailStatus: "error",
    consecutiveHealthyTailBatches: 2,
  }).allowFreshQueue, false, "an RPC tail error cannot be bypassed by a small lag");

  const capacity = bscDeepRpcPriority({
    ...base,
    realtimeTailNextBlock: 900,
    realtimeTailStatus: "error",
    realtimeTailBackpressure: "realtime_pending_capacity",
  });
  assert.equal(capacity.tailReady, false);
  assert.equal(capacity.allowFreshQueue, true, "capacity backpressure may drain only already-durable queue work");
  assert.equal(capacity.allowFreshDeferred, false);
  assert.equal(capacity.oldDeepIntervalMs, 750, "capacity recovery must not take eight days at the repair-gap quota");

  const durationMs = 10 * 60_000;
  const arrivalEveryMs = 1_000 / 0.6;
  let arrived = 0;
  let serviced = 0;
  let nextArrivalAt = 0;
  let nextServiceAt = 0;
  for (let clock = 0; clock <= durationMs; clock += 50) {
    while (nextArrivalAt <= clock) {
      arrived += 1;
      nextArrivalAt += arrivalEveryMs;
    }
    while (nextServiceAt <= clock && serviced < arrived) {
      serviced += 1;
      nextServiceAt += healthy.deepIntervalMs;
    }
  }
  assert.ok(serviced >= arrived - 1, `750ms serial starts drain a 0.6/s stream over ten minutes (${serviced}/${arrived})`);
  const degraded = bscDeepRpcPriority({
    ...base,
    realtimeTailStatus: "degraded",
    consecutiveHealthyTailBatches: 2,
  });
  assert.equal(degraded.allowFreshQueue, false, "once the tail degrades, the next deep start count is exactly zero");
});

test("Four.Meme stock and RWA templates stay out of alerts and active first-token replay", () => {
  assert.equal(isExcludedFourMemeTemplate({ name: "RWA", description: "RWA税费股票" }), true);
  assert.equal(isExcludedFourMemeTemplate({ name: "Tokenized Equity" }), true);
  assert.equal(isExcludedFourMemeTemplate({ name: "Royalty Vault", description: "creator fee sharing" }), false);
  const snapshot = {
    officialSources: {
      fourMeme: {
        featureActivations: {
          rwa: { type: "template", active: true, template: { name: "RWA", description: "股票模板" } },
          royalty: { type: "template", active: true, template: { name: "Royalty Vault" } },
        },
      },
    },
  };
  assert.equal(suppressExcludedFourMemeTemplateActivations(snapshot, "2026-08-11T00:00:00.000Z"), 1);
  assert.equal(snapshot.officialSources.fourMeme.featureActivations.rwa.active, false);
  assert.equal(snapshot.officialSources.fourMeme.featureActivations.rwa.exclusionReason, "stock_equity_rwa_out_of_scope");
  assert.equal(snapshot.officialSources.fourMeme.featureActivations.royalty.active, true);
});

test("focus3 refuses lossy live compaction and keeps the truthful historical cursor", () => {
  const snapshot = {
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 100_001,
    realtimePendingEntries: { keep: { blockNumber: 99_000 } },
    nearHeadRecoveryGaps: [
      { id: "old", fromBlock: 1_000, toBlock: 2_000, nextBlock: 1_500 },
      { id: "overlap", fromBlock: 97_000, toBlock: 98_000, nextBlock: 97_100 },
      { id: "recent", fromBlock: 99_000, toBlock: 99_500, nextBlock: 99_100 },
    ],
    coverageRecoveryHistory: [],
  };
  const result = compactFocus3LiveCoverageState(snapshot, {
    maxHistoricalLagBlocks: 10_000,
    replayLookbackBlocks: 2_400,
    current: Date.parse("2026-08-11T00:00:00Z"),
  });
  assert.equal(result.changed, false);
  assert.equal(result.refusedLossyCompaction, true);
  assert.equal(snapshot.lastFinalizedBlock, 100);
  assert.deepEqual(snapshot.nearHeadRecoveryGaps.map((gap) => [gap.id, gap.fromBlock, gap.nextBlock]), [
    ["old", 1_000, 1_500],
    ["overlap", 97_000, 97_100],
    ["recent", 99_000, 99_100],
  ]);
  assert.ok(snapshot.realtimePendingEntries.keep, "durable creation candidates must survive baseline compaction");
  assert.equal(snapshot.coverageRecoveryHistory.at(-1).reason, "focus3_live_compaction_refused_uncovered");
});

test("latest closed legacy lossy handoff reopens a conservative full-history superset exactly once", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-legacy-lossy-reopen-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const previousLastFinalizedBlock = 119_869_645;
  const compactedThroughBlock = 119_920_033;
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-09-04T12:00:00.000Z",
    lastFinalizedBlock: compactedThroughBlock,
    realtimeTailNextBlock: compactedThroughBlock + 1_000,
    alertSuppressedThroughBlock: 113_595_826,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [],
    coverageGaps: [],
    coverageRecoveryHistory: [{
      scheduledAt: "2026-09-04T12:39:15.572Z",
      reason: "focus3_live_baseline_compaction",
      previousLastFinalizedBlock,
      realtimeTailCoveredBlock: compactedThroughBlock,
      droppedGapCount: 203,
      retainedGapCount: 3,
    }],
    _health: {
      realtimeTail: {
        handoffCompaction: {
          previousLastFinalizedBlock,
          compactedThroughBlock,
          replayLookbackFromBlock: 119_917_634,
          droppedGapCount: 203,
          retainedGapCount: 3,
        },
      },
    },
  }));
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  const first = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3" }, dependencies);
  const migrated = await first.getState();
  assert.equal(migrated.lastFinalizedBlock, previousLastFinalizedBlock,
    "the last durable pre-loss cursor is the only safe rescan boundary");
  assert.equal(migrated.coverageContinuity.status, "partial_legacy_abandoned");
  assert.equal(migrated.coverageContinuity.abandonedThroughBlock, previousLastFinalizedBlock);
  assert.deepEqual(migrated.coverageContinuity.latestConservativeRescan, {
    version: 1,
    status: "pending",
    source: "legacy_realtime_tail_handoff_compaction",
    recordedAt: migrated.coverageContinuity.latestConservativeRescan.recordedAt,
    rescanFromBlock: previousLastFinalizedBlock + 1,
    rescanThroughBlock: compactedThroughBlock,
    previousLastFinalizedBlock,
    compactedThroughBlock,
    replayLookbackFromBlock: 119_917_634,
    droppedGapCount: 203,
    retainedGapCount: 3,
  });
  const marker = structuredClone(migrated.coverageContinuity);
  await first.stop();

  // The diagnostic history is intentionally rolling. Losing the old entry
  // must neither erase the permanent continuity marker nor reopen twice.
  const compactedSnapshot = JSON.parse(await fs.readFile(stateFile, "utf8"));
  compactedSnapshot.coverageRecoveryHistory = Array.from({ length: 20 }, (_, index) => ({
    scheduledAt: new Date(Date.parse("2026-09-05T00:00:00.000Z") + index * 1_000).toISOString(),
    reason: "focus3_live_compaction_refused_uncovered",
    previousLastFinalizedBlock,
    realtimeTailCoveredBlock: compactedThroughBlock + index,
    droppedGapCount: 0,
    retainedGapCount: 3,
  }));
  await fs.writeFile(stateFile, `${JSON.stringify(compactedSnapshot)}\n`, { mode: 0o600 });
  const restarted = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3" }, dependencies);
  const durable = await restarted.getState();
  assert.equal(durable.lastFinalizedBlock, previousLastFinalizedBlock);
  assert.deepEqual(durable.coverageContinuity, marker);
  assert.equal(durable.coverageRecoveryHistory.filter((entry) =>
    entry.reason === "focus3_latest_lossy_compaction_conservative_reopen").length, 0,
  "the top-level marker, not rolling history, makes migration idempotent");
  await restarted.stop();

  const refusalOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-new-refusal-not-legacy-"));
  t.after(() => fs.rm(refusalOnlyDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(refusalOnlyDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-09-05T00:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 60_000,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [],
    coverageGaps: [],
    coverageRecoveryHistory: [{
      reason: "focus3_live_compaction_refused_uncovered",
      previousLastFinalizedBlock: 100,
      realtimeTailCoveredBlock: 59_999,
      droppedGapCount: 0,
      retainedGapCount: 0,
    }],
  }));
  const refusalOnly = createBscLaunchpadMonitor({ dataDir: refusalOnlyDir, monitorScope: "focus3" }, dependencies);
  const refusalState = await refusalOnly.getState();
  assert.equal(refusalState.lastFinalizedBlock, 100);
  assert.equal(refusalState.coverageContinuity, null,
    "the new lossless refusal record is never misclassified as a legacy loss");
  await refusalOnly.stop();
});

test("pristine adjacent near-head gaps compact without changing the exact pending block union", () => {
  const gaps = [
    { id: "a", fromBlock: 100, toBlock: 109, nextBlock: 100, reason: "realtime_tail_stale_rebuild", attempts: 0 },
    { id: "b", fromBlock: 110, toBlock: 119, nextBlock: 110, reason: "realtime_tail_stale_rebuild", attempts: 0 },
    { id: "active", fromBlock: 120, toBlock: 139, nextBlock: 125, reason: "realtime_tail_stale_rebuild", attempts: 1, lastAttemptAt: "2026-08-11T00:00:00.000Z" },
    { id: "other", fromBlock: 140, toBlock: 149, nextBlock: 140, reason: "legacy_historical_handoff_migration", attempts: 0 },
  ];
  const pendingUnion = (records) => records.flatMap((gap) => Array.from(
    { length: gap.toBlock - gap.nextBlock + 1 },
    (_, index) => gap.nextBlock + index,
  )).sort((left, right) => left - right);
  const compacted = compactBscNearHeadRecoveryGaps(gaps, 100);
  assert.deepEqual(pendingUnion(compacted), pendingUnion(gaps));
  assert.ok(compacted.some((gap) => gap.fromBlock === 100 && gap.toBlock === 119));
  assert.ok(compacted.some((gap) => gap.id === "active" && gap.nextBlock === 125), "processed prefixes and active retry identity are never rewritten");
  assert.ok(compacted.some((gap) => gap.id === "other"), "different gap reasons remain independently auditable");

  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const uniquePendingUnion = (records) => [...new Set(pendingUnion(records))].sort((left, right) => left - right);
  for (let fixture = 0; fixture < 200; fixture += 1) {
    const segmentSize = 5 + Math.floor(random() * 26);
    let cursor = 1_000;
    const generated = Array.from({ length: 20 }, (_, index) => {
      cursor += Math.floor(random() * 4) - 1;
      const length = 1 + Math.floor(random() * Math.min(8, segmentSize));
      const fromBlock = Math.max(0, cursor);
      const toBlock = fromBlock + length - 1;
      cursor = toBlock;
      const attempted = random() < 0.35;
      const progressed = attempted ? Math.floor(random() * length) : 0;
      return {
        id: `fixture-${fixture}-${index}`,
        fromBlock,
        toBlock,
        nextBlock: fromBlock + progressed,
        reason: random() < 0.7 ? "realtime_tail_stale_rebuild" : "legacy_historical_handoff_migration",
        attempts: attempted ? 1 + Math.floor(random() * 3) : 0,
        ...(attempted ? { lastAttemptAt: "2026-09-04T00:00:00.000Z" } : {}),
      };
    });
    const propertyCompacted = compactBscNearHeadRecoveryGaps(generated, segmentSize);
    assert.deepEqual(uniquePendingUnion(propertyCompacted), uniquePendingUnion(generated),
      `fixture ${fixture} must preserve every and only uncovered block`);
    for (const active of generated.filter((gap) => gap.attempts > 0)) {
      const retainedActive = propertyCompacted.find((gap) => gap.id === active.id);
      assert.ok(retainedActive, `fixture ${fixture} retains attempted gap ${active.id}`);
      assert.deepEqual(
        [retainedActive.fromBlock, retainedActive.toBlock, retainedActive.nextBlock, retainedActive.reason, retainedActive.attempts],
        [active.fromBlock, active.toBlock, active.nextBlock, active.reason, active.attempts],
      );
    }
  }
});

test("near-head gaps keep a missing retry timestamp as null", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-null-retry-"));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-11T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:90:90",
      fromBlock: 90,
      toBlock: 90,
      nextBlock: 90,
      attempts: 0,
      nextAttemptAt: null,
    }],
  }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const snapshot = await monitor.getState();
  assert.equal(snapshot.nearHeadRecoveryGaps[0].nextAttemptAt, null);
});

test("realtime tail WAL-persists exact Flap Vault creation before ordinary deep processing", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-tail-hot-index-"));
  const clock = Date.parse("2026-08-11T12:00:00.000Z");
  const transactionHash = `0x${"a".repeat(64)}`;
  const token = "0x1111111111111111111111111111111111117777";
  const vault = "0x2222222222222222222222222222222222222222";
  const vaultFactory = "0x3333333333333333333333333333333333333333";
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, vaultFactory]);
  const log = {
    address: "0x90497450f2a706f1951b5bdda52b4e5d16f34c06",
    transactionHash,
    blockNumber: "0x63",
    transactionIndex: "0x1",
    logIndex: "0x2",
    topics: encoded.topics,
    data: encoded.data,
  };
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60_000).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 99,
    seenTransactions: {},
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    destroy() {},
  };
  const realtimeProvider = {
    async getBlockNumber() { return 102; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) && request.topics[0].includes(FLAP_VAULT_TOKEN_CREATED_TOPIC)
        ? [log]
        : [];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    provider,
    realtimeProvider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.start();
  await waitUntil(async () => {
    const current = await monitor.getState();
    return current.realtimeTailNextBlock === 101
      && Boolean(current.realtimePendingEntries[transactionHash]
        || current.deferredCreationEvidence[transactionHash]);
  });
  const snapshot = await monitor.getState();
  const durable = snapshot.realtimePendingEntries[transactionHash]
    || snapshot.deferredCreationEvidence[transactionHash];
  const candidate = durable.flapCreationHotCandidates
    .find((entry) => entry.transactionHash === transactionHash);
  assert.equal(candidate.token, token);
  assert.equal(candidate.vaultFactory, vaultFactory);
  assert.equal(candidate.topic, FLAP_VAULT_TOKEN_CREATED_TOPIC);
  assert.equal(snapshot.realtimeTailNextBlock, 101);
  assert.equal(snapshot.officialSources.flap.creationEventHotIndex
    .some((entry) => entry.transactionHash === transactionHash), false,
  "unprocessed raw evidence belongs to the per-transaction WAL record, not the processed hot cache");
});

test("an exact Flap receipt stays in per-transaction evidence when later identity profiling fails", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-profile-failure-hot-index-"));
  const clock = Date.parse("2026-08-11T12:00:00.000Z");
  const transactionHash = `0x${"b".repeat(64)}`;
  const portal = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const creator = "0x2222222222222222222222222222222222222222";
  const token = "0x1111111111111111111111111111111111117777";
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [Math.floor(clock / 1_000), creator, 1n, token, "First", "FIRST", "ipfs://first"]);
  const blockHash = `0x${"c".repeat(64)}`;
  const log = {
    address: portal,
    transactionHash,
    blockNumber: "0x63",
    blockHash,
    transactionIndex: "0x0",
    logIndex: "0x2",
    topics: encoded.topics,
    data: encoded.data,
  };
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 99,
    seenTransactions: {},
  }));
  const unavailable = () => {
    const error = new Error("getCode failed on every BSC RPC: providers cooling down");
    error.code = "SERVER_ERROR";
    throw error;
  };
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async getTransaction(hash) {
      assert.equal(hash, transactionHash);
      return { hash, blockNumber: 99, blockHash, index: 0, transactionIndex: 0, to: portal, from: creator, data: "0x8cb5772c" };
    },
    async getTransactionReceipt(hash) {
      assert.equal(hash, transactionHash);
      return { transactionHash: hash, blockNumber: 99, blockHash, index: 0, transactionIndex: 0, status: 1, logs: [log] };
    },
    async getBlock(number) {
      return { number, hash: blockHash, timestamp: Math.floor(clock / 1_000), transactions: [transactionHash] };
    },
    async getCode() { return unavailable(); },
    async getStorage() { return unavailable(); },
    destroy() {},
  };
  const realtimeProvider = {
    async getBlockNumber() { return 102; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) && request.topics[0].includes(FLAP_TOKEN_CREATED_TOPIC)
        ? [log]
        : [];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    provider,
    realtimeProvider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async () => assert.fail("profile failure must not deliver an alert"),
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.start();
  await waitUntil(async () => {
    const current = await monitor.getState();
    const durable = current.realtimePendingEntries[transactionHash]
      || current.deferredCreationEvidence[transactionHash];
    return durable?.flapCreationHotCandidates?.some((candidate) =>
      candidate.transactionHash === transactionHash && candidate.blockHash === blockHash);
  });
  const snapshot = await monitor.getState();
  const durable = snapshot.realtimePendingEntries[transactionHash]
    || snapshot.deferredCreationEvidence[transactionHash];
  const candidate = durable.flapCreationHotCandidates
    .find((entry) => entry.transactionHash === transactionHash);
  assert.equal(candidate.token, token);
  assert.equal(candidate.topic, FLAP_TOKEN_CREATED_TOPIC);
  assert.equal(snapshot.officialSources.flap.creationEventHotIndex
    .some((entry) => entry.transactionHash === transactionHash), false,
  "a failed deep profile cannot publish an unprocessed candidate into the hot cache");
  assert.ok(durable, "deep analysis must remain durable for retry");
  assert.equal(snapshot.seenTransactions[transactionHash], undefined);
});

test("the first near-head exact Flap warm profile reads latest before any historical blockTag", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-near-head-latest-warm-"));
  const clock = Date.parse("2026-08-11T12:00:00.000Z");
  const transactionHash = `0x${"c".repeat(64)}`;
  const portal = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const creator = "0x2222222222222222222222222222222222222222";
  const token = "0x1111111111111111111111111111111111118888";
  const blockHash = `0x${"d".repeat(64)}`;
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [Math.floor(clock / 1_000), creator, 1n, token, "Warm", "WARM", "ipfs://warm"]);
  const log = {
    address: portal,
    transactionHash,
    blockNumber: "0x63",
    blockHash,
    transactionIndex: "0x0",
    logIndex: "0x2",
    topics: encoded.topics,
    data: encoded.data,
  };
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 99,
    seenTransactions: {},
  }));
  const profileReads = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async getTransaction(hash) {
      assert.equal(hash, transactionHash);
      return { hash, blockNumber: 99, blockHash, index: 0, transactionIndex: 0, to: portal, from: creator, data: `0x8cb5772c${"00".repeat(32)}` };
    },
    async getTransactionReceipt(hash) {
      assert.equal(hash, transactionHash);
      return { hash, transactionHash: hash, blockNumber: 99, blockHash, index: 0, transactionIndex: 0, status: 1, logs: [log] };
    },
    async getBlock(number) {
      return { number, hash: blockHash, timestamp: Math.floor(clock / 1_000), transactions: [transactionHash] };
    },
    async getCode(address, blockTag) {
      const normalized = String(address).toLowerCase();
      if ([portal, token].includes(normalized)) {
        profileReads.push({ method: "getCode", address: normalized, blockTag });
        assert.equal(blockTag, undefined, "the exact near-head warm profile must read latest first");
      }
      return normalized === portal ? `0x${"60".repeat(700)}` : "0x6001600055";
    },
    async getStorage(address, _slot, blockTag) {
      const normalized = String(address).toLowerCase();
      if ([portal, token].includes(normalized)) {
        profileReads.push({ method: "getStorage", address: normalized, blockTag });
        assert.equal(blockTag, undefined, "the exact near-head warm identity must read latest first");
      }
      return "0x";
    },
    destroy() {},
  };
  const realtimeProvider = {
    async getBlockNumber() { return 102; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) && request.topics[0].includes(FLAP_TOKEN_CREATED_TOPIC)
        ? [log]
        : [];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    provider,
    realtimeProvider,
    realtimeTailMinIntervalMsForTesting: 0,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async () => assert.fail("a baseline warm profile must not deliver an alert"),
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.start();
  await completeRealtimeTailPasses(monitor, 2);
  await waitUntil(async () => (await monitor.getState()).seenTransactions[transactionHash] === 99);
  const snapshot = await monitor.getState();
  assert.equal(snapshot.seenTransactions[transactionHash], 99);
  assert.ok(profileReads.some((read) => read.method === "getCode" && read.address === portal));
  assert.ok(profileReads.some((read) => read.method === "getCode" && read.address === token));
  assert.equal(snapshot.realtimePendingEntries[transactionHash], undefined, "successful latest-first warm profiling drains the durable entry");
  assert.ok(snapshot.officialSources.flap.creationEventHotIndex
    .some((candidate) => candidate.transactionHash === transactionHash && candidate.blockHash === blockHash),
  "successful processing commits the rich receipt candidate into the processed hot cache");
});

test("successful Flap deep processing atomically replaces pending raw evidence with restartable hot evidence", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-success-hot-restart-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  const clock = Date.parse("2026-08-11T12:00:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const token = "0x1111111111111111111111111111111111117777";
  const vault = "0x2222222222222222222222222222222222222222";
  const vaultFactory = "0x3333333333333333333333333333333333333333";
  const creator = "0x4444444444444444444444444444444444444444";
  const transactionHash = `0x${"ab".repeat(32)}`;
  const blockHash = `0x${"cd".repeat(32)}`;
  const iface = new Interface([
    "event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)",
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, vaultFactory]);
  const log = {
    address: launcher,
    transactionHash,
    blockNumber: 99,
    blockHash,
    transactionIndex: 0,
    logIndex: 2,
    topics: encoded.topics,
    data: encoded.data,
    removed: false,
  };
  await fs.writeFile(stateFile, JSON.stringify({
    version: 7,
    journalRevision: 0,
    initializedAt: new Date(clock - 3_600_000).toISOString(),
    lastFinalizedBlock: 98,
    realtimeTailNextBlock: 100,
    realtimeTailInitializedAt: new Date(clock - 3_600_000).toISOString(),
    realtimePendingEntries: {},
    deferredCreationEvidence: {},
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    nearHeadRecoveryGaps: [{
      id: "success-hot",
      fromBlock: 99,
      toBlock: 99,
      nextBlock: 99,
      reason: "fixture",
      attempts: 0,
    }],
    officialSources: {
      flap: {
        creationEventHotIndex: [],
        quotePoolFirstThree: { version: 1, windows: {}, activeByQuote: {}, lifecycleEvents: {} },
      },
    },
    _health: {
      realtimeTail: {
        status: "healthy",
        lastSuccessAt: new Date(clock).toISOString(),
        toBlock: 99,
        consecutiveFailures: 0,
      },
    },
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 99; },
    async send(method, [request]) {
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const topics = Array.isArray(request?.topics?.[0]) ? request.topics[0] : [request?.topics?.[0]];
      return topics.includes(FLAP_VAULT_TOKEN_CREATED_TOPIC) ? [log] : [];
    },
    async getTransaction(hash) {
      if (hash !== transactionHash) return null;
      return {
        hash,
        blockNumber: 99,
        blockHash,
        index: 0,
        transactionIndex: 0,
        to: launcher,
        from: creator,
        data: `0x8cb5772c${"0".repeat(64)}`,
        value: 0n,
      };
    },
    async getTransactionReceipt(hash) {
      if (hash !== transactionHash) return null;
      return {
        hash,
        transactionHash: hash,
        blockNumber: 99,
        blockHash,
        index: 0,
        transactionIndex: 0,
        to: launcher,
        from: creator,
        status: 1,
        logs: [log],
      };
    },
    async getBlock(number) {
      return {
        number: Number(number),
        hash: blockHash,
        timestamp: Math.floor((clock - 60_000) / 1_000),
        transactions: [transactionHash],
      };
    },
    async getCode(address) {
      return String(address).toLowerCase() === token
        ? `0x${"6000".repeat(300)}`
        : `0x${"6000".repeat(400)}`;
    },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };
  const alerts = [];
  const dependencies = {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(structuredClone(event));
      return { status: "delivered", eventId: event.eventKey };
    },
    ...disabledJournalTimerDependencies(),
  };
  const config = {
    dataDir,
    monitorScope: "focus3",
    bscConfirmations: 0,
    bscNearHeadRecoveryBatchSize: 1,
    blockedContracts: new Set(),
  };
  let monitor = createBscLaunchpadMonitor(config, dependencies);
  t.after(async () => {
    await monitor?.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await monitor.getState();
  assert.equal((await monitor.scanNearHeadRecovery()).completed, true);
  let snapshot = await monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[transactionHash]);
  assert.equal(snapshot.officialSources.flap.creationEventHotIndex
    .some((candidate) => candidate.transactionHash === transactionHash), false);

  await monitor.checkHttpHead();
  for (let turn = 0; turn < 3; turn += 1) await monitor.processRealtimeQueue();
  await monitor.awaitIdle();
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimePendingEntries[transactionHash], undefined);
  assert.equal(snapshot.deferredCreationEvidence[transactionHash], undefined);
  assert.equal(snapshot.seenTransactions[transactionHash], 99);
  assert.ok(snapshot.officialSources.flap.creationEventHotIndex
    .some((candidate) => candidate.transactionHash === transactionHash));

  const frames = (await fs.readFile(walFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.ok(frames.some((frame) => {
    const paths = frame.ops.map((operation) => operation.path.join("."));
    return paths.includes("officialSources.flap.creationEventHotIndex")
      && paths.includes(`realtimePendingEntries.${transactionHash}`)
      && frame.ops.some((operation) => operation.op === "delete"
        && operation.path.join(".") === `realtimePendingEntries.${transactionHash}`);
  }), "the processed hot evidence and pending deletion share one WAL revision");

  await monitor.stop();
  monitor = createBscLaunchpadMonitor(config, dependencies);
  snapshot = await monitor.getState();
  assert.ok(snapshot.officialSources.flap.creationEventHotIndex
    .some((candidate) => candidate.transactionHash === transactionHash));
  assert.equal(await monitor.registerFlapFeatureActivations([{
    pool: {
      identity: `vault:INDEX:${vaultFactory}`,
      category: "INDEX",
      vaultFactory,
      sourceUrl: "https://flap.sh/board",
    },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(clock - 30_000).toISOString(),
    confirmedAt: new Date(clock).toISOString(),
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  snapshot = await monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[transactionHash],
    "registration durably admits the processed-hot replay before unified deep work");
  await monitor.processRealtimeQueue();
  await monitor.awaitIdle();
  snapshot = await monitor.getState();
  const activation = Object.values(snapshot.officialSources.flap.featureActivations)[0];
  assert.equal(activation.firstTokenTransactionHash, transactionHash);
  assert.equal(alerts.filter((event) => event.transactionHash === transactionHash).length, 1);

  await monitor.stop();
  monitor = createBscLaunchpadMonitor(config, dependencies);
  await monitor.getState();
  await monitor.replayFlapFeatureActivations();
  await monitor.awaitIdle();
  snapshot = await monitor.getState();
  assert.equal(Object.values(snapshot.officialSources.flap.featureActivations)[0]
    .firstTokenTransactionHash, transactionHash);
  assert.equal(alerts.filter((event) => event.transactionHash === transactionHash).length, 1,
    "the processed hot owner remains exact-once across a second restart");
});

test("warmed ordinary Flap and Four.Meme fingerprints use the conservative identity fast path", async () => {
  for (const [fixture, expectedReads] of [
    [knownOfficialFastFixture({ platformId: "flap" }), 4],
    [knownOfficialFastFixture({ platformId: "fourmeme-springboard-shared", directToken: true }), 6],
  ]) {
    const matched = await matchKnownOfficialFastMode({
      provider: fixture.provider,
      state: fixture.state,
      controller: fixture.controller,
      token: fixture.token,
      blockTag: 101,
      descriptor: fixture.descriptor,
      warmedFingerprints: fixture.warmedFingerprints,
    });
    assert.deepEqual(matched, fixture.shape);
    assert.equal(fixture.getReads(), expectedReads, "clone bytecode avoids redundant proxy-slot reads");
  }
});

test("warmed official controller identity is shared for a short block bucket", async () => {
  const fixture = knownOfficialFastFixture({ platformId: "flap" });
  const identityCache = new Map();
  const options = {
    provider: fixture.provider,
    state: fixture.state,
    controller: fixture.controller,
    token: fixture.token,
    blockTag: 101,
    descriptor: fixture.descriptor,
    warmedFingerprints: fixture.warmedFingerprints,
    identityCache,
  };
  assert.deepEqual(await matchKnownOfficialFastMode(options), fixture.shape);
  assert.equal(fixture.getReads(), 4);
  assert.deepEqual(await matchKnownOfficialFastMode({ ...options, blockTag: 102 }), fixture.shape);
  assert.equal(fixture.getReads(), 5, "the second token needs only its embedded clone identity");
});

test("warmed exact official identity retries latest state when public archive reads are unavailable", async () => {
  const fixture = knownOfficialFastFixture({ platformId: "flap" });
  const originalGetCode = fixture.provider.getCode;
  const originalGetStorage = fixture.provider.getStorage;
  const unavailable = () => {
    const error = new Error("getCode failed on every BSC RPC: providers cooling down");
    error.code = "SERVER_ERROR";
    throw error;
  };
  fixture.provider.getCode = async (address, blockTag) => blockTag === 101
    ? unavailable()
    : originalGetCode(address, blockTag);
  fixture.provider.getStorage = async (address, slot, blockTag) => blockTag === 101
    ? unavailable()
    : originalGetStorage(address, slot, blockTag);

  const options = {
    provider: fixture.provider,
    state: fixture.state,
    controller: fixture.controller,
    token: fixture.token,
    blockTag: 101,
    descriptor: fixture.descriptor,
    warmedFingerprints: fixture.warmedFingerprints,
  };
  assert.deepEqual(await matchKnownOfficialFastMode(options), fixture.shape);

  fixture.provider.getCode = async (address, blockTag) => {
    if (blockTag === 101) return unavailable();
    if (address.toLowerCase() === fixture.token) {
      return `0x363d3d373d3d3d363d73${"3".repeat(40)}5af43d82803e903d91602b57fd5bf3`;
    }
    return originalGetCode(address, blockTag);
  };
  assert.equal(await matchKnownOfficialFastMode(options), null, "latest fallback must not hide a changed token implementation");
});

test("near-head exact official identity reads latest first and remains fail-closed for selector, upgrade, and implementation novelty", async () => {
  const fixture = knownOfficialFastFixture({ platformId: "flap" });
  const originalGetCode = fixture.provider.getCode;
  const originalGetStorage = fixture.provider.getStorage;
  const blockTags = [];
  fixture.provider.getCode = async (address, blockTag) => {
    blockTags.push(blockTag);
    assert.equal(blockTag, undefined, "near-head identity must not pay a historical blockTag timeout first");
    return originalGetCode(address, blockTag);
  };
  fixture.provider.getStorage = async (address, slot, blockTag) => {
    blockTags.push(blockTag);
    assert.equal(blockTag, undefined, "near-head identity storage must read latest first");
    return originalGetStorage(address, slot, blockTag);
  };
  const options = {
    provider: fixture.provider,
    state: fixture.state,
    controller: fixture.controller,
    token: fixture.token,
    blockTag: 101,
    descriptor: fixture.descriptor,
    warmedFingerprints: fixture.warmedFingerprints,
    preferLatestState: true,
  };
  assert.deepEqual(await matchKnownOfficialFastMode(options), fixture.shape);
  assert.ok(blockTags.length > 0);

  const fourMeme = knownOfficialFastFixture({ platformId: "fourmeme-springboard-shared", directToken: true });
  const fourGetCode = fourMeme.provider.getCode;
  const fourGetStorage = fourMeme.provider.getStorage;
  fourMeme.provider.getCode = async (address, blockTag) => {
    assert.equal(blockTag, undefined, "near-head Four.Meme identity must read latest first");
    return fourGetCode(address, blockTag);
  };
  fourMeme.provider.getStorage = async (address, slot, blockTag) => {
    assert.equal(blockTag, undefined, "near-head Four.Meme identity storage must read latest first");
    return fourGetStorage(address, slot, blockTag);
  };
  assert.deepEqual(await matchKnownOfficialFastMode({
    provider: fourMeme.provider,
    state: fourMeme.state,
    controller: fourMeme.controller,
    token: fourMeme.token,
    blockTag: 101,
    descriptor: fourMeme.descriptor,
    warmedFingerprints: fourMeme.warmedFingerprints,
    preferLatestState: true,
  }), fourMeme.shape);

  const changedSelector = knownOfficialFastFixture({ platformId: "flap" });
  changedSelector.descriptor.selector = "0x12345678";
  assert.equal(await matchKnownOfficialFastMode({
    provider: changedSelector.provider,
    state: changedSelector.state,
    controller: changedSelector.controller,
    token: changedSelector.token,
    blockTag: 101,
    descriptor: changedSelector.descriptor,
    warmedFingerprints: changedSelector.warmedFingerprints,
    preferLatestState: true,
  }), null);
  assert.equal(changedSelector.getReads(), 0, "new selectors must reject the shortcut before state reads");

  const upgraded = knownOfficialFastFixture({ platformId: "flap" });
  upgraded.state.officialUpgrades.upgrade = {
    emitter: upgraded.controllerAddress,
    implementation: "0x3333333333333333333333333333333333333333",
    blockNumber: 101,
  };
  assert.equal(await matchKnownOfficialFastMode({
    provider: upgraded.provider,
    state: upgraded.state,
    controller: upgraded.controller,
    token: upgraded.token,
    blockTag: 101,
    descriptor: upgraded.descriptor,
    warmedFingerprints: upgraded.warmedFingerprints,
    preferLatestState: true,
  }), null);
  assert.equal(upgraded.getReads(), 0, "an unabsorbed official upgrade must reject the shortcut before cached identity reads");

  const changedImplementation = knownOfficialFastFixture({ platformId: "flap" });
  const changedGetStorage = changedImplementation.provider.getStorage;
  changedImplementation.provider.getStorage = async (address, slot, blockTag) => {
    if (address.toLowerCase() === changedImplementation.controllerAddress
      && slot === EIP1967_IMPLEMENTATION_SLOT_TEST) {
      return `0x${"0".repeat(24)}${"3".repeat(40)}`;
    }
    return changedGetStorage(address, slot, blockTag);
  };
  assert.equal(await matchKnownOfficialFastMode({
    provider: changedImplementation.provider,
    state: changedImplementation.state,
    controller: changedImplementation.controller,
    token: changedImplementation.token,
    blockTag: 101,
    descriptor: changedImplementation.descriptor,
    warmedFingerprints: changedImplementation.warmedFingerprints,
    preferLatestState: true,
  }), null, "a changed latest implementation must fall back to full profiling");
});

test("known official fast fingerprints fail closed on restart, static novelty, upgrades, and implementation changes", async () => {
  {
    const fixture = knownOfficialFastFixture();
    assert.equal(await matchKnownOfficialFastMode({
      provider: fixture.provider,
      state: fixture.state,
      controller: fixture.controller,
      token: fixture.token,
      blockTag: 101,
      descriptor: fixture.descriptor,
      warmedFingerprints: new Set(),
    }), null, "the first launch after restart must be fully profiled");
    assert.equal(fixture.getReads(), 0);
  }

  for (const mutate of [
    (fixture) => { fixture.descriptor.selector = "0x12345678"; },
    (fixture) => { fixture.descriptor.creationTopics = [`0x${"f".repeat(64)}`]; },
    (fixture) => { fixture.descriptor.poolKinds = ["PancakeSwap V3"]; },
    (fixture) => { fixture.descriptor.verifiedPoolFactories = ["0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865"]; },
    (fixture) => {
      fixture.state.officialUpgrades.upgrade = {
        emitter: fixture.controllerAddress,
        implementation: "0x3333333333333333333333333333333333333333",
        blockNumber: 101,
      };
    },
    (fixture) => {
      const vaultFactory = "0x4444444444444444444444444444444444444444";
      fixture.shape.vaultFactory = vaultFactory;
      fixture.descriptor.vaultFactory = vaultFactory;
      fixture.state.officialUpgrades.linkedUpgrade = {
        emitter: vaultFactory,
        implementation: "0x5555555555555555555555555555555555555555",
        blockNumber: 100,
      };
    },
  ]) {
    const fixture = knownOfficialFastFixture();
    mutate(fixture);
    assert.equal(await matchKnownOfficialFastMode({
      provider: fixture.provider,
      state: fixture.state,
      controller: fixture.controller,
      token: fixture.token,
      blockTag: 101,
      descriptor: fixture.descriptor,
      warmedFingerprints: fixture.warmedFingerprints,
    }), null);
    assert.equal(fixture.getReads(), 0, "static/upgrade novelty must fall back before lightweight state reads");
  }

  for (const changedAddress of ["token", "controller"]) {
    const fixture = knownOfficialFastFixture();
    const originalGetCode = fixture.provider.getCode;
    const originalGetStorage = fixture.provider.getStorage;
    fixture.provider.getCode = async (address, blockTag) => {
      if (changedAddress === "token" && address.toLowerCase() === fixture.token) {
        return `0x363d3d373d3d3d363d73${"3".repeat(40)}5af43d82803e903d91602b57fd5bf3`;
      }
      return originalGetCode(address, blockTag);
    };
    fixture.provider.getStorage = async (address, slot) => {
      if (changedAddress === "controller"
        && address.toLowerCase() === fixture.controllerAddress
        && slot === EIP1967_IMPLEMENTATION_SLOT_TEST) {
        return `0x${"0".repeat(24)}${"3".repeat(40)}`;
      }
      return originalGetStorage(address, slot);
    };
    assert.equal(await matchKnownOfficialFastMode({
      provider: fixture.provider,
      state: fixture.state,
      controller: fixture.controller,
      token: fixture.token,
      blockTag: 101,
      descriptor: fixture.descriptor,
      warmedFingerprints: fixture.warmedFingerprints,
    }), null, `${changedAddress} implementation novelty must fall back`);
  }

  const unknown = knownOfficialFastFixture();
  unknown.controller.platform.id = "unknown-launchpad";
  assert.equal(await matchKnownOfficialFastMode({
    provider: unknown.provider,
    state: unknown.state,
    controller: unknown.controller,
    token: unknown.token,
    blockTag: 101,
    descriptor: unknown.descriptor,
    warmedFingerprints: unknown.warmedFingerprints,
  }), null);
  assert.equal(unknown.getReads(), 0, "unknown launchpads must retain the strict path unchanged");
});

test("eth_getLogs prefers archive-capable RPCs and falls back to standard providers", async () => {
  const archiveFirstCalls = [];
  const archiveFirst = createRpcPool(["https://standard.test"], ["https://archive.test"], 1, {
    providerFactory: (_url, context) => ({
      async send(method, params) {
        archiveFirstCalls.push({ kind: context.kind, method, params });
        return [{ source: context.kind }];
      },
    }),
  });
  const preferred = await archiveFirst.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
  assert.deepEqual(preferred, [{ source: "archive" }]);
  assert.deepEqual(archiveFirstCalls.map(({ kind }) => kind), ["archive"]);
  assert.deepEqual(archiveFirstCalls[0], {
    kind: "archive",
    method: "eth_getLogs",
    params: [{ fromBlock: "0x1", toBlock: "0x2" }],
  });
  archiveFirst.destroy();

  const fallbackCalls = [];
  const fallback = createRpcPool(["https://standard.test"], ["https://archive.test"], 1, {
    providerFactory: (_url, context) => ({
      async send(method, params) {
        fallbackCalls.push({ kind: context.kind, method, params });
        if (context.kind === "archive") throw new Error("archive temporarily unavailable");
        return [{ source: context.kind }];
      },
    }),
  });
  const recovered = await fallback.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x4" }]);
  assert.deepEqual(recovered, [{ source: "standard" }]);
  assert.deepEqual(fallbackCalls.map(({ kind }) => kind), ["archive", "standard"]);
  fallback.destroy();
});

test("historical transaction objects use the archive pool first and retry null results", async () => {
  const calls = [];
  const pool = createRpcPool(
    ["https://standard.test"],
    ["https://archive-null.test", "https://archive-good.test"],
    2,
    {
      providerFactory: (_url, context) => ({
        async getTransaction(hash) {
          calls.push({ kind: context.kind, index: context.index, method: "getTransaction", hash });
          if (context.kind === "archive" && context.index === 0) return null;
          return { hash, source: context.kind };
        },
        async getTransactionReceipt(hash) {
          calls.push({ kind: context.kind, index: context.index, method: "getTransactionReceipt", hash });
          if (context.kind === "archive" && context.index === 0) throw new Error("archive receipt unavailable");
          return { hash, source: context.kind };
        },
      }),
    },
  );
  const hash = `0x${"a".repeat(64)}`;
  assert.equal((await pool.getHistoricalTransaction(hash)).source, "archive");
  assert.equal((await pool.getHistoricalTransactionReceipt(hash)).source, "archive");
  assert.deepEqual(calls.map(({ kind, index, method }) => [kind, index, method]), [
    ["archive", 0, "getTransaction"],
    ["archive", 1, "getTransaction"],
    ["archive", 1, "getTransactionReceipt"],
  ]);
  pool.destroy();

  const fallbackCalls = [];
  const fallback = createRpcPool(["https://standard.test"], ["https://archive.test"], 1, {
    providerFactory: (_url, context) => ({
      async getTransactionReceipt(hashValue) {
        fallbackCalls.push(context.kind);
        if (context.kind === "archive") throw new Error("archive down");
        return { hash: hashValue, source: "standard" };
      },
    }),
  });
  assert.equal((await fallback.getHistoricalTransactionReceipt(hash)).source, "standard");
  assert.deepEqual(fallbackCalls, ["archive", "standard"]);
  fallback.destroy();
});

test("historical eth_call uses archive state while untagged and latest calls stay on standard RPC", async () => {
  const calls = [];
  const pool = createRpcPool(["https://standard.test"], ["https://archive.test"], 1, {
    providerFactory: (_url, context) => ({
      async call(transaction) {
        calls.push({ kind: context.kind, blockTag: transaction.blockTag });
        if (context.kind === "standard" && transaction.blockTag === 100) {
          throw new Error("missing trie node");
        }
        return context.kind === "archive" ? "0xaaaa" : "0xbbbb";
      },
    }),
  });
  const transaction = { to: "0x1111111111111111111111111111111111111111", data: "0x1234" };

  assert.equal(await pool.call({ ...transaction, blockTag: 100 }), "0xaaaa");
  assert.equal(await pool.call(transaction), "0xbbbb");
  assert.equal(await pool.call({ ...transaction, blockTag: "latest" }), "0xbbbb");
  assert.deepEqual(calls, [
    { kind: "archive", blockTag: 100 },
    { kind: "standard", blockTag: undefined },
    { kind: "standard", blockTag: "latest" },
  ]);
  pool.destroy();
});

test("RPC timeouts release archive slots and fall back from hung archive and standard providers", async () => {
  let archiveCalls = 0;
  let standardCalls = 0;
  const archiveFallback = createRpcPool(["https://standard.test"], ["https://archive.test"], 1, {
    requestTimeoutMs: 25,
    providerFactory: (_url, context) => ({
      async send(method, params) {
        assert.equal(method, "eth_getLogs");
        assert.equal(params.length, 1);
        if (context.kind === "archive") {
          archiveCalls += 1;
          return new Promise(() => {});
        }
        standardCalls += 1;
        return [{ source: "standard", fromBlock: params[0].fromBlock }];
      },
    }),
  });
  const archiveStartedAt = Date.now();
  const results = await Promise.all([
    archiveFallback.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
    archiveFallback.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]),
  ]);
  assert.equal(archiveCalls, 1, "the timed-out archive must cool down so the waiting request can fall back without hanging");
  assert.equal(standardCalls, 2);
  assert.ok(Date.now() - archiveStartedAt < 500, "a hung archive must not retain its slot until the provider's own timeout");
  assert.deepEqual(results.flatMap((items) => items.map((item) => item.fromBlock)).sort(), ["0x1", "0x2"]);
  archiveFallback.destroy();

  const standardFallback = createRpcPool(["https://slow.test", "https://fast.test"], [], 1, {
    requestTimeoutMs: 25,
    providerFactory: (_url, context) => ({
      async send() {
        if (context.index === 0) return new Promise(() => {});
        return [{ source: "fast-standard" }];
      },
    }),
  });
  assert.deepEqual(
    await standardFallback.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x3" }]),
    [{ source: "fast-standard" }],
  );
  standardFallback.destroy();
});

test("default RPC transport aborts the underlying HTTP request on timeout", async (t) => {
  let activeRequests = 0;
  let releasedRequests = 0;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    activeRequests += 1;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      activeRequests -= 1;
      releasedRequests += 1;
    };
    request.once("aborted", () => {
      release();
    });
    response.once("close", release);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const pool = createRpcPool([`http://127.0.0.1:${address.port}`], [], 1, {
    // Leave enough time for the request to reach the local server even while
    // the complete test suite is running many files in parallel.
    requestTimeoutMs: 1_000,
    standardConcurrency: 1,
    hostCircuitRegistry: new Map(),
  });
  t.after(() => pool.destroy());

  await assert.rejects(() => pool.getBlockNumber(), /timed out|timeout/i);
  const cleanupDeadline = Date.now() + 2_000;
  // The outer provider timeout can reject a few milliseconds before ethers
  // dispatches (or the local server observes) its transport. Wait for the
  // exchange to be released, not only while the request is already visible.
  while (releasedRequests === 0 && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(activeRequests, 0, "a timed-out transport request must not retain an active server request");
  assert.equal(releasedRequests, 1, "the timeout must close the real HTTP exchange, not only reject the caller promise");
});

test("standard RPC pool enforces its configured total concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  const pool = createRpcPool(["https://standard.test"], [], 1, {
    standardConcurrency: 2,
    providerFactory: () => ({
      async getBlockNumber() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return 123;
      },
    }),
  });
  const results = await Promise.all(Array.from({ length: 7 }, () => pool.getBlockNumber()));
  assert.deepEqual(results, Array(7).fill(123));
  assert.equal(maximumActive, 2);
  pool.destroy();
});

test("standard RPC cooldown fails closed instead of retrying every cooling provider", async () => {
  let calls = 0;
  const pool = createRpcPool(["https://first.test", "https://second.test"], [], 1, {
    providerFactory: () => ({
      async getBlockNumber() {
        calls += 1;
        throw new Error("limit exceeded");
      },
    }),
  });
  await assert.rejects(() => pool.getBlockNumber(), /failed on every BSC RPC/);
  assert.equal(calls, 2);
  await assert.rejects(() => pool.getBlockNumber(), /providers cooling down; retry in \d+ms/);
  assert.equal(calls, 2, "a second call during cooldown must not hit either provider again");
  pool.destroy();
});

test("transient getLogs timeouts use a short method cooldown and expose retry timing", async () => {
  let logCalls = 0;
  let headCalls = 0;
  const pool = createRpcPool(["https://first.test", "https://second.test"], [], 1, {
    requestTimeoutMs: 4_000,
    providerFactory: () => ({
      async send(method) {
        assert.equal(method, "eth_getLogs");
        logCalls += 1;
        throw new Error("eth_getLogs timed out after 4000ms");
      },
      async getBlockNumber() {
        headCalls += 1;
        return 123;
      },
    }),
  });

  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
    (error) => /failed on every BSC RPC/.test(error.message)
      && error.retryAfterMs >= 1_000
      && error.retryAfterMs <= 5_000,
  );
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]),
    (error) => /providers cooling down/.test(error.message)
      && error.retryAfterMs >= 1_000
      && error.retryAfterMs <= 5_000,
  );
  assert.equal(logCalls, 2, "the timeout cooldown must prevent immediate log retries");
  assert.equal(await pool.getBlockNumber(), 123, "a log timeout must not disable head reads");
  assert.equal(headCalls, 1);
  pool.destroy();
});

test("BSC RPC circuits honor Retry-After with a fake clock and recover with one probe", async () => {
  let clock = Date.parse("2026-08-24T09:00:00.000Z");
  let calls = 0;
  let available = false;
  const pool = createRpcPool(["https://rate-limited.test"], [], 1, {
    now: () => clock,
    recoveryProbeIntervalMs: 250,
    providerFactory: () => ({
      async send(method) {
        assert.equal(method, "eth_getLogs");
        calls += 1;
        if (available) return [];
        const error = new Error("HTTP 429");
        error.status = 429;
        error.response = { headers: { "retry-after": "12" } };
        throw error;
      },
    }),
  });

  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
    (error) => error.retryAfterMs === 12_000,
  );
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]),
    (error) => /cooling down/.test(error.message) && error.retryAfterMs === 12_000,
  );
  assert.equal(calls, 1, "Retry-After must suppress every request during the declared circuit window");
  clock += 11_999;
  await assert.rejects(() => pool.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x3" }]), /cooling down/);
  assert.equal(calls, 1);
  clock += 1;
  available = true;
  assert.deepEqual(await pool.send("eth_getLogs", [{ fromBlock: "0x4", toBlock: "0x4" }]), []);
  assert.equal(calls, 2, "the endpoint receives one half-open recovery probe at Retry-After expiry");
  pool.destroy();
});

test("a BSC 429 without Retry-After uses 60/120/240/300 second host cooldowns", async () => {
  let clock = 0;
  let physicalCalls = 0;
  const pool = createRpcPool(["https://bsc-mainnet.public.blastapi.io"], [], 1, {
    now: () => clock,
    recoveryProbeIntervalMs: 250,
    providerFactory: () => ({
      async send() {
        physicalCalls += 1;
        const error = new Error("HTTP 429 without a server deadline");
        error.status = 429;
        error.code = "SERVER_ERROR";
        throw error;
      },
      async getBlockNumber() {
        physicalCalls += 1;
        return 123;
      },
    }),
  });

  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
    (error) => error.rpcFailureScope === "host"
      && error.retryAfterMs >= 60_000
      && error.rpcHostRetryAfterMs >= 60_000,
  );
  clock = 59_999;
  await assert.rejects(() => pool.getBlockNumber(), /providers cooling down/);
  assert.equal(physicalCalls, 1, "another method cannot probe the physical host before the minute gate");

  clock = 60_000;
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]),
    (error) => error.retryAfterMs === 120_000,
  );
  assert.equal(physicalCalls, 2, "the first half-open probe fails once and doubles the undeclared cooldown");

  clock = 180_000;
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x3" }]),
    (error) => error.retryAfterMs === 240_000,
  );
  clock = 420_000;
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x4", toBlock: "0x4" }]),
    (error) => error.retryAfterMs === 300_000,
  );
  clock = 720_000;
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x5", toBlock: "0x5" }]),
    (error) => error.retryAfterMs === 300_000,
  );
  assert.equal(physicalCalls, 5, "undeclared cooldowns cap at five minutes without early probes");
  pool.destroy();

  let declaredCalls = 0;
  const declaredPool = createRpcPool(["https://declared-rate-limit.test"], [], 1, {
    now: () => clock,
    hostCircuitRegistry: new Map(),
    providerFactory: () => ({
      async send() {
        declaredCalls += 1;
        const error = new Error("HTTP 429 with a long server deadline");
        error.status = 429;
        error.headers = { "retry-after": "420" };
        throw error;
      },
    }),
  });
  await assert.rejects(
    () => declaredPool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
    (error) => error.retryAfterMs === 420_000,
  );
  clock += 300_000;
  await assert.rejects(() => declaredPool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]), /cooling down/);
  assert.equal(declaredCalls, 1, "the local five-minute exponential cap cannot shorten Retry-After");
  declaredPool.destroy();
});

test("a queued getLogs waiter rechecks a newly opened host circuit before sending", async () => {
  let clock = 0;
  let physicalCalls = 0;
  const pending = new Map();
  let signalStarted;
  const twoStarted = new Promise((resolve) => { signalStarted = resolve; });
  const pool = createRpcPool(["https://bsc.blockrazor.xyz"], [], 1, {
    now: () => clock,
    standardConcurrency: 4,
    hostCircuitRegistry: new Map(),
    providerFactory: () => ({
      async send() {
        physicalCalls += 1;
        const call = physicalCalls;
        if (physicalCalls === 2) signalStarted();
        if (call <= 2) {
          return new Promise((resolve, reject) => pending.set(call, { resolve, reject }));
        }
        return [];
      },
    }),
  });
  const request = (block) => pool.send("eth_getLogs", [{
    address: "0x1111111111111111111111111111111111111111",
    fromBlock: `0x${block.toString(16)}`,
    toBlock: `0x${block.toString(16)}`,
  }]);
  const first = request(1);
  const second = request(2);
  const third = request(3);
  const settled = Promise.allSettled([first, second, third]);
  await twoStarted;
  assert.equal(physicalCalls, 2, "the third request waits behind the per-host cap");
  const rateLimit = new Error("HTTP 429 without Retry-After");
  rateLimit.status = 429;
  pending.get(1).reject(rateLimit);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(physicalCalls, 2,
    "the transferred waiter observes the new host circuit instead of leaking another physical request");
  pending.get(2).resolve([]);
  const results = await settled;
  assert.deepEqual(results.map(({ status }) => status), ["rejected", "fulfilled", "rejected"]);
  assert.equal(physicalCalls, 2);

  clock = 60_000;
  const probeOne = request(4);
  const probeTwo = request(5);
  const probes = await Promise.allSettled([probeOne, probeTwo]);
  assert.equal(physicalCalls, 3, "only one physical half-open probe is admitted at the shared deadline");
  assert.equal(probes.filter(({ status }) => status === "fulfilled").length, 1);
  pool.destroy();
});

test("timed-out BSC hosts use exponential method circuits and only one rotating recovery probe", async () => {
  let clock = Date.parse("2026-08-24T09:00:00.000Z");
  let recovered = false;
  let headCalls = 0;
  const calls = [];
  const pool = createRpcPool([
    "https://bsc-mainnet.public.blastapi.io",
    "https://bsc.blockrazor.xyz",
  ], [], 1, {
    now: () => clock,
    requestTimeoutMs: 1_000,
    recoveryProbeIntervalMs: 250,
    providerFactory: (url) => ({
      async send(method) {
        assert.equal(method, "eth_getLogs");
        calls.push(new URL(url).host);
        if (recovered) return [];
        throw new Error("eth_getLogs timed out after 1000ms");
      },
      async getBlockNumber() {
        headCalls += 1;
        return 123;
      },
    }),
  });

  await assert.rejects(() => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]), /failed on every BSC RPC/);
  assert.equal(calls.length, 2, "the first failure samples each previously healthy endpoint once");
  await assert.rejects(() => pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]), /cooling down/);
  assert.equal(calls.length, 2, "an open circuit adds no requests");
  assert.equal(await pool.getBlockNumber(), 123, "the method-scoped tail circuit cannot disable the WebSocket/head lane");
  assert.equal(headCalls, 1);

  clock += 1_000;
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x3" }]),
    // The other physical host is independently eligible immediately. A
    // method-only timeout must not serialize recovery probes across hosts.
    (error) => error.retryAfterMs >= 1,
  );
  assert.equal(calls.length, 3, "only one due host is probed after all circuits open");
  clock += 250;
  let secondProbeError;
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x4", toBlock: "0x4" }]),
    (error) => {
      secondProbeError = error;
      return error.retryAfterMs >= 250;
    },
  );
  assert.equal(calls.length, 4, "the next low-frequency probe rotates to one other due host");
  assert.notEqual(calls[2], calls[3]);
  clock += secondProbeError.retryAfterMs;
  recovered = true;
  assert.deepEqual(await pool.send("eth_getLogs", [{ fromBlock: "0x5", toBlock: "0x5" }]), []);
  assert.equal(calls.length, 5, "recovery still costs one probe, never a burst across hosts");
  pool.destroy();
});

test("getCode timeout and 403 circuits are method-only and leave the same host log lane available", async () => {
  for (const failure of ["timeout", "forbidden"]) {
    let codeCalls = 0;
    let logCalls = 0;
    const pool = createRpcPool([`https://${failure}.test`], [], 1, {
      providerFactory: () => ({
        async getCode() {
          codeCalls += 1;
          const error = new Error(failure === "timeout" ? "getCode timed out after 1000ms" : "HTTP 403 Forbidden");
          if (failure === "forbidden") error.status = 403;
          throw error;
        },
        async send(method) {
          assert.equal(method, "eth_getLogs");
          logCalls += 1;
          return [];
        },
        async getBlockNumber() { return 123; },
      }),
    });
    await assert.rejects(
      () => pool.getCode("0x1111111111111111111111111111111111111111", 100),
      (error) => error.rpcFailureScope === "method" && error.rpcOperation === "getCode",
    );
    await assert.rejects(() => pool.getCode("0x1111111111111111111111111111111111111111", 100), /cooling down/);
    assert.equal(codeCalls, 1);
    assert.deepEqual(await pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]), []);
    assert.equal(logCalls, 1, `${failure} getCode must not close eth_getLogs on the same physical host`);
    assert.equal(await pool.getBlockNumber(), 123);
    pool.destroy();
  }
});

test("mixed archive 429 and standard method failure retain an independent host cooldown", async () => {
  let clock = Date.parse("2026-09-05T00:00:00.000Z");
  const calls = [];
  const pool = createRpcPool(["https://mixed-standard.test"], ["https://mixed-archive.test"], 1, {
    now: () => clock,
    requestTimeoutMs: 1_000,
    hostCircuitRegistry: new Map(),
    providerFactory: (_url, context) => ({
      async getCode() {
        calls.push(context.kind);
        if (context.kind === "archive") {
          const error = new Error("HTTP 429");
          error.status = 429;
          error.retryAfterMs = 12_000;
          throw error;
        }
        throw new Error("getCode timed out after 1000ms");
      },
    }),
  });
  let firstError;
  await assert.rejects(
    () => pool.getCode("0x1111111111111111111111111111111111111111", 100),
    (error) => {
      firstError = error;
      return error.rpcFailureScope === "method"
        && error.rpcOperation === "getCode"
        && error.rpcHostRetryAfterMs === 12_000;
    },
  );
  assert.deepEqual(calls, ["archive", "standard"]);
  assert.match(firstError.rpcHostFailure, /429/);

  clock += 1;
  await assert.rejects(
    () => pool.getCode("0x1111111111111111111111111111111111111111", 100),
    (error) => error.rpcFailureScope === "method"
      && error.rpcHostRetryAfterMs >= 11_999,
  );
  assert.deepEqual(calls, ["archive", "standard"],
    "the aggregate host evidence prevents a physical archive probe while its 429 is active");
  pool.destroy();
});

test("a host-global 429 permits only one cross-method half-open probe", async () => {
  let clock = Date.parse("2026-08-24T09:00:00.000Z");
  let physicalCalls = 0;
  let releaseProbe;
  let signalProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const probeStarted = new Promise((resolve) => { signalProbe = resolve; });
  const request = async (kind) => {
    physicalCalls += 1;
    if (physicalCalls === 1) {
      const error = new Error("HTTP 429");
      error.status = 429;
      error.retryAfterMs = 1_000;
      throw error;
    }
    signalProbe(kind);
    await probeGate;
    return kind === "code" ? "0x6000" : [];
  };
  const pool = createRpcPool(["https://shared-429.test"], [], 1, {
    now: () => clock,
    standardConcurrency: 4,
    providerFactory: () => ({
      async send(method) { assert.equal(method, "eth_getLogs"); return request("logs"); },
      async getCode() { return request("code"); },
    }),
  });
  await assert.rejects(() => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]), /429/);
  // A host-global 429 has a hard five-second minimum circuit even when the
  // server advertises a shorter Retry-After value.
  clock += 5_000;
  const attempts = [
    pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]),
    pool.getCode("0x1111111111111111111111111111111111111111", 100),
  ];
  const settledPromise = Promise.allSettled(attempts);
  await probeStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(physicalCalls, 2, "different methods share one physical-host recovery lease after a 429");
  releaseProbe();
  const settled = await settledPromise;
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  assert.match(settled.find((result) => result.status === "rejected").reason.message, /recovery probe already in flight/);
  pool.destroy();
});

test("concurrent callers share one half-open BSC recovery probe", async () => {
  let clock = Date.parse("2026-08-24T09:00:00.000Z");
  let calls = 0;
  let releaseProbe;
  let signalProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const probeStarted = new Promise((resolve) => { signalProbe = resolve; });
  const pool = createRpcPool(["https://half-open.test"], [], 1, {
    now: () => clock,
    requestTimeoutMs: 1_000,
    recoveryProbeIntervalMs: 250,
    standardConcurrency: 4,
    providerFactory: () => ({
      async send(method) {
        assert.equal(method, "eth_getLogs");
        calls += 1;
        if (calls === 1) throw new Error("eth_getLogs timed out after 1000ms");
        if (calls === 2) {
          signalProbe();
          await probeGate;
        }
        return [];
      },
    }),
  });

  await assert.rejects(() => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]), /failed on every BSC RPC/);
  clock += 1_000;
  const recovery = pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]);
  await probeStarted;
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x3" }]),
    (error) => /recovery probe already in flight/.test(error.message) && error.retryAfterMs === 250,
  );
  assert.equal(calls, 2, "parallel range recovery must not send a second physical half-open probe");
  releaseProbe();
  assert.deepEqual(await recovery, []);
  assert.deepEqual(await pool.send("eth_getLogs", [{ fromBlock: "0x4", toBlock: "0x4" }]), []);
  assert.equal(calls, 3, "a successful probe reopens the host for the next normal request");
  pool.destroy();
});

test("shared physical-host circuits prevent duplicate 429 probes across BSC pools", async () => {
  const circuits = new Map();
  const clock = Date.parse("2026-08-24T09:00:00.000Z");
  let firstPoolCalls = 0;
  let secondPoolCalls = 0;
  const first = createRpcPool(["https://shared-rpc.test"], [], 1, {
    now: () => clock,
    hostCircuitRegistry: circuits,
    providerFactory: () => ({
      async getBlockNumber() {
        firstPoolCalls += 1;
        const error = new Error("too many requests");
        error.status = 429;
        error.headers = { "retry-after": "9" };
        throw error;
      },
    }),
  });
  const second = createRpcPool(["https://shared-rpc.test"], [], 1, {
    now: () => clock,
    hostCircuitRegistry: circuits,
    providerFactory: () => ({
      async getBlockNumber() {
        secondPoolCalls += 1;
        return 456;
      },
    }),
  });

  await assert.rejects(() => first.getBlockNumber(), (error) => error.retryAfterMs === 9_000);
  await assert.rejects(() => second.getBlockNumber(), /providers cooling down/);
  assert.equal(firstPoolCalls, 1);
  assert.equal(secondPoolCalls, 0, "archive/realtime/main pools must not rediscover the same host-wide 429");
  first.destroy();
  second.destroy();
});

test("an older in-flight success cannot erase a newer shared-host rate-limit generation", async () => {
  let clock = Date.parse("2026-08-24T09:00:00.000Z");
  let releaseFirst;
  let signalFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { signalFirst = resolve; });
  let calls = 0;
  const pool = createRpcPool(["https://generation.test"], [], 1, {
    now: () => clock,
    standardConcurrency: 2,
    providerFactory: () => ({
      async getBlockNumber() {
        calls += 1;
        if (calls === 1) {
          signalFirst();
          await firstGate;
          return 123;
        }
        const error = new Error("HTTP 429 newer generation");
        error.status = 429;
        error.headers = { "retry-after": "10" };
        throw error;
      },
    }),
  });

  const olderSuccess = pool.getBlockNumber();
  await firstStarted;
  await assert.rejects(() => pool.getBlockNumber(), (error) => error.retryAfterMs === 10_000);
  releaseFirst();
  assert.equal(await olderSuccess, 123);
  await assert.rejects(() => pool.getBlockNumber(), /providers cooling down/);
  assert.equal(calls, 2, "the stale success must not reopen the newer 429 circuit");
  clock += 10_000;
  pool.destroy();
});

test("the default BSC transport surfaces one HTTP 429 with its Retry-After instead of ethers retry bursts", async (t) => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(429, { "content-type": "application/json", "retry-after": "17" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const pool = createRpcPool([`http://127.0.0.1:${address.port}`], [], 1, {
    requestTimeoutMs: 1_000,
    hostCircuitRegistry: new Map(),
  });
  t.after(() => pool.destroy());

  await assert.rejects(
    () => pool.getBlockNumber(),
    (error) => error.retryAfterMs > 16_000
      && error.retryAfterMs <= 17_000
      && /failed on every BSC RPC/.test(error.message),
  );
  assert.equal(requests, 1, "the transport circuit must intercept 429 before ethers performs internal retries");
  await assert.rejects(() => pool.getBlockNumber(), /providers cooling down/);
  assert.equal(requests, 1);
});

test("getLogs routing keeps filter-aware provider priority across rotations", async () => {
  const calls = [];
  const pool = createRpcPool([
    "https://bsc-mainnet.public.blastapi.io",
    "https://bsc-rpc.publicnode.com",
    "https://bsc.blockrazor.xyz",
    "https://rpc.48.club",
    "https://bsc.rpc.blxrbdn.com",
  ], [], 1, {
    providerFactory: (url) => ({
      async send(method) {
        assert.equal(method, "eth_getLogs");
        calls.push(new URL(url).host);
        return [];
      },
    }),
  });
  await pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]);
  await pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]);
  const address = "0x1111111111111111111111111111111111111111";
  await pool.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x3", address }]);
  await pool.send("eth_getLogs", [{ fromBlock: "0x4", toBlock: "0x4", address }]);
  await pool.send("eth_getLogs", [{
    fromBlock: "0x5",
    toBlock: "0x5",
    address: Array.from({ length: 9 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`),
  }]);
  assert.deepEqual(calls, [
    "rpc.48.club",
    "rpc.48.club",
    "bsc-rpc.publicnode.com",
    "bsc-rpc.publicnode.com",
    "rpc.48.club",
  ]);
  pool.destroy();
});

test("a recovered preferred getLogs host is probed ahead of a healthy fallback", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  for (const scenario of [
    {
      name: "unscoped 48.club",
      preferred: "rpc.48.club",
      fallback: "bsc.blockrazor.xyz",
      filter: { fromBlock: "0x1", toBlock: "0x1" },
    },
    {
      name: "scoped PublicNode",
      preferred: "bsc-rpc.publicnode.com",
      fallback: "rpc.48.club",
      filter: { address, fromBlock: "0x1", toBlock: "0x1" },
    },
  ]) {
    let clock = 0;
    let preferredHealthy = false;
    const calls = [];
    const pool = createRpcPool([
      "https://bsc-mainnet.public.blastapi.io",
      "https://bsc-rpc.publicnode.com",
      "https://bsc.blockrazor.xyz",
      "https://rpc.48.club",
      "https://bsc.rpc.blxrbdn.com",
    ], [], 1, {
      now: () => clock,
      hostCircuitRegistry: new Map(),
      providerFactory: (url) => ({
        async send() {
          const host = new URL(url).host;
          calls.push(host);
          if (host === scenario.preferred && !preferredHealthy) {
            const error = new Error("HTTP 429 without Retry-After");
            error.status = 429;
            throw error;
          }
          return [];
        },
      }),
    });
    await pool.send("eth_getLogs", [scenario.filter]);
    assert.deepEqual(calls, [scenario.preferred, scenario.fallback], `${scenario.name} falls back once`);
    clock = 59_999;
    await pool.send("eth_getLogs", [scenario.filter]);
    assert.equal(calls.at(-1), scenario.fallback, `${scenario.name} stays closed before its deadline`);
    preferredHealthy = true;
    clock = 60_000;
    await pool.send("eth_getLogs", [scenario.filter]);
    assert.equal(calls.at(-1), scenario.preferred,
      `${scenario.name} receives one due half-open probe ahead of the worse healthy host`);
    await pool.send("eth_getLogs", [scenario.filter]);
    assert.equal(calls.at(-1), scenario.preferred, `${scenario.name} resumes its deterministic first position`);
    pool.destroy();
  }

  const registry = new Map([[
    "bsc.rpc.blxrbdn.com",
    { host: "bsc.rpc.blxrbdn.com", globalUntil: 0, globalFailures: 1, globalGeneration: 1, methods: new Map() },
  ]]);
  const worseCalls = [];
  const worsePool = createRpcPool([
    "https://bsc-rpc.publicnode.com",
    "https://bsc.rpc.blxrbdn.com",
  ], [], 1, {
    hostCircuitRegistry: registry,
    providerFactory: (url) => ({
      async send() { worseCalls.push(new URL(url).host); return []; },
    }),
  });
  await worsePool.send("eth_getLogs", [{ address, fromBlock: "0x1", toBlock: "0x1" }]);
  assert.deepEqual(worseCalls, ["bsc-rpc.publicnode.com"],
    "an expired lower-priority circuit cannot probe ahead of a healthy preferred host");
  worsePool.destroy();
});

test("historical getLogs keeps PublicNode disabled and uses archive 48.club first", async () => {
  const calls = [];
  const pool = createRpcPool(
    ["https://bsc-rpc.publicnode.com", "https://bsc-mainnet.public.blastapi.io"],
    ["https://bsc.blockrazor.xyz", "https://rpc.48.club"],
    1,
    {
      allowPublicNodeLogs: false,
      hostCircuitRegistry: new Map(),
      providerFactory: (url, context) => ({
        async send() {
          calls.push(`${context.kind}:${new URL(url).host}`);
          return [];
        },
      }),
    },
  );
  await pool.send("eth_getLogs", [{
    address: "0x1111111111111111111111111111111111111111",
    fromBlock: "0x64",
    toBlock: "0x64",
  }]);
  assert.deepEqual(calls, ["archive:rpc.48.club"]);
  assert.equal(calls.some((call) => call.includes("publicnode")), false);
  pool.destroy();
});

test("eth_getLogs routes wider ranges only to providers that support them", async () => {
  const calls = [];
  const pool = createRpcPool([
    "https://bsc-mainnet.public.blastapi.io",
    "https://bsc.blockrazor.xyz",
    "https://bsc.rpc.blxrbdn.com",
  ], [], 1, {
    providerFactory: (url) => ({
      async send(method) {
        assert.equal(method, "eth_getLogs");
        calls.push(new URL(url).host);
        return [];
      },
    }),
  });
  await pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x14" }]);
  await pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x28" }]);
  assert.deepEqual(calls, ["bsc.blockrazor.xyz", "bsc.rpc.blxrbdn.com"]);
  pool.destroy();
});

test("eth_getLogs capability cooldown does not block verified block-receipt fallback", async () => {
  let logCalls = 0;
  let receiptCalls = 0;
  const pool = createRpcPool(["https://standard.test"], [], 1, {
    providerFactory: () => ({
      async send(method) {
        if (method === "eth_getLogs") {
          logCalls += 1;
          throw new Error("limit exceeded");
        }
        assert.equal(method, "eth_getBlockReceipts");
        receiptCalls += 1;
        return [];
      },
    }),
  });

  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
    /eth_getLogs failed on every BSC RPC/,
  );
  assert.deepEqual(await pool.send("eth_getBlockReceipts", ["0x1"]), []);
  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]),
    /eth_getLogs failed on every BSC RPC: providers cooling down/,
  );
  assert.equal(logCalls, 1, "the unsupported log method must remain cooled down");
  assert.equal(receiptCalls, 1, "the receipt fallback must retain an independent request lane");
  pool.destroy();
});

test("unsupported non-log send methods get a long method-only cooldown", async () => {
  let receiptCalls = 0;
  let transactionCalls = 0;
  let codeCalls = 0;
  const pool = createRpcPool(["https://standard.test"], [], 1, {
    providerFactory: () => ({
      async send(method) {
        assert.equal(method, "eth_getBlockReceipts");
        receiptCalls += 1;
        throw new Error("the method eth_getBlockReceipts does not exist/is not available");
      },
      async getTransaction(hash) {
        transactionCalls += 1;
        return { hash };
      },
      async getCode() {
        codeCalls += 1;
        return "0x6000";
      },
    }),
  });

  await assert.rejects(
    () => pool.send("eth_getBlockReceipts", ["0x1"]),
    /eth_getBlockReceipts failed on every BSC RPC/,
  );
  await assert.rejects(
    () => pool.send("eth_getBlockReceipts", ["0x2"]),
    (error) => /providers cooling down/.test(error.message) && error.retryAfterMs > 29 * 60_000,
  );
  assert.deepEqual(await pool.getTransaction("0xabc"), { hash: "0xabc" });
  assert.equal(await pool.getCode("0x1111111111111111111111111111111111111111", "latest"), "0x6000");
  assert.equal(receiptCalls, 1, "the unsupported operation must stay method-cooled");
  assert.equal(transactionCalls, 1, "transaction reads must retain their independent lane");
  assert.equal(codeCalls, 1, "code reads must retain their independent lane");
  pool.destroy();
});

test("historical state capability failures do not poison the BSC host across methods", async () => {
  for (const [index, message] of [
    "Archive requests require a personal token",
    "missing trie node",
    "not supported",
    "header not found",
    "block not found",
  ].entries()) {
    let codeCalls = 0;
    let headCalls = 0;
    const pool = createRpcPool([`https://historical-state-${index}.test`], [], 1, {
      providerFactory: () => ({
        async getCode() {
          codeCalls += 1;
          throw new Error(message);
        },
        async getBlockNumber() {
          headCalls += 1;
          return 123;
        },
      }),
    });

    await assert.rejects(
      () => pool.getCode("0x1111111111111111111111111111111111111111", 100),
      new RegExp(message, "i"),
    );
    assert.equal(
      await pool.getBlockNumber(),
      123,
      `${message} must cool only historical state reads, not the entire physical host`,
    );
    await assert.rejects(
      () => pool.getCode("0x1111111111111111111111111111111111111111", 100),
      /providers cooling down/,
    );
    assert.equal(codeCalls, 1, `${message} must retain a method cooldown`);
    assert.equal(headCalls, 1);
    pool.destroy();
  }
});

test("eth_getLogs skips global-only hosts, uses PublicNode for address-scoped logs, and keeps capability failures on a long method cooldown", async () => {
  const officiallyDisabledUrls = [
    "https://bsc-dataseed-public.bnbchain.org",
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-dataseed.nariox.org",
    "https://bsc-dataseed.defibit.io",
    "https://bsc-dataseed.ninicoin.io",
    "https://bsc.nodereal.io",
  ];
  const calls = [];
  const preferred = createRpcPool([
    ...officiallyDisabledUrls,
    "https://bsc.rpc.blxrbdn.com",
    "https://bsc-rpc.publicnode.com",
  ], [], 1, {
    providerFactory: (url) => ({
      async send(method) {
        calls.push({ host: new URL(url).host, method });
        return [];
      },
    }),
  });
  assert.deepEqual(await preferred.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]), []);
  assert.deepEqual(await preferred.send("eth_getLogs", [{
    fromBlock: "0x2",
    toBlock: "0x2",
    address: "0x1111111111111111111111111111111111111111",
  }]), []);
  assert.deepEqual(calls, [
    { host: "bsc.rpc.blxrbdn.com", method: "eth_getLogs" },
    { host: "bsc-rpc.publicnode.com", method: "eth_getLogs" },
  ]);
  preferred.destroy();

  for (const url of officiallyDisabledUrls) {
    const endpointCalls = [];
    const disabled = createRpcPool([url], [], 1, {
      providerFactory: () => ({
        async getBlockNumber() {
          endpointCalls.push("eth_blockNumber");
          return 123;
        },
        async send(method) {
          endpointCalls.push(method);
          return [];
        },
      }),
    });
    await assert.rejects(
      () => disabled.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
      /no log-capable standard providers configured/,
    );
    assert.equal(await disabled.getBlockNumber(), 123);
    assert.deepEqual(await disabled.send("eth_getBlockReceipts", ["0x1"]), []);
    assert.deepEqual(
      endpointCalls,
      ["eth_blockNumber", "eth_getBlockReceipts"],
      `${new URL(url).hostname} must stay available for head/receipt requests without receiving eth_getLogs`,
    );
    disabled.destroy();
  }

  let unsupportedCalls = 0;
  const cooling = createRpcPool(["https://unknown-log-rpc.test"], [], 1, {
    providerFactory: () => ({
      async send() {
        unsupportedCalls += 1;
        throw new Error("limit exceeded");
      },
    }),
  });
  await assert.rejects(() => cooling.send("eth_getLogs", [{ fromBlock: "0x2", toBlock: "0x2" }]), /failed on every BSC RPC/);
  await assert.rejects(
    () => cooling.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x3" }]),
    (error) => /providers cooling down/.test(error.message) && error.retryAfterMs > 29 * 60_000,
  );
  assert.equal(unsupportedCalls, 1, "-32005-style capability failures must not be retried every five seconds");
  cooling.destroy();
});

test("global RPC rate limiting still cools the provider across methods", async () => {
  let logCalls = 0;
  let receiptCalls = 0;
  const pool = createRpcPool(["https://standard.test"], [], 1, {
    providerFactory: () => ({
      async send(method) {
        if (method === "eth_getLogs") {
          logCalls += 1;
          throw new Error("rate limit exceeded");
        }
        receiptCalls += 1;
        return [];
      },
    }),
  });

  await assert.rejects(
    () => pool.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]),
    /eth_getLogs failed on every BSC RPC/,
  );
  await assert.rejects(
    () => pool.send("eth_getBlockReceipts", ["0x1"]),
    /eth_getBlockReceipts failed on every BSC RPC: providers cooling down/,
  );
  assert.equal(logCalls, 1);
  assert.equal(receiptCalls, 0, "a real provider-wide rate limit must prevent fallback hammering");
  pool.destroy();
});

test("an unknown BSC launcher stays silent on one token and confirms exactly once on a second safe token", () => {
  const snapshot = state();
  const first = observation();
  const second = observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    blockNumber: 101,
  });

  assert.equal(evaluateBscObservation(snapshot, first, current), null);
  const decision = evaluateBscObservation(snapshot, second, current);
  assert.equal(decision.kind, "new_launchpad");
  assert.equal(decision.uniqueTokens, 2);
  commitBscDecision(snapshot, decision);
  assert.equal(evaluateBscObservation(snapshot, observation({
    token: "0x5555555555555555555555555555555555555555",
    transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    blockNumber: 102,
  }), current), null);
});

test("a blocked BSC token sample cannot confirm an anonymous launchpad", () => {
  const snapshot = state();
  evaluateBscObservation(snapshot, observation(), current);
  const blocked = evaluateBscObservation(snapshot, observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    security: { decision: "block", metrics: { liquidityConfirmed: true } },
  }), current);
  assert.equal(blocked, null);
  assert.equal(snapshot.launchers["0x1111111111111111111111111111111111111111"].discoveryAlerted, false);
});

test("unknown launchpad confirmation is order-independent and requires both token samples to pass", () => {
  const dangerousFirst = state();
  evaluateBscObservation(dangerousFirst, observation({ security: { decision: "block", reasons: ["检测到可增发入口"], metrics: { liquidityConfirmed: false } } }), current);
  assert.equal(evaluateBscObservation(dangerousFirst, observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }), current), null);

  const dangerousSecond = state();
  evaluateBscObservation(dangerousSecond, observation(), current);
  assert.equal(evaluateBscObservation(dangerousSecond, observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    security: { decision: "block", reasons: ["检测到可增发入口"], metrics: { liquidityConfirmed: false } },
  }), current), null);
});

test("unknown launchpad needs two causal structural transactions from independent callers", () => {
  for (const overrides of [
    { structural: { eligible: false } },
    { causalTokenEvent: false },
    { deployer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  ]) {
    const snapshot = state();
    const first = observation({ deployer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    evaluateBscObservation(snapshot, first, current);
    const second = observation({
      token: "0x4444444444444444444444444444444444444444",
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ...overrides,
    });
    if (overrides.structural) second.structural = overrides.structural;
    assert.equal(evaluateBscObservation(snapshot, second, current), null);
  }
});

test("a reusable token factory without a launch mechanism stays silent", () => {
  const snapshot = state();
  const first = observation();
  first.structural.mechanismEvidence = false;
  evaluateBscObservation(snapshot, first, current);
  const second = observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  second.structural.mechanismEvidence = false;
  assert.equal(evaluateBscObservation(snapshot, second, current), null);
});

test("a repeat curve launcher can confirm without a DEX pool only when liquidity is the sole safety gap", () => {
  const snapshot = state();
  const curveOnly = { decision: "block", reasons: ["池子实际流动性未确认"], metrics: { liquidityConfirmed: false, capabilities: {} } };
  evaluateBscObservation(snapshot, observation({ security: curveOnly }), current);
  const decision = evaluateBscObservation(snapshot, observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    security: curveOnly,
  }), current);
  assert.equal(decision.kind, "new_launchpad");

  const unsafe = state();
  evaluateBscObservation(unsafe, observation(), current);
  assert.equal(evaluateBscObservation(unsafe, observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    security: { decision: "block", reasons: ["检测到可增发入口", "池子实际流动性未确认"], metrics: { liquidityConfirmed: false } },
  }), current), null);
});

test("Flap alerts the first safe token of a later structural mode and suppresses repeats", () => {
  const snapshot = state();
  const platform = { id: "flap", name: "Flap", trust: "official_verified" };
  assert.equal(evaluateBscObservation(snapshot, observation({ platform }), current), null);
  assert.equal(evaluateBscObservation(snapshot, observation({
    platform,
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }), current), null);
  const mode = evaluateBscObservation(snapshot, observation({
    platform,
    token: "0x5555555555555555555555555555555555555555",
    transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    fingerprint: "mode-b",
    selector: "0x87654321",
  }), current);
  assert.equal(mode.kind, "new_mode");
  assert.equal(mode.featureFirstToken, true);
  assert.equal(mode.novelty.selector, "0x87654321");
  commitBscDecision(snapshot, mode);
  assert.equal(evaluateBscObservation(snapshot, observation({
    platform,
    token: "0x8888888888888888888888888888888888888888",
    transactionHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    fingerprint: "mode-b",
    selector: "0x87654321",
  }), current), null);
});

test("Flap alerts the first safe token carrying a new creation event topic", () => {
  const snapshot = state();
  const platform = { id: "flap", name: "Flap", trust: "official_verified" };
  evaluateBscObservation(snapshot, observation({ platform }), current);
  const first = evaluateBscObservation(snapshot, observation({
    platform,
    fingerprint: "topic-mode",
    customTopics: ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }), current);
  assert.equal(first.kind, "new_mode");
  assert.equal(first.featureFirstToken, true);
  assert.deepEqual(first.novelty.customTopics, ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]);
  commitBscDecision(snapshot, first);
  assert.equal(evaluateBscObservation(snapshot, observation({
    platform,
    fingerprint: "topic-mode",
    customTopics: ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    token: "0x5555555555555555555555555555555555555555",
    transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  }), current), null);
});

test("Flap does not relabel a historical safe mode as a feature first-token after warmup", () => {
  const initializedAt = current - 60_000;
  const snapshot = state(new Date(initializedAt).toISOString());
  const platform = { id: "flap", name: "Flap", trust: "official_verified" };
  evaluateBscObservation(snapshot, observation({ platform }), current);
  const historical = observation({
    platform,
    fingerprint: "historical-safe-mode",
    selector: "0x87654321",
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(evaluateBscObservation(snapshot, historical, current), null, "warmup absorbs the existing safe mode");
  const later = observation({
    platform,
    fingerprint: "historical-safe-mode",
    selector: "0x87654321",
    token: "0x5555555555555555555555555555555555555555",
    transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  });
  assert.equal(evaluateBscObservation(snapshot, later, initializedAt + 16 * 60_000), null);
});

test("an official Flap VaultFactory discovered after activation replays the actual first safe token", () => {
  const snapshot = state();
  const platform = { id: "flap", name: "Flap", trust: "official_verified" };
  evaluateBscObservation(snapshot, observation({ platform }), current);
  const first = observation({
    platform,
    fingerprint: "late-vault-factory-mode",
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  first.mode.vaultFactory = "0x6666666666666666666666666666666666666666";
  first.mode.vaultFactoryOfficial = false;
  first.mode.vaultFactoryAlertEligible = false;
  assert.equal(evaluateBscObservation(snapshot, first, current), null, "a permissionless VaultFactory is not announced");

  const replay = structuredClone(first);
  replay.officialDiscoveryReplay = true;
  replay.mode.componentMode = "Vault V4";
  replay.mode.componentModeAlertEligible = true;
  replay.mode.vaultFactoryOfficial = true;
  replay.mode.vaultFactoryAlertEligible = true;
  const decision = evaluateBscObservation(snapshot, replay, current + 1_000);
  assert.equal(decision.kind, "new_mode");
  assert.equal(decision.featureFirstToken, true);
  assert.equal(decision.novelty.vaultFactory, "0x6666666666666666666666666666666666666666");
});

test("Four.Meme alerts only the first safe token tied to an exact official preset activation", () => {
  const snapshot = state();
  const platform = { id: "openfour", name: "Four.Meme / OpenFour", trust: "official_verified" };
  const presetId = "1778027615999";
  const templateFingerprint = "official-template-revision";
  const activationKey = `template:${presetId}:${templateFingerprint}`;
  snapshot.officialSources = { fourMeme: { featureActivations: {
    [activationKey]: {
      key: activationKey,
      type: "template",
      templateId: presetId,
      templateFingerprint,
      template: { id: presetId, name: "Royalty V2", fingerprint: templateFingerprint },
      active: true,
      allowReplay: false,
      firstObservedAt: "2026-08-02T00:59:00.000Z",
      confirmedAt: "2026-08-02T00:59:00.000Z",
    },
  } } };
  evaluateBscObservation(snapshot, observation({ platform, fingerprint: "openfour-baseline" }), current);

  const first = observation({
    platform,
    fingerprint: "openfour-new-preset",
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  Object.assign(first.mode, {
    presetId,
    templateFingerprint,
    template: { id: presetId, name: "Royalty V2", fingerprint: templateFingerprint },
    componentMode: "Four.Meme Royalty V2",
    componentModeAlertEligible: true,
    featureActivationKey: activationKey,
    featureActivationEligible: true,
    curveModule: "0x6666666666666666666666666666666666666666",
    tradeModule: "0x7777777777777777777777777777777777777777",
  });
  const decision = evaluateBscObservation(snapshot, first, current);
  assert.equal(decision.kind, "new_mode");
  assert.equal(decision.featureFirstToken, true);
  assert.equal(decision.novelty.presetId, presetId);
  commitBscDecision(snapshot, decision);
  assert.equal(snapshot.officialSources.fourMeme.featureActivations[activationKey].firstTokenTransactionHash, first.transactionHash);

  const repeat = structuredClone(first);
  repeat.transactionHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  repeat.tokens[0].token = "0x5555555555555555555555555555555555555555";
  repeat.sampleToken = repeat.tokens[0].token;
  assert.equal(evaluateBscObservation(snapshot, repeat, current + 1_000), null);
});

test("Four.Meme live-only activations never enter the historical replay scheduler", () => {
  const liveOnly = {
    active: true,
    allowReplay: false,
    replayCompletedAt: null,
    firstTokenAlertedAt: null,
    firstTokenTransactionHash: null,
  };
  assert.equal(shouldReplayFourMemeActivation(liveOnly), false);
  assert.equal(shouldReplayFourMemeActivation({ ...liveOnly, allowReplay: true }), true);
  assert.equal(shouldReplayFourMemeActivation({ ...liveOnly, allowReplay: true, replayCompletedAt: "2026-08-02T01:00:00.000Z" }), false);
});

test("Four.Meme keeps an unsafe activation token silent and alerts the next token that passes locally", () => {
  const snapshot = state();
  const platform = { id: "fourmeme", name: "Four.Meme", trust: "official_verified" };
  const quoteAddress = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
  const quoteFingerprint = "spcxb-config-v1";
  const activationKey = `quote:SPCXB:${quoteAddress}:${quoteFingerprint}`;
  snapshot.officialSources = { fourMeme: { featureActivations: {
    [activationKey]: {
      key: activationKey,
      type: "quote_config",
      quoteSymbol: "SPCXB",
      quoteAddress,
      quoteFingerprint,
      active: true,
      allowReplay: false,
      firstObservedAt: "2026-08-02T00:59:00.000Z",
      confirmedAt: "2026-08-02T00:59:00.000Z",
    },
  } } };
  evaluateBscObservation(snapshot, observation({ platform, fingerprint: "manager-baseline" }), current);
  const unsafe = observation({
    platform,
    fingerprint: "spcxb-mode",
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    security: { decision: "block", reasons: ["检测到可增发入口"], metrics: { liquidityConfirmed: false } },
  });
  Object.assign(unsafe.mode, {
    quoteAsset: quoteAddress,
    quoteSymbol: "SPCXB",
    quoteFingerprint,
    componentMode: "Four.Meme SPCXB 新底池",
    componentModeAlertEligible: true,
    featureActivationKey: activationKey,
    featureActivationEligible: true,
  });
  assert.equal(evaluateBscObservation(snapshot, unsafe, current), null);
  const safe = structuredClone(unsafe);
  safe.transactionHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  safe.tokens[0].token = "0x5555555555555555555555555555555555555555";
  safe.sampleToken = safe.tokens[0].token;
  safe.security = { decision: "pass", metrics: { liquidityConfirmed: true } };
  const decision = evaluateBscObservation(snapshot, safe, current + 1_000);
  assert.equal(decision.kind, "new_mode");
  assert.equal(decision.featureFirstToken, true);
  assert.equal(decision.novelty.quoteSymbol, "SPCXB");
});

test("Four.Meme replay never attributes a historical token outside the activation lookback", () => {
  const snapshot = state();
  const platform = { id: "fourmeme", name: "Four.Meme", trust: "official_verified" };
  const quoteAddress = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
  const quoteFingerprint = "spcxb-config-v1";
  const activationKey = `quote:SPCXB:${quoteAddress}:${quoteFingerprint}`;
  snapshot.officialSources = { fourMeme: { featureActivations: {
    [activationKey]: {
      key: activationKey,
      type: "quote_config",
      quoteSymbol: "SPCXB",
      quoteAddress,
      quoteFingerprint,
      active: true,
      allowReplay: true,
      firstObservedAt: "2026-08-02T01:00:00.000Z",
      confirmedAt: "2026-08-02T01:00:00.000Z",
      replayCompletedAt: "2026-08-02T01:00:01.000Z",
    },
  } } };
  evaluateBscObservation(snapshot, observation({ platform, fingerprint: "manager-baseline" }), current);
  const makeCandidate = (token, transactionHash, observedAt) => {
    const item = observation({ platform, fingerprint: "spcxb-mode", token, transactionHash });
    item.observedAt = observedAt;
    Object.assign(item.mode, {
      quoteAsset: quoteAddress,
      quoteSymbol: "SPCXB",
      quoteFingerprint,
      componentMode: "Four.Meme SPCXB 新底池",
      componentModeAlertEligible: true,
      featureActivationKey: activationKey,
      featureActivationEligible: true,
    });
    return item;
  };
  assert.equal(evaluateBscObservation(snapshot, makeCandidate(
    "0x4444444444444444444444444444444444444444",
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "2026-08-02T00:44:59.999Z",
  ), current), null);
  const boundary = evaluateBscObservation(snapshot, makeCandidate(
    "0x5555555555555555555555555555555555555555",
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "2026-08-02T00:45:00.000Z",
  ), current);
  assert.equal(boundary.kind, "new_mode");
  assert.equal(boundary.featureActivationKey, activationKey);
});

test("Four.Meme token-API template activations use templateId instead of a fake OpenFour preset", () => {
  const snapshot = state();
  const platform = { id: "fourmeme", name: "Four.Meme", trust: "official_verified" };
  const templateId = "1778027615730";
  const templateFingerprint = "universal-subscription-v1";
  const activationKey = `template:${templateId}:${templateFingerprint}`;
  snapshot.officialSources = { fourMeme: { featureActivations: {
    [activationKey]: {
      key: activationKey,
      type: "template",
      verificationLane: "official_token_api",
      templateId,
      templateFingerprint,
      template: { id: templateId, name: "Universal Subscription", fingerprint: templateFingerprint },
      active: true,
      allowReplay: false,
      firstObservedAt: "2026-08-02T00:59:00.000Z",
      confirmedAt: "2026-08-02T00:59:00.000Z",
    },
  } } };
  evaluateBscObservation(snapshot, observation({ platform, fingerprint: "presale-baseline" }), current);
  const first = observation({
    platform,
    fingerprint: "presale-template-mode",
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  Object.assign(first.mode, {
    templateId,
    templateFingerprint,
    template: { id: templateId, name: "Universal Subscription", fingerprint: templateFingerprint },
    componentMode: "Four.Meme Universal Subscription",
    componentModeAlertEligible: true,
    featureActivationKey: activationKey,
    featureActivationEligible: true,
  });
  const decision = evaluateBscObservation(snapshot, first, current);
  assert.equal(decision.kind, "new_mode");
  assert.equal(decision.novelty.templateId, templateId);
  assert.equal(decision.novelty.presetId, undefined);
});

test("ordinary Four.Meme and OpenFour tokens never become a new-mode alert without an official activation", () => {
  for (const platform of [
    { id: "fourmeme", name: "Four.Meme", trust: "official_verified" },
    { id: "openfour", name: "OpenFour", trust: "official_verified" },
  ]) {
    const snapshot = state();
    evaluateBscObservation(snapshot, observation({ platform }), current);
    assert.equal(evaluateBscObservation(snapshot, observation({
      platform,
      fingerprint: "ordinary-second-mode",
      selector: "0x87654321",
      token: "0x4444444444444444444444444444444444444444",
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }), current), null);
    assert.equal(evaluateBscObservation(snapshot, observation({
      platform,
      fingerprint: "ordinary-second-mode",
      selector: "0x87654321",
      token: "0x5555555555555555555555555555555555555555",
      transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }), current), null);
  }
});

test("known launchpad modes observed during warmup are silently absorbed", () => {
  const snapshot = state(new Date(current - 60_000).toISOString());
  const platform = { id: "fourmeme", name: "Four.Meme", trust: "official_verified" };
  evaluateBscObservation(snapshot, observation({ platform }), current);
  assert.equal(evaluateBscObservation(snapshot, observation({
    platform,
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    fingerprint: "historical-mode-b",
  }), current), null);
});

test("the shared Four.Meme/SpringBoard manager stays silent without exact Four.Meme feature evidence", () => {
  const sharedAddress = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
  const platform = platformForAddress(sharedAddress);
  assert.equal(platform.id, "fourmeme-springboard-shared");
  assert.equal(platform.trust, "official_shared");

  const snapshot = state();
  assert.equal(evaluateBscObservation(snapshot, observation({ launcher: sharedAddress, platform }), current), null);
  assert.equal(evaluateBscObservation(snapshot, observation({
    launcher: sharedAddress,
    platform,
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    fingerprint: "shared-mode-b",
    selector: "0x87654321",
  }), current), null);
  const decision = evaluateBscObservation(snapshot, observation({
    launcher: sharedAddress,
    platform,
    token: "0x5555555555555555555555555555555555555555",
    transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    fingerprint: "shared-mode-b",
    selector: "0x87654321",
  }), current);
  assert.equal(decision, null);
  assert.equal(snapshot.launchers[sharedAddress].discoveryAlerted, false);
});

test("shared Manager proof accepts Four.Meme V3 on BSC and rejects SpringBoard V9", () => {
  assert.equal(isOfficialFourMemeClassicTokenRecord({ version: "V3", networkCode: "BSC" }), true);
  assert.equal(isOfficialFourMemeClassicTokenRecord({ version: "V9", networkCode: "BSC" }), false);
  assert.equal(isOfficialFourMemeClassicTokenRecord({ version: "V3", networkCode: "ETH" }), false);
  assert.equal(isOfficialFourMemeClassicTokenRecord(null), false);
});

test("nested ethers archive errors trigger the latest-state fallback", () => {
  assert.equal(isBscArchiveStateUnavailable({
    message: "missing revert data",
    info: { error: { message: "missing trie node 0xabc" } },
  }), true);
  assert.equal(isBscArchiveStateUnavailable({ message: "execution reverted: invalid token" }), false);
});

test("official first-token sources alert once, while ordinary known platforms remain baseline-only", () => {
  const snapshot = state();
  const platform = { id: "hodldance", name: "HODL.DANCE", trust: "official_verified", notifyFirstToken: true };
  const decision = evaluateBscObservation(snapshot, observation({ platform }), current);
  assert.equal(decision.kind, "new_launchpad");
  assert.equal(decision.officialFirstToken, true);
  commitBscDecision(snapshot, decision);
  assert.equal(evaluateBscObservation(snapshot, observation({
    platform,
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }), current), null);
});

test("an officially sourced and causally corroborated factory can alert on its first safe token", () => {
  const snapshot = state();
  const platform = { id: "newdocslaunch", name: "New Docs Launch", trust: "multi_source_corroborated", notifyFirstToken: true };
  const decision = evaluateBscObservation(snapshot, observation({ platform }), current);
  assert.equal(decision.kind, "new_launchpad");
  assert.equal(decision.officialFirstToken, true);
});

test("official first-token and mode alerts require causal structural locally-safe evidence", () => {
  const platform = { id: "hodldance", name: "HODL.DANCE", trust: "official_verified", notifyFirstToken: true };
  for (const field of ["causal", "structural", "security"]) {
    const snapshot = state();
    const item = observation({ platform });
    if (field === "causal") item.causalTokenEvent = false;
    if (field === "structural") item.structural.eligible = false;
    if (field === "security") item.security = { decision: "block", reasons: ["honeypot"] };
    assert.equal(evaluateBscObservation(snapshot, item, current), null);
  }

  const snapshot = state();
  const flap = { id: "flap", name: "Flap", trust: "official_verified" };
  evaluateBscObservation(snapshot, observation({ platform: flap }), current);
  const unsafeMode = observation({
    platform: flap,
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    fingerprint: "unsafe-implementation",
    selector: "0x87654321",
    security: { decision: "block", reasons: ["honeypot"] },
  });
  unsafeMode.mode.implementation = "0x9999999999999999999999999999999999999999";
  assert.equal(evaluateBscObservation(snapshot, unsafeMode, current), null);
});

test("historical migration replay rebuilds evidence without re-alerting old modes", () => {
  const snapshot = { ...state(), alertSuppressedThroughBlock: 101 };
  const platform = { id: "flap", name: "Flap", trust: "official_verified", notifyFirstToken: true };
  assert.equal(evaluateBscObservation(snapshot, observation({ platform, blockNumber: 99 }), current), null);
  assert.equal(snapshot.launchers["0x1111111111111111111111111111111111111111"].discoveryAlerted, true);
  for (const [blockNumber, token, transactionHash] of [
    [100, "0x4444444444444444444444444444444444444444", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    [101, "0x5555555555555555555555555555555555555555", "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
  ]) {
    assert.equal(evaluateBscObservation(snapshot, observation({ platform, blockNumber, token, transactionHash, fingerprint: "historical-mode", selector: "0x87654321" }), current), null);
  }
  const launcher = snapshot.launchers["0x1111111111111111111111111111111111111111"];
  assert.ok(launcher.alertedModes.includes("historical-mode"));
  assert.equal(evaluateBscObservation(snapshot, observation({
    platform,
    blockNumber: 102,
    token: "0x6666666666666666666666666666666666666666",
    transactionHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    fingerprint: "historical-mode",
    selector: "0x87654321",
  }), current), null);
});

test("runtime lifecycle topics alone cannot create a new official mode", () => {
  const snapshot = state();
  const platform = { id: "flap", name: "Flap", trust: "official_verified" };
  evaluateBscObservation(snapshot, observation({ platform }), current);
  for (const [index, token] of ["0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555"].entries()) {
    const item = observation({ platform, token, transactionHash: `0x${String(index + 11).repeat(64).slice(0, 64)}`, fingerprint: "lifecycle-only" });
    item.mode.creationTopics = [];
    item.mode.customTopics = ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"];
    assert.equal(evaluateBscObservation(snapshot, item, current), null);
  }
});

test("parses a BSC V2 pair event and recognizes the verified Pancake factory", () => {
  const factory = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
  const pair = "0x3333333333333333333333333333333333333333";
  const iface = new Interface(["event PairCreated(address indexed token0,address indexed token1,address pair,uint256)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("PairCreated"), [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    pair,
    1n,
  ]);
  const [parsed] = parseBscPoolLogs([{ address: factory, topics: encoded.topics, data: encoded.data }]);
  assert.equal(encoded.topics[0], BSC_PAIR_CREATED_TOPIC);
  assert.equal(parsed.kind, "PancakeSwap V2");
  assert.equal(parsed.pool, pair);
  assert.equal(parsed.verifiedDex, true);
});

test("BSC catalog contains verified Four.Meme, OpenFour, Flap and GraFun roots", () => {
  assert.equal(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "flap").trust, "official_verified");
  assert.equal(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "fourmeme").launchers.length, 6);
  assert.equal(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "openfour").trust, "official_verified");
  assert.deepEqual(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "grafun").launchers, ["0x8341b19a2a602eae0f22633b6da12e1b016e6451"]);
});

test("Bullshot official contract inventory covers every current BSC bonding threshold", () => {
  const bullshot = BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "bullshot");
  assert.equal(bullshot.trust, "official_verified");
  assert.equal(bullshot.evidenceUrl, "https://docs.bullshot.io/?page=contracts");
  assert.deepEqual(new Set(bullshot.launchers), new Set([
    "0xcdba6243e733f7d7cdcbc0b4b10f703a11f7432d",
    "0x8cee21c45c2fec7bdf3181faafa4cc857421202b",
    "0x18b0d0c5aad9fa205198f6eaf58123d3fbfa0f9c",
    "0x8d9d3e29876787fd2441b3f8470bb6350eebb6bf",
    "0xada338ab1f3077c20934daf2317c03a8c56ddf8a",
  ]));
  assert.equal(platformForAddress("0xCdBA6243E733f7d7Cdcbc0B4B10F703A11F7432d").id, "bullshot");
  assert.equal(platformForAddress("0xaDA338Ab1f3077C20934daF2317C03a8c56DDF8a").id, "bullshot");
});

test("a permissionless vanity deployer used by linked burners is excluded, not branded as Flap", () => {
  const deployer = "0x9f2cd4035023fb3bb1400f7a98ab5d0a59bfbb61";
  assert.equal(BSC_EXCLUDED_CONTROLLERS.has(deployer), true);
  assert.equal(platformForAddress(deployer), null);
});

test("Bullshot Created is exact official token evidence", () => {
  const iface = new Interface(["event Created(address indexed bondingCurve,address indexed token,address indexed referrer,address creator)"]);
  const bondingCurve = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const creator = "0x3333333333333333333333333333333333333333";
  const encoded = iface.encodeEventLog(iface.getEvent("Created"), [bondingCurve, token, "0x0000000000000000000000000000000000000000", creator]);
  assert.equal(encoded.topics[0], BULLSHOT_CREATED_TOPIC);
  const [evidence] = parseKnownBscLaunchEvidence([{
    address: "0xcdba6243e733f7d7cdcbc0b4b10f703a11f7432d",
    topics: encoded.topics,
    data: encoded.data,
  }]);
  assert.equal(evidence.token, token);
  assert.equal(evidence.creator, creator);
  assert.equal(evidence.bondingCurve, bondingCurve);
  assert.equal(evidence.launchType, "bonding_curve");
});

test("official Four.Meme parsers keep only BSC launch roots and stable template fields", () => {
  const addresses = parseFourMemeAddressPayload({ code: 0, data: [
    { name: "TokenManager4", address: "0x1111111111111111111111111111111111111111", networkCode: "BSC", network: 0 },
    { name: "TOKEN_MANAGER_HELPER", address: "0x2222222222222222222222222222222222222222", networkCode: "BSC", network: 0 },
    { name: "TokenManagerEth", address: "0x3333333333333333333333333333333333333333", networkCode: "ETH", network: 1 },
  ] });
  assert.deepEqual(addresses.roots.map((item) => item.address), ["0x1111111111111111111111111111111111111111"]);
  const first = parseFourMemeTemplatePayload({ code: 0, data: [{ id: 7, name: "Royalty", tag: "Tax", codeType: "SOLIDITY", amount: "5000", descr: "Fee  sharing costs 0.2 BNB", status: "PUBLISHED", deploys: 1, likes: 2 }] });
  const second = parseFourMemeTemplatePayload({ code: 0, data: [{ id: 7, name: "Royalty", tag: "Tax", codeType: "SOLIDITY", amount: "5000", descr: "Fee   sharing costs 0.2 BNB", status: "PUBLISHED", deploys: 999, likes: 800 }] });
  assert.equal(first[0].fingerprint, second[0].fingerprint);
  assert.equal(first[0].description, "Fee sharing costs 0.2 BNB");
  const changedParameter = parseFourMemeTemplatePayload({ code: 0, data: [{ id: 7, name: "Royalty", tag: "Tax", codeType: "SOLIDITY", amount: "6000", descr: "Fee sharing costs 0.3 BNB", status: "PUBLISHED" }] });
  assert.notEqual(first[0].fingerprint, changedParameter[0].fingerprint);
  const presaleList = parseFourMemeTemplatePayload({ code: 0, data: [{ id: 8, name: "Universal Subscription", tag: "Presale", codeType: "SOLIDITY", amount: "5000", descr: "Subscription with refunds costs 0.2 BNB", status: "PUBLISHED" }] });
  const presaleTokenRecord = parseFourMemeTemplatePayload({ code: 0, data: [{ id: 8, name: "Universal Subscription", tags: ["Presale"], codeType: "SOLIDITY", amount: "5000", descr: "Subscription with refunds costs 0.2 BNB", status: "PUBLISHED" }] });
  assert.equal(presaleList[0].fingerprint, presaleTokenRecord[0].fingerprint);
});

test("OpenFour launch evidence preserves the exact preset and stable module graph", () => {
  const iface = new Interface(["event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)"]);
  const creator = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const addresses = Array.from({ length: 7 }, (_, index) => `0x${String(index + 3).repeat(40)}`);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [
    9n, 1778027615723n, creator, token, "Royalty First", "RF", 1000n, 800n, 20n, 1n,
    ...addresses, "ipfs://royalty", 5n, "0x1234",
  ]);
  const [evidence] = parseKnownBscLaunchEvidence([{
    address: "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3",
    topics: encoded.topics,
    data: encoded.data,
  }]);
  assert.equal(evidence.presetId, "1778027615723");
  assert.equal(evidence.requestId, "9");
  assert.equal(evidence.quoteAsset.toLowerCase(), addresses[0].toLowerCase());
  assert.equal(evidence.curveModule.toLowerCase(), addresses[2].toLowerCase());
  assert.equal(evidence.tradeModule.toLowerCase(), addresses[3].toLowerCase());
  assert.equal(evidence.migrateModule.toLowerCase(), addresses[4].toLowerCase());
  assert.equal(evidence.tokenModule.toLowerCase(), addresses[6].toLowerCase());
  assert.equal(evidence.flags, "5");
});

test("Four.Meme quote parser treats published quote assets as modes with stable semantic fingerprints", () => {
  const make = (overrides = {}) => ({
    code: 0,
    data: [{
      symbol: "SPCXB",
      symbolAddress: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1",
      platform: "MEME",
      networkCode: "BSC",
      status: "PUBLISH",
      buyFee: "0.01",
      totalBAmount: "90",
      tradeLevel: ["0.5", "2", "5"],
      price: "123.45",
      ...overrides,
    }],
  });
  const first = parseFourMemeQuotePayload(make())[0];
  const priceOnly = parseFourMemeQuotePayload(make({ price: "999.99" }))[0];
  const mechanismChange = parseFourMemeQuotePayload(make({ totalBAmount: "120" }))[0];
  assert.equal(first.symbol, "SPCXB");
  assert.equal(first.fingerprint, priceOnly.fingerprint);
  assert.notEqual(first.fingerprint, mechanismChange.fingerprint);
});

test("DappBay is parsed only as a BSC launchpad discovery candidate with build contracts", () => {
  const result = parseDappBayLaunchpadCatalog({ list: [
    { id: 1, name: "Fresh Launchpad", category: "DeFi", description: "Memecoin bonding curve launchpad", website: "https://fresh.example", twitter_url: "https://x.com/fresh", uniq_name: "fresh", chain_info: [{ id: 1, name: "BNB Smart Chain" }], build_contracts: [{ chain_info_id: 1, contract: "0x1111111111111111111111111111111111111111" }] },
    { id: 2, name: "Base Launchpad", description: "token launchpad", chain_info: [{ id: 8453, name: "Base" }], build_contracts: [{ chain_info_id: 8453, contract: "0x2222222222222222222222222222222222222222" }] },
    { id: 3, name: "BSC Game", description: "ordinary game", chain_info: [{ id: 1, name: "BNB Smart Chain" }], build_contracts: [{ chain_info_id: 1, contract: "0x3333333333333333333333333333333333333333" }] },
  ] });
  assert.equal(result.length, 1);
  assert.equal(result[0].address, "0x1111111111111111111111111111111111111111");
  assert.equal(result[0].trust, "ecosystem_directory_candidate");
});

test("Rugspull official API restores only children belonging to the verified BSC factory", () => {
  const valid = "0x1111111111111111111111111111111111111111";
  const records = parseOfficialRugspullCatalog({ rugs: [
    { chain_id: 56, rug_address: valid, factory_address: "0xDFF540baBCa2ee8A2A8Ff26359Ecc9c5921D8A63", created_block: 123, status: "Active" },
    { chain_id: 56, rug_address: "0x2222222222222222222222222222222222222222", factory_address: "0x3333333333333333333333333333333333333333" },
    { chain_id: 97, rug_address: "0x4444444444444444444444444444444444444444", factory_address: "0xDFF540baBCa2ee8A2A8Ff26359Ecc9c5921D8A63" },
  ] });
  assert.deepEqual(records, [{ child: valid, createdBlock: 123, status: "Active" }]);
});

test("Rugspull pagination stops on short pages and non-advancing cursors", () => {
  assert.equal(nextRugspullCatalogCursor({ rugs: Array(100).fill({}), nextCursor: 100 }, null), "100");
  assert.equal(nextRugspullCatalogCursor({ rugs: [], nextCursor: 100 }, "100"), null);
  assert.equal(nextRugspullCatalogCursor({ rugs: Array(100).fill({}), nextCursor: 100 }, "100"), null);
  assert.equal(nextRugspullCatalogCursor({ rugs: Array(12).fill({}), nextCursor: 212 }, "200"), null);
});

test("waifu mode fingerprints deduplicate ordinary tokens but retain mechanism differences", () => {
  assert.equal(
    waifuModeFingerprint({ token: "0x1111111111111111111111111111111111111111", tier: "Gold", vault: "0x2222222222222222222222222222222222222222" }),
    waifuModeFingerprint({ token: "0x3333333333333333333333333333333333333333", tier: "Gold", vault: "0x4444444444444444444444444444444444444444" }),
  );
  assert.notEqual(
    waifuModeFingerprint({ tier: "Gold", vault: "0x2222222222222222222222222222222222222222" }),
    waifuModeFingerprint({ tier: "Gold", vault: null }),
  );
});

test("token-correlated emitter detection requires an exact ABI address word", () => {
  const token = "0x1111111111111111111111111111111111111111";
  const emitter = "0x2222222222222222222222222222222222222222";
  const topic = `0x${"f".repeat(64)}`;
  const word = `0x${"0".repeat(24)}${token.slice(2)}`;
  assert.deepEqual(findTokenCorrelatedEmitters([{ address: emitter, topics: [topic, word], data: "0x" }], [token]), [{ emitter, token, topic }]);
  assert.deepEqual(findTokenCorrelatedEmitters([{ address: emitter, topics: [topic], data: `0x${"0".repeat(23)}${token.slice(2)}0` }], [token]), []);
});

test("known Flap launch topic extracts its token from event data", () => {
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const token = "0x2222222222222222222222222222222222222222";
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1, "0x1111111111111111111111111111111111111111", 2, token, "Test", "TST", "{}"]);
  assert.deepEqual(parseKnownBscLaunchTokens([{ address: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0", topics: encoded.topics, data: encoded.data }]), [token]);
});

test("Flap Vault launch evidence preserves the exact VaultFactory address", () => {
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const token = "0x2222222222222222222222222222222222222222";
  const vault = "0x3333333333333333333333333333333333333333";
  const vaultFactory = "0x4444444444444444444444444444444444444444";
  const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, vaultFactory]);
  assert.equal(encoded.topics[0], FLAP_VAULT_TOKEN_CREATED_TOPIC);
  const [evidence] = parseKnownBscLaunchEvidence([{
    address: "0x90497450f2a706f1951b5bdda52b4e5d16f34c06",
    topics: encoded.topics,
    data: encoded.data,
  }]);
  assert.equal(evidence.token, token);
  assert.equal(evidence.vault, vault);
  assert.equal(evidence.vaultFactory, vaultFactory);
});

test("Four.Meme TokenCreate is exact causal evidence while purchase lifecycle topics are not", () => {
  const creator = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const manager = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
  const iface = new Interface(["event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 raisedAmount,uint256 reservedAmount)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreate"), [creator, token, 7n, "First", "ONE", 1_000_000n, 0n, 0n]);
  assert.equal(encoded.topics[0], FOUR_MEME_TOKEN_CREATE_TOPIC);
  assert.deepEqual(parseKnownBscLaunchTokens([{ address: manager, topics: encoded.topics, data: encoded.data }]), [token]);
  assert.deepEqual(parseKnownBscLaunchTokens([{ address: manager, topics: ["0x48063b1239b68b5d50123408787a6df1f644d9160f0e5f702fefddb9a855954d"], data: `0x${"0".repeat(24)}${token.slice(2)}` }]), []);
});

test("Four.Meme Presale TokenCreate decodes the exact Universal Subscription token", () => {
  const iface = new Interface(["event TokenCreate(uint256 requestId,address creator,address token)"]);
  const manager = "0x704352c86b10247f361ccb7a1c95841c35753a17";
  const creator = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreate"), [7n, creator, token]);
  const [evidence] = parseKnownBscLaunchEvidence([{ address: manager, topics: encoded.topics, data: encoded.data }]);
  assert.equal(encoded.topics[0], FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC);
  assert.equal(evidence.token, token);
  assert.equal(evidence.creator, creator);
  assert.equal(evidence.requestId, "7");
  assert.equal(evidence.launchType, "fourmeme_presale");
});

test("OpenFour TokenCreated decodes its indexed creator and token as exact causal evidence", () => {
  const iface = new Interface(["event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)"]);
  const creator = "0xC366Fd5cAdE36Bf0C116eB600A5f3D8aB7C17F8B";
  const token = "0x5B17A2Dd61Fe73c39590154433E0Ad0bc2E3335C";
  const zero = "0x0000000000000000000000000000000000000000";
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1n, 2n, creator, token, "Open", "OPEN", 1n, 1n, 1n, 1n, zero, zero, zero, zero, zero, zero, zero, "ipfs://meta", 0n, "0x"]);
  const [evidence] = parseKnownBscLaunchEvidence([{ address: "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3", topics: encoded.topics, data: encoded.data }]);
  assert.equal(encoded.topics[0], OPENFOUR_TOKEN_CREATED_TOPIC);
  assert.equal(evidence.token, token);
  assert.equal(evidence.creator, creator);
  assert.equal(evidence.launchType, "openfour_modular");
});

test("Rugspull child finalize needs no calldata arguments when its exact launch event is present", () => {
  assert.equal(hasBscLaunchArgumentEvidence({
    argumentBytes: 0,
    controllerKind: "official_child_event_emitter",
    creationTopics: [RUG_LAUNCH_SUCCEEDED_TOPIC],
  }), true);
  assert.equal(hasBscLaunchArgumentEvidence({ argumentBytes: 0, controllerKind: "root_fallback", creationTopics: [] }), false);
  assert.equal(hasBscLaunchArgumentEvidence({ argumentBytes: 32, controllerKind: "root_fallback", creationTopics: [] }), true);
});

test("MoonSale token-factory events are subscribed and parsed as exact launch evidence", () => {
  const factory = "0x8D1490006De561C4380e3066a6A1210Bc37A205D";
  const token = "0x2222222222222222222222222222222222222222";
  const creator = "0x1111111111111111111111111111111111111111";
  const iface = new Interface(["event TokenCreated(address indexed token,address indexed creator,string name,string symbol,uint8 decimals,uint256 totalSupply,uint256 maxSupply,bool mintable,bool burnable)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [token, creator, "Moon", "MOON", 18, 1_000_000n, 2_000_000n, true, true]);
  assert.equal(encoded.topics[0], MOONSALE_TOKEN_CREATED_TOPIC);
  const [evidence] = parseKnownBscLaunchTokens([{ address: factory, topics: encoded.topics, data: encoded.data }]);
  assert.equal(evidence, token);
});

test("strict ERC20 mint detection excludes ERC721 Transfer logs", () => {
  const recipient = `0x${"0".repeat(24)}2222222222222222222222222222222222222222`;
  assert.equal(isErc20MintLog({
    topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, recipient],
    data: `0x${"0".repeat(63)}1`,
  }), true);
  assert.equal(isErc20MintLog({
    topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, recipient, `0x${"0".repeat(63)}1`],
    data: "0x",
  }), false);
});

test("BscScan creation evidence is scoped to the Contract Creator section", () => {
  const creationHash = `0x${"a".repeat(64)}`;
  const unrelatedHash = `0x${"b".repeat(64)}`;
  const html = `<a href="/tx/${unrelatedHash}">noise</a><!-- Contract Creator --><span>Contract</span>Creator<a href='/tx/${creationHash}'>created</a>`;
  assert.equal(parseBscScanCreationTransaction(html), creationHash);
  assert.equal(parseBscScanCreationTransaction(`<a href="/tx/${unrelatedHash}">noise</a>`), null);
});

test("v2 BSC state is normalized and durably migrated while a future version is rejected", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-state-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  await fs.writeFile(stateFile, JSON.stringify({ version: 2, lastFinalizedBlock: 77, hooks: null, transactionFailures: null, launchers: {}, seenTransactions: { "0xabc": 76 }, coverageGaps: [] }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
  const migrated = await monitor.getState();
  assert.equal(migrated.version, 7);
  assert.equal(migrated.lastFinalizedBlock, 77);
  assert.deepEqual(migrated.hooks, {});
  assert.deepEqual(migrated.transactionFailures, {});
  assert.equal(migrated.seenTransactions["0xabc"], 76);
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).version, 7);

  const futureDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-state-future-"));
  t.after(() => fs.rm(futureDir, { recursive: true, force: true }));
  const futureFile = path.join(futureDir, "bsc-launchpad-state.json");
  await fs.writeFile(futureFile, JSON.stringify({ version: 8 }));
  const future = createBscLaunchpadMonitor({ dataDir: futureDir }, { autoStart: false, provider: { destroy() {} } });
  await assert.rejects(() => future.getState(), /newer than supported/);
  assert.equal(JSON.parse(await fs.readFile(futureFile, "utf8")).version, 8);
});

test("deferred creation evidence is never pruned by ordinary state maintenance", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-deferred-retention-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const deferredCreationEvidence = Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => {
    const transactionHash = `0x${index.toString(16).padStart(64, "0")}`;
    return [transactionHash, { transactionHash, blockNumber: index + 1, firstDeferredAt: "2026-08-02T00:00:00.000Z", nextAttemptAt: "2099-01-01T00:00:00.000Z" }];
  }));
  const unresolvedCoverageGaps = Array.from({ length: 30 }, (_, index) => ({
    fromBlock: index + 1,
    toBlock: index + 1,
    transactionHash: `0x${(index + 3_000).toString(16).padStart(64, "0")}`,
    detectedAt: "2026-08-02T00:00:00.000Z",
    status: "deferred",
  }));
  const resolvedCoverageGaps = Array.from({ length: 30 }, (_, index) => ({
    fromBlock: index + 101,
    toBlock: index + 101,
    transactionHash: `0x${(index + 4_000).toString(16).padStart(64, "0")}`,
    detectedAt: "2026-08-02T00:00:00.000Z",
    resolvedAt: new Date(Date.parse("2026-08-02T01:00:00.000Z") + index).toISOString(),
    status: "resolved",
  }));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 100,
    deferredCreationEvidence,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [...unresolvedCoverageGaps, ...resolvedCoverageGaps],
  }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
  t.after(() => monitor.stop());
  await monitor.observe(observation());
  const retained = await monitor.getState();
  assert.equal(Object.keys(retained.deferredCreationEvidence).length, 2_001);
  assert.equal(retained.coverageGaps.filter((gap) => !gap.resolvedAt && gap.status !== "resolved").length, 30);
  assert.equal(retained.coverageGaps.filter((gap) => gap.resolvedAt || gap.status === "resolved").length, 20);
});

test("a deferred poison error is rescheduled and never marked seen or quarantined", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-deferred-poison-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"a".repeat(64)}`;
  const token = `0x${"1".repeat(40)}`;
  const clock = Date.parse("2026-08-02T01:00:00.000Z");
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 100,
    deferredCreationEvidence: {
      [transactionHash]: {
        transactionHash,
        blockNumber: 101,
        reasons: ["zero_mint"],
        mintEmitters: [token],
        candidateTokens: [],
        verifiedNewContracts: [],
        upgradeEmitters: [],
        hookPools: [],
        hasProtocolTrigger: false,
        revision: 1,
        attempts: 1,
        firstDeferredAt: "2026-08-02T00:00:00.000Z",
        nextAttemptAt: "2026-08-02T00:00:00.000Z",
      },
    },
    launchers: {},
    hooks: {},
    seenTransactions: {},
    transactionFailures: {},
    coverageGaps: [],
  }));
  const provider = {
    async getCode() { throw new Error("missing trie node"); },
    async getTransaction() { throw new Error("poison transaction response"); },
    async getTransactionReceipt() { return { transactionHash, blockNumber: "0x65", logs: [] }; },
    destroy() {},
  };
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => `<!-- Contract Creator --><a href='/tx/${transactionHash}'>created</a>` });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider,
    fetchImpl,
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(() => monitor.stop());
  await monitor.retryDeferredCreationEvidence();
  const snapshot = await monitor.getState();
  assert.equal(snapshot.deferredCreationEvidence[transactionHash].attempts, 2);
  assert.ok(Date.parse(snapshot.deferredCreationEvidence[transactionHash].nextAttemptAt) > clock);
  assert.equal(snapshot.seenTransactions[transactionHash], undefined);
  assert.equal(snapshot.transactionFailures[transactionHash], undefined);
  assert.deepEqual(snapshot.coverageGaps, []);
});

test("BSC WebSocket ingress keeps its original five-second SLA through durable deferral and restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-websocket-delivery-sla-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const transactionHash = `0x${"d".repeat(64)}`;
  const token = "0x1111111111111111111111111111111111111111";
  const recipientTopic = `0x${"0".repeat(24)}2222222222222222222222222222222222222222`;
  const ingressAt = Date.parse("2026-08-20T12:00:00.000Z");
  let clock = ingressAt;
  const expectedSla = {
    startedAt: "2026-08-20T12:00:00.000Z",
    deadlineAt: "2026-08-20T12:00:05.000Z",
    budgetMs: 5_000,
    pollAllowanceMs: 0,
    basis: "bsc_websocket_ingest",
  };
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(ingressAt - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 101,
    realtimeTailNextBlock: 102,
    launchers: {},
    seenTransactions: {},
    coverageGaps: [],
  }));

  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 103; },
    async getCode() {
      const error = new Error("missing trie node");
      error.code = "SERVER_ERROR";
      throw error;
    },
    destroy() {},
  };
  class FakeWebSocket {
    static instance = null;
    constructor() {
      this.handlers = new Map();
      this.subscriptions = new Map();
      FakeWebSocket.instance = this;
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const handlers = this.handlers.get(kind) || [];
      handlers.push(handler);
      this.handlers.set(kind, handlers);
    }
    emit(kind, event) {
      for (const handler of this.handlers.get(kind) || []) handler(event);
    }
    send(raw) {
      const request = JSON.parse(raw);
      const subscription = `sub-${request.id}`;
      const kind = request.params[0] === "newHeads"
        ? "heads"
        : request.params[1]?.topics?.[0] === BSC_TRANSFER_TOPIC ? "mints" : "protocol";
      this.subscriptions.set(kind, subscription);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription }),
      }));
    }
    emitSubscription(kind, result) {
      this.emit("message", {
        data: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscription",
          params: { subscription: this.subscriptions.get(kind), result },
        }),
      });
    }
    close() {}
  }
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://bscscan.com/address/")) {
      return { ok: true, status: 200, text: async () => "<html>creation indexing pending</html>" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: [] }) };
  };
  const config = {
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
  };
  const first = createBscLaunchpadMonitor(config, {
    autoStart: false,
    provider,
    WebSocketImpl: FakeWebSocket,
    fetchImpl,
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    await first.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await first.start();
  await waitUntil(() => FakeWebSocket.instance?.subscriptions.has("mints")
    && FakeWebSocket.instance?.subscriptions.has("heads"));
  const mintResult = {
    address: token,
    transactionHash,
    blockNumber: "0x65",
    transactionIndex: "0x0",
    logIndex: "0x0",
    topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, recipientTopic],
    data: `0x${"0".repeat(63)}1`,
  };
  FakeWebSocket.instance.emitSubscription("mints", mintResult);
  clock += 1_000;
  FakeWebSocket.instance.emitSubscription("mints", mintResult);
  clock += 2_200;
  FakeWebSocket.instance.emitSubscription("heads", { number: "0x67" });
  await waitUntil(async () => Boolean((await first.getState()).deferredCreationEvidence?.[transactionHash]));
  let snapshot = await first.getState();
  assert.deepEqual(snapshot.deferredCreationEvidence[transactionHash].deliverySla, expectedSla);
  assert.equal(snapshot.deferredCreationEvidence[transactionHash].attempts, 1);
  await first.stop();

  clock = ingressAt + 20_000;
  const restarted = createBscLaunchpadMonitor(config, {
    autoStart: false,
    provider,
    fetchImpl,
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(() => restarted.stop());
  await restarted.retryDeferredCreationEvidence();
  snapshot = await restarted.getState();
  assert.deepEqual(snapshot.deferredCreationEvidence[transactionHash].deliverySla, expectedSla);
  assert.equal(snapshot.deferredCreationEvidence[transactionHash].attempts, 2);
  assert.equal(snapshot.deferredCreationEvidence[transactionHash].deliverySla.deadlineAt, expectedSla.deadlineAt,
    "a restart/retry must not replace an expired source deadline with a later budget");
});

test("official GitHub and docs contract discoveries are persisted for later causal attribution", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-external-discovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const address = "0x1111111111111111111111111111111111111111";
  const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
  assert.equal(await monitor.registerDiscoveryCandidates([{
    address,
    platformName: "HODL.DANCE",
    sourceTrust: "official_verified",
    sourceId: "github:hodldance/hodl-dance",
    sourceUrl: "https://github.com/hodldance/hodl-dance/commit/example",
  }]), 1);
  const migrated = await monitor.getState();
  const candidate = migrated.discoverySources.external.contracts[address];
  assert.equal(candidate.platform.id, "hodldance");
  assert.equal(candidate.sources[0].sourceTrust, "official_verified");
});

test("an official source address and its first causal safe token are joined end to end", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-source-first-token-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const launcher = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const pool = "0x3333333333333333333333333333333333333333";
  const ownerCall = new Interface(["function owner() view returns(address)"]);
  const poolCall = new Interface(["function getReserves() view returns(uint112,uint112,uint32)"]);
  const alerts = [];
  const provider = {
    async getCode() { return "0x60006000"; },
    async getStorage() { return "0x"; },
    async call(request) {
      if (request.data === ownerCall.encodeFunctionData("owner")) {
        return ownerCall.encodeFunctionResult("owner", ["0x0000000000000000000000000000000000000000"]);
      }
      if (request.data === poolCall.encodeFunctionData("getReserves")) {
        return poolCall.encodeFunctionResult("getReserves", [1n, 1n, 1]);
      }
      return "0x";
    },
    destroy() {},
  };
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => url.includes("dexscreener") ? "[]" : "{}",
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    externalAttribution: true,
    provider,
    fetchImpl,
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  await monitor.registerDiscoveryCandidates([{
    address: launcher,
    platformName: "New Docs Launch",
    sourceTrust: "official_verified",
    sourceId: "github:new/docs-launch",
    sourceUrl: "https://github.com/new/docs-launch/commit/1",
  }]);
  const item = observation({ launcher, token });
  item.pools = [{ kind: "PancakeSwap V2", pool, factory: "0xca143ce32fe78f1f7019d7d551a6402fc5350c73" }];
  item.platform = null;
  item.security = null;
  item.sampleToken = null;
  item.deliverySla = {
    startedAt: item.observedAt,
    deadlineAt: new Date(Date.parse(item.observedAt) + 5_000).toISOString(),
    budgetMs: 5_000,
    pollAllowanceMs: 0,
    basis: "bsc_websocket_ingest",
  };
  await monitor.observe(item);
  assert.equal(alerts.length, 1, JSON.stringify({ item, state: await monitor.getState() }));
  assert.equal(alerts[0].kind, "new_launchpad");
  assert.equal(alerts[0].attribution.status, "corroborated");
  assert.equal(alerts[0].platform.trust, "multi_source_corroborated");
  assert.equal(alerts[0].blockTimestamp, item.observedAt);
  assert.equal(alerts[0].deliverySla, undefined, "non-Flap/Four.Meme BSC events must stay on the existing best-effort path");
});

test("a Flap feature's first safe token passes focus3 and reaches the isolated Telegram outbox exactly once", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-feature-first-token-"));
  const payloads = [];
  const liveNow = Date.now();
  let clock = liveNow - 60 * 60_000;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    alertChineseTranslationEnabled: false,
    blockedContracts: new Set(),
    telegramToken: "isolated-test-token",
    telegramChatId: "isolated-test-chat",
    telegramStrongAlerts: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  }, {
    autoStart: false,
    provider: { destroy() {} },
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(() => monitor.stop());
  await monitor.getState();
  clock = liveNow;

  const platform = { id: "flap", name: "Flap", trust: "official_verified" };
  const baseline = observation({ platform });
  baseline.observedAt = new Date(liveNow).toISOString();
  assert.equal(await monitor.observe(baseline), null, "the established Flap mode is a silent baseline");
  const first = observation({
    platform,
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    fingerprint: "flap-v8-mode",
    selector: "0xfeedc0de",
    blockNumber: 101,
  });
  first.observedAt = new Date(liveNow).toISOString();
  first.deliverySla = {
    startedAt: new Date(liveNow).toISOString(),
    deadlineAt: new Date(liveNow + 5_000).toISOString(),
    budgetMs: 5_000,
    pollAllowanceMs: 0,
    basis: "bsc_websocket_ingest",
  };
  const event = await monitor.observe(first);
  assert.equal(event.kind, "new_mode");
  assert.equal(event.featureFirstToken, true);
  assert.deepEqual(event.deliverySla, first.deliverySla);
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /Flap 新功能首币/);

  const repeat = observation({
    platform,
    token: "0x5555555555555555555555555555555555555555",
    transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    fingerprint: "flap-v8-mode",
    selector: "0xfeedc0de",
    blockNumber: 102,
  });
  repeat.observedAt = new Date(liveNow).toISOString();
  assert.equal(await monitor.observe(repeat), null);
  assert.equal(payloads.length, 1, "ordinary follow-up tokens in the same mode must stay silent");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(Object.values(outbox.events).filter((entry) => entry.destinations.telegram.deliveredAt).length, 1);
});

test("a Board-confirmed Flap quote pool activates exactly one locally safe first token", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-board-feature-"));
  const alerts = [];
  const liveNow = Date.parse("2026-08-10T14:00:00.000Z");
  let clock = liveNow - 60 * 60_000;
  const quote = "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec";
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    blockedContracts: new Set(),
  }, {
    autoStart: false,
    provider: { destroy() {} },
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    },
  });
  await monitor.getState();
  clock = liveNow;
  const pool = {
    identity: `quote:${quote}`,
    category: "QUOTE",
    quoteAddress: quote,
    quoteSymbol: "BABAB",
    sourceUrl: "https://flap.sh/board",
  };
  assert.equal(await monitor.registerFlapFeatureActivations([{
    pool,
    confirmed: false,
    observations: 1,
    observedAt: new Date(liveNow).toISOString(),
  }]), 0, "one unconfirmed Board observation must fail closed");
  assert.equal(await monitor.registerFlapFeatureActivations([{
    pool,
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(liveNow - 30_000).toISOString(),
    confirmedAt: new Date(liveNow).toISOString(),
    observedAt: new Date(liveNow).toISOString(),
  }]), 1);
  const snapshot = await monitor.getState();
  const [activationKey, activation] = Object.entries(snapshot.officialSources.flap.featureActivations)[0];
  assert.equal(activation.quoteSymbol, "BABAB");
  assert.ok(activation.replayCompletedAt, "registration checks durable history before opening the live lane");

  const platform = { id: "flap", name: "Flap", trust: "official_verified", website: "https://flap.sh", twitter: "https://x.com/flapdotsh" };
  const first = observation({ platform, fingerprint: "flap-babab-feature" });
  first.observedAt = new Date(liveNow).toISOString();
  Object.assign(first.mode, {
    quoteAsset: quote,
    quoteSymbol: "BABAB",
    quoteFingerprint: activation.fingerprint,
    componentMode: "Flap BABAB 新底池",
    componentModeAlertEligible: true,
    featureActivationKey: activationKey,
    featureActivationEligible: true,
    featurePlatform: "flap",
    featureSourceUrl: "https://flap.sh/board",
  });
  const event = await monitor.observe(first);
  assert.equal(event.kind, "new_mode");
  assert.equal(event.featureFirstToken, true);
  assert.equal(event.featurePlatform, "flap");
  assert.match(event.eventKey, /^bsc-flap-feature-token:/);
  assert.equal(event.sourceUrl, "https://flap.sh/board");
  assert.equal(alerts.length, 1);

  const repeat = structuredClone(first);
  repeat.transactionHash = `0x${"c".repeat(64)}`;
  repeat.tokens[0].token = "0x5555555555555555555555555555555555555555";
  repeat.sampleToken = repeat.tokens[0].token;
  assert.equal(await monitor.observe(repeat), null);
  assert.equal(alerts.length, 1);
  const committed = await monitor.getState();
  assert.equal(committed.officialSources.flap.featureActivations[activationKey].firstTokenTransactionHash, first.transactionHash);
});

test("Flap Board replay keeps the earliest exact creation after more than 100 newer launcher tokens", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-hot-index-volume-"));
  const walFile = path.join(dataDir, "bsc-launchpad-state.json.wal");
  const clock = Date.parse("2026-08-10T14:00:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const vaultFactory = "0x6666666666666666666666666666666666666666";
  const vault = "0x7777777777777777777777777777777777777777";
  const creator = "0x8888888888888888888888888888888888888888";
  const candidates = Array.from({ length: 151 }, (_, index) => {
    const token = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    const transactionHash = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    const observedAt = new Date(clock - 10 * 60_000 + index * 1_000).toISOString();
    return {
      launcher,
      token,
      transactionHash,
      blockNumber: 1_000 + index,
      transactionIndex: index % 10,
      logIndex: 0,
      topic: FLAP_VAULT_TOKEN_CREATED_TOPIC,
      observedAt,
      indexedAt: observedAt,
      vaultFactory,
      quoteAssets: [],
    };
  });
  candidates[1] = {
    ...candidates[1],
    transactionHash: candidates[0].transactionHash,
    blockNumber: candidates[0].blockNumber,
    transactionIndex: candidates[0].transactionIndex,
    logIndex: 1,
    observedAt: candidates[0].observedAt,
    indexedAt: candidates[0].indexedAt,
  };
  const retainedLauncherTokens = Object.fromEntries(candidates.slice(-100).map((candidate) => [candidate.token, {
    token: candidate.token,
    transactionHash: candidate.transactionHash,
    firstSeenBlock: candidate.blockNumber,
    lastSeenBlock: candidate.blockNumber,
    observedAt: candidate.observedAt,
    pools: [],
  }]));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 1_200,
    realtimeTailNextBlock: 1_201,
    launchers: {
      [launcher]: {
        launcher,
        firstSeenBlock: 1_000,
        lastSeenBlock: 1_150,
        transactions: candidates.slice(-30).map((candidate) => candidate.transactionHash),
        tokens: retainedLauncherTokens,
        modes: {},
        baselineModeFingerprint: null,
        discoveryAlerted: false,
        alertedModes: [],
        structuralEligible: true,
        callers: [],
        platform: { id: "flap", name: "Flap", trust: "official_verified" },
      },
    },
    seenTransactions: Object.fromEntries(candidates.map((candidate) => [candidate.transactionHash, candidate.blockNumber])),
    officialSources: { flap: { creationEventHotIndex: [...candidates].reverse() } },
  }));
  const first = candidates[0];
  const firstBlockHash = `0x${"a9".repeat(32)}`;
  const vaultInterface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const encoded = vaultInterface.encodeEventLog(vaultInterface.getEvent("FlapTaxVaultTokenCreated"), [first.token, vault, vaultFactory]);
  const log = {
    address: launcher,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: first.transactionHash,
    blockHash: firstBlockHash,
    blockNumber: first.blockNumber,
    transactionIndex: first.transactionIndex,
    logIndex: 0,
    removed: false,
  };
  const controllerCode = `0x${"6000".repeat(400)}`;
  const tokenCode = `0x${"6000".repeat(300)}`;
  const alerts = [];
  const requestedTransactions = [];
  const provider = {
    async getTransaction(hash) {
      requestedTransactions.push(hash);
      if (hash !== first.transactionHash) throw new Error(`unexpected later Flap replay ${hash}`);
      return { hash, blockNumber: first.blockNumber, blockHash: firstBlockHash, index: first.transactionIndex, transactionIndex: first.transactionIndex, to: launcher, from: creator, data: `0x8cb5772c${"0".repeat(64)}` };
    },
    async getTransactionReceipt(hash) {
      if (hash !== first.transactionHash) throw new Error(`unexpected later Flap receipt ${hash}`);
      return { transactionHash: hash, blockHash: firstBlockHash, status: 1, blockNumber: first.blockNumber, index: first.transactionIndex, transactionIndex: first.transactionIndex, logs: [log] };
    },
    async getBlock(blockNumber) {
      return { number: Number(blockNumber), hash: firstBlockHash, timestamp: Math.floor(Date.parse(first.observedAt) / 1_000), transactions: [first.transactionHash] };
    },
    async getCode(address) {
      return String(address).toLowerCase() === first.token ? tokenCode : controllerCode;
    },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const before = await monitor.getState();
  assert.equal(before.officialSources.flap.creationEventHotIndex.length, 151);
  assert.equal(before.launchers[launcher].tokens[first.token], undefined, "the real first token is already outside launcher.tokens retention");
  assert.equal(await monitor.registerFlapFeatureActivations([{
    pool: {
      identity: `vault:STAKING:${vaultFactory}`,
      category: "STAKING",
      vaultFactory,
      sourceUrl: "https://flap.sh/board",
    },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(clock - 60_000).toISOString(),
    confirmedAt: new Date(clock).toISOString(),
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  let after = await monitor.getState();
  let activation = Object.values(after.officialSources.flap.featureActivations)[0];
  assert.deepEqual(requestedTransactions, [], "registration only durably admits the replay owner");
  assert.equal(after.seenTransactions[first.transactionHash], undefined);
  assert.ok(after.realtimePendingEntries[first.transactionHash]);
  assert.equal(after.realtimePendingEntries[first.transactionHash].featureActivationReplayKey, activation.key);
  assert.equal(alerts.length, 0);
  let frames = (await fs.readFile(walFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(frames.some((frame) => {
    const paths = frame.ops.map((operation) => operation.path.join("."));
    return frame.ops.some((operation) => operation.op === "delete"
      && operation.path.join(".") === `seenTransactions.${first.transactionHash}`)
      && paths.includes(`realtimePendingEntries.${first.transactionHash}`)
      && paths.some((value) => value.endsWith(`featureActivations.${activation.key}.replayLastAttemptAt`));
  }), "seen reopening and exact replay admission share one WAL revision");

  await monitor.processRealtimeQueue();
  after = await monitor.getState();
  activation = Object.values(after.officialSources.flap.featureActivations)[0];
  assert.deepEqual(requestedTransactions, [first.transactionHash]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].transactionHash, first.transactionHash);
  assert.equal(alerts[0].tokens[0].token.toLowerCase(), first.token);
  assert.equal(activation.firstTokenTransactionHash, first.transactionHash);
  assert.ok(activation.replayAttemptedTransactionHashes.includes(first.transactionHash));
  assert.equal(after.realtimePendingEntries[first.transactionHash], undefined);
  frames = (await fs.readFile(walFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(frames.some((frame) => {
    const paths = frame.ops.map((operation) => operation.path.join("."));
    return frame.ops.some((operation) => operation.op === "delete"
      && operation.path.join(".") === `realtimePendingEntries.${first.transactionHash}`)
      && paths.some((value) => value.endsWith(`featureActivations.${activation.key}.replayAttemptedTransactionHashes`));
  }), "deep success, replay attempted ownership, and pending cleanup share one WAL revision");
  assert.equal(after.officialSources.flap.creationEventHotIndex.length, 151);
});

test("a failed admitted Flap activation replay remains durable and retryable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-replay-checkpoint-"));
  let clock = Date.parse("2026-08-10T14:00:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const token = "0x1111111111111111111111111111111111111111";
  const vault = "0x2222222222222222222222222222222222222222";
  const vaultFactory = "0x3333333333333333333333333333333333333333";
  const creator = "0x4444444444444444444444444444444444444444";
  const transactionHash = `0x${"6".repeat(64)}`;
  const blockHash = `0x${"a6".repeat(32)}`;
  const observedAt = new Date(clock - 60_000).toISOString();
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    seenTransactions: { [transactionHash]: 99 },
    officialSources: { flap: { creationEventHotIndex: [{
      launcher,
      token,
      transactionHash,
      blockNumber: 99,
      transactionIndex: 0,
      logIndex: 0,
      topic: FLAP_VAULT_TOKEN_CREATED_TOPIC,
      observedAt,
      indexedAt: observedAt,
      vaultFactory,
      quoteAssets: [],
    }] } },
  }));
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, vaultFactory]);
  const log = { address: launcher, topics: encoded.topics, data: encoded.data, transactionHash, blockHash, blockNumber: 99, transactionIndex: 0, logIndex: 0, removed: false };
  let failReplay = true;
  const alerts = [];
  const provider = {
    async getTransaction(hash) {
      if (failReplay) throw new Error("Flap replay RPC unavailable");
      return { hash, blockNumber: 99, blockHash, index: 0, transactionIndex: 0, to: launcher, from: creator, data: `0x8cb5772c${"0".repeat(64)}` };
    },
    async getTransactionReceipt(hash) {
      if (failReplay) throw new Error("Flap replay RPC unavailable");
      return { transactionHash: hash, blockHash, status: 1, blockNumber: 99, index: 0, transactionIndex: 0, logs: [log] };
    },
    async getBlock() { return { number: 99, hash: blockHash, timestamp: Math.floor(Date.parse(observedAt) / 1_000), transactions: [transactionHash] }; },
    async getCode(address) { return String(address).toLowerCase() === token ? `0x${"6000".repeat(300)}` : `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const record = {
    pool: { identity: `vault:INDEX:${vaultFactory}`, category: "INDEX", vaultFactory, sourceUrl: "https://flap.sh/board" },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(clock - 30_000).toISOString(),
    confirmedAt: new Date(clock).toISOString(),
    observedAt: new Date(clock).toISOString(),
  };
  assert.equal(await monitor.registerFlapFeatureActivations([record]), 1);
  let activation = Object.values((await monitor.getState()).officialSources.flap.featureActivations)[0];
  let snapshot = await monitor.getState();
  assert.equal(activation.replayCompletedAt, null);
  assert.equal(activation.firstTokenTransactionHash, null);
  assert.ok(snapshot.realtimePendingEntries[transactionHash]);
  assert.equal(snapshot.seenTransactions[transactionHash], undefined);
  await monitor.processRealtimeQueue();
  snapshot = await monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[transactionHash]);
  assert.equal(snapshot.transactionFailures[transactionHash].attempts, 1);
  assert.equal(activation.replayAttemptedTransactionHashes.includes(transactionHash), false);
  failReplay = false;
  clock += 1_001;
  assert.equal(await monitor.registerFlapFeatureActivations([record]), 0, "the existing activation retries without being recreated");
  await monitor.processRealtimeQueue();
  activation = Object.values((await monitor.getState()).officialSources.flap.featureActivations)[0];
  assert.equal(alerts.length, 1);
  assert.equal(activation.firstTokenTransactionHash, transactionHash);
  assert.ok(activation.replayAttemptedTransactionHashes.includes(transactionHash));
});

test("Flap replay shares one persisted RPC backoff across features and resumes without losing candidates", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-shared-replay-backoff-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let current = Date.parse("2026-08-24T10:22:12.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const creator = "0x4444444444444444444444444444444444444444";
  const records = [
    {
      token: "0x1111111111111111111111111111111111111111",
      vault: "0x2111111111111111111111111111111111111111",
      vaultFactory: "0x3111111111111111111111111111111111111111",
      transactionHash: `0x${"6".repeat(64)}`,
      blockHash: `0x${"b6".repeat(32)}`,
      blockNumber: 99,
      category: "INDEX",
    },
    {
      token: "0x1222222222222222222222222222222222222222",
      vault: "0x2222222222222222222222222222222222222222",
      vaultFactory: "0x3222222222222222222222222222222222222222",
      transactionHash: `0x${"7".repeat(64)}`,
      blockHash: `0x${"b7".repeat(32)}`,
      blockNumber: 100,
      category: "STAKING",
    },
  ];
  const observedAt = new Date(current - 60_000).toISOString();
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(current - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    seenTransactions: Object.fromEntries(records.map((record) => [record.transactionHash, record.blockNumber])),
    officialSources: {
      flap: {
        creationEventHotIndex: records.map((record, index) => ({
          launcher,
          token: record.token,
          transactionHash: record.transactionHash,
          blockNumber: record.blockNumber,
          transactionIndex: index,
          logIndex: 0,
          topic: FLAP_VAULT_TOKEN_CREATED_TOPIC,
          observedAt,
          indexedAt: observedAt,
          vaultFactory: record.vaultFactory,
          quoteAssets: [],
        })),
      },
    },
  }));
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const logs = new Map(records.map((record, index) => {
    const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [record.token, record.vault, record.vaultFactory]);
    return [record.transactionHash, {
      address: launcher,
      topics: encoded.topics,
      data: encoded.data,
      transactionHash: record.transactionHash,
      blockHash: record.blockHash,
      blockNumber: record.blockNumber,
      transactionIndex: index,
      logIndex: 0,
      removed: false,
    }];
  }));
  let cooling = true;
  const transactionRequests = [];
  const errors = [];
  const alerts = [];
  let writes = 0;
  const provider = {
    async getTransaction(hash) {
      transactionRequests.push(hash);
      if (cooling) {
        const error = new Error("eth_getTransaction failed on every BSC RPC: providers cooling down; retry in 5000ms");
        error.code = "SERVER_ERROR";
        error.retryAfterMs = 5_000;
        error.rpcOperation = "getTransaction";
        error.rpcFailureScope = "host";
        throw error;
      }
      const record = records.find((item) => item.transactionHash === hash);
      return { hash, blockNumber: record.blockNumber, blockHash: record.blockHash, index: records.indexOf(record), transactionIndex: records.indexOf(record), to: launcher, from: creator, data: `0x8cb5772c${"0".repeat(64)}` };
    },
    async getTransactionReceipt(hash) {
      const log = logs.get(hash);
      return { transactionHash: hash, blockHash: log.blockHash, status: 1, blockNumber: log.blockNumber, index: log.transactionIndex, transactionIndex: log.transactionIndex, logs: [log] };
    },
    async getBlock(blockNumber) {
      const record = records.find((item) => item.blockNumber === Number(blockNumber));
      return {
        number: Number(blockNumber),
        hash: record.blockHash,
        timestamp: Math.floor(Date.parse(observedAt) / 1_000),
        transactions: Array.from({ length: records.indexOf(record) }, (_, index) => `0x${String(index + 3).repeat(64)}`).concat(record.transactionHash),
      };
    },
    async getCode(address) { return records.some((record) => record.token.toLowerCase() === String(address).toLowerCase()) ? `0x${"6000".repeat(300)}` : `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };
  const dependencies = {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => current,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error(message) { errors.push(String(message)); }, info() {} },
    atomicWriteImpl: async (file, snapshot) => {
      writes += 1;
      await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  };
  const activationRecords = records.map((record) => ({
    pool: {
      identity: `vault:${record.category}:${record.vaultFactory}`,
      category: record.category,
      vaultFactory: record.vaultFactory,
      sourceUrl: "https://flap.sh/board",
    },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(current - 30_000).toISOString(),
    confirmedAt: new Date(current).toISOString(),
    observedAt: new Date(current).toISOString(),
  }));

  const monitorConfig = {
    dataDir,
    bscEntryRpcConcurrency: 1,
    bscProcessBatchSize: 1,
    bscBacklogProcessBatchSize: 1,
  };
  let monitor = createBscLaunchpadMonitor(monitorConfig, dependencies);
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(await monitor.registerFlapFeatureActivations(activationRecords), 2);
  let snapshot = await monitor.getState();
  assert.equal(Object.keys(snapshot.realtimePendingEntries).length, 2);
  assert.equal(transactionRequests.length, 0, "registration performs no deep RPC");
  await monitor.processRealtimeQueue();
  snapshot = await monitor.getState();
  assert.equal(transactionRequests.length, 1, "the first shared outage stops the remaining feature probes");
  assert.equal(snapshot._health.backgroundDeepRpc.nextRetryAt, "2026-08-24T10:22:17.000Z");
  assert.equal(Object.keys(snapshot.realtimePendingEntries).length, 2);
  const writesAfterFailure = writes;
  await monitor.replayFlapFeatureActivations();
  await monitor.processRealtimeQueue();
  assert.equal(transactionRequests.length, 1);
  assert.equal(writes, writesAfterFailure, "cooling wakeups must not rewrite the multi-megabyte state");

  await monitor.stop();
  monitor = createBscLaunchpadMonitor(monitorConfig, dependencies);
  await monitor.getState();
  const writesAfterRestart = writes;
  await monitor.processRealtimeQueue();
  assert.equal(transactionRequests.length, 1, "a restart must restore the feature-lane deadline");
  assert.equal(writes, writesAfterRestart);

  current += 5_000;
  await monitor.processRealtimeQueue();
  assert.equal(transactionRequests.length, 2, "the due lane permits exactly the first feature probe");
  snapshot = await monitor.getState();
  assert.equal(snapshot._health.backgroundDeepRpc.nextRetryAt, "2026-08-24T10:22:22.000Z");
  assert.equal(Object.values(snapshot.officialSources.flap.featureActivations).every((activation) => !activation.replayCompletedAt), true);

  cooling = false;
  current += 5_000;
  await monitor.processRealtimeQueue();
  current += 1_001;
  await monitor.processRealtimeQueue();
  snapshot = await monitor.getState();
  assert.equal(alerts.length, 2);
  assert.equal(Object.values(snapshot.officialSources.flap.featureActivations).every((activation) => activation.firstTokenTransactionHash), true);
  assert.ok(Date.parse(snapshot._health.backgroundDeepRpc.nextRetryAt) <= current,
    "the persisted host deadline no longer blocks either admitted replay owner");
  assert.equal(snapshot.officialSources.flap.creationEventHotIndex.length, 2, "replay recovery must not delete retained candidates");
});

test("a background Flap activation replay preserves its durable admission and retries idempotently", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-background-replay-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let clock = Date.parse("2026-08-10T14:30:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const token = "0x1111111111111111111111111111111111111111";
  const vault = "0x2222222222222222222222222222222222222222";
  const vaultFactory = "0x3333333333333333333333333333333333333333";
  const creator = "0x4444444444444444444444444444444444444444";
  const transactionHash = `0x${"7".repeat(64)}`;
  const blockHash = `0x${"a7".repeat(32)}`;
  const observedAt = new Date(clock - 60_000).toISOString();
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    seenTransactions: { [transactionHash]: 99 },
    officialSources: { flap: { creationEventHotIndex: [{
      launcher,
      token,
      transactionHash,
      blockNumber: 99,
      transactionIndex: 0,
      logIndex: 0,
      topic: FLAP_VAULT_TOKEN_CREATED_TOPIC,
      observedAt,
      indexedAt: observedAt,
      vaultFactory,
      quoteAssets: [],
    }] } },
  }));
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, vaultFactory]);
  const log = { address: launcher, topics: encoded.topics, data: encoded.data, transactionHash, blockHash, blockNumber: 99, transactionIndex: 0, logIndex: 0, removed: false };
  let failReplay = true;
  let releaseFirstReplay;
  let signalFirstReplay;
  const firstReplayGate = new Promise((resolve) => { releaseFirstReplay = resolve; });
  const firstReplayStarted = new Promise((resolve) => { signalFirstReplay = resolve; });
  let signalReplayFailureLogged;
  const replayFailureLogged = new Promise((resolve) => { signalReplayFailureLogged = resolve; });
  let replayStarts = 0;
  const alerts = [];
  const provider = {
    async getTransaction(hash) {
      replayStarts += 1;
      signalFirstReplay();
      await firstReplayGate;
      if (failReplay) throw new Error("Flap background replay RPC unavailable");
      return { hash, blockNumber: 99, blockHash, index: 0, transactionIndex: 0, to: launcher, from: creator, data: `0x8cb5772c${"0".repeat(64)}` };
    },
    async getTransactionReceipt(hash) {
      signalFirstReplay();
      await firstReplayGate;
      if (failReplay) throw new Error("Flap background replay RPC unavailable");
      return { transactionHash: hash, blockHash, status: 1, blockNumber: 99, index: 0, transactionIndex: 0, logs: [log] };
    },
    async getBlock() { return { number: 99, hash: blockHash, timestamp: Math.floor(Date.parse(observedAt) / 1_000), transactions: [transactionHash] }; },
    async getCode(address) { return String(address).toLowerCase() === token ? `0x${"6000".repeat(300)}` : `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    logger: {
      error(message) {
        if (/\[bsc\]\[realtime\]/.test(String(message))) signalReplayFailureLogged();
      },
      info() {},
    },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  t.after(async () => {
    releaseFirstReplay();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const record = {
    pool: { identity: `vault:INDEX:${vaultFactory}`, category: "INDEX", vaultFactory, sourceUrl: "https://flap.sh/board" },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(clock - 30_000).toISOString(),
    confirmedAt: new Date(clock).toISOString(),
    observedAt: new Date(clock).toISOString(),
  };

  const registration = monitor.registerFlapFeatureActivations([record], { awaitReplay: false });
  let timeout;
  const outcome = await Promise.race([
    registration.then((value) => ({ status: "returned", value }), (error) => ({ status: "rejected", error })),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ status: "blocked" }), 1_000);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
  if (outcome.status !== "returned") {
    releaseFirstReplay();
    await registration.catch(() => {});
  }
  assert.equal(outcome.status, "returned", "durable registration must not wait for historical replay");
  assert.equal(outcome.value, 1);
  await firstReplayStarted;
  const durable = await readBscLaunchpadDurableState(stateFile);
  let activation = Object.values(durable.officialSources.flap.featureActivations)[0];
  assert.ok(activation, "the activation is durable while the background RPC is still blocked");
  assert.equal(activation.replayCompletedAt, null);
  assert.equal(activation.firstTokenTransactionHash, null);
  assert.ok(durable.realtimePendingEntries[transactionHash]);
  assert.equal(alerts.length, 0);

  releaseFirstReplay();
  await waitUntil(async () => {
    const snapshot = await monitor.getState();
    return /Flap background replay RPC unavailable/.test(snapshot?._health?.realtimeQueue?.lastError || "");
  });
  let failed = await monitor.getState();
  activation = Object.values(failed.officialSources.flap.featureActivations)[0];
  assert.match(failed._health.realtimeQueue.lastError, /Flap background replay RPC unavailable/);
  assert.equal(activation.replayCompletedAt, null);
  assert.ok(failed.realtimePendingEntries[transactionHash]);
  await replayFailureLogged;

  failReplay = false;
  clock += 1_001;
  assert.equal(await monitor.registerFlapFeatureActivations([record], { awaitReplay: false }), 0,
    "retrying a persisted activation must not recreate it");
  await monitor.processRealtimeQueue();
  await waitUntil(async () => {
    activation = Object.values((await monitor.getState()).officialSources.flap.featureActivations)[0];
    return activation?.firstTokenTransactionHash === transactionHash;
  });
  assert.equal(activation.firstTokenTransactionHash, transactionHash);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].transactionHash, transactionHash);
  assert.ok(replayStarts >= 2);

  assert.equal(await monitor.registerFlapFeatureActivations([record], { awaitReplay: false }), 0);
  assert.equal(alerts.length, 1, "a repeated durable handoff must not alert the first token twice");
});

test("focus3 Flap activation replay performs zero deep RPC until two healthy tail batches", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-replay-tail-priority-"));
  let clock = Date.parse("2026-09-04T13:30:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const token = "0x1811111111111111111111111111111111111111";
  const vault = "0x2822222222222222222222222222222222222222";
  const vaultFactory = "0x3833333333333333333333333333333333333333";
  const creator = "0x4844444444444444444444444444444444444444";
  const transactionHash = `0x${"58".repeat(32)}`;
  const blockHash = `0x${"68".repeat(32)}`;
  const observedAt = new Date(clock - 60_000).toISOString();
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 77,
    realtimeTailNextBlock: 78,
    realtimeTailInitializedAt: new Date(clock - 60_000).toISOString(),
    launchers: {},
    seenTransactions: { [transactionHash]: 98 },
    officialSources: { flap: { creationEventHotIndex: [{
      launcher,
      token,
      transactionHash,
      blockHash,
      blockNumber: 98,
      transactionIndex: 0,
      logIndex: 0,
      topic: FLAP_VAULT_TOKEN_CREATED_TOPIC,
      observedAt,
      indexedAt: observedAt,
      vaultFactory,
      quoteAssets: [],
    }] } },
    _health: { realtimeTail: {
      status: "healthy",
      consecutiveFailures: 0,
      nextBlock: 78,
      lastSuccessAt: new Date(clock - 1_000).toISOString(),
    } },
  }));
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, vaultFactory]);
  const log = {
    address: launcher,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockHash,
    blockNumber: 98,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
  const deepTransactions = [];
  let eligibilityScans = 0;
  const alerts = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 100; },
    async getTransaction(hash) {
      deepTransactions.push(hash);
      return { hash, blockNumber: 98, blockHash, index: 0, transactionIndex: 0, to: launcher, from: creator, data: `0x8cb5772c${"0".repeat(64)}` };
    },
    async getTransactionReceipt(hash) {
      return { transactionHash: hash, blockHash, status: 1, blockNumber: 98, index: 0, transactionIndex: 0, logs: [log] };
    },
    async getBlock(number) {
      return { number: Number(number), hash: blockHash, timestamp: Math.floor(Date.parse(observedAt) / 1_000), transactions: [transactionHash] };
    },
    async getCode(address) { return String(address).toLowerCase() === token ? `0x${"6000".repeat(300)}` : `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    async send() { return []; },
    destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
  }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    onBackgroundDeepEligibilityScanImpl: () => { eligibilityScans += 1; },
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
    ...disabledJournalTimerDependencies(),
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(await monitor.registerFlapFeatureActivations([{
    pool: { identity: `vault:INDEX:${vaultFactory}`, category: "INDEX", vaultFactory, sourceUrl: "https://flap.sh/board" },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(clock - 30_000).toISOString(),
    confirmedAt: new Date(clock).toISOString(),
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  // Register before start so the initial assertion observes the configured
  // lag-21 cursor before activation work can run. The production 25ms tail
  // timer may own any of the rebuilding batches, so the remainder of this
  // fixture follows durable tail state rather than assuming that four direct
  // calls correspond to four completed scans.
  await monitor.start();
  let snapshot = await monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[transactionHash]);
  await monitor.processRealtimeQueue();
  assert.deepEqual(deepTransactions, [], "a nominally healthy tail at lag 21 blocks admitted replay deep reads");
  assert.equal(eligibilityScans, 0, "a blocked deep lane must not scan its durable backlog");

  let firstHealthyObserved = false;
  for (let attempt = 0; attempt < 40 && !firstHealthyObserved; attempt += 1) {
    snapshot = await monitor.getState();
    if (snapshot._health.realtimeTail.status === "healthy"
      && Number(snapshot.realtimeTailNextBlock) > 98) {
      firstHealthyObserved = true;
      break;
    }
    clock += 5_000;
    const result = await monitor.scanRealtimeTail();
    if (result?.skipped !== false) {
      await monitor.awaitIdle();
      continue;
    }
    snapshot = await monitor.getState();
    await monitor.processRealtimeQueue();
    assert.deepEqual(deepTransactions, [], snapshot._health.realtimeTail.status === "healthy"
      ? "the first actually healthy tail batch is not sufficient"
      : "a rebuilding batch cannot open the deep lane");
    firstHealthyObserved = snapshot._health.realtimeTail.status === "healthy"
      && Number(snapshot.realtimeTailNextBlock) > 98;
  }
  assert.equal(firstHealthyObserved, true, "the tail must durably reach its first healthy caught-up batch");
  await monitor.processRealtimeQueue();
  assert.deepEqual(deepTransactions, [], "one healthy caught-up batch cannot release replay deep work");
  assert.equal(eligibilityScans, 0, "one healthy batch still must not scan the durable backlog");

  let secondHealthyCompleted = false;
  for (let attempt = 0; attempt < 20 && !secondHealthyCompleted; attempt += 1) {
    clock += 5_000;
    const result = await monitor.scanRealtimeTail();
    if (result?.skipped !== false) {
      await monitor.awaitIdle();
      continue;
    }
    snapshot = await monitor.getState();
    assert.equal(snapshot._health.realtimeTail.status, "healthy");
    assert.ok(Number(snapshot.realtimeTailNextBlock) > 98);
    secondHealthyCompleted = true;
  }
  assert.equal(secondHealthyCompleted, true, "a second real healthy tail scan must own the lane");
  await monitor.processRealtimeQueue();
  assert.deepEqual(deepTransactions, [transactionHash], "the second healthy tail batch releases exactly one replay");
  assert.ok(eligibilityScans > 0, "an eligible deep lane must scan and select its durable head");
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimePendingEntries[transactionHash], undefined);
  assert.ok(snapshot.officialSources.flap.featureActivations[
    Object.keys(snapshot.officialSources.flap.featureActivations)[0]
  ].replayAttemptedTransactionHashes.includes(transactionHash));
  assert.equal(alerts.length, 1);
});

test("stop before unified deep work preserves an admitted Flap replay for restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-replay-stop-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const clock = Date.parse("2026-08-29T01:30:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const token = "0x1111111111111111111111111111111111111111";
  const vault = "0x2222222222222222222222222222222222222222";
  const vaultFactory = "0x3333333333333333333333333333333333333333";
  const creator = "0x4444444444444444444444444444444444444444";
  const transactionHash = `0x${"8".repeat(64)}`;
  const blockHash = `0x${"a8".repeat(32)}`;
  const observedAt = new Date(clock - 60_000).toISOString();
  const candidate = {
    launcher,
    token,
    transactionHash,
    blockNumber: 99,
    transactionIndex: 0,
    logIndex: 0,
    topic: FLAP_VAULT_TOKEN_CREATED_TOPIC,
    observedAt,
    indexedAt: observedAt,
    vaultFactory,
    quoteAssets: [],
  };
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    seenTransactions: { [transactionHash]: 99 },
    officialSources: { flap: { creationEventHotIndex: [candidate] } },
  }));
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, vaultFactory]);
  const log = { address: launcher, topics: encoded.topics, data: encoded.data, transactionHash, blockHash, blockNumber: 99, transactionIndex: 0, logIndex: 0, removed: false };
  let releaseBlockedReads;
  let signalBlockedRead;
  const blockedReads = new Promise((resolve) => { releaseBlockedReads = resolve; });
  const blockedReadStarted = new Promise((resolve) => { signalBlockedRead = resolve; });
  let destroyCalls = 0;
  const lateUnhandled = [];
  const onUnhandled = (error) => lateUnhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const blockedProvider = {
    async getTransaction() {
      signalBlockedRead();
      await blockedReads;
      throw new Error("late blocked replay transaction failure");
    },
    async getTransactionReceipt() {
      signalBlockedRead();
      await blockedReads;
      throw new Error("late blocked replay receipt failure");
    },
    destroy() { destroyCalls += 1; },
  };
  let monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    externalAttribution: false,
    provider: blockedProvider,
    now: () => clock,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
  });
  let restarted;
  t.after(async () => {
    process.removeListener("unhandledRejection", onUnhandled);
    releaseBlockedReads();
    await monitor?.stop();
    await restarted?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const record = {
    pool: { identity: `vault:INDEX:${vaultFactory}`, category: "INDEX", vaultFactory, sourceUrl: "https://flap.sh/board" },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(clock - 30_000).toISOString(),
    confirmedAt: new Date(clock).toISOString(),
    observedAt: new Date(clock).toISOString(),
  };
  assert.equal(await monitor.registerFlapFeatureActivations([record]), 1);
  assert.equal((await monitor.getState()).realtimePendingEntries[transactionHash].featureActivationReplayKey != null, true);

  let timeout;
  const stopStartedAt = Date.now();
  const stopOutcome = await Promise.race([
    monitor.stop().then(() => "stopped"),
    new Promise((resolve) => { timeout = setTimeout(() => resolve("timed_out"), 750); }),
  ]);
  clearTimeout(timeout);
  assert.equal(stopOutcome, "stopped", "an admitted replay with no active deep RPC stops promptly");
  assert.ok(Date.now() - stopStartedAt < 750);
  assert.equal(destroyCalls, 1);

  let durable = await readBscLaunchpadDurableState(stateFile);
  let activation = Object.values(durable.officialSources.flap.featureActivations)[0];
  assert.equal(activation.replayCompletedAt, null);
  assert.equal(activation.firstTokenTransactionHash, null);
  assert.equal(activation.replayAttemptedTransactionHashes.includes(transactionHash), false);
  assert.ok(durable.realtimePendingEntries[transactionHash]);
  assert.equal(durable.officialSources.flap.creationEventHotIndex.some((item) => item.transactionHash === transactionHash), true,
    "shutdown must retain the replay cursor for restart");

  releaseBlockedReads();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateUnhandled, [], "late provider failures must remain observed after replay cancellation");
  durable = await readBscLaunchpadDurableState(stateFile);
  activation = Object.values(durable.officialSources.flap.featureActivations)[0];
  assert.equal(activation.replayLastError, null, "shutdown cancellation is not a replay failure/backoff");

  const alerts = [];
  const replayProvider = {
    async getTransaction(hash) { return { hash, blockNumber: 99, blockHash, index: 0, transactionIndex: 0, to: launcher, from: creator, data: `0x8cb5772c${"0".repeat(64)}` }; },
    async getTransactionReceipt(hash) { return { transactionHash: hash, blockHash, status: 1, blockNumber: 99, index: 0, transactionIndex: 0, logs: [log] }; },
    async getBlock() { return { number: 99, hash: blockHash, timestamp: Math.floor(Date.parse(observedAt) / 1_000), transactions: [transactionHash] }; },
    async getCode(address) { return String(address).toLowerCase() === token ? `0x${"6000".repeat(300)}` : `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };
  restarted = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    externalAttribution: false,
    provider: replayProvider,
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  await restarted.getState();
  await restarted.processRealtimeQueue();
  const resumed = await restarted.getState();
  activation = Object.values(resumed.officialSources.flap.featureActivations)[0];
  assert.equal(activation.firstTokenTransactionHash, transactionHash);
  assert.equal(alerts.length, 1);
});

test("a background Four.Meme activation replay returns after the durable handoff and remains single-flight", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-background-replay-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const clock = Date.parse("2026-08-10T14:30:00.000Z");
  const quote = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
  let releaseReplay;
  let signalReplayStarted;
  const replayGate = new Promise((resolve) => { releaseReplay = resolve; });
  const replayStarted = new Promise((resolve) => { signalReplayStarted = resolve; });
  let replayStarts = 0;
  const monitor = createBscLaunchpadMonitor({ dataDir, bscConfirmations: 2 }, {
    autoStart: false,
    externalAttribution: false,
    provider: {
      async getBlockNumber() {
        replayStarts += 1;
        signalReplayStarted();
        await replayGate;
        throw new Error("Four.Meme background replay RPC unavailable");
      },
      async getBlock() { throw new Error("the gated replay must fail before reading a block"); },
      async send() { throw new Error("the gated replay must fail before reading logs"); },
      destroy() {},
    },
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    releaseReplay();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const record = {
    quoteConfig: { symbol: "SPCXB", address: quote, status: "PUBLISH" },
    observedAt: new Date(clock).toISOString(),
  };

  const registration = monitor.registerFourMemeFeatureActivations([record], { awaitReplay: false });
  let timeout;
  const outcome = await Promise.race([
    registration.then((value) => ({ status: "returned", value }), (error) => ({ status: "rejected", error })),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ status: "blocked" }), 1_000);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
  if (outcome.status !== "returned") {
    releaseReplay();
    await registration.catch(() => {});
  }
  assert.equal(outcome.status, "returned", "durable registration must not wait for historical replay");
  assert.equal(outcome.value, 1);
  await replayStarted;
  const durable = await readBscLaunchpadDurableState(stateFile);
  let activation = Object.values(durable.officialSources.fourMeme.featureActivations)[0];
  assert.ok(activation, "the activation is durable while the background RPC is still blocked");
  assert.equal(activation.replayCompletedAt, null);
  assert.equal(activation.replayLastError, null);

  assert.equal(await monitor.registerFourMemeFeatureActivations([record], { awaitReplay: false }), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replayStarts, 1, "an empty replay-key handoff must not start a full pending replay");

  releaseReplay();
  await waitUntil(async () => {
    activation = Object.values((await monitor.getState()).officialSources.fourMeme.featureActivations)[0];
    return /Four\.Meme background replay RPC unavailable/.test(activation?.replayLastError || "");
  });
  assert.match(activation.replayLastError, /Four\.Meme background replay RPC unavailable/);
  assert.equal(activation.replayCompletedAt, null);
  assert.equal(replayStarts, 1, "the failed background replay must remain single-flight");
  await monitor.awaitIdle();
});

test("a Four.Meme quote-pool first safe token reaches focus3 Telegram once with the exact feature label", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-feature-first-token-"));
  const payloads = [];
  const liveNow = Date.now();
  let clock = liveNow - 60 * 60_000;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = {
    dataDir,
    monitorScope: "focus3",
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    blockedContracts: new Set(),
    telegramToken: "isolated-test-token",
    telegramChatId: "isolated-test-chat",
    telegramStrongAlerts: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  };
  const monitor = createBscLaunchpadMonitor(config, {
    autoStart: false,
    provider: {
      destroy() {},
      async getBlockNumber() { return 100; },
      async getBlock() { return { timestamp: Math.floor(liveNow / 1_000) }; },
      async send() { return []; },
    },
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(() => monitor.stop());
  await monitor.getState();
  clock = liveNow;
  const quoteConfig = {
    symbol: "SPCXB",
    address: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1",
    status: "PUBLISH",
    fees: { buyFee: "0.01" },
    thresholds: { totalBAmount: "90" },
  };
  assert.equal(await monitor.registerFourMemeFeatureActivations([{ quoteConfig, observedAt: new Date(liveNow).toISOString() }]), 1);
  const snapshot = await monitor.getState();
  const [activationKey, activation] = Object.entries(snapshot.officialSources.fourMeme.featureActivations)[0];
  const platform = {
    id: "fourmeme",
    name: "Four.Meme / OpenFour",
    trust: "official_verified",
    website: "https://four.meme",
    twitter: "https://x.com/fourdotmemezh",
    github: null,
    notifyFirstToken: false,
    notifyFirstInfrastructureActivation: false,
    evidenceUrl: "https://four.meme/meme-api/v1/public/address",
  };
  const first = observation({
    launcher: "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3",
    platform,
    fingerprint: "spcxb-first-mode",
  });
  first.observedAt = new Date(liveNow).toISOString();
  first.blockHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  first.transactionIndex = 2;
  first.canonical = true;
  first.confirmations = 3;
  first.requiredConfirmations = 2;
  first.launchEvidence = openFourTokenCreatedEvidence({
    token: first.tokens[0].token,
    transactionHash: first.transactionHash,
    blockHash: first.blockHash,
    blockNumber: first.blockNumber,
    transactionIndex: first.transactionIndex,
    logIndex: 7,
    quoteAsset: quoteConfig.address,
  });
  first.tokens[0].launchEvidence = first.launchEvidence[0];
  first.deliverySla = {
    startedAt: new Date(liveNow).toISOString(),
    deadlineAt: new Date(liveNow + 5_000).toISOString(),
    budgetMs: 5_000,
    pollAllowanceMs: 0,
    basis: "bsc_websocket_ingest",
  };
  Object.assign(first.mode, {
    quoteAsset: quoteConfig.address,
    quoteSymbol: quoteConfig.symbol,
    quoteFingerprint: activation.quoteFingerprint,
    componentMode: "Four.Meme SPCXB 新底池",
    componentModeAlertEligible: true,
    featureActivationKey: activationKey,
    featureActivationEligible: true,
  });
  const event = await monitor.observe(first);
  assert.equal(event.kind, "new_mode");
  assert.equal(event.featureFirstToken, true);
  assert.equal(event.officialFirstToken, true);
  assert.equal(event.logIndex, 7);
  assert.equal(event.informationalOnly, true);
  assert.equal(event.autoTradeEligible, false);
  assert.equal(event.automaticExecution, false);
  assert.equal(isStrictBscOpenFourFirstTokenUpdate(event), true, JSON.stringify(event, null, 2));
  assert.deepEqual(event.deliverySla, first.deliverySla);
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /(?:OpenFour 首币｜安全检查通过|Four\.Meme \/ OpenFour 新功能首币)/);
  assert.match(payloads[0].text, /SPCXB 新底池/);
  assert.match(payloads[0].text, new RegExp(first.tokens[0].token, "i"));
  assert.doesNotMatch(JSON.stringify(payloads[0].reply_markup), /gmgn|买入|swap/i);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const [entry] = Object.values(outbox.events);
  assert.equal(isStrictBscOpenFourFirstTokenUpdate(entry.event), true, JSON.stringify(entry.event, null, 2));
  assert.equal(entry.renderBundle.focusModel.fourMeme?.kind, "core_first_token_safety", JSON.stringify(entry.renderBundle.focusModel, null, 2));
  const canonicalCoreSignal = `fourmeme:openfour-core-token-created:56:${first.transactionHash}:7:${first.tokens[0].token}`;
  assert.deepEqual(entry.event.canonicalSignalIds, [canonicalCoreSignal, `${canonicalCoreSignal}:safety-pass-v1`]);
  assert.equal(outbox.immutableOpenFourSignalOwners[canonicalCoreSignal].eventId, entry.id);
  assert.equal(outbox.immutableOpenFourSignalOwners[`${canonicalCoreSignal}:safety-pass-v1`].eventId, entry.id);
  assert.equal(entry.event.tradingPriority.tier, "T2");
  assert.equal(entry.event.tradingPriority.category, "focus_registry_first_token");
  assert.equal(entry.event.tradingPriority.hardGates.t1Eligible, false);
  assert.equal(entry.event.tradingPriority.plan.automaticExecution, false);
  assert.deepEqual(entry.deliveryDisposition, {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "four_registry_first_token_monitor_only",
  });
  const malformed = await sendAlerts(config, {
    ...structuredClone(event),
    eventKey: `${event.eventKey}:forged`,
    attackerUrl: "https://attacker.example/buy",
  });
  assert.equal(malformed.status, "suppressed");
  assert.equal(malformed.reason, "monitoring_source_disabled");
  assert.equal(payloads.length, 1);
  assert.equal(await monitor.observe({
    ...structuredClone(first),
    transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    tokens: [{ ...first.tokens[0], token: "0x5555555555555555555555555555555555555555" }],
    sampleToken: "0x5555555555555555555555555555555555555555",
  }), null);
  assert.equal(payloads.length, 1);
});

test("Four.Meme activation replay keeps its cursor open when eth_getLogs fails", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-replay-failure-"));
  const clock = Date.parse("2026-08-10T09:30:00.000Z");
  let fastLogCalls = 0;
  let completeLogCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    fourMemeFastReplayFetchImpl: async (url, options) => {
      fastLogCalls += 1;
      assert.equal(url, "https://bsc-rpc.publicnode.com");
      const payload = JSON.parse(options.body);
      assert.equal(payload.method, "eth_getLogs");
      assert.ok(payload.params[0].address, "the fast query must always be address constrained");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "fast range unavailable" } }),
      };
    },
    provider: {
      destroy() {},
      async getBlockNumber() { return 100; },
      async getBlock() { return { timestamp: Math.floor(clock / 1_000) }; },
      async send(_method, [filter]) {
        completeLogCalls += 1;
        assert.ok(Number.parseInt(filter.toBlock, 16) - Number.parseInt(filter.fromBlock, 16) + 1 <= 10);
        throw new Error("rpc log failure");
      },
    },
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(() => monitor.stop());
  const quoteConfig = {
    symbol: "SPCXB",
    address: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1",
    status: "PUBLISH",
  };
  assert.equal(await monitor.registerFourMemeFeatureActivations([{
    quoteConfig,
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  const snapshot = await monitor.getState();
  const activation = Object.values(snapshot.officialSources.fourMeme.featureActivations)[0];
  assert.equal(fastLogCalls, 1);
  assert.ok(completeLogCalls > 0, "a failed PublicNode shortcut must fall back to complete small-window replay");
  assert.equal(activation.replayCompletedAt, null);
  assert.equal(activation.firstTokenAlertedAt, null);
  assert.equal(activation.firstTokenTransactionHash, null);
  assert.match(activation.replayLastError, /rpc log failure/);
  assert.equal(activation.replayScannedThroughBlock, null);
});

test("Four.Meme PublicNode fast replay is address scoped, ordered, and bypasses small windows after an exact safe hit", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-fast-replay-hit-"));
  const clock = Date.parse("2026-08-10T09:30:00.000Z");
  const core = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
  const quote = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
  const earlierToken = "0x1111111111111111111111111111111111111111";
  const laterToken = "0x2222222222222222222222222222222222222222";
  const creator = "0x4444444444444444444444444444444444444444";
  const earlierTransactionHash = `0x${"a".repeat(64)}`;
  const laterTransactionHash = `0x${"b".repeat(64)}`;
  const earlierBlockHash = `0x${"c1".repeat(32)}`;
  const laterBlockHash = `0x${"c2".repeat(32)}`;
  const modules = ["5", "6", "7", "8", "9", "a"].map((digit) => `0x${digit.repeat(40)}`);
  const iface = new Interface(["event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)"]);
  const makeLog = (token, transactionHash, blockHash, blockNumber, transactionIndex) => {
    const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [
      BigInt(blockNumber), 1778027615723n, creator, token, `Fast Token ${blockNumber}`, `F${blockNumber}`,
      1_000n, 800n, 20n, 1n, quote, ...modules, "ipfs://meta", 0n, "0x",
    ]);
    return {
      address: core,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: `0x${blockNumber.toString(16)}`,
      transactionIndex: `0x${transactionIndex.toString(16)}`,
      logIndex: "0x1",
      transactionHash,
      blockHash,
      removed: false,
    };
  };
  const earlierLog = makeLog(earlierToken, earlierTransactionHash, earlierBlockHash, 96, 3);
  const laterLog = makeLog(laterToken, laterTransactionHash, laterBlockHash, 97, 2);
  const owner = new Interface(["function owner() view returns(address)"]);
  const controllerCode = `0x${"6000".repeat(400)}`;
  const safeCode = `0x${"6000".repeat(300)}`;
  let fastLogCalls = 0;
  let completeLogCalls = 0;
  const alerts = [];
  const provider = {
    async getBlockNumber() { return 100; },
    async getBlock(blockNumber) {
      const isEarlier = Number(blockNumber) === 96;
      const transactionIndex = isEarlier ? 3 : 2;
      const transactionHash = isEarlier ? earlierTransactionHash : laterTransactionHash;
      return {
        number: Number(blockNumber),
        hash: isEarlier ? earlierBlockHash : laterBlockHash,
        timestamp: Math.floor((clock - (100 - Number(blockNumber)) * 750) / 1_000),
        transactions: Array.from({ length: transactionIndex }, (_, index) => `0x${String(index + 3).repeat(64)}`).concat(transactionHash),
      };
    },
    async send() {
      completeLogCalls += 1;
      throw new Error("the complete replay must not run after the fast candidate is claimed");
    },
    async getTransaction(hash) {
      if (hash === earlierTransactionHash) return { hash, blockNumber: 96, blockHash: earlierBlockHash, index: 3, transactionIndex: 3, to: core, from: creator, data: `0x12345678${"0".repeat(64)}` };
      if (hash === laterTransactionHash) return { hash, blockNumber: 97, blockHash: laterBlockHash, index: 2, transactionIndex: 2, to: core, from: creator, data: `0x12345678${"0".repeat(64)}` };
      return null;
    },
    async getTransactionReceipt(hash) {
      if (hash === earlierTransactionHash) return { transactionHash: hash, blockHash: earlierBlockHash, status: 1, blockNumber: 96, index: 3, transactionIndex: 3, logs: [earlierLog] };
      if (hash === laterTransactionHash) return { transactionHash: hash, blockHash: laterBlockHash, status: 1, blockNumber: 97, index: 2, transactionIndex: 2, logs: [laterLog] };
      return null;
    },
    async getCode(address) {
      return [earlierToken, laterToken].includes(String(address).toLowerCase()) ? safeCode : controllerCode;
    },
    async getStorage() { return "0x"; },
    async call(request) {
      if (request.data === owner.encodeFunctionData("owner")) {
        return owner.encodeFunctionResult("owner", ["0x0000000000000000000000000000000000000000"]);
      }
      return "0x";
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, bscConfirmations: 2 }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    fourMemeFastReplayFetchImpl: async (url, options) => {
      fastLogCalls += 1;
      assert.equal(url, "https://bsc-rpc.publicnode.com");
      const payload = JSON.parse(options.body);
      const filter = payload.params[0];
      assert.equal(payload.method, "eth_getLogs");
      assert.ok(Array.isArray(filter.address));
      assert.ok(filter.address.includes(core));
      assert.ok(filter.address.every((address) => /^0x[0-9a-f]{40}$/.test(address)));
      assert.ok(filter.topics[0].includes(OPENFOUR_TOKEN_CREATED_TOPIC));
      assert.ok(filter.topics[0].includes(FOUR_MEME_TOKEN_CREATE_TOPIC));
      assert.ok(Number.parseInt(filter.toBlock, 16) - Number.parseInt(filter.fromBlock, 16) + 1 <= 2_400);
      return {
        ok: true,
        status: 200,
        // PublicNode ordering is not trusted; the monitor must restore chain
        // order before either transaction can claim the one-shot activation.
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: [laterLog, earlierLog] }),
      };
    },
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(await monitor.registerFourMemeFeatureActivations([{
    quoteConfig: { symbol: "SPCXB", address: quote, status: "PUBLISH" },
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  const activation = Object.values((await monitor.getState()).officialSources.fourMeme.featureActivations)[0];
  assert.equal(fastLogCalls, 1);
  assert.equal(completeLogCalls, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].transactionHash, earlierTransactionHash);
  assert.equal(alerts[0].tokens[0].token.toLowerCase(), earlierToken);
  assert.equal(activation.firstTokenTransactionHash, earlierTransactionHash);
  assert.equal(activation.firstToken.toLowerCase(), earlierToken);
});

test("Four.Meme activation replays the persisted realtime creation hot index before archive logs", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-hot-index-"));
  const clock = Date.parse("2026-08-10T09:30:00.000Z");
  const core = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
  const quote = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
  const token1 = "0x1111111111111111111111111111111111111111";
  const token2 = "0x2222222222222222222222222222222222222222";
  const tx1 = `0x${"1".repeat(64)}`;
  const tx2 = `0x${"2".repeat(64)}`;
  const blockHash1 = `0x${"d1".repeat(32)}`;
  const blockHash2 = `0x${"d2".repeat(32)}`;
  const creator1 = "0x3333333333333333333333333333333333333333";
  const creator2 = "0x4444444444444444444444444444444444444444";
  const modules = ["5", "6", "7", "8", "9", "a"].map((digit) => `0x${digit.repeat(40)}`);
  const iface = new Interface(["event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)"]);
  const makeLog = (token, creator, transactionHash, blockHash, blockNumber, transactionIndex) => {
    const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [
      BigInt(blockNumber), 1778027615723n, creator, token, `Token ${blockNumber}`, `T${blockNumber}`,
      1_000n, 800n, 20n, 1n, quote, ...modules, "ipfs://meta", 0n, "0x",
    ]);
    return {
      address: core,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber,
      transactionIndex,
      logIndex: 0,
      transactionHash,
      blockHash,
      removed: false,
    };
  };
  const log1 = makeLog(token1, creator1, tx1, blockHash1, 91, 0);
  const log2 = makeLog(token2, creator2, tx2, blockHash2, 92, 0);
  const observed1 = new Date(clock - 5 * 60_000).toISOString();
  const observed2 = new Date(clock - 4 * 60_000).toISOString();
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 98,
    launchers: {},
    seenTransactions: { [tx1]: 91, [tx2]: 92 },
    officialSources: { fourMeme: { creationEventHotIndex: [
      { launcher: core, token: token2, transactionHash: tx2, blockNumber: 92, transactionIndex: 0, logIndex: 0, topic: OPENFOUR_TOKEN_CREATED_TOPIC, observedAt: observed2, indexedAt: observed2, presetId: "1778027615723", quoteAsset: quote },
      { launcher: core, token: token1, transactionHash: tx1, blockNumber: 91, transactionIndex: 0, logIndex: 0, topic: OPENFOUR_TOKEN_CREATED_TOPIC, observedAt: observed1, indexedAt: observed1, presetId: "1778027615723", quoteAsset: quote },
    ] } },
  }));
  const transactions = new Map([
    [tx1, { hash: tx1, blockNumber: 91, blockHash: blockHash1, index: 0, transactionIndex: 0, to: core, from: creator1, data: `0x12345678${"0".repeat(64)}` }],
    [tx2, { hash: tx2, blockNumber: 92, blockHash: blockHash2, index: 0, transactionIndex: 0, to: core, from: creator2, data: `0x12345678${"0".repeat(64)}` }],
  ]);
  const receipts = new Map([
    [tx1, { transactionHash: tx1, blockHash: blockHash1, status: 1, blockNumber: 91, index: 0, transactionIndex: 0, logs: [log1] }],
    [tx2, { transactionHash: tx2, blockHash: blockHash2, status: 1, blockNumber: 92, index: 0, transactionIndex: 0, logs: [log2] }],
  ]);
  const owner = new Interface(["function owner() view returns(address)"]);
  const controllerCode = `0x${"6000".repeat(400)}`;
  const unsafeCode = `0x6340c10f19${"6000".repeat(300)}`;
  const safeCode = `0x${"6000".repeat(300)}`;
  let archiveLogCalls = 0;
  const alerts = [];
  const provider = {
    async getBlockNumber() { throw new Error("archive head must not be read after a hot-index hit"); },
    async getBlock(blockNumber) {
      const isFirst = Number(blockNumber) === 91;
      return { number: Number(blockNumber), hash: isFirst ? blockHash1 : blockHash2, timestamp: Math.floor((clock - (100 - Number(blockNumber)) * 750) / 1_000), transactions: [isFirst ? tx1 : tx2] };
    },
    async send() { archiveLogCalls += 1; throw new Error("archive logs must not run before a hot-index hit"); },
    async getTransaction(hash) { return transactions.get(hash) || null; },
    async getTransactionReceipt(hash) { return receipts.get(hash) || null; },
    async getCode(address) {
      const normalized = String(address).toLowerCase();
      if (normalized === token1) return unsafeCode;
      if (normalized === token2) return safeCode;
      return controllerCode;
    },
    async getStorage() { return "0x"; },
    async call(request) {
      if (request.data === owner.encodeFunctionData("owner")) {
        return owner.encodeFunctionResult("owner", ["0x0000000000000000000000000000000000000000"]);
      }
      return "0x";
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, bscConfirmations: 2 }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(await monitor.registerFourMemeFeatureActivations([{
    quoteConfig: { symbol: "SPCXB", address: quote, status: "PUBLISH" },
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  const snapshot = await monitor.getState();
  const activation = Object.values(snapshot.officialSources.fourMeme.featureActivations)[0];
  assert.equal(archiveLogCalls, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].transactionHash, tx2);
  assert.equal(activation.firstTokenTransactionHash, tx2);
  assert.equal(activation.replayAttemptedCandidateKeys.length, 2);
  assert.ok(activation.hotReplayLastAttemptAt);
  assert.equal(snapshot.officialSources.fourMeme.creationEventHotIndex.length, 2);
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  assert.equal(durable.officialSources.fourMeme.creationEventHotIndex.length, 2);
  assert.equal(durable.officialSources.fourMeme.featureActivations[activation.key].firstTokenTransactionHash, tx2);
});

test("Four.Meme hot-index processing failure leaves the activation open and candidate retryable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-hot-index-failure-"));
  const clock = Date.parse("2026-08-10T09:30:00.000Z");
  const core = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
  const quote = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
  const token = "0x1111111111111111111111111111111111111111";
  const transactionHash = `0x${"3".repeat(64)}`;
  const observedAt = new Date(clock - 60_000).toISOString();
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 98,
    launchers: {},
    seenTransactions: { [transactionHash]: 97 },
    officialSources: { fourMeme: { creationEventHotIndex: [{
      launcher: core,
      token,
      transactionHash,
      blockNumber: 97,
      transactionIndex: 0,
      logIndex: 0,
      topic: OPENFOUR_TOKEN_CREATED_TOPIC,
      observedAt,
      indexedAt: observedAt,
      presetId: "1778027615723",
      quoteAsset: quote,
    }] } },
  }));
  let archiveCalls = 0;
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    externalAttribution: false,
    provider: {
      destroy() {},
      async getTransaction() { throw new Error("hot candidate RPC failure"); },
      async getTransactionReceipt() { throw new Error("hot candidate RPC failure"); },
      async getBlockNumber() { archiveCalls += 1; return 100; },
      async send() { archiveCalls += 1; return []; },
    },
    now: () => clock,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(await monitor.registerFourMemeFeatureActivations([{
    quoteConfig: { symbol: "SPCXB", address: quote, status: "PUBLISH" },
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  const activation = Object.values((await monitor.getState()).officialSources.fourMeme.featureActivations)[0];
  assert.equal(archiveCalls, 0, "a failed hot candidate must not be skipped by immediately completing archive replay");
  assert.equal(activation.firstTokenTransactionHash, null);
  assert.equal(activation.replayCompletedAt, null);
  assert.equal(activation.hotReplayCompletedAt, null);
  assert.deepEqual(activation.replayAttemptedCandidateKeys, []);
  assert.match(activation.replayLastError, /hot candidate RPC failure/);
});

test("Four.Meme log replay reopens pruned transactions, skips an unsafe first token, and alerts the next safe token", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-replay-pruned-"));
  const clock = Date.parse("2026-08-10T09:30:00.000Z");
  const core = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
  const quote = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
  const token1 = "0x1111111111111111111111111111111111111111";
  const token2 = "0x2222222222222222222222222222222222222222";
  const tx1 = `0x${"a".repeat(64)}`;
  const tx2 = `0x${"b".repeat(64)}`;
  const blockHash1 = `0x${"e1".repeat(32)}`;
  const blockHash2 = `0x${"e2".repeat(32)}`;
  const creator1 = "0x3333333333333333333333333333333333333333";
  const creator2 = "0x4444444444444444444444444444444444444444";
  const modules = ["5", "6", "7", "8", "9", "a"].map((digit) => `0x${digit.repeat(40)}`);
  const iface = new Interface(["event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)"]);
  const makeLog = (token, creator, transactionHash, blockHash, blockNumber, transactionIndex) => {
    const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [
      BigInt(blockNumber), 1778027615723n, creator, token, `Token ${blockNumber}`, `T${blockNumber}`,
      1_000n, 800n, 20n, 1n, quote, ...modules, "ipfs://meta", 0n, "0x",
    ]);
    return {
      address: core,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: `0x${blockNumber.toString(16)}`,
      transactionIndex: `0x${transactionIndex.toString(16)}`,
      logIndex: "0x0",
      transactionHash,
      blockHash,
      removed: false,
    };
  };
  const log1 = makeLog(token1, creator1, tx1, blockHash1, 9, 0);
  const log2 = makeLog(token2, creator2, tx2, blockHash2, 10, 0);
  const transactions = new Map([
    [tx1, { hash: tx1, blockNumber: 9, blockHash: blockHash1, index: 0, transactionIndex: 0, to: core, from: creator1, data: `0x12345678${"0".repeat(64)}` }],
    [tx2, { hash: tx2, blockNumber: 10, blockHash: blockHash2, index: 0, transactionIndex: 0, to: core, from: creator2, data: `0x12345678${"0".repeat(64)}` }],
  ]);
  const receipts = new Map([
    [tx1, { transactionHash: tx1, blockHash: blockHash1, status: 1, blockNumber: 9, index: 0, transactionIndex: 0, logs: [log1] }],
    [tx2, { transactionHash: tx2, blockHash: blockHash2, status: 1, blockNumber: 10, index: 0, transactionIndex: 0, logs: [log2] }],
  ]);
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 98,
    launchers: {},
    seenTransactions: { [tx1]: 9, [tx2]: 10 },
  }));
  const owner = new Interface(["function owner() view returns(address)"]);
  const controllerCode = `0x${"6000".repeat(400)}`;
  const unsafeCode = `0x6340c10f19${"6000".repeat(300)}`;
  const safeCode = `0x${"6000".repeat(300)}`;
  const alerts = [];
  const provider = {
    async getBlockNumber() { return 100; },
    async getBlock(blockNumber) {
      const isFirst = Number(blockNumber) === 9;
      return { number: Number(blockNumber), hash: isFirst ? blockHash1 : blockHash2, timestamp: Math.floor((clock - (100 - Number(blockNumber)) * 750) / 1_000), transactions: [isFirst ? tx1 : tx2] };
    },
    async send(method, [filter]) {
      assert.equal(method, "eth_getLogs");
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      assert.ok(to - from + 1 <= 10, "replay must respect the public archive RPC range limit");
      return [log1, log2].filter((log) => {
        const block = Number.parseInt(log.blockNumber, 16);
        return block >= from && block <= to;
      });
    },
    async getTransaction(hash) { return transactions.get(hash) || null; },
    async getTransactionReceipt(hash) { return receipts.get(hash) || null; },
    async getCode(address) {
      const normalized = String(address).toLowerCase();
      if (normalized === token1) return unsafeCode;
      if (normalized === token2) return safeCode;
      return controllerCode;
    },
    async getStorage() { return "0x"; },
    async call(request) {
      if (request.data === owner.encodeFunctionData("owner")) {
        return owner.encodeFunctionResult("owner", ["0x0000000000000000000000000000000000000000"]);
      }
      return "0x";
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, bscConfirmations: 2 }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(await monitor.registerFourMemeFeatureActivations([{
    quoteConfig: { symbol: "SPCXB", address: quote, status: "PUBLISH" },
    observedAt: new Date(clock).toISOString(),
  }]), 1);
  const snapshot = await monitor.getState();
  const activation = Object.values(snapshot.officialSources.fourMeme.featureActivations)[0];
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].transactionHash, tx2);
  assert.equal(alerts[0].tokens[0].token.toLowerCase(), token2);
  assert.equal(activation.firstTokenTransactionHash, tx2);
  assert.equal(activation.firstToken.toLowerCase(), token2);
  assert.ok(activation.replayCompletedAt);
  assert.equal(snapshot.seenTransactions[tx1], 9);
  assert.equal(snapshot.seenTransactions[tx2], 10);
  assert.ok(snapshot.launchers[core].tokens[token1]);
  assert.ok(snapshot.launchers[core].tokens[token2]);
});

test("v4 migration reopens v3 RPC coverage gaps without replaying older seen transactions", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-state-gap-replay-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  await fs.writeFile(stateFile, JSON.stringify({
    version: 3,
    lastFinalizedBlock: 1_000,
    launchers: {},
    hooks: {},
    seenTransactions: { old: 800, affected: 950 },
    transactionFailures: { affected: { blockNumber: 950, attempts: 9 } },
    coverageGaps: [{ fromBlock: 900, toBlock: 920, reason: "catchup_limit" }],
  }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
  const migrated = await monitor.getState();
  assert.equal(migrated.version, 7);
  assert.equal(migrated.lastFinalizedBlock, 899);
  assert.equal(migrated.alertSuppressedThroughBlock, 1_000);
  assert.equal(migrated.seenTransactions.old, 800);
  assert.equal(migrated.seenTransactions.affected, undefined);
  assert.deepEqual(migrated.transactionFailures, {});
  assert.deepEqual(migrated.coverageGaps, []);
  assert.equal(migrated.coverageRecoveryHistory.at(-1).fromBlock, 900);
});

test("BscScan indexing gaps are reopened instead of remaining quarantined", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-state-evidence-replay-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  await fs.writeFile(stateFile, JSON.stringify({
    version: 4,
    lastFinalizedBlock: 1_000,
    launchers: {},
    hooks: {},
    seenTransactions: { old: 800, affected: 950 },
    transactionFailures: { affected: { blockNumber: 950, attempts: 13 } },
    coverageGaps: [{
      fromBlock: 950,
      toBlock: 950,
      transactionHash: "affected",
      reason: "poison_transaction",
      error: "BscScan contract creation evidence missing for 0x1111111111111111111111111111111111111111",
    }],
  }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
  const migrated = await monitor.getState();
  assert.equal(migrated.lastFinalizedBlock, 949);
  assert.equal(migrated.alertSuppressedThroughBlock, 1_000);
  assert.equal(migrated.seenTransactions.old, 800);
  assert.equal(migrated.seenTransactions.affected, undefined);
  assert.deepEqual(migrated.transactionFailures, {});
  assert.deepEqual(migrated.coverageGaps, []);
  assert.match(migrated.coverageRecoveryHistory.at(-1).reason, /recheck_bscscan_creation_evidence/);
});

test("v4 anonymous launchers use targeted causal rebuild and legacy confirmations are downgraded", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-state-targeted-replay-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"a".repeat(64)}`;
  const token = "0x2222222222222222222222222222222222222222";
  const launcher = "0x1111111111111111111111111111111111111111";
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 4,
    initializedAt: new Date(old).toISOString(),
    lastFinalizedBlock: 1_000,
    launchers: {
      [launcher]: {
        launcher,
        platform: null,
        discoveryAlerted: true,
        modes: { noisy: { fingerprint: "noisy" } },
        alertedModes: ["noisy"],
        tokens: { [token]: { token, transactionHash, firstSeenBlock: 900 } },
      },
    },
    seenTransactions: { [transactionHash]: 900, unrelated: 899 },
    coverageGaps: [],
  }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
  const migrated = await monitor.getState();
  assert.equal(migrated.lastFinalizedBlock, 1_000);
  assert.equal(migrated.alertSuppressedThroughBlock, 900);
  assert.equal(migrated.seenTransactions[transactionHash], undefined);
  assert.equal(migrated.seenTransactions.unrelated, 899);
  assert.deepEqual(migrated.migrationReplayTransactions, [{ transactionHash, blockNumber: 900, tokens: [token] }]);
  assert.equal(migrated.launchers[launcher].discoveryAlerted, false);
  assert.equal(migrated.launchers[launcher].legacyDiscoveryAlerted, true);
  assert.deepEqual(migrated.launchers[launcher].modes, {});
  assert.match(migrated.coverageRecoveryHistory.at(-1).reason, /targeted_causal/);
});

test("v4 known launchers also use targeted replay so their stable mode is rebuilt silently", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-known-targeted-replay-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"b".repeat(64)}`;
  const token = "0x4444444444444444444444444444444444444444";
  const launcher = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 4,
    initializedAt: new Date(old).toISOString(),
    lastFinalizedBlock: 1_000,
    launchers: {
      [launcher]: {
        launcher,
        platform: { id: "flap", name: "Flap", trust: "official_verified" },
        discoveryAlerted: false,
        modes: { noisy: { fingerprint: "noisy" } },
        alertedModes: [],
        tokens: { [token]: { token, transactionHash, firstSeenBlock: 910 } },
      },
    },
    seenTransactions: { [transactionHash]: 910 },
    coverageGaps: [],
  }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
  const migrated = await monitor.getState();
  assert.deepEqual(migrated.migrationReplayTransactions, [{ transactionHash, blockNumber: 910, tokens: [token] }]);
  assert.equal(migrated.seenTransactions[transactionHash], undefined);
  assert.equal(migrated.alertSuppressedThroughBlock, 910);
  assert.deepEqual(migrated.launchers[launcher].modes, {});
});

test("Four.Meme official API baselines silently and requires two identical observations before alerting", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let roots = [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC", network: 0 }];
  let templates = [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }];
  let quotes = [{ symbol: "BNB", symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", platform: "MEME", networkCode: "BSC", status: "PUBLISH" }];
  const alerts = [];
  const registry = new Interface([
    "function isPresetActive(uint256 presetId) view returns (bool)",
    "function isPresetCreateEnabled(uint256 presetId) view returns (bool)",
  ]);
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? roots
      : url.includes("/config")
        ? quotes
        : templates }),
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: {
      destroy() {},
      async call(request) {
        const parsed = registry.parseTransaction({ data: request.data });
        return registry.encodeFunctionResult(parsed.name, [false]);
      },
      async getBlockNumber() { return 100; },
      async getBlock() { return { timestamp: Math.floor(Date.now() / 1_000) }; },
      async send() { return []; },
    },
    fetchImpl,
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  await monitor.checkOfficialSources();
  assert.equal(alerts.length, 0);
  roots = [...roots, { name: "TokenManager4", address: "0x1111111111111111111111111111111111111111", networkCode: "BSC", network: 0 }];
  templates = [...templates, { id: 2, name: "New Mode", tag: "Hook", codeType: "SOLIDITY", descr: "new mechanism", status: "PUBLISHED" }];
  quotes = [...quotes, { symbol: "SPCXB", symbolAddress: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1", platform: "MEME", networkCode: "BSC", status: "PUBLISH", totalBAmount: "90" }];
  await monitor.checkOfficialSources();
  assert.equal(alerts.length, 0);
  await monitor.checkOfficialSources();
  assert.deepEqual(alerts.map((event) => event.kind).sort(), ["new_factory", "new_mode"]);
  const newTemplateAlert = alerts.find((event) => event.mode?.selector === "official-template");
  assert.equal(newTemplateAlert.previousTemplate, null);
  assert.equal(newTemplateAlert.currentTemplate.id, "2");
  assert.equal(newTemplateAlert.currentTemplate.name, "New Mode");
  assert.deepEqual(newTemplateAlert.changedFields, ["template"]);
  assert.equal(newTemplateAlert.changeType, "new_published_template");
  assert.deepEqual(newTemplateAlert.officialCapability, {
    version: 1,
    platform: "fourmeme",
    kind: "template",
    changeType: "new_published_template",
    sourceId: "fourmeme_public_template_api",
    sourceUrl: "https://four.meme/meme-api/v1/public/token_template/search",
    observedAt: newTemplateAlert.observedAt,
  });
  assert.deepEqual(newTemplateAlert.source, {
    id: "fourmeme_public_template_api",
    name: "Four.Meme public template API",
    url: "https://four.meme/meme-api/v1/public/token_template/search",
    trust: "official_verified",
    official: true,
  });
  assert.equal(newTemplateAlert.sourceTrust, "official_verified");
  assert.equal(newTemplateAlert.mode.officialName, "New Mode");
  assert.equal(newTemplateAlert.mode.componentMode, "New Mode");
  const accepted = await monitor.getState();
  assert.equal(Object.values(accepted.officialSources.fourMeme.featureActivations).some((activation) => activation.type === "quote_config" && activation.quoteSymbol === "SPCXB"), true);
  await monitor.checkOfficialSources();
  assert.equal(alerts.length, 2);
  templates = templates.map((template) => template.id === 2
    ? { ...template, amount: "6000", descr: "new oracle mechanism costs 0.3 BNB" }
    : template);
  await monitor.checkOfficialSources();
  assert.equal(alerts.length, 2, "one changed-template observation remains pending");
  await monitor.checkOfficialSources();
  assert.equal(alerts.length, 3);
  const changedTemplateAlert = alerts.at(-1);
  assert.equal(changedTemplateAlert.previousTemplate.description, "new mechanism");
  assert.equal(changedTemplateAlert.currentTemplate.description, "new oracle mechanism costs 0.3 BNB");
  assert.deepEqual(changedTemplateAlert.changedFields, ["description", "amount", "mechanismTerms", "numericParameters"]);

  templates = templates.map((template) => template.id === 2
    ? { ...template, status: "DISABLED" }
    : template);
  await monitor.checkOfficialSources();
  assert.equal(alerts.length, 3, "one explicit unpublish observation remains pending");
  await monitor.checkOfficialSources();
  assert.equal(alerts.length, 4);
  const unpublished = alerts.at(-1);
  assert.equal(unpublished.changeType, "template_unpublished");
  assert.equal(unpublished.previousTemplate.status, "PUBLISHED");
  assert.equal(unpublished.currentTemplate.status, "DISABLED");
  assert.deepEqual(unpublished.changedFields, ["status"]);
  const afterUnpublish = await monitor.getState();
  const templateActivations = Object.values(afterUnpublish.officialSources.fourMeme.featureActivations)
    .filter((activation) => activation.type === "template" && activation.templateId === "2");
  assert.ok(templateActivations.length > 0);
  assert.equal(templateActivations.every((activation) => activation.active === false), true);
  assert.equal(templateActivations.every((activation) => activation.deactivationReason === "official_template_unpublished"), true);
});

test("Four.Meme 403 source circuits batch one checkpoint per failed round across two hours and restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-source-circuit-"));
  let current = Date.parse("2026-08-24T10:00:00.000Z");
  let requests = 0;
  let writes = 0;
  const errors = [];
  const fetchImpl = async () => {
    requests += 1;
    return { ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" };
  };
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    fetchImpl,
    now: () => current,
    logger: { error(message) { errors.push(String(message)); }, info() {} },
    atomicWriteImpl: async (file, snapshot) => {
      writes += 1;
      await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    },
  };
  const config = { dataDir, monitorScope: "focus3" };
  let monitor = createBscLaunchpadMonitor(config, dependencies);
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await monitor.checkOfficialSources();
  assert.equal(requests, 3);
  const writesAfterFirstRound = writes;
  assert.equal(errors.filter((message) => message.startsWith("[bsc][fourmeme-source] http_403")).length, 3);
  let snapshot = await monitor.getState();
  assert.equal(Object.values(snapshot.officialSources.fourMeme.sourceCircuits).every((source) => source.nextRetryAt === "2026-08-24T10:15:00.000Z"), true);

  await monitor.stop();
  monitor = createBscLaunchpadMonitor(config, dependencies);
  await monitor.getState();
  const writesAfterRestartInitialization = writes;
  current += 5_000;
  await monitor.checkOfficialSources();
  assert.equal(requests, 3, "restart must not bypass any persisted URL circuit");
  assert.equal(writes, writesAfterRestartInitialization, "a fully cooled poll does not rewrite state");

  const end = Date.parse("2026-08-24T12:00:00.000Z");
  while (current < end) {
    current += 5_000;
    await monitor.checkOfficialSources();
  }
  snapshot = await monitor.getState();
  assert.equal(requests, 9, "only the 15-minute and 1-hour recovery deadlines probe the three URLs");
  assert.equal(writes - writesAfterRestartInitialization, 2, "three same-round failures share one durable checkpoint");
  assert.equal(errors.filter((message) => message.startsWith("[bsc][fourmeme-source] http_403")).length, 9);
  assert.equal(Object.values(snapshot.officialSources.fourMeme.sourceCircuits).every((source) => source.forbiddenFailures === 3), true);
  assert.equal(Object.values(snapshot.officialSources.fourMeme.sourceCircuits).every((source) => source.nextRetryAt === "2026-08-24T17:15:00.000Z"), true);
  assert.ok(writesAfterFirstRound >= 2, "initialization and the first batch checkpoint are durable");
});

test("one Four.Meme source circuit does not stop the other official sources and clears on one recovery probe", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-source-isolation-"));
  let current = Date.parse("2026-08-24T10:00:00.000Z");
  let addressHealthy = false;
  const calls = { address: 0, template: 0, config: 0 };
  const errors = [];
  const fetchImpl = async (url) => {
    if (url.includes("/address")) {
      calls.address += 1;
      if (!addressHealthy) return { ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }] }) };
    }
    if (url.includes("/config")) {
      calls.config += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: [{ symbol: "BNB", symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", platform: "MEME", networkCode: "BSC", status: "PUBLISH" }] }) };
    }
    calls.template += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED", deployCount: 1 }] }) };
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3" }, {
    autoStart: false,
    provider: { destroy() {} },
    fetchImpl,
    now: () => current,
    logger: { error(message) { errors.push(String(message)); }, info() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.checkOfficialSources();
  current += 5_000;
  await monitor.checkOfficialSources();
  assert.deepEqual(calls, { address: 1, template: 2, config: 2 }, "only the blocked URL is skipped");
  assert.equal(errors.filter((message) => message.includes("fourmeme-source")).length, 1);

  addressHealthy = true;
  current = Date.parse("2026-08-24T10:15:00.000Z");
  await monitor.checkOfficialSources();
  let snapshot = await monitor.getState();
  assert.deepEqual(calls, { address: 2, template: 3, config: 3 });
  assert.equal(snapshot.officialSources.fourMeme.sourceCircuits["https://four.meme/meme-api/v1/public/address"].status, "healthy");
  assert.equal(snapshot.officialSources.fourMeme.sourceCircuits["https://four.meme/meme-api/v1/public/address"].nextRetryAt, null);
  assert.equal(errors.filter((message) => message.includes("fourmeme-source] recovered")).length, 1);
  current += 5_000;
  await monitor.checkOfficialSources();
  snapshot = await monitor.getState();
  assert.equal(calls.address, 3);
  assert.equal(errors.filter((message) => message.includes("fourmeme-source] recovered")).length, 1, "steady health does not repeat recovery logs");
});

test("Four.Meme 429 Retry-After and timeout circuits use their exact independent deadlines", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-fourmeme-source-policies-"));
  let current = Date.parse("2026-08-24T10:00:00.000Z");
  const calls = { address: 0, template: 0, config: 0 };
  const fetchImpl = async (url) => {
    if (url.includes("/address")) {
      calls.address += 1;
      return {
        ok: false,
        status: 429,
        headers: { get(name) { return String(name).toLowerCase() === "retry-after" ? "120" : null; } },
        text: async () => "limited",
      };
    }
    if (url.includes("token_template")) {
      calls.template += 1;
      const error = new Error("official template request timed out");
      error.code = "TIMEOUT";
      throw error;
    }
    calls.config += 1;
    return { ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" };
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3" }, {
    autoStart: false,
    provider: { destroy() {} },
    fetchImpl,
    now: () => current,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.checkOfficialSources();
  let circuits = (await monitor.getState()).officialSources.fourMeme.sourceCircuits;
  assert.equal(circuits["https://four.meme/meme-api/v1/public/address"].nextRetryAt, "2026-08-24T10:02:00.000Z");
  assert.equal(circuits["https://four.meme/meme-api/v1/public/token_template/search"].nextRetryAt, "2026-08-24T10:00:05.000Z");
  assert.equal(circuits["https://four.meme/meme-api/v1/public/config"].nextRetryAt, "2026-08-24T10:15:00.000Z");
  current += 4_000;
  await monitor.checkOfficialSources();
  assert.deepEqual(calls, { address: 1, template: 1, config: 1 });
  current += 1_000;
  await monitor.checkOfficialSources();
  assert.deepEqual(calls, { address: 1, template: 2, config: 1 });
  circuits = (await monitor.getState()).officialSources.fourMeme.sourceCircuits;
  assert.equal(circuits["https://four.meme/meme-api/v1/public/token_template/search"].nextRetryAt, "2026-08-24T10:00:15.000Z");
});

test("a slow official API alert does not hold the state lock or duplicate its event key", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-official-alert-lock-"));
  let releaseAlert;
  let markAlertStarted;
  const alertStarted = new Promise((resolve) => { markAlertStarted = resolve; });
  const alertGate = new Promise((resolve) => { releaseAlert = resolve; });
  let roots = [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC", network: 0 }];
  const templates = [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }];
  let alertCalls = 0;
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? roots
      : url.includes("/config")
        ? [{ symbol: "BNB", symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", platform: "MEME", networkCode: "BSC", status: "PUBLISH" }]
        : templates }),
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    fetchImpl,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async () => {
      alertCalls += 1;
      markAlertStarted();
      await alertGate;
      return { status: "delivered" };
    },
  });
  t.after(async () => {
    releaseAlert();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await monitor.checkOfficialSources();
  roots = [...roots, { name: "TokenManager4", address: "0x1111111111111111111111111111111111111111", networkCode: "BSC", network: 0 }];
  await monitor.checkOfficialSources();
  const pendingCheck = monitor.checkOfficialSources();
  await alertStarted;

  const liveSnapshot = await Promise.race([
    monitor.getState(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("official alert held the state lock")), 100)),
  ]);
  assert.equal(liveSnapshot.officialSources.fourMeme.pendingRoots.observations, 2);
  const unrelated = observation({
    launcher: "0x8888888888888888888888888888888888888888",
    token: "0x9999999999999999999999999999999999999999",
    transactionHash: `0x${"d".repeat(64)}`,
    blockNumber: 103,
  });
  await monitor.observe(unrelated);
  await Promise.race([
    monitor.checkOfficialSources(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("concurrent official check did not honor its reservation")), 100)),
  ]);
  assert.equal(alertCalls, 1);
  assert.equal((await monitor.getState()).seenTransactions[unrelated.transactionHash], 103);

  releaseAlert();
  await pendingCheck;
  const accepted = await monitor.getState();
  assert.equal(alertCalls, 1);
  assert.ok(accepted.officialSources.fourMeme.roots["0x1111111111111111111111111111111111111111"]);
  assert.equal(accepted.officialSources.fourMeme.pendingRoots, null);
});

test("a failed official API alert keeps the snapshot pending and retries without duplicate success", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-official-alert-retry-"));
  let roots = [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC", network: 0 }];
  const templates = [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }];
  let failAlert = true;
  let alertCalls = 0;
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? roots
      : url.includes("/config")
        ? [{ symbol: "BNB", symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", platform: "MEME", networkCode: "BSC", status: "PUBLISH" }]
        : templates }),
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    fetchImpl,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async () => {
      alertCalls += 1;
      if (failAlert) throw new Error("official outbox unavailable");
      return { status: "delivered" };
    },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await monitor.checkOfficialSources();
  const baseline = await monitor.getState();
  roots = [...roots, { name: "TokenManager4", address: "0x2222222222222222222222222222222222222222", networkCode: "BSC", network: 0 }];
  await monitor.checkOfficialSources();
  await monitor.checkOfficialSources();
  let pending = await monitor.getState();
  assert.equal(alertCalls, 1);
  assert.equal(pending.officialSources.fourMeme.rootFingerprint, baseline.officialSources.fourMeme.rootFingerprint);
  assert.equal(pending.officialSources.fourMeme.roots["0x2222222222222222222222222222222222222222"], undefined);
  assert.equal(pending.officialSources.fourMeme.pendingRoots.fingerprint !== null, true);

  failAlert = false;
  await monitor.checkOfficialSources();
  pending = await monitor.getState();
  assert.equal(alertCalls, 2);
  assert.ok(pending.officialSources.fourMeme.roots["0x2222222222222222222222222222222222222222"]);
  assert.equal(pending.officialSources.fourMeme.pendingRoots, null);
  await monitor.checkOfficialSources();
  assert.equal(alertCalls, 2, "a committed official event must not be sent again");
});

test("a failed BSC alert does not commit the triggering transaction or mode", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-alert-rollback-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let fail = true;
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    now: () => current,
    sendAlertsImpl: async () => {
      if (fail) throw new Error("outbox unavailable");
      return { status: "delivered" };
    },
  });
  t.after(() => monitor.stop());
  const first = observation();
  const second = observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    blockNumber: 101,
  });
  await monitor.observe(first);
  await assert.rejects(() => monitor.observe(second), /outbox unavailable/);
  let snapshot = await monitor.getState();
  const launcher = snapshot.launchers[first.launcher.toLowerCase()];
  assert.equal(launcher.tokens[second.tokens[0].token.toLowerCase()], undefined);
  assert.equal(snapshot.seenTransactions[second.transactionHash], undefined);
  fail = false;
  const event = await monitor.observe(second);
  assert.equal(event.kind, "new_launchpad");
  snapshot = await monitor.getState();
  assert.equal(snapshot.launchers[first.launcher.toLowerCase()].discoveryAlerted, true);
});

test("transaction hashes are normalized before durable and in-flight deduplication", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-hash-normalization-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
  });
  t.after(() => monitor.stop());
  const sample = observation();
  const uppercaseHash = sample.transactionHash.toUpperCase();
  await monitor.observe({ ...sample, transactionHash: uppercaseHash });
  const snapshot = await monitor.getState();
  assert.equal(snapshot.seenTransactions[sample.transactionHash], sample.blockNumber);
  assert.equal(snapshot.seenTransactions[uppercaseHash], undefined);
});

test("an in-flight BSC alert never leaks its transaction into the durable state", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-alert-draft-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  let rejectAlert;
  let alertStarted;
  const started = new Promise((resolve) => { alertStarted = resolve; });
  monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    now: () => current,
    sendAlertsImpl: async () => new Promise((_resolve, reject) => {
      rejectAlert = reject;
      alertStarted();
    }),
  });
  const first = observation();
  const second = observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    blockNumber: 101,
  });
  await monitor.observe(first);
  const pending = monitor.observe(second);
  await started;
  const liveSnapshot = await Promise.race([
    monitor.getState(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("state lock was held by alert delivery")), 100)),
  ]);
  assert.equal(liveSnapshot.seenTransactions[second.transactionHash], undefined);
  const unrelated = observation({
    launcher: "0x5555555555555555555555555555555555555555",
    token: "0x6666666666666666666666666666666666666666",
    transactionHash: `0x${"c".repeat(64)}`,
    blockNumber: 102,
  });
  await monitor.observe(unrelated);
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  assert.equal(durable.seenTransactions[second.transactionHash], undefined);
  assert.equal(durable.launchers[first.launcher.toLowerCase()].tokens[second.tokens[0].token.toLowerCase()], undefined);
  assert.equal(durable.seenTransactions[unrelated.transactionHash], unrelated.blockNumber, "an unrelated realtime observation must commit while delivery is slow");
  rejectAlert(new Error("outbox unavailable"));
  await assert.rejects(() => pending, /outbox unavailable/);
});

test("concurrent decisions reserve one event key and merge both revisions without rollback", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-alert-reservation-"));
  let releaseAlert;
  let markAlertStarted;
  let alertCalls = 0;
  const alertStarted = new Promise((resolve) => { markAlertStarted = resolve; });
  const alertGate = new Promise((resolve) => { releaseAlert = resolve; });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    now: () => current,
    sendAlertsImpl: async () => {
      alertCalls += 1;
      markAlertStarted();
      await alertGate;
    },
  });
  t.after(async () => {
    releaseAlert();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const first = observation();
  const second = observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: `0x${"b".repeat(64)}`,
    blockNumber: 101,
  });
  const third = observation({
    token: "0x5555555555555555555555555555555555555555",
    transactionHash: `0x${"c".repeat(64)}`,
    blockNumber: 102,
  });
  await monitor.observe(first);
  const secondPending = monitor.observe(second);
  await alertStarted;
  const thirdPending = monitor.observe(third);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(alertCalls, 1, "the same launchpad event key must have one in-flight owner");
  releaseAlert();
  const [secondEvent, thirdEvent] = await Promise.all([secondPending, thirdPending]);
  assert.equal(alertCalls, 1);
  assert.equal(secondEvent?.kind, "new_launchpad");
  assert.equal(thirdEvent, null);
  const snapshot = await monitor.getState();
  const launcher = snapshot.launchers[first.launcher.toLowerCase()];
  assert.equal(launcher.discoveryAlerted, true);
  assert.equal(launcher.uniqueTokenCount, 3);
  assert.equal(snapshot.seenTransactions[second.transactionHash], 101);
  assert.equal(snapshot.seenTransactions[third.transactionHash], 102);
});

test("stop waits for alert, processors, state and save locks before destroying the provider", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-stop-idle-"));
  let releaseAlert;
  let markAlertStarted;
  let destroyCalls = 0;
  let stopResolved = false;
  const alertStarted = new Promise((resolve) => { markAlertStarted = resolve; });
  const alertGate = new Promise((resolve) => { releaseAlert = resolve; });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() { destroyCalls += 1; } },
    now: () => current,
    sendAlertsImpl: async () => {
      markAlertStarted();
      await alertGate;
    },
  });
  t.after(async () => {
    releaseAlert();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const first = observation();
  const second = observation({
    token: "0x4444444444444444444444444444444444444444",
    transactionHash: `0x${"b".repeat(64)}`,
    blockNumber: 101,
  });
  await monitor.observe(first);
  const pendingObservation = monitor.observe(second);
  await alertStarted;
  const stopping = monitor.stop().then(() => { stopResolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopResolved, false);
  assert.equal(destroyCalls, 0, "provider destruction must not interrupt an in-flight commit");
  releaseAlert();
  await pendingObservation;
  await stopping;
  assert.equal(destroyCalls, 1);
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  assert.equal(durable.seenTransactions[second.transactionHash], 101);
});

test("a failed initial RPC retries the complete BSC start and reconciles finalized receipts", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-start-retry-"));
  let networkCalls = 0;
  const receiptBlocks = [];
  const provider = {
    async getNetwork() {
      networkCalls += 1;
      if (networkCalls === 1) throw new Error("temporary RPC outage");
      return { chainId: 56n };
    },
    async getBlockNumber() { return 100; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [block]) {
      assert.equal(method, "eth_getBlockReceipts");
      receiptBlocks.push(Number.parseInt(block, 16));
      return [];
    },
    destroy() {},
  };
  class FakeWebSocket {
    static instances = [];
    constructor() {
      this.handlers = new Map();
      this.closed = false;
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const handlers = this.handlers.get(kind) || [];
      handlers.push(handler);
      this.handlers.set(kind, handlers);
    }
    emit(kind, event) {
      for (const handler of this.handlers.get(kind) || []) handler(event);
    }
    send(raw) {
      const request = JSON.parse(raw);
      const subscription = `sub-${request.id}`;
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription }) });
        if (request.params[0] === "newHeads") {
          this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result: { number: "0x66" } } }) });
        }
      });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", {});
    }
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscMaxCatchupBlocks: 240,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    provider,
    WebSocketImpl: FakeWebSocket,
    fetchImpl,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitUntil(() => networkCalls >= 2 && receiptBlocks.length >= 2);
  assert.equal(networkCalls, 2);
  assert.equal(FakeWebSocket.instances.length, 1);
  const snapshot = await monitor.getState();
  assert.equal(snapshot._health.websocket.status, "healthy");
  assert.deepEqual(snapshot._health.websocket.activeSubscriptions, ["heads", "mints", "protocol"]);
  assert.deepEqual(receiptBlocks.sort((left, right) => left - right), [99, 100]);
});

test("receipt fallback never advances coverage on empty or wrong-block receipt data", async (t) => {
  const transactionHash = `0x${"a".repeat(64)}`;
  const scenarios = [{
    name: "empty receipts for a non-empty block",
    receipts: [],
    expectedError: /count mismatch/,
  }, {
    name: "receipt belonging to another block",
    receipts: [{ transactionHash, blockNumber: "0x64", logs: [] }],
    expectedError: /malformed block/,
  }];
  for (const scenario of scenarios) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-receipt-validation-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
      version: 6,
      initializedAt: "2026-08-02T00:00:00.000Z",
      lastFinalizedBlock: 100,
      realtimeTailNextBlock: 102,
      launchers: {},
      hooks: {},
      seenTransactions: {},
      coverageGaps: [],
    }));
    const provider = {
      async getNetwork() { return { chainId: 56n }; },
      async getBlockNumber() { return 103; },
      async getBlock(blockNumber) { return { number: blockNumber, transactions: [transactionHash] }; },
      async send(method) {
        if (method === "eth_getLogs") throw new Error("log range unavailable");
        if (method === "eth_getBlockReceipts") return scenario.receipts;
        throw new Error(`unexpected method ${method}`);
      },
      destroy() {},
    };
    class IdleWebSocket {
      addEventListener() {}
      close() {}
    }
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
        ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
        : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
    });
    const monitor = createBscLaunchpadMonitor({
      dataDir,
      bscMonitorEnabled: true,
      bscWsUrl: "wss://example.invalid",
      bscRpcUrl: "https://example.invalid",
      bscConfirmations: 2,
      bscHttpHeadPollIntervalMs: 60_000,
      bscOfficialPollIntervalMs: 60_000,
    }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });
    await monitor.start();
    let snapshot;
    const deadline = Date.now() + 1_000;
    do {
      snapshot = await monitor.getState();
      if (snapshot._health.rpc.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(snapshot.lastFinalizedBlock, 100, scenario.name);
    assert.equal(snapshot._health.rpc.status, "error", scenario.name);
    assert.match(snapshot._health.rpc.lastError, scenario.expectedError, scenario.name);
    await monitor.stop();
  }
});

test("independent HTTP heads keep receipt coverage moving when WebSocket heads are silent", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-http-head-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  let headCalls = 0;
  const logRanges = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { headCalls += 1; return headCalls === 1 ? 100 : 102; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      logRanges.push([Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)]);
      return [];
    },
    destroy() {},
  };
  class SilentHeadWebSocket {
    constructor() {
      this.handlers = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const handlers = this.handlers.get(kind) || [];
      handlers.push(handler);
      this.handlers.set(kind, handlers);
    }
    emit(kind, event) { for (const handler of this.handlers.get(kind) || []) handler(event); }
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: `sub-${request.id}` }) }));
    }
    close() { this.emit("close", {}); }
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscMaxCatchupBlocks: 240,
    bscHttpHeadPollIntervalMs: 20,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: SilentHeadWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  await monitor.start();
  await waitUntil(() => logRanges.length >= 2, 1_000);
  const snapshot = await monitor.getState();
  assert.equal(snapshot._health.websocket.status, "subscribing");
  assert.equal(snapshot._health.httpHead.status, "healthy");
  assert.deepEqual(logRanges.slice(0, 2), [[99, 100], [99, 100]]);
  assert.ok(logRanges.every((range) => range[0] === 99 && range[1] === 100));
});

test("entry inspection obeys the configured RPC concurrency", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-entry-concurrency-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const entries = Array.from({ length: 6 }, (_, index) => {
    const digit = (index + 1).toString(16);
    return {
      transactionHash: `0x${digit.repeat(64)}`,
      token: `0x${digit.repeat(40)}`,
      recipient: `0x${(index + 9).toString(16).repeat(40)}`,
    };
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 101,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  let activeCodeReads = 0;
  let maximumCodeReads = 0;
  let codeReads = 0;
  const receipts = new Map(entries.map(({ transactionHash, token, recipient }) => [transactionHash, {
    transactionHash,
    blockNumber: 101,
    status: 1,
    logs: [{
      address: token,
      transactionHash,
      blockNumber: "0x65",
      topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, `0x${"0".repeat(24)}${recipient.slice(2)}`],
      data: `0x${"0".repeat(63)}1`,
    }],
  }]));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 103; },
    async getCode() {
      codeReads += 1;
      activeCodeReads += 1;
      maximumCodeReads = Math.max(maximumCodeReads, activeCodeReads);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeCodeReads -= 1;
      return "0x";
    },
    async getTransaction(transactionHash) {
      return { hash: transactionHash, to: "0x7777777777777777777777777777777777777777", from: "0x8888888888888888888888888888888888888888", data: "0x" };
    },
    async getTransactionReceipt(transactionHash) { return receipts.get(transactionHash); },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      if (request.topics?.[0] !== BSC_TRANSFER_TOPIC) return [];
      return [...receipts.values()].flatMap((receipt) => receipt.logs);
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscEntryRpcConcurrency: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  await monitor.start();
  await waitUntil(() => codeReads >= entries.length && activeCodeReads === 0, 2_000);
  assert.ok(codeReads >= entries.length, "every queued entry must reach the RPC inspection stage");
  assert.equal(maximumCodeReads, 2);
});

test("realtime tail health becomes critical when a prior healthy success is stale", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-stale-health-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const clock = Date.parse("2026-08-02T01:00:00.000Z");
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    _health: {
      realtimeTail: {
        status: "healthy",
        checkedAt: "2026-08-02T00:00:00.000Z",
        lastSuccessAt: "2026-08-02T00:00:00.000Z",
        nextBlock: 101,
      },
    },
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async send() { return []; },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscExpectedBlockTimeMs: 500,
    bscHealthDegradedLagBlocks: 5,
    bscHealthCriticalLagBlocks: 10,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, now: () => clock, logger: { error() {}, info() {} } });
  await monitor.start();
  const snapshot = await monitor.getState();
  assert.equal(snapshot._health.realtimeTail.status, "critical");
  assert.equal(snapshot._health.realtimeTail.lagBlocks, 0);
  assert.equal(snapshot._health.realtimeTail.lastSuccessAgeMs, 3_600_000);
});

test("realtime tail keeps its cursor and backs off instead of blocking on full receipt scans", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-receipt-fallback-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 103,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  let getLogsAvailable = false;
  let receiptCalls = 0;
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 105; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [request]) {
      if (method === "eth_getLogs") {
        if (!getLogsAvailable) throw new Error("global getLogs disabled");
        return [];
      }
      if (method === "eth_getBlockReceipts") receiptCalls += 1;
      throw new Error(`unexpected realtime fallback ${method} ${request}`);
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscEntryRpcConcurrency: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  await monitor.start();
  await waitUntil(async () => (await monitor.getState())._health.realtimeTail.status === "error", 2_000);
  let snapshot = await monitor.getState();
  assert.equal(receiptCalls, 0, "the latency-sensitive lane must not expand one failed query into full block scans");
  assert.equal(snapshot.realtimeTailNextBlock, 101, "a failed range must remain behind the durable cursor");
  assert.ok(snapshot._health.realtimeTail.retryDelayMs >= 500);
  assert.ok(Date.parse(snapshot._health.realtimeTail.nextRetryAt) >= Date.parse(snapshot._health.realtimeTail.lastErrorAt));

  getLogsAvailable = true;
  await waitUntil(async () => (await monitor.getState()).realtimeTailNextBlock === 104, 3_000);
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 104);
  assert.equal(snapshot._health.realtimeTail.status, "healthy");
  assert.equal(snapshot._health.realtimeTail.coveredBlock, 103);
  assert.equal(snapshot._health.realtimeTail.nextRetryAt, undefined);
});

test("realtime tail preserves the earliest viable provider Retry-After across direct calls and restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-long-retry-after-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let current = Date.parse("2026-08-24T10:30:00.000Z");
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 103,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-08-24T10:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  let available = false;
  let logRequests = 0;
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 105; },
    async send(method) {
      assert.equal(method, "eth_getLogs");
      logRequests += 1;
      if (available) return [];
      const error = new Error("eth_getLogs failed on every BSC RPC: providers cooling down; retry in 90000ms");
      error.code = "SERVER_ERROR";
      error.retryAfterMs = 90_000;
      error.rpcHostRetryAfterMs = 300_000;
      error.rpcFailureScope = "method";
      error.rpcOperation = "eth_getLogs";
      throw error;
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const dependencies = {
    autoStart: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => current,
    logger: { error() {}, info() {} },
  };
  const config = {
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  };
  let monitor = createBscLaunchpadMonitor(config, dependencies);
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.start();
  await waitUntil(async () => (await monitor.getState())._health.realtimeTail.status === "error", 2_000);
  let snapshot = await monitor.getState();
  assert.equal(snapshot._health.realtimeTail.retryDelayMs, 90_000);
  assert.equal(snapshot._health.realtimeTail.nextRetryAt, "2026-08-24T10:31:30.000Z");
  const requestsAfterFailure = logRequests;
  assert.equal((await monitor.scanRealtimeTail()).reason, "backoff");
  assert.equal(logRequests, requestsAfterFailure, "a direct scan cannot bypass the provider deadline");

  await monitor.stop();
  monitor = createBscLaunchpadMonitor(config, dependencies);
  await monitor.start();
  assert.equal((await monitor.scanRealtimeTail()).reason, "backoff");
  assert.equal(logRequests, requestsAfterFailure, "restart restores the exact long Retry-After without a probe");

  available = true;
  current += 90_000;
  const recovered = await monitor.scanRealtimeTail();
  assert.equal(recovered.skipped, false);
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 104);
  assert.equal(snapshot._health.realtimeTail.status, "healthy");
});

test("realtime processing persists shared RPC cooling without retry loops or dropped pending work", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-realtime-shared-backoff-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let current = Date.parse("2026-08-24T10:40:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const token = "0x1111111111111111111111111111111111111111";
  const creator = "0x4444444444444444444444444444444444444444";
  const transactionHash = `0x${"8".repeat(64)}`;
  const blockHash = `0x${"f8".repeat(32)}`;
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 103,
    realtimeTailNextBlock: 104,
    realtimeTailInitializedAt: "2026-08-24T10:00:00.000Z",
    realtimePendingEntries: {
      [transactionHash]: {
        transactionHash,
        blockNumber: 100,
        transactionIndex: 0,
        logIndex: 0,
        reasons: ["http_tail"],
        mintEmitters: [token],
        candidateTokens: [token],
        verifiedNewContracts: [token],
        upgradeEmitters: [],
        lifecycleEmitters: [],
        hookPools: [],
        hasProtocolTrigger: true,
        observedAt: "2026-08-24T10:39:59.000Z",
      },
    },
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1n, creator, 1n, token, "WAL", "WAL", "ipfs://wal"]);
  const log = {
    address: launcher,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockHash,
    blockNumber: 100,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
  let cooling = true;
  let transactionRequests = 0;
  let writes = 0;
  const errors = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 105; },
    async getTransaction(hash) {
      transactionRequests += 1;
      if (cooling) {
        const error = new Error("eth_getTransaction failed on every BSC RPC: providers cooling down; retry in 5000ms");
        error.code = "SERVER_ERROR";
        error.retryAfterMs = 5_000;
        throw error;
      }
      return { hash, blockNumber: 100, blockHash, index: 0, transactionIndex: 0, to: launcher, from: creator, data: `0x8cb5772c${"0".repeat(64)}` };
    },
    async getTransactionReceipt(hash) { return { transactionHash: hash, blockHash, status: 1, blockNumber: 100, index: 0, transactionIndex: 0, logs: [log] }; },
    async getBlock() { return { number: 100, hash: blockHash, timestamp: Math.floor(current / 1_000), transactions: [transactionHash] }; },
    async getCode(address) { return String(address).toLowerCase() === token ? `0x${"6000".repeat(300)}` : `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const config = {
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  };
  const dependencies = {
    autoStart: false,
    externalAttribution: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => current,
    logger: { error(message) { errors.push(String(message)); }, info() {} },
    atomicWriteImpl: async (file, snapshot) => {
      writes += 1;
      await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    },
  };
  let monitor = createBscLaunchpadMonitor(config, dependencies);
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.start();
  await waitUntil(async () => (await monitor.getState())._health.realtimeQueue.status === "backoff", 2_000);
  // start() also launches independent official-source/replay maintenance.
  // Settle those expected startup writes before asserting that cooling queue
  // wakeups themselves remain write-free.
  await monitor.awaitIdle();
  let snapshot = await monitor.getState();
  assert.equal(snapshot._health.realtimeQueue.nextRetryAt, "2026-08-24T10:40:05.000Z");
  assert.ok(snapshot.realtimePendingEntries[transactionHash]);
  const requestsAfterFailure = transactionRequests;
  const writesAfterFailure = writes;
  await monitor.processRealtimeQueue();
  await monitor.processRealtimeQueue();
  assert.equal(transactionRequests, requestsAfterFailure);
  assert.equal(writes, writesAfterFailure);
  assert.equal(errors.filter((message) => message.startsWith("[bsc][realtime]")).length, 1);

  await monitor.stop();
  monitor = createBscLaunchpadMonitor(config, dependencies);
  await monitor.start();
  await monitor.processRealtimeQueue();
  assert.equal(transactionRequests, requestsAfterFailure, "restart must preserve the realtime processing deadline");

  current += 5_000;
  await monitor.processRealtimeQueue();
  assert.equal(transactionRequests, requestsAfterFailure + 1, "only one due processing attempt is made");
  snapshot = await monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[transactionHash]);

  cooling = false;
  current += 5_000;
  await monitor.processRealtimeQueue();
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimePendingEntries[transactionHash], undefined);
  assert.equal(snapshot._health.realtimeQueue.status, "healthy");
});

test("focus3 realtime recovery excludes ordinary BSC mints and unrelated launchpads at the RPC boundary", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-focus3-rpc-filter-"));
  let monitor;
  const logRequests = [];
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 103,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    officialSources: {
      flap: {
        // Production currently carries seven active vault factories in
        // addition to the static focus3 component catalog. Keep the live
        // 28-address shard shape under regression coverage here.
        featureActivations: Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
          const vaultFactory = `0xa${String(index + 1).padStart(39, "0")}`;
          return [`vault:TEST${index}:${vaultFactory}`, {
            type: "vault_factory",
            category: `TEST${index}`,
            vaultFactory,
            active: true,
            firstObservedAt: "2026-08-02T00:00:00.000Z",
            confirmedAt: "2026-08-02T00:00:00.000Z",
            replayCompletedAt: "2026-08-02T00:00:00.000Z",
          }];
        })),
      },
    },
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 105; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      logRequests.push(request);
      return [];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });

  await monitor.start();
  await waitUntil(async () => (await monitor.getState()).realtimeTailNextBlock === 104, 2_000);
  const tailRequests = logRequests.filter((request) => request.fromBlock === "0x65" && request.toBlock === "0x67");
  const launchRequests = tailRequests.filter((request) => !request.address);
  const upgradeRequests = tailRequests.filter((request) => Array.isArray(request.address));
  assert.equal(launchRequests.length, 1, "focus3 needs one global unique-creation query and no global mint query");
  assert.ok(upgradeRequests.length >= 1, "official upgrades must use exact address shards");
  const topics = launchRequests[0].topics[0];
  assert.ok(topics.includes(FLAP_TOKEN_CREATED_TOPIC));
  assert.ok(topics.includes(FOUR_MEME_TOKEN_CREATE_TOPIC));
  assert.ok(topics.includes(OPENFOUR_TOKEN_CREATED_TOPIC));
  assert.equal(topics.includes(MOONSALE_TOKEN_CREATED_TOPIC), false);
  assert.equal(topics.includes(ONEVONE_TOURNAMENT_CREATED_TOPIC), false);
  assert.equal(topics.includes(BSC_PAIR_CREATED_TOPIC), false, "focus3 must not ingest every global V2 pool");
  assert.equal(topics.includes(PANCAKE_INFINITY_CL_INITIALIZE_TOPIC), false, "focus3 must not ingest every global Infinity pool");
  assert.ok(topics.length <= 10, "the realtime topic filter must remain compatible with the fallback RPC");
  const upgradeAddresses = upgradeRequests.flatMap((request) => request.address);
  assert.deepEqual(upgradeRequests.map((request) => request.address.length), [8, 8, 8, 4],
    "the 28 exact emitters remain four PublicNode-compatible shards");
  assert.equal(new Set(upgradeAddresses).size, 28);
  assert.ok(upgradeRequests.every((request) => BSC_UPGRADE_TOPICS.every((topic) => request.topics[0].includes(topic))));
  assert.ok(upgradeAddresses.includes("0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0"));
  assert.ok(upgradeAddresses.includes("0x90497450f2a706f1951b5bdda52b4e5d16f34c06"));
  assert.ok(upgradeAddresses.includes("0x5c952063c7fc8610ffdb798152d69f0b9550762b"));
  assert.ok(upgradeAddresses.includes("0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3"));
  assert.ok(upgradeAddresses.every((address) => /^0x[0-9a-f]{40}$/.test(address)));
  assert.notDeepEqual(launchRequests[0].topics, [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC]);
});

test("focus3 realtime-tail starts cannot occur within the hard five-second floor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-hard-cadence-"));
  let monitor;
  let clock = Date.parse("2026-09-05T00:00:00.000Z");
  const head = 142;
  const requests = [];
  t.after(async () => {
    t.mock.timers.reset();
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-09-05T00:00:00.000Z",
    lastFinalizedBlock: 140,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-09-05T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [],
    coverageGaps: [],
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return head; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      requests.push({ clock, request: structuredClone(request) });
      return [];
    },
    destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRealtimeTailBatchSize: 20,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" }),
    now: () => clock,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });

  await monitor.start();
  const flushUntil = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await predicate()) return true;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
  };
  t.mock.timers.tick(25);
  assert.equal(await flushUntil(async () => (await monitor.getState()).realtimeTailNextBlock === 121), true,
    "the production scheduler starts the first due tail range");
  const firstRequestCount = requests.length;
  assert.ok(firstRequestCount > 0);

  const sameTick = await monitor.scanRealtimeTail();
  assert.equal(sameTick.reason, "paced");
  assert.equal(requests.length, firstRequestCount);
  clock += 4_999;
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, firstRequestCount, "T+4999ms cannot start another physical tail range");

  clock += 1;
  t.mock.timers.tick(1);
  assert.equal(await flushUntil(async () => (await monitor.getState()).realtimeTailNextBlock === 141), true,
    "the scheduler starts the next physical range exactly at T+5000ms");
  assert.ok(requests.length > firstRequestCount);
  assert.deepEqual([...new Set(requests.map((request) => request.clock))], [
    Date.parse("2026-09-05T00:00:00.000Z"),
    Date.parse("2026-09-05T00:00:05.000Z"),
  ]);
  assert.equal((await monitor.scanRealtimeTail()).reason, "paced",
    "even a caught-up continuation consumes the same start-to-start floor");
});

test("production focus3 defaults recover at least 600 near-head blocks in ten fake minutes while history progresses within the log-call budget", async (t) => {
  const startedAt = Date.parse("2026-09-05T01:00:00.000Z");
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: startedAt,
  });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-focus3-production-scheduler-"));
  let monitor;
  let activePhysicalLogs = 0;
  let activeLowLogs = 0;
  let maximumPhysicalLogs = 0;
  let maximumLowLogs = 0;
  let ethGetLogsCalls = 0;
  const tailStarts = [];
  const circuitRegistry = new Map();
  const rpcUrl = "https://bsc.blockrazor.xyz";
  const headAt = () => 10_002 + (Math.floor((Date.now() - startedAt) / 5_000) * 11);
  const providerFactory = (lane) => () => ({
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return headAt(); },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      ethGetLogsCalls += 1;
      activePhysicalLogs += 1;
      if (lane === "low") activeLowLogs += 1;
      maximumPhysicalLogs = Math.max(maximumPhysicalLogs, activePhysicalLogs);
      maximumLowLogs = Math.max(maximumLowLogs, activeLowLogs);
      if (lane === "tail" && !request.address) {
        tailStarts.push(Date.now());
      }
      try {
        await Promise.resolve();
        return [];
      } finally {
        activePhysicalLogs -= 1;
        if (lane === "low") activeLowLogs -= 1;
      }
    },
    async getBlock(blockNumber) { return { number: Number(blockNumber), transactions: [] }; },
    destroy() {},
  });
  const provider = createRpcPool([rpcUrl], [], 1, {
    hostCircuitRegistry: circuitRegistry,
    standardConcurrency: 4,
    allowPublicNodeLogs: false,
    providerFactory: providerFactory("low"),
  });
  const realtimeProvider = createRpcPool([rpcUrl], [], 1, {
    hostCircuitRegistry: circuitRegistry,
    standardConcurrency: 4,
    allowPublicNodeLogs: true,
    providerFactory: providerFactory("tail"),
  });
  t.after(async () => {
    t.mock.timers.reset();
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(startedAt).toISOString(),
    lastFinalizedBlock: 0,
    realtimeTailNextBlock: 10_001,
    realtimeTailInitializedAt: new Date(startedAt).toISOString(),
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:1000:9999",
      fromBlock: 1_000,
      toBlock: 9_999,
      nextBlock: 1_000,
      reason: "realtime_tail_stale_rebuild",
      detectedAt: new Date(startedAt).toISOString(),
      attempts: 0,
      nextAttemptAt: null,
    }],
    coverageGaps: [],
  }));
  class IdleWebSocket { addEventListener() {} close() {} }
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: rpcUrl,
    bscConfirmations: 2,
    bscRealtimeTailBatchSize: 20,
    bscRecoveryLogBatchSize: 10,
    bscHttpHeadPollIntervalMs: 5_000,
    bscOfficialPollIntervalMs: 1_000_000,
    bscDeferredRetryIntervalMs: 1_000_000,
  }, {
    autoStart: false,
    provider,
    realtimeProvider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: { get() { return null; } },
      text: async () => "forbidden",
    }),
    logger: { error() {}, info() {} },
    journalSetTimeoutImpl: () => ({ unref() {} }),
    journalClearTimeoutImpl() {},
  });

  const settleScheduler = async () => {
    let previousSignature = null;
    for (let turn = 0; turn < 1_000; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (activePhysicalLogs > 0 || activeLowLogs > 0) {
        previousSignature = null;
        continue;
      }
      const current = await monitor.getState();
      const pendingGap = current.nearHeadRecoveryGaps.find((item) => item.id === "realtime-tail-gap:1000:9999");
      const signature = JSON.stringify([
        current.realtimeTailNextBlock,
        current.lastFinalizedBlock,
        pendingGap?.nextBlock || null,
        current._health?.realtimeTail?.status || null,
      ]);
      if (signature === previousSignature) return;
      previousSignature = signature;
    }
    assert.fail("production scheduler did not settle before the next fake-clock tick");
  };
  await monitor.start();
  await settleScheduler();
  for (let elapsed = 1_000; elapsed <= 600_000; elapsed += 1_000) {
    t.mock.timers.tick(1_000);
    await settleScheduler();
  }
  let snapshot;
  for (let turn = 0; turn < 2_000; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    snapshot = await monitor.getState();
    const pendingGap = snapshot.nearHeadRecoveryGaps.find((item) => item.id === "realtime-tail-gap:1000:9999");
    const recovered = Number(pendingGap?.nextBlock || 10_000) - 1_000;
    const confirmedNow = headAt() - 2;
    const lagNow = Math.max(0, confirmedNow - Number(snapshot.realtimeTailNextBlock) + 1);
    if (recovered >= 600 && Number(snapshot.lastFinalizedBlock || 0) > 0 && lagNow === 0) break;
  }
  assert.ok(snapshot, "the fake-clock scheduler produced a durable state snapshot");
  const gap = snapshot.nearHeadRecoveryGaps.find((item) => item.id === "realtime-tail-gap:1000:9999");
  const nearRecovered = Number(gap?.nextBlock || 10_000) - 1_000;
  const historyRecovered = Number(snapshot.lastFinalizedBlock || 0);
  const confirmed = headAt() - 2;
  const tailLag = Math.max(0, confirmed - Number(snapshot.realtimeTailNextBlock) + 1);
  const uniqueTailStarts = [...new Set(tailStarts)];
  const minimumTailCadenceMs = uniqueTailStarts.length > 1
    ? Math.min(...uniqueTailStarts.slice(1).map((at, index) => at - uniqueTailStarts[index]))
    : null;
  assert.ok(nearRecovered >= 600, `near-head recovered only ${nearRecovered} blocks`);
  assert.ok(historyRecovered > 0, "bounded full-history work retains progress under the live-repair load");
  assert.ok(tailLag <= 20,
    `the production scheduler keeps the moving finalized tail within one bounded batch, observed ${tailLag}`);
  assert.ok(ethGetLogsCalls <= 1_080,
    `the worst-case four-shard ten-minute budget is bounded, observed ${ethGetLogsCalls}`);
  assert.ok(maximumLowLogs <= 1, `low filter concurrency stays serial, observed ${maximumLowLogs}`);
  assert.ok(maximumPhysicalLogs <= 2,
    `shared physical-host log concurrency stays bounded at two, observed ${maximumPhysicalLogs}`);
  assert.ok(minimumTailCadenceMs >= 5_000,
    `scheduled realtime-tail starts violated the five-second floor: ${minimumTailCadenceMs}`);
});

test("every addressless recovery log request is hard-bounded to ten blocks", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-unscoped-log-bound-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 130,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{ id: "realtime-tail-gap:90:114", fromBlock: 90, toBlock: 114, nextBlock: 90 }],
    coverageGaps: [],
  }));
  const requests = [];
  const provider = {
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      requests.push(structuredClone(request));
      return [];
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscNearHeadRecoveryBatchSize: 25,
    bscNearHeadRecoverySegmentSize: 100,
  }, {
    autoStart: false,
    provider,
    logger: { error() {}, info() {} },
  });
  t.after(() => monitor.stop());
  const result = await monitor.scanNearHeadRecovery();
  assert.equal(result.completed, true);
  const unscoped = requests.filter((request) => !request.address);
  assert.ok(unscoped.length >= 6, "both global mint and protocol filters are split across the 25-block range");
  assert.ok(unscoped.every((request) => Number.parseInt(request.toBlock, 16) - Number.parseInt(request.fromBlock, 16) + 1 <= 10));
  const perFilterRanges = new Map();
  for (const request of unscoped) {
    const key = JSON.stringify(request.topics);
    const ranges = perFilterRanges.get(key) || [];
    ranges.push([Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)]);
    perFilterRanges.set(key, ranges);
  }
  for (const ranges of perFilterRanges.values()) {
    assert.deepEqual(ranges, [[90, 99], [100, 109], [110, 114]], "bounded chunks exactly cover the configured range without gaps or overlap");
  }
});

test("one failed focus3 shard leaves the near-head cursor and candidate WAL uncommitted", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-shard-atomic-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const transactionHash = `0x${"71".repeat(32)}`;
  const token = "0x7111111111111111111111111111111111111111";
  const creator = "0x7222222222222222222222222222222222222222";
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1n, creator, 1n, token, "Atomic", "ATM", "ipfs://atomic"]);
  const creationLog = {
    address: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockNumber: "0x5a",
    transactionIndex: "0x1",
    logIndex: "0x2",
    removed: false,
  };
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-09-05T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:90:90",
      fromBlock: 90,
      toBlock: 90,
      nextBlock: 90,
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
    }],
    coverageGaps: [],
  }));
  let clock = 0;
  let failScopedShard = true;
  let receiptFallbackCalls = 0;
  let blockFallbackCalls = 0;
  const provider = {
    async send(method, [request]) {
      if (method === "eth_getBlockReceipts") {
        receiptFallbackCalls += 1;
        return [];
      }
      assert.equal(method, "eth_getLogs");
      if (!request.address) return [creationLog];
      if (failScopedShard) {
        const error = new Error("HTTP 429 on one exact upgrade shard");
        error.code = "SERVER_ERROR";
        error.status = 429;
        error.retryAfterMs = 60_000;
        error.rpcHostRetryAfterMs = 60_000;
        error.rpcOperation = method;
        error.rpcFailureScope = "host";
        throw error;
      }
      return [];
    },
    async getBlock() { blockFallbackCalls += 1; return { number: 90, transactions: [] }; },
    destroy() {},
  };
  const dependencies = {
    autoStart: false,
    provider,
    now: () => clock,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  let monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscNearHeadRecoveryBatchSize: 1 }, dependencies);
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(() => monitor.scanNearHeadRecovery(), /429/);
  let snapshot = await monitor.getState();
  assert.equal(snapshot.nearHeadRecoveryGaps[0].nextBlock, 90);
  assert.equal(snapshot.realtimePendingEntries[transactionHash], undefined);
  assert.equal(receiptFallbackCalls, 0, "focus3 never expands a partial filter result into receipt fallback");
  assert.equal(blockFallbackCalls, 0);
  let durable = await readBscLaunchpadDurableState(stateFile);
  assert.equal(durable.nearHeadRecoveryGaps[0].nextBlock, 90);
  assert.equal(durable.realtimePendingEntries[transactionHash], undefined);
  const failureFrames = (await fs.readFile(`${stateFile}.wal`, "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(failureFrames.some((frame) => frame.ops.some((operation) =>
    operation.path.join(".") === `realtimePendingEntries.${transactionHash}`)), false);

  await monitor.stop();
  failScopedShard = false;
  clock = 60_001;
  monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscNearHeadRecoveryBatchSize: 1 }, dependencies);
  assert.equal((await monitor.scanNearHeadRecovery()).completed, true);
  snapshot = await monitor.getState();
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, []);
  assert.ok(snapshot.realtimePendingEntries[transactionHash]);
  durable = await readBscLaunchpadDurableState(stateFile);
  assert.deepEqual(durable.nearHeadRecoveryGaps, []);
  assert.ok(durable.realtimePendingEntries[transactionHash]);
  const replayFrames = (await fs.readFile(`${stateFile}.wal`, "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(replayFrames.some((frame) => {
    const paths = frame.ops.map((operation) => operation.path.join("."));
    return paths.includes(`realtimePendingEntries.${transactionHash}`) && paths.includes("nearHeadRecoveryGaps");
  }), "the complete retry admits the candidate and deletes its gap in one WAL frame");
});

test("realtime tail durably advances before a candidate's deep analysis completes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-durable-pending-"));
  let monitor;
  let releaseTransaction;
  t.after(async () => {
    releaseTransaction?.();
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 103,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const token = "0x1111111111111111111111111111111111111111";
  const creator = "0x2222222222222222222222222222222222222222";
  const transactionHash = `0x${"3".repeat(64)}`;
  const creationInterface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = creationInterface.encodeEventLog(creationInterface.getEvent("TokenCreated"), [1n, creator, 1n, token, "First", "FIRST", "ipfs://first"]);
  const creationLog = {
    address: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockNumber: "0x65",
    transactionIndex: "0x1",
    logIndex: "0x1",
    removed: false,
  };
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 105; },
    async getTransaction() {
      return new Promise((resolve) => {
        releaseTransaction = () => resolve(null);
      });
    },
    async getTransactionReceipt() { return { status: 1, blockNumber: 101, logs: [creationLog] }; },
    async send(method) {
      assert.equal(method, "eth_getLogs");
      return [creationLog];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    realtimeTailMinIntervalMsForTesting: 0,
    logger: { error() {}, info() {} },
  });

  await monitor.start();
  await waitUntil(() => typeof releaseTransaction === "function", 2_000);
  const snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 104, "the exact covered range should commit while analysis is still in flight");
  assert.ok(snapshot.realtimePendingEntries[transactionHash], "the candidate must be durable before the cursor advances");
  assert.equal(snapshot.realtimePendingEntries[transactionHash].transactionIndex, 1);
  assert.equal(snapshot.realtimePendingEntries[transactionHash].logIndex, 1);
  assert.equal(snapshot.seenTransactions[transactionHash], undefined);
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  assert.equal(durable.realtimeTailNextBlock, 104);
  assert.ok(durable.realtimePendingEntries[transactionHash]);
  assert.equal(durable.realtimePendingEntries[transactionHash].transactionIndex, 1);
  assert.equal(durable.realtimePendingEntries[transactionHash].logIndex, 1);
  const walFrames = (await fs.readFile(path.join(dataDir, "bsc-launchpad-state.json.wal"), "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(walFrames.some((frame) => {
    const paths = frame.ops.map((operation) => operation.path.join("."));
    return paths.includes("realtimeTailNextBlock")
      && paths.some((value) => value === `realtimePendingEntries.${transactionHash}`);
  }), "tail cursor and its pending candidate must share one checksummed WAL frame");
  releaseTransaction();
});

test("focus3 background deep RPC prioritizes delivery deadlines and fairly drains both old lanes through a permanent gap", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-deep-rpc-arbitration-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let clock = Date.parse("2026-08-24T12:00:00.000Z");
  const head = 5_000;
  const blockByHash = new Map();
  const record = (id, blockNumber, extra = {}) => {
    const transactionHash = `0x${id.toString(16).padStart(64, "0")}`;
    blockByHash.set(transactionHash, blockNumber);
    return [transactionHash, {
      transactionHash,
      blockNumber,
      transactionIndex: id,
      logIndex: 0,
      reasons: ["http_tail"],
      mintEmitters: [],
      candidateTokens: [],
      verifiedNewContracts: [],
      // A real inspection trigger is required; otherwise the queue entry is
      // correctly marked seen before transaction/receipt RPCs are attempted.
      upgradeEmitters: ["0x1111111111111111111111111111111111111111"],
      lifecycleEmitters: [],
      hookPools: [],
      hasProtocolTrigger: false,
      revision: 1,
      ...extra,
    }];
  };
  const queueUrgent = record(1, 100, {
    deliverySla: {
      startedAt: new Date(clock - 1_000).toISOString(),
      deadlineAt: new Date(clock + 2_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "bsc_websocket_ingest",
    },
  });
  const deferredUrgent = record(2, 101, {
    deliverySla: {
      startedAt: new Date(clock - 1_000).toISOString(),
      deadlineAt: new Date(clock + 1_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "bsc_websocket_ingest",
    },
    attempts: 1,
    firstDeferredAt: new Date(clock - 1_000).toISOString(),
    nextAttemptAt: new Date(clock - 1).toISOString(),
  });
  const oldQueue = record(3, 102);
  const oldDeferred = record(4, 103, {
    attempts: 1,
    firstDeferredAt: new Date(clock - 20 * 60_000).toISOString(),
    nextAttemptAt: new Date(clock - 1).toISOString(),
  });
  const normalQueue = Array.from({ length: 50 }, (_, index) => record(100 + index, 3_000 + index));
  const normalDeferred = Array.from({ length: 50 }, (_, index) => record(200 + index, 3_100 + index, {
    attempts: 1,
    firstDeferredAt: new Date(clock - 1_000).toISOString(),
    nextAttemptAt: new Date(clock - 1).toISOString(),
  }));
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60_000).toISOString(),
    lastFinalizedBlock: head - 2,
    realtimeTailNextBlock: head - 1,
    realtimeTailInitializedAt: new Date(clock - 60_000).toISOString(),
    realtimePendingEntries: Object.fromEntries([queueUrgent, oldQueue, ...normalQueue]),
    deferredCreationEvidence: Object.fromEntries([deferredUrgent, oldDeferred, ...normalDeferred]),
    nearHeadRecoveryGaps: [{
      id: "permanent-gap",
      fromBlock: 200,
      toBlock: 200,
      nextBlock: 200,
      reason: "realtime_tail_stale_rebuild",
      attempts: 1,
      nextAttemptAt: new Date(clock + 60_000).toISOString(),
    }],
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    _health: { realtimeTail: { status: "healthy", consecutiveFailures: 0 } },
  }));

  const deepOrder = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return head; },
    async getTransaction(hash) {
      deepOrder.push(hash);
      return { hash, blockNumber: blockByHash.get(hash), to: null, from: `0x${"9".repeat(40)}`, data: "0x" };
    },
    async getTransactionReceipt(hash) {
      return { hash, transactionHash: hash, blockNumber: blockByHash.get(hash), status: 1, logs: [] };
    },
    async send() { return []; },
    destroy() {},
  };
  const backgroundTimers = [];
  const backgroundSetTimeoutImpl = (callback, delay) => {
    const timer = { callback, delay, dueAt: clock + delay, cancelled: false, unref() {} };
    backgroundTimers.push(timer);
    return timer;
  };
  const backgroundClearTimeoutImpl = (timer) => { timer.cancelled = true; };
  class IdleWebSocket { addEventListener() {} close() {} }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
  }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    realtimeTailMinIntervalMsForTesting: 0,
    backgroundSetTimeoutImpl,
    backgroundClearTimeoutImpl,
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await completeRealtimeTailPasses(monitor, 2, 5_000);

  for (let slot = 0; slot < 44; slot += 1) {
    const before = deepOrder.length;
    await monitor.processRealtimeQueue();
    await monitor.retryDeferredCreationEvidence();
    assert.ok(deepOrder.length <= before + 1, "the shared deep lease starts at most one transaction per slot");
    clock += 750;
  }

  assert.deepEqual(deepOrder.slice(0, 2), [deferredUrgent[0], queueUrgent[0]],
    "deadline-bound durable work outranks hundreds of normal fresh entries across both lanes");
  const queueOldIndex = deepOrder.indexOf(oldQueue[0]);
  const deferredOldIndex = deepOrder.indexOf(oldDeferred[0]);
  assert.ok(queueOldIndex >= 2 && queueOldIndex <= 3, "fresh receives the first slot, then the first due old lane progresses");
  assert.ok(deferredOldIndex > queueOldIndex && deferredOldIndex <= 43,
    "the old-specific lane cursor reaches deferred work at the next 30-second quota despite forty fresh completions");
});

test("focus3 background deep RPC preserves feature and first-three causal order across queue classes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-deep-rpc-causal-order-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let clock = Date.parse("2026-08-24T13:00:00.000Z");
  const head = 5_000;
  const sharedLiteralKey = "same-literal-different-causal-namespaces";
  const blockByHash = new Map();
  const record = (id, blockNumber, extra = {}) => {
    const transactionHash = `0x${id.toString(16).padStart(64, "0")}`;
    blockByHash.set(transactionHash, blockNumber);
    return [transactionHash, {
      transactionHash,
      blockNumber,
      transactionIndex: id,
      logIndex: 0,
      reasons: ["http_tail"],
      mintEmitters: [],
      candidateTokens: [],
      verifiedNewContracts: [],
      upgradeEmitters: ["0x1111111111111111111111111111111111111111"],
      lifecycleEmitters: [],
      hookPools: [],
      hasProtocolTrigger: true,
      revision: 1,
      ...extra,
    }];
  };
  const featureOlderQueue = record(11, 100, { featureActivationReplayKey: sharedLiteralKey });
  const featureLaterDeferred = record(12, 3_000, {
    featureActivationReplayKey: sharedLiteralKey,
    deliverySla: {
      startedAt: new Date(clock - 1_000).toISOString(),
      deadlineAt: new Date(clock + 4_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "bsc_websocket_ingest",
    },
    attempts: 1,
    firstDeferredAt: new Date(clock - 1_000).toISOString(),
    nextAttemptAt: new Date(clock - 1).toISOString(),
  });
  const firstThreeOlderDeferred = record(13, 101, {
    flapQuoteFirstThreeReplayGenerationKey: sharedLiteralKey,
    attempts: 1,
    firstDeferredAt: new Date(clock - 20 * 60_000).toISOString(),
    nextAttemptAt: new Date(clock + 15_000).toISOString(),
  });
  const firstThreeLaterQueue = record(14, 3_001, {
    flapQuoteFirstThreeReplayGenerationKey: sharedLiteralKey,
    deliverySla: {
      startedAt: new Date(clock - 1_000).toISOString(),
      deadlineAt: new Date(clock + 4_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "bsc_websocket_ingest",
    },
  });
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60_000).toISOString(),
    lastFinalizedBlock: head - 2,
    realtimeTailNextBlock: head - 1,
    realtimeTailInitializedAt: new Date(clock - 60_000).toISOString(),
    realtimePendingEntries: Object.fromEntries([featureOlderQueue, firstThreeLaterQueue]),
    deferredCreationEvidence: Object.fromEntries([featureLaterDeferred, firstThreeOlderDeferred]),
    nearHeadRecoveryGaps: [],
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    _health: { realtimeTail: { status: "healthy", consecutiveFailures: 0 } },
  }));
  const deepOrder = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return head; },
    async getTransaction(hash) {
      deepOrder.push(hash);
      return { hash, blockNumber: blockByHash.get(hash), to: null, from: `0x${"9".repeat(40)}`, data: "0x" };
    },
    async getTransactionReceipt(hash) {
      return { hash, transactionHash: hash, blockNumber: blockByHash.get(hash), status: 1, logs: [] };
    },
    async send() { return []; },
    destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
  }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    realtimeTailMinIntervalMsForTesting: 0,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await completeRealtimeTailPasses(monitor, 2, 5_000);
  const normalized = await monitor.getState();
  assert.ok(normalized.deferredCreationEvidence[featureLaterDeferred[0]].deliverySla);
  assert.ok(normalized.realtimePendingEntries[firstThreeLaterQueue[0]].deliverySla);
  for (let slot = 0; slot < 16 && deepOrder.length < 4; slot += 1) {
    await monitor.processRealtimeQueue();
    await monitor.retryDeferredCreationEvidence();
    if (slot === 0) assert.deepEqual(deepOrder, [featureOlderQueue[0]],
      "the later feature SLA makes zero deep calls until its causal head completes");
    clock += 750;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const causalSnapshot = await monitor.getState();
  assert.deepEqual(deepOrder, [
    featureOlderQueue[0],
    featureLaterDeferred[0],
    firstThreeOlderDeferred[0],
    firstThreeLaterQueue[0],
  ], `later SLA work never overtakes its own group head, while equal literal keys in separate namespaces remain independent: ${JSON.stringify({
    pending: causalSnapshot.realtimePendingEntries,
    deferred: causalSnapshot.deferredCreationEvidence,
    failures: causalSnapshot.transactionFailures,
    health: causalSnapshot._health,
  })}`);
});

test("focus3 mixed archive 429 and method failure share one durable deep RPC gate across both lanes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-deep-rpc-host-cooldown-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let clock = Date.parse("2026-08-24T14:00:00.000Z");
  const head = 1_000;
  const queueHash = `0x${"51".repeat(32)}`;
  const deferredHash = `0x${"52".repeat(32)}`;
  const trigger = "0x8b4329947e34b6d56d71a3385cac122bade7d78d";
  const implementation = "0x1111111111111111111111111111111111111111";
  const baseRecord = (transactionHash, blockNumber) => ({
    transactionHash,
    blockNumber,
    transactionIndex: 1,
    logIndex: 0,
    reasons: ["http_tail"],
    mintEmitters: [],
    candidateTokens: [],
    verifiedNewContracts: [],
    upgradeEmitters: [trigger],
    lifecycleEmitters: [],
    hookPools: [],
    hasProtocolTrigger: true,
    revision: 1,
  });
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60_000).toISOString(),
    lastFinalizedBlock: head - 2,
    realtimeTailNextBlock: head - 1,
    realtimeTailInitializedAt: new Date(clock - 60_000).toISOString(),
    realtimePendingEntries: { [queueHash]: baseRecord(queueHash, 900) },
    deferredCreationEvidence: {
      [deferredHash]: {
        ...baseRecord(deferredHash, 901),
        attempts: 2,
        firstDeferredAt: new Date(clock - 30_000).toISOString(),
        nextAttemptAt: new Date(clock - 1).toISOString(),
      },
    },
    nearHeadRecoveryGaps: [],
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    _health: { realtimeTail: { status: "healthy", consecutiveFailures: 0 } },
  }));
  let mixedFailure = true;
  const deepCalls = [];
  const codeCalls = [];
  const provider = createRpcPool(
    ["https://mixed-monitor-standard.test"],
    ["https://mixed-monitor-archive.test"],
    1,
    {
      now: () => clock,
      requestTimeoutMs: 1_000,
      hostCircuitRegistry: new Map(),
      providerFactory: (_url, context) => ({
        async getNetwork() { return { chainId: 56n }; },
        async getBlockNumber() { return head; },
        async getTransaction(hash) {
          deepCalls.push(hash);
          const blockNumber = hash === queueHash ? 900 : 901;
          return { hash, blockNumber, blockHash: `0x${String(blockNumber).padStart(64, "0")}`, index: 1, transactionIndex: 1, to: trigger, from: `0x${"9".repeat(40)}`, data: "0x" };
        },
        async getTransactionReceipt(hash) {
          const blockNumber = hash === queueHash ? 900 : 901;
          const blockHash = `0x${String(blockNumber).padStart(64, "0")}`;
          return {
            hash,
            transactionHash: hash,
            blockNumber,
            blockHash,
            status: 1,
            index: 1,
            transactionIndex: 1,
            logs: [{
              address: trigger,
              transactionHash: hash,
              blockNumber,
              blockHash,
              transactionIndex: 1,
              logIndex: 0,
              removed: false,
              topics: [BSC_UPGRADED_TOPIC, `0x${"0".repeat(24)}${implementation.slice(2)}`],
              data: "0x",
            }],
          };
        },
        async getBlock(blockNumber) {
          const numeric = Number(blockNumber);
          return {
            number: numeric,
            hash: `0x${String(numeric).padStart(64, "0")}`,
            timestamp: Math.floor(clock / 1_000),
            transactions: [`0x${"0".repeat(64)}`, numeric === 900 ? queueHash : deferredHash],
          };
        },
        async getCode() {
          codeCalls.push(context.kind);
          if (!mixedFailure) return "0x6000";
          if (context.kind === "archive") {
            const error = new Error("HTTP 429 archive host rate limited");
            error.status = 429;
            error.retryAfterMs = 12_000;
            throw error;
          }
          throw new Error("getCode timed out after 1000ms");
        },
        async getStorage() { return "0x"; },
        async call() { return "0x"; },
        async send() { return []; },
      }),
    },
  );
  const timers = [];
  const backgroundSetTimeoutImpl = (callback, delay) => {
    const timer = { callback, delay, dueAt: clock + delay, cancelled: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  const backgroundClearTimeoutImpl = (timer) => { timer.cancelled = true; };
  class IdleWebSocket { addEventListener() {} close() {} }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const makeMonitor = () => createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 2_000,
  }, {
    autoStart: false,
    externalAttribution: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    realtimeTailMinIntervalMsForTesting: 0,
    backgroundSetTimeoutImpl,
    backgroundClearTimeoutImpl,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async () => ({ status: "delivered" }),
    ...disabledJournalTimerDependencies(),
  });
  let monitor = makeMonitor();
  t.after(async () => {
    await monitor?.stop();
    provider.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await completeRealtimeTailPasses(monitor, 2, 5_000);
  await monitor.processRealtimeQueue();
  assert.deepEqual(deepCalls, [queueHash]);
  assert.deepEqual(codeCalls, ["archive", "standard"],
    "the official-upgrade wrapper observes one archive 429 plus one standard method failure");
  let snapshot = await monitor.getState();
  const retryAt = Date.parse(snapshot._health.backgroundDeepRpc.nextRetryAt);
  assert.equal(snapshot._health.backgroundDeepRpc.rpcFailureScope, "host");
  assert.equal(snapshot.transactionFailures[queueHash], undefined,
    "mixed host evidence is installed before a candidate attempt is charged");
  assert.equal(snapshot.deferredCreationEvidence[deferredHash].attempts, 2);
  clock += 500;
  await monitor.retryDeferredCreationEvidence();
  await monitor.processRealtimeQueue();
  snapshot = await monitor.getState();
  assert.deepEqual(deepCalls, [queueHash], "neither lane makes a physical call during the shared host cooldown");
  assert.deepEqual(codeCalls, ["archive", "standard"]);
  assert.equal(snapshot.transactionFailures[queueHash], undefined);
  assert.equal(snapshot.deferredCreationEvidence[deferredHash].attempts, 2,
    "a host outage is not charged as a candidate-specific deferred failure");

  await monitor.stop();
  monitor = makeMonitor();
  await monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await completeRealtimeTailPasses(monitor, 2, 5_000);
  await monitor.processRealtimeQueue();
  await monitor.retryDeferredCreationEvidence();
  assert.deepEqual(deepCalls, [queueHash], "the persisted host gate remains closed after restart");
  assert.deepEqual(codeCalls, ["archive", "standard"]);
  snapshot = await monitor.getState();
  assert.equal(snapshot.transactionFailures[queueHash], undefined);
  assert.equal(snapshot.deferredCreationEvidence[deferredHash].attempts, 2);
  mixedFailure = false;
  clock = retryAt + 1;
  for (const timer of timers.filter((item) => !item.cancelled && item.dueAt <= clock)) {
    timer.cancelled = true;
    timer.callback();
  }
  await waitUntil(async () => deepCalls.length >= 2
    && (await monitor.getState())._health.backgroundDeepRpc.status === "healthy", 5_000);
  assert.equal(deepCalls[1], queueHash, "the retry timer wakes the realtime lane without waiting for the 60s head poll");
  snapshot = await monitor.getState();
  assert.equal(snapshot._health.backgroundDeepRpc.status, "healthy");
  assert.equal(snapshot._health.backgroundDeepRpc.nextRetryAt, null);
  clock += 750;
  await monitor.retryDeferredCreationEvidence();
  assert.deepEqual(deepCalls, [queueHash, queueHash, deferredHash]);
  snapshot = await monitor.getState();
  assert.equal(snapshot.deferredCreationEvidence[deferredHash], undefined);
});

test("near-head recovery commits every candidate and its gap cursor in one WAL revision", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-wal-handoff-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const transactionHash = `0x${"31".repeat(32)}`;
  const launcher = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const token = "0x3111111111111111111111111111111111111111";
  const creator = "0x3222222222222222222222222222222222222222";
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1n, creator, 1n, token, "WAL", "WAL", "ipfs://wal"]);
  const creationLog = {
    address: launcher,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockNumber: "0x5a",
    transactionIndex: "0x1",
    logIndex: "0x2",
    removed: false,
  };
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:90:90",
      fromBlock: 90,
      toBlock: 90,
      nextBlock: 90,
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
    }],
    coverageGaps: [],
  }));
  let deepReads = 0;
  let releaseDeepRead;
  const deepReadGate = new Promise((resolve) => { releaseDeepRead = resolve; });
  const provider = {
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) && request.topics[0].includes(FLAP_TOKEN_CREATED_TOPIC)
        ? [creationLog]
        : [];
    },
    async getTransaction() {
      deepReads += 1;
      await deepReadGate;
      return null;
    },
    destroy() {},
  };
  const dependencies = {
    autoStart: false,
    provider,
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  const first = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscNearHeadRecoveryBatchSize: 1 }, dependencies);
  let restarted;
  t.after(async () => {
    releaseDeepRead();
    await Promise.allSettled([first.stop(), restarted?.stop()]);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const result = await first.scanNearHeadRecovery();
  assert.equal(result.completed, true);
  assert.ok(deepReads <= 1, "deep analysis may start only after the durable log-lane handoff returns");
  const snapshot = await first.getState();
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, []);
  assert.equal(snapshot.realtimePendingEntries[transactionHash].transactionIndex, 1);
  assert.equal(snapshot.realtimePendingEntries[transactionHash].logIndex, 2);
  const walFrames = (await fs.readFile(`${stateFile}.wal`, "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(walFrames.some((frame) => {
    const paths = frame.ops.map((operation) => operation.path.join("."));
    return paths.includes(`realtimePendingEntries.${transactionHash}`)
      && paths.includes("nearHeadRecoveryGaps");
  }), "candidate handoff and gap deletion must share one checksummed WAL frame");
  const laggingSnapshot = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(laggingSnapshot.realtimePendingEntries?.[transactionHash], undefined);
  assert.equal(laggingSnapshot.nearHeadRecoveryGaps?.[0]?.nextBlock, 90,
    "after WAL fsync and before snapshot compaction, the JSON snapshot may still hold the old cursor");

  restarted = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3" }, dependencies);
  const durable = await restarted.getState();
  assert.deepEqual(durable.nearHeadRecoveryGaps, []);
  assert.ok(durable.realtimePendingEntries[transactionHash], "restart restores the complete candidate whenever it observes the advanced cursor");
});

test("near-head handoff replaces a deferred transaction's orphaned fork coordinates and survives restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-canonical-reinclude-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const transactionHash = `0x${"39".repeat(32)}`;
  const oldBlockHash = `0x${"3a".repeat(32)}`;
  const newBlockHash = `0x${"3b".repeat(32)}`;
  const launcher = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const token = "0x3c11111111111111111111111111111111111111";
  const creator = "0x3d22222222222222222222222222222222222222";
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1n, creator, 1n, token, "Canonical", "NEW", "ipfs://canonical"]);
  const canonicalLog = {
    address: launcher,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockHash: newBlockHash,
    blockNumber: "0x5b",
    transactionIndex: "0x1",
    logIndex: "0x2",
    removed: false,
  };
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    realtimePendingEntries: {},
    deferredCreationEvidence: {
      [transactionHash]: {
        transactionHash,
        blockHash: oldBlockHash,
        blockNumber: 90,
        transactionIndex: 5,
        logIndex: 8,
        reasons: ["http_tail"],
        mintEmitters: [],
        candidateTokens: [],
        verifiedNewContracts: [],
        upgradeEmitters: [],
        lifecycleEmitters: [],
        hookPools: [],
        hasProtocolTrigger: true,
        featureActivationReplayKey: null,
        flapQuoteFirstThreeReplayGenerationKey: null,
        causalBarrierKeys: [],
        flapCreationHotCandidates: [],
        fourMemeCreationHotCandidates: [],
        revision: 1,
        deferredKind: "coverage_processing",
        attempts: 1,
        firstDeferredAt: "2026-08-24T09:59:00.000Z",
        lastAttemptAt: "2026-08-24T10:00:00.000Z",
        nextAttemptAt: "2099-01-01T00:00:00.000Z",
        lastError: "old fork",
      },
    },
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:91:91",
      fromBlock: 91,
      toBlock: 91,
      nextBlock: 91,
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
    }],
    coverageGaps: [],
  }));
  const provider = {
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) && request.topics[0].includes(FLAP_TOKEN_CREATED_TOPIC)
        ? [canonicalLog]
        : [];
    },
    destroy() {},
  };
  const inertTimer = () => ({ unref() {} });
  const dependencies = {
    autoStart: false,
    provider,
    backgroundSetTimeoutImpl: inertTimer,
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  let monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscNearHeadRecoveryBatchSize: 1 }, dependencies);
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  assert.equal((await monitor.scanNearHeadRecovery()).completed, true);
  let snapshot = await monitor.getState();
  let record = snapshot.deferredCreationEvidence[transactionHash];
  assert.equal(record.blockNumber, 91);
  assert.equal(record.blockHash, newBlockHash);
  assert.equal(record.transactionIndex, 1);
  assert.equal(record.logIndex, 2);
  assert.equal(record.flapCreationHotCandidates.length, 1);
  assert.equal(record.flapCreationHotCandidates[0].blockHash, newBlockHash,
    "the new canonical raw proof replaces the same transaction's orphaned fork proof");
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, []);

  await monitor.stop();
  monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3" }, dependencies);
  snapshot = await monitor.getState();
  record = snapshot.deferredCreationEvidence[transactionHash];
  assert.deepEqual(
    [record.blockNumber, record.blockHash, record.transactionIndex, record.logIndex],
    [91, newBlockHash, 1, 2],
  );
  assert.equal(record.flapCreationHotCandidates[0].blockHash, newBlockHash);
});

test("a durable near-head candidate registered after restart bypasses the warmed ordinary fast exit for its Flap activation", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-late-flap-activation-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let clock = Date.parse("2026-08-24T12:00:00.000Z");
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const vaultFactory = "0xfab75dc774cb9b38b91749b8833360b46a52345f";
  const vault = "0x4111111111111111111111111111111111111111";
  const creator = "0x4222222222222222222222222222222222222222";
  const warmToken = "0x4333333333333333333333333333333333333333";
  const targetToken = "0x4444444444444444444444444444444444444444";
  const warmTransactionHash = `0x${"41".repeat(32)}`;
  const targetTransactionHash = `0x${"42".repeat(32)}`;
  const warmBlockHash = `0x${"43".repeat(32)}`;
  const targetBlockHash = `0x${"44".repeat(32)}`;
  const vaultInterface = new Interface([
    "event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)",
  ]);
  const makeLog = (token, transactionHash, blockNumber, blockHash) => {
    const encoded = vaultInterface.encodeEventLog(
      vaultInterface.getEvent("FlapTaxVaultTokenCreated"),
      [token, vault, vaultFactory],
    );
    return {
      address: launcher,
      topics: encoded.topics,
      data: encoded.data,
      transactionHash,
      blockHash,
      blockNumber,
      transactionIndex: 1,
      logIndex: 2,
      removed: false,
    };
  };
  const warmLog = makeLog(warmToken, warmTransactionHash, 80, warmBlockHash);
  const targetLog = makeLog(targetToken, targetTransactionHash, 90, targetBlockHash);
  const transactions = new Map([
    [warmTransactionHash, {
      hash: warmTransactionHash,
      blockNumber: 80,
      blockHash: warmBlockHash,
      transactionIndex: 1,
      to: launcher,
      from: creator,
      data: `0x8cb5772c${"00".repeat(32)}`,
    }],
    [targetTransactionHash, {
      hash: targetTransactionHash,
      blockNumber: 90,
      blockHash: targetBlockHash,
      transactionIndex: 1,
      to: launcher,
      from: creator,
      data: `0x8cb5772c${"00".repeat(32)}`,
    }],
  ]);
  const receipts = new Map([
    [warmTransactionHash, {
      hash: warmTransactionHash,
      transactionHash: warmTransactionHash,
      blockNumber: 80,
      blockHash: warmBlockHash,
      index: 1,
      transactionIndex: 1,
      status: 1,
      logs: [warmLog],
    }],
    [targetTransactionHash, {
      hash: targetTransactionHash,
      transactionHash: targetTransactionHash,
      blockNumber: 90,
      blockHash: targetBlockHash,
      index: 1,
      transactionIndex: 1,
      status: 1,
      logs: [targetLog],
    }],
  ]);
  const blocks = new Map([
    [80, { number: 80, hash: warmBlockHash, timestamp: Math.floor((clock - 20 * 60_000) / 1_000), transactions: [`0x${"40".repeat(32)}`, warmTransactionHash] }],
    [90, { number: 90, hash: targetBlockHash, timestamp: Math.floor(clock / 1_000), transactions: [`0x${"50".repeat(32)}`, targetTransactionHash] }],
  ]);
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: new Date(clock - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 79,
    realtimeTailNextBlock: 89,
    realtimeTailInitializedAt: new Date(clock - 60 * 60_000).toISOString(),
    realtimePendingEntries: {
      [warmTransactionHash]: {
        transactionHash: warmTransactionHash,
        blockNumber: 80,
        transactionIndex: 1,
        logIndex: 2,
        reasons: ["near_head_gap_recovery"],
        mintEmitters: [],
        candidateTokens: [warmToken],
        verifiedNewContracts: [warmToken],
        upgradeEmitters: [],
        lifecycleEmitters: [],
        hookPools: [],
        hasProtocolTrigger: true,
        observedAt: new Date(clock - 20 * 60_000).toISOString(),
      },
    },
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:90:90",
      fromBlock: 90,
      toBlock: 90,
      nextBlock: 90,
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
    }],
    coverageGaps: [],
  }));
  let head = 88;
  let recoveryLogsVisible = true;
  const controllerCode = `0x${"60".repeat(700)}`;
  const tokenCode = "0x6001600055";
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return head; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return recoveryLogsVisible
        && Array.isArray(request.topics?.[0])
        && request.topics[0].includes(FLAP_VAULT_TOKEN_CREATED_TOPIC)
        ? [{ ...targetLog, blockNumber: "0x5a", transactionIndex: "0x1", logIndex: "0x2" }]
        : [];
    },
    async getTransaction(hash) { return transactions.get(hash) || null; },
    async getTransactionReceipt(hash) { return receipts.get(hash) || null; },
    async getBlock(number) { return blocks.get(Number(number)) || { number: Number(number), hash: `0x${"45".repeat(32)}`, timestamp: Math.floor(clock / 1_000), transactions: [] }; },
    async getCode(address) {
      const normalized = String(address).toLowerCase();
      if (normalized === launcher) return controllerCode;
      if ([warmToken, targetToken].includes(normalized)) return tokenCode;
      return "0x6000";
    },
    async getStorage() { return "0x"; },
    async call() { throw new Error("optional view unavailable"); },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const alerts = [];
  const dependencies = {
    autoStart: false,
    externalAttribution: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    realtimeTailMinIntervalMsForTesting: 0,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(structuredClone(event));
      return { status: "delivered", eventId: event.eventKey };
    },
    ...disabledJournalTimerDependencies(),
  };
  const config = {
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscNearHeadRecoveryBatchSize: 1,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  };
  let first = createBscLaunchpadMonitor(config, dependencies);
  let restarted;
  t.after(async () => {
    await Promise.allSettled([first?.stop(), restarted?.stop()]);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const handoff = await first.scanNearHeadRecovery();
  assert.equal(handoff.completed, true);
  let snapshot = await first.getState();
  assert.ok(snapshot.realtimePendingEntries[targetTransactionHash], "the future feature candidate is durable before registration");
  assert.ok(snapshot.realtimePendingEntries[warmTransactionHash], "the process-local identity warmup remains queued across the handoff");
  await first.stop();

  recoveryLogsVisible = false;
  restarted = createBscLaunchpadMonitor(config, dependencies);
  await restarted.getState();
  await restarted.processRealtimeQueue();
  snapshot = await restarted.getState();
  assert.equal(snapshot.seenTransactions[warmTransactionHash], 80, "restart fully profiles one ordinary token before enabling the shortcut");
  assert.ok(snapshot.realtimePendingEntries[targetTransactionHash], "the not-yet-confirmed activation candidate stays pending");
  assert.equal(alerts.length, 0, "the ordinary warm profile stays silent");

  assert.equal(await restarted.registerFlapFeatureActivations([{
    pool: {
      identity: `vault:SPLIT:${vaultFactory}`,
      category: "SPLIT",
      vaultFactory,
      sourceUrl: "https://flap.sh/board",
    },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(clock - 30_000).toISOString(),
    confirmedAt: new Date(clock - 10_000).toISOString(),
    observedAt: new Date(clock - 10_000).toISOString(),
  }]), 1);
  head = 92;
  clock += 751;
  await restarted.start();
  // start() also schedules a tail pass. Count two completed explicit scans,
  // rather than sleeps or calls, so a concurrent `skipped: running` result
  // cannot masquerade as either healthy observation.
  let completedTailScans = 0;
  for (let pass = 0; pass < 100 && completedTailScans < 2; pass += 1) {
    const tail = await restarted.scanRealtimeTail();
    if (tail?.skipped === false) completedTailScans += 1;
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(completedTailScans, 2);
  for (let turn = 0; turn < 4 && alerts.length === 0; turn += 1) {
    await restarted.replayFlapFeatureActivations();
    await restarted.processRealtimeQueue();
    clock += 751;
  }
  await waitUntil(() => alerts.length === 1, 3_000);
  await restarted.awaitIdle();
  snapshot = await restarted.getState();
  assert.equal(alerts.length, 1, `the late activation must emit its first token exactly once: ${JSON.stringify({
    pending: snapshot.realtimePendingEntries[targetTransactionHash],
    deferred: snapshot.deferredCreationEvidence[targetTransactionHash],
    failure: snapshot.transactionFailures[targetTransactionHash],
    activation: Object.values(snapshot.officialSources.flap.featureActivations || {})[0],
    tail: snapshot._health?.realtimeTail,
    realtime: snapshot._health?.realtimeQueue,
    deep: snapshot._health?.backgroundDeepRpc,
  })}`);
  assert.equal(alerts[0].transactionHash, targetTransactionHash);
  assert.equal(alerts[0].tokens[0].token.toLowerCase(), targetToken);
  assert.equal(alerts[0].featureFirstToken, true);
  assert.equal(alerts[0].featurePlatform, "flap");
  assert.equal(alerts[0].structural.fastPath, "known_official_mode", "the activation survives the warmed ordinary fast path");
  assert.equal(snapshot.realtimePendingEntries[targetTransactionHash], undefined);
  const activation = Object.values(snapshot.officialSources.flap.featureActivations)[0];
  assert.equal(activation.firstTokenTransactionHash, targetTransactionHash);
  await restarted.processRealtimeQueue();
  assert.equal(alerts.length, 1);
});

test("near-head handoff replays its whole range after a pre-append WAL failure", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-wal-preappend-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  const transactionHash = `0x${"33".repeat(32)}`;
  const launcher = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const token = "0x3311111111111111111111111111111111111111";
  const creator = "0x3322222222222222222222222222222222222222";
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1n, creator, 1n, token, "Preappend", "PRE", "ipfs://preappend"]);
  const creationLog = {
    address: launcher,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockNumber: "0x5a",
    transactionIndex: "0x1",
    logIndex: "0x2",
    removed: false,
  };
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:90:90",
      fromBlock: 90,
      toBlock: 90,
      nextBlock: 90,
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
    }],
    coverageGaps: [],
  }));
  let failWalAppendOpen = false;
  let rejectedAppendOpens = 0;
  const journalFsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (file, flags, mode) => {
        if (String(file) === walFile && flags === "a" && failWalAppendOpen) {
          rejectedAppendOpens += 1;
          const error = new Error("simulated near-head WAL failure before append");
          error.code = "EIO";
          throw error;
        }
        return fs.open(file, flags, mode);
      };
    },
  });
  let releaseDeepRead;
  const deepReadGate = new Promise((resolve) => { releaseDeepRead = resolve; });
  const provider = {
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) && request.topics[0].includes(FLAP_TOKEN_CREATED_TOPIC)
        ? [creationLog]
        : [];
    },
    async getTransaction() { await deepReadGate; return null; },
    destroy() {},
  };
  const baseDependencies = {
    autoStart: false,
    provider,
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  const failedMonitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscNearHeadRecoveryBatchSize: 1 }, {
    ...baseDependencies,
    journalFsImpl,
  });
  let restarted;
  t.after(async () => {
    releaseDeepRead();
    await Promise.allSettled([failedMonitor.stop(), restarted?.stop()]);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await failedMonitor.getState();
  failWalAppendOpen = true;
  await assert.rejects(
    () => failedMonitor.scanNearHeadRecovery(),
    /simulated near-head WAL failure before append/,
  );
  assert.ok(rejectedAppendOpens >= 1);
  const afterFailure = await readBscLaunchpadDurableState(stateFile);
  assert.equal(afterFailure.nearHeadRecoveryGaps[0].nextBlock, 90);
  assert.equal(afterFailure.realtimePendingEntries[transactionHash], undefined,
    "a candidate and cursor are both absent when their shared frame never appends");

  // Simulate the process dying with its mutated in-memory object. A clean
  // reader must start from the old durable range and hand it off once.
  await failedMonitor.stop();
  failWalAppendOpen = false;
  restarted = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscNearHeadRecoveryBatchSize: 1 }, baseDependencies);
  const beforeReplay = await restarted.getState();
  assert.equal(beforeReplay.nearHeadRecoveryGaps[0].nextBlock, 90);
  assert.equal(beforeReplay.realtimePendingEntries[transactionHash], undefined);
  const replay = await restarted.scanNearHeadRecovery();
  assert.equal(replay.completed, true);
  const afterReplay = await restarted.getState();
  assert.deepEqual(afterReplay.nearHeadRecoveryGaps, []);
  assert.deepEqual(Object.keys(afterReplay.realtimePendingEntries), [transactionHash]);
});

test("near-head handoff capacity is all-or-none and cannot advance a partially persisted range", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-capacity-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const launcher = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const iface = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const logs = [0, 1].map((index) => {
    const token = `0x3${String(index + 1).repeat(39)}`;
    const creator = `0x4${String(index + 1).repeat(39)}`;
    const encoded = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1n, creator, BigInt(index + 1), token, `Capacity ${index}`, `C${index}`, "ipfs://capacity"]);
    return {
      address: launcher,
      topics: encoded.topics,
      data: encoded.data,
      transactionHash: `0x${String(index + 4).repeat(64)}`,
      blockNumber: "0x5a",
      transactionIndex: `0x${index.toString(16)}`,
      logIndex: `0x${index.toString(16)}`,
    };
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{ id: "realtime-tail-gap:90:90", fromBlock: 90, toBlock: 90, nextBlock: 90 }],
    coverageGaps: [],
  }));
  const provider = {
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) && request.topics[0].includes(FLAP_TOKEN_CREATED_TOPIC) ? logs : [];
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscNearHeadRecoveryBatchSize: 1 }, {
    autoStart: false,
    provider,
    realtimePendingMaxEntries: 1,
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  t.after(() => monitor.stop());
  await assert.rejects(() => monitor.scanNearHeadRecovery(), (error) => error.code === "BSC_REALTIME_PENDING_CAPACITY");
  const snapshot = await monitor.getState();
  assert.deepEqual(Object.keys(snapshot.realtimePendingEntries), []);
  assert.equal(snapshot.nearHeadRecoveryGaps[0].nextBlock, 90);
  assert.equal(snapshot.nearHeadRecoveryGaps[0].attempts, 1);
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  assert.deepEqual(Object.keys(durable.realtimePendingEntries), []);
  assert.equal(durable.nearHeadRecoveryGaps[0].nextBlock, 90);
});

test("a saturated recovery pool cannot block the isolated realtime tail", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-isolated-rpc-"));
  let monitor;
  let realtimeHead = 102;
  let blockRecovery = true;
  let sharedDestroyCalls = 0;
  let realtimeDestroyCalls = 0;
  const recoveryWaiters = [];
  const realtimeRanges = [];
  t.after(async () => {
    blockRecovery = false;
    for (const resolve of recoveryWaiters.splice(0)) resolve([]);
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:60:69",
      fromBlock: 60,
      toBlock: 69,
      nextBlock: 60,
      reason: "realtime_tail_stale_rebuild",
      detectedAt: "2026-08-02T00:00:00.000Z",
      attempts: 0,
      nextAttemptAt: null,
    }],
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return realtimeHead; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method) {
      assert.equal(method, "eth_getLogs");
      if (!blockRecovery) return [];
      return new Promise((resolve) => recoveryWaiters.push(resolve));
    },
    destroy() { sharedDestroyCalls += 1; },
  };
  const realtimeProvider = {
    hosts: ["realtime.test"],
    async getBlockNumber() { return realtimeHead; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      realtimeRanges.push([Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)]);
      return [];
    },
    destroy() { realtimeDestroyCalls += 1; },
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRealtimeTailBatchSize: 10,
    bscNearHeadRecoveryBatchSize: 10,
    bscHttpHeadPollIntervalMs: 20,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, realtimeProvider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });

  await monitor.start();
  await waitUntil(() => recoveryWaiters.length === 2, 2_000);
  realtimeHead = 105;
  await waitUntil(async () => (await monitor.getState()).realtimeTailNextBlock === 104, 2_000);
  assert.deepEqual(realtimeRanges.slice(-2), [[101, 103], [101, 103]]);

  blockRecovery = false;
  for (const resolve of recoveryWaiters.splice(0)) resolve([]);
  await monitor.stop();
  assert.equal(sharedDestroyCalls, 1);
  assert.equal(realtimeDestroyCalls, 1);
});

test("a slow focus3 low request overlaps an actual tail range but serializes the next low lease", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-focus3-slow-low-tail-overlap-"));
  const startedAt = Date.parse("2026-09-05T02:00:00.000Z");
  let clock = startedAt;
  let head = 102;
  let monitor;
  let releaseLow;
  let signalLowStarted;
  const lowGate = new Promise((resolve) => { releaseLow = resolve; });
  const lowStarted = new Promise((resolve) => { signalLowStarted = resolve; });
  let blockFirstLow = true;
  let activePhysicalLogs = 0;
  let maximumPhysicalLogs = 0;
  const physicalCalls = [];
  const circuitRegistry = new Map();
  const rpcUrl = "https://bsc.blockrazor.xyz";
  const providerFactory = (lane) => () => ({
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return head; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      const fromBlock = Number.parseInt(request.fromBlock, 16);
      const toBlock = Number.parseInt(request.toBlock, 16);
      activePhysicalLogs += 1;
      maximumPhysicalLogs = Math.max(maximumPhysicalLogs, activePhysicalLogs);
      physicalCalls.push({ lane, fromBlock, toBlock, address: request.address || null });
      try {
        if (lane === "low" && blockFirstLow && !request.address && fromBlock === 60 && toBlock === 69) {
          signalLowStarted();
          await lowGate;
        }
        return [];
      } finally {
        activePhysicalLogs -= 1;
      }
    },
    async getBlock(blockNumber) { return { number: Number(blockNumber), transactions: [] }; },
    destroy() {},
  });
  const provider = createRpcPool([rpcUrl], [], 1, {
    hostCircuitRegistry: circuitRegistry,
    standardConcurrency: 4,
    allowPublicNodeLogs: false,
    providerFactory: providerFactory("low"),
  });
  const realtimeProvider = createRpcPool([rpcUrl], [], 1, {
    hostCircuitRegistry: circuitRegistry,
    standardConcurrency: 4,
    allowPublicNodeLogs: true,
    providerFactory: providerFactory("tail"),
  });
  t.after(async () => {
    blockFirstLow = false;
    releaseLow();
    t.mock.timers.reset();
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(startedAt).toISOString(),
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: new Date(startedAt).toISOString(),
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:60:99",
      fromBlock: 60,
      toBlock: 99,
      nextBlock: 60,
      reason: "realtime_tail_stale_rebuild",
      detectedAt: new Date(startedAt).toISOString(),
      attempts: 0,
      nextAttemptAt: new Date(startedAt + 60_000).toISOString(),
    }],
    coverageGaps: [],
  }));
  class IdleWebSocket { addEventListener() {} close() {} }
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: rpcUrl,
    bscConfirmations: 2,
    bscRealtimeTailBatchSize: 20,
    bscNearHeadRecoveryBatchSize: 20,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    provider,
    realtimeProvider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" }),
    now: () => clock,
    realtimeTailMinIntervalMsForTesting: 0,
    backgroundSetTimeoutImpl: () => ({ unref() {} }),
    backgroundClearTimeoutImpl() {},
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });

  await monitor.start();
  assert.equal((await monitor.scanRealtimeTail()).skipped, false);
  assert.equal((await monitor.scanRealtimeTail()).skipped, false);

  head = 113;
  await monitor.checkHttpHead();
  let snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 101);
  assert.equal(head - 2 - snapshot.realtimeTailNextBlock + 1, 11,
    "a moving BSC head may remain inside the healthy twenty-block tail window without becoming exactly caught up");

  clock += 60_000;
  const firstLow = monitor.scanNearHeadRecovery();
  await lowStarted;
  assert.equal((await monitor.scanNearHeadRecovery()).reason, "running");
  assert.equal(physicalCalls.filter((call) => call.lane === "low").length, 1,
    "a blocked low filter owns the only low-range request");

  head = 116;
  await monitor.checkHttpHead();
  const overlappingTail = await monitor.scanRealtimeTail();
  assert.deepEqual({ fromBlock: overlappingTail.fromBlock, toBlock: overlappingTail.toBlock }, {
    fromBlock: 101,
    toBlock: 114,
  });
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 115, "the actual tail range commits while one low filter is blocked");
  assert.equal(snapshot.nearHeadRecoveryGaps[0].nextBlock, 60);
  assert.ok(physicalCalls.some((call) => call.lane === "tail" && call.fromBlock === 101 && call.toBlock === 114));
  assert.ok(maximumPhysicalLogs <= 2,
    `the shared physical host never exceeds tail+low concurrency two, observed ${maximumPhysicalLogs}`);
  const lowCallsWhileBlocked = physicalCalls.filter((call) => call.lane === "low").length;
  await monitor.advanceCoverage();
  assert.equal(physicalCalls.filter((call) => call.lane === "low").length, lowCallsWhileBlocked,
    "history cannot become a second low owner while near-head holds the lane");

  blockFirstLow = false;
  releaseLow();
  assert.equal((await firstLow).completed, false);
  snapshot = await monitor.getState();
  assert.equal(snapshot.nearHeadRecoveryGaps[0].nextBlock, 80);
  const callsAfterRelease = physicalCalls.length;
  assert.equal((await monitor.scanNearHeadRecovery()).reason, "realtime_priority");
  assert.equal(physicalCalls.length, callsAfterRelease, "release invalidates the prior tail proof immediately");

  assert.equal((await monitor.scanRealtimeTail()).skipped, false);
  assert.equal((await monitor.scanNearHeadRecovery()).reason, "realtime_priority",
    "one post-release healthy tail pass is insufficient");
  assert.equal((await monitor.scanRealtimeTail()).skipped, false);
  const secondLow = await monitor.scanNearHeadRecovery();
  assert.equal(secondLow.completed, true);
  snapshot = await monitor.getState();
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, []);
  assert.ok(physicalCalls.some((call) => call.lane === "low" && call.fromBlock === 80 && call.toBlock === 89));
  assert.ok(maximumPhysicalLogs <= 2);
});

test("stale realtime tail is rebuilt near head while historical coverage remains honest", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-stale-handoff-"));
  let monitor;
  const blockedGapRequests = [];
  t.after(async () => {
    for (const resolve of blockedGapRequests) resolve([]);
    await monitor?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 60,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const tailRanges = [];
  const distinctRangeOrder = [];
  const observedRanges = new Set();
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [request]) {
      if (method === "eth_getBlockReceipts") throw new Error("historical receipt fallback unavailable");
      assert.equal(method, "eth_getLogs");
      const range = [Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)];
      const rangeKey = range.join("-");
      if (!observedRanges.has(rangeKey)) {
        observedRanges.add(rangeKey);
        distinctRangeOrder.push(range);
      }
      if (range[0] === 97 && range[1] === 100) {
        tailRanges.push(range);
        return [];
      }
      if (range[0] === 60 && range[1] === 69) return [];
      if (range[0] === 70 && range[1] === 79) return new Promise((resolve) => blockedGapRequests.push(resolve));
      throw new Error(`unexpected historical range ${range.join("-")}`);
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRealtimeTailLookbackBlocks: 4,
    bscRealtimeTailBatchSize: 4,
    bscRealtimeTailMaxLagBlocks: 10,
    bscNearHeadRecoveryBatchSize: 10,
    bscNearHeadRecoverySuccessIntervalMs: 250,
    bscExpectedBlockTimeMs: 500,
    bscHealthDegradedLagBlocks: 5,
    bscHealthCriticalLagBlocks: 10,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  await monitor.start();
  await waitUntil(() => blockedGapRequests.length === 2, 2_000);

  const snapshot = await monitor.getState();
  assert.ok(tailRanges.length >= 2, "both verified tail log filters must scan the rebuilt near-head window");
  assert.deepEqual(distinctRangeOrder.slice(0, 3), [[97, 100], [60, 69], [70, 79]], "the live tail must run first, then the near-head gap before full history");
  assert.ok(!distinctRangeOrder.some(([from]) => from === 51), "the lagging full-history cursor must not outrank a due near-head gap");
  assert.equal(snapshot.realtimeTailNextBlock, 101);
  assert.equal(snapshot._health.realtimeTail.cursorRebuildReason, "cursor_stale_handoff_to_near_head_recovery");
  assert.equal(snapshot._health.realtimeTail.previousNextBlock, 60);
  assert.equal(snapshot._health.realtimeTail.previousLagBlocks, 41);
  assert.equal(snapshot._health.realtimeTail.handoffFromBlock, 60);
  assert.equal(snapshot._health.realtimeTail.handoffThroughBlock, 96);
  assert.equal(snapshot._health.realtimeTail.handoffLane, "near_head_recovery");
  assert.deepEqual(snapshot.nearHeadRecoveryGaps.map(({ fromBlock, toBlock, nextBlock }) => ({ fromBlock, toBlock, nextBlock })), [{ fromBlock: 60, toBlock: 96, nextBlock: 70 }]);
  assert.equal(snapshot._health.nearHeadRecovery.pendingGapCount, 1);
  assert.equal(snapshot._health.nearHeadRecovery.pendingBlockCount, 27);
  assert.equal(snapshot.lastFinalizedBlock, 50, "near-head recovery must not advance the historical completeness cursor");
  assert.equal(snapshot._health.coverage.coveredBlock, 50);
  assert.equal(snapshot._health.coverage.lagBlocks, 50);
  assert.equal(snapshot._health.coverage.status, "critical");
});

test("near-head recovery yields its RPC work until the realtime tail is durable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-fairness-"));
  const tailWaiters = [];
  const coverageWaiters = [];
  const gapRanges = [];
  let monitor;
  t.after(async () => {
    for (const resolve of [...tailWaiters, ...coverageWaiters]) resolve([]);
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 97,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:60:69",
      fromBlock: 60,
      toBlock: 69,
      nextBlock: 60,
      reason: "realtime_tail_stale_rebuild",
      detectedAt: "2026-08-02T00:00:00.000Z",
      attempts: 0,
      nextAttemptAt: null,
    }],
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [request]) {
      if (method === "eth_getBlockReceipts") throw new Error("receipt fallback unavailable");
      assert.equal(method, "eth_getLogs");
      const range = [Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)];
      if (range[0] === 97 && range[1] === 100) {
        return new Promise((resolve) => tailWaiters.push(resolve));
      }
      if (range[0] === 60 && range[1] === 69) {
        gapRanges.push(range);
        return [];
      }
      if (range[0] === 51) return new Promise((resolve) => coverageWaiters.push(resolve));
      return [];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRealtimeTailBatchSize: 4,
    bscNearHeadRecoveryBatchSize: 10,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });

  await monitor.start();
  await waitUntil(() => tailWaiters.length === 2, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  let snapshot = await monitor.getState();
  assert.equal(gapRanges.length, 0, "historical repair must not compete with a blocked realtime batch");
  assert.equal(snapshot.realtimeTailNextBlock, 97);
  assert.equal(snapshot.nearHeadRecoveryGaps.length, 1);

  for (const resolve of tailWaiters.splice(0)) resolve([]);
  await waitUntil(() => gapRanges.length === 2, 2_000);
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 101, "tail cursor must be durable before historical repair resumes");
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, [], "one bounded gap batch resumes after the realtime tail catches up");
  assert.equal(snapshot.lastFinalizedBlock, 50, "fair near-head progress must not advance full-history coverage");
});

test("five successful near-head batches admit one truthful full-history batch while gaps remain", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-history-fairness-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-09-04T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 201,
    realtimeTailInitializedAt: "2026-09-04T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:100:199",
      fromBlock: 100,
      toBlock: 199,
      nextBlock: 100,
      reason: "realtime_tail_stale_rebuild",
      detectedAt: "2026-09-04T00:00:00.000Z",
      attempts: 0,
      nextAttemptAt: null,
    }],
    coverageGaps: [],
  }));
  const firstSeenRanges = [];
  const seenRanges = new Set();
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 202; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      const range = [Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)];
      const key = range.join(":");
      if (!seenRanges.has(key)) {
        seenRanges.add(key);
        firstSeenRanges.push(range);
      }
      return [];
    },
    destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  const fetchImpl = async () => ({ ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRecoveryLogBatchSize: 10,
    bscNearHeadRecoveryBatchSize: 1,
    bscNearHeadRecoverySuccessIntervalMs: 60_000,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    realtimeTailMinIntervalMsForTesting: 0,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });

  await monitor.start();
  while ((await monitor.getState()).nearHeadRecoveryGaps[0].nextBlock < 105) {
    // Every completed low-range lease invalidates the preceding tail proof.
    // Drive two real caught-up tail passes before asking for the next lease;
    // native timers may race these calls, so count completions rather than
    // assuming a fixed number of invocations.
    await completeRealtimeTailPasses(monitor);
    const result = await monitor.scanNearHeadRecovery();
    if (result.skipped) await new Promise((resolve) => setImmediate(resolve));
  }
  await waitUntil(async () => {
    await monitor.advanceCoverage();
    return (await monitor.getState()).lastFinalizedBlock >= 60;
  }, 2_000);
  const snapshot = await monitor.getState();
  assert.equal(snapshot.lastFinalizedBlock, 60, "one exact ten-block history batch advances the truthful cursor");
  assert.equal(snapshot.nearHeadRecoveryGaps[0].nextBlock, 105, "the live repair gap remains independently durable");
  const historyIndex = firstSeenRanges.findIndex(([from, to]) => from === 51 && to === 60);
  assert.ok(historyIndex >= 0, "the admitted work is a real eth_getLogs history scan, not a synthetic cursor bump");
  const nearHeadBeforeHistory = firstSeenRanges.slice(0, historyIndex)
    .filter(([from, to]) => from >= 100 && from <= 104 && to === from);
  assert.deepEqual(nearHeadBeforeHistory, [[100, 100], [101, 101], [102, 102], [103, 103], [104, 104]]);
});

test("five failed near-head attempt slots still admit one real full-history request", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-failure-fairness-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-09-04T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 201,
    realtimeTailInitializedAt: "2026-09-04T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: Array.from({ length: 6 }, (_, index) => ({
      id: `realtime-tail-gap:${100 + (index * 2)}:${100 + (index * 2)}`,
      fromBlock: 100 + (index * 2),
      toBlock: 100 + (index * 2),
      nextBlock: 100 + (index * 2),
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
      nextAttemptAt: null,
    })),
    coverageGaps: [],
  }));
  const timeline = [];
  const recorded = new Set();
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 202; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [request]) {
      if (method === "eth_getBlockReceipts") {
        const error = new Error("receipt method unavailable");
        error.code = "SERVER_ERROR";
        error.retryAfterMs = 1_000;
        error.rpcOperation = method;
        error.rpcFailureScope = "method";
        throw error;
      }
      assert.equal(method, "eth_getLogs");
      const from = Number.parseInt(request.fromBlock, 16);
      const to = Number.parseInt(request.toBlock, 16);
      const key = `${from}:${to}`;
      if (!recorded.has(key)) {
        recorded.add(key);
        timeline.push([from, to]);
      }
      if (from === 51 && to === 60) return [];
      const error = new Error("eth_getLogs timed out after 1000ms");
      error.code = "TIMEOUT";
      error.retryAfterMs = 1_000;
      error.rpcOperation = method;
      error.rpcFailureScope = "method";
      throw error;
    },
    destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRecoveryLogBatchSize: 10,
    bscNearHeadRecoveryBatchSize: 1,
    bscNearHeadRecoveryRetryBaseMs: 60_000,
    bscNearHeadRecoveryRetryMaxMs: 60_000,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    realtimeTailMinIntervalMsForTesting: 0,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" }),
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  await monitor.start();
  await waitUntil(async () => (await monitor.getState()).lastFinalizedBlock === 60, 3_000);
  const historyIndex = timeline.findIndex(([from, to]) => from === 51 && to === 60);
  assert.equal(historyIndex, 5, "history receives a slot after five failed live-repair ranges, not after a success that may never occur");
  assert.ok(timeline.slice(0, historyIndex).every(([from, to]) => from >= 100 && to === from));
  assert.equal((await monitor.getState()).nearHeadRecoveryGaps.length, 6,
    "the method-failed gap cursors remain durable while independent history progresses");
});

test("history backoff leaves live repair runnable while a slow history request excludes overlapping low repair", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-history-backoff-fairness-"));
  let monitor;
  let releaseSlowHistory;
  const slowHistoryGate = new Promise((resolve) => { releaseSlowHistory = resolve; });
  t.after(async () => {
    releaseSlowHistory();
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-09-04T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 1_001,
    realtimeTailInitializedAt: "2026-09-04T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: Array.from({ length: 200 }, (_, index) => ({
      id: `realtime-tail-gap:${500 + (index * 2)}:${500 + (index * 2)}`,
      fromBlock: 500 + (index * 2),
      toBlock: 500 + (index * 2),
      nextBlock: 500 + (index * 2),
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
      nextAttemptAt: null,
    })),
    coverageGaps: [],
  }));
  const timeline = [];
  const nearRanges = new Set();
  let failFirstHistoryWave = true;
  let firstHistoryFailureScheduled = false;
  let firstHistoryFilterFailures = 0;
  let slowHistoryStarted = false;
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 1_002; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [request]) {
      if (method === "eth_getBlockReceipts") {
        const error = new Error("receipt method unavailable");
        error.code = "SERVER_ERROR";
        error.rpcOperation = method;
        error.rpcFailureScope = "method";
        throw error;
      }
      assert.equal(method, "eth_getLogs");
      const from = Number.parseInt(request.fromBlock, 16);
      const to = Number.parseInt(request.toBlock, 16);
      if (from >= 100) {
        if (!nearRanges.has(from)) {
          nearRanges.add(from);
          timeline.push(`near:${from}`);
        }
        const error = new Error("near-head log method unavailable");
        error.code = "TIMEOUT";
        error.rpcOperation = method;
        error.rpcFailureScope = "method";
        throw error;
      }
      if (from === 51 && to === 60 && failFirstHistoryWave) {
        if (!firstHistoryFailureScheduled) {
          firstHistoryFailureScheduled = true;
          timeline.push("history:failed");
        }
        firstHistoryFilterFailures += 1;
        if (firstHistoryFilterFailures >= 5) queueMicrotask(() => { failFirstHistoryWave = false; });
        const error = new Error("history host temporarily unavailable");
        error.code = "SERVER_ERROR";
        error.retryAfterMs = 250;
        error.rpcOperation = method;
        error.rpcFailureScope = "host";
        throw error;
      }
      if (from === 51 && to === 60) {
        if (!slowHistoryStarted) {
          slowHistoryStarted = true;
          timeline.push("history:slow-start");
        }
        await slowHistoryGate;
        return [];
      }
      if (from === 61 && to === 70 && !timeline.includes("history:next")) timeline.push("history:next");
      return [];
    },
    destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRecoveryLogBatchSize: 10,
    bscNearHeadRecoveryBatchSize: 1,
    bscCoverageRetryBaseMs: 5_000,
    bscCoverageRetryMaxMs: 5_000,
    bscNearHeadRecoveryRetryBaseMs: 60_000,
    bscNearHeadRecoveryRetryMaxMs: 60_000,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    realtimeTailMinIntervalMsForTesting: 0,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" }),
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });

  await monitor.start();
  await waitUntil(() => timeline.includes("history:failed"), 3_000);
  // The history lane is cooling, not running. Five further independent gap
  // attempts must remain possible, with each lease separated by a fresh
  // two-pass tail proof.
  for (let turn = 0; turn < 20 && nearRanges.size < 10; turn += 1) {
    await completeRealtimeTailPasses(monitor);
    await monitor.scanNearHeadRecovery().catch(() => {});
  }
  assert.ok(nearRanges.size >= 10,
    `five independent live gaps run while the failed history lane cools: ${JSON.stringify(timeline)}`);
  await waitUntil(() => timeline.includes("history:slow-start"), 7_000);
  assert.ok(timeline.includes("history:slow-start"), `history retry must start after its cooldown: ${JSON.stringify(timeline)}`);
  const slowHistoryIndex = timeline.indexOf("history:slow-start");
  const beforeHold = nearRanges.size;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(nearRanges.size, beforeHold,
    `a slow in-flight history request excludes a second low owner without a repair spin: ${JSON.stringify(timeline)}`);

  const attemptedBeforeRelease = new Set(nearRanges);
  releaseSlowHistory();
  await completeRealtimeTailPasses(monitor);
  await waitUntil(async () => {
    await monitor.scanNearHeadRecovery().catch(() => {});
    return nearRanges.size > attemptedBeforeRelease.size;
  }, 3_000);
  const resumedNearIndex = timeline.findIndex((item) => item.startsWith("near:")
    && !attemptedBeforeRelease.has(Number(item.slice("near:".length))));
  const nextHistoryIndex = timeline.indexOf("history:next");
  assert.ok(resumedNearIndex > slowHistoryIndex
    && (nextHistoryIndex < 0 || resumedNearIndex < nextHistoryIndex),
  `after the slow owner releases, two new healthy tail passes authorize live repair before another history turn: ${JSON.stringify(timeline)}`);
});

test("focus3 runtime stale-tail rebuild retains every uncovered block instead of falsifying coverage", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-runtime-gap-compaction-"));
  const blockedRequests = [];
  let blockProviderRequests = true;
  let monitor;
  t.after(async () => {
    // An already-started mapLimit worker can issue its next shard after stop()
    // begins. Make every future shard non-blocking before releasing the
    // currently parked calls so cleanup cannot strand a late request.
    blockProviderRequests = false;
    const stopping = monitor?.stop();
    for (const resolve of blockedRequests.splice(0)) resolve([]);
    await stopping;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-18T00:00:00.000Z",
    lastFinalizedBlock: 99,
    realtimeTailNextBlock: 100,
    realtimeTailInitializedAt: "2026-08-18T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [],
    coverageGaps: [],
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 1_000_102; },
    async send() {
      if (!blockProviderRequests) return [];
      return new Promise((resolve) => blockedRequests.push(resolve));
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: String(url).includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    monitorScope: "focus3",
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRealtimeTailLookbackBlocks: 4,
    bscRealtimeTailMaxLagBlocks: 10,
    bscNearHeadRecoverySegmentSize: 2_000,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });

  await monitor.start();
  const snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 1_000_097);
  assert.equal(snapshot.lastFinalizedBlock, 99);
  assert.equal(snapshot.nearHeadRecoveryGaps.length, 500, "bounded segments retain the complete million-block pending union");
  assert.equal(Math.min(...snapshot.nearHeadRecoveryGaps.map((gap) => gap.fromBlock)), 100);
  assert.equal(Math.max(...snapshot.nearHeadRecoveryGaps.map((gap) => gap.toBlock)), 1_000_096);
  assert.equal(snapshot.coverageRecoveryHistory.at(-1).reason, "focus3_live_compaction_refused_uncovered");
  assert.equal(snapshot._health.realtimeTail.handoffCompaction, undefined);
});

test("a 20-hour stale tail persists every segment but recovers the head-facing segment first", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-tail-20h-priority-"));
  const blockedGapRequests = [];
  let monitor;
  t.after(async () => {
    for (const resolve of blockedGapRequests) resolve([]);
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 99,
    realtimeTailNextBlock: 100,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const distinctRanges = [];
  const seenRanges = new Set();
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 160_102; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      const range = [Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)];
      const key = range.join("-");
      if (!seenRanges.has(key)) {
        seenRanges.add(key);
        distinctRanges.push(range);
      }
      if (key === "160097-160100" || key === "158097-158106") return [];
      if (key === "158107-158116") return new Promise((resolve) => blockedGapRequests.push(resolve));
      return [];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscRealtimeTailLookbackBlocks: 4,
    bscRealtimeTailBatchSize: 4,
    bscRealtimeTailMaxLagBlocks: 10,
    bscNearHeadRecoveryBatchSize: 40,
    bscNearHeadRecoverySegmentSize: 2_000,
    bscNearHeadRecoverySuccessIntervalMs: 250,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  await monitor.start();
  await waitUntil(() => blockedGapRequests.length === 2, 2_000);
  const snapshot = await monitor.getState();
  assert.deepEqual(distinctRanges.slice(0, 3), [
    [160_097, 160_100],
    [158_097, 158_106],
    [158_107, 158_116],
  ]);
  assert.equal(snapshot.nearHeadRecoveryGaps.length, 80, "the complete 20-hour interval must remain represented by bounded durable segments");
  assert.equal(Math.min(...snapshot.nearHeadRecoveryGaps.map((gap) => gap.fromBlock)), 100);
  assert.equal(Math.max(...snapshot.nearHeadRecoveryGaps.map((gap) => gap.toBlock)), 160_096);
  assert.deepEqual(
    snapshot.nearHeadRecoveryGaps[0] && {
      fromBlock: snapshot.nearHeadRecoveryGaps[0].fromBlock,
      toBlock: snapshot.nearHeadRecoveryGaps[0].toBlock,
      nextBlock: snapshot.nearHeadRecoveryGaps[0].nextBlock,
    },
    { fromBlock: 158_097, toBlock: 160_096, nextBlock: 158_097 },
  );
  assert.equal(snapshot.lastFinalizedBlock, 99, "head-first repair must not falsify full historical coverage");
});

test("legacy historical handoff state migrates once into segmented near-head recovery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-legacy-handoff-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 500,
    realtimeTailNextBlock: 1_001,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [],
    coverageGaps: [],
    _health: {
      realtimeTail: {
        status: "healthy",
        handoffLane: "historical_recovery",
        handoffFromBlock: 400,
        handoffThroughBlock: 900,
      },
    },
  }));
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscNearHeadRecoveryBatchSize: 25,
    bscNearHeadRecoverySegmentSize: 100,
  }, { autoStart: false, provider: { destroy() {} }, now: () => current, logger: { error() {}, info() {} } });
  t.after(() => monitor.stop());
  const migrated = await monitor.getState();
  assert.deepEqual(
    migrated.nearHeadRecoveryGaps.map(({ fromBlock, toBlock, nextBlock }) => ({ fromBlock, toBlock, nextBlock })),
    [
      { fromBlock: 801, toBlock: 900, nextBlock: 801 },
      { fromBlock: 701, toBlock: 800, nextBlock: 701 },
      { fromBlock: 601, toBlock: 700, nextBlock: 601 },
      { fromBlock: 501, toBlock: 600, nextBlock: 501 },
    ],
  );
  assert.equal(migrated._health.realtimeTail.handoffLane, "near_head_recovery");
  assert.equal(migrated._health.realtimeTail.legacyHandoffOriginalLane, "historical_recovery");
  assert.equal(migrated._health.realtimeTail.legacyHandoffMigratedAt, "2026-08-02T01:00:00.000Z");
  assert.equal(migrated._health.realtimeTail.handoffMigrationFromBlock, 501);
  const reloaded = await monitor.getState();
  assert.equal(reloaded.nearHeadRecoveryGaps.length, 4, "re-reading state must not duplicate migrated segments");
});

test("shared RPC cooling backs off the whole near-head lane without walking every gap", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-shared-backoff-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let current = Date.parse("2026-08-24T10:14:18.000Z");
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [90, 91, 92].map((blockNumber) => ({
      id: `realtime-tail-gap:${blockNumber}:${blockNumber}`,
      fromBlock: blockNumber,
      toBlock: blockNumber,
      nextBlock: blockNumber,
      reason: `test_gap_${blockNumber}`,
      detectedAt: "2026-08-24T10:00:00.000Z",
      attempts: 0,
      nextAttemptAt: null,
    })),
    coverageGaps: [],
  }));

  let cooling = true;
  let logRpcCalls = 0;
  let blockFallbackCalls = 0;
  const errors = [];
  const provider = {
    async send(method) {
      if (method === "eth_getLogs") {
        logRpcCalls += 1;
        if (!cooling) return [];
        const error = new Error("eth_getLogs failed on every BSC RPC: providers cooling down; retry in 5000ms");
        error.code = "SERVER_ERROR";
        error.retryAfterMs = 5_000;
        error.rpcHostRetryAfterMs = 300_000;
        error.rpcOperation = "eth_getLogs";
        error.rpcFailureScope = "method";
        throw error;
      }
      blockFallbackCalls += 1;
      throw new Error(`unexpected block fallback ${method}`);
    },
    async getBlock() {
      blockFallbackCalls += 1;
      throw new Error("unexpected block fallback");
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscNearHeadRecoveryBatchSize: 1,
    bscNearHeadRecoveryRetryBaseMs: 100,
    bscNearHeadRecoveryRetryMaxMs: 1_000,
  }, {
    autoStart: false,
    provider,
    now: () => current,
    logger: { error(message) { errors.push(message); }, info() {} },
  });

  await assert.rejects(() => monitor.scanNearHeadRecovery(), /providers cooling down/);
  const callsAfterFirstGap = logRpcCalls;
  let snapshot = await monitor.getState();
  assert.equal(blockFallbackCalls, 0, "a pool-wide cooling error must not expand into block receipt fallbacks");
  assert.equal(snapshot.nearHeadRecoveryGaps.length, 3, "all gaps remain durable during a shared outage");
  assert.deepEqual(snapshot.nearHeadRecoveryGaps.map(({ nextBlock }) => nextBlock).sort((left, right) => left - right), [90, 91, 92]);
  assert.equal(snapshot.nearHeadRecoveryGaps.filter(({ attempts }) => attempts > 0).length, 1, "only one gap is attempted before the lane-wide backoff");
  assert.equal(snapshot._health.nearHeadRecovery.sharedRpcRetryAt, "2026-08-24T10:14:23.000Z");
  assert.equal(errors.filter((message) => message.startsWith("[bsc][near-head-gap]")).length, 1);

  assert.deepEqual(await monitor.scanNearHeadRecovery(), { skipped: true, reason: "backoff" });
  assert.deepEqual(await monitor.scanNearHeadRecovery(), { skipped: true, reason: "backoff" });
  assert.equal(logRpcCalls, callsAfterFirstGap, "other due gaps must not probe while the shared RPC circuit is cooling");

  current += 5_000;
  await assert.rejects(() => monitor.scanNearHeadRecovery(), /providers cooling down/);
  assert.equal(errors.filter((message) => message.startsWith("[bsc][near-head-gap]")).length, 1, "the same outage is logged at most once per minute");
  cooling = false;
  current += 5_000;
  const recovered = await monitor.scanNearHeadRecovery();
  assert.equal(recovered.skipped, false);
  snapshot = await monitor.getState();
  assert.equal(snapshot.nearHeadRecoveryGaps.length, 2, "the lane resumes from a retained gap when the shared backoff is due");
  assert.equal(snapshot._health.nearHeadRecovery.sharedRpcRetryAt, undefined);
  await monitor.stop();
});

test("a host-global fallback 429 propagates through the near-head wrapper and gates every gap", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-fallback-429-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let current = Date.parse("2026-08-24T10:14:18.000Z");
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [90, 91].map((blockNumber) => ({
      id: `realtime-tail-gap:${blockNumber}:${blockNumber}`,
      fromBlock: blockNumber,
      toBlock: blockNumber,
      nextBlock: blockNumber,
      reason: "realtime_tail_stale_rebuild",
      attempts: 0,
      nextAttemptAt: null,
    })),
    coverageGaps: [],
  }));
  let logCalls = 0;
  let receiptCalls = 0;
  const provider = {
    async send(method) {
      if (method === "eth_getLogs") {
        logCalls += 1;
        const error = new Error("eth_getLogs timed out after 4000ms");
        error.code = "TIMEOUT";
        error.retryAfterMs = 4_000;
        error.rpcOperation = "eth_getLogs";
        error.rpcFailureScope = "method";
        throw error;
      }
      assert.equal(method, "eth_getBlockReceipts");
      receiptCalls += 1;
      const error = new Error("HTTP 429 fallback host rate limited");
      error.code = "SERVER_ERROR";
      error.retryAfterMs = 12_000;
      error.rpcOperation = "eth_getBlockReceipts";
      error.rpcFailureScope = "host";
      throw error;
    },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscNearHeadRecoveryBatchSize: 1,
    bscNearHeadRecoveryRetryBaseMs: 100,
    bscNearHeadRecoveryRetryMaxMs: 1_000,
  }, {
    autoStart: false,
    provider,
    now: () => current,
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  t.after(() => monitor.stop());
  await assert.rejects(
    () => monitor.scanNearHeadRecovery(),
    (error) => error.rpcFailureScope === "host"
      && error.rpcOperation === "eth_getBlockReceipts"
      && error.retryAfterMs === 12_000,
  );
  const callsAfterOutage = { logCalls, receiptCalls };
  const snapshot = await monitor.getState();
  assert.equal(snapshot._health.nearHeadRecovery.sharedRpcRetryAt, "2026-08-24T10:14:30.000Z");
  assert.equal(snapshot.nearHeadRecoveryGaps.filter((gap) => gap.attempts > 0).length, 1);
  assert.deepEqual(await monitor.scanNearHeadRecovery(), { skipped: true, reason: "backoff" });
  assert.deepEqual({ logCalls, receiptCalls }, callsAfterOutage,
    "the second due gap cannot probe during a physical-host fallback cooldown");
  current += 12_000;
});

test("a method-scoped getCode outage defers one candidate without blocking the next near-head log gap", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-method-scope-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"81".repeat(32)}`;
  const implementation = "0x8111111111111111111111111111111111111111";
  const upgradeLog = {
    address: "0x8b4329947e34b6d56d71a3385cac122bade7d78d",
    transactionHash,
    blockNumber: "0x5b",
    transactionIndex: "0x0",
    logIndex: "0x0",
    topics: [BSC_UPGRADED_TOPIC, `0x${"0".repeat(24)}${implementation.slice(2)}`],
    data: "0x",
  };
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [
      { id: "new", fromBlock: 91, toBlock: 91, nextBlock: 91, reason: "new", attempts: 0 },
      { id: "old", fromBlock: 90, toBlock: 90, nextBlock: 90, reason: "old", attempts: 0 },
    ],
    coverageGaps: [],
  }));
  const logRanges = [];
  const provider = {
    async getBlockNumber() { return 101; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      const from = Number.parseInt(request.fromBlock, 16);
      logRanges.push(from);
      return from === 91 && Array.isArray(request.topics?.[0]) ? [upgradeLog] : [];
    },
    async getTransaction() { return { hash: transactionHash, to: upgradeLog.address, from: "0x8222222222222222222222222222222222222222", data: "0x" }; },
    async getTransactionReceipt() { return { transactionHash, status: 1, blockNumber: 91, logs: [upgradeLog] }; },
    async getBlock() { return { number: 91, timestamp: 1_786_000_000, transactions: [transactionHash] }; },
    async getCode() {
      const error = new Error("getCode timed out after 4000ms");
      error.code = "TIMEOUT";
      error.retryAfterMs = 4_000;
      error.rpcOperation = "getCode";
      error.rpcFailureScope = "method";
      throw error;
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, bscNearHeadRecoveryBatchSize: 1 }, {
    autoStart: false,
    provider,
    logger: { error() {}, info() {} },
  });
  t.after(() => monitor.stop());
  assert.equal((await monitor.scanNearHeadRecovery()).fromBlock, 91);
  await monitor.processRealtimeQueue();
  let snapshot = await monitor.getState();
  assert.ok(snapshot.deferredCreationEvidence[transactionHash]);
  assert.equal(snapshot._health.nearHeadRecovery.sharedRpcRetryAt, undefined,
    "getCode retry timing belongs to the candidate, never the log lane");
  assert.equal((await monitor.scanNearHeadRecovery()).fromBlock, 90);
  snapshot = await monitor.getState();
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, []);
  assert.ok(logRanges.includes(91) && logRanges.includes(90));
});

test("near-head gap recovery survives failure and restart, then deletes the gap without replaying a seen transaction", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-gap-restart-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const transactionHash = `0x${"a".repeat(64)}`;
  const token = "0x1111111111111111111111111111111111111111";
  const recipient = `0x${"0".repeat(24)}2222222222222222222222222222222222222222`;
  const firstNow = Date.parse("2026-08-02T01:00:00.000Z");
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: { [transactionHash]: 90 },
    nearHeadRecoveryGaps: [{
      id: "realtime-tail-gap:90:90",
      fromBlock: 90,
      toBlock: 90,
      nextBlock: 90,
      detectedAt: "2026-08-02T00:30:00.000Z",
      attempts: 0,
    }],
    coverageGaps: [],
  }));

  const failingProvider = {
    async send(method) {
      if (method === "eth_getLogs") throw new Error("limit exceeded");
      throw new Error("receipt fallback unavailable");
    },
    async getBlock() { throw new Error("block fallback unavailable"); },
    destroy() {},
  };
  const first = createBscLaunchpadMonitor({
    dataDir,
    bscNearHeadRecoveryBatchSize: 1,
    bscNearHeadRecoveryRetryBaseMs: 100,
    bscNearHeadRecoveryRetryMaxMs: 100,
  }, { autoStart: false, provider: failingProvider, now: () => firstNow, logger: { error() {}, info() {} } });
  await assert.rejects(() => first.scanNearHeadRecovery(), /near-head gap recovery failed/);
  const failed = await first.getState();
  assert.equal(failed.nearHeadRecoveryGaps.length, 1, "a failed batch must remain durable");
  assert.equal(failed.nearHeadRecoveryGaps[0].nextBlock, 90, "failure must not advance the gap cursor");
  assert.equal(failed.nearHeadRecoveryGaps[0].attempts, 1);
  assert.equal(failed.nearHeadRecoveryGaps[0].nextAttemptAt, "2026-08-02T01:00:00.100Z");
  assert.equal(failed._health.nearHeadRecovery.status, "backoff");
  await first.stop();

  let alerts = 0;
  const recoveredRanges = [];
  const recoveringProvider = {
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      recoveredRanges.push([Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)]);
      if (request.topics?.[0] === BSC_TRANSFER_TOPIC) return [{
        address: token,
        transactionHash,
        blockNumber: "0x5a",
        topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, recipient],
        data: `0x${"0".repeat(63)}1`,
      }];
      return [];
    },
    destroy() {},
  };
  const restarted = createBscLaunchpadMonitor({
    dataDir,
    bscNearHeadRecoveryBatchSize: 1,
  }, {
    autoStart: false,
    provider: recoveringProvider,
    now: () => firstNow + 101,
    sendAlertsImpl: async () => { alerts += 1; },
    logger: { error() {}, info() {} },
  });
  const beforeRetry = await restarted.getState();
  assert.equal(beforeRetry.nearHeadRecoveryGaps.length, 1, "the pending range must survive process restart");
  const result = await restarted.scanNearHeadRecovery();
  assert.equal(result.completed, true);
  const recovered = await restarted.getState();
  assert.deepEqual(recoveredRanges, [[90, 90], [90, 90]], "the durable cursor retries exactly the failed batch");
  assert.deepEqual(recovered.nearHeadRecoveryGaps, [], "a fully verified range must be deleted");
  assert.equal(recovered._health.nearHeadRecovery.status, "healthy");
  assert.equal(alerts, 0, "overlap with a transaction already delivered by the live lane must not alert twice");
  await restarted.stop();
});

test("historical near-head lifecycle and upgrade alerts carry their real block time into freshness suppression", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-chain-time-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"b".repeat(64)}`;
  const implementation = "0x1111111111111111111111111111111111111111";
  const lifecycleInterface = new Interface([
    "event TournamentCreated(uint256 indexed tournamentId,uint256 entryFee,uint256 roundDelay,uint256 roundDuration,uint256 startTime)",
  ]);
  const lifecycleEncoded = lifecycleInterface.encodeEventLog(lifecycleInterface.getEvent("TournamentCreated"), [1n, 2n, 3n, 4n, 5n]);
  const lifecycleLog = {
    address: "0x5b3ba297a60685844fe673c134651d7dcf1a74b6",
    transactionHash,
    blockNumber: "0x5a",
    topics: lifecycleEncoded.topics,
    data: lifecycleEncoded.data,
  };
  assert.equal(lifecycleLog.topics[0], ONEVONE_TOURNAMENT_CREATED_TOPIC);
  const upgradeLog = {
    address: "0x8b4329947e34b6d56d71a3385cac122bade7d78d",
    transactionHash,
    blockNumber: "0x5a",
    topics: [BSC_UPGRADED_TOPIC, `0x${"0".repeat(24)}${implementation.slice(2)}`],
    data: "0x",
  };
  const blockTimestamp = "2026-08-05T00:00:00.000Z";
  const discoveredAt = "2026-08-06T04:00:00.000Z";
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    officialLifecycleEvents: {},
    officialUpgrades: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{ id: "realtime-tail-gap:90:90", fromBlock: 90, toBlock: 90, nextBlock: 90 }],
    coverageGaps: [],
  }));
  const receipt = { hash: transactionHash, transactionHash, blockNumber: 90, status: 1, logs: [lifecycleLog, upgradeLog] };
  const alerts = [];
  const provider = {
    async getBlockNumber() { return 101; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) ? [lifecycleLog, upgradeLog] : [];
    },
    async getTransaction() {
      return {
        hash: transactionHash,
        to: "0x5b3ba297a60685844fe673c134651d7dcf1a74b6",
        from: "0x2222222222222222222222222222222222222222",
        data: "0x",
      };
    },
    async getTransactionReceipt() { return receipt; },
    async getBlock(blockNumber) { return { number: blockNumber, timestamp: Date.parse(blockTimestamp) / 1_000, transactions: [transactionHash] }; },
    async getCode() { return "0x6000"; },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, bscNearHeadRecoveryBatchSize: 1 }, {
    autoStart: false,
    provider,
    now: () => Date.parse(discoveredAt),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); },
    logger: { error() {}, info() {} },
  });
  await monitor.scanNearHeadRecovery();
  let handoff = await monitor.getState();
  assert.ok(handoff.realtimePendingEntries[transactionHash], "the canonical candidate is durable before deep lifecycle/code reads");
  assert.deepEqual(handoff.nearHeadRecoveryGaps, []);
  await monitor.processRealtimeQueue();
  assert.equal(alerts.length, 2);
  assert.deepEqual(new Set(alerts.map((event) => event.mode.selector)), new Set(["official-lifecycle", "proxy-upgrade"]));
  for (const event of alerts) {
    assert.equal(event.blockNumber, 90);
    assert.equal(event.blockTimestamp, blockTimestamp);
    const freshness = classifyAlertFreshness({}, event, discoveredAt);
    assert.equal(freshness.sourceOccurredAt, blockTimestamp);
    assert.equal(freshness.decision, "suppress", `${event.mode.selector} must not bypass the stale-chain gate`);
  }
  await monitor.stop();
});

test("official upgrade verification stays retryable when historical and latest code RPCs both fail", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-upgrade-code-retry-"));
  const transactionHash = `0x${"e".repeat(64)}`;
  const implementation = "0x1111111111111111111111111111111111111111";
  const upgradeLog = {
    address: "0x8b4329947e34b6d56d71a3385cac122bade7d78d",
    transactionHash,
    blockNumber: "0x5a",
    topics: [BSC_UPGRADED_TOPIC, `0x${"0".repeat(24)}${implementation.slice(2)}`],
    data: "0x",
  };
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    officialUpgrades: {},
    seenTransactions: {},
    nearHeadRecoveryGaps: [{ id: "realtime-tail-gap:90:90", fromBlock: 90, toBlock: 90, nextBlock: 90 }],
    coverageGaps: [],
  }));
  const receipt = { hash: transactionHash, transactionHash, blockNumber: 90, status: 1, logs: [upgradeLog] };
  let verificationAvailable = false;
  let codeReads = 0;
  let clock = Date.parse("2026-08-06T04:00:00.000Z");
  const alerts = [];
  const provider = {
    async getBlockNumber() { return 101; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return Array.isArray(request.topics?.[0]) ? [upgradeLog] : [];
    },
    async getTransaction() {
      return {
        hash: transactionHash,
        to: upgradeLog.address,
        from: "0x3333333333333333333333333333333333333333",
        data: "0x",
      };
    },
    async getTransactionReceipt() { return receipt; },
    async getBlock(blockNumber) { return { number: blockNumber, timestamp: clock / 1_000, transactions: [transactionHash] }; },
    async getCode(address) {
      assert.equal(String(address).toLowerCase(), implementation);
      codeReads += 1;
      if (!verificationAvailable) {
        const error = new Error("code RPC unavailable");
        error.code = "NETWORK_ERROR";
        error.retryAfterMs = 100;
        error.rpcOperation = "getCode";
        error.rpcFailureScope = "method";
        throw error;
      }
      return "0x6000";
    },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscNearHeadRecoveryBatchSize: 1,
    bscNearHeadRecoveryRetryBaseMs: 100,
    bscNearHeadRecoveryRetryMaxMs: 100,
  }, {
    autoStart: false,
    provider,
    now: () => clock,
    sendAlertsImpl: async (_config, event) => { alerts.push(event); },
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const handoff = await monitor.scanNearHeadRecovery();
  assert.equal(handoff.completed, true, "log coverage advances independently of implementation code availability");
  await monitor.processRealtimeQueue();
  let snapshot = await monitor.getState();
  assert.equal(codeReads, 2, "historical and latest code checks must both be attempted");
  assert.equal(alerts.length, 0);
  assert.equal(snapshot.seenTransactions[transactionHash], undefined);
  assert.deepEqual(Object.keys(snapshot.officialUpgrades), []);
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, [], "deep getCode failure must not roll back verified log coverage");
  assert.ok(snapshot.deferredCreationEvidence[transactionHash], "the exact candidate moves immediately to durable method retry");

  verificationAvailable = true;
  clock = Date.parse(snapshot.deferredCreationEvidence[transactionHash].nextAttemptAt) + 1;
  await monitor.retryDeferredCreationEvidence();
  snapshot = await monitor.getState();
  assert.equal(alerts.length, 1);
  assert.equal(snapshot.seenTransactions[transactionHash], 90);
  assert.equal(Object.keys(snapshot.officialUpgrades).length, 1);
  assert.deepEqual(snapshot.nearHeadRecoveryGaps, []);
  assert.equal(snapshot.deferredCreationEvidence[transactionHash], undefined);
});

test("a hook alert recovered from a historical gap uses block time rather than recovery time", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-near-head-hook-time-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"c".repeat(64)}`;
  const previousTransactionHash = `0x${"d".repeat(64)}`;
  const token = "0x1111111111111111111111111111111111111111";
  const previousToken = "0x4444444444444444444444444444444444444444";
  const controller = "0x2222222222222222222222222222222222222222";
  const hook = "0x3333333333333333333333333333333333333333";
  const previousCaller = "0x5555555555555555555555555555555555555555";
  const caller = "0x6666666666666666666666666666666666666666";
  const poolId = `0x${"1".repeat(64)}`;
  const infinity = new Interface([
    "event Initialize(bytes32 indexed poolId,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint160 sqrtPriceX96,int24 tick)",
  ]);
  const poolEncoded = infinity.encodeEventLog(infinity.getEvent("Initialize"), [
    poolId,
    token,
    BSC_WBNB,
    hook,
    100,
    `0x${"0".repeat(64)}`,
    1n,
    0,
  ]);
  const poolLog = {
    address: "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b",
    transactionHash,
    blockNumber: "0x5a",
    topics: poolEncoded.topics,
    data: poolEncoded.data,
  };
  assert.equal(poolLog.topics[0], PANCAKE_INFINITY_CL_INITIALIZE_TOPIC);
  const mintLog = {
    address: token,
    transactionHash,
    blockNumber: "0x5a",
    topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, `0x${"0".repeat(24)}7777777777777777777777777777777777777777`],
    data: `0x${"0".repeat(63)}1`,
  };
  const blockTimestamp = "2026-08-05T00:00:00.000Z";
  const discoveredAt = "2026-08-06T04:00:00.000Z";
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {
      [hook]: {
        hook,
        firstSeenBlock: 89,
        lastSeenBlock: 89,
        transactions: [previousTransactionHash],
        poolIds: [`0x${"2".repeat(64)}`],
        poolKinds: ["Pancake Infinity CL"],
        newTokens: [previousToken],
        controllers: {
          [controller]: {
            controller,
            transactions: [previousTransactionHash],
            poolIds: [`0x${"2".repeat(64)}`],
            newTokens: [previousToken],
            safeTokens: [previousToken],
            callers: [previousCaller],
            alerted: false,
          },
        },
      },
    },
    seenTransactions: {},
    nearHeadRecoveryGaps: [{ id: "realtime-tail-gap:90:90", fromBlock: 90, toBlock: 90, nextBlock: 90 }],
    coverageGaps: [],
  }));
  const hookCode = `0x63aaaaaaaa63bbbbbbbb${"00".repeat(600)}`;
  const controllerCode = `0x63cccccccc63ddddddddf5${"00".repeat(1_100)}`;
  const receipt = { hash: transactionHash, transactionHash, blockNumber: 90, status: 1, logs: [mintLog, poolLog] };
  const alerts = [];
  const provider = {
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return request.topics?.[0] === BSC_TRANSFER_TOPIC ? [mintLog] : [poolLog];
    },
    async getTransaction() { return { hash: transactionHash, to: controller, from: caller, data: "0x" }; },
    async getTransactionReceipt() { return receipt; },
    async getBlock(blockNumber) { return { number: blockNumber, timestamp: Date.parse(blockTimestamp) / 1_000, transactions: [transactionHash] }; },
    async getCode(address, blockTag) {
      const normalized = String(address).toLowerCase();
      if (normalized === token && blockTag === 89) return "0x";
      if (normalized === hook) return hookCode;
      if (normalized === controller) return controllerCode;
      if (normalized === token) return "0x60006000";
      return "0x6000";
    },
    async getStorage() { return "0x"; },
    async call() { throw new Error("owner unavailable"); },
    destroy() {},
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, bscNearHeadRecoveryBatchSize: 1 }, {
    autoStart: false,
    provider,
    now: () => Date.parse(discoveredAt),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); },
    logger: { error() {}, info() {} },
  });
  await monitor.scanNearHeadRecovery();
  const handoff = await monitor.getState();
  assert.ok(handoff.realtimePendingEntries[transactionHash]);
  assert.deepEqual(handoff.nearHeadRecoveryGaps, []);
  await monitor.processRealtimeQueue();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].mode.selector, "v4-hook");
  assert.equal(alerts[0].blockTimestamp, blockTimestamp);
  const freshness = classifyAlertFreshness({}, alerts[0], discoveredAt);
  assert.equal(freshness.sourceOccurredAt, blockTimestamp);
  assert.equal(freshness.decision, "suppress");
  await monitor.stop();
});

test("historical recovery backoff cannot be bypassed by fresh heads or repeated scheduling", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-coverage-backoff-"));
  let monitor;
  t.after(async () => {
    await monitor?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const clock = Date.parse("2026-08-02T01:00:00.000Z");
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  let head = 102;
  let historicalLogCalls = 0;
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return head; },
    async getBlock(blockNumber) { return { number: blockNumber, transactions: [] }; },
    async send(method, [request]) {
      if (method === "eth_getLogs") {
        const fromBlock = Number.parseInt(request.fromBlock, 16);
        if (fromBlock >= 101) return [];
        historicalLogCalls += 1;
        throw new Error("historical getLogs unavailable");
      }
      assert.equal(method, "eth_getBlockReceipts");
      throw new Error("historical receipt fallback unavailable");
    },
    destroy() {},
  };
  class HeadWebSocket {
    static instance;
    constructor() {
      this.handlers = new Map();
      this.headSubscription = null;
      HeadWebSocket.instance = this;
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const handlers = this.handlers.get(kind) || [];
      handlers.push(handler);
      this.handlers.set(kind, handlers);
    }
    emit(kind, event) { for (const handler of this.handlers.get(kind) || []) handler(event); }
    send(raw) {
      const request = JSON.parse(raw);
      const subscription = `sub-${request.id}`;
      if (request.params[0] === "newHeads") this.headSubscription = subscription;
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription }) }));
    }
    emitHead(blockNumber) {
      this.emit("message", { data: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: this.headSubscription, result: { number: `0x${blockNumber.toString(16)}` } },
      }) });
    }
    close() { this.emit("close", {}); }
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscCoverageRetryBaseMs: 1_000,
    bscCoverageRetryMaxMs: 1_000,
    bscHttpHeadPollIntervalMs: 20,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: HeadWebSocket, fetchImpl, now: () => clock, logger: { error() {}, info() {} } });
  await monitor.start();
  await waitUntil(async () => (await monitor.getState())._health.rpc?.status === "error", 2_000);

  let snapshot = await monitor.getState();
  assert.ok(historicalLogCalls > 0, "the historical lane must attempt recovery before entering backoff");
  assert.equal(snapshot._health.rpc.consecutiveFailures, 1);
  assert.equal(snapshot._health.rpc.retryDelayMs, 1_000);
  assert.equal(Date.parse(snapshot._health.rpc.nextRetryAt), clock + 1_000);
  const callsAtBackoff = historicalLogCalls;

  head = 105;
  assert.ok(HeadWebSocket.instance?.headSubscription, "the head subscription must be active before exercising rescheduling");
  HeadWebSocket.instance.emitHead(103);
  HeadWebSocket.instance.emitHead(104);
  HeadWebSocket.instance.emitHead(105);
  await new Promise((resolve) => setTimeout(resolve, 350));

  snapshot = await monitor.getState();
  assert.equal(snapshot._health.websocket.blockNumber, 105);
  assert.equal(historicalLogCalls, callsAtBackoff, "fresh heads and frequent HTTP polls must respect the historical retry deadline");
  assert.equal(snapshot._health.rpc.consecutiveFailures, 1);
  assert.equal(snapshot._health.rpc.retryDelayMs, 1_000);
  assert.equal(Date.parse(snapshot._health.rpc.nextRetryAt), clock + 1_000);
  assert.equal(snapshot.lastFinalizedBlock, 50);
});

test("historical recovery yields after one log batch and resumes without a new head", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-coverage-yield-"));
  let monitor;
  const blockedSecondBatch = [];
  t.after(async () => {
    for (const resolve of blockedSecondBatch) resolve([]);
    await monitor?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const ranges = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      const range = [Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)];
      ranges.push(range);
      if (range[0] === 51 && range[1] === 60) return [];
      if (range[0] === 61 && range[1] === 70) return new Promise((resolve) => blockedSecondBatch.push(resolve));
      throw new Error(`unexpected historical range ${range.join("-")}`);
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscMaxCatchupBlocks: 240,
    bscRecoveryLogBatchSize: 10,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  await monitor.start();
  await waitUntil(async () => (await monitor.getState()).lastFinalizedBlock === 60, 2_000);
  assert.equal((await monitor.getState()).lastFinalizedBlock, 60);
  assert.deepEqual(ranges, [[51, 60], [51, 60]], "one invocation must stop after a single two-filter log batch");
  await waitUntil(() => blockedSecondBatch.length === 2, 2_000);
  assert.equal(blockedSecondBatch.length, 2, "the next batch must self-schedule without waiting for another head");
});

test("caught-up block coverage stays critical while an unresolved transaction gap exists", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-gap-health-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"A".repeat(64)}`;
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    deferredCreationEvidence: {},
    coverageGaps: [{
      fromBlock: 90,
      toBlock: 90,
      transactionHash,
      detectedAt: "2026-08-02T00:00:00.000Z",
      status: "deferred",
    }, {
      fromBlock: 80,
      toBlock: 80,
      transactionHash: `0x${"b".repeat(64)}`,
      detectedAt: "2026-08-01T00:00:00.000Z",
      resolvedAt: "2026-08-02T00:00:00.000Z",
      status: "resolved",
    }],
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async send() { return []; },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscOfficialPollIntervalMs: 60_000,
    bscHttpHeadPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  t.after(() => monitor.stop());
  await monitor.start();
  const snapshot = await monitor.getState();
  assert.equal(snapshot._health.coverage.lagBlocks, 0);
  assert.equal(snapshot._health.coverage.status, "critical");
  assert.equal(snapshot._health.coverage.unresolvedGapCount, 1);
  assert.equal(snapshot._health.coverage.oldestUnresolvedBlock, 90);
  assert.equal(snapshot.coverageGaps[0].transactionHash, transactionHash.toLowerCase());
  await monitor.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("HTTP tail cursor is failure-closed while historical coverage health remains critical", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-http-tail-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 999,
    realtimeTailInitializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  let tailFailure = true;
  const blockedHistorical = [];
  const logRanges = [];
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async send(method, [request]) {
      if (method === "eth_getBlockReceipts") throw new Error("receipt fallback unavailable");
      assert.equal(method, "eth_getLogs");
      const range = [Number.parseInt(request.fromBlock, 16), Number.parseInt(request.toBlock, 16)];
      logRanges.push(range);
      if (range[0] === 99 && range[1] === 100) {
        if (tailFailure) throw new Error("tail log RPC unavailable");
        return [];
      }
      if (range[0] >= 51 && range[1] <= 82) return [];
      if (range[0] >= 83 && range[1] <= 100) {
        return new Promise((_resolve, reject) => blockedHistorical.push(reject));
      }
      throw new Error(`unexpected log range ${range.join("-")}`);
    },
    destroy() {},
  };
  class SilentHeadWebSocket {
    constructor() {
      this.handlers = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const handlers = this.handlers.get(kind) || [];
      handlers.push(handler);
      this.handlers.set(kind, handlers);
    }
    emit(kind, event) { for (const handler of this.handlers.get(kind) || []) handler(event); }
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: `sub-${request.id}` }) }));
    }
    close() { this.emit("close", {}); }
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscMaxCatchupBlocks: 240,
    bscRecoveryLogBatchSize: 32,
    bscRealtimeTailLookbackBlocks: 2,
    bscRealtimeTailBatchSize: 32,
    bscExpectedBlockTimeMs: 500,
    bscHealthDegradedLagBlocks: 5,
    bscHealthCriticalLagBlocks: 10,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: SilentHeadWebSocket, fetchImpl, logger: { error() {}, info() {} } });
  t.after(() => monitor.stop());
  await monitor.start();

  let snapshot;
  const deadline = Date.now() + 2_000;
  do {
    snapshot = await monitor.getState();
    if (snapshot.lastFinalizedBlock === 82 && snapshot._health.realtimeTail.status === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(snapshot.realtimeTailNextBlock, 99, "a failed tail range must not advance its durable cursor");
  assert.equal(snapshot._health.realtimeTail.cursorRebuildReason, "cursor_out_of_confirmed_range");
  assert.equal(snapshot._health.realtimeTail.previousNextBlock, 999);
  assert.equal(snapshot.lastFinalizedBlock, 82);
  assert.equal(snapshot._health.rpc.status, "healthy", "the completed historical batch should report its own lane as healthy");
  assert.equal(snapshot._health.coverage.status, "critical", "historical lane success must not hide remaining lag");
  assert.equal(snapshot._health.coverage.headBlock, 102);
  assert.equal(snapshot._health.coverage.coveredBlock, 82);
  assert.equal(snapshot._health.coverage.lagBlocks, 18);
  assert.equal(snapshot._health.coverage.lagSeconds, 9);

  tailFailure = false;
  const tailRetryWaitMs = Math.max(0, Date.parse(snapshot._health.realtimeTail.nextRetryAt) - Date.now());
  if (tailRetryWaitMs) await new Promise((resolve) => setTimeout(resolve, tailRetryWaitMs + 10));
  await monitor.scanRealtimeTail();
  snapshot = await monitor.getState();
  assert.equal(snapshot.realtimeTailNextBlock, 101);
  assert.equal(snapshot._health.realtimeTail.status, "healthy");
  assert.equal(snapshot._health.coverage.realtimeTailCoveredBlock, 100);
  assert.equal(snapshot._health.coverage.status, "critical");
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  assert.equal(durable.realtimeTailNextBlock, 101);
  assert.ok(logRanges.filter(([from, to]) => from === 99 && to === 100).length >= 4, "the exact failed range must be retried without skipping");

  await waitUntil(() => blockedHistorical.length > 0, 1_000);
  for (const reject of blockedHistorical) reject(new Error("release blocked historical range"));
  await waitUntil(async () => (await monitor.getState())._health.rpc.status === "error", 3_000);
  snapshot = await monitor.getState();
  assert.equal(snapshot._health.rpc.status, "error");
  await monitor.stop();
});

test("poison transaction processing is durably deferred, retried, and never falsely marked seen", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-coverage-deferred-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const transactionHash = `0x${"c".repeat(64)}`;
  const token = `0x${"1".repeat(40)}`;
  const recipient = `0x${"9".repeat(40)}`;
  const mintLog = {
    address: token,
    transactionHash,
    blockNumber: "0x65",
    topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, `0x${"0".repeat(24)}${recipient.slice(2)}`],
    data: `0x${"0".repeat(63)}1`,
  };
  const receipt = { transactionHash, blockNumber: 101, status: 1, logs: [mintLog] };
  let clock = Date.parse("2026-08-02T01:00:00.000Z");
  let poison = true;
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 102,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    transactionFailures: {},
    coverageGaps: [],
  }));
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 103; },
    async getBlock(blockNumber) { return { number: blockNumber, timestamp: Math.floor(clock / 1_000), transactions: [transactionHash] }; },
    async getCode() { return "0x"; },
    async getTransaction() {
      if (poison) throw new Error("poison transaction response");
      return { hash: transactionHash, to: `0x${"7".repeat(40)}`, from: `0x${"8".repeat(40)}`, data: "0x" };
    },
    async getTransactionReceipt() { return receipt; },
    async send(method, [request]) {
      assert.equal(method, "eth_getLogs");
      return request.topics?.[0] === BSC_TRANSFER_TOPIC ? [mintLog] : [];
    },
    destroy() {},
  };
  class IdleWebSocket {
    addEventListener() {}
    close() {}
  }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] }),
  });
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 20,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
  }, { autoStart: false, provider, WebSocketImpl: IdleWebSocket, fetchImpl, now: () => clock, logger: { error() {}, info() {} } });
  t.after(() => monitor.stop());
  await monitor.start();

  let snapshot;
  const firstFailureDeadline = Date.now() + 1_000;
  do {
    snapshot = await monitor.getState();
    if (snapshot.transactionFailures?.[transactionHash]?.attempts >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < firstFailureDeadline);
  assert.ok(snapshot.transactionFailures?.[transactionHash]?.attempts >= 1);
  clock += 20_000;

  const deferredDeadline = Date.now() + 2_000;
  do {
    snapshot = await monitor.getState();
    if (snapshot.deferredCreationEvidence?.[transactionHash] && snapshot.lastFinalizedBlock === 101) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deferredDeadline);
  assert.equal(snapshot.lastFinalizedBlock, 101);
  assert.equal(snapshot.seenTransactions[transactionHash], undefined);
  assert.equal(snapshot.deferredCreationEvidence[transactionHash].deferredKind, "coverage_processing");
  assert.equal(snapshot.coverageGaps.find((gap) => gap.transactionHash === transactionHash)?.status, "deferred");
  assert.equal(snapshot._health.coverage.status, "critical");

  poison = false;
  clock += 301_000;
  await monitor.retryDeferredCreationEvidence();
  snapshot = await monitor.getState();
  assert.equal(snapshot.deferredCreationEvidence[transactionHash], undefined);
  assert.equal(snapshot.seenTransactions[transactionHash], 101);
  assert.equal(snapshot.coverageGaps.find((gap) => gap.transactionHash === transactionHash)?.status, "resolved");
  assert.equal(snapshot._health.coverage.unresolvedGapCount, 0);
  assert.equal(snapshot._health.coverage.status, "healthy");
});

test("BscScan timeouts are durably deferred without blocking coverage and retry with bounded concurrency", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-deferred-evidence-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-02T00:00:00.000Z",
    lastFinalizedBlock: 100,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  const tokens = ["1", "2", "3"].map((digit) => `0x${digit.repeat(40)}`);
  const transactions = ["a", "b", "c"].map((digit) => `0x${digit.repeat(64)}`);
  const receipts = tokens.map((token, index) => ({
    transactionHash: transactions[index],
    blockNumber: "0x65",
    logs: [{
      address: token,
      transactionHash: transactions[index],
      blockNumber: "0x65",
      topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, `0x${"0".repeat(24)}${"9".repeat(40)}`],
      data: `0x${"0".repeat(63)}1`,
    }],
  }));
  const copiedFlap = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
  const copiedEvent = copiedFlap.encodeEventLog(copiedFlap.getEvent("TokenCreated"), [1n, `0x${"8".repeat(40)}`, 1n, tokens[0], "Copy", "COPY", "ipfs://copy"]);
  receipts[0].logs.push({
    address: `0x${"7".repeat(40)}`,
    transactionHash: transactions[0],
    blockNumber: "0x65",
    topics: copiedEvent.topics,
    data: copiedEvent.data,
  });
  let clock = Date.parse("2026-08-02T01:00:00.000Z");
  let bscScanAvailable = false;
  let activeBscScan = 0;
  let maximumBscScan = 0;
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 103; },
    async getBlock(blockNumber) {
      return {
        number: blockNumber,
        transactions: blockNumber === 101 ? transactions : [],
      };
    },
    async getCode(_address, blockTag) {
      if (blockTag !== undefined && blockTag !== null) throw new Error("missing trie node");
      return "0x6000";
    },
    async send(method, [block]) {
      assert.equal(method, "eth_getBlockReceipts");
      return Number.parseInt(block, 16) === 101 ? receipts : [];
    },
    destroy() {},
  };
  class FakeWebSocket {
    constructor() {
      this.handlers = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const handlers = this.handlers.get(kind) || [];
      handlers.push(handler);
      this.handlers.set(kind, handlers);
    }
    emit(kind, event) { for (const handler of this.handlers.get(kind) || []) handler(event); }
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: `sub-${request.id}` }) }));
    }
    close() { this.emit("close", {}); }
  }
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://bscscan.com/address/")) {
      activeBscScan += 1;
      maximumBscScan = Math.max(maximumBscScan, activeBscScan);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!bscScanAvailable) throw new Error("temporary timeout");
        return { ok: true, status: 200, text: async () => `<!-- Contract Creator --><a href='/tx/0x${"f".repeat(64)}'>created</a>` };
      } finally {
        activeBscScan -= 1;
      }
    }
    let payload;
    if (String(url).includes("/public/address")) payload = { code: 0, data: [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }] };
    else if (String(url).includes("token_template")) payload = { code: 0, data: [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }] };
    else if (String(url).includes("rugspull.com")) payload = { rugs: [], nextCursor: 0 };
    else if (String(url).includes("dappbay")) payload = { list: [] };
    else payload = { data: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 20,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
    bscScanConcurrency: 2,
  }, { autoStart: false, provider, WebSocketImpl: FakeWebSocket, fetchImpl, now: () => clock, logger: { error() {}, info() {} } });
  t.after(() => monitor.stop());
  await monitor.start();
  let snapshot;
  const deadline = Date.now() + 3_000;
  do {
    snapshot = await monitor.getState();
    if (snapshot.lastFinalizedBlock === 101 && Object.keys(snapshot.deferredCreationEvidence || {}).length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(snapshot.lastFinalizedBlock, 101);
  assert.equal(Object.keys(snapshot.deferredCreationEvidence).length, 3);
  assert.equal(snapshot._health.coverage.status, "degraded", "a caught-up block cursor must not hide deferred transaction evidence");
  assert.equal(snapshot._health.coverage.deferredTransactionCount, 3);
  assert.equal(snapshot._health.coverage.unresolvedGapCount, 0);
  assert.equal(maximumBscScan, 2);
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  assert.equal(Object.keys(durable.deferredCreationEvidence).length, 3);

  bscScanAvailable = true;
  clock += 20_000;
  await monitor.retryDeferredCreationEvidence();
  await monitor.retryDeferredCreationEvidence();
  snapshot = await monitor.getState();
  assert.deepEqual(Object.keys(snapshot.deferredCreationEvidence), []);
  assert.equal(snapshot._health.coverage.status, "healthy");
  assert.equal(snapshot._health.coverage.deferredTransactionCount, 0);
  for (const transactionHash of transactions) assert.equal(snapshot.seenTransactions[transactionHash], 101);
});

test("pure BSC health telemetry coalesces while a durable discovery mutation persists immediately across restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-health-coalesce-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T09:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }));
  let clock = Date.parse("2026-08-24T09:00:00.000Z");
  let nextTimerId = 0;
  const healthTimers = new Map();
  const healthSetTimeoutImpl = (callback, delay) => {
    const handle = { id: ++nextTimerId, unref() {} };
    healthTimers.set(handle.id, { handle, callback, dueAt: clock + delay });
    return handle;
  };
  const healthClearTimeoutImpl = (handle) => healthTimers.delete(handle?.id);
  const advanceHealthClock = async (milliseconds, monitor) => {
    clock += milliseconds;
    const due = [...healthTimers.values()].filter((timer) => timer.dueAt <= clock);
    for (const timer of due) {
      healthTimers.delete(timer.handle.id);
      timer.callback();
    }
    await Promise.resolve();
    await monitor.awaitIdle();
  };
  const writes = [];
  const atomicWriteImpl = async (file, snapshot) => {
    writes.push({ at: clock, httpCheckedAt: snapshot._health?.httpHead?.checkedAt || null });
    await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  };
  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 102; },
    async send(method) {
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected method ${method}`);
    },
    destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: String(url).includes("/address")
      ? [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }]
      : String(url).includes("token_template")
        ? [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }]
        : [] }),
  });
  const config = {
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHealthPersistIntervalMs: 30_000,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
    monitorScope: "focus3",
  };
  const dependencies = {
    autoStart: false,
    provider,
    WebSocketImpl: IdleWebSocket,
    fetchImpl,
    now: () => clock,
    atomicWriteImpl,
    healthSetTimeoutImpl,
    healthClearTimeoutImpl,
    sendAlertsImpl: async () => assert.fail("health and discovery persistence must not alert"),
    logger: { error() {}, info() {} },
  };
  const monitor = createBscLaunchpadMonitor(config, dependencies);
  await monitor.start();
  await monitor.awaitIdle();
  const baselineWrites = writes.length;

  for (let index = 0; index < 20; index += 1) {
    clock += 1_000;
    await monitor.checkHttpHead();
  }
  assert.equal(writes.length, baselineWrites, "twenty checkedAt-only refreshes do not serialize the full state");
  assert.equal(healthTimers.size, 1, "health refreshes share one trailing flush");

  await advanceHealthClock(10_000, monitor);
  assert.equal(writes.length, baselineWrites + 1, "the latest telemetry is durably flushed once at 30 seconds");
  assert.equal(healthTimers.size, 0);

  clock += 1_000;
  await monitor.checkHttpHead();
  assert.equal(healthTimers.size, 1);
  const beforeDurableWrites = writes.length;
  const address = "0x1234567890123456789012345678901234567890";
  await monitor.registerDiscoveryCandidates([{
    address,
    platformName: "Durable Test Launchpad",
    sourceTrust: "candidate",
    sourceId: "durability-regression",
    sourceUrl: "https://example.com/evidence",
    observedAt: new Date(clock).toISOString(),
  }]);
  assert.ok(writes.length > beforeDurableWrites, "a durable mutation writes immediately inside the telemetry window");
  assert.equal(healthTimers.size, 0, "the durable snapshot absorbs pending telemetry and cancels its redundant flush");
  const durable = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(durable.discoverySources.external.contracts[address].sources[0].sourceTrust, "candidate");
  clock += 1_000;
  await monitor.checkHttpHead();
  assert.equal(healthTimers.size, 1);
  const writesBeforeStop = writes.length;
  await monitor.stop();
  assert.equal(healthTimers.size, 0, "stop cancels an unimportant trailing health flush");
  await advanceHealthClock(30_000, monitor);
  assert.equal(writes.length, writesBeforeStop, "a stopped monitor cannot perform a late telemetry write");

  const restarted = createBscLaunchpadMonitor(config, { ...dependencies, autoStart: false });
  const restored = await restarted.getState();
  assert.equal(restored.discoverySources.external.contracts[address].sources[0].sourceId, "durability-regression");
  await restarted.stop();
});

test("BSC latest-revision persistence coalesces concurrent saves without resolving a newer durability boundary early", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-save-latest-revision-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let releaseFirstWrite;
  let releaseSecondWrite;
  let signalFirstWrite;
  let signalSecondWrite;
  const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
  const secondWriteGate = new Promise((resolve) => { releaseSecondWrite = resolve; });
  const firstWriteStarted = new Promise((resolve) => { signalFirstWrite = resolve; });
  const secondWriteStarted = new Promise((resolve) => { signalSecondWrite = resolve; });
  let allWrites = 0;
  let updateWrites = 0;
  const writtenSnapshots = [];
  const atomicWriteImpl = async (file, snapshot) => {
    allWrites += 1;
    if (allWrites === 1) {
      await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      return;
    }
    updateWrites += 1;
    writtenSnapshots.push(structuredClone(snapshot));
    if (updateWrites === 1) {
      signalFirstWrite();
      await firstWriteGate;
    } else if (updateWrites === 2) {
      signalSecondWrite();
      await secondWriteGate;
    }
    await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    atomicWriteImpl,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    releaseFirstWrite();
    releaseSecondWrite();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.getState();

  const samples = [
    observation({
      launcher: "0x1011111111111111111111111111111111111111",
      token: "0x2011111111111111111111111111111111111111",
      transactionHash: `0x${"1".repeat(64)}`,
      blockNumber: 101,
    }),
    observation({
      launcher: "0x1022222222222222222222222222222222222222",
      token: "0x2022222222222222222222222222222222222222",
      transactionHash: `0x${"2".repeat(64)}`,
      blockNumber: 102,
    }),
    observation({
      launcher: "0x1033333333333333333333333333333333333333",
      token: "0x2033333333333333333333333333333333333333",
      transactionHash: `0x${"3".repeat(64)}`,
      blockNumber: 103,
    }),
  ];
  let firstSettled = false;
  let secondSettled = false;
  let thirdSettled = false;
  const first = monitor.observe(samples[0]).then((value) => { firstSettled = true; return value; });
  await firstWriteStarted;
  const second = monitor.observe(samples[1]).then((value) => { secondSettled = true; return value; });
  const third = monitor.observe(samples[2]).then((value) => { thirdSettled = true; return value; });
  // Queue behind both observation mutations to prove their save requests have
  // reached the coordinator while the first physical write is still blocked.
  await monitor.getState();
  assert.equal(updateWrites, 1);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(thirdSettled, false);

  releaseFirstWrite();
  await Promise.all([first, secondWriteStarted]);
  assert.equal(firstSettled, true, "the first caller resolves after its own snapshot is durable");
  assert.equal(secondSettled, false, "a newer caller must not resolve on the older in-flight write");
  assert.equal(thirdSettled, false, "the latest caller must wait for the latest snapshot");
  const firstDurable = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(firstDurable.seenTransactions[samples[0].transactionHash], 101);
  assert.equal(firstDurable.seenTransactions[samples[1].transactionHash], undefined);
  assert.equal(firstDurable.seenTransactions[samples[2].transactionHash], undefined);

  releaseSecondWrite();
  await Promise.all([second, third]);
  assert.equal(updateWrites, 2, "three concurrent save requests need at most the in-flight write plus one latest write");
  assert.equal(writtenSnapshots.length, 2);
  const latestDurable = JSON.parse(await fs.readFile(stateFile, "utf8"));
  for (const sample of samples) assert.equal(latestDurable.seenTransactions[sample.transactionHash], sample.blockNumber);
});

test("a failed BSC state write rejects only covered callers while a newer queued revision recovers", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-save-failure-recovery-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let releaseFailedWrite;
  let releaseRecoveryWrite;
  let signalFailedWrite;
  let signalRecoveryWrite;
  const failedWriteGate = new Promise((resolve) => { releaseFailedWrite = resolve; });
  const recoveryWriteGate = new Promise((resolve) => { releaseRecoveryWrite = resolve; });
  const failedWriteStarted = new Promise((resolve) => { signalFailedWrite = resolve; });
  const recoveryWriteStarted = new Promise((resolve) => { signalRecoveryWrite = resolve; });
  let allWrites = 0;
  let updateWrites = 0;
  const atomicWriteImpl = async (file, snapshot) => {
    allWrites += 1;
    if (allWrites > 1) {
      updateWrites += 1;
      if (updateWrites === 1) {
        signalFailedWrite();
        await failedWriteGate;
        throw new Error("simulated BSC state replacement failure");
      }
      if (updateWrites === 2) {
        signalRecoveryWrite();
        await recoveryWriteGate;
      }
    }
    await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    atomicWriteImpl,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    releaseFailedWrite();
    releaseRecoveryWrite();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.getState();
  const failedSample = observation({
    launcher: "0x1044444444444444444444444444444444444444",
    token: "0x2044444444444444444444444444444444444444",
    transactionHash: `0x${"4".repeat(64)}`,
    blockNumber: 104,
  });
  const failedSave = monitor.observe(failedSample);
  await failedWriteStarted;
  const recoverySample = observation({
    launcher: "0x1055555555555555555555555555555555555555",
    token: "0x2055555555555555555555555555555555555555",
    transactionHash: `0x${"5".repeat(64)}`,
    blockNumber: 105,
  });
  let recoverySettled = false;
  const recoverySave = monitor.observe(recoverySample).then((value) => { recoverySettled = true; return value; });
  await monitor.getState();
  releaseFailedWrite();
  await assert.rejects(() => failedSave, /simulated BSC state replacement failure/);
  await recoveryWriteStarted;
  assert.equal(recoverySettled, false, "the newer revision remains pending after the older write fails");
  let durable = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(durable.seenTransactions[failedSample.transactionHash], undefined, "a failed rename cannot satisfy its save promise");
  assert.equal(durable.seenTransactions[recoverySample.transactionHash], undefined);

  releaseRecoveryWrite();
  await recoverySave;
  durable = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(durable.seenTransactions[failedSample.transactionHash], 104, "the next latest snapshot recovers the prior in-memory mutation");
  assert.equal(durable.seenTransactions[recoverySample.transactionHash], 105);
  assert.equal(updateWrites, 2);
});

test("a pending Four.Meme official snapshot is durably replaced before its external alert begins", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-save-before-official-send-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let roots = [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC", network: 0 }];
  const templates = [{ id: 1, name: "Baseline", tag: "Curve", codeType: "SOLIDITY", descr: "base", status: "PUBLISHED" }];
  let releasePendingWrite;
  let signalPendingWrite;
  const pendingWriteGate = new Promise((resolve) => { releasePendingWrite = resolve; });
  const pendingWriteStarted = new Promise((resolve) => { signalPendingWrite = resolve; });
  let gated = false;
  let alertCalls = 0;
  const atomicWriteImpl = async (file, snapshot) => {
    if (!gated && snapshot.officialSources?.fourMeme?.pendingRoots?.observations === 2) {
      gated = true;
      signalPendingWrite();
      await pendingWriteGate;
    }
    await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  };
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 0, data: url.includes("/address")
      ? roots
      : url.includes("/config")
        ? [{ symbol: "BNB", symbolAddress: BSC_WBNB, platform: "MEME", networkCode: "BSC", status: "PUBLISH" }]
        : templates }),
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    fetchImpl,
    atomicWriteImpl,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async () => { alertCalls += 1; return { status: "delivered" }; },
  });
  t.after(async () => {
    releasePendingWrite();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.checkOfficialSources();
  roots = [...roots, { name: "TokenManager4", address: "0x1111111111111111111111111111111111111111", networkCode: "BSC", network: 0 }];
  await monitor.checkOfficialSources();
  const confirming = monitor.checkOfficialSources();
  await pendingWriteStarted;
  assert.equal(alertCalls, 0, "the alert cannot begin while its two-observation checkpoint is not durable");
  const beforeCommit = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(beforeCommit.officialSources.fourMeme.pendingRoots.observations, 1);

  releasePendingWrite();
  await confirming;
  assert.equal(alertCalls, 1);
  const afterCommit = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.ok(afterCommit.officialSources.fourMeme.roots["0x1111111111111111111111111111111111111111"]);
  assert.equal(afterCommit.officialSources.fourMeme.pendingRoots, null);
});

test("BSC stop waits for an in-flight latest-revision write and leaves its mutation durable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-save-stop-flush-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let releaseWrite;
  let signalWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  let allWrites = 0;
  let destroyCalls = 0;
  const atomicWriteImpl = async (file, snapshot) => {
    allWrites += 1;
    if (allWrites === 2) {
      signalWrite();
      await writeGate;
    }
    await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() { destroyCalls += 1; } },
    atomicWriteImpl,
    logger: { error() {}, info() {} },
  });
  t.after(async () => {
    releaseWrite();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.getState();
  const sample = observation({
    launcher: "0x1066666666666666666666666666666666666666",
    token: "0x2066666666666666666666666666666666666666",
    transactionHash: `0x${"6".repeat(64)}`,
    blockNumber: 106,
  });
  const observing = monitor.observe(sample);
  await writeStarted;
  let stopSettled = false;
  const stopping = monitor.stop().then(() => { stopSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopSettled, false);
  assert.equal(destroyCalls, 0);

  releaseWrite();
  await observing;
  await stopping;
  const durable = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(durable.seenTransactions[sample.transactionHash], 106);
  assert.equal(destroyCalls, 1);
});

test("BSC atomic state replacement tightens an existing state file to owner-only permissions", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-state-mode-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T09:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }), { mode: 0o644 });
  await fs.chmod(stateFile, 0o644);
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
  }, { autoStart: false, provider: { destroy() {} }, logger: { error() {}, info() {} } });
  await monitor.getState();
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  await monitor.stop();
});

test("BSC snapshot WAL migrates legacy JSON, replays one atomic delta, and truncates only a torn tail", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-replay-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T09:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
  }), { mode: 0o644 });
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  const first = createBscLaunchpadMonitor({ dataDir }, dependencies);
  await first.getState();
  const migratedSnapshot = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(migratedSnapshot.journalRevision, 0);
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(walFile)).mode & 0o777, 0o600);

  const sample = observation({
    launcher: "0x1077777777777777777777777777777777777777",
    token: "0x2077777777777777777777777777777777777777",
    transactionHash: `0x${"7".repeat(64)}`,
    blockNumber: 107,
  });
  await first.observe(sample);
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).seenTransactions[sample.transactionHash], undefined,
    "the readable snapshot may lag while the fsynced WAL is authoritative");
  const completeWal = await fs.readFile(walFile);
  assert.ok(completeWal.length > 0 && completeWal.at(-1) === 0x0a);
  await fs.appendFile(walFile, "{\"torn\":");

  const restarted = createBscLaunchpadMonitor({ dataDir }, dependencies);
  const recovered = await restarted.getState();
  assert.equal(recovered.seenTransactions[sample.transactionHash], 107);
  assert.deepEqual(await fs.readFile(walFile), completeWal, "only the incomplete suffix is durably truncated");
  await restarted.stop();
  await first.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("a modern BSC snapshot with no WAL durably creates the WAL entry before a normalization delta resolves", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-missing-entry-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  const seed = createBscLaunchpadMonitor({ dataDir }, dependencies);
  await seed.getState();
  await seed.stop();

  const snapshot = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const staleQuoteAddress = "0x7666666666666666666666666666666666666666";
  snapshot.discoverySources.external.contracts[staleQuoteAddress] = {
    address: staleQuoteAddress,
    sources: [{
      sourceId: "platform-capability:fourmeme",
      sourceUrl: "https://four.meme/meme-api/v1/public/config",
    }],
  };
  await fs.writeFile(stateFile, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await fs.rm(walFile, { force: true });

  let walRenameNeedsDirectoryBarrier = false;
  let walDirectoryEntryDurable = false;
  let walDirectorySyncs = 0;
  let walAppends = 0;
  const journalFsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === "rename") return async (from, to) => {
        await fs.rename(from, to);
        if (String(to) === walFile) {
          walRenameNeedsDirectoryBarrier = true;
          walDirectoryEntryDurable = false;
        }
      };
      if (property !== "open") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (file, flags, mode) => {
        if (String(file) === walFile && flags === "a") {
          walAppends += 1;
          assert.equal(walDirectoryEntryDurable, true,
            "startup must not append or resolve a revision before the WAL directory entry is durable");
        }
        const handle = await fs.open(file, flags, mode);
        if (String(file) !== dataDir || flags !== "r") return handle;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === "sync") return async () => {
              await handleTarget.sync();
              if (walRenameNeedsDirectoryBarrier) {
                walRenameNeedsDirectoryBarrier = false;
                walDirectoryEntryDurable = true;
                walDirectorySyncs += 1;
              }
            };
            const value = handleTarget[handleProperty];
            return typeof value === "function" ? value.bind(handleTarget) : value;
          },
        });
      };
    },
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    ...dependencies,
    journalFsImpl,
  });
  const normalized = await monitor.getState();
  assert.equal(normalized.discoverySources.external.contracts[staleQuoteAddress], undefined);
  assert.equal(walDirectorySyncs, 1);
  assert.equal(walAppends, 1, "the startup normalization is persisted as one WAL revision");
  const durable = await readBscLaunchpadDurableState(stateFile);
  assert.equal(durable.discoverySources.external.contracts[staleQuoteAddress], undefined);
  await monitor.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("BSC WAL fails closed on middle corruption, checksum conflict, and revision gaps", async (t) => {
  const makeSnapshot = async (prefix) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const monitor = createBscLaunchpadMonitor({ dataDir }, {
      autoStart: false,
      provider: { destroy() {} },
      logger: { error() {}, info() {} },
      ...disabledJournalTimerDependencies(),
    });
    await monitor.getState();
    await monitor.stop();
    return { dataDir, stateFile: path.join(dataDir, "bsc-launchpad-state.json") };
  };
  const cases = [
    {
      name: "middle corruption",
      wal: `${testBscWalFrame(1, [{ op: "set", path: ["lastFinalizedBlock"], value: 101 }])}not-json\n${testBscWalFrame(2, [{ op: "set", path: ["lastFinalizedBlock"], value: 102 }])}`,
      error: /corrupt BSC state WAL frame/,
    },
    {
      name: "checksum mismatch",
      wal: `${JSON.stringify({ ...JSON.parse(testBscWalFrame(1, [{ op: "set", path: ["lastFinalizedBlock"], value: 101 }])), sha256: "0".repeat(64) })}\n`,
      error: /checksum mismatch/,
    },
    {
      name: "revision gap",
      wal: testBscWalFrame(2, [{ op: "set", path: ["lastFinalizedBlock"], value: 102 }]),
      error: /revision gap/,
    },
    {
      name: "same revision with different checksum",
      wal: `${testBscWalFrame(1, [{ op: "set", path: ["lastFinalizedBlock"], value: 101 }])}${testBscWalFrame(1, [{ op: "set", path: ["lastFinalizedBlock"], value: 102 }])}`,
      error: /conflicting BSC state WAL revision/,
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { dataDir, stateFile } = await makeSnapshot(`bsc-wal-${fixture.name.replaceAll(" ", "-")}-`);
      await fs.writeFile(`${stateFile}.wal`, fixture.wal, { mode: 0o600 });
      const monitor = createBscLaunchpadMonitor({ dataDir }, { autoStart: false, provider: { destroy() {} } });
      await assert.rejects(() => monitor.getState(), fixture.error);
      await fs.rm(dataDir, { recursive: true, force: true });
    });
  }
});

test("a failed BSC WAL append rejects its covered save while the next revision recovers A and B", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-append-recovery-"));
  const walFile = path.join(dataDir, "bsc-launchpad-state.json.wal");
  let failWalSync = true;
  const journalFsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (file, flags, mode) => {
        const handle = await fs.open(file, flags, mode);
        if (!String(file).endsWith(".wal") || flags !== "a") return handle;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === "sync") return async () => {
              if (failWalSync) {
                failWalSync = false;
                throw new Error("simulated WAL fsync failure after append");
              }
              return handleTarget.sync();
            };
            const value = handleTarget[handleProperty];
            return typeof value === "function" ? value.bind(handleTarget) : value;
          },
        });
      };
    },
  });
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    journalFsImpl,
    ...disabledJournalTimerDependencies(),
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, dependencies);
  await monitor.getState();
  const first = observation({ transactionHash: `0x${"8".repeat(64)}`, blockNumber: 108 });
  const second = observation({
    launcher: "0x1099999999999999999999999999999999999999",
    token: "0x2099999999999999999999999999999999999999",
    transactionHash: `0x${"9".repeat(64)}`,
    blockNumber: 109,
  });
  await assert.rejects(() => monitor.observe(first), /simulated WAL fsync failure/);
  assert.equal((await fs.stat(walFile)).size, 0, "a failed fsync is rolled back and fsynced before retry");
  await monitor.observe(second);
  assert.equal((await fs.readFile(walFile, "utf8")).trim().split("\n").length, 1,
    "the recovery snapshot is one sequential revision, not a conflicting retry");
  const restarted = createBscLaunchpadMonitor({ dataDir }, dependencies);
  const recovered = await restarted.getState();
  assert.equal(recovered.seenTransactions[first.transactionHash], 108);
  assert.equal(recovered.seenTransactions[second.transactionHash], 109);
  await restarted.stop();
  await monitor.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("BSC WAL fstat failure preserves existing bytes and poisons appends instead of truncating to zero", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-stat-failure-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  let failWalStat = false;
  let walAppendOpens = 0;
  const journalFsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (file, flags, mode) => {
        const handle = await fs.open(file, flags, mode);
        if (!String(file).endsWith(".wal") || flags !== "a") return handle;
        walAppendOpens += 1;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === "stat") return async () => {
              if (failWalStat) throw new Error("simulated WAL fstat failure");
              return handleTarget.stat();
            };
            const value = handleTarget[handleProperty];
            return typeof value === "function" ? value.bind(handleTarget) : value;
          },
        });
      };
    },
  });
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    journalFsImpl,
    ...disabledJournalTimerDependencies(),
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, dependencies);
  await monitor.getState();
  const first = observation({ transactionHash: `0x${"1a".repeat(32)}`, blockNumber: 210 });
  await monitor.observe(first);
  const existingWal = await fs.readFile(walFile);
  assert.ok(existingWal.length > 0);
  failWalStat = true;
  const rejected = observation({
    launcher: "0x7111111111111111111111111111111111111111",
    token: "0x8111111111111111111111111111111111111111",
    transactionHash: `0x${"1b".repeat(32)}`,
    blockNumber: 211,
  });
  await assert.rejects(() => monitor.observe(rejected), /simulated WAL fstat failure/);
  assert.deepEqual(await fs.readFile(walFile), existingWal, "fstat failure must not truncate the prior journal");
  const opensAfterFailure = walAppendOpens;
  const beforeRecovery = await readBscLaunchpadDurableState(stateFile);
  assert.equal(beforeRecovery.seenTransactions[first.transactionHash], 210);
  assert.equal(beforeRecovery.seenTransactions[rejected.transactionHash], undefined);
  failWalStat = false;
  const recovery = observation({
    launcher: "0x7222222222222222222222222222222222222222",
    token: "0x8222222222222222222222222222222222222222",
    transactionHash: `0x${"1c".repeat(32)}`,
    blockNumber: 212,
  });
  await monitor.observe(recovery);
  assert.equal(walAppendOpens, opensAfterFailure + 1,
    "the next save appends only after a full snapshot and WAL-reset recovery barrier");
  const afterRecovery = await readBscLaunchpadDurableState(stateFile);
  assert.equal(afterRecovery.seenTransactions[first.transactionHash], 210);
  assert.equal(afterRecovery.seenTransactions[rejected.transactionHash], 211);
  assert.equal(afterRecovery.seenTransactions[recovery.transactionHash], 212);

  const restarted = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  const recovered = await restarted.getState();
  assert.equal(recovered.seenTransactions[first.transactionHash], 210);
  assert.equal(recovered.seenTransactions[rejected.transactionHash], 211);
  assert.equal(recovered.seenTransactions[recovery.transactionHash], 212);
  await restarted.stop();
  await monitor.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("a poisoned empty BSC WAL explicitly recovers through a full barrier before the next save", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-empty-poison-recovery-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  let failNextWalStat = false;
  const journalFsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (file, flags, mode) => {
        const handle = await fs.open(file, flags, mode);
        if (String(file) !== walFile || flags !== "a") return handle;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === "stat") return async () => {
              if (failNextWalStat) {
                failNextWalStat = false;
                throw new Error("simulated empty WAL fstat failure");
              }
              return handleTarget.stat();
            };
            const value = handleTarget[handleProperty];
            return typeof value === "function" ? value.bind(handleTarget) : value;
          },
        });
      };
    },
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    journalFsImpl,
    ...disabledJournalTimerDependencies(),
  });
  await monitor.getState();
  assert.equal((await fs.stat(walFile)).size, 0);
  failNextWalStat = true;
  const rejected = observation({ transactionHash: `0x${"3c".repeat(32)}`, blockNumber: 302 });
  await assert.rejects(() => monitor.observe(rejected), /simulated empty WAL fstat failure/);
  assert.equal((await fs.stat(walFile)).size, 0);
  const recovery = observation({
    launcher: "0x7777777777777777777777777777777777777777",
    token: "0x8777777777777777777777777777777777777777",
    transactionHash: `0x${"3d".repeat(32)}`,
    blockNumber: 303,
  });
  await monitor.observe(recovery);
  const durable = await readBscLaunchpadDurableState(stateFile);
  assert.equal(durable.seenTransactions[rejected.transactionHash], 302);
  assert.equal(durable.seenTransactions[recovery.transactionHash], 303);
  await monitor.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("BSC WAL latest-revision coordinator uses two appends for three concurrent saves and never resolves early", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-latest-revision-"));
  let releaseFirst;
  let releaseSecond;
  let signalFirst;
  let signalSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const firstStarted = new Promise((resolve) => { signalFirst = resolve; });
  const secondStarted = new Promise((resolve) => { signalSecond = resolve; });
  let appends = 0;
  const journalAppendImpl = async (file, frame) => {
    appends += 1;
    if (appends === 1) { signalFirst(); await firstGate; }
    if (appends === 2) { signalSecond(); await secondGate; }
    const handle = await fs.open(file, "a", 0o600);
    try { await handle.writeFile(frame); await handle.sync(); } finally { await handle.close(); }
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    journalAppendImpl,
    ...disabledJournalTimerDependencies(),
  });
  await monitor.getState();
  const samples = [0, 1, 2].map((index) => observation({
    launcher: `0x5${(index + 1).toString(16).padStart(39, "0")}`,
    token: `0x6${(index + 1).toString(16).padStart(39, "0")}`,
    transactionHash: `0x${(index + 20).toString(16).padStart(64, "0")}`,
    blockNumber: 200 + index,
  }));
  let firstSettled = false;
  let secondSettled = false;
  let thirdSettled = false;
  const first = monitor.observe(samples[0]).then((value) => { firstSettled = true; return value; });
  await firstStarted;
  const second = monitor.observe(samples[1]).then((value) => { secondSettled = true; return value; });
  const third = monitor.observe(samples[2]).then((value) => { thirdSettled = true; return value; });
  await monitor.getState();
  assert.equal(appends, 1);
  assert.equal(firstSettled || secondSettled || thirdSettled, false);
  releaseFirst();
  await Promise.all([first, secondStarted]);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled || thirdSettled, false);
  releaseSecond();
  await Promise.all([second, third]);
  assert.equal(appends, 2);
  const durable = await readBscLaunchpadDurableState(path.join(dataDir, "bsc-launchpad-state.json"));
  for (const sample of samples) assert.equal(durable.seenTransactions[sample.transactionHash], sample.blockNumber);
  await monitor.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("BSC WAL detaches only changed operations and defers append-gate mutations to the next frame", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-detached-hot-path-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const coldRecords = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [
    `cold-${index.toString().padStart(4, "0")}`,
    { index, evidence: "c".repeat(256) },
  ]));
  const coldBranch = { marker: "cold-branch-must-not-enter-delta", records: coldRecords };
  const coldBranchBytes = Buffer.byteLength(JSON.stringify(coldBranch));
  assert.ok(coldBranchBytes > 500_000, `cold fixture ${coldBranchBytes} bytes must exercise a large unchanged branch`);
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 6,
    journalRevision: 0,
    initializedAt: "2026-08-24T09:00:00.000Z",
    lastFinalizedBlock: 100,
    realtimeTailNextBlock: 101,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    coldArchive: coldBranch,
  })}\n`, { mode: 0o600 });

  let releaseFirstAppend;
  let signalFirstAppend;
  const firstAppendGate = new Promise((resolve) => { releaseFirstAppend = resolve; });
  const firstAppendStarted = new Promise((resolve) => { signalFirstAppend = resolve; });
  const frames = [];
  const detachedCloneBytes = [];
  const journalAppendImpl = async (file, frame) => {
    frames.push(frame);
    if (frames.length === 1) {
      signalFirstAppend();
      await firstAppendGate;
    }
    const handle = await fs.open(file, "a", 0o600);
    try {
      await handle.writeFile(frame);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    journalAppendImpl,
    journalDetachOperationsImpl: (operations) => {
      detachedCloneBytes.push(Buffer.byteLength(JSON.stringify(operations)));
      return structuredClone(operations);
    },
    ...disabledJournalTimerDependencies(),
  });
  t.after(async () => {
    releaseFirstAppend?.();
    await monitor.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const initialized = await monitor.getState();
  assert.equal(Object.keys(initialized.coldArchive.records).length, 2_000);
  assert.equal(frames.length, 0, "startup must not manufacture a delta for the unchanged cold branch");

  const firstSample = observation({
    launcher: "0x5111111111111111111111111111111111111111",
    token: "0x6111111111111111111111111111111111111111",
    transactionHash: `0x${"4a".repeat(32)}`,
    blockNumber: 401,
  });
  const secondSample = observation({
    launcher: "0x5222222222222222222222222222222222222222",
    token: "0x6222222222222222222222222222222222222222",
    transactionHash: `0x${"4b".repeat(32)}`,
    blockNumber: 402,
  });
  const firstSave = monitor.observe(firstSample);
  await firstAppendStarted;
  const secondSave = monitor.observe(secondSample);
  await waitUntil(async () => Boolean((await monitor.getState()).seenTransactions[secondSample.transactionHash]));
  const liveWhileBlocked = await monitor.getState();
  assert.equal(liveWhileBlocked.seenTransactions[secondSample.transactionHash], secondSample.blockNumber,
    "the second mutation must reach live state while revision one is blocked in append");

  const firstFrame = JSON.parse(frames[0]);
  const firstOperations = JSON.stringify(firstFrame.ops);
  assert.equal(firstFrame.revision, 1);
  assert.match(firstOperations, new RegExp(firstSample.transactionHash));
  assert.doesNotMatch(firstOperations, new RegExp(secondSample.transactionHash),
    "a live mutation after operation detachment must not leak into the blocked frame");
  assert.doesNotMatch(firstOperations, /cold-branch-must-not-enter-delta/);

  releaseFirstAppend();
  await Promise.all([firstSave, secondSave]);
  assert.equal(frames.length, 2);
  const secondFrame = JSON.parse(frames[1]);
  assert.equal(secondFrame.revision, 2);
  assert.match(JSON.stringify(secondFrame.ops), new RegExp(secondSample.transactionHash),
    "the mutation made during revision one append must be persisted by revision two");
  assert.equal(detachedCloneBytes.length, 2, "each WAL revision detaches exactly one changed-operation set");
  const detachedBytes = detachedCloneBytes.reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(detachedBytes < coldBranchBytes * 0.1,
    `changed-operation clones ${detachedBytes} bytes must stay below 10% of the ${coldBranchBytes}-byte cold branch`);

  const recovered = await readBscLaunchpadDurableState(stateFile);
  assert.equal(recovered.journalRevision, 2);
  assert.equal(recovered.seenTransactions[firstSample.transactionHash], firstSample.blockNumber);
  assert.equal(recovered.seenTransactions[secondSample.transactionHash], secondSample.blockNumber);
  assert.equal(recovered.coldArchive.marker, coldBranch.marker);
  assert.equal(Object.keys(recovered.coldArchive.records).length, 2_000);
});

test("BSC WAL compaction runs by 30 seconds and preserves recovery when WAL reset fails", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-compaction-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let clock = Date.parse("2026-08-24T10:00:00.000Z");
  let timerId = 0;
  const timers = new Map();
  const journalSetTimeoutImpl = (callback, delay) => {
    const handle = { id: ++timerId, unref() {} };
    timers.set(handle.id, { handle, callback, dueAt: clock + delay });
    return handle;
  };
  const journalClearTimeoutImpl = (handle) => timers.delete(handle?.id);
  let resetCalls = 0;
  let failReset = false;
  const journalResetImpl = async (file) => {
    resetCalls += 1;
    if (failReset) throw new Error("simulated WAL reset rename failure");
    const handle = await fs.open(file, "w", 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    now: () => clock,
    journalSetTimeoutImpl,
    journalClearTimeoutImpl,
    journalResetImpl,
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, dependencies);
  await monitor.getState();
  const sample = observation({ transactionHash: `0x${"d".repeat(64)}`, blockNumber: 110 });
  await monitor.observe(sample);
  const stale = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(stale.seenTransactions[sample.transactionHash], undefined);
  assert.equal(timers.size, 1);
  clock += 30_000;
  for (const timer of [...timers.values()].filter((entry) => entry.dueAt <= clock)) {
    timers.delete(timer.handle.id);
    timer.callback();
  }
  await monitor.awaitIdle();
  const compacted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(compacted.seenTransactions[sample.transactionHash], 110);
  assert.equal((await fs.readFile(`${stateFile}.wal`)).length, 0);

  const later = observation({
    launcher: "0x10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token: "0x20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    transactionHash: `0x${"e".repeat(64)}`,
    blockNumber: 111,
  });
  await monitor.observe(later);
  failReset = true;
  await assert.rejects(() => monitor.stop(), /simulated WAL reset rename failure/);
  assert.ok(resetCalls >= 2);
  const restarted = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  const recovered = await restarted.getState();
  assert.equal(recovered.seenTransactions[sample.transactionHash], 110);
  assert.equal(recovered.seenTransactions[later.transactionHash], 111,
    "a new snapshot plus an old WAL is idempotent after reset failure");
  await restarted.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("a failed BSC stop barrier destroys providers and a second stop retries the final compaction", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-stop-retry-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let resetCalls = 0;
  let failReset = false;
  let destroyCalls = 0;
  const journalResetImpl = async (file) => {
    resetCalls += 1;
    if (failReset) throw new Error("simulated final WAL reset failure");
    const handle = await fs.open(file, "w", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() { destroyCalls += 1; } },
    logger: { error() {}, info() {} },
    journalResetImpl,
    ...disabledJournalTimerDependencies(),
  });
  await monitor.getState();
  const sample = observation({ transactionHash: `0x${"3e".repeat(32)}`, blockNumber: 304 });
  await monitor.observe(sample);
  failReset = true;
  await assert.rejects(() => monitor.stop(), /simulated final WAL reset failure/);
  assert.equal(destroyCalls, 1, "provider cleanup runs even when the final durability barrier rejects");
  const resetsAfterFailure = resetCalls;

  failReset = false;
  await monitor.stop();
  assert.equal(resetCalls, resetsAfterFailure + 1, "the second stop retries the failed final WAL barrier");
  assert.equal(destroyCalls, 1, "provider destruction stays idempotent across stop retries");
  await monitor.stop();
  assert.equal(resetCalls, resetsAfterFailure + 1, "a successful stop remains cached and idempotent");
  const durable = await readBscLaunchpadDurableState(stateFile);
  assert.equal(durable.seenTransactions[sample.transactionHash], 304);
  assert.equal((await fs.stat(`${stateFile}.wal`)).size, 0);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("BSC WAL reset directory-fsync ambiguity blocks saves until a complete reset barrier succeeds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-reset-ambiguous-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  let clock = Date.parse("2026-08-24T10:30:00.000Z");
  let timerId = 0;
  const timers = new Map();
  const journalSetTimeoutImpl = (callback, delay) => {
    const handle = { id: ++timerId, unref() {} };
    timers.set(handle.id, { handle, callback, dueAt: clock + delay });
    return handle;
  };
  const journalClearTimeoutImpl = (handle) => timers.delete(handle?.id);
  let failWalDirectorySync = false;
  let walRenameAwaitingDirectorySync = false;
  let releaseAmbiguousSync;
  let signalAmbiguousSync;
  const ambiguousSyncGate = new Promise((resolve) => { releaseAmbiguousSync = resolve; });
  const ambiguousSyncStarted = new Promise((resolve) => { signalAmbiguousSync = resolve; });
  const journalFsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === "rename") return async (from, to) => {
        await fs.rename(from, to);
        if (String(to).endsWith(".wal")) walRenameAwaitingDirectorySync = true;
      };
      if (property !== "open") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (file, flags, mode) => {
        const handle = await fs.open(file, flags, mode);
        if (String(file) !== dataDir || flags !== "r") return handle;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === "sync") return async () => {
              if (walRenameAwaitingDirectorySync) {
                walRenameAwaitingDirectorySync = false;
                if (failWalDirectorySync) {
                  signalAmbiguousSync();
                  await ambiguousSyncGate;
                  throw new Error("simulated WAL reset directory fsync failure");
                }
              }
              return handleTarget.sync();
            };
            const value = handleTarget[handleProperty];
            return typeof value === "function" ? value.bind(handleTarget) : value;
          },
        });
      };
    },
  });
  const dependencies = {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    now: () => clock,
    journalFsImpl,
    journalSetTimeoutImpl,
    journalClearTimeoutImpl,
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, dependencies);
  await monitor.getState();
  const first = observation({ transactionHash: `0x${"2a".repeat(32)}`, blockNumber: 220 });
  await monitor.observe(first);
  const oldSnapshot = await fs.readFile(stateFile);
  const oldWal = await fs.readFile(walFile);
  failWalDirectorySync = true;
  clock += 30_000;
  for (const timer of [...timers.values()].filter((entry) => entry.dueAt <= clock)) {
    timers.delete(timer.handle.id);
    timer.callback();
  }
  await ambiguousSyncStarted;
  const blocked = observation({
    launcher: "0x7333333333333333333333333333333333333333",
    token: "0x8333333333333333333333333333333333333333",
    transactionHash: `0x${"2b".repeat(32)}`,
    blockNumber: 221,
  });
  const blockedSave = monitor.observe(blocked);
  releaseAmbiguousSync();
  await assert.rejects(() => blockedSave, /simulated WAL reset directory fsync failure/,
    "a save queued before the ambiguous barrier resolves must still be rejected in the IO lane");
  await monitor.awaitIdle();
  const newSnapshot = await fs.readFile(stateFile);
  const newWal = await fs.readFile(walFile);
  assert.equal(newWal.length, 0, "the ambiguous rename is visible even though its directory barrier failed");

  for (const [name, snapshotBytes, walBytes] of [
    ["old directory entry", oldSnapshot, oldWal],
    ["new directory entry", newSnapshot, newWal],
  ]) {
    const recoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), `bsc-wal-reset-${name.replaceAll(" ", "-")}-`));
    const recoveryState = path.join(recoveryDir, "bsc-launchpad-state.json");
    await fs.writeFile(recoveryState, snapshotBytes, { mode: 0o600 });
    await fs.writeFile(`${recoveryState}.wal`, walBytes, { mode: 0o600 });
    const recovered = await readBscLaunchpadDurableState(recoveryState);
    assert.equal(recovered.seenTransactions[first.transactionHash], 220,
      `${name} must retain every already-resolved revision`);
    await fs.rm(recoveryDir, { recursive: true, force: true });
  }

  failWalDirectorySync = false;
  clock += 30_000;
  for (const timer of [...timers.values()].filter((entry) => entry.dueAt <= clock)) {
    timers.delete(timer.handle.id);
    timer.callback();
  }
  await monitor.awaitIdle();
  const afterRecovery = observation({
    launcher: "0x7444444444444444444444444444444444444444",
    token: "0x8444444444444444444444444444444444444444",
    transactionHash: `0x${"2c".repeat(32)}`,
    blockNumber: 222,
  });
  await monitor.observe(afterRecovery);
  await monitor.stop();
  const restarted = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  const recovered = await restarted.getState();
  assert.equal(recovered.seenTransactions[first.transactionHash], 220);
  assert.equal(recovered.seenTransactions[blocked.transactionHash], 221,
    "the rejected in-memory mutation may become durable only after the barrier recovers");
  assert.equal(recovered.seenTransactions[afterRecovery.transactionHash], 222);
  await restarted.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("legacy BSC initialization recovers a reset directory-barrier ambiguity in the same monitor instance", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-initialize-reset-retry-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const legacyTransaction = `0x${"3a".repeat(32)}`;
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T09:00:00.000Z",
    lastFinalizedBlock: 300,
    realtimeTailNextBlock: 301,
    launchers: {},
    hooks: {},
    seenTransactions: { [legacyTransaction]: 300 },
    coverageGaps: [],
  }), { mode: 0o600 });
  let failFirstWalDirectorySync = true;
  let walRenameAwaitingDirectorySync = false;
  const journalFsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === "rename") return async (from, to) => {
        await fs.rename(from, to);
        if (String(to).endsWith(".wal")) walRenameAwaitingDirectorySync = true;
      };
      if (property !== "open") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (file, flags, mode) => {
        const handle = await fs.open(file, flags, mode);
        if (String(file) !== dataDir || flags !== "r") return handle;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === "sync") return async () => {
              if (walRenameAwaitingDirectorySync) {
                walRenameAwaitingDirectorySync = false;
                if (failFirstWalDirectorySync) {
                  failFirstWalDirectorySync = false;
                  throw new Error("simulated initial WAL directory barrier failure");
                }
              }
              return handleTarget.sync();
            };
            const value = handleTarget[handleProperty];
            return typeof value === "function" ? value.bind(handleTarget) : value;
          },
        });
      };
    },
  });
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    journalFsImpl,
    ...disabledJournalTimerDependencies(),
  });
  await assert.rejects(() => monitor.getState(), /simulated initial WAL directory barrier failure/);
  const recovered = await monitor.getState();
  assert.equal(recovered.seenTransactions[legacyTransaction], 300);
  assert.equal(recovered.lastFinalizedBlock, 300);
  const later = observation({
    launcher: "0x7555555555555555555555555555555555555555",
    token: "0x8555555555555555555555555555555555555555",
    transactionHash: `0x${"3b".repeat(32)}`,
    blockNumber: 301,
  });
  await monitor.observe(later);
  const durable = await readBscLaunchpadDurableState(stateFile);
  assert.equal(durable.seenTransactions[legacyTransaction], 300);
  assert.equal(durable.seenTransactions[later.transactionHash], 301,
    "the successful startup barrier clears only reset ambiguity and re-enables WAL appends");
  await monitor.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("BSC WAL survives every snapshot compaction barrier failure without rolling durable state back", async (t) => {
  for (const phase of ["write", "file fsync", "rename", "directory fsync"]) {
    await t.test(phase, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `bsc-wal-compact-${phase.replaceAll(" ", "-")}-`));
      const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
      let failPhase = false;
      const journalCompactSnapshotImpl = async (file, snapshot) => {
        if (!failPhase) {
          await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
          await fs.chmod(file, 0o600);
          return;
        }
        const temporary = `${file}.${phase.replaceAll(" ", "-")}.tmp`;
        if (phase === "write") throw new Error("simulated snapshot write failure");
        const handle = await fs.open(temporary, "w", 0o600);
        await handle.writeFile(`${JSON.stringify(snapshot)}\n`);
        if (phase === "file fsync") {
          await handle.close();
          throw new Error("simulated snapshot file fsync failure");
        }
        await handle.sync();
        await handle.close();
        if (phase === "rename") throw new Error("simulated snapshot rename failure");
        await fs.rename(temporary, file);
        throw new Error("simulated snapshot directory fsync failure");
      };
      const monitor = createBscLaunchpadMonitor({ dataDir }, {
        autoStart: false,
        provider: { destroy() {} },
        logger: { error() {}, info() {} },
        journalCompactSnapshotImpl,
        ...disabledJournalTimerDependencies(),
      });
      await monitor.getState();
      const sample = observation({
        launcher: `0x3${phase.length.toString(16).padStart(39, "0")}`,
        token: `0x4${phase.length.toString(16).padStart(39, "0")}`,
        transactionHash: `0x${phase.length.toString(16).padStart(64, "0")}`,
        blockNumber: 120 + phase.length,
      });
      await monitor.observe(sample);
      failPhase = true;
      await assert.rejects(() => monitor.stop(), /simulated snapshot/);
      const restarted = createBscLaunchpadMonitor({ dataDir }, {
        autoStart: false,
        provider: { destroy() {} },
        logger: { error() {}, info() {} },
        ...disabledJournalTimerDependencies(),
      });
      const recovered = await restarted.getState();
      assert.equal(recovered.seenTransactions[sample.transactionHash], sample.blockNumber);
      await restarted.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
  }
});

test("BSC WAL cuts physical state bytes by more than 90 percent for two minutes of durable mutations", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-wal-byte-budget-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const filler = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [
    `0x${index.toString(16).padStart(40, "0")}`,
    { address: `0x${index.toString(16).padStart(40, "0")}`, evidence: "x".repeat(256) },
  ]));
  await fs.writeFile(stateFile, JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T09:00:00.000Z",
    lastFinalizedBlock: 100,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    discoverySources: { external: { contracts: filler } },
  }));
  let clock = Date.parse("2026-08-24T11:00:00.000Z");
  let timerId = 0;
  const timers = new Map();
  const journalSetTimeoutImpl = (callback, delay) => {
    const handle = { id: ++timerId, unref() {} };
    timers.set(handle.id, { handle, callback, dueAt: clock + delay });
    return handle;
  };
  const journalClearTimeoutImpl = (handle) => timers.delete(handle?.id);
  let physicalBytes = 0;
  const journalAppendImpl = async (file, frame) => {
    physicalBytes += Buffer.byteLength(frame);
    const handle = await fs.open(file, "a", 0o600);
    try { await handle.writeFile(frame); await handle.sync(); } finally { await handle.close(); }
  };
  const journalCompactSnapshotImpl = async (file, snapshot) => {
    const payload = `${JSON.stringify(snapshot)}\n`;
    physicalBytes += Buffer.byteLength(payload);
    await fs.writeFile(file, payload, { mode: 0o600 });
    await fs.chmod(file, 0o600);
  };
  const journalResetImpl = async (file) => {
    const handle = await fs.open(file, "w", 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const monitor = createBscLaunchpadMonitor({ dataDir }, {
    autoStart: false,
    provider: { destroy() {} },
    logger: { error() {}, info() {} },
    now: () => clock,
    forceJournalPersistence: true,
    journalAppendImpl,
    journalCompactSnapshotImpl,
    journalResetImpl,
    journalSetTimeoutImpl,
    journalClearTimeoutImpl,
  });
  await monitor.getState();
  const fullSnapshotBytes = (await fs.stat(stateFile)).size;
  physicalBytes = 0;
  for (let index = 0; index < 120; index += 1) {
    clock += 1_000;
    await monitor.observe(observation({
      launcher: `0x1${index.toString(16).padStart(39, "0")}`,
      token: `0x2${index.toString(16).padStart(39, "0")}`,
      transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      blockNumber: 1_000 + index,
    }));
    for (const timer of [...timers.values()].filter((entry) => entry.dueAt <= clock)) {
      timers.delete(timer.handle.id);
      timer.callback();
    }
    await monitor.awaitIdle();
  }
  const wholeSnapshotBaseline = fullSnapshotBytes * 120;
  assert.ok(physicalBytes < wholeSnapshotBaseline * 0.1,
    `WAL plus four 30-second snapshots ${physicalBytes} must be <10% of ${wholeSnapshotBaseline}`);
  await monitor.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function createBscWebsocketProofHarness(t, {
  proofResponder = null,
  proofTimeoutMs = 1_250,
  failDeepProof = false,
  providerSend = null,
  providerGetBlock = null,
  healthyRealtimeLogs = false,
  monitorScope = "focus3",
  dependencyOverrides = {},
} = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-ws-proof-fast-path-"));
  const ingressAt = Date.parse("2026-08-24T12:00:00.000Z");
  let clock = ingressAt;
  let currentHead = 101;
  const blockNumber = 101;
  const blockHash = `0x${"b".repeat(64)}`;
  const launcher = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
  const vaultFactory = "0x6666666666666666666666666666666666666666";
  const vault = "0x7777777777777777777777777777777777777777";
  const creator = "0x8888888888888888888888888888888888888888";
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: new Date(ingressAt - 60 * 60_000).toISOString(),
    lastFinalizedBlock: 99,
    realtimeTailNextBlock: 100,
    launchers: {},
    hooks: {},
    seenTransactions: {},
    transactionFailures: {},
    deferredCreationEvidence: {},
    coverageGaps: [],
  }));
  const iface = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
  const proofs = new Map();
  const alerts = [];
  const alertTimes = [];
  const errors = [];
  const httpCalls = {
    transaction: 0,
    receipt: 0,
    block: 0,
    blockNumbers: [],
    blockReceipts: 0,
    getCode: 0,
    getLogs: 0,
  };
  const sockets = [];

  const addCandidate = ({
    transactionHash = `0x${"a".repeat(64)}`,
    token = "0x1111111111111111111111111111111111111111",
    transactionIndex = proofs.size,
    removed = false,
    candidateVaultFactory = vaultFactory,
    candidateBlockNumber = blockNumber,
    candidateBlockHash = blockHash,
  } = {}) => {
    const encoded = iface.encodeEventLog(iface.getEvent("FlapTaxVaultTokenCreated"), [token, vault, candidateVaultFactory]);
    const quantityIndex = `0x${transactionIndex.toString(16)}`;
    const log = {
      address: launcher,
      topics: encoded.topics,
      data: encoded.data,
      transactionHash,
      blockNumber: `0x${candidateBlockNumber.toString(16)}`,
      blockHash: candidateBlockHash,
      transactionIndex: quantityIndex,
      logIndex: quantityIndex,
      removed,
    };
    const transaction = {
      hash: transactionHash,
      blockNumber: log.blockNumber,
      blockHash: candidateBlockHash,
      transactionIndex: quantityIndex,
      from: creator,
      to: launcher,
      input: `0x8cb5772c${"0".repeat(64)}`,
      value: "0x0",
    };
    const receipt = {
      transactionHash,
      blockNumber: log.blockNumber,
      blockHash: candidateBlockHash,
      transactionIndex: quantityIndex,
      from: creator,
      to: launcher,
      status: "0x1",
      logs: [log],
    };
    const proof = {
      transactionHash,
      token,
      log,
      transaction,
      receipt,
      transactionIndex,
      blockNumber: candidateBlockNumber,
      blockHash: candidateBlockHash,
    };
    proofs.set(transactionHash, proof);
    return proof;
  };

  const buildBlock = (requestedBlockNumber = blockNumber) => {
    const matchingProofs = [...proofs.values()]
      .filter((proof) => proof.blockNumber === Number(requestedBlockNumber));
    const transactions = matchingProofs
      .sort((left, right) => left.transactionIndex - right.transactionIndex)
      .map((proof) => proof.transactionHash);
    return {
      number: `0x${Number(requestedBlockNumber).toString(16)}`,
      hash: matchingProofs[0]?.blockHash || blockHash,
      timestamp: `0x${Math.floor(ingressAt / 1_000).toString(16)}`,
      transactions,
    };
  };

  const provider = {
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return currentHead; },
    async getLogs() { httpCalls.getLogs += 1; return []; },
    async send(method, params) {
      if (method === "eth_getLogs") httpCalls.getLogs += 1;
      if (method === "eth_getBlockReceipts") httpCalls.blockReceipts += 1;
      if (providerSend) return providerSend({ method, params, proofs, buildBlock });
      throw new Error(`BSC websocket harness has no ${method} response`);
    },
    async getTransaction() {
      httpCalls.transaction += 1;
      const error = new Error("eth_getTransaction failed on every BSC RPC: providers cooling down");
      error.code = "SERVER_ERROR";
      error.retryAfterMs = 60_000;
      throw error;
    },
    async getTransactionReceipt() {
      httpCalls.receipt += 1;
      const error = new Error("eth_getTransactionReceipt failed on every BSC RPC: providers cooling down");
      error.code = "SERVER_ERROR";
      error.retryAfterMs = 60_000;
      throw error;
    },
    async getBlock(number) {
      httpCalls.block += 1;
      httpCalls.blockNumbers.push(Number(number));
      if (providerGetBlock) return providerGetBlock({ number: Number(number), proofs, buildBlock });
      const raw = buildBlock(Number(number));
      return {
        ...raw,
        number: Number(number),
        timestamp: Number.parseInt(raw.timestamp, 16),
      };
    },
    async getCode(address) {
      httpCalls.getCode += 1;
      if (failDeepProof) throw new Error("runtime profile RPC unavailable");
      return String(address).toLowerCase() === launcher
        ? `0x${"6000".repeat(400)}`
        : `0x${"6000".repeat(300)}`;
    },
    async getStorage() { return "0x"; },
    async call() { return "0x"; },
    destroy() {},
  };

  class ProofWebSocket {
    constructor() {
      this.handlers = new Map();
      this.subscriptions = new Map();
      this.proofRequests = [];
      this.closeCalls = 0;
      sockets.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const handlers = this.handlers.get(kind) || [];
      handlers.push(handler);
      this.handlers.set(kind, handlers);
    }
    emit(kind, event) {
      for (const handler of this.handlers.get(kind) || []) handler(event);
    }
    emitMessage(message) {
      this.emit("message", { data: JSON.stringify(message) });
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.method === "eth_subscribe") {
        const kind = request.params[0] === "newHeads" ? "heads" : "protocol";
        const subscription = `sub-${kind}-${request.id}`;
        this.subscriptions.set(kind, subscription);
        queueMicrotask(() => this.emitMessage({ jsonrpc: "2.0", id: request.id, result: subscription }));
        return;
      }
      this.proofRequests.push(request);
      const transactionHash = request.params?.[0];
      const proof = proofs.get(transactionHash);
      let result;
      if (request.method === "eth_getTransactionByHash") result = proof?.transaction || null;
      else if (request.method === "eth_getTransactionReceipt") result = proof?.receipt || null;
      else if (request.method === "eth_getBlockByNumber") {
        result = buildBlock(Number.parseInt(request.params?.[0], 16));
      }
      const respond = (message = { jsonrpc: "2.0", id: request.id, result }) => {
        queueMicrotask(() => this.emitMessage(message));
      };
      if (proofResponder) proofResponder({ request, result, proof, socket: this, respond, buildBlock });
      else respond();
    }
    emitSubscription(kind, result) {
      this.emitMessage({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: this.subscriptions.get(kind), result },
      });
    }
    close() {
      this.closeCalls += 1;
    }
  }

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    text: async () => JSON.stringify({ code: 0, data: [] }),
  });
  const config = {
    dataDir,
    monitorScope,
    blockedContracts: new Set(),
    bscMonitorEnabled: true,
    bscWsUrl: "wss://example.invalid",
    bscRpcUrl: "https://example.invalid",
    bscConfirmations: 2,
    bscHttpHeadPollIntervalMs: 60_000,
    bscOfficialPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
    bscWebsocketProofTimeoutMs: proofTimeoutMs,
  };
  const dependencies = {
    autoStart: false,
    externalAttribution: false,
    provider,
    realtimeTailMinIntervalMsForTesting: 0,
    ...(healthyRealtimeLogs ? {
      realtimeProvider: {
        ...provider,
        async send(method, params) {
          if (method === "eth_getLogs") {
            httpCalls.getLogs += 1;
            return [];
          }
          return provider.send(method, params);
        },
      },
    } : {}),
    WebSocketImpl: ProofWebSocket,
    fetchImpl,
    now: () => clock,
    logger: { error(message) { errors.push(String(message)); }, info() {} },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      alertTimes.push(clock);
      return { status: "delivered", eventId: event.eventKey };
    },
    ...dependencyOverrides,
  };
  const monitor = createBscLaunchpadMonitor(config, dependencies);
  t.after(async () => {
    await monitor.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.getState();
  assert.equal(await monitor.registerFlapFeatureActivations([{
    pool: {
      identity: `vault:INDEX:${vaultFactory}`,
      category: "INDEX",
      vaultFactory,
      sourceUrl: "https://flap.sh/board",
    },
    confirmed: true,
    observations: 2,
    firstObservedAt: new Date(ingressAt - 30_000).toISOString(),
    confirmedAt: new Date(ingressAt - 1_000).toISOString(),
    observedAt: new Date(ingressAt - 1_000).toISOString(),
  }]), 1);
  await monitor.start();
  await waitUntil(() => sockets[0]?.subscriptions.has("heads") && sockets[0]?.subscriptions.has("protocol"));
  assert.ok(sockets[0]?.subscriptions.has("protocol"));

  return {
    dataDir,
    config,
    dependencies,
    monitor,
    provider,
    ProofWebSocket,
    sockets,
    proofs,
    alerts,
    alertTimes,
    errors,
    httpCalls,
    ingressAt,
    blockNumber,
    blockHash,
    launcher,
    vaultFactory,
    addCandidate,
    buildBlock,
    clock: () => clock,
    advance(ms) { clock += ms; },
    setHead(value) { currentHead = value; },
    emitHead(value) {
      currentHead = value;
      sockets[0].emitSubscription("heads", { number: `0x${value.toString(16)}` });
    },
    emitCandidate(proof) { sockets[0].emitSubscription("protocol", proof.log); },
  };
}

test("BSC WebSocket fast proof waits for confirmations, routes mixed responses, and sends through the unified path", async (t) => {
  let releaseBlockProof;
  const blockProofGate = new Promise((resolve) => { releaseBlockProof = resolve; });
  t.after(() => releaseBlockProof());
  const harness = await createBscWebsocketProofHarness(t, {
    proofResponder({ request, result, respond }) {
      // Hold the canonical block beyond the 150ms coverage timer. The block
      // generation reservation must make coverage wait instead of starting a
      // parallel HTTP getBlock for the same proof block.
      if (request.method === "eth_getBlockByNumber") {
        void blockProofGate.then(() => respond({ jsonrpc: "2.0", id: request.id, result }));
        return;
      }
      respond({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  const proof = harness.addCandidate();
  const socket = harness.sockets[0];
  harness.emitCandidate(proof);
  socket.emitMessage({ jsonrpc: "2.0", id: 999_999, result: "ignored" });
  await waitUntil(() => socket.proofRequests.length === 2);
  assert.deepEqual(socket.proofRequests.map((request) => request.method).sort(), [
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
  ]);
  assert.equal(socket.closeCalls, 0);
  harness.advance(700);
  harness.emitHead(102);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.proofRequests.length, 2, "head N+1 must not fetch the canonical block yet");
  harness.advance(800);
  harness.emitHead(103);
  await waitUntil(() => harness.httpCalls.getLogs > 0);
  assert.equal(
    harness.httpCalls.blockNumbers.includes(harness.blockNumber),
    false,
    "coverage must not start an HTTP read while the WS block generation is pending",
  );
  releaseBlockProof();
  await waitUntil(() => harness.alerts.length === 1);
  await harness.monitor.awaitIdle();
  const successSnapshot = await harness.monitor.getState();
  assert.equal(harness.alerts.length, 1, JSON.stringify({
    proofRequests: socket.proofRequests.map((request) => request.method),
    pending: successSnapshot.realtimePendingEntries?.[proof.transactionHash] || null,
    deferred: successSnapshot.deferredCreationEvidence?.[proof.transactionHash] || null,
    failures: successSnapshot.transactionFailures?.[proof.transactionHash] || null,
    seen: successSnapshot.seenTransactions?.[proof.transactionHash] || null,
    httpCalls: harness.httpCalls,
    errors: harness.errors,
  }));
  assert.equal(socket.proofRequests.length, 3);
  assert.equal(socket.proofRequests[2].method, "eth_getBlockByNumber");
  assert.deepEqual(socket.proofRequests[2].params, ["0x65", false]);
  assert.equal(harness.alerts[0].featureFirstToken, true);
  assert.equal(harness.alerts[0].featurePlatform, "flap");
  assert.equal(harness.alerts[0].transactionHash, proof.transactionHash);
  assert.equal(harness.alerts[0].deliverySla.startedAt, new Date(harness.ingressAt).toISOString());
  assert.ok(harness.alertTimes[0] - harness.ingressAt < 5_000);
  assert.equal(harness.httpCalls.transaction, 0);
  assert.equal(harness.httpCalls.receipt, 0);
  assert.equal(
    harness.httpCalls.blockNumbers.includes(harness.blockNumber),
    false,
    "the post-confirmation WS block proof must feed every shared block consumer",
  );
  const snapshot = successSnapshot;
  assert.equal(snapshot.seenTransactions[proof.transactionHash], harness.blockNumber);
  assert.equal(snapshot.realtimePendingEntries[proof.transactionHash], undefined);
  const firstRequest = socket.proofRequests[0];
  socket.emitMessage({ jsonrpc: "2.0", id: firstRequest.id, result: firstRequest.method === "eth_getTransactionByHash" ? proof.transaction : proof.receipt });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.alerts.length, 1, "a duplicate response id is ignored after its exact waiter is settled");
  assert.equal(harness.sockets.length, 1);
});

test("BSC WebSocket fast proof cannot overtake an earlier durable feature candidate", async (t) => {
  const earlierHash = `0x${"c1".repeat(32)}`;
  const laterHash = `0x${"c2".repeat(32)}`;
  let failEarlierReceipt = true;
  const harness = await createBscWebsocketProofHarness(t, {
    proofResponder({ request, result, proof, respond }) {
      if (proof?.transactionHash === earlierHash
        && request.method === "eth_getTransactionReceipt"
        && failEarlierReceipt) {
        respond({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "temporary receipt outage" } });
        return;
      }
      respond({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  const earlier = harness.addCandidate({ transactionHash: earlierHash, transactionIndex: 0 });
  const later = harness.addCandidate({ transactionHash: laterHash, transactionIndex: 1 });
  const socket = harness.sockets[0];
  harness.emitCandidate(earlier);
  await waitUntil(async () => Boolean((await harness.monitor.getState()).realtimePendingEntries?.[earlierHash]));
  await waitUntil(() => socket.proofRequests.filter((request) => request.params?.[0] === earlierHash).length >= 2);

  harness.emitCandidate(later);
  await waitUntil(async () => Boolean((await harness.monitor.getState()).realtimePendingEntries?.[laterHash]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(socket.proofRequests.some((request) => request.params?.[0] === laterHash), false,
    "a later five-second candidate is durable but starts no proof while its causal head is pending");
  assert.equal(harness.alerts.length, 0);

  failEarlierReceipt = false;
  harness.emitCandidate(earlier);
  await waitUntil(() => socket.proofRequests.filter((request) => request.params?.[0] === earlierHash).length >= 4);
  harness.advance(1_000);
  harness.emitHead(103);
  await waitUntil(() => harness.alerts.length === 1);
  assert.equal(harness.alerts[0].transactionHash, earlierHash);
  harness.emitCandidate(later);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(harness.alerts.length, 1, "the later transaction cannot replace the first feature token after the head succeeds");
});

test("BSC causal reservation sees an earlier official candidate handed off immediately before the final claim", async (t) => {
  const earlierHash = `0x${"d1".repeat(32)}`;
  const laterHash = `0x${"d2".repeat(32)}`;
  let harness;
  let earlier;
  let injected = false;
  harness = await createBscWebsocketProofHarness(t, {
    dependencyOverrides: {
      async beforeCausalGroupReservationImpl({ transactionHash, claim }) {
        if (transactionHash !== laterHash || claim !== "observation" || injected) return;
        injected = true;
        harness.emitCandidate(earlier);
        await waitUntil(async () => Boolean(
          (await harness.monitor.getState()).realtimePendingEntries?.[earlierHash],
        ));
      },
    },
  });
  earlier = harness.addCandidate({ transactionHash: earlierHash, transactionIndex: 0 });
  const later = harness.addCandidate({ transactionHash: laterHash, transactionIndex: 1 });
  harness.emitCandidate(later);
  harness.advance(1_500);
  harness.emitHead(103);
  await waitUntil(() => injected);
  await waitUntil(async () => Boolean(
    (await harness.monitor.getState()).realtimePendingEntries?.[laterHash],
  ));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(harness.alerts.length, 0,
    "the later candidate cannot alert after an earlier raw-evidence handoff wins before reservation");

  await waitUntil(async () => Boolean(
    (await harness.monitor.getState()).transactionFailures?.[laterHash],
  ));
  await new Promise((resolve) => setImmediate(resolve));
  harness.emitCandidate(earlier);
  await waitUntil(() => harness.alerts.length === 1);
  const finalSnapshot = await harness.monitor.getState();
  assert.equal(harness.alerts.length, 1, JSON.stringify({
    pending: finalSnapshot.realtimePendingEntries,
    deferred: finalSnapshot.deferredCreationEvidence,
    failures: finalSnapshot.transactionFailures,
    seen: finalSnapshot.seenTransactions,
    proofRequests: harness.sockets[0].proofRequests.map((request) => ({
      method: request.method,
      transactionHash: request.params?.[0],
    })),
    errors: harness.errors,
  }));
  assert.equal(harness.alerts[0].transactionHash, earlierHash);
  await harness.monitor.awaitIdle();
  assert.equal(harness.alerts.some((event) => event.transactionHash === laterHash), false);
});

test("stop aborts coverage waiting on a WS block reservation without starting a new HTTP read", async (t) => {
  let releaseBlockProof;
  const blockProofGate = new Promise((resolve) => { releaseBlockProof = resolve; });
  const neverSettles = new Promise(() => {});
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => {
    releaseBlockProof();
    process.off("unhandledRejection", onUnhandled);
  });
  const harness = await createBscWebsocketProofHarness(t, {
    proofResponder({ request, result, respond }) {
      if (request.method === "eth_getBlockByNumber") {
        void blockProofGate.then(() => respond({ jsonrpc: "2.0", id: request.id, result }));
        return;
      }
      respond({ jsonrpc: "2.0", id: request.id, result });
    },
    providerGetBlock({ number, buildBlock }) {
      if (number === 101) return neverSettles;
      const raw = buildBlock(number);
      return { ...raw, number, timestamp: Number.parseInt(raw.timestamp, 16) };
    },
  });
  const proof = harness.addCandidate({ transactionIndex: 0 });
  harness.emitCandidate(proof);
  await waitUntil(() => harness.sockets[0].proofRequests.length === 2);
  harness.advance(1_500);
  harness.emitHead(103);
  await waitUntil(() => harness.sockets[0].proofRequests.length === 3);
  await waitUntil(() => harness.httpCalls.blockReceipts > 0);
  const beforeStop = await harness.monitor.getState();
  assert.equal(beforeStop.lastFinalizedBlock, 99);
  assert.ok(beforeStop.realtimePendingEntries[proof.transactionHash]);

  let timeout;
  const startedAt = Date.now();
  try {
    await Promise.race([
      harness.monitor.stop(),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("BSC stop exceeded 750ms")), 750);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.ok(Date.now() - startedAt < 750);
  assert.equal(
    harness.httpCalls.blockNumbers.filter((number) => number === 101).length,
    0,
    "stop must not replace the failed WS reservation with a new HTTP generation",
  );
  releaseBlockProof();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);

  const durable = await readBscLaunchpadDurableState(path.join(harness.dataDir, "bsc-launchpad-state.json"));
  assert.equal(durable.lastFinalizedBlock, 99, "shutdown must not advance the coverage cursor");
  assert.equal(durable.seenTransactions[proof.transactionHash], undefined);
  assert.ok(durable.realtimePendingEntries[proof.transactionHash], "the durable candidate must remain restartable");
});

test("late HTTP block failures cannot evict newer WS generations under concurrent pressure", async (t) => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  await Promise.all(Array.from({ length: 4 }, async (_, round) => {
    let proof;
    let rejectOldBlock;
    let signalOldBlockStarted;
    const oldBlockStarted = new Promise((resolve) => { signalOldBlockStarted = resolve; });
    const oldBlock = new Promise((_resolve, reject) => { rejectOldBlock = reject; });
    const harness = await createBscWebsocketProofHarness(t, {
      monitorScope: "legacy",
      healthyRealtimeLogs: true,
      providerSend({ method, params }) {
        if (method === "eth_getLogs") throw new Error("force verified receipt fallback");
        if (method === "eth_getBlockReceipts") {
          const requested = Number.parseInt(params[0], 16);
          return requested === 101 ? [proof.receipt] : [];
        }
        throw new Error(`unexpected ${method}`);
      },
      providerGetBlock({ number, buildBlock }) {
        if (number === 101) {
          signalOldBlockStarted();
          return oldBlock;
        }
        const raw = buildBlock(number);
        return { ...raw, number, timestamp: Number.parseInt(raw.timestamp, 16) };
      },
    });
    const nibble = (10 + round).toString(16);
    proof = harness.addCandidate({
      transactionHash: `0x${nibble.repeat(64)}`,
      token: `0x${nibble.repeat(40)}`,
      transactionIndex: 0,
    });

    // This cache-generation regression intentionally uses the legacy recovery
    // path, where a filter failure may still expand into verified block reads.
    // Focus3 ranges are covered separately and now fail closed on any filter
    // failure, so they can no longer construct this older fallback race.
    await harness.monitor.awaitIdle();
    await completeRealtimeTailPasses(harness.monitor, 2);
    // Start coverage first so its old HTTP generation is genuinely pending.
    harness.emitHead(103);
    await oldBlockStarted;
    harness.emitCandidate(proof);
    await waitUntil(() => harness.alerts.length === 1);
    assert.equal(
      harness.httpCalls.blockNumbers.filter((number) => number === 101).length,
      1,
      "the pending pre-proof HTTP generation is the only HTTP read",
    );
    rejectOldBlock(new Error(`late old-generation failure ${round}`));
    await harness.monitor.awaitIdle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      harness.httpCalls.blockNumbers.filter((number) => number === 101).length,
      1,
      "a late rejection must not delete the verified WS generation or trigger another read",
    );
    const snapshot = await harness.monitor.getState();
    assert.equal(snapshot.seenTransactions[proof.transactionHash], 101);
  }));

  assert.deepEqual(unhandled, []);
});

test("coverage invalidates one stale WS block generation and refreshes the fork exactly once", async (t) => {
  let proof;
  let releaseLogRange;
  let signalLogRangeStarted;
  const logRangeGate = new Promise((resolve) => { releaseLogRange = resolve; });
  const logRangeStarted = new Promise((resolve) => { signalLogRangeStarted = resolve; });
  t.after(() => releaseLogRange());
  const refreshedBlockHash = `0x${"c".repeat(64)}`;
  const harness = await createBscWebsocketProofHarness(t, {
    monitorScope: "legacy",
    healthyRealtimeLogs: true,
    async providerSend({ method, params }) {
      if (method === "eth_getLogs") {
        signalLogRangeStarted();
        await logRangeGate;
        throw new Error("force block receipt recovery after WS publish");
      }
      if (method === "eth_getBlockReceipts") {
        const requested = Number.parseInt(params[0], 16);
        if (requested !== 101) return [];
        return [{
          ...proof.receipt,
          blockHash: refreshedBlockHash,
          logs: [],
        }];
      }
      throw new Error(`unexpected ${method}`);
    },
    providerGetBlock({ number, buildBlock }) {
      if (number === 101) {
        return {
          number,
          hash: refreshedBlockHash,
          timestamp: Math.floor(Date.parse("2026-08-24T12:00:00.000Z") / 1_000),
          transactions: [proof.transactionHash],
        };
      }
      const raw = buildBlock(number);
      return { ...raw, number, timestamp: Number.parseInt(raw.timestamp, 16), transactions: [] };
    },
  });
  proof = harness.addCandidate({ transactionIndex: 0 });
  await harness.monitor.awaitIdle();
  await completeRealtimeTailPasses(harness.monitor, 2);
  harness.emitCandidate(proof);
  harness.advance(1_500);
  harness.emitHead(103);
  await waitUntil(() => harness.alerts.length === 1);
  await logRangeStarted;
  assert.equal(
    harness.httpCalls.blockNumbers.includes(101),
    false,
    "coverage must initially read the strictly verified WS generation",
  );

  releaseLogRange();
  await waitUntil(() => harness.httpCalls.blockReceipts > 0);
  await harness.monitor.awaitIdle();
  assert.equal(
    harness.httpCalls.blockNumbers.filter((number) => number === 101).length,
    1,
    "an old-fork hash mismatch must trigger exactly one shared HTTP refresh",
  );
  const snapshot = await harness.monitor.getState();
  assert.equal(snapshot.lastFinalizedBlock, 101);
  assert.equal(snapshot.seenTransactions[proof.transactionHash], 101);
});

test("BSC WebSocket fast proof failures retain the durable HTTP pending item without reconnecting", async (t) => {
  const scenarios = [
    {
      name: "receipt hash mismatch",
      responder({ request, result, respond }) {
        respond({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_getTransactionReceipt"
          ? { ...result, transactionHash: `0x${"f".repeat(64)}` }
          : result });
      },
      confirm: true,
    },
    {
      name: "block position mismatch",
      responder({ request, result, respond }) {
        respond({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_getBlockByNumber"
          ? { ...result, transactions: [`0x${"f".repeat(64)}`] }
          : result });
      },
      confirm: true,
    },
    {
      name: "block hash mismatch",
      responder({ request, result, respond }) {
        respond({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_getBlockByNumber"
          ? { ...result, hash: `0x${"e".repeat(64)}` }
          : result });
      },
      confirm: true,
    },
    {
      name: "removed trigger",
      removed: true,
      confirm: true,
    },
    {
      name: "JSON-RPC error",
      responder({ request, result, respond }) {
        respond(request.method === "eth_getTransactionReceipt"
          ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "unavailable" } }
          : { jsonrpc: "2.0", id: request.id, result });
      },
    },
    {
      name: "invalid JSON-RPC envelope",
      responder({ request, result, respond }) {
        respond(request.method === "eth_getTransactionReceipt"
          ? { jsonrpc: "1.0", id: request.id, result }
          : { jsonrpc: "2.0", id: request.id, result });
      },
    },
    {
      name: "timeout",
      timeout: true,
      responder({ request, result, respond }) {
        if (request.method !== "eth_getTransactionReceipt") respond({ jsonrpc: "2.0", id: request.id, result });
      },
    },
    {
      name: "socket error",
      responder() {},
      afterRequests(harness) { harness.sockets[0].emit("error", {}); },
    },
    {
      name: "socket close",
      responder() {},
      afterRequests(harness) { harness.sockets[0].emit("close", {}); },
    },
  ];

  for (const scenario of scenarios) await t.test(scenario.name, async (st) => {
    const harness = await createBscWebsocketProofHarness(st, {
      proofResponder: scenario.responder || null,
      proofTimeoutMs: scenario.timeout ? 10 : 1_250,
    });
    const proof = harness.addCandidate({ removed: scenario.removed === true });
    harness.emitCandidate(proof);
    await waitUntil(() => harness.sockets[0].proofRequests.length >= 2);
    scenario.afterRequests?.(harness);
    if (scenario.confirm) harness.emitHead(103);
    await new Promise((resolve) => setTimeout(resolve, scenario.timeout ? 15 : 5));
    await harness.monitor.stop();
    const snapshot = await harness.monitor.getState();
    const pending = snapshot.realtimePendingEntries[proof.transactionHash];
    assert.ok(pending, "the HTTP fallback must remain restart-durable");
    assert.deepEqual(pending.deliverySla, {
      startedAt: new Date(harness.ingressAt).toISOString(),
      deadlineAt: new Date(harness.ingressAt + 5_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "bsc_websocket_ingest",
    });
    assert.equal(snapshot.seenTransactions[proof.transactionHash], undefined);
    assert.equal(snapshot.deferredCreationEvidence[proof.transactionHash], undefined);
    assert.equal(snapshot.transactionFailures[proof.transactionHash], undefined);
    assert.equal(snapshot.lastFinalizedBlock, 99);
    assert.equal(snapshot.realtimeTailNextBlock, 100);
    assert.deepEqual(snapshot.coverageGaps, []);
    assert.equal(harness.alerts.length, 0);
    assert.equal(harness.httpCalls.transaction, 0);
    assert.equal(harness.httpCalls.receipt, 0);
    assert.equal(harness.sockets.length, 1, "an individual proof failure must not reconnect the socket");
  });
});

test("BSC WebSocket fast proof is single-flight, does not queue busy candidates, and preserves both for HTTP", async (t) => {
  const held = [];
  const harness = await createBscWebsocketProofHarness(t, {
    proofResponder({ request, result, respond }) { held.push({ request, result, respond }); },
  });
  const first = harness.addCandidate({ transactionHash: `0x${"1".repeat(64)}`, transactionIndex: 0 });
  const second = harness.addCandidate({
    transactionHash: `0x${"2".repeat(64)}`,
    token: "0x2222222222222222222222222222222222222222",
    transactionIndex: 1,
  });
  harness.emitCandidate(first);
  await waitUntil(() => harness.sockets[0].proofRequests.length === 2);
  harness.emitCandidate(second);
  await waitUntil(async () => Object.keys((await harness.monitor.getState()).realtimePendingEntries || {}).length === 2);
  assert.equal(harness.sockets[0].proofRequests.length, 2);
  assert.ok(harness.sockets[0].proofRequests.every((request) => request.params[0] === first.transactionHash));
  await harness.monitor.stop();
  const snapshot = await harness.monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[first.transactionHash]);
  assert.ok(snapshot.realtimePendingEntries[second.transactionHash]);
  assert.equal(harness.alerts.length, 0);
});

test("an ordinary Flap creation outside the unresolved feature does not spend any WS proof request", async (t) => {
  const harness = await createBscWebsocketProofHarness(t);
  const proof = harness.addCandidate({
    candidateVaultFactory: "0x9999999999999999999999999999999999999999",
  });
  harness.emitCandidate(proof);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.sockets[0].proofRequests.length, 0);
  assert.equal(harness.alerts.length, 0);
  await harness.monitor.stop();
});

test("stale WS candidates and restored durable backlog never issue WebSocket proof RPCs", async (t) => {
  const harness = await createBscWebsocketProofHarness(t);
  const proof = harness.addCandidate();
  harness.emitCandidate(proof);
  harness.advance(5_000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await harness.monitor.stop();
  assert.equal(harness.sockets[0].proofRequests.length, 0);
  let snapshot = await harness.monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[proof.transactionHash]);
  const originalDeadline = snapshot.realtimePendingEntries[proof.transactionHash].deliverySla.deadlineAt;

  const restartSockets = [];
  class RestartWebSocket {
    constructor() {
      this.handlers = new Map();
      this.proofRequests = [];
      restartSockets.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(kind, handler) {
      const values = this.handlers.get(kind) || [];
      values.push(handler);
      this.handlers.set(kind, values);
    }
    emit(kind, event) { for (const handler of this.handlers.get(kind) || []) handler(event); }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.method !== "eth_subscribe") this.proofRequests.push(request);
      else queueMicrotask(() => this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: `restart-${request.id}` }) }));
    }
    close() {}
  }
  const restarted = createBscLaunchpadMonitor(harness.config, {
    ...harness.dependencies,
    WebSocketImpl: RestartWebSocket,
    now: () => harness.clock(),
  });
  t.after(() => restarted.stop());
  await restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restartSockets[0].proofRequests.length, 0);
  snapshot = await restarted.getState();
  assert.ok(snapshot.realtimePendingEntries[proof.transactionHash]);
  assert.equal(snapshot.realtimePendingEntries[proof.transactionHash].deliverySla.deadlineAt, originalDeadline);
  await restarted.stop();
});

test("a post-receipt deep-proof failure leaves WS pending, retry and coverage state untouched", async (t) => {
  const harness = await createBscWebsocketProofHarness(t, { failDeepProof: true });
  const proof = harness.addCandidate();
  harness.emitCandidate(proof);
  await waitUntil(() => harness.sockets[0].proofRequests.length === 2);
  harness.emitHead(103);
  await waitUntil(() => harness.sockets[0].proofRequests.length === 3);
  await new Promise((resolve) => setImmediate(resolve));
  await harness.monitor.stop();
  const snapshot = await harness.monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[proof.transactionHash]);
  assert.equal(snapshot.seenTransactions[proof.transactionHash], undefined);
  assert.equal(snapshot.deferredCreationEvidence[proof.transactionHash], undefined);
  assert.equal(snapshot.transactionFailures[proof.transactionHash], undefined);
  assert.equal(harness.alerts.length, 0);
});

function flapQuoteLifecycleRecord({
  action = "activated",
  quoteAddress = "0x1111111111111111111111111111111111111111",
  quoteName = "Berkshire Class B",
  quoteSymbol = "Brk.B",
  transactionHash = `0x${"a1".repeat(32)}`,
  blockNumber = 100,
  blockHash = `0x${"b1".repeat(32)}`,
  transactionIndex = 1,
  logIndex = 2,
  occurredAt = "2026-08-24T12:00:00.000Z",
  targetActivationEventKey,
} = {}) {
  return {
    version: 1,
    action,
    quoteAddress,
    quoteName,
    quoteSymbol,
    activationEventKey: `flap-quote:56:${transactionHash}:${logIndex}`,
    transactionHash,
    blockNumber,
    blockHash,
    transactionIndex,
    logIndex,
    occurredAt,
    proofType: action === "activated"
      ? "verified_zero_to_one"
      : action === "disabled" ? "verified_disable" : "verified_disable_orphaned",
    requiredConfirmations: 0,
    monitorOnly: true,
    ...(targetActivationEventKey ? { targetActivationEventKey } : {}),
  };
}

function flapQuoteLifecycleProvider(head = 120) {
  return {
    async getBlockNumber() { return head; },
    async send(method) {
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected lifecycle provider method ${method}`);
    },
    destroy() {},
  };
}

test("Flap direct quote lifecycle is durable, case-preserving, reorg-safe, and exactly restorable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-first-three-lifecycle-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, bscConfirmations: 0 };
  const dependencies = {
    autoStart: false,
    provider: flapQuoteLifecycleProvider(),
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  };
  let monitor = createBscLaunchpadMonitor(config, dependencies);
  const activation = flapQuoteLifecycleRecord();
  assert.deepEqual(await monitor.registerFlapQuotePoolLifecycle(activation), {
    accepted: true,
    changed: true,
    action: "activated",
    status: "activated",
    quoteAddress: activation.quoteAddress,
    generationKey: `quote:${activation.quoteAddress}:generation:${activation.blockHash}:${activation.transactionHash}:${activation.logIndex}`,
  });
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(activation)).status, "duplicate");
  await assert.rejects(() => monitor.registerFlapQuotePoolLifecycle(flapQuoteLifecycleRecord({
    transactionHash: `0x${"a2".repeat(32)}`,
    blockNumber: 101,
    blockHash: `0x${"b2".repeat(32)}`,
    logIndex: 3,
  })), /already has active generation/);

  const replacement = flapQuoteLifecycleRecord({ blockHash: `0x${"c1".repeat(32)}` });
  const replacementAck = await monitor.registerFlapQuotePoolLifecycle(replacement);
  assert.equal(replacementAck.status, "activated");
  assert.notEqual(replacementAck.generationKey, `quote:${activation.quoteAddress}:generation:${activation.blockHash}:${activation.transactionHash}:${activation.logIndex}`);

  const disable = flapQuoteLifecycleRecord({
    action: "disabled",
    transactionHash: `0x${"d1".repeat(32)}`,
    blockNumber: 110,
    blockHash: `0x${"e1".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 4,
    occurredAt: "2026-08-24T12:10:00.000Z",
  });
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(disable)).status, "disabled");
  const restore = flapQuoteLifecycleRecord({
    ...disable,
    action: "restored",
    targetActivationEventKey: replacement.activationEventKey,
  });
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(restore)).status, "restored");
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(restore)).status, "duplicate");
  const replacementDisable = flapQuoteLifecycleRecord({
    ...disable,
    blockHash: `0x${"e2".repeat(32)}`,
    occurredAt: "2026-08-24T12:11:00.000Z",
  });
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(replacementDisable)).status, "disabled");
  const replacementRestore = flapQuoteLifecycleRecord({
    ...replacementDisable,
    action: "restored",
    targetActivationEventKey: replacement.activationEventKey,
  });
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(replacementRestore)).status, "restored");
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(replacementRestore)).status, "duplicate");
  await monitor.awaitIdle();
  let snapshot = await monitor.getState();
  const windows = Object.values(snapshot.officialSources.flap.quotePoolFirstThree.windows);
  const oldWindow = windows.find((item) => item.activationBlockHash === activation.blockHash);
  const activeWindow = windows.find((item) => item.generationKey === replacementAck.generationKey);
  assert.equal(oldWindow.status, "canonical_replaced");
  assert.equal(activeWindow.active, true);
  assert.equal(activeWindow.quoteSymbol, "Brk.B");
  assert.equal(activeWindow.disableEventKey, disable.activationEventKey);
  assert.equal(activeWindow.orphanedDisableProof.blockHash, replacementDisable.blockHash);
  assert.equal(activeWindow.disableCanonicalReplacementOfBlockHash, disable.blockHash);
  assert.equal(snapshot.officialSources.flap.quotePoolFirstThree.activeByQuote[activation.quoteAddress], replacementAck.generationKey);

  const finalDisable = flapQuoteLifecycleRecord({
    action: "disabled",
    transactionHash: `0x${"d3".repeat(32)}`,
    blockNumber: 111,
    blockHash: `0x${"e3".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 5,
    occurredAt: "2026-08-24T12:12:00.000Z",
  });
  await monitor.registerFlapQuotePoolLifecycle(finalDisable);
  const reenabled = flapQuoteLifecycleRecord({
    transactionHash: `0x${"d4".repeat(32)}`,
    blockNumber: 112,
    blockHash: `0x${"e4".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 6,
    occurredAt: "2026-08-24T12:13:00.000Z",
  });
  const reenabledAck = await monitor.registerFlapQuotePoolLifecycle(reenabled);
  assert.equal(reenabledAck.status, "activated");
  assert.notEqual(reenabledAck.generationKey, replacementAck.generationKey,
    "disable then re-enable creates a new independent generation");

  await monitor.stop();
  monitor = createBscLaunchpadMonitor(config, dependencies);
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(replacementRestore)).status, "duplicate");
  snapshot = await monitor.getState();
  assert.equal(snapshot.officialSources.flap.quotePoolFirstThree.windows[replacementAck.generationKey].quoteSymbol, "Brk.B");
  await monitor.stop();
});

test("Flap first-three retention keeps active windows and lifecycle references closed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-first-three-retention-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, bscConfirmations: 0 };
  const dependencies = {
    autoStart: false,
    provider: flapQuoteLifecycleProvider(),
    logger: { error() {}, info() {} },
    flapQuoteFirstThreeWindowMax: 2,
    flapQuoteFirstThreeLifecycleMax: 4,
    ...disabledJournalTimerDependencies(),
  };
  const record = (index, action, blockNumber) => flapQuoteLifecycleRecord({
    action,
    quoteAddress: `0x${String(100 + index).padStart(40, "0")}`,
    quoteName: `Quote ${index}`,
    quoteSymbol: `Q${index}`,
    transactionHash: `0x${(1_000 + blockNumber).toString(16).padStart(64, "0")}`,
    blockNumber,
    blockHash: `0x${(2_000 + blockNumber).toString(16).padStart(64, "0")}`,
    transactionIndex: 0,
    logIndex: action === "activated" ? 1 : 2,
    occurredAt: new Date(Date.parse("2026-08-24T12:00:00.000Z") + blockNumber * 1_000).toISOString(),
  });
  let monitor = createBscLaunchpadMonitor(config, dependencies);
  const first = record(1, "activated", 101);
  const firstAck = await monitor.registerFlapQuotePoolLifecycle(first);
  for (const index of [2, 3]) {
    const activation = record(index, "activated", 100 + index * 2);
    await monitor.registerFlapQuotePoolLifecycle(activation);
    await monitor.registerFlapQuotePoolLifecycle(record(index, "disabled", 101 + index * 2));
  }
  await monitor.awaitIdle();
  let firstThree = (await monitor.getState()).officialSources.flap.quotePoolFirstThree;
  assert.equal(Object.keys(firstThree.windows).length, 2);
  assert.ok(firstThree.windows[firstAck.generationKey], "the older active generation is never evicted");
  assert.equal(firstThree.activeByQuote[first.quoteAddress], firstAck.generationKey);
  assert.ok(Object.values(firstThree.lifecycleEvents).every((event) => (
    event.generationKey === null || firstThree.windows[event.generationKey]
  )));
  await monitor.stop();

  monitor = createBscLaunchpadMonitor(config, dependencies);
  firstThree = (await monitor.getState()).officialSources.flap.quotePoolFirstThree;
  assert.equal(Object.keys(firstThree.windows).length, 2);
  assert.equal(firstThree.activeByQuote[first.quoteAddress], firstAck.generationKey);
  assert.ok(Object.values(firstThree.lifecycleEvents).every((event) => (
    event.generationKey === null || firstThree.windows[event.generationKey]
  )));
  await monitor.stop();
});

test("Flap orphan disable is a durable no-op and v6 Board activations remain legacy-closed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-first-three-legacy-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6,
    initializedAt: "2026-08-24T10:00:00.000Z",
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    officialSources: {
      flap: {
        featureActivations: {
          "quote_pool:legacy": {
            type: "quote_pool",
            quoteAddress: "0x2222222222222222222222222222222222222222",
            quoteSymbol: "OLD",
            active: true,
          },
        },
      },
    },
  }));
  const monitor = createBscLaunchpadMonitor({ dataDir, bscConfirmations: 0 }, {
    autoStart: false,
    provider: flapQuoteLifecycleProvider(),
    logger: { error() {}, info() {} },
    ...disabledJournalTimerDependencies(),
  });
  const orphan = flapQuoteLifecycleRecord({
    action: "disabled",
    quoteAddress: "0x3333333333333333333333333333333333333333",
    transactionHash: `0x${"f1".repeat(32)}`,
    blockHash: `0x${"f2".repeat(32)}`,
    logIndex: 7,
  });
  const ack = await monitor.registerFlapQuotePoolLifecycle(orphan);
  assert.equal(ack.accepted, true);
  assert.equal(ack.status, "disabled");
  assert.equal(ack.generationKey, null);
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(orphan)).status, "duplicate");
  const snapshot = await monitor.getState();
  assert.equal(snapshot.officialSources.flap.featureActivations["quote_pool:legacy"].firstThreeStatus, "legacy_closed");
  assert.deepEqual(snapshot.officialSources.flap.quotePoolFirstThree.activeByQuote, {});
  assert.deepEqual(snapshot.officialSources.flap.quotePoolFirstThree.windows, {});
  await monitor.stop();
});

async function createFlapQuoteFirstThreeHarness(t, {
  delayedMs = 31 * 60_000,
  alertResult = async (event) => ({ status: "delivered", eventId: event.eventKey }),
  factoryAddress = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
} = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-flap-first-three-archive-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const portal = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const factory = factoryAddress;
  const quoteAddress = "0x1111111111111111111111111111111111111111";
  const creator = "0x2222222222222222222222222222222222222222";
  const tokens = [
    "0x3333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
    "0x6666666666666666666666666666666666666666",
  ];
  const pairs = [
    "0x7333333333333333333333333333333333333333",
    "0x7444444444444444444444444444444444444444",
    "0x7555555555555555555555555555555555555555",
    "0x7666666666666666666666666666666666666666",
  ];
  const transactionHash = `0x${"91".repeat(32)}`;
  const blockHash = `0x${"92".repeat(32)}`;
  const activationTransactionHash = `0x${"81".repeat(32)}`;
  const activationBlockHash = `0x${"82".repeat(32)}`;
  const activationBlockNumber = 100;
  const blockNumber = 101;
  const blockTimestampMs = Date.parse("2026-08-24T12:00:00.000Z");
  let clock = blockTimestampMs + delayedMs;
  const flapInterface = new Interface([
    "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
  ]);
  const pairInterface = new Interface([
    "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
  ]);
  const tokenLogs = [];
  const receiptLogs = [];
  tokens.forEach((token, index) => {
    const tokenLogIndex = 5 + index * 2;
    const encodedToken = flapInterface.encodeEventLog(
      flapInterface.getEvent("TokenCreated"),
      [BigInt(Math.floor(blockTimestampMs / 1_000)), creator, BigInt(index + 1), token, `Token ${index + 1}`, `T${index + 1}`, `ipfs://token-${index + 1}`],
    );
    const tokenLog = {
      address: portal,
      topics: encodedToken.topics,
      data: encodedToken.data,
      transactionHash,
      blockNumber,
      blockHash,
      transactionIndex: 2,
      logIndex: tokenLogIndex,
      removed: false,
    };
    const encodedPair = pairInterface.encodeEventLog(
      pairInterface.getEvent("PairCreated"),
      [token, quoteAddress, pairs[index], BigInt(index + 1)],
    );
    const pairLog = {
      address: factory,
      topics: encodedPair.topics,
      data: encodedPair.data,
      transactionHash,
      blockNumber,
      blockHash,
      transactionIndex: 2,
      logIndex: tokenLogIndex + 1,
      removed: false,
    };
    tokenLogs.push(tokenLog);
    receiptLogs.push(tokenLog, pairLog);
  });
  const duplicateTokenLog = {
    ...tokenLogs[0],
    logIndex: 13,
  };
  tokenLogs.push(duplicateTokenLog);
  receiptLogs.push(duplicateTokenLog);
  const transaction = {
    hash: transactionHash,
    blockNumber,
    blockHash,
    transactionIndex: 2,
    from: creator,
    to: portal,
    data: `0x12345678${"0".repeat(128)}`,
    value: 0n,
  };
  const receipt = {
    hash: transactionHash,
    transactionHash,
    blockNumber,
    blockHash,
    index: 2,
    transactionIndex: 2,
    from: creator,
    to: portal,
    status: 1,
    logs: receiptLogs,
  };
  const block = {
    number: blockNumber,
    hash: blockHash,
    timestamp: Math.floor(blockTimestampMs / 1_000),
    transactions: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, transactionHash],
  };
  const archiveRequests = [];
  let archiveVisible = true;
  let currentHead = blockNumber;
  const provider = {
    async getBlockNumber() { return currentHead; },
    async send(method, [filter]) {
      if (method !== "eth_getLogs") throw new Error(`unexpected archive method ${method}`);
      archiveRequests.push(structuredClone(filter));
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      if (!archiveVisible || from > blockNumber || to < blockNumber) return [];
      // Deliberately reverse the RPC result to prove canonical log ordering.
      return [...tokenLogs].reverse();
    },
    async getTransaction(hash) { return hash === transactionHash ? transaction : null; },
    async getTransactionReceipt(hash) { return hash === transactionHash ? receipt : null; },
    async getBlock(number) { return Number(number) === blockNumber ? block : null; },
    async getCode() { return `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { throw new Error("safety RPC unavailable"); },
    destroy() {},
  };
  const alerts = [];
  const errors = [];
  const dependencies = {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    logger: { error(message) { errors.push(String(message)); }, info() {} },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(structuredClone(event));
      return alertResult(event);
    },
    ...disabledJournalTimerDependencies(),
  };
  const config = {
    dataDir,
    bscConfirmations: 0,
    bscRecoveryLogBatchSize: 2,
    blockedContracts: new Set(),
  };
  const activation = flapQuoteLifecycleRecord({
    quoteAddress,
    quoteName: "Berkshire Class B",
    quoteSymbol: "Brk.B",
    transactionHash: activationTransactionHash,
    blockNumber: activationBlockNumber,
    blockHash: activationBlockHash,
    transactionIndex: 0,
    logIndex: 1,
    occurredAt: new Date(blockTimestampMs - 60_000).toISOString(),
  });
  const createMonitor = (overrides = {}) => createBscLaunchpadMonitor(config, {
    ...dependencies,
    ...overrides,
  });
  return {
    dataDir,
    config,
    dependencies,
    createMonitor,
    activation,
    alerts,
    errors,
    archiveRequests,
    portal,
    factory,
    quoteAddress,
    tokens,
    pairs,
    transactionHash,
    blockHash,
    blockNumber,
    blockTimestampMs,
    reorgBlock(nextBlockHash) {
      transaction.blockHash = nextBlockHash;
      receipt.blockHash = nextBlockHash;
      block.hash = nextBlockHash;
      for (const log of receiptLogs) log.blockHash = nextBlockHash;
    },
    setArchiveVisible(value) { archiveVisible = value === true; },
    setHead(value) { currentHead = Number(value); },
    setClock(value) { clock = value; },
  };
}

test("Flap first-three ignores non-V2/V3 factory logs before reserving an ordinal", async (t) => {
  const harness = await createFlapQuoteFirstThreeHarness(t, {
    factoryAddress: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  });
  const monitor = harness.createMonitor();
  const ack = await monitor.registerFlapQuotePoolLifecycle(harness.activation);
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  const window = (await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[ack.generationKey];
  assert.equal(window.slots.length, 0);
  assert.equal(harness.alerts.length, 0);
  await monitor.stop();
});

test("Flap active incomplete generations keep incrementally replaying finalized heads", async (t) => {
  const harness = await createFlapQuoteFirstThreeHarness(t);
  harness.setArchiveVisible(false);
  harness.setHead(harness.activation.blockNumber);
  let monitor = harness.createMonitor();
  const ack = await monitor.registerFlapQuotePoolLifecycle(harness.activation);
  await monitor.awaitIdle();
  let window = (await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[ack.generationKey];
  assert.equal(window.slots.length, 0);
  assert.ok(window.replayCompletedAt, "the first archive pass completed at the then-finalized head");

  harness.setArchiveVisible(true);
  harness.setHead(harness.blockNumber);
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  window = (await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[ack.generationKey];
  assert.equal(window.slots.length, 3);
  assert.ok(window.trackingCompletedAt);
  assert.deepEqual(harness.alerts.map((event) => event.featureTokenOrdinal), [1, 2, 3]);
  await monitor.stop();

  monitor = harness.createMonitor();
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  assert.equal(harness.alerts.length, 3, "an incremental replay remains exact-once after restart");
  await monitor.stop();
});

test("Flap retries a reserved third ordinal until delivery is durably accepted", async (t) => {
  let thirdAttempts = 0;
  const harness = await createFlapQuoteFirstThreeHarness(t, {
    alertResult: async (event) => {
      if (event.featureTokenOrdinal === 3 && ++thirdAttempts === 1) {
        return { status: "suppressed", reason: "monitoring_source_disabled", terminal: true };
      }
      return { status: "delivered", eventId: event.eventKey };
    },
  });
  let monitor = harness.createMonitor();
  const ack = await monitor.registerFlapQuotePoolLifecycle(harness.activation);
  await monitor.awaitIdle();
  let window = (await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[ack.generationKey];
  assert.equal(window.slots.length, 3);
  assert.deepEqual(window.slots.map((slot) => Boolean(slot.deliveryAcceptedAt)), [true, true, false]);
  assert.equal(window.trackingCompletedAt ?? null, null);
  const thirdEventKey = window.slots[2].eventKey;
  await monitor.stop();

  monitor = harness.createMonitor();
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(harness.activation)).status, "duplicate");
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  window = (await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[ack.generationKey];
  assert.ok(window.slots.every((slot) => slot.deliveryAcceptedAt));
  assert.ok(window.trackingCompletedAt);
  assert.equal(thirdAttempts, 2);
  assert.equal(harness.alerts.filter((event) => event.eventKey === thirdEventKey).length, 2,
    "the same pending event is retried; accepted ordinals are never resent");
  assert.equal(harness.alerts.filter((event) => event.featureTokenOrdinal < 3).length, 2);
  await monitor.stop();
});

test("Flap v7 state rejects tampered pending event and slot invariants on restart", async (t) => {
  const harness = await createFlapQuoteFirstThreeHarness(t);
  const monitor = harness.createMonitor();
  await monitor.registerFlapQuotePoolLifecycle(harness.activation);
  await monitor.awaitIdle();
  await monitor.stop();
  const stateFile = path.join(harness.dataDir, "bsc-launchpad-state.json");
  const walFile = `${stateFile}.wal`;
  const durable = await readBscLaunchpadDurableState(stateFile);
  const mutations = [
    ["event", (slot) => { slot.event.sourceUrl = "https://attacker.example"; }],
    ["event key", (slot) => { slot.eventKey += ":forged"; }],
    ["proof", (slot) => { slot.event.featureTokenProof.tokenAddress = harness.quoteAddress; }],
    ["pair", (slot) => { slot.pool.token1 = "0x9999999999999999999999999999999999999999"; }],
    ["delivery", (slot) => { slot.deliveryAcceptedAt = null; }],
    ["canonical ordinal", (_slot, snapshot) => { snapshot.officialSources.flap.quotePoolFirstThree
      .windows[Object.keys(snapshot.officialSources.flap.quotePoolFirstThree.windows)[0]].slots[1].ordinal = 1; }],
    ["archive cursor", (_slot, snapshot) => { snapshot.officialSources.flap.quotePoolFirstThree
      .windows[Object.keys(snapshot.officialSources.flap.quotePoolFirstThree.windows)[0]].archiveReplayNextBlock = 999_999_999; }],
    ["activation lifecycle", (_slot, snapshot) => {
      const lifecycle = Object.values(snapshot.officialSources.flap.quotePoolFirstThree.lifecycleEvents)
        .find((event) => event.action === "activated");
      lifecycle.blockNumber += 1;
    }],
  ];
  for (const [label, mutate] of mutations) {
    const corrupted = structuredClone(durable);
    const firstThree = corrupted.officialSources.flap.quotePoolFirstThree;
    const corruptedWindow = firstThree.windows[Object.keys(firstThree.windows)[0]];
    mutate(corruptedWindow.slots[0], corrupted);
    await fs.writeFile(stateFile, `${JSON.stringify(corrupted)}\n`);
    await fs.writeFile(walFile, "");
    const restarted = harness.createMonitor();
    await assert.rejects(() => restarted.getState(), /invalid durable Flap first-three/, label);
    await restarted.stop().catch(() => {});
  }
});

test("Flap archive replay emits the first three distinct CAs in canonical order and survives restart exactly once", async (t) => {
  const harness = await createFlapQuoteFirstThreeHarness(t);
  let monitor = harness.createMonitor();
  const ack = await monitor.registerFlapQuotePoolLifecycle(harness.activation);
  assert.equal(ack.status, "activated");
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  const debugSnapshot = await monitor.getState();
  assert.equal(harness.alerts.length, 3, JSON.stringify({
    errors: harness.errors,
    firstThree: debugSnapshot.officialSources.flap.quotePoolFirstThree,
    seen: debugSnapshot.seenTransactions,
    launchers: debugSnapshot.launchers,
    failures: debugSnapshot.transactionFailures,
    deferred: debugSnapshot.deferredCreationEvidence,
  }));
  assert.deepEqual(harness.alerts.map((event) => event.tokens[0].token), harness.tokens.slice(0, 3));
  assert.deepEqual(harness.alerts.map((event) => event.featureTokenOrdinal), [1, 2, 3]);
  const proofKeys = [
    "activationEventKey", "activationId", "blockHash", "blockNumber", "canonical",
    "confirmations", "logIndex", "pairAddress", "pairKind", "portal", "quoteAddress",
    "requiredConfirmations", "tokenAddress", "tokenCreatedTopic", "transactionHash",
    "transactionIndex", "version",
  ];
  for (const [index, event] of harness.alerts.entries()) {
    assert.equal(event.type, "bsc_launchpad_update");
    assert.equal(event.kind, "flap_pool_token");
    assert.equal(event.featureActivationKey, event.featureGenerationKey);
    assert.equal(event.featureTrackedToken, true);
    assert.equal(event.featureTokenTarget, 3);
    assert.equal(event.featureFirstToken, index === 0);
    assert.equal(event.informationalOnly, true);
    assert.equal(event.autoTradeEligible, false);
    assert.equal(event.automaticExecution, false);
    assert.equal(event.launcher, harness.portal);
    assert.equal(event.platform.id, "flap");
    assert.equal(event.platform.trust, "official_verified");
    assert.equal(event.mode.featureActivationKey, undefined);
    assert.equal(event.mode.quoteAsset, harness.quoteAddress);
    assert.equal(event.mode.quoteSymbol, "Brk.B");
    assert.equal(event.tokens.length, 1);
    assert.equal(event.pools.length, 1);
    assert.equal(event.pools[0].pool, harness.pairs[index]);
    assert.equal(event.security.decision, "block", "unsafe/unknown checks still occupy their canonical ordinal");
    assert.deepEqual(Object.keys(event.featureTokenProof).sort(), proofKeys);
    assert.equal(event.featureTokenProof.tokenAddress, event.tokens[0].token);
    assert.equal(event.featureTokenProof.quoteAddress, event.mode.quoteAsset);
    assert.equal(event.featureTokenProof.pairAddress, event.pools[0].pool);
    assert.equal(event.featureTokenProof.transactionHash, event.transactionHash);
    assert.equal(event.featureTokenProof.blockHash, event.blockHash);
    assert.equal(event.featureTokenProof.logIndex, event.logIndex);
    assert.equal(event.featureTokenProof.canonical, true);
    assert.equal(event.delayedRecovery.reason, "verified_generation_archive_catch_up");
    assert.equal(event.delayedRecovery.lagMs, 31 * 60_000);
    assert.equal(isStrictFlapTrackedPoolTokenUpdate(event), true);
  }
  const snapshot = await monitor.getState();
  const window = snapshot.officialSources.flap.quotePoolFirstThree.windows[ack.generationKey];
  assert.equal(window.slots.length, 3);
  assert.equal(new Set(window.slots.map((slot) => slot.tokenAddress)).size, 3);
  assert.ok(window.replayAttemptedCandidateKeys.some((key) => key.endsWith(`:13:${harness.tokens[0]}`)),
    "a repeated CA is observed but never consumes another ordinal");
  assert.ok(window.slots.every((slot) => slot.deliveryAcceptedAt));
  assert.ok(window.trackingCompletedAt);
  assert.ok(harness.archiveRequests.some((filter) => Number.parseInt(filter.fromBlock, 16) === harness.activation.blockNumber),
    "archive replay starts at the durable activation cursor even with an empty hot index");
  const unrelatedQuoteActivation = flapQuoteLifecycleRecord({
    quoteAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    quoteName: "Unrelated Quote",
    quoteSymbol: "UQ",
    transactionHash: `0x${"83".repeat(32)}`,
    blockNumber: 100,
    blockHash: `0x${"84".repeat(32)}`,
    transactionIndex: 1,
    logIndex: 2,
    occurredAt: new Date(harness.blockTimestampMs - 30_000).toISOString(),
  });
  const unrelatedAck = await monitor.registerFlapQuotePoolLifecycle(unrelatedQuoteActivation);
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  assert.equal(harness.alerts.length, 3, "same transaction cannot leak tokens across quote pools without its exact pair");
  assert.equal((await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[unrelatedAck.generationKey].slots.length, 0);
  const canonicalReplacementHash = `0x${"93".repeat(32)}`;
  harness.reorgBlock(canonicalReplacementHash);
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  assert.equal(harness.alerts.length, 6);
  for (const [index, event] of harness.alerts.slice(3).entries()) {
    const previous = harness.alerts[index];
    assert.deepEqual(event.canonicalRevision, {
      version: 1,
      reason: "token_created_reorg",
      ordinal: index + 1,
      replacesEventKey: previous.eventKey,
      replacesBlockHash: harness.blockHash,
      replacesTokenAddress: previous.tokens[0].token,
    });
    assert.equal(event.featureTokenOrdinal, index + 1);
    assert.equal(event.blockHash, canonicalReplacementHash);
    assert.equal(event.featureTokenProof.blockHash, canonicalReplacementHash);
    assert.equal(event.eventKey,
      `bsc-flap-pool-token:${ack.generationKey}:${index + 1}:${harness.transactionHash}:${5 + index * 2}:${harness.tokens[index]}:canonical-revision:${canonicalReplacementHash}`);
    assert.equal(isStrictFlapTrackedPoolTokenUpdate(event), true);
  }
  await monitor.stop();

  monitor = harness.createMonitor();
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(harness.activation)).status, "duplicate");
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  assert.equal(harness.alerts.length, 6, "restart and duplicate lifecycle handoff cannot redeliver accepted ordinals or revisions");
  await monitor.stop();
});

test("Flap fresh archive replay omits delayed recovery and policy suppression keeps its ordinal pending", async (t) => {
  let attempts = 0;
  const harness = await createFlapQuoteFirstThreeHarness(t, {
    delayedMs: 60_000,
    alertResult: async (event) => {
      attempts += 1;
      return attempts === 1
        ? { status: "suppressed", reason: "monitoring_source_disabled", terminal: true }
        : { status: "queued", eventId: event.eventKey };
    },
  });
  const monitor = harness.createMonitor();
  await monitor.registerFlapQuotePoolLifecycle(harness.activation);
  await monitor.awaitIdle();
  let snapshot = await monitor.getState();
  let window = Object.values(snapshot.officialSources.flap.quotePoolFirstThree.windows)[0];
  assert.equal(window.slots.length, 1);
  assert.equal(window.slots[0].ordinal, 1);
  assert.equal(window.slots[0].deliveryAcceptedAt, null);
  assert.equal(window.slots[0].lastDeliveryResult.reason, "monitoring_source_disabled");

  harness.reorgBlock(`0x${"94".repeat(32)}`);
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  snapshot = await monitor.getState();
  window = Object.values(snapshot.officialSources.flap.quotePoolFirstThree.windows)[0];
  assert.equal(window.slots.length, 3);
  assert.deepEqual(window.slots.map((slot) => slot.ordinal), [1, 2, 3]);
  assert.ok(window.slots.every((slot) => slot.deliveryAcceptedAt));
  assert.ok(window.slots.every((slot) => slot.canonicalRevision === undefined),
    "an unaccepted orphan is removed and canonically reordered without a replacement notification");
  assert.ok(harness.alerts.every((event) => event.delayedRecovery === undefined));
  assert.ok(harness.alerts.every((event) => isStrictFlapTrackedPoolTokenUpdate(event)),
    "fresh ordinary producer events pass the strict source gate");
  assert.equal(window.slots[0].deliveryStatus, "queued");
  await monitor.stop();
});

test("Flap orphaned disable restoration replays its canonical gap and remains exact-once after restart", async (t) => {
  const harness = await createFlapQuoteFirstThreeHarness(t, { delayedMs: 60_000 });
  harness.setArchiveVisible(false);
  harness.setHead(harness.activation.blockNumber);
  let monitor = harness.createMonitor();
  const activationAck = await monitor.registerFlapQuotePoolLifecycle(harness.activation);
  await monitor.awaitIdle();
  let window = (await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[activationAck.generationKey];
  assert.equal(window.slots.length, 0);
  assert.ok(window.replayCompletedAt);

  const disable = flapQuoteLifecycleRecord({
    action: "disabled",
    quoteAddress: harness.quoteAddress,
    quoteName: "Berkshire Class B",
    quoteSymbol: "Brk.B",
    transactionHash: `0x${"95".repeat(32)}`,
    blockNumber: harness.blockNumber,
    blockHash: `0x${"96".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 4,
    occurredAt: new Date(harness.blockTimestampMs).toISOString(),
  });
  await monitor.registerFlapQuotePoolLifecycle(disable);
  harness.setArchiveVisible(true);
  harness.setHead(harness.blockNumber);
  const restore = flapQuoteLifecycleRecord({
    ...disable,
    action: "restored",
    targetActivationEventKey: harness.activation.activationEventKey,
  });
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(restore)).status, "restored");
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  assert.equal(harness.alerts.length, 3);
  assert.deepEqual(harness.alerts.map((event) => event.featureTokenOrdinal), [1, 2, 3]);
  assert.ok(harness.alerts.every((event) => isStrictFlapTrackedPoolTokenUpdate(event)));
  window = (await monitor.getState()).officialSources.flap.quotePoolFirstThree
    .windows[activationAck.generationKey];
  assert.equal(window.slots.length, 3);
  assert.ok(window.trackingCompletedAt);
  assert.ok(window.orphanedDisableProof);
  await monitor.stop();

  monitor = harness.createMonitor();
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(restore)).status, "duplicate");
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  assert.equal(harness.alerts.length, 3);
  await monitor.stop();
});

test("Flap restored first-three processing keeps a disabled-period durable predecessor ahead of a later candidate", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-first3-restore-raw-"));
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  let clock = Date.parse("2026-08-24T12:00:00.000Z");
  let head = 100;
  let phase = "none";
  const portal = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const factory = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
  const quote = "0x1111111111111111111111111111111111111111";
  const creator = "0x2222222222222222222222222222222222222222";
  const tokens = ["0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"];
  const pairs = ["0x7333333333333333333333333333333333333333", "0x7444444444444444444444444444444444444444"];
  const transactionHashes = [`0x${"31".repeat(32)}`, `0x${"41".repeat(32)}`];
  const blockHashes = [`0x${"32".repeat(32)}`, `0x${"42".repeat(32)}`];
  const creationInterface = new Interface([
    "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
  ]);
  const pairInterface = new Interface([
    "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
  ]);
  const creationLogs = [];
  const transactions = new Map();
  const receipts = new Map();
  const blocks = new Map();
  for (let index = 0; index < 2; index += 1) {
    const blockNumber = 102 + index;
    const encodedCreation = creationInterface.encodeEventLog(
      creationInterface.getEvent("TokenCreated"),
      [BigInt(Math.floor(clock / 1_000)), creator, BigInt(index + 1), tokens[index], `Token ${index + 1}`, `T${index + 1}`, `ipfs://${index + 1}`],
    );
    const creation = {
      address: portal,
      topics: encodedCreation.topics,
      data: encodedCreation.data,
      transactionHash: transactionHashes[index],
      blockHash: blockHashes[index],
      blockNumber,
      transactionIndex: 1,
      logIndex: 2,
      removed: false,
    };
    const encodedPair = pairInterface.encodeEventLog(
      pairInterface.getEvent("PairCreated"),
      [tokens[index], quote, pairs[index], BigInt(index + 1)],
    );
    const pairLog = {
      address: factory,
      topics: encodedPair.topics,
      data: encodedPair.data,
      transactionHash: transactionHashes[index],
      blockHash: blockHashes[index],
      blockNumber,
      transactionIndex: 1,
      logIndex: 3,
      removed: false,
    };
    creationLogs.push(creation);
    transactions.set(transactionHashes[index], {
      hash: transactionHashes[index],
      blockNumber,
      blockHash: blockHashes[index],
      index: 1,
      transactionIndex: 1,
      from: creator,
      to: portal,
      data: `0x12345678${"0".repeat(128)}`,
      value: 0n,
    });
    receipts.set(transactionHashes[index], {
      hash: transactionHashes[index],
      transactionHash: transactionHashes[index],
      blockNumber,
      blockHash: blockHashes[index],
      index: 1,
      transactionIndex: 1,
      from: creator,
      to: portal,
      status: 1,
      logs: [creation, pairLog],
    });
    blocks.set(blockNumber, {
      number: blockNumber,
      hash: blockHashes[index],
      timestamp: Math.floor(clock / 1_000) + index,
      transactions: [`0x${String(index + 5).repeat(64)}`, transactionHashes[index]],
    });
  }
  await fs.writeFile(stateFile, JSON.stringify({
    version: 7,
    initializedAt: new Date(clock - 3_600_000).toISOString(),
    lastFinalizedBlock: 50,
    realtimeTailNextBlock: 104,
    realtimeTailInitializedAt: new Date(clock - 3_600_000).toISOString(),
    realtimePendingEntries: {},
    deferredCreationEvidence: {},
    officialSources: { flap: { quotePoolFirstThree: { version: 1, windows: {}, activeByQuote: {}, lifecycleEvents: {} } } },
    launchers: {},
    hooks: {},
    seenTransactions: {},
    coverageGaps: [],
    nearHeadRecoveryGaps: [{
      id: "first3-raw",
      fromBlock: 102,
      toBlock: 103,
      nextBlock: 102,
      reason: "fixture",
      attempts: 0,
    }],
    _health: { realtimeTail: { status: "healthy", lastSuccessAt: new Date(clock).toISOString(), toBlock: 103, consecutiveFailures: 0 } },
  }));
  const provider = {
    async getBlockNumber() { return head; },
    async send(method, [filter]) {
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      if (phase === "restore_blocked") throw new Error("fixture keeps archive replay incomplete");
      const fromBlock = Number.parseInt(filter.fromBlock, 16);
      const toBlock = Number.parseInt(filter.toBlock, 16);
      const topics = Array.isArray(filter?.topics?.[0]) ? filter.topics[0] : [filter?.topics?.[0]];
      if (!topics.includes(FLAP_TOKEN_CREATED_TOPIC)) return [];
      if (phase === "A" && fromBlock <= 102 && toBlock >= 102) return [creationLogs[0]];
      if (phase === "B" && fromBlock <= 103 && toBlock >= 103) return [creationLogs[1]];
      return [];
    },
    async getTransaction(hash) { return transactions.get(hash) || null; },
    async getTransactionReceipt(hash) { return receipts.get(hash) || null; },
    async getBlock(number) { return blocks.get(Number(number)) || null; },
    async getCode() { return `0x${"6000".repeat(400)}`; },
    async getStorage() { return "0x"; },
    async call() { throw new Error("optional safety RPC unavailable"); },
    destroy() {},
  };
  const alerts = [];
  const dependencies = {
    autoStart: false,
    externalAttribution: false,
    provider,
    now: () => clock,
    logger: { error() {}, info() {} },
    sendAlertsImpl: async (_config, event) => {
      alerts.push(structuredClone(event));
      return { status: "delivered", eventId: event.eventKey };
    },
    ...disabledJournalTimerDependencies(),
  };
  const config = {
    dataDir,
    monitorScope: "focus3",
    bscConfirmations: 0,
    bscNearHeadRecoveryBatchSize: 1,
    bscRecoveryLogBatchSize: 1,
    blockedContracts: new Set(),
  };
  const activation = flapQuoteLifecycleRecord({
    quoteAddress: quote,
    quoteName: "Quote",
    quoteSymbol: "Q",
    transactionHash: `0x${"11".repeat(32)}`,
    blockNumber: 100,
    blockHash: `0x${"12".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 1,
    occurredAt: new Date(clock - 60_000).toISOString(),
  });
  const disable = flapQuoteLifecycleRecord({
    action: "disabled",
    quoteAddress: quote,
    quoteName: "Quote",
    quoteSymbol: "Q",
    transactionHash: `0x${"21".repeat(32)}`,
    blockNumber: 101,
    blockHash: `0x${"22".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 4,
    occurredAt: new Date(clock - 30_000).toISOString(),
  });
  const restore = flapQuoteLifecycleRecord({
    ...disable,
    action: "restored",
    targetActivationEventKey: activation.activationEventKey,
  });
  let monitor = createBscLaunchpadMonitor(config, dependencies);
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const activationAck = await monitor.registerFlapQuotePoolLifecycle(activation);
  await monitor.awaitIdle();
  await monitor.registerFlapQuotePoolLifecycle(disable);
  phase = "A";
  head = 102;
  assert.equal((await monitor.scanNearHeadRecovery()).completed, false);
  phase = "restore_blocked";
  let snapshot = await monitor.getState();
  assert.deepEqual(snapshot.realtimePendingEntries[transactionHashes[0]].causalBarrierKeys, []);
  assert.equal(snapshot.nearHeadRecoveryGaps[0]?.nextBlock, 103,
    "the second candidate remains an uncovered durable gap before restart");
  await monitor.stop();

  monitor = createBscLaunchpadMonitor(config, dependencies);
  await monitor.getState();
  phase = "restore_blocked";
  assert.equal((await monitor.registerFlapQuotePoolLifecycle(restore)).status, "restored");
  await monitor.awaitIdle();
  phase = "none";
  snapshot = await monitor.getState();
  assert.equal(snapshot.officialSources.flap.quotePoolFirstThree
    .windows[activationAck.generationKey].replayCompletedAt, null,
  "the potential barrier must authorize A while archive replay is still incomplete");
  assert.deepEqual(
    snapshot.realtimePendingEntries[transactionHashes[0]].causalBarrierKeys,
    [`first3:${activationAck.generationKey}`],
  );
  await monitor.processRealtimeQueue();
  await monitor.awaitIdle();
  snapshot = await monitor.getState();
  let window = snapshot.officialSources.flap.quotePoolFirstThree.windows[activationAck.generationKey];
  assert.deepEqual(window.slots.map((slot) => [slot.ordinal, slot.transactionHash]), [
    [1, transactionHashes[0]],
  ], "A must claim ordinal one while archive replay is still incomplete");

  phase = "B";
  head = 103;
  clock = Math.max(clock, Date.parse("2026-08-24T12:00:01.000Z"));
  const remainingGap = snapshot.nearHeadRecoveryGaps[0];
  if (remainingGap?.nextAttemptAt) {
    clock = Math.max(clock, Date.parse(remainingGap.nextAttemptAt) + 1);
  }
  const handoffB = await monitor.scanNearHeadRecovery();
  phase = "restore_blocked";
  const afterBHandoff = await monitor.getState();
  assert.ok(
    afterBHandoff.realtimePendingEntries[transactionHashes[1]]
      || afterBHandoff.deferredCreationEvidence[transactionHashes[1]]
      || afterBHandoff.seenTransactions[transactionHashes[1]],
    `B must be durably admitted even when a scheduled scan wins the race: ${JSON.stringify(handoffB)}`,
  );
  for (let turn = 0; turn < 5; turn += 1) {
    await monitor.processRealtimeQueue();
    clock += 1_000;
  }
  await monitor.awaitIdle();
  phase = "none";
  snapshot = await monitor.getState();
  window = snapshot.officialSources.flap.quotePoolFirstThree.windows[activationAck.generationKey];
  assert.deepEqual(window.slots.map((slot) => [slot.ordinal, slot.transactionHash]), [
    [1, transactionHashes[0]],
    [2, transactionHashes[1]],
  ]);
  assert.deepEqual(alerts.map((event) => [event.featureTokenOrdinal, event.transactionHash]), [
    [1, transactionHashes[0]],
    [2, transactionHashes[1]],
  ]);
  await monitor.stop();

  monitor = createBscLaunchpadMonitor(config, dependencies);
  await monitor.replayFlapQuotePoolFirstThree();
  await monitor.awaitIdle();
  assert.equal(alerts.length, 2, "restart cannot redeliver either accepted canonical ordinal");
});
