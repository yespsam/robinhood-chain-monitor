import path from "node:path";
import { id } from "ethers";
import { config } from "./config.js";
import { Storage } from "./storage.js";
import { analyzeReceipt, bytecodeFeatures, classifyModeObservation, jaccard, modeFamilyKey, readTokenMetadata, V4_INITIALIZE_TOPIC } from "./detector.js";
import { sendAlerts, startAlertOutboxWorker } from "./alerts.js";
import { launchpadByFactory, launchpadByGmgnPlatform, publicLaunchpadProfile, launchpadFactoryAddresses, registerLaunchpadFactory } from "./launchpad-catalog.js";
import { createGithubMonitor } from "./github-monitor.js";
import { assessLocalTokenSecurity } from "./local-security.js";
import { startSiteMonitor } from "./site-monitor.js";
import { buildOfficialCatalog, scanOfficialActivity } from "./official-monitor.js";
import { createEarlyActivityMonitor } from "./early-activity-monitor.js";
import { createTwitterMonitor } from "./twitter-monitor.js";
import {
  contractDiscoveryChainId,
  createPlatformCapabilityMonitor,
  orderedFlapQuoteMetadataRpcUrls,
  resolveFlapQuoteAssetMetadataAcrossRpcUrls,
} from "./platform-capability-monitor.js";
import { createPonsVersionMonitor, PONS_V2_TOKEN_LAUNCHED_TOPIC } from "./pons-version-monitor.js";
import { createPonMonitor } from "./pon-monitor.js";
import { createBinanceMonitor } from "./binance-monitor.js";
import { createBscLaunchpadMonitor, createRpcPool } from "./bsc-launchpad-monitor.js";
import { createFlapQuoteMonitor } from "./flap-quote-monitor.js";
import { createAbortableJsonRpcProvider, createMorphLaunchpadMonitor, mapWithConcurrency } from "./morph-launchpad-monitor.js";
import { createFomoCallMonitor } from "./fomo-call-monitor.js";
import { createFomoHealthMonitor } from "./fomo-health-monitor.js";
import { createFomoThesisMonitor } from "./fomo-thesis-monitor.js";
import { createFomoXCallMonitor } from "./fomo-x-call-monitor.js";
import { createUniswapMonitor } from "./uniswap-monitor.js";
import { createXaiOfficialMonitor } from "./xai-official-monitor.js";
import { createTelegramNewsMonitor } from "./telegram-news-monitor.js";
import { isMonitoringSourceEnabled, isThreePlatformScope } from "./source-controls.js";
import { createRobinhoodScanPolicy, loadRobinhoodSignalCandidate } from "./robinhood-scan-policy.js";
import { createBoundedStartupQueue, startIndependentMonitor } from "./startup-stagger.js";
import { startRuntimeHeartbeat } from "./runtime-heartbeat.js";

for (const level of ["error", "info"]) {
  const write = console[level].bind(console);
  console[level] = (...args) => write(`[${new Date().toISOString()}]`, ...args);
}

let shutdownRequested = false;
let shutdownPromise = null;
let mainPromise = null;
let runtimeHeartbeat = null;
const sleepWakeups = new Set();
const independentStartupTimers = new Set();

const sleep = (ms) => {
  if (shutdownRequested) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sleepWakeups.delete(finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    sleepWakeups.add(finish);
  });
};
const robinhoodRpcReadConcurrency = Math.max(4, Math.min(8, Number(config.robinhoodRpcReadConcurrency || 6)));
const provider = createAbortableJsonRpcProvider(config.rpcUrl, config.chainId, {
  requestTimeoutMs: Math.max(1_000, Number(config.rpcRequestTimeoutMs || 5_000)),
  batchMaxCount: 20,
});
const flapQuoteMetadataProviders = new Map();
const flapQuoteLogProviders = new Map();
const flapQuoteStateProviders = new Map();
let flapQuoteRpcProvider = null;
async function resolveFlapQuoteAssetMetadata({ address, chainId }) {
  if (shutdownRequested) return null;
  const numericChainId = Number(chainId);
  const rpcUrls = numericChainId === 56
    ? orderedFlapQuoteMetadataRpcUrls(config.bscRpcUrl, config.bscRpcUrls)
    : numericChainId === 2818 ? orderedFlapQuoteMetadataRpcUrls(config.morphRpcUrl) : [];
  const configuredTimeoutMs = numericChainId === 56
    ? config.bscRpcRequestTimeoutMs
    : config.morphRpcRequestTimeoutMs;
  const requestTimeoutMs = Math.max(1_000, Math.min(3_000, Number(configuredTimeoutMs) || 3_000));
  return resolveFlapQuoteAssetMetadataAcrossRpcUrls({
    address,
    chainId: numericChainId,
    rpcUrls,
    attemptTimeoutMs: requestTimeoutMs,
    totalTimeoutMs: Math.min(4_500, requestTimeoutMs * 3),
    shouldStop: () => shutdownRequested,
    providerForUrl: (rpcUrl) => {
      const providerKey = `${numericChainId}:${rpcUrl}`;
      let metadataProvider = flapQuoteMetadataProviders.get(providerKey);
      if (!metadataProvider) {
        metadataProvider = createAbortableJsonRpcProvider(rpcUrl, numericChainId, {
          requestTimeoutMs,
          batchMaxCount: 5,
        });
        flapQuoteMetadataProviders.set(providerKey, metadataProvider);
      }
      return metadataProvider;
    },
    readMetadata: readTokenMetadata,
  });
}
const storage = new Storage(config.dataDir);
const factoryScores = new Map();
const robinhoodScanPolicy = createRobinhoodScanPolicy(config);
const referenceProfiles = new Map();
const launcherCodeCache = new Map();
let githubMonitor;
let siteMonitor;
let officialCatalog;
let officialFromBlock = null;
let officialNextScanAt = 0;
let earlyActivityMonitor;
let twitterMonitor;
let platformCapabilityMonitor;
let flapQuoteMonitor;
let ponsVersionMonitor;
let ponMonitor;
let binanceMonitor;
let bscLaunchpadMonitor;
let morphLaunchpadMonitor;
let fomoCallMonitor;
let fomoHealthMonitor;
let fomoThesisMonitor;
let fomoXCallMonitor;
let uniswapMonitor;
let xaiOfficialMonitor;
let telegramNewsMonitor;
let alertOutboxWorker;
const PONS_V1_TOKEN_LAUNCHED_TOPIC = "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a";
const POOL_TOPICS = [
  id("PairCreated(address,address,address,uint256)"),
  id("PoolCreated(address,address,uint24,int24,address)"),
  V4_INITIALIZE_TOPIC,
  ...(config.ponsMonitorEnabled ? [PONS_V1_TOKEN_LAUNCHED_TOPIC, PONS_V2_TOKEN_LAUNCHED_TOPIC] : []),
];
const PONS_V2_FACTORIES = new Set();

function classifyEarlyDeployment(deployment) {
  const features = deployment.bytecodeFeatures;
  let closest = null;
  for (const [address, profile] of referenceProfiles) {
    const similarity = jaccard(features.selectors, profile.selectors);
    if (!closest || similarity > closest.similarity) closest = { address, similarity };
  }
  const infraCount = Object.values(features.infrastructure).filter(Boolean).length;
  const genericScore = Math.min(100, infraCount * 20 + (features.usesCreate2 ? 20 : 0) + (features.selectorCount >= 12 ? 10 : 0));
  deployment.earlyLaunchpad = {
    candidate: genericScore >= 40 || (closest?.similarity || 0) >= 0.45,
    score: genericScore,
    closestKnownFactory: closest?.address || null,
    selectorSimilarity: Number((closest?.similarity || 0).toFixed(4)),
    reason: genericScore >= 40 ? "dex_infrastructure_and_factory_bytecode" : (closest?.similarity || 0) >= 0.45 ? "known_factory_bytecode_similarity" : "insufficient_signal",
  };
  const exact = launchpadByFactory(deployment.contract);
  const similar = launchpadByFactory(closest?.address);
  deployment.launchpad = publicLaunchpadProfile(exact || similar, exact ? "exact_factory" : similar ? "bytecode_similarity" : "unknown");
}

async function classifyLauncher(launch, transaction, previous) {
  const argumentBytes = Math.max(0, ((transaction.data?.length || 10) - 10) / 2);
  const exactKnown = launchpadByFactory(launch.launcher);
  const cachedFeatures = referenceProfiles.get(launch.launcher.toLowerCase());
  let code = null;
  if (!exactKnown || !cachedFeatures) {
    const cacheKey = launch.launcher.toLowerCase();
    code = launcherCodeCache.get(cacheKey);
    if (!code) {
      code = await provider.getCode(launch.launcher);
      launcherCodeCache.set(cacheKey, code);
    }
  }
  const features = cachedFeatures || bytecodeFeatures(code);
  let closest = null;
  for (const [address, profile] of referenceProfiles) {
    if (address.toLowerCase() === launch.launcher.toLowerCase()) continue;
    const similarity = jaccard(features.selectors, profile.selectors);
    if (!closest || similarity > closest.similarity) closest = { address, similarity };
  }
  let classification;
  if (exactKnown) classification = "known_launchpad";
  else if (previous.launches > 0) classification = "reusable_launcher";
  else if (argumentBytes === 0) classification = "single_project_launcher";
  else classification = "reusable_launchpad_candidate";
  return {
    classification,
    label: classification === "known_launchpad" ? "已知发射台" : classification === "reusable_launcher" ? "已重复使用的 Launcher" : classification === "single_project_launcher" ? "单项目启动合约（不是发射台）" : "可复用发射台候选",
    selector: transaction.data?.slice(0, 10) || "0x",
    argumentBytes,
    codeSize: code ? (code.length - 2) / 2 : null,
    usesCreate2: features.usesCreate2,
    infrastructure: features.infrastructure,
    closestKnownFactory: closest?.address || null,
    selectorSimilarity: Number((closest?.similarity || 0).toFixed(4)),
  };
}

function isPonsVersionShape(launch) {
  if (!config.ponsMonitorEnabled) return false;
  const analysis = launch.launcherAnalysis;
  if (launch.mode?.topicShape?.includes(PONS_V2_TOKEN_LAUNCHED_TOPIC)) return true;
  const closest = launchpadByFactory(analysis?.closestKnownFactory);
  const infrastructureCount = Object.values(analysis?.infrastructure || {}).filter(Boolean).length;
  return closest?.id === "pons"
    && launch.mode?.topicShape?.includes(PONS_V1_TOKEN_LAUNCHED_TOPIC)
    && analysis.selectorSimilarity >= 0.15
    && infrastructureCount >= 2;
}

function envelope(item, transaction, block) {
  return {
    ...item,
    chainId: config.chainId,
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    transactionHash: transaction.hash,
    explorerUrl: `https://robinhoodchain.blockscout.com/tx/${transaction.hash}`,
    observedAt: new Date().toISOString(),
  };
}

async function emit(item, transaction, block) {
  const event = envelope(item, transaction, block);
  await storage.append(event);
  if (config.logEventsToStdout) console.log(JSON.stringify(event));
  await sendAlerts(config, event);
}

async function processCandidate(transaction, receipt, block) {
  const number = block.number;
  if (receipt.status !== 1) return;
  if (!robinhoodScanPolicy.shouldAnalyzeTransaction(transaction)) return;
  const knownCaller = transaction.to ? launchpadByFactory(transaction.to) : null;
  const repeatedCaller = transaction.to ? factoryScores.has(transaction.to.toLowerCase()) : false;
  const fastCaller = Boolean(knownCaller || repeatedCaller);
  const { deployment, launch } = await analyzeReceipt(provider, transaction, receipt, block, {
    includeTokenMetadata: !fastCaller,
  });
  if (deployment) {
    classifyEarlyDeployment(deployment);
    if (isMonitoringSourceEnabled(config, deployment)) await emit(deployment, transaction, block);
  }
  if (launch?.launcher) {
    const key = launch.launcher.toLowerCase();
    const previous = factoryScores.get(key) || { launches: 0, firstSeenBlock: number, lastSeenBlock: number, modes: {} };
    const modes = previous.modes || {};
    const currentFamily = modeFamilyKey(launch.mode);
    const previousFamilies = Object.values(modes).map((record) => modeFamilyKey(record.shape));
    const modeWasSeen = previousFamilies.includes(currentFamily);
    const modeObservation = classifyModeObservation(previous, launch.mode);
    const nextModes = {
      ...modes,
      [launch.modeFingerprint]: {
        firstSeenBlock: modes[launch.modeFingerprint]?.firstSeenBlock || number,
        lastSeenBlock: number,
        count: (modes[launch.modeFingerprint]?.count || 0) + 1,
        shape: launch.mode,
      },
    };
    const nextFactoryScore = { ...previous, launches: previous.launches + 1, lastSeenBlock: number, modes: nextModes };
    launch.launchCount = nextFactoryScore.launches;
    launch.factoryStatus = config.knownFactories.has(key) ? "known" : previous.launches ? "rediscovered" : "new_candidate";
    const matched = launch.tokens.map((token) => storage.gmgn.tokens?.[token.token.toLowerCase()]).find(Boolean);
    launch.gmgnStatus = config.gmgnIntegratedFactories.has(key) || matched ? "integrated" : "gmgn_gap_candidate";
    launch.gmgnPlatform = matched?.platform || null;
    launch.modeStatus = isThreePlatformScope(config)
      ? modeObservation.status === "new_mode_candidate" ? "new_mode_pending" : modeObservation.status
      : modeObservation.status === "new_mode_confirmed" ? "known_mode" : modeObservation.status;
    if (["new_mode_pending", "new_mode_confirmed"].includes(launch.modeStatus)) {
      launch.modeConfirmation = {
        observations: modeObservation.previousObservations + 1,
        required: 2,
        status: launch.modeStatus === "new_mode_confirmed" ? "confirmed" : "pending",
      };
    }
    launch.launcherAnalysis = await classifyLauncher(launch, transaction, previous);
    let exactProfile = launchpadByFactory(launch.launcher);
    let profile = exactProfile || launchpadByGmgnPlatform(launch.gmgnPlatform);
    let inferredPonsVersion = false;
    if (!profile && isPonsVersionShape(launch)) {
      inferredPonsVersion = true;
      registerLaunchpadFactory("pons", launch.launcher);
      exactProfile = launchpadByFactory(launch.launcher);
      profile = exactProfile;
    }
    launch.launchpad = publicLaunchpadProfile(profile, exactProfile ? (inferredPonsVersion ? "pons_version_shape" : "exact_factory") : profile ? "gmgn_platform" : "unknown");
    if (!config.ponsMonitorEnabled && launch.launchpad?.id === "pons") return;
    const isPonsV2 = PONS_V2_FACTORIES.has(key) || launch.mode?.topicShape?.includes(PONS_V2_TOKEN_LAUNCHED_TOPIC);
    if (launch.launchpad?.id === "pons" && isPonsV2) {
      launch.ponsVersion = "v2";
      launch.launchpad = {
        ...launch.launchpad,
        version: "v2",
        model: "Bonding curve → Uniswap V4；支持自定义报价资产；毕业后永久锁定流动性",
      };
      await ponsVersionMonitor?.observeLaunchFactory(key, {
        transactionHash: transaction.hash,
        blockNumber: number,
      });
    }
    if (fastCaller && ["new_mode_candidate", "new_mode_pending", "new_mode_confirmed"].includes(launch.modeStatus)) {
      launch.tokens = await Promise.all(launch.tokens.map(async (token) => ({
        ...token,
        metadata: await readTokenMetadata(provider, token.token, number, token.isNewContract),
      })));
    }
    if (["new_mode_candidate", "new_mode_pending", "new_mode_confirmed"].includes(launch.modeStatus)) {
      launch.modeDifference = {
        previous: [...new Set(Object.values(modes).map((record) => ({ selector: record.shape?.selector || "0x", poolKinds: record.shape?.poolKinds || [] })).map(JSON.stringify))].map((value) => JSON.parse(value)),
        current: { selector: launch.mode.selector, poolKinds: launch.mode.poolKinds },
      };
    }
    const monitoringEnabled = isMonitoringSourceEnabled(config, launch);
    if (monitoringEnabled && (launch.factoryStatus === "new_candidate" || launch.gmgnStatus === "gmgn_gap_candidate")) {
      void githubMonitor?.discoverByContract(launch.launcher, launch.launchpad?.name || "未知候选");
      const metadata = launch.tokens.find((token) => token.metadata?.website)?.metadata;
      if (metadata) {
        void siteMonitor?.watch({ factory: launch.launcher, website: metadata.website, name: metadata.name, twitter: metadata.twitter, telegram: metadata.telegram, discord: metadata.discord })
          .catch((error) => console.error(`[site-watch] ${launch.launcher}: ${error.message}`));
      }
    }
    const needsSafetyGate = monitoringEnabled && (["new_mode_candidate", "new_mode_confirmed"].includes(launch.modeStatus) || launch.factoryStatus === "new_candidate");
    if (launch.launchpad?.id !== "pons" && needsSafetyGate && launch.tokens[0]?.token) {
      launch.security = await assessLocalTokenSecurity(provider, launch.tokens[0].token, launch.pools);
    }
    if (config.earlyActivityMonitorEnabled && monitoringEnabled && launch.launchpad?.id !== "pons") {
      await earlyActivityMonitor?.add({ ...launch, blockNumber: number, observedAt: new Date(Number(block.timestamp) * 1_000).toISOString() });
    }
    if (monitoringEnabled && (launch.launchpad?.id !== "pons" || launch.modeStatus === "new_mode_candidate")) {
      await emit(launch, transaction, block);
    }
    factoryScores.set(key, nextFactoryScore);
    return;
  }
}

async function processRange(fromBlock, toBlock) {
  const signalLogs = await provider.getLogs({ fromBlock, toBlock, topics: [POOL_TOPICS] });
  const hashes = [...new Set(signalLogs.map((log) => log.transactionHash))];
  // Start enough reads together for ethers to JSON-RPC batch them, but cap
  // logical transaction/receipt work so a dense range cannot create hundreds
  // of simultaneous sockets. Preserve chain order before doing stateful work.
  const candidates = (await mapWithConcurrency(
    hashes,
    robinhoodRpcReadConcurrency,
    (hash) => loadRobinhoodSignalCandidate(provider, hash, robinhoodScanPolicy),
  ))
    .filter(Boolean)
    .sort((left, right) => Number(left.receipt.blockNumber) - Number(right.receipt.blockNumber)
      || Number(left.receipt.index ?? left.receipt.transactionIndex ?? 0) - Number(right.receipt.index ?? right.receipt.transactionIndex ?? 0)
      || String(left.transaction.hash).localeCompare(String(right.transaction.hash)));
  for (const candidate of candidates) {
    const { transaction, receipt } = candidate;
    const block = await provider.getBlock(receipt.blockNumber);
    await processCandidate(transaction, receipt, block);
  }
  if (config.officialActivityMonitorEnabled && officialCatalog && Date.now() >= officialNextScanAt) {
    const scanFrom = Math.max(officialFromBlock ?? fromBlock, toBlock - 2_000);
    try {
      const activities = await scanOfficialActivity(provider, scanFrom, toBlock, officialCatalog);
      const activityEvidence = await mapWithConcurrency(
        activities,
        robinhoodRpcReadConcurrency,
        async (activity) => {
          const [transaction, block] = await Promise.all([
            provider.getTransaction(activity.transactionHash),
            provider.getBlock(activity.blockNumber),
          ]);
          return { activity, transaction, block };
        },
      );
      for (const { activity, transaction, block } of activityEvidence) {
        if (transaction && block) await emit(activity, transaction, block);
      }
      officialFromBlock = toBlock + 1;
    } catch (error) {
      console.error(`[official] ${scanFrom}-${toBlock}: ${error.message}`);
    }
    officialNextScanAt = Date.now() + 30_000;
  }
  const endBlock = await provider.getBlock(toBlock);
  if (endBlock) await storage.saveBlock(endBlock, factoryScores);
}

function startIndependentMonitors() {
  if (shutdownRequested) return;
  alertOutboxWorker = startAlertOutboxWorker(config);
  const pendingBscGithubCandidates = createBoundedStartupQueue();
  const pendingBscSiteCandidates = createBoundedStartupQueue();
  const flushPending = (queue, deliver, label) => {
    const pending = queue.drain();
    void (async () => {
      for (const item of pending) {
        if (shutdownRequested) return;
        try {
          await deliver(item);
        } catch (error) {
          console.error(`[${label}-deferred] ${error.message}`);
        }
      }
    })();
  };
  const deliverGithubCandidate = ({ launcher, platformName }) => githubMonitor.discoverByContract(launcher, platformName);
  const deliverSiteCandidate = (candidate) => siteMonitor.watch(candidate);
  const onBscLaunchpadCandidate = async (event) => {
    if (shutdownRequested) return;
    if (!isMonitoringSourceEnabled(config, event)) return;
    const platformName = event.attribution?.platform?.name || event.platform?.name || "未知 BSC 发射台候选";
    const key = event.transactionHash || `${event.launcher}:${event.tokens?.[0]?.token || "unknown"}`;
    const githubCandidate = { launcher: event.launcher, platformName };
    if (githubMonitor) await deliverGithubCandidate(githubCandidate);
    else pendingBscGithubCandidates.remember(key, githubCandidate);

    if (shutdownRequested) return;
    const metadata = event.tokens?.[0]?.metadata || {};
    const website = metadata.website || event.marketContext?.website || event.attribution?.platform?.website || event.platform?.website;
    if (!website) return;
    const siteCandidate = {
      factory: event.launcher,
      website,
      name: platformName,
      twitter: metadata.twitter || event.marketContext?.twitter || event.attribution?.platform?.twitter || event.platform?.twitter,
      telegram: metadata.telegram || event.marketContext?.telegram,
    };
    if (siteMonitor) await deliverSiteCandidate(siteCandidate);
    else pendingBscSiteCandidates.remember(key, siteCandidate);
  };
  const registerBscDiscovery = async (signal) => {
    if (shutdownRequested) return false;
    if (contractDiscoveryChainId(signal) !== 56) return false;
    if (!isMonitoringSourceEnabled(config, signal)) return;
    return bscLaunchpadMonitor?.registerDiscoveryCandidates(
      (signal.addresses || []).map((address) => ({ ...signal, address })),
    );
  };
  const startMonitor = (name, start) => {
    const handle = startIndependentMonitor(config, name, () => {
      if (!shutdownRequested) start();
    }, {
      onError: (error) => console.error(`[${name}-init] ${error.message}`),
    });
    if (handle !== undefined && handle !== null) independentStartupTimers.add(handle);
    return handle;
  };
  startMonitor("bsc", () => {
    bscLaunchpadMonitor = createBscLaunchpadMonitor(config, { onLaunchpadCandidate: onBscLaunchpadCandidate });
  });
  if (config.morphMonitorEnabled) startMonitor("morph", () => {
    morphLaunchpadMonitor = createMorphLaunchpadMonitor(config);
  });
  startMonitor("github", () => {
    githubMonitor = createGithubMonitor(config, { onContractDiscovery: registerBscDiscovery });
    flushPending(pendingBscGithubCandidates, deliverGithubCandidate, "github");
  });
  startMonitor("site", () => {
    siteMonitor = startSiteMonitor(config, {
      onContractDiscovery: registerBscDiscovery,
      onOfficialRepository: (repository, evidence) => githubMonitor?.confirmOfficialRepository(repository, evidence),
    });
    flushPending(pendingBscSiteCandidates, deliverSiteCandidate, "site-watch");
  });
  if (config.twitterMonitorEnabled || config.binanceCriticalXMonitorEnabled || config.focusCriticalXMonitorEnabled || config.ponMonitorEnabled) startMonitor("twitter", () => {
    twitterMonitor = createTwitterMonitor(config, {
      onOfficialRepository: (repository, evidence) => githubMonitor?.confirmOfficialRepository(repository, evidence),
    });
  });
  startMonitor("platform-capability", () => {
    platformCapabilityMonitor = createPlatformCapabilityMonitor(config, {
      onContractDiscovery: registerBscDiscovery,
      resolveFlapQuoteAssetMetadata,
      onFlapFeatureActivation: async (records) => {
        if (shutdownRequested) return;
        await Promise.all([
          bscLaunchpadMonitor?.registerFlapFeatureActivations(records, { awaitReplay: false }),
          morphLaunchpadMonitor?.registerFlapFeatureActivations(records),
        ]);
      },
      onFourMemeFeatureActivation: (records) => shutdownRequested
        ? undefined
        : bscLaunchpadMonitor?.registerFourMemeFeatureActivations(records, { awaitReplay: false }),
    });
  });
  if (config.flapQuoteMonitorEnabled) startMonitor("flap-quote", () => {
    flapQuoteRpcProvider ||= createRpcPool(
      orderedFlapQuoteMetadataRpcUrls(config.bscRpcUrl, config.bscRpcUrls),
      config.bscArchiveRpcUrls || [],
      2,
      {
        requestTimeoutMs: Math.max(1_000, Number(config.bscRpcRequestTimeoutMs || 7_000)),
        standardConcurrency: 2,
      },
    );
    for (const rpcUrl of config.flapQuoteLogRpcUrls) {
      const sourceId = new URL(rpcUrl).origin.toLowerCase();
      if (!flapQuoteLogProviders.has(sourceId)) {
        flapQuoteLogProviders.set(sourceId, createAbortableJsonRpcProvider(rpcUrl, 56, {
          requestTimeoutMs: Math.max(1_000, Math.min(7_000, Number(config.bscRpcRequestTimeoutMs || 7_000))),
          batchMaxCount: 1,
        }));
      }
    }
    for (const rpcUrl of config.flapQuoteStateRpcUrls) {
      const sourceId = new URL(rpcUrl).origin.toLowerCase();
      if (!flapQuoteStateProviders.has(sourceId)) {
        flapQuoteStateProviders.set(sourceId, createAbortableJsonRpcProvider(rpcUrl, 56, {
          requestTimeoutMs: Math.max(1_000, Math.min(7_000, Number(config.bscRpcRequestTimeoutMs || 7_000))),
          batchMaxCount: 1,
        }));
      }
    }
    flapQuoteMonitor = createFlapQuoteMonitor(config, {
      provider: flapQuoteRpcProvider,
      logVerificationProviders: [...flapQuoteLogProviders].map(([sourceId, logProvider]) => ({
        sourceId,
        provider: logProvider,
      })),
      stateVerificationProviders: [...flapQuoteStateProviders].map(([sourceId, stateProvider]) => ({
        sourceId,
        provider: stateProvider,
      })),
      onFlapQuotePoolLifecycle: async (record) => {
        if (shutdownRequested) {
          throw new Error("BSC launchpad monitor is shutting down");
        }
        if (typeof bscLaunchpadMonitor?.registerFlapQuotePoolLifecycle !== "function") {
          throw new Error("BSC launchpad monitor lifecycle registry is not ready");
        }
        return bscLaunchpadMonitor.registerFlapQuotePoolLifecycle(record);
      },
    });
  });
  if (config.binanceMonitorEnabled) startMonitor("binance", () => {
    binanceMonitor = createBinanceMonitor(config);
  });
  if (config.uniswapMonitorEnabled) startMonitor("uniswap", () => {
    uniswapMonitor = createUniswapMonitor(config);
  });
  if (config.xaiOfficialMonitorEnabled) startMonitor("xai-official", () => {
    xaiOfficialMonitor = createXaiOfficialMonitor(config);
  });
  if (config.telegramNewsMonitorEnabled) startMonitor("telegram-news", () => {
    telegramNewsMonitor = createTelegramNewsMonitor(config);
  });
  const anyFomoLaneEnabled = config.fomoBuyMonitorEnabled
    || config.fomoSmartMoneyMonitorEnabled
    || config.fomoPublishedCallEnabled
    || config.fomoXCallEnabled;
  if (config.fomoCallEnabled && config.fomoHealthMonitorEnabled && anyFomoLaneEnabled) {
    // This watchdog intentionally stays in the main process when the scanners
    // run in the standalone worker. Persisted heartbeats still reveal a stuck
    // or dead worker, and health transitions use the main durable outbox.
    fomoHealthMonitor = createFomoHealthMonitor(config);
  }
  if (config.fomoCallEnabled && !config.fomoCallStandalone
    && (config.fomoBuyMonitorEnabled || config.fomoSmartMoneyMonitorEnabled)) {
    fomoCallMonitor = createFomoCallMonitor(config);
  }
  if (config.fomoCallEnabled && !config.fomoCallStandalone && config.fomoPublishedCallEnabled) {
    fomoThesisMonitor = createFomoThesisMonitor(config, { sendAlertsImpl: sendAlerts });
  }
  if (config.fomoCallEnabled && !config.fomoCallStandalone && config.fomoXCallEnabled) {
    fomoXCallMonitor = createFomoXCallMonitor(config, { sendAlertsImpl: sendAlerts });
  }
  if (config.ponsMonitorEnabled) {
    ponsVersionMonitor = createPonsVersionMonitor(config, {
      provider,
      onOfficialRepository: (repository, evidence) => githubMonitor?.confirmOfficialRepository(repository, evidence),
      onFactory: async ({ address, version }) => {
        if (shutdownRequested) return;
        registerLaunchpadFactory("pons", address);
        if (version === "v2") PONS_V2_FACTORIES.add(address.toLowerCase());
        try {
          const code = await provider.getCode(address);
          if (code && code !== "0x") referenceProfiles.set(address.toLowerCase(), bytecodeFeatures(code));
        } catch (error) {
          console.error(`[pons-v2] profile ${address}: ${error.message}`);
        }
      },
    });
  }
  if (config.ponMonitorEnabled) startMonitor("pon", () => {
    ponMonitor = createPonMonitor(config, { provider });
  });
}

async function runChainMonitor() {
  if (shutdownRequested) return;
  officialCatalog = config.officialActivityMonitorEnabled
    ? await buildOfficialCatalog(provider, config.dataDir, { ponsMonitorEnabled: config.ponsMonitorEnabled })
    : null;
  if (shutdownRequested) return;
  const persistedFactoryScores = robinhoodScanPolicy.retainedFactoryScoreEntries(
    Object.entries(storage.state.factoryScores || {}),
  );
  for (const [address, score] of persistedFactoryScores) factoryScores.set(address, score);
  const network = await provider.getNetwork();
  if (shutdownRequested) return;
  if (Number(network.chainId) !== config.chainId) throw new Error(`RPC chain ID ${network.chainId} != configured ${config.chainId}`);
  for (const address of new Set([...config.knownFactories, ...launchpadFactoryAddresses()])) {
    if (shutdownRequested) return;
    if (!config.ponsMonitorEnabled && launchpadByFactory(address)?.id === "pons") continue;
    if (!isMonitoringSourceEnabled(config, launchpadByFactory(address) || { factory: address })) continue;
    try {
      referenceProfiles.set(address.toLowerCase(), bytecodeFeatures(await provider.getCode(address)));
    } catch (error) {
      console.error(`[profile] ${address}: ${error.message}`);
    }
  }

  let next;
  if (storage.state.lastBlock !== null) next = storage.state.lastBlock + 1;
  else if (config.startBlock === "latest") next = Math.max(0, (await provider.getBlockNumber()) - config.confirmations);
  else next = Number(config.startBlock);

  const startupSafeHead = (await provider.getBlockNumber()) - config.confirmations;
  if (shutdownRequested) return;
  const catchupLimit = robinhoodScanPolicy.catchupLimit(config.maxCatchupBlocks);
  if (catchupLimit > 0 && startupSafeHead - next > catchupLimit) {
    const previous = next;
    next = startupSafeHead - catchupLimit + 1;
    console.error(`[monitor] backlog=${startupSafeHead - previous + 1} exceeds limit=${catchupLimit}; fast-forwarding ${previous}->${next}`);
  }

  if (config.earlyActivityMonitorEnabled) {
    earlyActivityMonitor ||= createEarlyActivityMonitor({
      provider, config,
      onEvent: async (event) => {
        const txHash = event.lastTransactionHash;
        const enriched = { ...event, chainId: config.chainId, explorerUrl: txHash ? `https://robinhoodchain.blockscout.com/tx/${txHash}` : event.entry?.pool?.pool ? `https://robinhoodchain.blockscout.com/address/${event.entry.pool.pool}` : null };
        await storage.append(enriched);
        await sendAlerts(config, enriched);
      },
    });
    await earlyActivityMonitor.ready;
  }

  console.error(`[monitor] chain=${config.chainId} next=${next} rpc=${new URL(config.rpcUrl).host}`);
  while (!shutdownRequested) {
    try {
      const safeHead = (await provider.getBlockNumber()) - config.confirmations;
      while (!shutdownRequested && next <= safeHead) {
        const end = Math.min(safeHead, next + 199);
        await processRange(next, end);
        next = end + 1;
      }
    } catch (error) {
      if (shutdownRequested) return;
      console.error(`[rpc-retry] ${error.message}`);
      await sleep(Math.max(5_000, config.pollIntervalMs));
    }
    if (shutdownRequested || config.once) break;
    await sleep(config.pollIntervalMs);
  }
}

async function main() {
  await storage.init();
  if (shutdownRequested) return;
  startIndependentMonitors();
  while (!shutdownRequested) {
    try {
      await runChainMonitor();
      return;
    } catch (error) {
      if (shutdownRequested) return;
      if (config.once) throw error;
      console.error(`[chain-init-retry] ${error.message}`);
      await sleep(Math.max(10_000, config.pollIntervalMs));
    }
  }
}

function stopNewScheduling() {
  shutdownRequested = true;
  for (const timer of independentStartupTimers) clearTimeout(timer);
  independentStartupTimers.clear();
  for (const wake of [...sleepWakeups]) wake();
}

function createdMonitorEntries() {
  return [
    ["alert-outbox", alertOutboxWorker],
    ["github", githubMonitor],
    ["site", siteMonitor],
    ["early-activity", earlyActivityMonitor],
    ["twitter", twitterMonitor],
    ["platform-capability", platformCapabilityMonitor],
    ["flap-quote", flapQuoteMonitor],
    ["pons-version", ponsVersionMonitor],
    ["pon", ponMonitor],
    ["binance", binanceMonitor],
    ["bsc", bscLaunchpadMonitor],
    ["morph", morphLaunchpadMonitor],
    ["fomo-call", fomoCallMonitor],
    ["fomo-health", fomoHealthMonitor],
    ["fomo-thesis", fomoThesisMonitor],
    ["fomo-x-call", fomoXCallMonitor],
    ["uniswap", uniswapMonitor],
    ["xai-official", xaiOfficialMonitor],
    ["telegram-news", telegramNewsMonitor],
  ].filter(([, monitor]) => monitor?.stop);
}

function gracefulShutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  stopNewScheduling();
  console.error(`[shutdown] ${signal} received; draining monitors`);

  const attempt = (async () => {
    const monitorEntries = createdMonitorEntries();
    const drainResults = await Promise.allSettled([
      ...monitorEntries.map(([, monitor]) => Promise.resolve().then(() => monitor.stop())),
      ...(mainPromise ? [mainPromise] : []),
    ]);
    let failed = false;
    drainResults.forEach((result, index) => {
      if (result.status !== "rejected") return;
      failed = true;
      const label = index < monitorEntries.length ? monitorEntries[index][0] : "chain";
      console.error(`[shutdown] ${label}: ${result.reason?.message || result.reason}`);
    });

    const ownedProviders = [...new Set([
      provider,
      flapQuoteRpcProvider,
      ...flapQuoteMetadataProviders.values(),
      ...flapQuoteLogProviders.values(),
      ...flapQuoteStateProviders.values(),
    ].filter(Boolean))];
    const providerResults = await Promise.allSettled(
      ownedProviders.map((rpc) => Promise.resolve().then(() => rpc.destroy?.())),
    );
    providerResults.forEach((result) => {
      if (result.status !== "rejected") return;
      failed = true;
      console.error(`[shutdown] provider: ${result.reason?.message || result.reason}`);
    });
    flapQuoteMetadataProviders.clear();
    flapQuoteLogProviders.clear();
    flapQuoteStateProviders.clear();

    const [heartbeatResult] = await Promise.allSettled([
      Promise.resolve().then(() => runtimeHeartbeat?.stop()),
    ]);
    if (heartbeatResult.status === "rejected") {
      failed = true;
      console.error(`[shutdown] runtime-heartbeat: ${heartbeatResult.reason?.message || heartbeatResult.reason}`);
    }
    if (failed) process.exitCode = 1;
    console.error(`[shutdown] ${failed ? "completed with errors" : "complete"}`);
  })();
  shutdownPromise = attempt;
  return attempt;
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

runtimeHeartbeat = startRuntimeHeartbeat({
  file: path.join(config.dataDir, "main-runtime-heartbeat.json"),
  producer: "main",
});
mainPromise = main();
mainPromise.catch((error) => {
  console.error("[fatal]", error);
  process.exitCode = 1;
});
