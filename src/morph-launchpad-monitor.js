import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  Interface,
  FetchRequest,
  JsonRpcProvider,
  getAddress,
  id,
  keccak256,
  toQuantity,
} from "ethers";
import WebSocket from "ws";
import { sendAlerts } from "./alerts.js";
import { assessLocalTokenSecurity } from "./local-security.js";

export const MORPH_CHAIN_ID = 2818;
export const MORPH_FLAP_PORTAL = "0x4267F317adee7C6478a5EE92985c2BD5D855E274";
export const MORPH_FLAP_DEPLOY_BLOCK = 1_150_754;
export const MORPH_FLAP_TOKEN_CREATED_TOPIC = "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603";
export const MORPH_FLAP_LAUNCHED_TO_DEX_TOPIC = "0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d";
export const MORPH_EIP1967_UPGRADED_TOPIC = id("Upgraded(address)");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const STATE_VERSION = 1;
const EXPLORER = "https://explorer.morph.network";
const FLAP_EVIDENCE = "https://docs.flap.sh/flap/developers/deployed-contract-addresses";
const FLAP_BOARD = "https://flap.sh/morph/board";
const LONG_APP = "https://app.long.xyz/";
const LONG_SITE = "https://long.xyz/";
const DEFAULT_RPC_URLS = [
  "https://rpc-quicknode.morph.network",
  "https://rpc.morph.network",
  "https://rpc.morphl2.io",
];

const portalInterface = new Interface([
  "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
  "event TokenCurveSet(address token,address curve,uint256 curveParameter)",
  "event TokenCurveSetV2(address token,uint256 r,uint256 h,uint256 k)",
  "event TokenDexSupplyThreshSet(address token,uint256 dexSupplyThresh)",
  "event TokenQuoteSet(address token,address quoteToken)",
  "event TokenMigratorSet(address token,uint8 migratorType)",
  "event TokenVersionSet(address token,uint8 version)",
  "event FlapTokenTaxSet(address token,uint256 tax)",
  "event FlapTokenStaged(uint256 ts,address creator,address token)",
  "event TokenExtensionEnabled(address token,bytes32 extensionID,address extensionAddress,uint8 version)",
  "event TokenDexPreferenceSet(address token,uint8 dexId,uint8 lpFeeProfile)",
  "event FlapTokenAsymmetricTaxSet(address token,uint256 buyTax,uint256 sellTax)",
  "event VanityTokenCreated(address token,address creator,address beneficiary)",
  "event LaunchedToDEX(address token,address pool,uint256 tokenAmount,uint256 quoteAmount)",
  "function version() view returns (string)",
]);

const HISTORICAL_FEATURE_EVENTS = [
  "TokenVersionSet",
  "TokenMigratorSet",
  "TokenCurveSet",
  "TokenCurveSetV2",
  "TokenDexSupplyThreshSet",
  "TokenQuoteSet",
  "TokenExtensionEnabled",
  "TokenDexPreferenceSet",
  "FlapTokenAsymmetricTaxSet",
  "FlapTokenStaged",
  "FlapTokenTaxSet",
];

const normalizedAddress = (value) => {
  try { return getAddress(value); } catch { return null; }
};
const lowerAddress = (value) => normalizedAddress(value)?.toLowerCase() || null;
const iso = (value = Date.now()) => new Date(value).toISOString();
const numberFromHex = (value) => Number(BigInt(value));
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return typeof value === "bigint" ? value.toString() : value;
};

export async function mapWithConcurrency(items, limit, worker) {
  const values = Array.from(items || []);
  if (!values.length) return [];
  const concurrency = Math.max(1, Math.min(values.length, Math.floor(Number(limit) || 1)));
  const results = new Array(values.length);
  let cursor = 0;
  let firstError = null;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < values.length && !firstError) {
      const index = cursor++;
      try {
        results[index] = await worker(values[index], index);
      } catch (error) {
        firstError ||= error;
      }
    }
  }));
  if (firstError) throw firstError;
  return results;
}

export function createAbortableJsonRpcProvider(url, chainId, {
  requestTimeoutMs = 5_000,
  batchMaxCount = 10,
  fetchImpl = fetch,
} = {}) {
  const timeoutMs = Math.max(1, Number(requestTimeoutMs) || 5_000);
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  request.getUrlFunc = async (prepared, signal) => {
    const controller = new AbortController();
    let abortKind = null;
    const timeout = setTimeout(() => {
      abortKind = "timeout";
      controller.abort();
    }, Math.max(1, Number(prepared.timeout) || timeoutMs));
    signal?.addListener(() => {
      abortKind ||= "cancelled";
      controller.abort();
    });
    try {
      const response = await fetchImpl(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body ? Buffer.from(prepared.body) : undefined,
        signal: controller.signal,
      });
      return {
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    } catch (error) {
      if (abortKind) {
        const aborted = new Error(abortKind === "timeout"
          ? `request timed out after ${timeoutMs}ms`
          : "request cancelled");
        aborted.code = abortKind === "timeout" ? "TIMEOUT" : "CANCELLED";
        throw aborted;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  return new JsonRpcProvider(request, chainId, {
    staticNetwork: true,
    batchMaxCount: Math.max(1, Number(batchMaxCount) || 1),
  });
}
const digest = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const compactError = (error) => String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 240);

function defaultKnownFeatures() {
  return [
    // These are protocol defaults, not every capability present in the ABI.
    // Non-default versions/migrators/curves are learned from historical event
    // evidence so their first actual activation remains alertable.
    "token-version:0",
    "migrator:0",
    `quote:${ZERO_ADDRESS}`,
    "curve:legacy",
  ];
}

function emptyState() {
  return {
    version: STATE_VERSION,
    chainId: MORPH_CHAIN_ID,
    baselineComplete: false,
    cursor: null,
    lastScannedBlock: null,
    lastScannedBlockHash: null,
    seenTransactions: {},
    knownFeatures: defaultKnownFeatures(),
    featureOrigins: {},
    pendingFeatures: {},
    officialActivations: {},
    alertedKeys: [],
    alertOrigins: {},
    reorgOrphanedEventKeys: [],
    upgradeHistory: [],
    portal: {
      address: MORPH_FLAP_PORTAL,
      implementation: null,
      implementationCodeHash: null,
      protocolVersion: null,
      pendingUpgrade: null,
    },
    long: {
      initialized: false,
      contentHash: null,
      candidate: null,
      lastAlertHash: null,
      roots: {},
      checkedAt: null,
    },
    health: {
      status: "starting",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      headBlock: null,
      safeBlock: null,
      lagBlocks: null,
      websocket: "disabled",
    },
  };
}

function normalizeState(value) {
  const base = emptyState();
  const parsed = value && typeof value === "object" ? value : {};
  const merged = {
    ...base,
    ...parsed,
    portal: { ...base.portal, ...(parsed.portal || {}) },
    long: { ...base.long, ...(parsed.long || {}) },
    health: { ...base.health, ...(parsed.health || {}) },
  };
  merged.chainId = MORPH_CHAIN_ID;
  merged.knownFeatures = [...new Set([...defaultKnownFeatures(), ...(Array.isArray(parsed.knownFeatures) ? parsed.knownFeatures : [])])];
  merged.alertedKeys = [...new Set(Array.isArray(parsed.alertedKeys) ? parsed.alertedKeys : [])].slice(-500);
  merged.pendingFeatures = parsed.pendingFeatures && typeof parsed.pendingFeatures === "object" ? parsed.pendingFeatures : {};
  merged.officialActivations = parsed.officialActivations && typeof parsed.officialActivations === "object" ? parsed.officialActivations : {};
  merged.seenTransactions = parsed.seenTransactions && typeof parsed.seenTransactions === "object" ? parsed.seenTransactions : {};
  merged.featureOrigins = parsed.featureOrigins && typeof parsed.featureOrigins === "object" ? parsed.featureOrigins : {};
  merged.alertOrigins = parsed.alertOrigins && typeof parsed.alertOrigins === "object" ? parsed.alertOrigins : {};
  merged.reorgOrphanedEventKeys = [...new Set(Array.isArray(parsed.reorgOrphanedEventKeys) ? parsed.reorgOrphanedEventKeys : [])].slice(-100);
  merged.upgradeHistory = Array.isArray(parsed.upgradeHistory) ? parsed.upgradeHistory.slice(-100) : [];
  return merged;
}

async function atomicWriteJson(fsImpl, file, value) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fsImpl.rename(temporary, file);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function parsePortalEvent(log) {
  if (lowerAddress(log?.address) !== MORPH_FLAP_PORTAL.toLowerCase()) return null;
  if (!Array.isArray(log?.topics) || typeof log?.data !== "string") return null;
  try { return portalInterface.parseLog({ topics: log.topics.filter(Boolean), data: log.data }); } catch { return null; }
}

function featuresForParsedEvent(parsed) {
  if (!parsed) return [];
  const value = (name) => parsed.args?.[name];
  if (parsed.name === "TokenVersionSet") return [`token-version:${Number(value("version"))}`];
  if (parsed.name === "TokenMigratorSet") return [`migrator:${Number(value("migratorType"))}`];
  if (parsed.name === "TokenQuoteSet") return [`quote:${lowerAddress(value("quoteToken")) || ZERO_ADDRESS}`];
  if (parsed.name === "TokenCurveSet") {
    const curve = lowerAddress(value("curve"));
    const profile = {
      curve: curve || ZERO_ADDRESS,
      parameter: value("curveParameter").toString(),
    };
    return [
      "curve:legacy",
      `curve-legacy-profile:${digest(profile).slice(0, 24)}`,
      ...(curve && curve !== ZERO_ADDRESS ? [`curve-address:${curve}`] : []),
    ];
  }
  if (parsed.name === "TokenCurveSetV2") {
    const tuple = {
      r: value("r").toString(),
      h: value("h").toString(),
      k: value("k").toString(),
    };
    return ["curve:v2", `curve-v2-profile:${digest(tuple).slice(0, 24)}`];
  }
  // DexSupplyThreshType is a per-token launch choice exposed by the current
  // product, not a platform mode by itself. Retain its exact value in `mode`
  // for context, but require a new quote/curve/version/migrator or official
  // activation before it can trigger an alert.
  if (parsed.name === "TokenDexSupplyThreshSet") return [];
  if (parsed.name === "TokenExtensionEnabled") {
    return [`extension:${String(value("extensionID")).toLowerCase()}:${lowerAddress(value("extensionAddress"))}:${Number(value("version"))}`];
  }
  if (parsed.name === "TokenDexPreferenceSet") return [`dex-preference:${Number(value("dexId"))}:${Number(value("lpFeeProfile"))}`];
  if (parsed.name === "FlapTokenAsymmetricTaxSet") return ["tax:asymmetric"];
  if (parsed.name === "FlapTokenStaged") return ["launch:two-step-staged"];
  if (parsed.name === "FlapTokenTaxSet") return ["token:taxed"];
  return [];
}

export function parseMorphFlapCreation(receipt, transaction, implementation = null, targetLogIndex = null) {
  if (!receipt || Number(BigInt(receipt.status ?? "0x0")) !== 1) return null;
  const portalLogs = (receipt.logs || []).filter((log) => lowerAddress(log.address) === MORPH_FLAP_PORTAL.toLowerCase());
  const creationLog = portalLogs.find((log) => String(log.topics?.[0] || "").toLowerCase() === MORPH_FLAP_TOKEN_CREATED_TOPIC
    && (targetLogIndex == null || Number(BigInt(log.logIndex || "0x0")) === Number(targetLogIndex)));
  const creation = parsePortalEvent(creationLog);
  if (!creation || creation.name !== "TokenCreated") return null;
  const token = normalizedAddress(creation.args.token);
  if (!token) return null;

  const mode = {
    implementation: lowerAddress(implementation),
    entrySelector: lowerAddress(transaction?.to) === MORPH_FLAP_PORTAL.toLowerCase()
      && /^0x[0-9a-f]{8}/i.test(transaction?.input || transaction?.data || "")
      ? String(transaction.input || transaction.data).slice(0, 10).toLowerCase()
      : null,
    tokenVersion: 0,
    migratorType: 0,
    quoteToken: ZERO_ADDRESS,
    curve: "legacy",
    curveAddress: null,
    curveParameter: null,
    curveV2: null,
    dexSupplyThreshold: null,
    extension: null,
    dexPreference: null,
    taxed: false,
    tax: null,
    asymmetricTax: false,
    asymmetricTaxProfile: null,
    staged: false,
  };
  const features = new Set();
  for (const log of portalLogs) {
    const parsed = parsePortalEvent(log);
    if (!parsed) continue;
    const eventToken = normalizedAddress(parsed.args?.token);
    if (eventToken && eventToken.toLowerCase() !== token.toLowerCase()) continue;
    for (const feature of featuresForParsedEvent(parsed)) features.add(feature);
    if (parsed.name === "TokenVersionSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) mode.tokenVersion = Number(parsed.args.version);
    if (parsed.name === "TokenMigratorSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) mode.migratorType = Number(parsed.args.migratorType);
    if (parsed.name === "TokenQuoteSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) mode.quoteToken = normalizedAddress(parsed.args.quoteToken) || ZERO_ADDRESS;
    if (parsed.name === "TokenCurveSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) {
      mode.curve = "legacy";
      mode.curveAddress = normalizedAddress(parsed.args.curve);
      mode.curveParameter = parsed.args.curveParameter.toString();
    }
    if (parsed.name === "TokenCurveSetV2" && lowerAddress(parsed.args.token) === token.toLowerCase()) {
      mode.curve = "v2";
      mode.curveV2 = {
        r: parsed.args.r.toString(),
        h: parsed.args.h.toString(),
        k: parsed.args.k.toString(),
      };
    }
    if (parsed.name === "TokenDexSupplyThreshSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) {
      mode.dexSupplyThreshold = parsed.args.dexSupplyThresh.toString();
    }
    if (parsed.name === "TokenExtensionEnabled" && lowerAddress(parsed.args.token) === token.toLowerCase()) {
      mode.extension = {
        id: String(parsed.args.extensionID).toLowerCase(),
        address: normalizedAddress(parsed.args.extensionAddress),
        version: Number(parsed.args.version),
      };
    }
    if (parsed.name === "TokenDexPreferenceSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) {
      mode.dexPreference = { dexId: Number(parsed.args.dexId), feeProfile: Number(parsed.args.lpFeeProfile) };
    }
    if (parsed.name === "FlapTokenTaxSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) {
      mode.taxed = true;
      mode.tax = parsed.args.tax.toString();
    }
    if (parsed.name === "FlapTokenAsymmetricTaxSet" && lowerAddress(parsed.args.token) === token.toLowerCase()) {
      mode.asymmetricTax = true;
      mode.asymmetricTaxProfile = {
        buyTax: parsed.args.buyTax.toString(),
        sellTax: parsed.args.sellTax.toString(),
      };
    }
    if (parsed.name === "FlapTokenStaged" && lowerAddress(parsed.args.token) === token.toLowerCase()) mode.staged = true;
  }
  features.add(`token-version:${mode.tokenVersion}`);
  features.add(`migrator:${mode.migratorType}`);
  features.add(`quote:${mode.quoteToken.toLowerCase()}`);
  features.add(`curve:${mode.curve}`);
  mode.fingerprint = digest(mode);
  return {
    token,
    creator: normalizedAddress(creation.args.creator),
    nonce: creation.args.nonce.toString(),
    name: String(creation.args.name || ""),
    symbol: String(creation.args.symbol || ""),
    meta: String(creation.args.meta || ""),
    mode,
    features: [...features].sort(),
    logIndex: numberFromHex(creationLog.logIndex || "0x0"),
  };
}

function implementationFromStorage(storage) {
  if (typeof storage !== "string" || !/^0x[0-9a-f]{64}$/i.test(storage)) return null;
  const suffix = storage.slice(-40);
  if (/^0+$/.test(suffix)) return null;
  return normalizedAddress(`0x${suffix}`);
}

function implementationFromUpgradeLog(log) {
  if (String(log?.topics?.[0] || "").toLowerCase() !== MORPH_EIP1967_UPGRADED_TOPIC) return null;
  if (!Array.isArray(log.topics) || log.topics.length !== 2 || !/^0x[0-9a-f]{64}$/i.test(log.topics[1])) return null;
  return implementationFromStorage(log.topics[1]);
}

function featureLabel(feature) {
  if (feature.startsWith("quote:")) return `新增报价/底池资产 ${feature.slice(6)}`;
  if (feature.startsWith("extension:")) return `首次启用 Extension ${feature.split(":")[1]}`;
  if (feature.startsWith("dex-preference:")) return `新增 DEX/费率档 ${feature.slice("dex-preference:".length)}`;
  if (feature.startsWith("curve-v2-profile:")) return `新增 V2 曲线参数档 ${feature.slice("curve-v2-profile:".length)}`;
  if (feature.startsWith("curve-legacy-profile:")) return `新增曲线参数档 ${feature.slice("curve-legacy-profile:".length)}`;
  if (feature.startsWith("curve-address:")) return `新增曲线合约 ${feature.slice("curve-address:".length)}`;
  if (feature === "tax:asymmetric") return "首次出现非对称买卖税模式";
  if (feature === "launch:two-step-staged") return "首次出现两阶段发射模式";
  if (feature === "token:taxed") return "首次出现税费代币模式";
  if (feature.startsWith("token-version:")) return `新增 TokenVersion ${feature.split(":")[1]}`;
  if (feature.startsWith("migrator:")) return `新增 Migrator 类型 ${feature.split(":")[1]}`;
  if (feature.startsWith("entry-selector:")) return `新增创建入口 ${feature.split(":").slice(1).join(":")}`;
  return feature;
}

function acceptedDelivery(result) {
  // A suppressed result is a completed policy decision (freshness/blocklist),
  // not a transport failure. Refusing to advance here would pin the durable
  // chain cursor on the same event forever. Telegram/webhook failures are
  // represented as a queued outbox item and remain durably retryable.
  return ["delivered", "queued", "suppressed"].includes(result?.status);
}

function currentPlatform(idValue) {
  if (idValue === "long") return {
    id: "long",
    name: "Long",
    website: LONG_APP,
    twitter: "https://x.com/longdotxyz",
    trust: "official_verified",
    evidenceUrl: LONG_APP,
  };
  return {
    id: "flap",
    name: "Flap",
    website: FLAP_BOARD,
    twitter: "https://x.com/flapdotsh",
    trust: "official_verified",
    evidenceUrl: FLAP_EVIDENCE,
  };
}

function baseEvent(platformId, kind, observedAt) {
  return {
    type: "evm_launchpad_update",
    kind,
    chainId: MORPH_CHAIN_ID,
    chain: { id: MORPH_CHAIN_ID, slug: "morph", name: "Morph" },
    platform: currentPlatform(platformId),
    strong: true,
    structural: { eligible: true, exactOfficialRoot: platformId === "flap" },
    observedAt,
  };
}

function normalizeOfficialActivation(record) {
  if (!record || typeof record !== "object") return null;
  const chainId = Number(record.chainId || record.chain?.id || record.chain?.chainId || 0);
  const sourceUrl = String(record.sourceUrl || record.url || "");
  const explicitlyMorph = chainId === MORPH_CHAIN_ID
    || String(record.chain?.slug || record.chain || "").toLowerCase() === "morph"
    || /\/morph(?:\/|$)/i.test(sourceUrl);
  if (!explicitlyMorph) return null;
  const identity = String(record.identity || record.key || record.featureActivationKey || "").trim();
  if (!identity) return null;
  const activationShape = {
    identity: identity.toLowerCase(),
    category: record.category || null,
    vaultFactory: lowerAddress(record.vaultFactory),
    quoteAddress: lowerAddress(record.quoteAddress),
    quoteSymbol: record.quoteSymbol || null,
    changeType: record.changeType || null,
    chainId: MORPH_CHAIN_ID,
  };
  return {
    key: `official:${digest(activationShape)}`,
    identity,
    label: String(record.label || record.name || record.category || identity),
    sourceUrl,
    observedAt: record.observedAt || iso(),
    activatedAt: record.firstObservedAt || record.observedAt || iso(),
    activationShape,
    firstTokenAlertedAt: null,
  };
}

export function createMorphLaunchpadMonitor(config, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const sendAlertsImpl = dependencies.sendAlertsImpl || sendAlerts;
  const assessSecurityImpl = dependencies.assessSecurityImpl || assessLocalTokenSecurity;
  const stateFile = path.join(config.dataDir, "morph-launchpad-state.json");
  const rpcUrls = (config.morphRpcUrls?.length ? config.morphRpcUrls : [config.morphRpcUrl, ...DEFAULT_RPC_URLS])
    .filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
  const rpcReadConcurrency = Math.max(4, Math.min(8, Number(config.morphRpcReadConcurrency || 6)));
  const ownedProviders = dependencies.provider ? [] : rpcUrls.map((url) => createAbortableJsonRpcProvider(
    url,
    MORPH_CHAIN_ID,
    {
      requestTimeoutMs: Math.max(1_000, Number(config.morphRpcRequestTimeoutMs || 5_000)),
      batchMaxCount: 10,
      fetchImpl: dependencies.rpcFetchImpl || fetch,
    },
  ));
  const providers = dependencies.provider ? [dependencies.provider] : ownedProviders;
  if (!providers.length) throw new Error("Morph monitoring requires at least one RPC provider");
  let activeProvider = 0;
  let state = emptyState();
  let initialized = false;
  let started = false;
  let stopped = false;
  let timer = null;
  let officialTimer = null;
  let reconnectTimer = null;
  let socket = null;
  let scanPromise = null;
  let officialPromise = null;
  let savePromise = Promise.resolve();
  let lastHealthPersistAt = 0;

  const save = () => {
    savePromise = savePromise.catch(() => {}).then(() => atomicWriteJson(fsImpl, stateFile, state));
    return savePromise;
  };

  async function rpc(method, params = []) {
    const errors = [];
    for (let offset = 0; offset < providers.length; offset += 1) {
      const index = (activeProvider + offset) % providers.length;
      try {
        const result = await providers[index].send(method, params);
        activeProvider = index;
        return result;
      } catch (error) {
        errors.push(`${rpcUrls[index] || `provider-${index}`}: ${compactError(error)}`);
      }
    }
    throw new Error(`Morph RPC ${method} failed: ${errors.join(" | ")}`);
  }

  async function portalIdentity(blockNumber = "latest") {
    const blockTag = blockNumber === "latest" ? "latest" : toQuantity(blockNumber);
    const [portalCode, storage] = await Promise.all([
      rpc("eth_getCode", [MORPH_FLAP_PORTAL, blockTag]),
      rpc("eth_getStorageAt", [MORPH_FLAP_PORTAL, EIP1967_IMPLEMENTATION_SLOT, blockTag]),
    ]);
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(portalCode) || portalCode === "0x") throw new Error("official Flap Morph Portal has no bytecode");
    const implementation = implementationFromStorage(storage);
    if (!implementation) throw new Error("official Flap Morph Portal implementation is unresolved");
    const implementationCode = await rpc("eth_getCode", [implementation, blockTag]);
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(implementationCode) || implementationCode === "0x") throw new Error("Flap Morph implementation has no bytecode");
    let protocolVersion = null;
    try {
      const raw = await rpc("eth_call", [{ to: MORPH_FLAP_PORTAL, data: portalInterface.encodeFunctionData("version") }, blockTag]);
      [protocolVersion] = portalInterface.decodeFunctionResult("version", raw);
    } catch { /* An implementation change itself remains actionable. */ }
    return {
      implementation,
      implementationCodeHash: keccak256(implementationCode),
      protocolVersion: protocolVersion ? String(protocolVersion) : null,
    };
  }

  async function explorerIndexedHead() {
    const api = String(config.morphExplorerApiUrl || "https://explorer-api.morph.network").replace(/\/$/, "");
    const [indexingResponse, statsResponse] = await Promise.all([
      fetchImpl(`${api}/api/v2/main-page/indexing-status`, { signal: AbortSignal.timeout(10_000) }),
      fetchImpl(`${api}/api/v2/stats`, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!indexingResponse.ok || !statsResponse.ok) throw new Error(`Morph explorer baseline HTTP ${indexingResponse.status}/${statsResponse.status}`);
    const [indexing, stats] = await Promise.all([indexingResponse.json(), statsResponse.json()]);
    if (indexing.finished_indexing_blocks !== true) throw new Error("Morph explorer block indexing is incomplete");
    const indexedHead = Number(stats.total_blocks);
    if (!Number.isSafeInteger(indexedHead) || indexedHead < MORPH_FLAP_DEPLOY_BLOCK) throw new Error("Morph explorer indexed head is invalid");
    return indexedHead;
  }

  async function explorerEventLogs(eventName, toBlock) {
    const api = String(config.morphExplorerApiUrl || "https://explorer-api.morph.network").replace(/\/$/, "");
    const topic = portalInterface.getEvent(eventName).topicHash.toLowerCase();
    const collected = [];
    const pageSize = 1_000;
    const ranges = [[MORPH_FLAP_DEPLOY_BLOCK, Number(toBlock)]];
    let requests = 0;
    while (ranges.length) {
      const [fromBlock, rangeEnd] = ranges.shift();
      if (fromBlock > rangeEnd) continue;
      requests += 1;
      if (requests > 10_000) throw new Error(`Morph explorer ${eventName} baseline exceeded range limit`);
      const query = new URLSearchParams({
        module: "logs",
        action: "getLogs",
        fromBlock: String(fromBlock),
        toBlock: String(rangeEnd),
        address: MORPH_FLAP_PORTAL,
        topic0: topic,
        page: "1",
        offset: String(pageSize),
      });
      const response = await fetchImpl(`${api}/api?${query}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Morph explorer ${eventName} HTTP ${response.status}`);
      const payload = await response.json();
      const noLogs = payload?.message === "No logs found" && Array.isArray(payload?.result) && payload.result.length === 0;
      if (!noLogs && (payload?.message !== "OK" || !Array.isArray(payload?.result))) throw new Error(`Morph explorer ${eventName} returned an ambiguous baseline`);
      const logs = payload.result || [];
      for (const log of logs) {
        const blockNumber = numberFromHex(log.blockNumber);
        if (lowerAddress(log.address) !== MORPH_FLAP_PORTAL.toLowerCase()
          || String(log.topics?.[0] || "").toLowerCase() !== topic
          || !/^0x[0-9a-f]*$/i.test(log.data || "")
          || !Number.isSafeInteger(blockNumber)
          || blockNumber < fromBlock
          || blockNumber > rangeEnd) throw new Error(`Morph explorer ${eventName} returned malformed log evidence`);
      }
      if (logs.length >= pageSize) {
        if (fromBlock === rangeEnd) throw new Error(`Morph explorer ${eventName} has at least ${pageSize} logs in block ${fromBlock}`);
        const midpoint = Math.floor((fromBlock + rangeEnd) / 2);
        ranges.unshift([fromBlock, midpoint], [midpoint + 1, rangeEnd]);
        continue;
      }
      collected.push(...logs);
    }
    return [...new Map(collected.map((log) => [`${String(log.transactionHash || "").toLowerCase()}:${String(log.logIndex || "")}`, log])).values()]
      .sort((left, right) => numberFromHex(left.blockNumber) - numberFromHex(right.blockNumber)
        || numberFromHex(left.logIndex || "0x0") - numberFromHex(right.logIndex || "0x0"));
  }

  function absorbCreation(creation, blockNumber = 0) {
    const known = new Set(state.knownFeatures);
    for (const feature of creation.features) {
      if (!known.has(feature)) state.featureOrigins[feature] = Number(blockNumber) || 0;
      known.add(feature);
    }
    state.knownFeatures = [...known].sort();
  }

  async function absorbRpcRange(fromBlock, toBlock) {
    const batchSize = Math.max(1, Math.min(5_000, Number(config.morphLogBatchSize || 2_000)));
    for (let from = fromBlock; from <= toBlock; from += batchSize) {
      const upper = Math.min(toBlock, from + batchSize - 1);
      const logs = await rpc("eth_getLogs", [{
        fromBlock: toQuantity(from),
        toBlock: toQuantity(upper),
        address: MORPH_FLAP_PORTAL,
        topics: [MORPH_FLAP_TOKEN_CREATED_TOPIC],
      }]);
      const evidence = await mapWithConcurrency(logs, rpcReadConcurrency, async (log) => {
        const [receipt, transaction] = await Promise.all([
          rpc("eth_getTransactionReceipt", [log.transactionHash]),
          rpc("eth_getTransactionByHash", [log.transactionHash]),
        ]);
        return { log, receipt, transaction };
      });
      for (const { log, receipt, transaction } of evidence) {
        const creation = parseMorphFlapCreation(
          receipt,
          transaction,
          state.portal.implementation,
          numberFromHex(log.logIndex || "0x0"),
        );
        if (creation) absorbCreation(creation, 0);
      }
    }
  }

  async function establishBaseline(safeBlock) {
    const identity = await portalIdentity(safeBlock);
    const indexedHead = Math.min(safeBlock, await explorerIndexedHead());
    const historical = await Promise.all(HISTORICAL_FEATURE_EVENTS.map((eventName) => explorerEventLogs(eventName, indexedHead)));
    state.portal = { ...state.portal, ...identity, pendingUpgrade: null };
    const known = new Set(state.knownFeatures);
    for (const logs of historical) {
      for (const log of logs) {
        for (const feature of featuresForParsedEvent(parsePortalEvent(log))) known.add(feature);
      }
    }
    state.knownFeatures = [...known].sort();
    for (const feature of state.knownFeatures) state.featureOrigins[feature] ??= 0;
    const recentBaselineStart = Math.max(
      MORPH_FLAP_DEPLOY_BLOCK,
      safeBlock - Math.max(1, Number(config.morphBaselineRecentBlocks || 100_000)) + 1,
    );
    // Explorer feature logs establish the full semantic history. A bounded RPC
    // receipt sample additionally learns selectors and compound receipt shapes
    // that cannot be recovered from standalone event rows.
    await absorbRpcRange(Math.min(recentBaselineStart, Math.max(MORPH_FLAP_DEPLOY_BLOCK, indexedHead + 1)), safeBlock);
    const block = await rpc("eth_getBlockByNumber", [toQuantity(safeBlock), false]);
    if (!block?.hash) throw new Error("Morph baseline block is unavailable");
    state.baselineComplete = true;
    state.cursor = safeBlock + 1;
    state.lastScannedBlock = safeBlock;
    state.lastScannedBlockHash = block.hash;
    state.health = {
      ...state.health,
      status: "healthy",
      lastSuccessAt: iso(now()),
      safeBlock,
      lagBlocks: 0,
      baselineIndexedHead: indexedHead,
    };
    await save();
    logger.info(`[morph] quiet baseline complete block=${safeBlock} explorer=${indexedHead} features=${state.knownFeatures.length}`);
  }

  async function initialize() {
    if (initialized) return;
    await fsImpl.mkdir(config.dataDir, { recursive: true });
    try {
      state = normalizeState(JSON.parse(await fsImpl.readFile(stateFile, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = emptyState();
    }
    initialized = true;
  }

  async function deliver(event) {
    const result = await sendAlertsImpl(config, event);
    if (!acceptedDelivery(result)) throw new Error(`Morph alert was not durably accepted (${result?.status || "unknown"}${result?.reason ? `/${result.reason}` : ""})`);
    return result;
  }

  async function checkPortalUpgrade(safeBlock, evidence = {}) {
    const identity = await portalIdentity(safeBlock);
    if (evidence.expectedImplementation
      && identity.implementation.toLowerCase() !== evidence.expectedImplementation.toLowerCase()) {
      throw new Error(`Morph Upgraded log implementation mismatch at block ${safeBlock}`);
    }
    const prior = state.portal;
    const priorSnapshot = structuredClone(prior);
    const changed = prior.implementation?.toLowerCase() !== identity.implementation.toLowerCase()
      || prior.implementationCodeHash !== identity.implementationCodeHash
      || (prior.protocolVersion && identity.protocolVersion && prior.protocolVersion !== identity.protocolVersion);
    if (!changed) {
      if ((!prior.protocolVersion && identity.protocolVersion)
        || !prior.implementationCodeHash) state.portal = { ...state.portal, ...identity };
      return;
    }
    let observedAt = evidence.observedAt || null;
    if (!observedAt) {
      const block = await rpc("eth_getBlockByNumber", [toQuantity(safeBlock), false]);
      if (!block?.hash || block.timestamp == null) throw new Error(`Morph upgrade block ${safeBlock} is unavailable`);
      observedAt = iso(Number(BigInt(block.timestamp)) * 1_000);
    }
    const activationKey = `upgrade:${safeBlock}:${identity.implementation.toLowerCase()}:${identity.implementationCodeHash}:${identity.protocolVersion || "unknown"}`;
    const event = {
      ...baseEvent("flap", "portal_upgrade", observedAt),
      eventKey: `evm-launchpad:${MORPH_CHAIN_ID}:flap:${MORPH_FLAP_PORTAL.toLowerCase()}:upgrade-announcement:${activationKey}`,
      featureActivationKey: activationKey,
      launcher: MORPH_FLAP_PORTAL,
      mode: {
        selector: "proxy-upgrade",
        componentMode: "Morph Portal implementation",
        previousImplementation: prior.implementation,
        implementation: identity.implementation,
        previousVersion: prior.protocolVersion,
        version: identity.protocolVersion,
      },
      blockNumber: safeBlock,
      blockTimestamp: observedAt,
      explorerUrl: `${EXPLORER}/address/${MORPH_FLAP_PORTAL}`,
      launcherUrl: `${EXPLORER}/address/${MORPH_FLAP_PORTAL}`,
      sourceUrl: FLAP_EVIDENCE,
      reorgOrphanedEventKeys: state.reorgOrphanedEventKeys,
    };
    if (!state.alertedKeys.includes(event.eventKey)) await deliver(event);
    state.alertedKeys = [...new Set([...state.alertedKeys, event.eventKey])].slice(-500);
    state.alertOrigins[event.eventKey] = safeBlock;
    state.portal = {
      ...state.portal,
      ...identity,
      pendingUpgrade: {
        activationKey,
        implementation: identity.implementation,
        detectedAt: observedAt,
        detectedBlock: safeBlock,
        firstTokenAlertedAt: null,
      },
    };
    state.upgradeHistory = [...state.upgradeHistory, {
      blockNumber: safeBlock,
      eventKey: event.eventKey,
      before: priorSnapshot,
      after: structuredClone(state.portal),
    }].slice(-100);
    await save();
  }

  async function processUpgradeLog(log) {
    if (log.removed === true) return;
    if (lowerAddress(log.address) !== MORPH_FLAP_PORTAL.toLowerCase()) return;
    const implementation = implementationFromUpgradeLog(log);
    if (!implementation) throw new Error("Morph Portal returned a malformed Upgraded log");
    const txHash = String(log.transactionHash || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error("Morph Upgraded log has no valid transaction hash");
    const [receipt, block] = await Promise.all([
      rpc("eth_getTransactionReceipt", [txHash]),
      rpc("eth_getBlockByNumber", [log.blockNumber, false]),
    ]);
    if (!receipt || Number(BigInt(receipt.status ?? "0x0")) !== 1
      || receipt.blockHash !== log.blockHash || !block?.hash || block.hash !== log.blockHash) {
      throw new Error(`Morph canonical upgrade receipt mismatch ${txHash}`);
    }
    const canonical = (receipt.logs || []).some((item) => lowerAddress(item.address) === MORPH_FLAP_PORTAL.toLowerCase()
      && String(item.topics?.[0] || "").toLowerCase() === MORPH_EIP1967_UPGRADED_TOPIC
      && String(item.topics?.[1] || "").toLowerCase() === String(log.topics?.[1] || "").toLowerCase()
      && Number(BigInt(item.logIndex || "0x0")) === Number(BigInt(log.logIndex || "0x0")));
    if (!canonical) throw new Error(`Morph Upgraded log is not canonical ${txHash}`);
    await checkPortalUpgrade(numberFromHex(log.blockNumber), {
      expectedImplementation: implementation,
      observedAt: iso(Number(BigInt(block.timestamp)) * 1_000),
    });
  }

  function pendingActivationFor(creation, creationObservedAt) {
    const pendingUpgrade = state.portal.pendingUpgrade;
    if (pendingUpgrade && !pendingUpgrade.firstTokenAlertedAt) {
      return {
        key: pendingUpgrade.activationKey,
        label: `Portal ${state.portal.protocolVersion || "新实现"} 的首个代币`,
        sourceUrl: FLAP_EVIDENCE,
        kind: "upgrade_first_token",
      };
    }
    const creationTime = Date.parse(creationObservedAt || "");
    const officials = Object.values(state.officialActivations)
      .filter((activation) => !activation.firstTokenAlertedAt)
      .filter((activation) => {
        const activatedAt = Date.parse(activation.activatedAt || activation.observedAt || "");
        return !Number.isFinite(creationTime) || !Number.isFinite(activatedAt) || creationTime >= activatedAt;
      })
      .sort((left, right) => String(left.key).localeCompare(String(right.key)));
    if (officials.length) {
      const activationKeys = officials.map((activation) => activation.key);
      return {
        key: `official-batch:${digest(activationKeys)}`,
        activationKeys,
        label: [...new Set(officials.map((activation) => activation.label))].join("；"),
        sourceUrl: officials[0].sourceUrl,
        kind: "official_feature_first_token",
      };
    }
    const known = new Set(state.knownFeatures);
    const novel = creation.features.filter((feature) => !known.has(feature));
    if (!novel.length) return null;
    const key = `semantic:${digest(novel)}`;
    return {
      key,
      label: novel.map(featureLabel).join("；"),
      sourceUrl: FLAP_BOARD,
      kind: "semantic_first_token",
      features: novel,
      pendingRecord: {
        key,
        features: novel,
        firstSeenAt: iso(now()),
        firstToken: creation.token,
        firstTokenAlertedAt: null,
      },
    };
  }

  function creationLogKey(log) {
    return `${String(log?.transactionHash || "").toLowerCase()}:${numberFromHex(log?.logIndex || "0x0")}`;
  }

  function creationLogNeedsEvidence(log) {
    if (log.removed === true) return;
    if (lowerAddress(log.address) !== MORPH_FLAP_PORTAL.toLowerCase()
      || String(log.topics?.[0] || "").toLowerCase() !== MORPH_FLAP_TOKEN_CREATED_TOPIC) return false;
    const txHash = String(log.transactionHash || "").toLowerCase();
    const seenKey = creationLogKey(log);
    return /^0x[0-9a-f]{64}$/.test(txHash) && !state.seenTransactions[seenKey];
  }

  async function loadCreationEvidence(log) {
    const txHash = String(log.transactionHash || "").toLowerCase();
    const [receipt, transaction, block] = await Promise.all([
      rpc("eth_getTransactionReceipt", [txHash]),
      rpc("eth_getTransactionByHash", [txHash]),
      rpc("eth_getBlockByNumber", [log.blockNumber, false]),
    ]);
    if (!receipt || receipt.blockHash !== log.blockHash || !block?.hash || block.hash !== log.blockHash) throw new Error(`Morph canonical receipt mismatch ${txHash}`);
    const canonical = (receipt.logs || []).some((item) => lowerAddress(item.address) === MORPH_FLAP_PORTAL.toLowerCase()
      && String(item.topics?.[0] || "").toLowerCase() === MORPH_FLAP_TOKEN_CREATED_TOPIC
      && Number(BigInt(item.logIndex || "0x0")) === Number(BigInt(log.logIndex || "0x0")));
    if (!canonical) throw new Error(`Morph TokenCreated log is not canonical ${txHash}`);
    return { receipt, transaction, block };
  }

  async function processCreationLog(log, prefetched = null) {
    if (!creationLogNeedsEvidence(log)) return;
    const txHash = String(log.transactionHash || "").toLowerCase();
    const seenKey = creationLogKey(log);
    const { receipt, transaction, block } = prefetched || await loadCreationEvidence(log);
    const creation = parseMorphFlapCreation(
      receipt,
      transaction,
      state.portal.implementation,
      numberFromHex(log.logIndex || "0x0"),
    );
    if (!creation) throw new Error(`Morph TokenCreated receipt cannot be decoded ${txHash}`);
    const observedAt = iso(Number(BigInt(block.timestamp)) * 1_000);
    const activation = pendingActivationFor(creation, observedAt);
    if (activation) {
      const securityProvider = providers[activeProvider];
      const security = await assessSecurityImpl(securityProvider, creation.token, []);
      if (!security || security.decision === "unknown") throw new Error(`Morph first-token safety is unavailable ${creation.token}`);
      const eventKey = `evm-launchpad:${MORPH_CHAIN_ID}:flap:${MORPH_FLAP_PORTAL.toLowerCase()}:first-token:${activation.key}:${txHash}:${numberFromHex(log.logIndex || "0x0")}`;
      const event = {
        ...baseEvent("flap", "new_mode", observedAt),
        eventKey,
        featureActivationKey: activation.key,
        featureFirstToken: true,
        launcher: MORPH_FLAP_PORTAL,
        transactionHash: txHash,
        blockNumber: numberFromHex(log.blockNumber),
        blockTimestamp: observedAt,
        tokens: [{
          token: creation.token,
          metadata: { name: creation.name, symbol: creation.symbol, meta: creation.meta },
        }],
        mode: {
          ...creation.mode,
          selector: creation.mode.entrySelector,
          componentMode: activation.label,
          activationKind: activation.kind,
          novelty: { meaningful: true, features: activation.features || [] },
        },
        security,
        explorerUrl: `${EXPLORER}/tx/${txHash}`,
        launcherUrl: `${EXPLORER}/address/${MORPH_FLAP_PORTAL}`,
        marketUrl: `https://dexscreener.com/morph/${creation.token}`,
        sourceUrl: activation.sourceUrl || FLAP_EVIDENCE,
        reorgOrphanedEventKeys: state.reorgOrphanedEventKeys,
      };
      if (!state.alertedKeys.includes(eventKey)) await deliver(event);
      state.alertedKeys = [...new Set([...state.alertedKeys, eventKey])].slice(-500);
      state.alertOrigins[eventKey] = numberFromHex(log.blockNumber);
      if (state.portal.pendingUpgrade?.activationKey === activation.key) state.portal.pendingUpgrade.firstTokenAlertedAt = iso(now());
      for (const activationKey of activation.activationKeys || [activation.key]) {
        if (state.officialActivations[activationKey]) {
          state.officialActivations[activationKey].firstTokenAlertedAt = iso(now());
          state.officialActivations[activationKey].firstTokenBlock = numberFromHex(log.blockNumber);
        }
      }
      if (activation.pendingRecord) {
        state.pendingFeatures[activation.key] = {
          ...activation.pendingRecord,
          firstSeenBlock: numberFromHex(log.blockNumber),
          firstTokenAlertedAt: iso(now()),
        };
        absorbCreation(creation, numberFromHex(log.blockNumber));
      } else if (state.pendingFeatures[activation.key]) {
        state.pendingFeatures[activation.key].firstTokenAlertedAt = iso(now());
      }
      // Upgrade/official first-token samples can simultaneously expose new
      // receipt features. Commit those features with the same milestone so the
      // next ordinary token cannot be mislabeled as another first token.
      if (!activation.pendingRecord) absorbCreation(creation, numberFromHex(log.blockNumber));
    } else {
      absorbCreation(creation, numberFromHex(log.blockNumber));
    }
    state.seenTransactions[seenKey] = {
      transactionHash: txHash,
      logIndex: numberFromHex(log.logIndex || "0x0"),
      blockNumber: numberFromHex(log.blockNumber),
      token: creation.token,
    };
  }

  async function reorgCheck() {
    if (!state.lastScannedBlock || !state.lastScannedBlockHash) return;
    const block = await rpc("eth_getBlockByNumber", [toQuantity(state.lastScannedBlock), false]);
    if (block?.hash === state.lastScannedBlockHash) return;
    const rewind = Math.max(MORPH_FLAP_DEPLOY_BLOCK, state.lastScannedBlock - Math.max(2, Number(config.morphReorgLookbackBlocks || 8)));
    const invalidUpgrades = state.upgradeHistory
      .filter((entry) => Number(entry?.blockNumber || 0) >= rewind)
      .sort((left, right) => Number(left.blockNumber) - Number(right.blockNumber));
    if (invalidUpgrades.length) state.portal = structuredClone(invalidUpgrades[0].before);
    else if (Number(state.portal.pendingUpgrade?.detectedBlock || 0) >= rewind) state.portal.pendingUpgrade = null;
    state.upgradeHistory = state.upgradeHistory.filter((entry) => Number(entry?.blockNumber || 0) < rewind);

    const invalidFeatures = new Set(Object.entries(state.featureOrigins)
      .filter(([, blockNumber]) => Number(blockNumber || 0) >= rewind)
      .map(([feature]) => feature));
    state.knownFeatures = state.knownFeatures.filter((feature) => !invalidFeatures.has(feature));
    state.featureOrigins = Object.fromEntries(Object.entries(state.featureOrigins)
      .filter(([, blockNumber]) => Number(blockNumber || 0) < rewind));
    state.pendingFeatures = Object.fromEntries(Object.entries(state.pendingFeatures)
      .filter(([, feature]) => Number(feature?.firstSeenBlock || 0) < rewind));
    for (const activation of Object.values(state.officialActivations)) {
      if (Number(activation.firstTokenBlock || 0) >= rewind) {
        activation.firstTokenAlertedAt = null;
        activation.firstTokenBlock = null;
      }
    }

    const invalidAlertKeys = Object.entries(state.alertOrigins)
      .filter(([, blockNumber]) => Number(blockNumber || 0) >= rewind)
      .map(([eventKey]) => eventKey);
    state.reorgOrphanedEventKeys = [...new Set([...state.reorgOrphanedEventKeys, ...invalidAlertKeys])].slice(-100);
    const invalidAlertSet = new Set(invalidAlertKeys);
    state.alertedKeys = state.alertedKeys.filter((eventKey) => !invalidAlertSet.has(eventKey));
    state.alertOrigins = Object.fromEntries(Object.entries(state.alertOrigins)
      .filter(([, blockNumber]) => Number(blockNumber || 0) < rewind));
    state.cursor = rewind;
    state.lastScannedBlock = rewind - 1;
    state.lastScannedBlockHash = null;
    state.seenTransactions = Object.fromEntries(Object.entries(state.seenTransactions)
      .filter(([, entry]) => Number(entry?.blockNumber || 0) < rewind));
    logger.error(`[morph] reorg detected; rewound to ${rewind}`);
    await save();
  }

  async function scanInternal() {
    await initialize();
    state.health.lastAttemptAt = iso(now());
    const chainId = numberFromHex(await rpc("eth_chainId"));
    if (chainId !== MORPH_CHAIN_ID) throw new Error(`Morph RPC chain ID ${chainId} != ${MORPH_CHAIN_ID}`);
    const head = numberFromHex(await rpc("eth_blockNumber"));
    const safeBlock = Math.max(0, head - Math.max(0, Number(config.morphConfirmations ?? 1)));
    state.health.headBlock = head;
    state.health.safeBlock = safeBlock;
    if (!state.baselineComplete) {
      await establishBaseline(safeBlock);
      return;
    }
    await reorgCheck();
    if (Number(state.cursor || 0) > safeBlock && Number(state.lastScannedBlock || 0) >= safeBlock) {
      state.health = {
        ...state.health,
        status: "healthy",
        lastSuccessAt: iso(now()),
        lastError: null,
        lagBlocks: 0,
      };
      if (now() - lastHealthPersistAt >= 10_000) {
        lastHealthPersistAt = now();
        await save();
      }
      return;
    }
    const batchSize = Math.max(1, Math.min(5_000, Number(config.morphLogBatchSize || 2_000)));
    const catchup = Math.max(batchSize, Number(config.morphMaxCatchupBlocks || 5_000));
    const lastAllowed = Math.min(safeBlock, Number(state.cursor || safeBlock + 1) + catchup - 1);
    for (let from = Number(state.cursor || safeBlock + 1); from <= lastAllowed; from += batchSize) {
      const upper = Math.min(lastAllowed, from + batchSize - 1);
      const logs = await rpc("eth_getLogs", [{
        fromBlock: toQuantity(from),
        toBlock: toQuantity(upper),
        address: MORPH_FLAP_PORTAL,
        topics: [[MORPH_FLAP_TOKEN_CREATED_TOPIC, MORPH_EIP1967_UPGRADED_TOPIC]],
      }]);
      logs.sort((left, right) => numberFromHex(left.blockNumber) - numberFromHex(right.blockNumber)
        || numberFromHex(left.logIndex) - numberFromHex(right.logIndex));
      const creationEvidence = new Map((await mapWithConcurrency(
        logs.filter((log) => creationLogNeedsEvidence(log)),
        rpcReadConcurrency,
        async (log) => [creationLogKey(log), await loadCreationEvidence(log)],
      )));
      for (const log of logs) {
        const topic = String(log.topics?.[0] || "").toLowerCase();
        if (topic === MORPH_EIP1967_UPGRADED_TOPIC) await processUpgradeLog(log);
        else if (topic === MORPH_FLAP_TOKEN_CREATED_TOPIC) {
          await processCreationLog(log, creationEvidence.get(creationLogKey(log)));
        }
      }
      // A compliant EIP-1967 proxy emits Upgraded. This final identity check
      // also catches a non-standard implementation change, but runs only
      // after older creation logs have been consumed so backlog cannot be
      // mislabeled as the new implementation's first token.
      await checkPortalUpgrade(upper);
      const block = await rpc("eth_getBlockByNumber", [toQuantity(upper), false]);
      if (!block?.hash) throw new Error(`Morph block ${upper} unavailable`);
      state.cursor = upper + 1;
      state.lastScannedBlock = upper;
      state.lastScannedBlockHash = block.hash;
      await save();
    }
    const seenEntries = Object.entries(state.seenTransactions).sort(([, left], [, right]) => Number(right.blockNumber) - Number(left.blockNumber)).slice(0, 5_000);
    state.seenTransactions = Object.fromEntries(seenEntries);
    state.health = {
      ...state.health,
      status: Number(state.cursor || 0) <= safeBlock ? "catching_up" : "healthy",
      lastSuccessAt: iso(now()),
      lastError: null,
      lagBlocks: Math.max(0, safeBlock - Number(state.cursor || safeBlock + 1) + 1),
    };
    await save();
  }

  async function scan() {
    if (scanPromise) return scanPromise;
    scanPromise = scanInternal().catch(async (error) => {
      state.health = {
        ...state.health,
        status: state.baselineComplete ? "degraded" : "baseline_blocked",
        lastErrorAt: iso(now()),
        lastError: compactError(error),
      };
      await save().catch(() => {});
      logger.error(`[morph] ${compactError(error)}`);
      throw error;
    }).finally(() => { scanPromise = null; });
    return scanPromise;
  }

  function longDeploymentEvidence(text) {
    const normalized = String(text || "").replace(/\s+/g, " ");
    const actionPattern = /\bmorph\b[^.!?]{0,180}\b(?:live|launch(?:ed)?|deploy(?:ed|ment)?|support(?:ed)?|available|integrat(?:ed|ion))\b|\b(?:live|launch(?:ed)?|deploy(?:ed|ment)?|support(?:ed)?|available|integrat(?:ed|ion))\b[^.!?]{0,180}\bmorph\b/i;
    const action = normalized.match(actionPattern);
    if (!action) return null;
    const contextStart = Math.max(0, Number(action.index || 0) - 120);
    const contextEnd = Math.min(normalized.length, Number(action.index || 0) + action[0].length + 120);
    const context = normalized.slice(contextStart, contextEnd);
    if (/\b(?:not\s+(?:yet\s+)?(?:live|available|supported|deployed)|(?:does|do|is|are)\s+not\s+(?:support|supporting|live|available|deployed)|doesn['’]?t\s+support|no\s+(?:current\s+)?morph\s+support|unsupported|coming\s+soon|roadmap|proposal|proposed|explor(?:e|es|ing)|consider(?:s|ed|ing)?|plan(?:s|ned)?\s+to|will\s+(?:support|deploy|launch|integrate)|may\s+(?:support|deploy|launch|integrate))\b/i.test(context)) return null;
    if (/\btestnet\b/i.test(context) && !/\bmainnet\b/i.test(context)) return null;
    const addresses = [];
    for (const match of normalized.matchAll(/0x[a-fA-F0-9]{40}/g)) {
      const context = normalized.slice(Math.max(0, match.index - 140), match.index + match[0].length + 140);
      if (/\b(?:factory|portal|launcher|launchpad|manager|router|core|deployed\s+contract)\b/i.test(context)) addresses.push(normalizedAddress(match[0]));
    }
    return { addresses: [...new Set(addresses.filter(Boolean))].sort(), text: context.slice(0, 600) };
  }

  async function checkLongOfficialInternal() {
    await initialize();
    const sources = [
      { official: LONG_APP, reader: `https://r.jina.ai/${LONG_APP}` },
      { official: LONG_SITE, reader: `https://r.jina.ai/${LONG_SITE}` },
      {
        official: LONG_APP,
        // Current official application chain registry. The public app is
        // Cloudflare-protected, while Jina exposes this immutable official
        // asset without requiring a user session.
        reader: "https://r.jina.ai/https://app.long.xyz/_next/static/chunks/71d56a1e8c45df39.js",
      },
    ];
    const attempts = await Promise.allSettled(sources.map(async (source) => {
      const response = await fetchImpl(source.reader, { headers: { accept: "application/json", "x-no-cache": "true" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Long official reader HTTP ${response.status}`);
      const text = await response.text();
      if (/Site Not Found|Target URL returned error\s+404/i.test(text)) throw new Error("Long official source is not currently published");
      return { ...source, text };
    }));
    const contents = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
    if (!contents.length) {
      throw new Error(`Long official sources unavailable: ${attempts.map((attempt) => attempt.status === "rejected" ? compactError(attempt.reason) : "unknown").join(" | ")}`);
    }
    const combined = contents.map((item) => item.text).join("\n");
    const contentHash = digest(combined.replace(/\s+/g, " ").slice(0, 500_000));
    const evidence = longDeploymentEvidence(combined);
    // Hash only deployment semantics, not the first bytes of a rotating app
    // bundle. Unrelated catalogue/build changes must not repeat the alert.
    const evidenceHash = evidence ? digest({ morph: true, addresses: evidence.addresses }) : null;
    const checkedAt = iso(now());
    if (!state.long.initialized) {
      state.long = {
        ...state.long,
        initialized: true,
        contentHash,
        checkedAt,
        candidate: null,
        // Existing official content is a quiet baseline. Only a later semantic
        // change (for example, a newly published root) can alert.
        lastAlertHash: evidenceHash || state.long.lastAlertHash,
      };
      await save();
      return;
    }
    const priorCandidate = state.long.candidate;
    state.long.contentHash = contentHash;
    state.long.checkedAt = checkedAt;
    delete state.long.lastError;
    state.long.candidate = evidence ? {
      hash: evidenceHash,
      evidence,
      observations: priorCandidate?.hash === evidenceHash ? Number(priorCandidate.observations || 0) + 1 : 1,
      firstObservedAt: priorCandidate?.hash === evidenceHash ? priorCandidate.firstObservedAt : checkedAt,
    } : null;
    const candidate = state.long.candidate;
    if (candidate?.observations >= 2 && state.long.lastAlertHash !== candidate.hash) {
      const verifiedRoots = [];
      for (const address of candidate.evidence.addresses) {
        const code = await rpc("eth_getCode", [address, "latest"]);
        if (/^0x(?:[0-9a-f]{2})+$/i.test(code) && code !== "0x") verifiedRoots.push(address);
      }
      const observedAt = checkedAt;
      const event = {
        ...baseEvent("long", "official_deployment", observedAt),
        eventKey: `evm-launchpad:${MORPH_CHAIN_ID}:long:official:${candidate.hash}`,
        featureActivationKey: `long-morph:${candidate.hash}`,
        launcher: verifiedRoots[0] || null,
        officialRoots: verifiedRoots,
        mode: { selector: "official-morph-deployment", componentMode: "Long Morph support/deployment" },
        chainSupport: [{ id: "morph", name: "Morph", chainId: MORPH_CHAIN_ID, environment: "mainnet", stage: "deployed" }],
        blockTimestamp: observedAt,
        explorerUrl: verifiedRoots[0] ? `${EXPLORER}/address/${verifiedRoots[0]}` : LONG_APP,
        sourceUrl: LONG_APP,
      };
      await deliver(event);
      state.long.lastAlertHash = candidate.hash;
      for (const root of verifiedRoots) state.long.roots[root.toLowerCase()] = { address: root, confirmedAt: observedAt, sourceUrl: LONG_APP };
    }
    await save();
  }

  async function checkLongOfficial() {
    if (officialPromise) return officialPromise;
    officialPromise = checkLongOfficialInternal().catch(async (error) => {
      logger.error(`[morph][long] ${compactError(error)}`);
      state.long.checkedAt = iso(now());
      state.long.lastError = compactError(error);
      await save().catch(() => {});
      throw error;
    }).finally(() => { officialPromise = null; });
    return officialPromise;
  }

  async function registerFlapFeatureActivations(records = []) {
    await initialize();
    const normalized = records.map(normalizeOfficialActivation).filter(Boolean);
    let created = 0;
    for (const activation of normalized) {
      if (!state.officialActivations[activation.key]) {
        state.officialActivations[activation.key] = activation;
        created += 1;
      }
    }
    if (created) await save();
    return created;
  }

  function connectWebSocket() {
    const url = config.morphWsUrl;
    if (!url || stopped || dependencies.disableWebSocket) return;
    try {
      socket = new WebSocket(url);
      socket.on("open", () => {
        state.health.websocket = "connected";
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      });
      socket.on("message", (payload) => {
        try {
          const message = JSON.parse(String(payload));
          if (message.method === "eth_subscription") void scan().catch(() => {});
        } catch { /* Ignore malformed remote frames. */ }
      });
      socket.on("error", (error) => {
        state.health.websocket = `error:${compactError(error)}`;
      });
      socket.on("close", () => {
        state.health.websocket = "disconnected";
        socket = null;
        if (!stopped) {
          reconnectTimer = setTimeout(connectWebSocket, 3_000);
          reconnectTimer.unref?.();
        }
      });
    } catch (error) {
      state.health.websocket = `error:${compactError(error)}`;
    }
  }

  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    await initialize();
    void scan().catch(() => {});
    void checkLongOfficial().catch(() => {});
    timer = setInterval(() => void scan().catch(() => {}), Math.max(500, Number(config.morphPollIntervalMs || 1_000)));
    officialTimer = setInterval(() => void checkLongOfficial().catch(() => {}), Math.max(10_000, Number(config.morphOfficialPollIntervalMs || 30_000)));
    timer.unref?.();
    officialTimer.unref?.();
    connectWebSocket();
  }

  async function stop() {
    stopped = true;
    started = false;
    clearInterval(timer);
    clearInterval(officialTimer);
    clearTimeout(reconnectTimer);
    timer = null;
    officialTimer = null;
    reconnectTimer = null;
    socket?.close();
    socket = null;
    await Promise.allSettled([scanPromise, officialPromise, savePromise].filter(Boolean));
    for (const provider of ownedProviders) provider.destroy?.();
  }

  const monitor = {
    start,
    stop,
    scan,
    checkLongOfficial,
    registerFlapFeatureActivations,
    getState: async () => {
      await initialize();
      await savePromise;
      return structuredClone(state);
    },
    awaitIdle: async () => Promise.allSettled([scanPromise, officialPromise, savePromise].filter(Boolean)),
  };
  if (dependencies.autoStart !== false && config.morphMonitorEnabled !== false) void start().catch((error) => logger.error(`[morph-init] ${compactError(error)}`));
  return monitor;
}
