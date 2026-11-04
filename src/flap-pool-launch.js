// Flap Pool Launch (poollaunch / DIRECT_V2_POOL_TAX).
// Docs: https://docs.flap.sh/en/docs/pool-launch
// BNB Chain (chainId 56) Portal proxy, also documented for BNB testnet:
// 0x000042108465206185A077Edc3F3fd2b49060000
// Index Portal logs. Curve launches stay on the legacy Portal
// (0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0) and are not this event.
// Read helpers on this Portal, not required to index a launch:
// getLaunchToken(token), getLaunchVault(token), graduationFloorV2(...).
import { AbiCoder, Interface, ZeroAddress, getAddress, id } from "ethers";

export const FLAP_POOL_LAUNCH_DOCS_URL = "https://docs.flap.sh/en/docs/pool-launch";
export const FLAP_POOL_LAUNCH_PORTAL = getAddress("0x000042108465206185A077Edc3F3fd2b49060000");
export const FLAP_POOL_LAUNCH_CHAIN_ID = 56;
export const FLAP_POOL_LAUNCH_KIND = "flap_pool_launch";
export const V2_POOL_LAUNCH_SCHEMA_V1 = id("DirectLaunchV2(DirectLaunchV2Data)");

const LAUNCH_KINDS = new Map([[0, "DIRECT_V2_POOL_TAX"]]);
const TOKEN_VERSIONS = new Map([[0, "TOKEN_DIRECT_TAXED"]]);
const DISTRIBUTION_TARGETS = new Map([[0, "NONE"], [1, "EXPLICIT"], [2, "VAULT"]]);

export const flapPoolLaunchInterface = new Interface([
  "event FlapDirectLaunched(address token,uint8 kind,address creator,bytes32 schemaId,bytes data)",
  "event FlapTokenGraduated(address token)",
  "event FlapLaunchVaultResolved(address token,address vault,address vaultFactory)",
  "event FlapDistributionExecuted(address token,uint8 target,address strategy,uint256 amount)",
  "event FlapSaltLocked(address locker,bytes32 salt,address tokenAddress,uint8 launchKind,uint256 ts)",
  "event FlapSaltUsed(address locker,bytes32 salt,address tokenAddress,uint8 launchKind,uint256 ts)",
]);

export const FLAP_DIRECT_LAUNCHED_TOPIC = flapPoolLaunchInterface.getEvent("FlapDirectLaunched").topicHash.toLowerCase();
const GRADUATED_TOPIC = flapPoolLaunchInterface.getEvent("FlapTokenGraduated").topicHash.toLowerCase();
const VAULT_TOPIC = flapPoolLaunchInterface.getEvent("FlapLaunchVaultResolved").topicHash.toLowerCase();
const DISTRIBUTION_TOPIC = flapPoolLaunchInterface.getEvent("FlapDistributionExecuted").topicHash.toLowerCase();
const SALT_LOCKED_TOPIC = flapPoolLaunchInterface.getEvent("FlapSaltLocked").topicHash.toLowerCase();
const SALT_USED_TOPIC = flapPoolLaunchInterface.getEvent("FlapSaltUsed").topicHash.toLowerCase();

const DIRECT_V2_TUPLE = "tuple(uint256 nonce,uint256 ts,uint8 tokenVersion,address quoteToken,uint8 migratorType,uint256 initialPriceWad,string name,string symbol,string meta,address pool,uint256 totalSupply,uint8 antiSniperMode,uint16 maxBuyBps)";
const coder = AbiCoder.defaultAbiCoder();

function topicOf(log) {
  return String(log?.topics?.[0] || "").toLowerCase();
}

function checksum(value) {
  try { return getAddress(String(value)); }
  catch { return null; }
}

function sameAddress(left, right) {
  const a = checksum(left);
  const b = checksum(right);
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function cleanText(value, max) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function decimalWad(value) {
  const raw = BigInt(value);
  const scale = 10n ** 18n;
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function safeParse(log) {
  try { return flapPoolLaunchInterface.parseLog(log); }
  catch { return null; }
}

function logIndexOf(log) {
  const value = log?.logIndex ?? log?.index;
  const parsed = typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)
    ? Number.parseInt(value, 16)
    : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function decodeDirectV2Data(data) {
  const [fields] = coder.decode([DIRECT_V2_TUPLE], data);
  const quoteToken = checksum(fields.quoteToken);
  const pool = checksum(fields.pool);
  if (!quoteToken || !pool) return null;
  const native = quoteToken === ZeroAddress;
  const initialPriceWad = fields.initialPriceWad.toString();
  return {
    nonce: fields.nonce.toString(),
    ts: fields.ts.toString(),
    tokenVersion: Number(fields.tokenVersion),
    tokenVersionName: TOKEN_VERSIONS.get(Number(fields.tokenVersion)) || null,
    quoteToken,
    quoteNative: native,
    quoteLabel: native ? "BNB" : quoteToken,
    migratorType: Number(fields.migratorType),
    initialPriceWad,
    initialPriceQuotePerToken: decimalWad(fields.initialPriceWad),
    name: cleanText(fields.name, 128),
    symbol: cleanText(fields.symbol, 32),
    meta: cleanText(fields.meta, 512),
    pool,
    totalSupply: fields.totalSupply.toString(),
    antiSniperMode: Number(fields.antiSniperMode),
    maxBuyBps: Number(fields.maxBuyBps),
  };
}

function emptyDetails(kind) {
  return {
    nonce: null,
    ts: null,
    tokenVersion: null,
    tokenVersionName: null,
    quoteToken: null,
    quoteNative: false,
    quoteLabel: null,
    migratorType: null,
    initialPriceWad: null,
    initialPriceQuotePerToken: null,
    name: null,
    symbol: null,
    meta: null,
    pool: null,
    totalSupply: null,
    antiSniperMode: null,
    maxBuyBps: null,
    launchKind: kind,
  };
}

// One Portal log, or a whole receipt. Graduation, vault, distribution and salt
// logs are joined onto the canonical FlapDirectLaunched record from the same
// receipt. A missing FlapTokenGraduated on DIRECT_V2_POOL_TAX is final.
export function decodeFlapPoolLaunchReceipt(logs = []) {
  const list = Array.isArray(logs) ? logs : [];
  const graduated = new Set();
  const vaults = new Map();
  const distributions = new Map();
  const salts = new Map();
  for (const log of list) {
    const topic = topicOf(log);
    const parsed = topic === GRADUATED_TOPIC || topic === VAULT_TOPIC || topic === DISTRIBUTION_TOPIC
      || topic === SALT_LOCKED_TOPIC || topic === SALT_USED_TOPIC
      ? safeParse(log)
      : null;
    if (!parsed) continue;
    if (parsed.name === "FlapTokenGraduated") {
      const token = checksum(parsed.args.token);
      if (token) graduated.add(token.toLowerCase());
    } else if (parsed.name === "FlapLaunchVaultResolved") {
      const token = checksum(parsed.args.token);
      const vault = checksum(parsed.args.vault);
      const vaultFactory = checksum(parsed.args.vaultFactory);
      if (token && vault && vaultFactory) vaults.set(token.toLowerCase(), { vault, vaultFactory });
    } else if (parsed.name === "FlapDistributionExecuted") {
      const token = checksum(parsed.args.token);
      const strategy = checksum(parsed.args.strategy);
      if (!token || !strategy) continue;
      const target = Number(parsed.args.target);
      distributions.set(token.toLowerCase(), {
        target,
        targetName: DISTRIBUTION_TARGETS.get(target) || `target_${target}`,
        strategy,
        amount: parsed.args.amount.toString(),
      });
    } else if (parsed.name === "FlapSaltLocked" || parsed.name === "FlapSaltUsed") {
      const token = checksum(parsed.args.tokenAddress);
      const locker = checksum(parsed.args.locker);
      if (!token || !locker) continue;
      const previous = salts.get(token.toLowerCase()) || {};
      salts.set(token.toLowerCase(), {
        ...previous,
        locker,
        salt: String(parsed.args.salt),
        launchKind: Number(parsed.args.launchKind),
        used: parsed.name === "FlapSaltUsed" || previous.used === true,
      });
    }
  }

  const launches = [];
  for (const log of list) {
    if (topicOf(log) !== FLAP_DIRECT_LAUNCHED_TOPIC) continue;
    if (!sameAddress(log?.address, FLAP_POOL_LAUNCH_PORTAL)) continue;
    const parsed = safeParse(log);
    if (!parsed || parsed.name !== "FlapDirectLaunched") continue;
    const token = checksum(parsed.args.token);
    const creator = checksum(parsed.args.creator);
    const logIndex = logIndexOf(log);
    if (!token || !creator || logIndex === null) continue;
    const kind = Number(parsed.args.kind);
    const schemaId = String(parsed.args.schemaId || "").toLowerCase();
    let details = null;
    let schemaKnown = schemaId === V2_POOL_LAUNCH_SCHEMA_V1;
    if (schemaKnown) {
      try { details = decodeDirectV2Data(parsed.args.data); }
      catch { details = null; }
      if (!details) schemaKnown = false;
    }
    const launchKindName = LAUNCH_KINDS.get(kind) || `kind_${kind}`;
    const graduationFinal = launchKindName === "DIRECT_V2_POOL_TAX";
    const vault = vaults.get(token.toLowerCase()) || null;
    launches.push({
      event: "FlapDirectLaunched",
      portal: FLAP_POOL_LAUNCH_PORTAL,
      chainId: FLAP_POOL_LAUNCH_CHAIN_ID,
      docsUrl: FLAP_POOL_LAUNCH_DOCS_URL,
      token,
      creator,
      logIndex,
      launchKind: kind,
      launchKindName,
      schemaId,
      schemaName: schemaKnown ? "V2_POOL_LAUNCH_SCHEMA_V1" : null,
      schemaKnown,
      ...(details || emptyDetails(kind)),
      graduated: graduated.has(token.toLowerCase()),
      // DIRECT_V2_POOL_TAX checks the floor once, inside this transaction.
      graduationFinal,
      vault: vault?.vault || null,
      vaultFactory: vault?.vaultFactory || null,
      distribution: distributions.get(token.toLowerCase()) || null,
      salt: salts.get(token.toLowerCase()) || null,
      monitorOnly: true,
      autoTradeEligible: false,
    });
  }
  return launches;
}

export function flapDirectLaunchedEvidence(log) {
  const [launch] = decodeFlapPoolLaunchReceipt([log]);
  if (!launch) return null;
  return {
    token: launch.token,
    creator: launch.creator,
    name: launch.name,
    symbol: launch.symbol,
    metadataUri: launch.meta,
    pool: launch.pool,
    quoteToken: launch.quoteToken,
    initialPriceWad: launch.initialPriceWad,
    totalSupply: launch.totalSupply,
    vault: launch.vault,
    vaultFactory: launch.vaultFactory,
    launchType: launch.schemaKnown && launch.launchKindName === "DIRECT_V2_POOL_TAX"
      ? "direct_v2_pool_tax"
      : "flap_pool_launch",
    event: "FlapDirectLaunched",
    graduated: launch.graduated,
    schemaId: launch.schemaId,
    schemaKnown: launch.schemaKnown,
  };
}

export function isFlapPoolLaunchObservation(observation) {
  const launches = Array.isArray(observation?.poolLaunch) ? observation.poolLaunch : [];
  return launches.length > 0 && launches.every((launch) => launch?.event === "FlapDirectLaunched"
    && sameAddress(launch.portal, FLAP_POOL_LAUNCH_PORTAL)
    && checksum(launch.token));
}

function hash(value) {
  return String(value || "").toLowerCase();
}

export function buildFlapPoolLaunchUpdate(observation) {
  const launches = Array.isArray(observation?.poolLaunch) ? observation.poolLaunch : [];
  if (!isFlapPoolLaunchObservation(observation)) return null;
  const transactionHash = hash(observation.transactionHash);
  const blockHash = hash(observation.blockHash);
  const blockNumber = Number(observation.blockNumber);
  const transactionIndex = Number(observation.transactionIndex ?? 0);
  const logIndex = Number(launches[0].logIndex);
  if (!/^0x[a-f0-9]{64}$/.test(transactionHash)
    || !Number.isSafeInteger(blockNumber) || blockNumber < 0
    || !Number.isSafeInteger(logIndex) || logIndex < 0
    || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0) return null;
  const platform = observation.platform?.id === "flap" && observation.platform?.trust === "official_verified"
    ? {
      id: "flap",
      name: observation.platform.name || "Flap",
      trust: "official_verified",
      website: observation.platform.website || "https://flap.sh",
      twitter: observation.platform.twitter || "https://x.com/flapdotsh",
      evidenceUrl: FLAP_POOL_LAUNCH_DOCS_URL,
    }
    : {
      id: "flap",
      name: "Flap",
      trust: "official_verified",
      website: "https://flap.sh",
      twitter: "https://x.com/flapdotsh",
      evidenceUrl: FLAP_POOL_LAUNCH_DOCS_URL,
    };
  return {
    type: "bsc_launchpad_update",
    kind: FLAP_POOL_LAUNCH_KIND,
    eventKey: `bsc-flap-pool-launch:${FLAP_POOL_LAUNCH_CHAIN_ID}:${transactionHash}:${logIndex}`,
    chainId: FLAP_POOL_LAUNCH_CHAIN_ID,
    launcher: FLAP_POOL_LAUNCH_PORTAL,
    platform,
    informationalOnly: true,
    autoTradeEligible: false,
    automaticExecution: false,
    strong: true,
    launchCount: launches.length,
    uniqueTokens: launches.length,
    transactionHash,
    blockNumber,
    ...( /^0x[a-f0-9]{64}$/.test(blockHash) ? { blockHash } : {}),
    blockTimestamp: observation.observedAt || null,
    transactionIndex,
    logIndex,
    tokens: launches.map((launch) => ({
      token: launch.token,
      isNewContract: true,
      metadata: {
        name: launch.name,
        symbol: launch.symbol,
        metadataUri: launch.meta,
        totalSupply: launch.totalSupply,
      },
    })),
    pools: launches.filter((launch) => launch.pool).map((launch) => ({
      kind: "v2",
      pool: launch.pool,
      quoteToken: launch.quoteToken,
      verifiedDex: false,
      source: "flap_direct_launched",
    })),
    poolLaunches: launches,
    mode: {
      selector: "launchTaxTokenV2",
      componentMode: "Flap Pool Launch",
      launchKind: launches[0].launchKind,
      launchKindName: launches[0].launchKindName,
      schemaId: launches[0].schemaId,
      schemaName: launches[0].schemaName,
      quoteAsset: launches[0].quoteToken,
      quoteSymbol: launches[0].quoteNative ? "BNB" : null,
      quoteLabel: launches[0].quoteLabel,
      initialPriceWad: launches[0].initialPriceWad,
      initialPriceQuotePerToken: launches[0].initialPriceQuotePerToken,
      graduated: launches[0].graduated,
      graduationFinal: launches[0].graduationFinal,
      monitorOnly: true,
      docsUrl: FLAP_POOL_LAUNCH_DOCS_URL,
      creationTopics: [FLAP_DIRECT_LAUNCHED_TOPIC],
    },
    structural: {
      eligible: true,
      mechanismEvidence: true,
      causalTokenEvent: true,
      controllerKind: "official_event_emitter",
      source: "flap_direct_launched",
    },
    security: observation.security || null,
    docsUrl: FLAP_POOL_LAUNCH_DOCS_URL,
    sourceUrl: `https://bscscan.com/tx/${transactionHash}`,
    explorerUrl: `https://bscscan.com/tx/${transactionHash}`,
    launcherUrl: `https://bscscan.com/address/${FLAP_POOL_LAUNCH_PORTAL}`,
    observedAt: observation.observedAt || null,
  };
}

export function isCanonicalFlapPoolLaunchUpdate(event) {
  if (!event || event.type !== "bsc_launchpad_update" || event.kind !== FLAP_POOL_LAUNCH_KIND) return false;
  if (event.chainId !== FLAP_POOL_LAUNCH_CHAIN_ID) return false;
  if (!sameAddress(event.launcher, FLAP_POOL_LAUNCH_PORTAL)) return false;
  if (event.informationalOnly !== true || event.autoTradeEligible !== false || event.automaticExecution !== false) return false;
  if (event.strong !== true) return false;
  if (event.platform?.id !== "flap" || event.platform?.trust !== "official_verified") return false;
  if (event.docsUrl !== FLAP_POOL_LAUNCH_DOCS_URL || event.mode?.docsUrl !== FLAP_POOL_LAUNCH_DOCS_URL) return false;
  if (event.mode?.monitorOnly !== true || event.mode?.componentMode !== "Flap Pool Launch") return false;
  const launches = Array.isArray(event.poolLaunches) ? event.poolLaunches : [];
  const tokens = Array.isArray(event.tokens) ? event.tokens : [];
  const transactionHash = hash(event.transactionHash);
  const logIndex = Number(event.logIndex);
  if (!launches.length || launches.length > 8 || tokens.length !== launches.length) return false;
  if (!/^0x[a-f0-9]{64}$/.test(transactionHash)) return false;
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) return false;
  if (event.eventKey !== `bsc-flap-pool-launch:${FLAP_POOL_LAUNCH_CHAIN_ID}:${transactionHash}:${logIndex}`) return false;
  if (Number(launches[0].logIndex) !== logIndex) return false;
  return launches.every((launch, index) => {
    const token = tokens[index]?.token;
    return launch?.event === "FlapDirectLaunched"
      && launch.monitorOnly === true
      && launch.autoTradeEligible === false
      && sameAddress(launch.portal, FLAP_POOL_LAUNCH_PORTAL)
      && sameAddress(launch.token, token)
      && checksum(launch.creator)
      && typeof launch.graduated === "boolean"
      && typeof launch.graduationFinal === "boolean"
      && (launch.schemaKnown === true || launch.schemaKnown === false);
  });
}
