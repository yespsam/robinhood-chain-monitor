import fs from "node:fs/promises";
import path from "node:path";
import { isAddress } from "ethers";
import { isTerminalAlertSuppression, sendAlerts } from "./alerts.js";
import {
  discoverGmgnBscKolCandidates,
  parseFomoScanProfile,
  parseFxTwitterProfile,
} from "./fomo-call-monitor.js";
import { defaultQualifyFomoThesis } from "./fomo-thesis-monitor.js";
import { parseFxTwitterTimeline, parseOfficialXOembed } from "./twitter-monitor.js";

const STATE_VERSION = 2;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const FUTURE_TOLERANCE_MS = 60_000;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const FORBIDDEN_GMGN_TAGS = new Set(["wash_trader", "arbitrager"]);
const GMGN_CANDIDATE_SOURCE = "gmgn_bsc_kol_feed";
const FOMOSCAN_SEED_SOURCE = "fomoscan_verified_profile";
const FX_PROFILE_SOURCE = "fxtwitter_profile";
const FX_TIMELINE_SOURCE = "fxtwitter_timeline";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TRANSPORT_BACKOFFS = Object.freeze({
  timeline404: Object.freeze([15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS]),
  timeout: Object.freeze([MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS]),
  transient: Object.freeze([MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS]),
  other: Object.freeze([5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS]),
});
const BSC_CHAIN = Object.freeze({
  id: 56,
  chainId: 56,
  slug: "bsc",
  name: "BNB Smart Chain",
  gmgn: "bsc",
  evm: true,
});
const FIRST_PERSON_CALL_WORDS = /(?:\b(?:i\s+(?:(?:am|['’]m)\s+)?(?:buying|aping|accumulating|entering|adding|loading|long)|i\s+(?:bought|aped|accumulated|entered|added|loaded|called|went\s+long)|my\s+(?:call|entry|position|bag)|(?:buying|aping|accumulating|entering|adding|loading)\s+(?:this|now|here|more|the\b)|bullish\b[^.\n]{0,48}\b(?:buying|long)|long\s+(?:on|here)|call(?:ing)?\s+(?:this|it))\b|我(?:买入|买了|入场|建仓|加仓|上车|埋伏|看好|持仓|梭哈)|(?:正在|已经|已)?(?:买入|入场|建仓|加仓|上车|埋伏)|看好这个)/iu;
const NEGATIVE_CALL_WORDS = /(?:\b(?:(?:do\s+not|don['’]?t|dont|not|never|avoid|stop)\s+(?:buy(?:ing)?|ape|enter|long|accumulat\w*)|(?:sell(?:ing)?|sold|dump(?:ed|ing)?|exit(?:ed|ing)?|closed?\s+(?:my\s+)?position|short(?:ed|ing)?|scam(?:\s+warning)?|warning|warn(?:ing)?|beware|honeypot|rug(?:ged|ging)?))\b|不要买|别买|勿买|别冲|卖出|卖了|清仓|止损|做空|骗局|诈骗|警告|谨防|貔貅|跑路)/iu;
const CONTRACT = /(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/g;

const cleanHandle = (value) => String(value || "").trim().replace(/^@/, "");
const asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function timestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 10_000_000_000 ? number * 1_000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTweetIds(left, right) {
  try {
    const a = BigInt(String(left || "0"));
    const b = BigInt(String(right || "0"));
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return String(left || "").localeCompare(String(right || ""));
  }
}

function maxTweetId(tweets) {
  return tweets.reduce((latest, tweet) => !latest || compareTweetIds(tweet.id, latest) > 0 ? tweet.id : latest, null);
}

function acceptedDelivery(result) {
  return ["delivered", "queued"].includes(result?.status) || isTerminalAlertSuppression(result);
}

function strictQualification(result, minimumLiquidityUsd) {
  return result?.decision === "pass"
    && result?.security?.decision === "pass"
    && result?.security?.metrics?.liquidityConfirmed === true
    && result?.security?.metrics?.sellObserved === true
    && Number(result?.market?.liquidityUsd || 0) >= minimumLiquidityUsd;
}

/** A post is actionable only when it has one unambiguous EVM address and an explicit call verb. */
export function classifyFomoXCallText(text) {
  const source = String(text || "");
  if (NEGATIVE_CALL_WORDS.test(source)) return { relevant: false, reason: "negative_exit_or_warning_language", token: null };
  if (!FIRST_PERSON_CALL_WORDS.test(source)) return { relevant: false, reason: "missing_first_person_positive_call", token: null };
  const addresses = [...new Set((source.match(CONTRACT) || []).filter(isAddress).map((address) => address.toLowerCase()))];
  if (addresses.length !== 1) {
    return { relevant: false, reason: addresses.length ? "ambiguous_contract_addresses" : "missing_contract_address", token: null };
  }
  return { relevant: true, reason: "explicit_call_with_exact_contract", token: addresses[0] };
}

function admissionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clearHandleRuntimeState(state, key) {
  delete state.initialized[key];
  delete state.cursors[key];
  delete state.transportCircuits?.[`${FX_PROFILE_SOURCE}:${key}`];
  delete state.transportCircuits?.[`${FX_TIMELINE_SOURCE}:${key}`];
  for (const pendingKey of Object.keys(state.pending || {})) {
    if (pendingKey.startsWith(`${key}:`)) delete state.pending[pendingKey];
  }
}

function cleanCandidate(candidate) {
  const handle = cleanHandle(candidate?.handle).toLowerCase();
  const wallet = String(candidate?.wallet || "").trim().toLowerCase();
  const tags = [...new Set((Array.isArray(candidate?.tags) ? candidate.tags : []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
  const wallets = [...new Set((Array.isArray(candidate?.wallets) ? candidate.wallets : wallet ? [wallet] : [])
    .map((value) => String(value || "").trim().toLowerCase()).filter(isAddress))];
  const twitterHandles = [...new Set((Array.isArray(candidate?.twitterHandles) ? candidate.twitterHandles : handle ? [handle] : [])
    .map((value) => cleanHandle(value).toLowerCase()).filter((value) => HANDLE.test(value)))];
  const source = String(candidate?.source || "").trim();
  const inferredOrigin = String(candidate?.origin || candidate?.candidateSource || source || "").trim();
  return {
    ...candidate,
    handle,
    wallet,
    wallets,
    twitterHandles,
    tags,
    source,
    origin: inferredOrigin,
    candidateSource: String(candidate?.candidateSource || inferredOrigin).trim(),
    discoveredAt: timestampMs(candidate?.discoveredAt),
  };
}

/**
 * Admission is independent of trade frequency or volume: only a fresh, clean,
 * one-to-one GMGN wallet/handle observation may enter the X roster.
 */
export function selectFomoXCallCandidates(candidates, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const maximumAgeMs = Math.max(60_000, Number(options.maximumAgeMs || 86_400_000));
  const limit = Math.max(1, Math.min(1_000, Number(options.limit || 500)));
  const normalized = (Array.isArray(candidates) ? candidates : []).map(cleanCandidate);
  const handlesByWallet = new Map();
  for (const candidate of normalized) {
    if (!candidate.wallet) continue;
    if (!handlesByWallet.has(candidate.wallet)) handlesByWallet.set(candidate.wallet, new Set());
    handlesByWallet.get(candidate.wallet).add(candidate.handle);
  }
  return normalized
    .filter((candidate) => HANDLE.test(candidate.handle) && isAddress(candidate.wallet))
    .filter((candidate) => candidate.wallets.length === 1 && candidate.wallets[0] === candidate.wallet)
    .filter((candidate) => candidate.twitterHandles.length === 1 && candidate.twitterHandles[0] === candidate.handle)
    .filter((candidate) => candidate.ambiguousIdentity !== true && candidate.ambiguousWallets !== true && candidate.ambiguousHandles !== true)
    .filter((candidate) => handlesByWallet.get(candidate.wallet)?.size === 1)
    .filter((candidate) => candidate.tags.includes("kol") && candidate.tags.includes("fomo"))
    .filter((candidate) => !candidate.tags.some((tag) => FORBIDDEN_GMGN_TAGS.has(tag)))
    .filter((candidate) => Number.isFinite(candidate.discoveredAt)
      && candidate.discoveredAt <= nowMs + FUTURE_TOLERANCE_MS
      && nowMs - candidate.discoveredAt <= maximumAgeMs)
    .sort((left, right) => right.discoveredAt - left.discoveredAt || left.handle.localeCompare(right.handle))
    .slice(0, limit)
    .map((candidate) => ({
      ...candidate,
      source: GMGN_CANDIDATE_SOURCE,
      origin: GMGN_CANDIDATE_SOURCE,
      candidateSource: GMGN_CANDIDATE_SOURCE,
      fomoTagged: true,
      ambiguousIdentity: false,
    }));
}

function defaultState() {
  return {
    version: STATE_VERSION,
    roster: {},
    initialized: {},
    cursors: {},
    seenTweets: {},
    seenTweetContracts: {},
    alertedTokens: {},
    pending: {},
    transportCircuits: {},
    batchCursor: 0,
    discoveryCheckedAt: null,
    verifiedSeedCheckedAt: null,
    verifiedSeedCursor: 0,
    verifiedSeedFailures: {},
    health: {
      status: "initializing",
      checkedAt: null,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      rosterCount: 0,
      discoveredCandidateCount: 0,
      eligibleCount: 0,
      admittedCount: 0,
      activeCount: 0,
      cachedCount: 0,
      freshCount: 0,
      liveCount: 0,
      backlogCount: 0,
      rejectedCount: 0,
      batchCount: 0,
      coverage: {},
      sources: {},
    },
  };
}

async function readState(file, fsImpl) {
  try {
    const parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      version: STATE_VERSION,
      roster: asObject(parsed.roster),
      initialized: asObject(parsed.initialized),
      cursors: asObject(parsed.cursors),
      seenTweets: asObject(parsed.seenTweets),
      seenTweetContracts: asObject(parsed.seenTweetContracts),
      alertedTokens: asObject(parsed.alertedTokens),
      pending: asObject(parsed.pending),
      transportCircuits: asObject(parsed.transportCircuits),
      verifiedSeedCursor: Math.max(0, Number(parsed.verifiedSeedCursor || 0)),
      verifiedSeedFailures: asObject(parsed.verifiedSeedFailures),
      health: {
        ...defaultState().health,
        ...asObject(parsed.health),
        coverage: asObject(parsed.health?.coverage),
        sources: asObject(parsed.health?.sources),
      },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState();
    throw error;
  }
}

export async function atomicWriteFomoXCallState(file, value, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fsImpl.rename(temporary, file);
  } catch (error) {
    await fsImpl.rm?.(temporary, { force: true }).catch?.(() => {});
    throw error;
  }
}

function pruneState(state, nowMs, maximumAttributionAgeMs, tokenDedupMs, pendingMaxAgeMs) {
  for (const [key, value] of Object.entries(state.roster || {})) {
    if (nowMs - Number(value?.discoveredAt || 0) > maximumAttributionAgeMs) {
      delete state.roster[key];
      clearHandleRuntimeState(state, key);
    }
  }
  for (const field of ["seenTweets", "seenTweetContracts"]) {
    for (const [key, value] of Object.entries(state[field] || {})) {
      const at = Number(typeof value === "object" ? value?.observedAt : value);
      if (!Number.isFinite(at) || nowMs - at > RETENTION_MS) delete state[field][key];
    }
  }
  for (const [key, value] of Object.entries(state.alertedTokens || {})) {
    const at = Number(typeof value === "object" ? value?.observedAt : value);
    if (!Number.isFinite(at) || nowMs - at > tokenDedupMs) delete state.alertedTokens[key];
  }
  for (const [key, value] of Object.entries(state.pending || {})) {
    if (nowMs - Number(value?.firstObservedAt || 0) > pendingMaxAgeMs) delete state.pending[key];
  }
  for (const [key, value] of Object.entries(state.transportCircuits || {})) {
    const handle = cleanHandle(value?.handle).toLowerCase();
    const source = String(value?.source || "");
    if (!state.roster[handle] || key !== `${source}:${handle}`
      || ![FX_PROFILE_SOURCE, FX_TIMELINE_SOURCE].includes(source)) delete state.transportCircuits[key];
  }
}

function transportCircuitKey(source, handle) {
  return `${source}:${cleanHandle(handle).toLowerCase()}`;
}

function summarizeTransportCircuits(state, nowMs) {
  const circuits = Object.entries(state.transportCircuits || {}).flatMap(([key, value]) => {
    const handle = cleanHandle(value?.handle).toLowerCase();
    const source = String(value?.source || "");
    if (!state.roster?.[handle]
      || key !== transportCircuitKey(source, handle)
      || ![FX_PROFILE_SOURCE, FX_TIMELINE_SOURCE].includes(source)) return [];
    const storedRetryAt = Number(value?.nextRetryAt || 0);
    const nextRetryAt = Number.isFinite(storedRetryAt) && storedRetryAt > 0 ? storedRetryAt : nowMs;
    return [{
      source,
      handle,
      reason: String(value?.reason || "transport_circuit_unknown"),
      nextRetryAt,
      state: nextRetryAt > nowMs ? "open" : "probe_due",
    }];
  }).sort((left, right) => left.nextRetryAt - right.nextRetryAt
    || left.handle.localeCompare(right.handle)
    || left.source.localeCompare(right.source));
  const unique = (values) => [...new Set(values)].sort();
  return {
    count: circuits.length,
    open: circuits.filter((circuit) => circuit.state === "open").length,
    probeDue: circuits.filter((circuit) => circuit.state === "probe_due").length,
    handles: unique(circuits.map((circuit) => circuit.handle)),
    reasons: unique(circuits.map((circuit) => circuit.reason)),
    sources: unique(circuits.map((circuit) => circuit.source)),
    nextRetryAt: circuits.length ? new Date(circuits[0].nextRetryAt).toISOString() : null,
  };
}

function parseRetryAfterMs(value, nowMs) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, Math.ceil(seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date) && date > nowMs ? date - nowMs : null;
}

function backoffAt(schedule, failureCount) {
  return schedule[Math.min(schedule.length - 1, Math.max(0, failureCount - 1))];
}

function classifyTransportFailure(source, error, nowMs, failureCount = 1) {
  const status = Number(error?.httpStatus || error?.status || 0);
  if (status === 404) {
    return {
      reason: "http_404",
      delayMs: source === FX_PROFILE_SOURCE ? 6 * HOUR_MS : backoffAt(TRANSPORT_BACKOFFS.timeline404, failureCount),
    };
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(error?.retryAfter, nowMs);
    return {
      reason: "http_429",
      delayMs: retryAfterMs || backoffAt(TRANSPORT_BACKOFFS.timeline404, failureCount),
      retryAfterMs,
    };
  }
  const message = String(error?.message || error || "");
  if (["AbortError", "TimeoutError"].includes(error?.name) || /\b(?:timeout|timed out)\b|aborted/i.test(message)) {
    return { reason: "timeout", delayMs: backoffAt(TRANSPORT_BACKOFFS.timeout, failureCount) };
  }
  if (status >= 500 || status === 408 || status === 425) {
    return { reason: `http_${status}`, delayMs: backoffAt(TRANSPORT_BACKOFFS.transient, failureCount) };
  }
  return { reason: status ? `http_${status}` : "transport_error", delayMs: backoffAt(TRANSPORT_BACKOFFS.other, failureCount) };
}

function requestOptions(timeoutMs, options = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([timeoutSignal, options.signal])
    : options.signal || timeoutSignal;
  return {
    method: options.method || "GET",
    headers: { accept: "application/json", "user-agent": "robinhood-chain-monitor/0.1 (Fomo-linked public X calls)", ...(options.headers || {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), headers: { accept: "application/json", "content-type": "application/json", "user-agent": "robinhood-chain-monitor/0.1 (Fomo-linked public X calls)", ...(options.headers || {}) } }),
    signal,
  };
}

function abortableTask(task, signal) {
  if (!signal) return Promise.resolve(task);
  if (signal.aborted) return Promise.reject(Object.assign(new Error("FomoScan discovery cancelled"), { code: "verified_seed_cancelled" }));
  return Promise.race([
    Promise.resolve(task),
    new Promise((_, reject) => signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("FomoScan discovery cancelled"), { code: "verified_seed_cancelled" }));
    }, { once: true })),
  ]);
}

async function settleBounded(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = { status: "fulfilled", value: await task(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

export function createFomoXCallMonitor(config, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const sendAlert = dependencies.sendAlertsImpl || sendAlerts;
  const qualifyCall = dependencies.qualifyCallImpl || defaultQualifyFomoThesis;
  const discoverCandidates = dependencies.discoverCandidatesImpl || (() => discoverGmgnBscKolCandidates({
    cliPath: config.fomoCallGmgnCliPath || "gmgn-cli",
    limit: config.fomoCallGmgnDiscoveryLimit || 100,
    timeoutMs: config.fomoCallGmgnDiscoveryTimeoutMs || 30_000,
  }));
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const stateFile = path.join(config.dataDir, "fomo-x-call-state.json");
  const fxTwitterBase = String(config.fomoCallFxTwitterApiBase || "https://api.fxtwitter.com").replace(/\/$/, "");
  const fomoScanBase = String(config.fomoScanApiBase || "https://api.fomoscan.sh").replace(/\/$/, "");
  const xOembedBase = String(config.fomoXCallOembedBase || "https://publish.x.com/oembed").replace(/\/$/, "");
  const bscRpcUrl = String(config.fomoCallBscRpcUrl || "https://bsc-rpc.publicnode.com");
  const intervalMs = Math.max(1_000, Number(config.fomoXCallPollIntervalMs || 5_000));
  const discoveryIntervalMs = Math.max(5_000, Number(config.fomoXCallDiscoveryIntervalMs || 60_000));
  const attributionMaxAgeMs = Math.max(60_000, Number(config.fomoXCallAttributionMaxAgeMs || config.fomoCallGmgnAttributionMaxAgeMs || 86_400_000));
  const profileRefreshMs = Math.max(60_000, Number(config.fomoXCallProfileRefreshMs || 1_800_000));
  const identityGraceMs = Math.min(DAY_MS, Math.max(profileRefreshMs, Number(config.fomoXCallIdentityGraceMs || DAY_MS)));
  const verifiedSeedRefreshMs = Math.max(60_000, Number(config.fomoXCallVerifiedSeedRefreshMs || profileRefreshMs));
  const verifiedSeedRetryMs = Math.max(60_000, Number(config.fomoXCallVerifiedSeedRetryMs || 300_000));
  const maximumPostAgeMs = Math.max(60_000, Number(config.fomoXCallMaxPostAgeMs || 300_000));
  const pendingMaxAgeMs = Math.max(maximumPostAgeMs, Number(config.fomoXCallPendingMaxAgeMs || 600_000));
  const admissionRetryMs = Math.max(60_000, Number(config.fomoXCallAdmissionRetryMs || profileRefreshMs));
  const tokenDedupMs = Math.max(60_000, Number(config.fomoXCallTokenDedupMs || RETENTION_MS));
  const minimumFollowers = Math.max(0, Number(config.fomoXCallMinXFollowers ?? 10_000));
  const minimumLiquidityUsd = Math.max(1, Number(config.fomoXCallMinLiquidityUsd || 10_000));
  const candidateLimit = Math.max(1, Math.min(1_000, Number(config.fomoXCallCandidateLimit || 500)));
  const batchSize = Math.max(1, Math.min(50, Number(config.fomoXCallBatchSize || 6)));
  const verifiedSeedBatchSize = Math.max(1, Math.min(50, Number(config.fomoXCallVerifiedSeedBatchSize || batchSize)));
  const concurrency = Math.max(1, Math.min(10, Number(config.fomoXCallConcurrency || 3)));
  const requestTimeoutMs = Math.max(500, Number(config.fomoXCallRequestTimeoutMs || 8_000));
  const verifiedSeedHandles = [...new Set((Array.isArray(config.fomoCallPublicHandles) ? config.fomoCallPublicHandles : [])
    .map((value) => cleanHandle(value).toLowerCase())
    .filter((value) => HANDLE.test(value)))];
  const qualificationConfig = {
    ...config,
    fomoPublishedCallMinXFollowers: minimumFollowers,
    fomoPublishedCallMinLiquidityUsd: minimumLiquidityUsd,
  };
  let state = null;
  let serial = Promise.resolve();
  let writeSerial = Promise.resolve();
  let verifiedSeedDiscovery = null;
  let verifiedSeedAbortController = null;
  let timer = null;
  let started = false;
  let stopped = false;

  const ensureState = async () => {
    if (!state) state = await readState(stateFile, fsImpl);
    return state;
  };

  const persist = (nowMs) => {
    pruneState(state, nowMs, attributionMaxAgeMs, tokenDedupMs, pendingMaxAgeMs);
    const snapshot = structuredClone(state);
    const current = writeSerial.catch(() => {}).then(() => atomicWriteFomoXCallState(stateFile, snapshot, fsImpl));
    writeSerial = current.catch(() => {});
    return current;
  };

  function hasExactCandidateIdentity(candidate) {
    return HANDLE.test(String(candidate?.handle || ""))
      && isAddress(String(candidate?.wallet || ""))
      && Array.isArray(candidate?.wallets) && candidate.wallets.length === 1 && candidate.wallets[0] === candidate.wallet
      && Array.isArray(candidate?.twitterHandles) && candidate.twitterHandles.length === 1 && candidate.twitterHandles[0] === candidate.handle
      && candidate?.ambiguousIdentity !== true && candidate?.ambiguousWallets !== true && candidate?.ambiguousHandles !== true;
  }

  function freshVerifiedBinding(candidate, binding, nowMs) {
    const checkedAtMs = Date.parse(binding?.checkedAt || binding?.lastCheckedAt || "");
    return binding?.status === "verified" && binding?.verified === true && binding?.proofSource === "fomoscan"
      && String(binding?.wallet || "").toLowerCase() === candidate.wallet
      && cleanHandle(binding?.handle || binding?.twitterHandle).toLowerCase() === candidate.handle
      && Number.isFinite(checkedAtMs) && checkedAtMs <= nowMs + FUTURE_TOLERANCE_MS
      && nowMs - checkedAtMs <= attributionMaxAgeMs;
  }

  function freshCachedProfile(candidate, profile, nowMs) {
    const checkedAtMs = Date.parse(profile?.checkedAt || "");
    return /^\d+$/.test(String(profile?.id || ""))
      && cleanHandle(profile?.handle).toLowerCase() === candidate.handle
      && profile?.protected !== true
      && Number(profile?.followers || 0) >= minimumFollowers
      && Number.isFinite(checkedAtMs) && checkedAtMs <= nowMs + FUTURE_TOLERANCE_MS
      && nowMs - checkedAtMs <= identityGraceMs;
  }

  function freshCachedBscActivity(activity, nowMs) {
    const checkedAtMs = Date.parse(activity?.checkedAt || "");
    return Number.isSafeInteger(Number(activity?.count)) && Number(activity.count) > 0
      && Number.isFinite(checkedAtMs) && checkedAtMs <= nowMs + FUTURE_TOLERANCE_MS
      && nowMs - checkedAtMs <= identityGraceMs;
  }

  function freshCandidateEvidence(candidate, nowMs) {
    if (!hasExactCandidateIdentity(candidate)) return false;
    const discoveredAt = Number(candidate?.discoveredAt);
    if (!Number.isFinite(discoveredAt) || discoveredAt > nowMs + FUTURE_TOLERANCE_MS
      || nowMs - discoveredAt > Math.min(attributionMaxAgeMs, identityGraceMs)) return false;
    if (candidate.source === FOMOSCAN_SEED_SOURCE) {
      const checkedAtMs = Date.parse(candidate?.walletBinding?.checkedAt || candidate?.walletBinding?.lastCheckedAt || "");
      return freshVerifiedBinding(candidate, candidate.walletBinding, nowMs)
        && Number.isFinite(checkedAtMs) && nowMs - checkedAtMs <= identityGraceMs;
    }
    return candidate.source === GMGN_CANDIDATE_SOURCE
      && candidate.origin === GMGN_CANDIDATE_SOURCE
      && candidate.candidateSource === GMGN_CANDIDATE_SOURCE
      && candidate.fomoTagged === true && candidate.ambiguousIdentity === false;
  }

  function hasFreshCachedIdentity(candidate, stored, nowMs) {
    return freshCachedProfile(candidate, stored?.xProfile, nowMs)
      && freshCachedBscActivity(stored?.bscActivity, nowMs)
      && freshCandidateEvidence(candidate, nowMs)
      && Number(stored?.admissionRejectedUntil || 0) <= nowMs;
  }

  function isTransientProfileReason(reason) {
    return reason === "timeout" || reason === "http_429" || /^http_5\d\d$/.test(String(reason || ""));
  }

  function isTransientBindingRefreshError(error) {
    const message = String(error?.message || error || "");
    const statusFromMessage = Number(message.match(/(?:^|\b)(?:HTTP\s*)?(\d{3})(?:\b|$)/i)?.[1] || 0);
    const status = Number(error?.httpStatus || error?.status || statusFromMessage || 0);
    return status === 429 || status >= 500 && status <= 599
      || ["AbortError", "TimeoutError"].includes(error?.name)
      || /\b(?:timeout|timed out)\b|aborted/i.test(message);
  }

  function migrateFreshSeedBinding(candidate, nowMs) {
    if (candidate?.source !== FOMOSCAN_SEED_SOURCE
      || (candidate?.origin && candidate.origin !== FOMOSCAN_SEED_SOURCE)
      || (candidate?.candidateSource && candidate.candidateSource !== FOMOSCAN_SEED_SOURCE)
      || !hasExactCandidateIdentity(candidate)
      || candidate.ambiguousIdentity !== false || candidate.ambiguousWallets !== false || candidate.ambiguousHandles !== false
      || !candidate.tags.includes("kol") || !candidate.tags.includes("fomo")
      || candidate.tags.some((tag) => FORBIDDEN_GMGN_TAGS.has(tag))) return null;
    const discoveredAt = Number(candidate.discoveredAt);
    if (!Number.isFinite(discoveredAt) || discoveredAt > nowMs + FUTURE_TOLERANCE_MS
      || nowMs - discoveredAt > attributionMaxAgeMs) return null;
    const checkedAt = new Date(discoveredAt).toISOString();
    const migrated = {
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      wallet: candidate.wallet,
      handle: candidate.handle,
      twitterHandle: candidate.handle,
      checkedAt,
      lastCheckedAt: checkedAt,
      cacheMigrated: true,
    };
    candidate.walletBinding = migrated;
    candidate.origin = FOMOSCAN_SEED_SOURCE;
    candidate.candidateSource = FOMOSCAN_SEED_SOURCE;
    return migrated;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, requestOptions(requestTimeoutMs, options));
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${new URL(url).hostname}`);
      error.httpStatus = Number(response.status || 0);
      error.retryAfter = response.headers?.get?.("retry-after") || null;
      throw error;
    }
    return response.json();
  }

  async function fetchWithTransportCircuit(source, handle, task) {
    const key = transportCircuitKey(source, handle);
    const nowMs = now();
    const previous = state.transportCircuits[key];
    if (Number(previous?.nextRetryAt || 0) > nowMs) {
      const error = new Error(`${source} @${handle} circuit open until ${new Date(previous.nextRetryAt).toISOString()}`);
      error.code = "transport_circuit_open";
      error.transportCircuit = previous;
      throw error;
    }
    try {
      const result = await task();
      if (previous) {
        delete state.transportCircuits[key];
        logger.info?.(`[fomo-x-call][transport] ${source} @${handle} recovered; circuit cleared`);
      }
      return result;
    } catch (error) {
      if (error?.code === "transport_circuit_open") throw error;
      const failureCount = Number(previous?.failureCount || 0) + 1;
      const classified = classifyTransportFailure(source, error, nowMs, failureCount);
      const nextRetryAt = nowMs + classified.delayMs;
      const control = {
        status: "open",
        source,
        handle: cleanHandle(handle).toLowerCase(),
        reason: classified.reason,
        failureCount,
        lastFailureAt: nowMs,
        nextRetryAt,
        lastError: String(error?.message || error).slice(0, 180),
        ...(classified.retryAfterMs ? { retryAfterMs: classified.retryAfterMs } : {}),
      };
      state.transportCircuits[key] = control;
      logger.warn?.(`[fomo-x-call][transport] ${source} @${handle} ${classified.reason}; circuit open until ${new Date(nextRetryAt).toISOString()}`);
      const circuitError = new Error(String(error?.message || error), { cause: error });
      circuitError.code = "transport_circuit_opened";
      circuitError.transportCircuit = control;
      throw circuitError;
    }
  }

  function transportBackoffResult(error) {
    if (!["transport_circuit_open", "transport_circuit_opened"].includes(error?.code)) return null;
    return {
      status: "transport_backoff",
      transportFailure: true,
      circuitOpen: error.code === "transport_circuit_open",
      reason: error?.transportCircuit?.reason || "transport_circuit_open",
      source: error?.transportCircuit?.source || null,
      handle: error?.transportCircuit?.handle || null,
      nextRetryAt: Number(error?.transportCircuit?.nextRetryAt || 0) || null,
    };
  }

  async function fetchXProfile(handle) {
    const payload = await fetchWithTransportCircuit(FX_PROFILE_SOURCE, handle,
      () => fetchJson(`${fxTwitterBase}/2/profile/${encodeURIComponent(handle)}`));
    const parsed = parseFxTwitterProfile(payload, handle);
    if (!parsed) throw admissionError(`@${handle} FxTwitter profile schema or handle/id mismatch`, "ineligible_x_profile");
    if (!/^\d+$/.test(String(parsed.id || "")) || parsed.protected === true || parsed.followers < minimumFollowers) {
      throw admissionError(`@${handle} failed numeric X identity or ${minimumFollowers}+ follower gate`, "ineligible_x_profile");
    }
    return { ...parsed, checkedAt: new Date(now()).toISOString() };
  }

  async function fetchBscActivity(wallet) {
    if (dependencies.getBscActivityImpl) return dependencies.getBscActivityImpl(wallet);
    const payload = await fetchJson(bscRpcUrl, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [wallet, "latest"] },
    });
    if (payload?.error || !/^0x[0-9a-f]+$/i.test(String(payload?.result || ""))) throw new Error("invalid BSC activity response");
    return Number(BigInt(payload.result));
  }

  async function resolveVerifiedBinding(candidate) {
    if (dependencies.resolveVerifiedBindingImpl) return dependencies.resolveVerifiedBindingImpl(candidate);
    const cachedCheckedAt = Date.parse(candidate?.walletBinding?.checkedAt || candidate?.walletBinding?.lastCheckedAt || "");
    if (candidate?.walletBinding?.status === "verified" && candidate?.walletBinding?.verified === true
      && candidate?.walletBinding?.proofSource === "fomoscan"
      && String(candidate.walletBinding.wallet || "").toLowerCase() === candidate.wallet
      && String(candidate.walletBinding.handle || candidate.walletBinding.twitterHandle || "").toLowerCase() === candidate.handle
      && Number.isFinite(cachedCheckedAt) && now() - cachedCheckedAt < verifiedSeedRefreshMs) {
      return candidate.walletBinding;
    }
    const parsed = parseFomoScanProfile(await fetchJson(`${fomoScanBase}/get-user/${encodeURIComponent(candidate.handle)}`), candidate.handle);
    if (!parsed || parsed.walletBinding?.status !== "verified" || parsed.walletBinding?.verified !== true
      || parsed.walletBinding?.proofSource !== "fomoscan"
      || String(parsed.baseAddress || "").toLowerCase() !== candidate.wallet
      || String(parsed.twitterHandle || "").toLowerCase() !== candidate.handle) return null;
    const checkedAt = new Date(now()).toISOString();
    return {
      ...parsed.walletBinding,
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      wallet: candidate.wallet,
      handle: candidate.handle,
      twitterHandle: candidate.handle,
      checkedAt,
      lastCheckedAt: checkedAt,
    };
  }

  async function fetchTimeline(profile) {
    const url = `${fxTwitterBase}/2/profile/id:${encodeURIComponent(profile.id)}/statuses?count=40`;
    const payload = await fetchWithTransportCircuit(FX_TIMELINE_SOURCE, profile.handle, () => fetchJson(url));
    return parseFxTwitterTimeline(payload, profile.handle, profile.id);
  }

  async function verifyOfficialPost(tweet, handle) {
    const requested = `https://x.com/${handle}/status/${tweet.id}`;
    const url = `${xOembedBase}?omit_script=true&dnt=true&url=${encodeURIComponent(requested)}`;
    const response = await fetchImpl(url, requestOptions(requestTimeoutMs));
    if (!response.ok) throw new Error(`official X oEmbed HTTP ${response.status}`);
    const payload = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
    const text = parseOfficialXOembed(payload, handle, tweet.id);
    return { ...tweet, text, url: requested, sourceVerifiedBy: "official_x_oembed" };
  }

  async function refreshGmgnDiscovery(nowMs) {
    const previousCheck = Date.parse(state.discoveryCheckedAt || "");
    if (Number.isFinite(previousCheck) && nowMs - previousCheck < discoveryIntervalMs) return state.health.sources.gmgn?.status || "healthy";
    try {
      const discovered = await discoverCandidates();
      const selected = selectFomoXCallCandidates(discovered, {
        nowMs,
        maximumAgeMs: attributionMaxAgeMs,
        limit: candidateLimit,
      });
      const discoveredHandles = new Set((Array.isArray(discovered) ? discovered : [])
        .map((candidate) => cleanHandle(candidate?.handle).toLowerCase())
        .filter((handle) => HANDLE.test(handle)));
      const selectedByHandle = new Map(selected.map((candidate) => [candidate.handle.toLowerCase(), candidate]));
      // A clean GMGN observation of the same wallet under a new unique handle is a
      // handle migration. Drop the old runtime completely so the new timeline is
      // silently baselined and no pre-migration post can be replayed.
      for (const candidate of selected) {
        for (const [oldKey, previous] of Object.entries(state.roster || {})) {
          if (oldKey === candidate.handle || previous?.source !== GMGN_CANDIDATE_SOURCE) continue;
          if (String(previous.wallet || "").toLowerCase() !== candidate.wallet) continue;
          delete state.roster[oldKey];
          clearHandleRuntimeState(state, oldKey);
        }
      }
      for (const [key, previous] of Object.entries(state.roster || {})) {
        if (previous?.source === GMGN_CANDIDATE_SOURCE && discoveredHandles.has(key) && !selectedByHandle.has(key)) {
          delete state.roster[key];
          clearHandleRuntimeState(state, key);
        } else if (previous?.source === FOMOSCAN_SEED_SOURCE && discoveredHandles.has(key) && !selectedByHandle.has(key)) {
          delete previous.gmgnCandidate;
        }
      }
      for (const candidate of selected) {
        const key = candidate.handle.toLowerCase();
        const previous = state.roster[key] || {};
        if (previous.source === FOMOSCAN_SEED_SOURCE) {
          previous.gmgnCandidate = candidate;
          continue;
        }
        const sameWallet = String(previous.wallet || "").toLowerCase() === candidate.wallet;
        if (!sameWallet && previous.wallet) clearHandleRuntimeState(state, key);
        state.roster[key] = {
          ...(sameWallet ? previous : {}),
          ...candidate,
          firstSeenAt: sameWallet ? previous.firstSeenAt || nowMs : nowMs,
          lastSeenAt: nowMs,
        };
      }
      state.discoveryCheckedAt = new Date(nowMs).toISOString();
      state.health.sources.gmgn = {
        status: "healthy",
        checkedAt: state.discoveryCheckedAt,
        discovered: Array.isArray(discovered) ? discovered.length : 0,
        cleanCandidates: selected.length,
      };
      return state.health.sources.gmgn.status;
    } catch (error) {
      state.discoveryCheckedAt = new Date(nowMs).toISOString();
      state.health.sources.gmgn = { status: "error", checkedAt: state.discoveryCheckedAt, error: String(error?.message || error).slice(0, 180) };
      return "error";
    }
  }

  async function fetchVerifiedSeed(handle, nowMs, signal) {
    const response = await fetchImpl(`${fomoScanBase}/get-user/${encodeURIComponent(handle)}`, requestOptions(requestTimeoutMs, { signal }));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${new URL(fomoScanBase).hostname}`);
    const parsed = parseFomoScanProfile(await response.json(), handle);
    const parsedHandle = cleanHandle(parsed?.twitterHandle).toLowerCase();
    const wallet = String(parsed?.baseAddress || "").toLowerCase();
    if (!parsed || parsed.walletBinding?.status !== "verified" || parsed.walletBinding?.verified !== true
      || parsed.walletBinding?.proofSource !== "fomoscan" || parsedHandle !== handle || !isAddress(wallet)) return null;
    const checkedAt = new Date(nowMs).toISOString();
    return cleanCandidate({
      handle,
      wallet,
      wallets: [wallet],
      twitterHandles: [handle],
      ambiguousWallets: false,
      ambiguousHandles: false,
      ambiguousIdentity: false,
      tags: ["kol", "fomo"],
      source: "fomoscan_verified_profile",
      origin: FOMOSCAN_SEED_SOURCE,
      candidateSource: FOMOSCAN_SEED_SOURCE,
      discoveredAt: nowMs,
      walletBinding: {
        ...parsed.walletBinding,
        status: "verified",
        verified: true,
        proofSource: "fomoscan",
        wallet,
        handle,
        twitterHandle: handle,
        checkedAt,
        lastCheckedAt: checkedAt,
      },
      verifiedSeedEvidence: { source: "fomoscan_get_user", checkedAt },
    });
  }

  function verifiedSeedRefreshPlan(nowMs) {
    if (!verifiedSeedHandles.length) {
      state.health.sources.fomoscanSeeds = {
        status: "disabled_no_handles",
        checkedAt: new Date(nowMs).toISOString(),
        configured: 0,
        queried: 0,
        verified: 0,
        inFlight: false,
        backlog: 0,
      };
      return null;
    }
    const previousCheck = Date.parse(state.verifiedSeedCheckedAt || "");
    const fullRefreshDue = !Number.isFinite(previousCheck) || nowMs - previousCheck >= verifiedSeedRefreshMs;
    const failedHandles = Object.keys(state.verifiedSeedFailures || {})
      .filter((handle) => verifiedSeedHandles.includes(handle));
    const failedHandlesDue = Object.entries(state.verifiedSeedFailures || {})
      .filter(([handle, value]) => verifiedSeedHandles.includes(handle) && Number(value?.nextRetryAt || 0) <= nowMs)
      .map(([handle]) => handle)
      .sort();
    if (fullRefreshDue) {
      const start = Math.max(0, Number(state.verifiedSeedCursor || 0)) % verifiedSeedHandles.length;
      const queriedHandles = verifiedSeedHandles.slice(start, start + verifiedSeedBatchSize);
      const nextCursor = start + queriedHandles.length;
      return {
        mode: "full_sweep",
        queriedHandles,
        start,
        nextCursor: nextCursor >= verifiedSeedHandles.length ? 0 : nextCursor,
        fullSweepComplete: nextCursor >= verifiedSeedHandles.length,
        backlogAfter: Math.max(0, verifiedSeedHandles.length - nextCursor),
        backlogBefore: new Set([...verifiedSeedHandles.slice(start), ...failedHandles]).size,
      };
    }
    if (!failedHandlesDue.length) return null;
    const queriedHandles = failedHandlesDue.slice(0, verifiedSeedBatchSize);
    return {
      mode: "retry",
      queriedHandles,
      start: null,
      nextCursor: Number(state.verifiedSeedCursor || 0),
      fullSweepComplete: false,
      backlogAfter: Math.max(0, failedHandlesDue.length - queriedHandles.length),
      backlogBefore: failedHandles.length,
    };
  }

  async function refreshVerifiedSeeds(nowMs, plan, signal) {
    const queriedHandles = plan.queriedHandles;
    const results = await settleBounded(queriedHandles, concurrency, async (handle) => {
      const task = dependencies.discoverVerifiedSeedImpl
        ? dependencies.discoverVerifiedSeedImpl(handle, nowMs, { signal })
        : fetchVerifiedSeed(handle, nowMs, signal);
      return abortableTask(task, signal);
    });
    if (signal?.aborted) throw Object.assign(new Error("FomoScan discovery cancelled"), { code: "verified_seed_cancelled" });
    let verified = 0;
    let absent = 0;
    let failures = 0;
    for (let index = 0; index < results.length; index += 1) {
      const handle = queriedHandles[index];
      const result = results[index];
      if (result.status === "rejected") {
        failures += 1;
        state.verifiedSeedFailures[handle] = {
          lastErrorAt: nowMs,
          nextRetryAt: nowMs + verifiedSeedRetryMs,
          error: String(result.reason?.message || result.reason).slice(0, 160),
        };
        continue;
      }
      delete state.verifiedSeedFailures[handle];
      const candidate = result.value ? cleanCandidate(result.value) : null;
      if (candidate?.source === FOMOSCAN_SEED_SOURCE) {
        candidate.origin = FOMOSCAN_SEED_SOURCE;
        candidate.candidateSource = FOMOSCAN_SEED_SOURCE;
      }
      const binding = candidate && freshVerifiedBinding(candidate, candidate.walletBinding, nowMs)
        ? candidate.walletBinding : null;
      if (!candidate || candidate.handle !== handle || !isAddress(candidate.wallet)
        || candidate.source !== FOMOSCAN_SEED_SOURCE || !hasExactCandidateIdentity(candidate) || !binding) {
        absent += 1;
        const previous = state.roster[handle];
        if (previous?.source === FOMOSCAN_SEED_SOURCE) {
          delete state.roster[handle];
          clearHandleRuntimeState(state, handle);
        }
        continue;
      }
      verified += 1;
      const previous = state.roster[handle] || {};
      const sameWallet = String(previous.wallet || "").toLowerCase() === candidate.wallet;
      if (!sameWallet && previous.wallet) clearHandleRuntimeState(state, handle);
      state.roster[handle] = {
        ...(sameWallet ? previous : {}),
        ...candidate,
        gmgnCandidate: previous.gmgnCandidate,
        firstSeenAt: sameWallet ? previous.firstSeenAt || nowMs : nowMs,
        lastSeenAt: nowMs,
      };
    }
    if (plan.mode === "full_sweep") {
      state.verifiedSeedCursor = plan.nextCursor;
      if (plan.fullSweepComplete) state.verifiedSeedCheckedAt = new Date(nowMs).toISOString();
    }
    for (const handle of Object.keys(state.verifiedSeedFailures)) {
      if (!verifiedSeedHandles.includes(handle)) delete state.verifiedSeedFailures[handle];
    }
    const outstandingFailureHandles = Object.keys(state.verifiedSeedFailures);
    const outstandingFailures = outstandingFailureHandles.length;
    const totalVerified = Object.values(state.roster || {}).filter((entry) => entry?.source === FOMOSCAN_SEED_SOURCE
      && freshVerifiedBinding(entry, entry.walletBinding, nowMs)).length;
    const unvisitedHandles = plan.mode === "full_sweep" && !plan.fullSweepComplete
      ? verifiedSeedHandles.slice(plan.nextCursor) : [];
    const discoveryBacklog = new Set([...unvisitedHandles, ...outstandingFailureHandles]).size;
    const status = outstandingFailures ? (totalVerified || failures < results.length ? "partial" : "error")
      : plan.backlogAfter ? "partial" : "healthy";
    const checkedAt = new Date(nowMs).toISOString();
    state.health.sources.fomoscanSeeds = {
      status,
      checkedAt,
      fullCheckedAt: state.verifiedSeedCheckedAt,
      configured: verifiedSeedHandles.length,
      queried: queriedHandles.length,
      mode: plan.mode,
      cursor: state.verifiedSeedCursor,
      verified: totalVerified,
      verifiedThisCheck: verified,
      absent,
      failures: outstandingFailures,
      failuresThisCheck: failures,
      inFlight: false,
      backlog: discoveryBacklog,
    };
    return status;
  }

  function scheduleVerifiedSeedRefresh(nowMs) {
    if (stopped) return "stopped";
    if (verifiedSeedDiscovery) {
      state.health.sources.fomoscanSeeds = {
        ...state.health.sources.fomoscanSeeds,
        inFlight: true,
      };
      return "in_flight";
    }
    const plan = verifiedSeedRefreshPlan(nowMs);
    if (!plan) return state.health.sources.fomoscanSeeds?.status || "healthy";
    state.health.sources.fomoscanSeeds = {
      ...state.health.sources.fomoscanSeeds,
      status: state.health.sources.fomoscanSeeds?.status || "checking",
      checkedAt: new Date(nowMs).toISOString(),
      configured: verifiedSeedHandles.length,
      queried: plan.queriedHandles.length,
      mode: plan.mode,
      cursor: Number(state.verifiedSeedCursor || 0),
      inFlight: true,
      backlog: plan.backlogBefore,
    };
    const controller = new AbortController();
    verifiedSeedAbortController = controller;
    const task = (async () => {
      try {
        const status = await refreshVerifiedSeeds(nowMs, plan, controller.signal);
        await persist(now());
        return status;
      } catch (error) {
        const checkedAt = new Date(now()).toISOString();
        if (error?.code === "verified_seed_cancelled") {
          state.health.sources.fomoscanSeeds = {
            ...state.health.sources.fomoscanSeeds,
            status: "stopped",
            checkedAt,
            inFlight: false,
          };
          await persist(now()).catch(() => {});
          return "stopped";
        }
        state.health.sources.fomoscanSeeds = {
          ...state.health.sources.fomoscanSeeds,
          status: "error",
          checkedAt,
          inFlight: false,
          backlog: Math.max(1, Number(state.health.sources.fomoscanSeeds?.backlog || plan.queriedHandles.length)),
          error: String(error?.message || error).slice(0, 180),
        };
        logger.error?.(`[fomo-x-call] FomoScan seed discovery: ${error?.message || error}`);
        await persist(now()).catch(() => {});
        return "error";
      }
    })();
    verifiedSeedDiscovery = task.finally(() => {
      if (verifiedSeedAbortController === controller) verifiedSeedAbortController = null;
      verifiedSeedDiscovery = null;
    });
    verifiedSeedDiscovery.catch(() => {});
    return "scheduled";
  }

  async function refreshDiscovery(nowMs) {
    const gmgn = await refreshGmgnDiscovery(nowMs);
    const fomoscanSeeds = scheduleVerifiedSeedRefresh(nowMs);
    return { gmgn, fomoscanSeeds };
  }

  function eligibleRoster(nowMs) {
    return Object.values(state.roster || {})
      .filter((candidate) => Number.isFinite(Number(candidate.discoveredAt))
        && Number(candidate.discoveredAt) <= nowMs + FUTURE_TOLERANCE_MS
        && nowMs - Number(candidate.discoveredAt) <= attributionMaxAgeMs)
      .filter((candidate) => {
        if (!hasExactCandidateIdentity(candidate)) return false;
        if (candidate.source === FOMOSCAN_SEED_SOURCE) {
          const binding = freshVerifiedBinding(candidate, candidate.walletBinding, nowMs)
            ? candidate.walletBinding : migrateFreshSeedBinding(candidate, nowMs);
          return Boolean(binding);
        }
        return candidate.source === GMGN_CANDIDATE_SOURCE
          && candidate.origin === GMGN_CANDIDATE_SOURCE
          && candidate.candidateSource === GMGN_CANDIDATE_SOURCE
          && candidate.fomoTagged === true
          && candidate.ambiguousIdentity === false
          && candidate.tags.includes("kol") && candidate.tags.includes("fomo")
          && !candidate.tags.some((tag) => FORBIDDEN_GMGN_TAGS.has(tag));
      })
      .sort((left, right) => Number(right.discoveredAt) - Number(left.discoveredAt) || left.handle.localeCompare(right.handle));
  }

  function selectBatch(roster) {
    if (!roster.length) return [];
    const start = Math.max(0, Number(state.batchCursor || 0)) % roster.length;
    const count = Math.min(batchSize, roster.length);
    const selected = Array.from({ length: count }, (_, index) => roster[(start + index) % roster.length]);
    state.batchCursor = (start + count) % roster.length;
    return selected;
  }

  function summarizeEffectiveCoverage(roster, nowMs) {
    const uniqueRoster = [...new Map(roster.map((candidate) => [candidate.handle.toLowerCase(), candidate])).values()];
    const rotationMs = intervalMs * Math.max(1, Math.ceil(uniqueRoster.length / batchSize));
    const timelineFreshnessMs = Math.max(MINUTE_MS, rotationMs * 3);
    const cachedHandles = [];
    const freshHandles = [];
    const liveHandles = [];
    const backlogHandles = [];
    const profileFallbackHandles = [];
    const effectiveCircuitHandles = [];
    const reasonsByHandle = {};
    const reasonCounts = {};
    for (const candidate of uniqueRoster) {
      const handle = candidate.handle.toLowerCase();
      const stored = state.roster[handle] || candidate;
      const reasons = [];
      const profile = stored.xProfile;
      const profileAt = Date.parse(profile?.checkedAt || "");
      const bscAt = Date.parse(stored.bscActivity?.checkedAt || "");
      const cached = /^\d+$/.test(String(profile?.id || ""))
        && cleanHandle(profile?.handle).toLowerCase() === handle
        && profile?.protected !== true
        && Number(profile?.followers || 0) >= minimumFollowers
        && Number(stored.bscActivity?.count || 0) > 0
        && Number(stored.admissionRejectedUntil || 0) <= nowMs;
      if (cached) cachedHandles.push(handle);
      else if (Number(stored.admissionRejectedUntil || 0) > nowMs) reasons.push("admission_rejected");
      else if (!/^\d+$/.test(String(profile?.id || ""))) reasons.push("profile_missing_or_non_numeric");
      else if (cleanHandle(profile?.handle).toLowerCase() !== handle || profile?.protected === true
        || Number(profile?.followers || 0) < minimumFollowers) reasons.push("profile_identity_gate");
      else if (!(Number(stored.bscActivity?.count || 0) > 0)) reasons.push("bsc_identity_missing");

      const fresh = cached && hasFreshCachedIdentity(candidate, stored, nowMs);
      if (fresh) freshHandles.push(handle);
      else if (cached) {
        if (!Number.isFinite(profileAt) || nowMs - profileAt > identityGraceMs) reasons.push("profile_cache_stale");
        if (!Number.isFinite(bscAt) || nowMs - bscAt > identityGraceMs) reasons.push("bsc_identity_stale");
        if (!freshCandidateEvidence(candidate, nowMs)) reasons.push("wallet_identity_stale");
      }

      const profileCircuit = state.transportCircuits[transportCircuitKey(FX_PROFILE_SOURCE, handle)];
      const timelineCircuit = state.transportCircuits[transportCircuitKey(FX_TIMELINE_SOURCE, handle)];
      const cachedFallback = Boolean(profileCircuit && fresh && isTransientProfileReason(profileCircuit.reason));
      if (cachedFallback) profileFallbackHandles.push(handle);
      const effectiveProfileCircuit = Boolean(profileCircuit && !cachedFallback);
      if (effectiveProfileCircuit) reasons.push(`profile_${profileCircuit.reason || "transport_error"}`);
      if (timelineCircuit) reasons.push(`timeline_${timelineCircuit.reason || "transport_error"}`);
      if (effectiveProfileCircuit || timelineCircuit) effectiveCircuitHandles.push(handle);

      const lastTimelineSuccessAt = Date.parse(stored.timelineHealth?.lastSuccessAt || "");
      const timelineFresh = Number.isFinite(lastTimelineSuccessAt)
        && lastTimelineSuccessAt <= nowMs + FUTURE_TOLERANCE_MS
        && nowMs - lastTimelineSuccessAt <= timelineFreshnessMs;
      if (!timelineFresh) {
        reasons.push(Number.isFinite(lastTimelineSuccessAt) ? "timeline_stale" : "timeline_never_succeeded");
      }
      const timelineFailedAfterSuccess = stored.timelineHealth?.status === "error"
        && Date.parse(stored.timelineHealth?.checkedAt || "") >= lastTimelineSuccessAt;
      if (timelineFailedAfterSuccess && !timelineCircuit) reasons.push("timeline_latest_check_failed");
      const live = fresh && timelineFresh && !effectiveProfileCircuit && !timelineCircuit && !timelineFailedAfterSuccess;
      if (live) liveHandles.push(handle);
      else backlogHandles.push(handle);
      const uniqueReasons = [...new Set(reasons)];
      if (uniqueReasons.length) reasonsByHandle[handle] = uniqueReasons;
      for (const reason of uniqueReasons) reasonCounts[reason] = Number(reasonCounts[reason] || 0) + 1;
    }
    return {
      eligibleCount: uniqueRoster.length,
      cachedCount: cachedHandles.length,
      freshCount: freshHandles.length,
      liveCount: liveHandles.length,
      backlogCount: backlogHandles.length,
      cachedHandles,
      freshHandles,
      liveHandles,
      backlogHandles,
      profileFallbackHandles,
      effectiveCircuitHandles: [...new Set(effectiveCircuitHandles)].sort(),
      reasonsByHandle,
      reasonCounts,
      timelineFreshnessMs,
    };
  }

  function effectiveCoverageError(coverage, seedBacklog = 0, batchFailure = null) {
    const topReasons = Object.entries(coverage.reasonCounts || {})
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 4)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(",");
    const detail = `X effective coverage limited: ${coverage.liveCount}/${coverage.eligibleCount}; cached=${coverage.cachedCount}; fresh=${coverage.freshCount}; backlog=${coverage.backlogCount}${seedBacklog ? `; seedBacklog=${seedBacklog}` : ""}${topReasons ? `; reasons=${topReasons}` : ""}`;
    return `${detail}${batchFailure ? `; batch=${batchFailure}` : ""}`.slice(0, 180);
  }

  function markSeen(key, nowMs) {
    state.seenTweets[key] = nowMs;
    delete state.pending[key];
  }

  function markPending(key, token, reason, nowMs, tweet) {
    const previous = state.pending[key] || {};
    state.pending[key] = {
      firstObservedAt: previous.firstObservedAt || nowMs,
      lastAttemptAt: nowMs,
      token,
      reason: String(reason || "qualification_pending").slice(0, 160),
      tweet: tweet ? {
        id: String(tweet.id || ""),
        text: String(tweet.text || ""),
        createdAt: tweet.createdAt || null,
        url: tweet.url || null,
        handle: tweet.handle || null,
        xUserId: tweet.xUserId || tweet.authorId || null,
        authorId: tweet.authorId || tweet.xUserId || null,
        isReply: tweet.isReply === true,
      } : previous.tweet || null,
    };
  }

  function identityFields(candidate, profile, bscActivity, binding, nowMs) {
    const checkedAt = profile.checkedAt;
    if (freshVerifiedBinding(candidate, binding, nowMs)) {
      return {
        identityLink: { state: "verified_wallet", source: "fomoscan+fxtwitter" },
        walletBinding: {
          ...binding,
          status: "verified",
          verified: true,
          proofSource: "fomoscan",
          wallet: candidate.wallet,
          handle: candidate.handle,
          twitterHandle: candidate.handle,
          xProfileId: profile.id,
        },
      };
    }
    if (candidate.source !== GMGN_CANDIDATE_SOURCE || candidate.origin !== GMGN_CANDIDATE_SOURCE
      || candidate.candidateSource !== GMGN_CANDIDATE_SOURCE || candidate.fomoTagged !== true
      || candidate.ambiguousIdentity !== false || !hasExactCandidateIdentity(candidate)) {
      throw new Error("identity source is neither a fresh FomoScan binding nor an exact GMGN observation");
    }
    return {
      identityLink: { state: "observed_wallet", source: "gmgn+fxtwitter" },
      walletBinding: null,
      walletAttribution: {
        scheme: "gmgn_x_maker_observation_v1",
        status: "observed",
        verified: false,
        source: GMGN_CANDIDATE_SOURCE,
        candidateSource: GMGN_CANDIDATE_SOURCE,
        origin: GMGN_CANDIDATE_SOURCE,
        monitoringWallet: candidate.wallet,
        xHandle: candidate.handle,
        xProfileId: profile.id,
        tags: candidate.tags,
        fomoTagged: true,
        ambiguousIdentity: false,
        ambiguousWallets: false,
        ambiguousHandles: false,
        observedAt: new Date(candidate.discoveredAt).toISOString(),
        xFollowersCheckedAt: checkedAt,
        bscActivityCheckedAt: bscActivity.checkedAt,
        bscTransactionCount: bscActivity.count,
      },
    };
  }

  function buildEvent(candidate, profile, bscActivity, binding, tweet, token, qualification, observedAt) {
    const identity = identityFields(candidate, profile, bscActivity, binding, observedAt);
    const caller = {
      handle: candidate.handle,
      twitter: `https://x.com/${candidate.handle}`,
      xProfileId: profile.id,
      followers: profile.followers,
      followersSyncedAt: profile.checkedAt,
      identitySource: binding ? "fomoscan+fxtwitter" : "gmgn+fxtwitter",
      bscTransactionCount: bscActivity.count,
      bscActivityCheckedAt: bscActivity.checkedAt,
    };
    const publishedAt = tweet.createdAt;
    return {
      type: "fomo_family_top_call",
      signalKind: "fomo_x_call",
      eventKey: `fomo-x-call:${tweet.id}:${token}`,
      callId: tweet.id,
      stableId: tweet.id,
      qualified: true,
      strong: true,
      official: false,
      fomoOfficial: false,
      source: {
        id: "fomo_linked_x_post",
        name: "Fomo-linked public X post",
        trust: "public_x_identity_linked",
        url: tweet.url,
      },
      sourceTrust: "public_x_identity_linked",
      candidateSource: candidate.candidateSource,
      origin: candidate.origin,
      tweet: {
        id: tweet.id,
        url: tweet.url,
        handle: candidate.handle,
        xUserId: profile.id,
        sourceVerifiedBy: "official_x_oembed",
        text: tweet.text,
        createdAt: publishedAt,
      },
      caller,
      handle: candidate.handle,
      walletAddress: candidate.wallet,
      ...identity,
      chain: BSC_CHAIN,
      token,
      contractAddress: token,
      explorerUrl: `https://bscscan.com/token/${token}`,
      body: tweet.text,
      thesis: { id: tweet.id, text: tweet.text, handle: candidate.handle, createdAt: publishedAt },
      publishedAt,
      timestamp: publishedAt,
      timestampMs: Date.parse(publishedAt),
      observedAt: new Date(observedAt).toISOString(),
      market: qualification.market,
      security: qualification.security,
      qualification,
    };
  }

  async function processTweet(candidate, profile, bscActivity, binding, tweet, nowMs) {
    const key = `${candidate.handle}:${tweet.id}`.toLowerCase();
    if (state.seenTweets[key]) return { status: "seen" };
    if (tweet.isReply === true) {
      markSeen(key, nowMs);
      return { status: "ignored_reply" };
    }
    const publishedMs = Date.parse(tweet.createdAt || "");
    const pendingEntry = state.pending[key];
    const pendingFresh = pendingEntry && nowMs - Number(pendingEntry.firstObservedAt || 0) <= pendingMaxAgeMs;
    if (!Number.isFinite(publishedMs) || publishedMs > nowMs + FUTURE_TOLERANCE_MS
      || (nowMs - publishedMs > maximumPostAgeMs && !pendingFresh)) {
      markSeen(key, nowMs);
      return { status: "ignored_stale" };
    }
    const preliminary = classifyFomoXCallText(tweet.text);
    if (!preliminary.relevant) {
      markSeen(key, nowMs);
      return { status: "ignored_text", reason: preliminary.reason };
    }
    if (state.alertedTokens[preliminary.token]) {
      markSeen(key, nowMs);
      return { status: "duplicate_token" };
    }
    try {
      const verifiedTweet = await verifyOfficialPost(tweet, candidate.handle);
      const official = classifyFomoXCallText(verifiedTweet.text);
      if (!official.relevant || official.token !== preliminary.token) throw new Error("official X text did not preserve the exact call and contract");
      const pairKey = `${verifiedTweet.id}:${official.token}`;
      if (state.seenTweetContracts[pairKey]) {
        markSeen(key, nowMs);
        return { status: "duplicate_tweet_contract" };
      }
      const qualification = await qualifyCall({
        token: official.token,
        contractAddress: official.token,
        chain: BSC_CHAIN,
        handle: candidate.handle,
        caller: {
          handle: candidate.handle,
          twitterHandle: candidate.handle,
          twitter: `https://x.com/${candidate.handle}`,
          followers: profile.followers,
        },
        body: verifiedTweet.text,
      }, { config: qualificationConfig, fetchImpl, bscProvider: dependencies.bscProvider });
      if (!strictQualification(qualification, minimumLiquidityUsd)) {
        markPending(key, official.token, qualification?.reason || "local_security_or_liquidity_blocked", nowMs, verifiedTweet);
        return { status: "qualification_pending" };
      }
      const event = buildEvent(candidate, profile, bscActivity, binding, verifiedTweet, official.token, qualification, nowMs);
      const delivery = await sendAlert(config, event);
      if (!acceptedDelivery(delivery)) throw new Error(`alert delivery was not durably accepted: ${delivery?.status || "missing"}`);
      state.seenTweetContracts[pairKey] = { observedAt: nowMs, handle: candidate.handle };
      if (delivery?.status !== "suppressed") {
        state.alertedTokens[official.token] = { observedAt: nowMs, tweetId: verifiedTweet.id, handle: candidate.handle };
      }
      markSeen(key, nowMs);
      return { status: delivery?.status === "suppressed" ? "suppressed" : "delivered", event };
    } catch (error) {
      markPending(key, preliminary.token, error?.message || error, nowMs, tweet);
      return { status: "pending_error", error };
    }
  }

  async function processIdentity(candidate, nowMs) {
    const key = candidate.handle.toLowerCase();
    const stored = state.roster[key];
    if (Number(stored?.admissionRejectedUntil || 0) > nowMs) {
      return { status: "ineligible_cached", reason: stored.admissionRejectionReason || "admission gate" };
    }
    let profile = stored.xProfile;
    const profileAt = Date.parse(profile?.checkedAt || "");
    if (!profile || !Number.isFinite(profileAt) || nowMs - profileAt >= profileRefreshMs) {
      try {
        profile = await fetchXProfile(candidate.handle);
      } catch (error) {
        const transportBackoff = transportBackoffResult(error);
        if (transportBackoff && isTransientProfileReason(transportBackoff.reason)
          && hasFreshCachedIdentity(candidate, stored, nowMs)) {
          profile = stored.xProfile;
          stored.profileRefreshHealth = {
            status: "cached_identity_fallback",
            checkedAt: new Date(nowMs).toISOString(),
            reason: transportBackoff.reason,
            nextRetryAt: transportBackoff.nextRetryAt,
          };
        } else if (transportBackoff) {
          return transportBackoff;
        } else {
          if (error?.code !== "ineligible_x_profile") throw error;
          stored.admissionRejectedUntil = nowMs + admissionRetryMs;
          stored.admissionRejectionReason = error.message;
          delete stored.xProfile;
          delete stored.timelineHealth;
          return { status: "ineligible_profile", reason: error.message };
        }
      }
      if (profile !== stored.xProfile) {
        stored.xProfile = profile;
        delete stored.profileRefreshHealth;
        const previousBinding = stored.walletBinding;
        const hadExactVerifiedBinding = previousBinding?.status === "verified" && previousBinding?.verified === true
          && previousBinding?.proofSource === "fomoscan"
          && String(previousBinding?.wallet || "").toLowerCase() === candidate.wallet
          && cleanHandle(previousBinding?.handle || previousBinding?.twitterHandle).toLowerCase() === candidate.handle;
        try {
          const resolvedBinding = await resolveVerifiedBinding(candidate);
          if (freshVerifiedBinding(candidate, resolvedBinding, nowMs)) {
            const checkedAt = resolvedBinding.checkedAt || resolvedBinding.lastCheckedAt;
            stored.walletBinding = { ...resolvedBinding, checkedAt, lastCheckedAt: checkedAt };
          } else if (candidate.source === FOMOSCAN_SEED_SOURCE || hadExactVerifiedBinding) {
            stored.walletBinding = null;
            stored.admissionRejectedUntil = nowMs + admissionRetryMs;
            stored.admissionRejectionReason = `@${candidate.handle} FomoScan binding refresh returned no exact handle-wallet match`;
            return { status: "ineligible_fomoscan_binding", reason: stored.admissionRejectionReason };
          } else {
            stored.walletBinding = null;
          }
        } catch (error) {
          if (isTransientBindingRefreshError(error) && freshVerifiedBinding(candidate, previousBinding, nowMs)) {
            stored.walletBinding = previousBinding;
          } else {
            stored.walletBinding = null;
            if (candidate.source === FOMOSCAN_SEED_SOURCE || hadExactVerifiedBinding) {
              stored.admissionRejectedUntil = nowMs + admissionRetryMs;
              stored.admissionRejectionReason = `@${candidate.handle} FomoScan binding refresh failed closed: ${String(error?.message || error).slice(0, 100)}`;
              return { status: "ineligible_fomoscan_binding", reason: stored.admissionRejectionReason };
            }
          }
        }
      }
    }
    if (!/^\d+$/.test(String(profile.id || ""))
      || cleanHandle(profile.handle).toLowerCase() !== candidate.handle
      || profile.protected === true || profile.followers < minimumFollowers) {
      stored.admissionRejectedUntil = nowMs + admissionRetryMs;
      stored.admissionRejectionReason = `@${candidate.handle} has no current qualifying numeric X identity`;
      return { status: "ineligible_profile", reason: stored.admissionRejectionReason };
    }
    if (candidate.source === FOMOSCAN_SEED_SOURCE && !freshVerifiedBinding(candidate, stored.walletBinding, nowMs)) {
      stored.admissionRejectedUntil = nowMs + admissionRetryMs;
      stored.admissionRejectionReason = `@${candidate.handle} has no fresh FomoScan wallet binding`;
      return { status: "ineligible_fomoscan_binding", reason: stored.admissionRejectionReason };
    }

    let bscActivity = stored.bscActivity;
    const bscAt = Date.parse(bscActivity?.checkedAt || "");
    if (!bscActivity || !Number.isFinite(bscAt) || nowMs - bscAt >= profileRefreshMs) {
      const count = Number(await fetchBscActivity(candidate.wallet));
      if (!Number.isSafeInteger(count) || count <= 0) {
        stored.admissionRejectedUntil = nowMs + admissionRetryMs;
        stored.admissionRejectionReason = `@${candidate.handle} wallet has no verified BSC activity`;
        return { status: "ineligible_bsc_activity", reason: stored.admissionRejectionReason };
      }
      bscActivity = { count, checkedAt: new Date(nowMs).toISOString() };
      stored.bscActivity = bscActivity;
    }
    delete stored.admissionRejectedUntil;
    delete stored.admissionRejectionReason;

    let tweets;
    try {
      tweets = await fetchTimeline(profile);
    } catch (error) {
      const transportBackoff = transportBackoffResult(error);
      stored.timelineHealth = {
        ...stored.timelineHealth,
        status: "error",
        checkedAt: new Date(nowMs).toISOString(),
        reason: transportBackoff?.reason || String(error?.message || error).slice(0, 120),
        nextRetryAt: transportBackoff?.nextRetryAt || null,
      };
      if (transportBackoff) return transportBackoff;
      throw error;
    }
    stored.timelineHealth = {
      status: "healthy",
      checkedAt: new Date(nowMs).toISOString(),
      lastSuccessAt: new Date(nowMs).toISOString(),
      itemCount: tweets.length,
    };
    const latestId = maxTweetId(tweets);
    const initialized = state.initialized[key];
    const identityChanged = initialized && (String(initialized.xUserId || "") !== String(profile.id)
      || String(initialized.wallet || "").toLowerCase() !== candidate.wallet);
    if (!initialized || identityChanged) {
      if (identityChanged) clearHandleRuntimeState(state, key);
      if (!tweets.length) return { status: "baseline_pending", baseline: 0, delivered: 0 };
      state.initialized[key] = { xUserId: profile.id, wallet: candidate.wallet, initializedAt: new Date(nowMs).toISOString(), latestId };
      if (latestId) state.cursors[key] = latestId;
      return { status: "baselined", baseline: tweets.length, delivered: 0 };
    }

    const previousCursor = state.cursors[key] || initialized.latestId || null;
    const initializedAt = Date.parse(initialized.initializedAt || "");
    const mergedTweets = new Map(tweets.map((tweet) => [String(tweet.id), tweet]));
    for (const [pendingKey, pendingEntry] of Object.entries(state.pending || {})) {
      if (!pendingKey.startsWith(`${key}:`) || !pendingEntry?.tweet?.id) continue;
      const pendingHandle = cleanHandle(pendingEntry.tweet.handle).toLowerCase();
      const pendingXUserId = String(pendingEntry.tweet.xUserId || pendingEntry.tweet.authorId || "");
      if (pendingHandle === key && pendingXUserId === String(profile.id)
        && nowMs - Number(pendingEntry.firstObservedAt || 0) <= pendingMaxAgeMs) {
        mergedTweets.set(String(pendingEntry.tweet.id), pendingEntry.tweet);
      } else {
        delete state.pending[pendingKey];
      }
    }
    const candidates = [...mergedTweets.values()]
      .filter((tweet) => state.pending[`${key}:${tweet.id}`]
        || (previousCursor ? compareTweetIds(tweet.id, previousCursor) > 0
          : Number.isFinite(Date.parse(tweet.createdAt || "")) && Date.parse(tweet.createdAt) > initializedAt))
      .sort((left, right) => compareTweetIds(left.id, right.id));
    let delivered = 0;
    let pending = 0;
    for (const tweet of candidates) {
      const result = await processTweet(candidate, profile, bscActivity, stored.walletBinding || null, tweet, nowMs);
      if (result.status === "delivered") delivered += 1;
      if (result.status === "qualification_pending" || result.status === "pending_error") pending += 1;
    }
    if (latestId && (!previousCursor || compareTweetIds(latestId, previousCursor) > 0)) state.cursors[key] = latestId;
    return { status: "checked", candidates: candidates.length, delivered, pending };
  }

  async function runCheck() {
    await ensureState();
    const nowMs = now();
    if (config.fomoXCallEnabled !== true) {
      state.health = { ...state.health, status: "disabled", checkedAt: new Date(nowMs).toISOString() };
      await persist(nowMs);
      return { status: "disabled" };
    }

    const discoveryStatus = await refreshDiscovery(nowMs);
    const roster = eligibleRoster(nowMs);
    const batch = selectBatch(roster);
    const results = await settleBounded(batch, concurrency, (candidate) => processIdentity(candidate, nowMs));
    const failures = results.filter((result) => result.status === "rejected");
    const batchTransportBackoffs = results.filter((result) => result.status === "fulfilled" && result.value?.transportFailure === true);
    const transportCoverage = summarizeTransportCircuits(state, nowMs);
    const delivered = results.reduce((total, result) => total + Number(result.value?.delivered || 0), 0);
    const checkedAt = new Date(nowMs).toISOString();
    const coverage = summarizeEffectiveCoverage(roster, nowMs);
    const admittedCount = coverage.cachedCount;
    const rejectedCount = roster.filter((candidate) => Number(candidate.admissionRejectedUntil || 0) > nowMs).length;
    const seedBacklog = Number(state.health.sources.fomoscanSeeds?.backlog || 0);
    const seedInFlight = state.health.sources.fomoscanSeeds?.inFlight === true;
    const discoveryLimited = discoveryStatus.gmgn === "error"
      || discoveryStatus.fomoscanSeeds === "error" || seedInFlight || seedBacklog > 0;
    const coverageLimited = coverage.liveCount < coverage.eligibleCount;
    const sourceLimited = discoveryLimited || coverageLimited;
    const issueCount = failures.length + coverage.effectiveCircuitHandles.length;
    const status = sourceLimited || failures.length ? "degraded"
      : !roster.length ? "healthy_no_candidates"
        : "healthy";
    const successful = status.startsWith("healthy");
    const batchFailure = failures.length
      ? String(failures[0].reason?.message || failures[0].reason)
      : batchTransportBackoffs.length
        ? `${batchTransportBackoffs[0].value.source || "fxtwitter"} @${batchTransportBackoffs[0].value.handle || "unknown"} ${batchTransportBackoffs[0].value.reason}`
        : null;
    const discoveryFailure = discoveryStatus.gmgn === "error" ? state.health.sources.gmgn?.error
      : discoveryStatus.fomoscanSeeds === "error" ? state.health.sources.fomoscanSeeds?.error
        : null;
    state.health = {
      ...state.health,
      status,
      checkedAt,
      lastSuccessAt: successful ? checkedAt : state.health.lastSuccessAt,
      lastError: sourceLimited || failures.length
        ? effectiveCoverageError(coverage, seedBacklog, batchFailure || discoveryFailure)
        : null,
      consecutiveFailures: successful ? 0 : Number(state.health.consecutiveFailures || 0) + 1,
      rosterCount: Object.keys(state.roster).length,
      discoveredCandidateCount: Number(state.health.sources.gmgn?.discovered || 0)
        + Number(state.health.sources.fomoscanSeeds?.verified || 0),
      eligibleCount: roster.length,
      admittedCount,
      activeCount: coverage.liveCount,
      cachedCount: coverage.cachedCount,
      freshCount: coverage.freshCount,
      liveCount: coverage.liveCount,
      backlogCount: coverage.backlogCount,
      rejectedCount,
      batchCount: batch.length,
      coverage,
      sources: {
        ...state.health.sources,
        x: {
          status: sourceLimited || failures.length ? "partial" : coverage.liveCount ? "healthy" : "no_candidates",
          coverage: sourceLimited ? "source_limited" : "complete",
          checkedAt,
          checked: batch.length,
          admitted: admittedCount,
          cached: coverage.cachedCount,
          fresh: coverage.freshCount,
          live: coverage.liveCount,
          backlog: coverage.backlogCount,
          rejected: rejectedCount,
          failures: issueCount,
          transportBackoffs: transportCoverage.count,
          effectiveTransportBackoffs: coverage.effectiveCircuitHandles.length,
          transportOpen: transportCoverage.open,
          transportProbeDue: transportCoverage.probeDue,
          handles: transportCoverage.handles,
          reasons: transportCoverage.reasons,
          sources: transportCoverage.sources,
          nextRetryAt: transportCoverage.nextRetryAt,
          liveHandles: coverage.liveHandles,
          backlogHandles: coverage.backlogHandles,
          profileFallbackHandles: coverage.profileFallbackHandles,
          effectiveCircuitHandles: coverage.effectiveCircuitHandles,
          coverageReasons: coverage.reasonCounts,
        },
      },
    };
    for (const failure of failures) logger.error?.(`[fomo-x-call] ${failure.reason?.message || failure.reason}`);
    await persist(nowMs);
    return {
      status,
      roster: roster.length,
      discoveredCandidates: state.health.discoveredCandidateCount,
      admitted: admittedCount,
      active: coverage.liveCount,
      rejected: rejectedCount,
      checked: batch.length,
      delivered,
      failures: issueCount,
    };
  }

  const check = () => {
    const current = serial.catch(() => {}).then(runCheck);
    serial = current.catch(() => {});
    return current;
  };

  async function start() {
    if (started || config.fomoXCallEnabled !== true) return;
    started = true;
    stopped = false;
    await check();
    if (stopped) return;
    timer = setInterval(() => check().catch((error) => logger.error?.(`[fomo-x-call] poll: ${error.message}`)), intervalMs);
    timer.unref?.();
  }

  async function stop() {
    stopped = true;
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    verifiedSeedAbortController?.abort();
    await serial.catch(() => {});
    verifiedSeedAbortController?.abort();
    const discovery = verifiedSeedDiscovery;
    if (discovery) await discovery.catch(() => {});
    await writeSerial.catch(() => {});
  }

  if (dependencies.autoStart !== false) start().catch((error) => logger.error?.(`[fomo-x-call] startup: ${error.message}`));

  return {
    check,
    start,
    stop,
    stateFile,
    async waitForDiscovery() {
      const current = verifiedSeedDiscovery;
      if (current) await current.catch(() => {});
      await writeSerial.catch(() => {});
    },
    async getState() { await serial.catch(() => {}); await writeSerial.catch(() => {}); await ensureState(); return structuredClone(state); },
  };
}
