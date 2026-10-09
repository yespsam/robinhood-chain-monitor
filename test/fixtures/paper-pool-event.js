// Offline fixture shared with the strict producer contract tests.
import {createHash} from 'node:crypto';
import {encodeFlapQuoteConfigurationLog} from '../../src/flap-quote-generation.js';
const FLAP_TRACKED_TOKEN_PORTAL = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const FLAP_TRACKED_TOKEN_TOPIC = "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603";
const FLAP_TRACKED_TOKEN_QUOTE = "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf";

export function strictFlapTrackedPoolTokenEvent({
  ordinal = 1,
  quoteSymbol = "SOXLB",
  blockTimestamp = "2026-09-04T00:00:00.000Z",
  observedAt = "2026-09-04T00:00:05.000Z",
  delayedRecovery,
} = {}) {
  const token = "0x4444444444444444444444444444444444444444";
  const poolAddress = "0x5555555555555555555555555555555555555555";
  const factory = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
  const transactionHash = `0x${"11".repeat(32)}`;
  const blockHash = `0x${"77".repeat(32)}`;
  const activationTransactionHash = `0x${"22".repeat(32)}`;
  const activationBlockHash = `0x${"33".repeat(32)}`;
  const activationLogIndex = 4;
  const logIndex = 7;
  const generationKey = `quote:${FLAP_TRACKED_TOKEN_QUOTE}:generation:${activationBlockHash}:${activationTransactionHash}:${activationLogIndex}`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ generationKey, quoteAddress: FLAP_TRACKED_TOKEN_QUOTE }))
    .digest("hex")
    .slice(0, 20);
  return {
    type: "bsc_launchpad_update",
    kind: "flap_pool_token",
    eventKey: `bsc-flap-pool-token:${generationKey}:${ordinal}:${transactionHash}:${logIndex}:${token}`,
    chainId: 56,
    launcher: FLAP_TRACKED_TOKEN_PORTAL,
    platform: {
      id: "flap",
      name: "Flap",
      trust: "official_verified",
      website: "https://flap.sh",
      twitter: "https://x.com/flapdotsh",
      github: null,
      notifyFirstToken: false,
      notifyFirstInfrastructureActivation: false,
      evidenceUrl: `https://bscscan.com/address/${FLAP_TRACKED_TOKEN_PORTAL}`,
    },
    featurePlatform: "flap",
    featureActivationKey: generationKey,
    featureGenerationKey: generationKey,
    featureTrackedToken: true,
    featureTokenOrdinal: ordinal,
    featureTokenTarget: 3,
    featureFirstToken: ordinal === 1,
    informationalOnly: true,
    autoTradeEligible: false,
    automaticExecution: false,
    strong: true,
    launchCount: ordinal,
    uniqueTokens: ordinal,
    transactionHash,
    blockNumber: 119_900_001,
    blockHash,
    blockTimestamp,
    transactionIndex: 3,
    logIndex,
    tokens: [{
      token,
      isNewContract: true,
      metadata: { name: "First Tracked Token", symbol: "FTT", decimals: 18 },
    }],
    pools: [{
      kind: "v2",
      factory,
      token0: token,
      token1: FLAP_TRACKED_TOKEN_QUOTE,
      pool: poolAddress,
      poolId: null,
      hook: null,
      verifiedDex: true,
    }],
    mode: {
      fingerprint,
      selector: "official-portal-token-created",
      creationTopics: [FLAP_TRACKED_TOKEN_TOPIC],
      customTopics: [FLAP_TRACKED_TOKEN_TOPIC],
      quoteAsset: FLAP_TRACKED_TOKEN_QUOTE,
      quoteName: "Semicon Bull 3X ETF",
      quoteSymbol,
      componentMode: `Flap ${quoteSymbol} 新底池`,
      componentModeAlertEligible: true,
      featureActivationEligible: true,
      monitorOnly: true,
    },
    structural: {
      eligible: true,
      mechanismEvidence: true,
      causalTokenEvent: true,
      controllerKind: "official_direct",
      source: "verified_flap_portal_receipt",
    },
    security: {
      decision: "pass",
      label: "静态检查通过",
      reasons: ["local bytecode checks passed"],
      metrics: { liquidityConfirmed: true },
    },
    featureTokenProof: {
      version: 1,
      activationId: generationKey,
      activationEventKey: `flap-quote:56:${activationTransactionHash}:${activationLogIndex}`,
      quoteAddress: FLAP_TRACKED_TOKEN_QUOTE,
      tokenAddress: token,
      portal: FLAP_TRACKED_TOKEN_PORTAL,
      tokenCreatedTopic: FLAP_TRACKED_TOKEN_TOPIC,
      transactionHash,
      blockNumber: 119_900_001,
      blockHash,
      transactionIndex: 3,
      logIndex,
      canonical: true,
      confirmations: 6,
      requiredConfirmations: 3,
      pairAddress: poolAddress,
      pairKind: "v2",
    },
    ...(delayedRecovery ? { delayedRecovery } : {}),
    launchEvidence: [{ emitter: FLAP_TRACKED_TOKEN_PORTAL, topic: FLAP_TRACKED_TOKEN_TOPIC, token }],
    sourceUrl: `https://bscscan.com/tx/${transactionHash}`,
    activationSourceUrl: `https://bscscan.com/tx/${activationTransactionHash}`,
    explorerUrl: `https://bscscan.com/tx/${transactionHash}`,
    launcherUrl: `https://bscscan.com/address/${FLAP_TRACKED_TOKEN_PORTAL}`,
    observedAt,
  };
}

export function strictFlapConfigurationTokenEvent(options = {}) {
  const event = strictFlapTrackedPoolTokenEvent(options);
  const generation = /^quote:(0x[a-f0-9]{40}):generation:(0x[a-f0-9]{64}):(0x[a-f0-9]{64}):(\d+)$/.exec(event.featureGenerationKey);
  const before = { enabled: true, enabledRaw: 1, defaultCurve: 32, alternativeCurve: 32,
    nativeToQuoteSwapType: 7, dexId: 0 };
  event.featureActivationProof = {
    type: "verified_configuration_change",
    transactionHash: generation[3], blockHash: generation[2], blockNumber: event.blockNumber - 1,
    transactionIndex: 0, logIndex: Number(generation[4]),
    before, after: { ...before, defaultCurve: 33, ...(options.configurationAfter || {}) },
  };
  event.featureActivationProof.configurationLog = encodeFlapQuoteConfigurationLog(
    event.mode.quoteAsset, event.featureActivationProof.after);
  event.mode.componentMode = `Flap ${event.mode.quoteSymbol} 新配置`;
  return event;
}
