import fs from "node:fs/promises";
import path from "node:path";
import { getAddress, id } from "ethers";
import { sendAlerts } from "./alerts.js";
import { extractGithubRepositories } from "./github-monitor.js";

export const PONS_V2_DOCS_URL = "https://docs.ponsfamily.com/v2";
export const PONS_DEPLOYER = "0xda4bcee76b29efec9697fcf663601c2042043968";
export const PONS_V2_CURRENT_OWNER = "0x0815a4881f9c4073a70fdf00600eba54c5a5baaa";
export const PONS_V2_HOOK = "0x8e99d2009d60a917e9b1c00c04c077b8c0c3a044";
export const PONS_V2_MAIN_FACTORY = "0x7e1eabd52ae29598e6483f72dcf1a70b14284db8";
export const PONS_V2_MIGRATION_HOOK = "0x107251ffcc1fc808643dc8da345e901f59ec2044";
export const PONS_V2_MIGRATION_FACTORY = "0x050e5c224466e2d377a7e555e139d51268239b39";
export const PONS_V2_FEE_ESCROW = "0xbc39b6502e1a6ab36e4a5c5026a35f08342a0a9c";
export const PONS_V2_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const PONS_DEPLOYER_TRANSACTIONS_URL = `https://robinhoodchain.blockscout.com/api/v2/addresses/${PONS_DEPLOYER}/transactions?filter=from`;
export const PONS_EXPLORER_API_URL = "https://robinhoodchain.blockscout.com/api";
export const PONS_EXPLORER_INDEXING_STATUS_URL = "https://robinhoodchain.blockscout.com/api/v2/main-page/indexing-status";
export const PONS_EXPLORER_STATS_URL = "https://robinhoodchain.blockscout.com/api/v2/stats";

export const PONS_V2_TOKEN_LAUNCHED_SIGNATURE = "TokenLaunched(address,address,address,address,uint256,uint256)";
export const PONS_V2_TOKEN_LAUNCHED_TOPIC = id(PONS_V2_TOKEN_LAUNCHED_SIGNATURE);
export const PONS_V2_TOKEN_MIGRATED_SIGNATURE = "TokenMigrated(address,address,uint256,uint256,uint256)";
export const PONS_V2_TOKEN_MIGRATED_TOPIC = id(PONS_V2_TOKEN_MIGRATED_SIGNATURE);
export const PONS_V2_FACTORY_SET_TOPIC = id("FactorySet(address)");
export const PONS_V2_BUYBACK_VAULT_SET_TOPIC = id("BuybackVaultSet(address)");
export const PONS_V2_OWNERSHIP_TRANSFERRED_TOPIC = id("OwnershipTransferred(address,address)");
export const PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC = id("LaunchEnabledUpdated(bool)");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAIN_FACTORY_START_BLOCK = 23_550_000;
const MIGRATION_FACTORY_START_BLOCK = 23_650_000;
const DEFAULT_EVENT_CHUNK_SIZE = 2_000;
const BASELINE_INDEXER_TAIL_BLOCKS = 2_000;
const BASELINE_RPC_CHUNK_SIZE = 200;

const HISTORICAL_FACTORIES = new Set([
  "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb",
  "0x0c37a24f5d23a486fa692d1500881d698b1f77a4",
]);

const OFFICIAL_HOOKS = [
  { address: PONS_V2_HOOK, role: "main", source: "official_v2_hook" },
  { address: PONS_V2_MIGRATION_HOOK, role: "migration", source: "official_v2_migration_hook" },
];

const V2_INFRASTRUCTURE = new Set([
  PONS_V2_HOOK,
  PONS_V2_MIGRATION_HOOK,
  PONS_V2_FEE_ESCROW,
]);

const FACTORY_FUNCTIONS = [
  "launchConfigCount()",
  "getLaunchConfig(uint256)",
  "previewLaunchEconomics(uint256,address)",
  "getLaunchedToken(address)",
  "launchEnabled()",
  "approvedPairTokens(address)",
  "launchFee()",
  "maxCreatorTaxBps()",
];

const FACTORY_SELECTORS = FACTORY_FUNCTIONS.map((signature) => id(signature).slice(2, 10));
const selector = (signature) => id(signature).slice(0, 10);
const normalizeAddress = (value) => {
  try { return getAddress(value).toLowerCase(); }
  catch { return null; }
};

const normalizeSourceTimestamp = (value) => {
  if (value === null || value === undefined || value === "") return null;
  let timestamp;
  if (value instanceof Date) timestamp = value.getTime();
  else if (typeof value === "number" || typeof value === "bigint" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    timestamp = Math.abs(numeric) < 10_000_000_000 ? numeric * 1_000 : numeric;
  } else {
    timestamp = Date.parse(String(value));
  }
  if (!Number.isFinite(timestamp)) return null;
  try { return new Date(timestamp).toISOString(); }
  catch { return null; }
};

const decodeAddressWord = (value) => {
  const word = String(value || "");
  if (!/^0x[0-9a-fA-F]{64,}$/.test(word)) return null;
  return normalizeAddress(`0x${word.slice(-40)}`);
};

const decodeTopicAddress = (value) => decodeAddressWord(value);
const decodeBooleanWord = (value) => {
  const word = String(value || "");
  if (!/^0x[0-9a-fA-F]{64,}$/.test(word)) return null;
  return BigInt(word) !== 0n;
};

const callRequest = (to, data, blockTag) => ({
  to,
  data,
  ...(blockTag == null ? {} : { blockTag }),
});

const shapeMismatchError = (message) => Object.assign(new Error(message), { code: "PONS_SHAPE_MISMATCH" });
const isDeterministicGetterMismatch = (error) => error?.code === "PONS_SHAPE_MISMATCH"
  || error?.code === "CALL_EXCEPTION"
  || /(?:execution reverted|missing revert data|call revert exception|unexpected call)/i.test(String(error?.message || ""));

async function readAddressGetter(provider, address, signature, blockTag) {
  const result = await provider.call(callRequest(address, selector(signature), blockTag));
  const decoded = decodeAddressWord(result);
  if (!decoded) throw shapeMismatchError(`${signature} returned an invalid address`);
  return decoded === ZERO_ADDRESS ? null : decoded;
}

const decodeHtml = (value) => String(value)
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, "\"")
  .replace(/&#(?:39|x27);/gi, "'")
  .replace(/&nbsp;/gi, " ");

const visibleText = (html) => decodeHtml(html)
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\\u003c/gi, "<")
  .replace(/\\u003e/gi, ">")
  .replace(/\\n/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/**
 * Read only addresses explicitly labelled as the v2 launch factory. The
 * tempered match deliberately stops at the next component heading, so the
 * already-published hook/escrow cannot be mistaken for the future factory.
 */
export function extractPonsV2FactoryAddresses(html) {
  const text = visibleText(html);
  const addresses = [];
  const patterns = [
    /(?:PonsV2LaunchFactory|launchFactory|factoryAddress)["'\s:=,-]{1,40}(0x[a-fA-F0-9]{40})/g,
    /Launch factory(?:(?!Bonding curve|Launch token|Meme hook|Fee escrow|Buyback vault|Launch locker).){0,260}?(0x[a-fA-F0-9]{40})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const address = normalizeAddress(match[1]);
      if (address && !HISTORICAL_FACTORIES.has(address) && !V2_INFRASTRUCTURE.has(address)) addresses.push(address);
    }
  }
  return [...new Set(addresses)].sort();
}

export function extractOfficialPonsGithubRepositories(html) {
  const links = [...String(html).matchAll(/<a\b([^>]*\bhref=["'](https?:\/\/(?:www\.)?github\.com\/[^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi)]
    .filter((match) => /(?:github|source(?:\s+code)?|contracts?|repositor(?:y|ies)|\brepo\b)/i.test(`${match[1]} ${visibleText(match[3])}`))
    .map((match) => match[2]);
  return extractGithubRepositories(links.join("\n"));
}

// Kept for state/import compatibility. Runtime discovery no longer polls the
// Blockscout "recent 50 transactions" endpoint.
export function extractPonsDeployerCreations(payload) {
  if (!payload || !Array.isArray(payload.items)) throw new Error("Blockscout deployment response missing items");
  return payload.items.flatMap((transaction) => {
    const from = normalizeAddress(transaction.from?.hash || transaction.from);
    const contract = normalizeAddress(transaction.created_contract?.hash || transaction.created_contract);
    if (transaction.status !== "ok" || from !== PONS_DEPLOYER || !contract) return [];
    return [{
      address: contract,
      transactionHash: transaction.hash || null,
      blockNumber: Number(transaction.block_number ?? 0) || null,
      timestamp: transaction.timestamp || null,
      source: "pons_deployer",
    }];
  });
}

export async function readPonsV2FactoryFromHook(provider, hookAddress = PONS_V2_HOOK) {
  const hook = normalizeAddress(hookAddress);
  if (!hook) throw new Error("invalid pons v2 hook address");
  const address = await readAddressGetter(provider, hook, "factory()");
  if (!address) return null;
  return {
    address,
    hookAddress: hook,
    source: hook === PONS_V2_MIGRATION_HOOK ? "official_v2_migration_hook" : "official_v2_hook",
  };
}

export async function readPonsV2HookBinding(provider, hookAddress, blockTag) {
  const hook = normalizeAddress(hookAddress);
  if (!hook) throw new Error("invalid pons v2 hook address");
  const [factory, buybackVault, owner, feeEscrow, poolManager] = await Promise.all([
    readAddressGetter(provider, hook, "factory()", blockTag),
    readAddressGetter(provider, hook, "buybackVault()", blockTag),
    readAddressGetter(provider, hook, "owner()", blockTag),
    readAddressGetter(provider, hook, "feeEscrow()", blockTag),
    readAddressGetter(provider, hook, "poolManager()", blockTag),
  ]);
  return { hook, factory, buybackVault, owner, feeEscrow, poolManager };
}

export async function readPonsV2FactoryBinding(provider, factoryAddress, blockTag) {
  const factory = normalizeAddress(factoryAddress);
  if (!factory) throw new Error("invalid pons v2 factory address");
  const [memeHook, buybackVault, feeEscrow, poolManager] = await Promise.all([
    readAddressGetter(provider, factory, "memeHook()", blockTag),
    readAddressGetter(provider, factory, "buybackVault()", blockTag),
    readAddressGetter(provider, factory, "feeEscrow()", blockTag),
    readAddressGetter(provider, factory, "poolManager()", blockTag),
  ]);
  return { factory, memeHook, buybackVault, feeEscrow, poolManager };
}

export async function readPonsV2FactoryStatus(provider, address, blockTag) {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new Error("invalid pons v2 factory address");
  const [countResult, enabledResult] = await Promise.all([
    provider.call(callRequest(normalized, selector("launchConfigCount()"), blockTag)),
    provider.call(callRequest(normalized, selector("launchEnabled()"), blockTag)),
  ]);
  if (!/^0x[0-9a-fA-F]{64,}$/.test(countResult) || !/^0x[0-9a-fA-F]{64,}$/.test(enabledResult)) {
    throw shapeMismatchError("pons v2 factory returned invalid status values");
  }
  return { launchConfigCount: Number(BigInt(countResult)), launchEnabled: BigInt(enabledResult) !== 0n };
}

const trustedOwnerSet = (values = []) => new Set([
  PONS_DEPLOYER,
  PONS_V2_CURRENT_OWNER,
  ...values,
].map(normalizeAddress).filter(Boolean));

const roleForBinding = (hook, factory, explicitRole) => explicitRole
  || (normalizeAddress(hook) === PONS_V2_MIGRATION_HOOK || normalizeAddress(factory) === PONS_V2_MIGRATION_FACTORY ? "migration" : "main");

/**
 * A copied event topic or copied bytecode is never enough. A factory is Pons
 * v2 only when the official Hook points to it and the factory points back to
 * that same Hook, with the official escrow/pool manager and matching vault.
 */
export async function verifyPonsV2Factory(provider, address, evidence = {}) {
  const normalized = normalizeAddress(address);
  if (!normalized || HISTORICAL_FACTORIES.has(normalized) || V2_INFRASTRUCTURE.has(normalized)) return null;
  const blockTag = evidence.blockTag;
  const ownerAllowlist = trustedOwnerSet(evidence.trustedOwners || []);
  const explicitHook = normalizeAddress(evidence.hookAddress);
  const hookCandidates = explicitHook
    ? [explicitHook]
    : [
        normalized === PONS_V2_MIGRATION_FACTORY ? PONS_V2_MIGRATION_HOOK : null,
        normalized === PONS_V2_MAIN_FACTORY ? PONS_V2_HOOK : null,
        PONS_V2_HOOK,
        PONS_V2_MIGRATION_HOOK,
      ].filter(Boolean);

  const code = String(await provider.getCode(normalized, blockTag)).toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(code) || code === "0x") return null;
  const selectorMatches = FACTORY_SELECTORS.filter((item) => code.includes(item));

  for (const hookAddress of [...new Set(hookCandidates)]) {
    const hookCode = String(await provider.getCode(hookAddress, blockTag)).toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(hookCode) || hookCode === "0x") continue;
    let hookBinding;
    let factoryBinding;
    try {
      [hookBinding, factoryBinding] = await Promise.all([
        readPonsV2HookBinding(provider, hookAddress, blockTag),
        readPonsV2FactoryBinding(provider, normalized, blockTag),
      ]);
    } catch (error) {
      if (isDeterministicGetterMismatch(error)) continue;
      throw error;
    }
    if (hookBinding.factory !== normalized || factoryBinding.memeHook !== hookAddress) continue;
    if (!hookBinding.owner || !ownerAllowlist.has(hookBinding.owner)) continue;
    if (!hookBinding.buybackVault || factoryBinding.buybackVault !== hookBinding.buybackVault) continue;
    if (hookBinding.feeEscrow !== PONS_V2_FEE_ESCROW || factoryBinding.feeEscrow !== PONS_V2_FEE_ESCROW) continue;
    if (hookBinding.poolManager !== PONS_V2_POOL_MANAGER || factoryBinding.poolManager !== PONS_V2_POOL_MANAGER) continue;

    const role = roleForBinding(hookAddress, normalized, evidence.role);
    let status = {};
    if (role !== "migration") {
      try { status = await readPonsV2FactoryStatus(provider, normalized, blockTag); }
      catch (error) {
        if (isDeterministicGetterMismatch(error)) return null;
        throw error;
      }
    }
    return {
      address: normalized,
      role,
      hookAddress,
      owner: hookBinding.owner,
      buybackVault: hookBinding.buybackVault,
      feeEscrow: hookBinding.feeEscrow,
      poolManager: hookBinding.poolManager,
      reciprocalFactoryGetter: hookBinding.factory,
      reciprocalHookGetter: factoryBinding.memeHook,
      bindingVerified: true,
      codeSize: (code.length - 2) / 2,
      selectorMatches,
      launchConfigCountReadable: status.launchConfigCount != null,
      launchEnabledReadable: status.launchEnabled != null,
      launchConfigCount: status.launchConfigCount ?? null,
      launchEnabled: status.launchEnabled ?? null,
      evidence: evidence.source || "unknown",
      ...(blockTag == null ? {} : { verifiedAtBlock: Number(blockTag) }),
    };
  }
  return null;
}

async function atomicWriteJson(file, value, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fsImpl.rename(temporary, file);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const emptyTrustGraph = () => ({ hooks: {}, owners: {}, factories: {}, buybackVaults: {} });
const emptyState = () => ({
  version: 4,
  knownFactories: {},
  pendingFactories: {},
  candidates: {},
  officialRepositories: {},
  trustGraph: emptyTrustGraph(),
  lifecycle: {},
  eventCursor: { nextBlock: null, lastScannedBlock: null, baselineEstablishedAt: null },
  sources: {},
  checkedAt: null,
});

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "text/html", "user-agent": "robinhood-launchpad-monitor" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchExplorerJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

export async function assertPonsExplorerCoverage(fetchImpl, requiredBlock) {
  const required = Number(requiredBlock);
  if (!Number.isSafeInteger(required) || required < 0) throw new Error("invalid Pons explorer coverage block");
  const [indexing, stats] = await Promise.all([
    fetchExplorerJson(fetchImpl, PONS_EXPLORER_INDEXING_STATUS_URL),
    fetchExplorerJson(fetchImpl, PONS_EXPLORER_STATS_URL),
  ]);
  const indexedHeight = Number(stats?.total_blocks);
  if (indexing?.finished_indexing_blocks !== true
    || !Number.isSafeInteger(indexedHeight)
    || indexedHeight < required) {
    throw new Error(`Pons explorer is not indexed through required block ${required}`);
  }
  return { indexedHeight, finishedIndexingBlocks: true };
}

export async function fetchPonsBaselineLifecycleLogs(fetchImpl, {
  factory,
  topic,
  fromBlock,
  toBlock,
}) {
  const normalizedFactory = normalizeAddress(factory);
  const normalizedTopic = String(topic || "").toLowerCase();
  const firstBlock = Math.max(0, Number(fromBlock));
  const lastBlock = Math.max(firstBlock, Number(toBlock));
  if (!normalizedFactory || !/^0x[0-9a-f]{64}$/.test(normalizedTopic)) {
    throw new Error("invalid Pons lifecycle baseline query");
  }

  const url = new URL(PONS_EXPLORER_API_URL);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", String(firstBlock));
  url.searchParams.set("toBlock", String(lastBlock));
  url.searchParams.set("address", normalizedFactory);
  url.searchParams.set("topic0", normalizedTopic);
  const response = await fetchImpl(url.toString(), {
    headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Pons explorer baseline returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.status === "0" && payload?.message === "No logs found" && Array.isArray(payload.result) && payload.result.length === 0) return [];
  if (payload?.status !== "1" || payload?.message !== "OK" || !Array.isArray(payload.result)) {
    throw new Error("Pons explorer baseline returned an invalid logs response");
  }

  const logs = payload.result.map((log) => {
    const address = normalizeAddress(log?.address);
    const blockNumber = Number(log?.blockNumber);
    const topics = Array.isArray(log?.topics) ? log.topics.map((value) => String(value).toLowerCase()) : [];
    const transactionHash = String(log?.transactionHash || "").toLowerCase();
    const transactionIndex = Number(log?.transactionIndex);
    const logIndex = Number(log?.logIndex);
    const data = String(log?.data || "").toLowerCase();
    const token = decodeTopicAddress(topics[1]);
    if (address !== normalizedFactory
      || topics[0] !== normalizedTopic
      || !token
      || token === ZERO_ADDRESS
      || !Number.isSafeInteger(blockNumber)
      || blockNumber < firstBlock
      || blockNumber > lastBlock
      || !Number.isSafeInteger(transactionIndex)
      || transactionIndex < 0
      || !Number.isSafeInteger(logIndex)
      || logIndex < 0
      || !/^0x[0-9a-f]*$/.test(data)
      || !/^0x[0-9a-f]{64}$/.test(transactionHash)) {
      throw new Error("Pons explorer baseline returned a mismatched log");
    }
    return {
      address,
      blockNumber,
      transactionHash,
      transactionIndex,
      logIndex,
      data,
      topics,
    };
  });
  // Blockscout's legacy endpoint is capped at 1,000 results, ordered oldest
  // first. Only the first lifecycle event is needed to suppress old launches.
  return orderedLogs(logs).slice(0, 1);
}

const orderedLogs = (logs) => [...logs].sort((left, right) =>
  Number(left.blockNumber || 0) - Number(right.blockNumber || 0)
  || Number(left.transactionIndex || 0) - Number(right.transactionIndex || 0)
  || Number(left.index ?? left.logIndex ?? 0) - Number(right.index ?? right.logIndex ?? 0));

const transactionUrl = (hash) => hash ? `https://robinhoodchain.blockscout.com/tx/${hash}` : null;
const ponsPlatform = (name = "pons") => ({
  id: "pons",
  name,
  website: "https://ponsfamily.com",
  docs: PONS_V2_DOCS_URL,
  match: "exact_factory",
});

export function createPonsVersionMonitor(config, dependencies = {}) {
  if (config.ponsMonitorEnabled === false) {
    return {
      disabled: true,
      check: async () => false,
      observeLaunchFactory: async () => false,
      state: () => null,
      stop: () => {},
    };
  }
  const provider = dependencies.provider;
  if (!provider) throw new Error("pons version monitor requires a provider");
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const fetchBaselineLogs = dependencies.fetchBaselineLogsImpl
    || ((query) => fetchPonsBaselineLifecycleLogs(fetchImpl, query));
  const assertBaselineCoverage = dependencies.assertBaselineCoverageImpl
    || ((requiredBlock) => assertPonsExplorerCoverage(fetchImpl, requiredBlock));
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const onFactory = dependencies.onFactory || (async () => {});
  const onOfficialRepository = dependencies.onOfficialRepository || (async () => {});
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  const fsImpl = dependencies.fsImpl || fs;
  const stateFile = dependencies.stateFile || path.join(config.dataDir, "pons-version-state.json");
  const autoStart = dependencies.autoStart !== false;
  let state = emptyState();
  let initialized = false;
  let running = false;
  let activeCheckPromise = null;
  const activeObservations = new Set();
  let stopped = false;
  let stopPromise = null;
  let writeQueue = Promise.resolve();
  const blockTimestampCache = new Map();

  const resolveBlockTimestamp = async (evidence = {}, { required = false, context = "Pons event" } = {}) => {
    // Explicit source timestamps (for example a trusted explorer candidate)
    // are chain evidence. Observation/discovery timestamps are intentionally
    // excluded: seeing an event now does not mean it happened now.
    const supplied = normalizeSourceTimestamp(evidence.blockTimestamp ?? evidence.timestamp);
    if (supplied) return supplied;

    const blockNumber = Number(evidence.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      if (required) throw new Error(`${context} is missing a valid block number`);
      return null;
    }

    let lookup = blockTimestampCache.get(blockNumber);
    if (!lookup) {
      lookup = (async () => {
        const block = await provider.getBlock(blockNumber);
        const resolved = normalizeSourceTimestamp(block?.timestamp);
        if (!block || !resolved) throw new Error(`${context} block ${blockNumber} timestamp unavailable`);
        if (block.number != null && Number(block.number) !== blockNumber) {
          throw new Error(`${context} block ${blockNumber} lookup returned block ${block.number}`);
        }
        return resolved;
      })();
      blockTimestampCache.set(blockNumber, lookup);
    }
    try {
      return await lookup;
    } catch (error) {
      if (blockTimestampCache.get(blockNumber) === lookup) blockTimestampCache.delete(blockNumber);
      throw error;
    }
  };

  const writeState = () => {
    writeQueue = writeQueue.then(() => atomicWriteJson(stateFile, state, fsImpl));
    return writeQueue;
  };

  const initialize = async () => {
    if (initialized) return;
    try { state = { ...emptyState(), ...JSON.parse(await fsImpl.readFile(stateFile, "utf8")) }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const loadedVersion = Number(state.version || 0);
    state.version = 4;
    state.knownFactories ||= {};
    state.pendingFactories ||= {};
    state.candidates ||= {};
    state.officialRepositories ||= {};
    state.sources ||= {};
    state.lifecycle ||= {};
    state.eventCursor = { ...emptyState().eventCursor, ...(state.eventCursor || {}) };
    state.trustGraph = { ...emptyTrustGraph(), ...(state.trustGraph || {}) };
    state.trustGraph.hooks ||= {};
    state.trustGraph.owners ||= {};
    state.trustGraph.factories ||= {};
    state.trustGraph.buybackVaults ||= {};
    state.trustGraph.owners[PONS_DEPLOYER] ||= { source: "official_v2_original_owner", retained: true };
    state.trustGraph.owners[PONS_V2_CURRENT_OWNER] ||= { source: "official_v2_current_owner", retained: true };
    for (const [address, record] of Object.entries(state.knownFactories)) {
      if (record.verification?.bindingVerified === true) {
        const confirmedStatus = record.confirmedStatus || {
          launchEnabled: record.verification?.launchEnabled ?? null,
          launchConfigCount: record.verification?.launchConfigCount ?? null,
          source: loadedVersion < 4 ? "legacy_v3_baseline" : "legacy_confirmed_state",
        };
        state.knownFactories[address] = {
          ...record,
          authority: record.authority || (loadedVersion < 4 ? "legacy_baseline_confirmed" : "legacy_confirmed"),
          confirmedStatus,
        };
        delete state.pendingFactories[address];
        await onFactory({ address, ...state.knownFactories[address], replay: true });
        continue;
      }
      // Version 2 accepted topic/selector-only records. Quarantine them until
      // the official Hook and candidate Factory getters verify each other.
      state.candidates[address] = {
        ...state.candidates[address],
        address,
        source: record.source || "legacy_unverified_state",
        firstSeenAt: record.discoveredAt || state.candidates[address]?.firstSeenAt || now().toISOString(),
        attempts: Number(state.candidates[address]?.attempts || 0),
      };
      delete state.knownFactories[address];
    }
    for (const [address, record] of Object.entries(state.pendingFactories)) {
      if (state.knownFactories[address]) {
        delete state.pendingFactories[address];
        continue;
      }
      state.pendingFactories[address] = {
        ...record,
        address,
        authority: record.authority || "getter_fallback_pending",
        firstSeenAt: record.firstSeenAt || record.discoveredAt || now().toISOString(),
        pendingReason: record.pendingReason || "awaiting_verified_factory_set",
      };
    }
    initialized = true;
  };

  const recordSource = (name, ok, detail = null) => {
    const observedAt = now().toISOString();
    const previous = state.sources[name] || {};
    state.sources[name] = ok
      ? { ...previous, checkedAt: observedAt, lastSuccessAt: observedAt, lastError: null, consecutiveFailures: 0 }
      : { ...previous, checkedAt: observedAt, lastErrorAt: observedAt, lastError: detail, consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1 };
  };

  const trustedOwners = () => Object.keys(state.trustGraph.owners);
  const confirmedStatusFor = (record = {}) => ({
    launchEnabled: record.confirmedStatus?.launchEnabled ?? record.verification?.launchEnabled ?? null,
    launchConfigCount: record.confirmedStatus?.launchConfigCount ?? record.verification?.launchConfigCount ?? null,
  });
  const verifyFactory = async (address, evidence = {}) => {
    const enriched = { ...evidence, trustedOwners: [...trustedOwners(), ...(evidence.trustedOwners || [])] };
    return dependencies.verifyFactoryImpl
      ? dependencies.verifyFactoryImpl(address, enriched)
      : verifyPonsV2Factory(provider, address, enriched);
  };

  const updateTrustGraph = (verification, metadata = {}) => {
    const observedAt = now().toISOString();
    const hook = verification.hookAddress;
    const factory = verification.address;
    const previousHook = state.trustGraph.hooks[hook];
    if (previousHook?.factory && previousHook.factory !== factory && state.trustGraph.factories[previousHook.factory]) {
      state.trustGraph.factories[previousHook.factory].active = false;
      state.trustGraph.factories[previousHook.factory].replacedAt = observedAt;
    }
    if (previousHook?.buybackVault && previousHook.buybackVault !== verification.buybackVault && state.trustGraph.buybackVaults[previousHook.buybackVault]) {
      state.trustGraph.buybackVaults[previousHook.buybackVault].active = false;
      state.trustGraph.buybackVaults[previousHook.buybackVault].replacedAt = observedAt;
    }
    state.trustGraph.hooks[hook] = {
      ...previousHook,
      role: verification.role,
      factory,
      buybackVault: verification.buybackVault,
      owner: verification.owner,
      feeEscrow: verification.feeEscrow,
      poolManager: verification.poolManager,
      bindingVerified: true,
      lastVerifiedAt: observedAt,
      ...metadata,
    };
    state.trustGraph.factories[factory] = {
      ...state.trustGraph.factories[factory],
      hookAddress: hook,
      role: verification.role,
      active: true,
      bindingVerified: true,
      lastVerifiedAt: observedAt,
    };
    state.trustGraph.buybackVaults[verification.buybackVault] = {
      ...state.trustGraph.buybackVaults[verification.buybackVault],
      hookAddress: hook,
      role: verification.role,
      active: true,
      lastVerifiedAt: observedAt,
    };
  };

  const confirmCandidate = async (candidate, options = {}) => {
    const address = normalizeAddress(candidate.address);
    if (!address || HISTORICAL_FACTORIES.has(address) || V2_INFRASTRUCTURE.has(address)) return false;
    const blockTimestamp = await resolveBlockTimestamp(candidate, {
      required: candidate.blockNumber !== null && candidate.blockNumber !== undefined,
      context: `Pons factory ${address}`,
    });
    const enrichedCandidate = blockTimestamp ? { ...candidate, blockTimestamp } : candidate;
    const observedAt = now().toISOString();
    const exactFactorySet = enrichedCandidate.evidenceSource === "verified_factory_set_event" && Boolean(blockTimestamp);
    const baseline = options.baseline === true;
    const authoritative = baseline || exactFactorySet;
    const announce = options.announce !== false && exactFactorySet && !baseline;
    if (state.knownFactories[address]) {
      if (authoritative) delete state.pendingFactories[address];
      return true;
    }
    state.candidates[address] = {
      ...state.candidates[address],
      ...enrichedCandidate,
      address,
      firstSeenAt: state.candidates[address]?.firstSeenAt || observedAt,
      lastSeenAt: observedAt,
      attempts: Number(state.candidates[address]?.attempts || 0),
    };
    await writeState();
    try {
      const verification = await verifyFactory(address, enrichedCandidate);
      if (!verification?.bindingVerified && !dependencies.verifyFactoryImpl) {
        state.candidates[address] = { ...state.candidates[address], attempts: state.candidates[address].attempts + 1, lastError: "reciprocal getter verification pending" };
        return false;
      }
      if (!verification) {
        state.candidates[address] = { ...state.candidates[address], attempts: state.candidates[address].attempts + 1, lastError: "factory verification pending" };
        return false;
      }
      const record = {
        version: "v2",
        role: verification.role || enrichedCandidate.role || "main",
        hookAddress: verification.hookAddress || normalizeAddress(enrichedCandidate.hookAddress),
        source: enrichedCandidate.source,
        transactionHash: enrichedCandidate.transactionHash || null,
        blockNumber: enrichedCandidate.blockNumber ?? null,
        ...(blockTimestamp ? { blockTimestamp } : {}),
        ...(enrichedCandidate.evidenceSource ? { evidenceSource: enrichedCandidate.evidenceSource } : {}),
        discoveredAt: observedAt,
        verification,
      };
      if (!authoritative) {
        state.pendingFactories[address] = {
          ...state.pendingFactories[address],
          ...record,
          authority: "getter_fallback_pending",
          firstSeenAt: state.pendingFactories[address]?.firstSeenAt || observedAt,
          lastSeenAt: observedAt,
          pendingReason: "awaiting_verified_factory_set",
        };
        delete state.candidates[address];
        return true;
      }
      record.authority = baseline ? "baseline_confirmed" : "factory_set_confirmed";
      record.confirmedStatus = {
        launchEnabled: verification.launchEnabled ?? null,
        launchConfigCount: verification.launchConfigCount ?? null,
        source: baseline ? "baseline" : "verified_factory_set_event",
        ...(enrichedCandidate.blockNumber == null ? {} : { confirmedAtBlock: Number(enrichedCandidate.blockNumber) }),
      };
      await onFactory({ address, ...record });
      if (announce) {
        await alertSender(config, {
          type: "pons_v2_factory_discovered",
          eventKey: `pons-v2-factory:${address}`,
          platform: ponsPlatform(),
          factory: address,
          source: enrichedCandidate.source,
          url: enrichedCandidate.source === "official_v2_docs" ? PONS_V2_DOCS_URL : `https://robinhoodchain.blockscout.com/address/${address}`,
          verification,
          transactionHash: enrichedCandidate.transactionHash || null,
          blockNumber: enrichedCandidate.blockNumber ?? null,
          ...(blockTimestamp ? { blockTimestamp } : {}),
          observedAt,
        });
      }
      state.knownFactories[address] = record;
      if (verification.bindingVerified) updateTrustGraph(verification);
      delete state.candidates[address];
      delete state.pendingFactories[address];
      return true;
    } catch (error) {
      state.candidates[address] = {
        ...state.candidates[address],
        attempts: Number(state.candidates[address]?.attempts || 0) + 1,
        lastError: error.message,
        lastAttemptAt: observedAt,
      };
      logger.error(`[pons-v2] candidate ${address}: ${error.message}`);
      if (enrichedCandidate.evidenceSource === "verified_factory_set_event") throw error;
      return false;
    } finally {
      await writeState();
    }
  };

  const factorySetEvidence = (logsByHook, hookAddress, factory) => {
    if (!logsByHook) return {};
    const matched = orderedLogs(logsByHook.get(hookAddress) || []).filter((log) => {
      if (String(log.topics?.[0]).toLowerCase() !== PONS_V2_FACTORY_SET_TOPIC.toLowerCase()) return false;
      return (decodeAddressWord(log.data) || decodeTopicAddress(log.topics?.[1])) === factory;
    }).at(-1);
    if (!matched) return {};
    const suppliedTimestamp = matched.blockTimestamp ?? matched.timestamp;
    return {
      transactionHash: matched.transactionHash || null,
      blockNumber: Number(matched.blockNumber),
      blockTag: Number(matched.blockNumber),
      ...(suppliedTimestamp == null ? {} : { timestamp: suppliedTimestamp }),
      evidenceSource: "verified_factory_set_event",
    };
  };

  const bootstrapBindings = async ({ baseline = false, logsByHook = null } = {}) => {
    const candidates = [];
    for (const specification of OFFICIAL_HOOKS) {
      try {
        const binding = await readPonsV2HookBinding(provider, specification.address);
        if (!binding.factory || !binding.owner || !binding.buybackVault) throw new Error("official hook binding is incomplete");
        if (binding.feeEscrow !== PONS_V2_FEE_ESCROW || binding.poolManager !== PONS_V2_POOL_MANAGER) {
          throw new Error("official hook infrastructure getter mismatch");
        }
        if (baseline && !state.trustGraph.owners[binding.owner]) {
          state.trustGraph.owners[binding.owner] = {
            source: "official_hook_owner_getter_baseline",
            firstSeenAt: now().toISOString(),
            retained: true,
          };
        }
        const candidate = {
          address: binding.factory,
          hookAddress: specification.address,
          role: specification.role,
          source: specification.source,
          ...factorySetEvidence(logsByHook, specification.address, binding.factory),
        };
        if (!state.knownFactories[binding.factory] && candidate.blockNumber != null) {
          candidate.blockTimestamp = await resolveBlockTimestamp(candidate, {
            required: true,
            context: `Pons factory ${binding.factory}`,
          });
        }
        const knownFactory = Boolean(state.knownFactories[binding.factory]);
        let verification;
        try {
          verification = await verifyFactory(binding.factory, candidate);
        } catch (error) {
          // A finalized FactorySet or an already-trusted binding is part of the
          // chain cursor: verification outages must keep that block retryable.
          // A new getter-only/docs candidate is auxiliary and may remain queued.
          if (candidate.evidenceSource === "verified_factory_set_event" || knownFactory) throw error;
          candidates.push(candidate);
          recordSource(specification.source, true);
          continue;
        }
        if (!verification) {
          if (knownFactory) throw new Error("reciprocal factory/hook getter verification failed");
          // A conclusive mismatch is not an RPC coverage gap. Keep the
          // candidate quarantined, but do not stall unrelated chain blocks.
          candidates.push(candidate);
          recordSource(specification.source, true);
          continue;
        }
        if (knownFactory) {
          updateTrustGraph(verification);
          const previousVerification = state.knownFactories[binding.factory].verification || {};
          state.knownFactories[binding.factory] = {
            ...state.knownFactories[binding.factory],
            role: verification.role,
            hookAddress: verification.hookAddress,
            verification: {
              ...previousVerification,
              ...verification,
              ...(previousVerification.launchEnabled == null ? {} : { launchEnabled: previousVerification.launchEnabled }),
              ...(previousVerification.launchConfigCount == null ? {} : { launchConfigCount: previousVerification.launchConfigCount }),
            },
          };
        } else {
          candidates.push(candidate);
        }
        recordSource(specification.source, true);
      } catch (error) {
        recordSource(specification.source, false, error.message);
        throw new Error(`${specification.source}: ${error.message}`);
      }
    }
    for (const candidate of candidates) await confirmCandidate(candidate, { announce: !baseline, baseline });
  };

  const refreshKnownFactory = async (candidate) => {
    const address = normalizeAddress(candidate.address);
    const previous = state.knownFactories[address];
    if (!previous || previous.role === "migration") return false;
    try {
      const verification = await verifyFactory(address, {
        ...candidate,
        hookAddress: previous.hookAddress,
        role: previous.role,
      });
      if (!verification) throw new Error("reciprocal binding no longer verifies");
      const current = await readPonsV2FactoryStatus(provider, address);
      const before = confirmedStatusFor(previous);
      const changes = {};
      if (before.launchEnabled !== null && before.launchEnabled !== current.launchEnabled) {
        changes.launchEnabled = { before: before.launchEnabled, after: current.launchEnabled };
      }
      if (before.launchConfigCount !== null && before.launchConfigCount !== current.launchConfigCount) {
        changes.launchConfigCount = { before: before.launchConfigCount, after: current.launchConfigCount };
      }
      const changed = Object.keys(changes).length > 0;
      const observedAt = now().toISOString();
      const nextRecord = {
        ...previous,
        confirmedStatus: {
          ...previous.confirmedStatus,
          ...before,
          source: previous.confirmedStatus?.source || "legacy_confirmed_state",
        },
        lastStatusCheckedAt: observedAt,
        ...(changed ? {
          lastGetterStatusObservedAt: observedAt,
          lastGetterStatusChanges: changes,
        } : {}),
        verification: {
          ...previous.verification,
          ...verification,
          launchEnabled: before.launchEnabled,
          launchConfigCount: before.launchConfigCount,
        },
      };
      if (changed) {
        nextRecord.pendingStatus = {
          source: "getter_fallback_unconfirmed",
          firstObservedAt: previous.pendingStatus?.firstObservedAt || observedAt,
          lastObservedAt: observedAt,
          fields: Object.fromEntries(Object.entries(changes).map(([field, change]) => [field, {
            confirmed: change.before,
            observed: change.after,
          }])),
        };
      } else {
        delete nextRecord.pendingStatus;
      }
      state.knownFactories[address] = nextRecord;
      updateTrustGraph(verification);
      if (changed || previous.pendingStatus) await writeState();
      return changed;
    } catch (error) {
      logger.error(`[pons-v2] status ${address}: ${error.message}`);
      return false;
    }
  };

  const registerVerifiedOwnerEvents = async (logsByHook) => {
    for (const specification of OFFICIAL_HOOKS) {
      const logs = orderedLogs(logsByHook.get(specification.address) || []);
      const transfers = logs.filter((log) => String(log.topics?.[0]).toLowerCase() === PONS_V2_OWNERSHIP_TRANSFERRED_TOPIC.toLowerCase());
      if (!transfers.length) continue;
      const currentOwner = await readAddressGetter(provider, specification.address, "owner()");
      for (const log of transfers) {
        const previousOwner = decodeTopicAddress(log.topics?.[1]);
        const nextOwner = decodeTopicAddress(log.topics?.[2]);
        if (!nextOwner || nextOwner !== currentOwner) continue;
        if (previousOwner) {
          state.trustGraph.owners[previousOwner] ||= {
            source: "verified_ownership_history",
            firstSeenAt: now().toISOString(),
            retained: true,
          };
        }
        state.trustGraph.owners[nextOwner] = {
          ...state.trustGraph.owners[nextOwner],
          source: "verified_ownership_transferred_event",
          firstSeenAt: state.trustGraph.owners[nextOwner]?.firstSeenAt || now().toISOString(),
          transactionHash: log.transactionHash || null,
          blockNumber: Number(log.blockNumber || 0),
          retained: true,
        };
      }
    }
  };

  const recordVerifiedSetterEvents = (logsByHook) => {
    for (const specification of OFFICIAL_HOOKS) {
      const current = state.trustGraph.hooks[specification.address];
      if (!current?.bindingVerified) continue;
      for (const log of orderedLogs(logsByHook.get(specification.address) || [])) {
        const topic = String(log.topics?.[0]).toLowerCase();
        const value = decodeAddressWord(log.data) || decodeTopicAddress(log.topics?.[1]);
        if (topic === PONS_V2_FACTORY_SET_TOPIC.toLowerCase() && value === current.factory) {
          current.lastFactorySet = { value, transactionHash: log.transactionHash || null, blockNumber: Number(log.blockNumber || 0) };
        }
        if (topic === PONS_V2_BUYBACK_VAULT_SET_TOPIC.toLowerCase() && value === current.buybackVault) {
          current.lastBuybackVaultSet = { value, transactionHash: log.transactionHash || null, blockNumber: Number(log.blockNumber || 0) };
        }
      }
    }
  };

  const lifecycleFor = (factory) => {
    state.lifecycle[factory] ||= {};
    return state.lifecycle[factory];
  };

  const confirmBaselineLog = dependencies.confirmBaselineLogImpl || (async (expected) => {
    const receipt = await provider.getTransactionReceipt(expected.transactionHash);
    if (!receipt || Number(receipt.status) !== 1 || Number(receipt.blockNumber) !== Number(expected.blockNumber)) {
      throw new Error(`Pons baseline receipt missing or failed for ${expected.transactionHash}`);
    }
    const expectedAddress = normalizeAddress(expected.address);
    const expectedTopics = (expected.topics || []).map((value) => String(value).toLowerCase());
    const expectedData = String(expected.data || "0x").toLowerCase();
    const expectedIndex = Number(expected.logIndex ?? expected.index);
    const matched = (receipt.logs || []).some((candidate) => {
      const candidateTopics = (candidate.topics || []).map((value) => String(value).toLowerCase());
      return normalizeAddress(candidate.address) === expectedAddress
        && Number(candidate.index ?? candidate.logIndex) === expectedIndex
        && String(candidate.data || "0x").toLowerCase() === expectedData
        && candidateTopics.length === expectedTopics.length
        && candidateTopics.every((value, index) => value === expectedTopics[index]);
    });
    if (!matched) throw new Error(`Pons baseline receipt log mismatch for ${expected.transactionHash}`);
    return true;
  });

  const firstMigrationEvent = async (factory, record, log) => {
    await alertSender(config, {
      type: "token_launch",
      eventKey: `pons-v2-first-migration:${factory}`,
      transactionHash: log.transactionHash || null,
      blockNumber: Number(log.blockNumber || 0),
      blockTimestamp: record.blockTimestamp,
      explorerUrl: transactionUrl(log.transactionHash),
      launcher: factory,
      tokens: [{ token: record.token, metadata: { name: "Pons v2 migration", symbol: "MIGRATION" } }],
      launchpad: ponsPlatform("pons v2 migration"),
      factoryStatus: "known",
      modeStatus: "new_mode_candidate",
      mode: { selector: "TokenMigrated", poolKinds: ["Uniswap v4"] },
      modeDifference: { previous: [], current: { selector: "TokenMigrated", poolKinds: ["Uniswap v4"] } },
      ponsVersion: "v2",
      ponsMigrationFirstToken: true,
      observedAt: now().toISOString(),
    });
  };

  const processFactoryLogs = async (factory, record, logs, {
    baseline = false,
    previousStatus = null,
    verifiedBaseline = false,
    baselineSource = null,
  } = {}) => {
    const lifecycle = lifecycleFor(factory);
    for (const log of orderedLogs(logs)) {
      const topic = String(log.topics?.[0]).toLowerCase();
      const verification = verifiedBaseline && record.verification?.bindingVerified
        ? record.verification
        : await verifyFactory(factory, {
          source: "pons_core_event",
          hookAddress: record.hookAddress,
          role: record.role,
          blockTag: Number(log.blockNumber || 0),
        });
      if (!verification) continue;

      if (topic === PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC.toLowerCase() && record.role !== "migration") {
        const enabled = decodeBooleanWord(log.data);
        if (enabled == null) continue;
        const currentStatus = await readPonsV2FactoryStatus(provider, factory, Number(log.blockNumber));
        if (currentStatus.launchEnabled !== enabled) continue;
        const previousEnabled = confirmedStatusFor(state.knownFactories[factory]).launchEnabled
          ?? previousStatus?.launchEnabled
          ?? null;
        const previousConfirmed = confirmedStatusFor(state.knownFactories[factory]);
        let revision = Number(state.knownFactories[factory].statusRevision || 0);
        if (!baseline && previousEnabled !== null && previousEnabled !== enabled) {
          const blockTimestamp = await resolveBlockTimestamp({ blockNumber: log.blockNumber }, {
            required: true,
            context: `Pons LaunchEnabledUpdated ${factory}`,
          });
          revision += 1;
          await alertSender(config, {
            type: "pons_v2_factory_status_update",
            eventKey: `pons-v2-launch-enabled:${factory}:${log.transactionHash || log.blockNumber}`,
            platform: ponsPlatform(),
            factory,
            changes: { launchEnabled: { before: previousEnabled, after: enabled } },
            status: {
              launchEnabled: enabled,
              launchConfigCount: previousConfirmed.launchConfigCount,
            },
            source: "LaunchEnabledUpdated",
            transactionHash: log.transactionHash || null,
            blockNumber: Number(log.blockNumber),
            blockTimestamp,
            explorerUrl: transactionUrl(log.transactionHash),
            observedAt: now().toISOString(),
          });
        }
        const currentRecord = state.knownFactories[factory];
        const pendingFields = { ...(currentRecord.pendingStatus?.fields || {}) };
        delete pendingFields.launchEnabled;
        const nextRecord = {
          ...currentRecord,
          verification: {
            ...currentRecord.verification,
            launchEnabled: enabled,
            launchConfigCount: previousConfirmed.launchConfigCount,
          },
          confirmedStatus: {
            ...currentRecord.confirmedStatus,
            launchEnabled: enabled,
            launchConfigCount: previousConfirmed.launchConfigCount,
            source: "LaunchEnabledUpdated",
            confirmedAtBlock: Number(log.blockNumber),
            confirmedAt: now().toISOString(),
          },
          statusRevision: revision,
        };
        if (Object.keys(pendingFields).length) {
          nextRecord.pendingStatus = { ...currentRecord.pendingStatus, fields: pendingFields };
        } else {
          delete nextRecord.pendingStatus;
        }
        state.knownFactories[factory] = nextRecord;
        continue;
      }

      if (topic === PONS_V2_TOKEN_LAUNCHED_TOPIC.toLowerCase() && record.role !== "migration") {
        if (lifecycle.firstToken) continue;
        const token = decodeTopicAddress(log.topics?.[1]);
        if (!token) continue;
        const first = {
          token,
          transactionHash: log.transactionHash || null,
          blockNumber: Number(log.blockNumber || 0),
          observedAt: now().toISOString(),
          baseline,
          ...(baselineSource ? { source: baselineSource } : {}),
        };
        // Pons ordinary launches are deliberately state-only. Factory/config,
        // migration and authenticated module changes are the alert surfaces.
        lifecycle.firstToken = first;
        continue;
      }

      if (topic === PONS_V2_TOKEN_MIGRATED_TOPIC.toLowerCase() && record.role === "migration") {
        if (lifecycle.firstMigration) continue;
        const token = decodeTopicAddress(log.topics?.[1]);
        if (!token) continue;
        const blockTimestamp = await resolveBlockTimestamp({ blockNumber: log.blockNumber }, {
          required: true,
          context: `Pons first TokenMigrated ${factory}`,
        });
        const first = {
          token,
          transactionHash: log.transactionHash || null,
          blockNumber: Number(log.blockNumber || 0),
          blockTimestamp,
          observedAt: now().toISOString(),
          baseline,
          ...(baselineSource ? { source: baselineSource } : {}),
        };
        if (!baseline) await firstMigrationEvent(factory, first, log);
        lifecycle.firstMigration = first;
      }
    }
  };

  const baselineLifecycle = async (latestBlock) => {
    const collected = [];
    const lifecycleBefore = structuredClone(state.lifecycle);
    try {
      const historyToBlock = latestBlock - BASELINE_INDEXER_TAIL_BLOCKS;
      const hasHistoricalSpan = Object.values(state.knownFactories).some((record) => {
        const fromBlock = record.role === "migration" ? MIGRATION_FACTORY_START_BLOCK : MAIN_FACTORY_START_BLOCK;
        return historyToBlock >= fromBlock;
      });
      if (hasHistoricalSpan) await assertBaselineCoverage(historyToBlock);
      for (const [factory, record] of Object.entries(state.knownFactories)) {
        const topic = record.role === "migration" ? PONS_V2_TOKEN_MIGRATED_TOPIC : PONS_V2_TOKEN_LAUNCHED_TOPIC;
        const fromBlock = record.role === "migration" ? MIGRATION_FACTORY_START_BLOCK : MAIN_FACTORY_START_BLOCK;
        if (fromBlock > latestBlock) continue;
        let logs = [];
        let source = "blockscout+receipt";
        if (historyToBlock >= fromBlock) {
          logs = await fetchBaselineLogs({ factory, topic, fromBlock, toBlock: historyToBlock });
          if (logs.length) await confirmBaselineLog(logs[0]);
        }
        if (!logs.length) {
          source = "rpc_tail";
          const tailFromBlock = Math.max(fromBlock, historyToBlock + 1);
          for (let nextBlock = tailFromBlock; nextBlock <= latestBlock; nextBlock += BASELINE_RPC_CHUNK_SIZE) {
            const toBlock = Math.min(latestBlock, nextBlock + BASELINE_RPC_CHUNK_SIZE - 1);
            const tailLogs = await provider.getLogs({ address: factory, fromBlock: nextBlock, toBlock, topics: [topic] });
            if (tailLogs.length) {
              logs = orderedLogs(tailLogs).slice(0, 1);
              break;
            }
          }
        }
        collected.push({ factory, record, logs, source });
      }
      for (const item of collected) {
        await processFactoryLogs(item.factory, item.record, item.logs, {
          baseline: true,
          verifiedBaseline: true,
          baselineSource: item.source,
        });
      }
    } catch (error) {
      state.lifecycle = lifecycleBefore;
      throw error;
    }
  };

  const scanCoreEvents = async (fromBlock, toBlock) => {
    const statusBeforeScan = new Map(Object.entries(state.knownFactories).map(([factory, record]) => [factory, confirmedStatusFor(record)]));
    const logsByHook = new Map();
    const hookTopics = [[
      PONS_V2_FACTORY_SET_TOPIC,
      PONS_V2_BUYBACK_VAULT_SET_TOPIC,
      PONS_V2_OWNERSHIP_TRANSFERRED_TOPIC,
    ]];
    for (const specification of OFFICIAL_HOOKS) {
      logsByHook.set(specification.address, await provider.getLogs({
        address: specification.address,
        fromBlock,
        toBlock,
        topics: hookTopics,
      }));
    }
    await registerVerifiedOwnerEvents(logsByHook);
    await bootstrapBindings({ baseline: false, logsByHook });
    recordVerifiedSetterEvents(logsByHook);

    for (const [factory, record] of Object.entries(state.knownFactories)) {
      const topics = record.role === "migration"
        ? [[PONS_V2_TOKEN_MIGRATED_TOPIC]]
        : [[PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC, PONS_V2_TOKEN_LAUNCHED_TOPIC]];
      const logs = await provider.getLogs({ address: factory, fromBlock, toBlock, topics });
      await processFactoryLogs(factory, record, logs, { previousStatus: statusBeforeScan.get(factory) || null });
    }
  };

  const collectDocsCandidates = async () => {
    try {
      const html = await fetchText(fetchImpl, PONS_V2_DOCS_URL);
      recordSource("official_v2_docs", true);
      for (const repository of extractOfficialPonsGithubRepositories(html)) {
        const observedAt = now().toISOString();
        await onOfficialRepository(repository, { source: "official_docs", url: PONS_V2_DOCS_URL, observedAt });
        state.officialRepositories[repository.toLowerCase()] = { repository, source: "official_docs", url: PONS_V2_DOCS_URL, observedAt };
      }
      return extractPonsV2FactoryAddresses(html).map((address) => ({ address, source: "official_v2_docs" }));
    } catch (error) {
      recordSource("official_v2_docs", false, error.message);
      logger.error(`[pons-v2] docs: ${error.message}`);
      return [];
    }
  };

  const runCheckCycle = async () => {
    await initialize();
    running = true;
    try {
      const docsPromise = collectDocsCandidates();
      const latest = Math.max(0, Number(await provider.getBlockNumber()) - Number(config.confirmations || 0));
      const baseline = state.eventCursor.nextBlock == null;
      if (baseline) {
        await bootstrapBindings({ baseline: true });
        await baselineLifecycle(latest);
        state.eventCursor = {
          nextBlock: latest + 1,
          lastScannedBlock: latest,
          baselineEstablishedAt: now().toISOString(),
        };
        recordSource("pons_core_events", true);
        await writeState();
      } else {
        let nextBlock = Number(state.eventCursor.nextBlock);
        const chunkSize = Math.max(1, Number(config.ponsVersionEventChunkSize || DEFAULT_EVENT_CHUNK_SIZE));
        while (nextBlock <= latest) {
          const toBlock = Math.min(latest, nextBlock + chunkSize - 1);
          await scanCoreEvents(nextBlock, toBlock);
          state.eventCursor.nextBlock = toBlock + 1;
          state.eventCursor.lastScannedBlock = toBlock;
          recordSource("pons_core_events", true);
          await writeState();
          nextBlock = toBlock + 1;
        }
        // Getter polling is also a recovery path when a provider omits a log.
        await bootstrapBindings({ baseline: false });
      }

      const candidates = await docsPromise;
      for (const candidate of Object.values(state.candidates)) candidates.push(candidate);
      for (const candidate of Object.values(state.pendingFactories)) candidates.push(candidate);
      const unique = new Map(candidates.map((candidate) => [normalizeAddress(candidate.address), candidate]));
      unique.delete(null);
      for (const candidate of unique.values()) {
        const address = normalizeAddress(candidate.address);
        if (state.knownFactories[address]) await refreshKnownFactory(candidate);
        else await confirmCandidate(candidate, { announce: !baseline });
      }
      for (const [address, record] of Object.entries(state.knownFactories)) {
        if (record.role !== "migration" && state.trustGraph.factories[address]?.active !== false) {
          await refreshKnownFactory({ address, source: "official_v2_hook", hookAddress: record.hookAddress });
        }
      }
      state.checkedAt = now().toISOString();
      await writeState();
      return state;
    } catch (error) {
      recordSource("pons_core_events", false, error.message);
      await writeState().catch(() => {});
      throw error;
    } finally {
      running = false;
    }
  };

  const check = () => {
    if (stopped) return activeCheckPromise || Promise.resolve(state);
    if (activeCheckPromise) return Promise.resolve(state);
    activeCheckPromise = runCheckCycle().finally(() => {
      activeCheckPromise = null;
    });
    return activeCheckPromise;
  };

  const runLaunchFactoryObservation = async (address, evidence = {}) => {
    await initialize();
    const normalized = normalizeAddress(address);
    if (!normalized) return false;
    const previous = state.knownFactories[normalized];
    const pending = state.pendingFactories[normalized];
    const hookAddress = normalizeAddress(evidence.hookAddress || previous?.hookAddress || pending?.hookAddress)
      || (normalized === PONS_V2_MIGRATION_FACTORY ? PONS_V2_MIGRATION_HOOK : PONS_V2_HOOK);
    const verification = await verifyFactory(normalized, {
      ...evidence,
      hookAddress,
      role: previous?.role || pending?.role || (hookAddress === PONS_V2_MIGRATION_HOOK ? "migration" : "main"),
      source: "v2_token_launched_event",
      blockTag: evidence.blockNumber,
    });
    if (!verification) return false;
    const observedAt = now().toISOString();
    if (!previous) {
      const blockTimestamp = await resolveBlockTimestamp(evidence, {
        required: evidence.blockNumber !== null && evidence.blockNumber !== undefined,
        context: `Pons factory ${normalized}`,
      });
      const record = {
        version: "v2",
        role: verification.role,
        hookAddress: verification.hookAddress,
        source: "v2_token_launched_event",
        transactionHash: evidence.transactionHash || null,
        blockNumber: evidence.blockNumber ?? null,
        ...(blockTimestamp ? { blockTimestamp } : {}),
        discoveredAt: observedAt,
        verification,
        authority: "token_launch_observation_pending",
        firstSeenAt: pending?.firstSeenAt || observedAt,
        lastSeenAt: observedAt,
        pendingReason: "awaiting_verified_factory_set",
      };
      state.pendingFactories[normalized] = { ...pending, ...record };
      delete state.candidates[normalized];
    } else {
      const confirmed = confirmedStatusFor(previous);
      state.knownFactories[normalized] = {
        ...previous,
        verification: {
          ...previous.verification,
          ...verification,
          launchEnabled: confirmed.launchEnabled,
          launchConfigCount: confirmed.launchConfigCount,
        },
      };
      updateTrustGraph(verification);
    }
    await writeState();
    return true;
  };

  const observeLaunchFactory = (address, evidence = {}) => {
    if (stopped) return Promise.resolve(false);
    const operation = runLaunchFactoryObservation(address, evidence);
    activeObservations.add(operation);
    void operation.then(
      () => activeObservations.delete(operation),
      () => activeObservations.delete(operation),
    );
    return operation;
  };

  let timer = null;
  if (autoStart) {
    void check().catch((error) => logger.error(`[pons-v2] check: ${error.message}`));
    timer = setInterval(() => void check().catch((error) => logger.error(`[pons-v2] check: ${error.message}`)), config.ponsVersionPollIntervalMs);
    timer.unref();
  }
  return {
    check,
    observeLaunchFactory,
    state: () => state,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      stopPromise = (async () => {
        await Promise.allSettled([activeCheckPromise, ...activeObservations].filter(Boolean));
        await writeQueue;
      })();
      return stopPromise;
    },
  };
}
