import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Interface } from "ethers";
import {
  createBscLaunchpadMonitor,
  parseKnownBscLaunchEvidence,
} from "../../src/bsc-launchpad-monitor.js";

const OPENFOUR_CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOKEN_CREATED_INTERFACE = new Interface([
  "event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)",
]);

function tokenCreatedEvidence({
  token,
  transactionHash,
  blockHash,
  blockNumber,
  transactionIndex,
  logIndex,
  presetId,
  quoteAsset,
}) {
  const encoded = TOKEN_CREATED_INTERFACE.encodeEventLog(TOKEN_CREATED_INTERFACE.getEvent("TokenCreated"), [
    1n,
    BigInt(presetId),
    "0x1111111111111111111111111111111111111111",
    token,
    "First Confirmed",
    "FIRST",
    1n,
    1n,
    1n,
    1n,
    quoteAsset,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    "ipfs://official-meta",
    0n,
    "0x",
  ]);
  return parseKnownBscLaunchEvidence([{
    address: OPENFOUR_CORE,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash,
    blockHash,
    blockNumber,
    transactionIndex,
    index: logIndex,
    removed: false,
  }], transactionHash);
}

export async function produceLegacyBscOpenFourSafetyEvent(t, {
  transactionHash,
  blockHash,
  blockNumber,
  transactionIndex,
  logIndex,
  token,
  presetId,
  quoteAsset,
  observedAt,
  dataDir: requestedDataDir,
} = {}) {
  const dataDir = requestedDataDir || await fs.mkdtemp(path.join(os.tmpdir(), "legacy-openfour-first-token-"));
  if (!requestedDataDir) t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const liveNow = Date.parse(observedAt);
  let clock = liveNow - 60 * 60_000;
  const captured = [];
  const monitor = createBscLaunchpadMonitor({
    dataDir,
    bscConfirmations: 2,
    monitorScope: "focus3",
    blockedContracts: new Set(),
  }, {
    autoStart: false,
    externalAttribution: false,
    provider: {
      destroy() {},
      async getBlockNumber() { return blockNumber + 2; },
      async getBlock() { return { timestamp: Math.floor(liveNow / 1_000) }; },
      async send() { return []; },
    },
    now: () => clock,
    sendAlertsImpl: async (event) => {
      captured.push(event);
      return { status: "delivered", eventId: event.eventKey, persisted: true };
    },
    logger: { error() {}, info() {} },
  });
  t.after(() => monitor.stop());
  await monitor.getState();
  clock = liveNow;
  const quoteConfig = {
    symbol: "FIXQ",
    address: quoteAsset,
    status: "PUBLISH",
    fees: { buyFee: "0.01" },
    thresholds: { totalBAmount: "90" },
  };
  await monitor.registerFourMemeFeatureActivations([{ quoteConfig, observedAt }]);
  const snapshot = await monitor.getState();
  const [activationKey, activation] = Object.entries(snapshot.officialSources.fourMeme.featureActivations)[0];
  const evidence = tokenCreatedEvidence({
    token,
    transactionHash,
    blockHash,
    blockNumber,
    transactionIndex,
    logIndex,
    presetId,
    quoteAsset,
  });
  const event = await monitor.observe({
    launcher: OPENFOUR_CORE,
    transactionHash,
    blockNumber,
    blockHash,
    transactionIndex,
    canonical: true,
    confirmations: 3,
    requiredConfirmations: 2,
    platform: {
      id: "fourmeme",
      name: "Four.Meme / OpenFour",
      trust: "official_verified",
      website: "https://four.meme",
      twitter: "https://x.com/fourdotmemezh",
      github: null,
      notifyFirstToken: false,
      notifyFirstInfrastructureActivation: false,
      evidenceUrl: "https://four.meme/meme-api/v1/public/address",
    },
    tokens: [{
      token,
      metadata: { name: "First Confirmed", symbol: "FIRST", decimals: 18 },
      launchEvidence: evidence[0],
    }],
    pools: [{ kind: "PancakeSwap V2", pool: "0x3333333333333333333333333333333333333333" }],
    mode: {
      fingerprint: "openfour-registry-cross-producer",
      selector: "0x12345678",
      poolKinds: ["PancakeSwap V2"],
      creationTopics: [],
      customTopics: [],
      tokenSelectorHash: "openfour-registry-token",
      launcherCodeHash: "launcher-code-a",
      implementation: "0x7777777777777777777777777777777777777777",
      quoteAsset,
      quoteSymbol: quoteConfig.symbol,
      quoteFingerprint: activation.quoteFingerprint,
      componentMode: "Four.Meme FIXQ 新底池",
      componentModeAlertEligible: true,
      featureActivationKey: activationKey,
      featureActivationEligible: true,
    },
    structural: {
      eligible: true,
      mechanismEvidence: true,
      usesCreate2: true,
      codeSize: 12_000,
      argumentBytes: 128,
    },
    deployer: `0x${transactionHash.slice(2, 42)}`,
    causalTokenEvent: true,
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
    sampleToken: token,
    observedAt,
    launchEvidence: evidence,
    deliverySla: {
      startedAt: observedAt,
      deadlineAt: new Date(liveNow + 5_000).toISOString(),
      budgetMs: 5_000,
      pollAllowanceMs: 0,
      basis: "bsc_websocket_ingest",
    },
  });
  return { event, monitor, captured, dataDir };
}
