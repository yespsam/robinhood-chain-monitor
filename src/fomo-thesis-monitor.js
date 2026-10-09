import fs from "node:fs/promises";
import path from "node:path";
import { isAddress, JsonRpcProvider } from "ethers";
import WebSocket from "ws";
import { isTerminalAlertSuppression } from "./alerts.js";
import { assessLocalTokenSecurity } from "./local-security.js";

export const FOMO_OFFICIAL_API_BASE = "https://prod-api.fomo.family";
export const FOMO_THESIS_RELAY_BASE = "https://api.fomoscan.sh";

const STATE_VERSION = 2;
const BSC_CHAIN = Object.freeze({ id: 56, chainId: 56, slug: "bsc", name: "BNB Smart Chain", gmgn: "bsc", evm: true });
const FORBIDDEN_ACTIVITY = /(?:^|_)(?:swap|buy|sell|manual)(?:_|$)/i;
const ALLOWED_ACTIVITY = new Set(["thesis", "thesis_created"]);
const RETENTION_MS = 30 * 24 * 60 * 60_000;

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
const asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const cleanType = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const cleanHandle = (value) => String(value || "").trim().replace(/^@/, "");

function timestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return number < 10_000_000_000 ? number * 1_000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const rows = [];
  const visited = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || visited.has(value) || depth > 4) return;
    visited.add(value);
    if (Array.isArray(value)) {
      rows.push(...value.filter((item) => item && typeof item === "object"));
      return;
    }
    for (const key of ["data", "result", "feed", "feeds", "items", "results", "records", "content", "thesis", "theses", "activities"]) {
      const nested = value[key];
      if (Array.isArray(nested)) visit(nested, depth + 1);
      else if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(payload);
  if (!rows.length) {
    const single = asObject(first(payload.data, payload.result, payload.item, payload.thesis, payload));
    if (Object.keys(single).length) rows.push(single);
  }
  return rows;
}

function activityMarkers(row, thesis) {
  return [
    row.feedType, row.feed_type, row.eventType, row.event_type, row.activityType, row.activity_type,
    row.type, row.kind, row.action, row.side, row.transactionType, row.transaction_type,
    thesis.feedType, thesis.feed_type, thesis.eventType, thesis.event_type, thesis.type, thesis.kind,
  ].map(cleanType).filter(Boolean);
}

function chainValue(row, thesis, token) {
  return first(
    thesis.chainId, thesis.chain_id, thesis.chain,
    row.chainId, row.chain_id, row.networkId, row.network_id, row.chain, row.network,
    token.chainId, token.chain_id, token.chain, token.network,
  );
}

function tokenValue(row, thesis, token) {
  return first(
    thesis.tokenAddress, thesis.token_address, thesis.contractAddress, thesis.contract_address, thesis.coinAddress, thesis.coin_address, thesis.tokenMint, thesis.token_mint, thesis.mint,
    row.tokenAddress, row.token_address, row.contractAddress, row.contract_address, row.coinAddress, row.coin_address, row.tokenMint, row.token_mint, row.mint,
    token.address, token.tokenAddress, token.token_address, token.contractAddress, token.contract_address, token.mint,
  );
}

function sourceFor(sourceKind) {
  if (sourceKind === "relay") {
    return {
      id: "fomoscan_thesis_relay",
      name: "FomoScan thesis relay",
      trust: "verified_thesis_relay",
      url: FOMO_THESIS_RELAY_BASE,
    };
  }
  return {
    id: "fomo_family_official_thesis",
    name: "Fomo Family official thesis feed",
    trust: "official_authenticated_api",
    url: "https://fomo.family",
  };
}

/**
 * Normalize the authenticated Fomo feed or the FomoScan thesis relay.
 * Records without a stable thesis id are intentionally rejected.
 */
export function parseFomoThesisPayload(payload, options = {}) {
  const sourceKind = options.sourceKind === "relay" ? "relay" : "official";
  const defaultHandle = cleanHandle(options.handle);
  const source = sourceFor(sourceKind);
  const parsed = [];

  for (const wrapper of candidateRows(payload)) {
    const nestedThesis = asObject(wrapper.thesis);
    const thesis = Object.keys(nestedThesis).length ? nestedThesis : wrapper;
    const markers = activityMarkers(wrapper, thesis);
    if (markers.some((marker) => FORBIDDEN_ACTIVITY.test(marker))) continue;

    const explicitlyThesis = markers.some((marker) => ALLOWED_ACTIVITY.has(marker));
    const semanticallyThesis = Object.keys(nestedThesis).length > 0
      || first(thesis.commentId, thesis.comment_id, wrapper.commentId, wrapper.comment_id) !== undefined
      || first(thesis.thesisExternalId, thesis.thesis_external_id, wrapper.thesisExternalId, wrapper.thesis_external_id) !== undefined
      || (sourceKind === "relay" && !markers.length && first(thesis.id, wrapper.id) !== undefined);
    if (markers.length ? !explicitlyThesis : !semanticallyThesis) continue;

    const stableId = first(
      thesis.thesisExternalId, thesis.thesis_external_id, wrapper.thesisExternalId, wrapper.thesis_external_id,
      thesis.commentId, thesis.comment_id, wrapper.commentId, wrapper.comment_id,
      thesis.id, wrapper.id,
    );
    if (stableId === undefined || stableId === null || !String(stableId).trim()) continue;

    const commentObject = asObject(first(thesis.comment, wrapper.comment));
    const bodyValue = first(
      typeof thesis.comment === "string" ? thesis.comment : undefined,
      typeof wrapper.thesis === "string" ? wrapper.thesis : undefined,
      thesis.text, thesis.content, thesis.body, thesis.message, thesis.thesisText, thesis.thesis_text, thesis.commentText, thesis.comment_text,
      typeof wrapper.comment === "string" ? wrapper.comment : undefined,
      wrapper.text, wrapper.content, wrapper.body, wrapper.message, wrapper.thesisText, wrapper.thesis_text, wrapper.commentText, wrapper.comment_text,
      commentObject.text, commentObject.content, commentObject.body,
    );
    if (bodyValue === undefined || bodyValue === null || !String(bodyValue).trim()) continue;

    const token = asObject(first(thesis.token, wrapper.token, wrapper.coin, wrapper.asset));
    const author = asObject(first(thesis.trader, thesis.author, thesis.creator, thesis.user, wrapper.trader, wrapper.author, wrapper.creator, wrapper.user));
    const publishedAt = first(
      thesis.publishedAt, thesis.published_at, thesis.createdAt, thesis.created_at, thesis.createdDate, thesis.created_date, thesis.timestamp,
      wrapper.publishedAt, wrapper.published_at, wrapper.createdAt, wrapper.created_at, wrapper.createdDate, wrapper.created_date, wrapper.timestamp,
    );
    const chain = chainValue(wrapper, thesis, token);
    const address = tokenValue(wrapper, thesis, token);
    const handle = cleanHandle(first(
      thesis.handle, thesis.authorHandle, thesis.author_handle, thesis.traderHandle, thesis.trader_handle, thesis.traderName, thesis.trader_name,
      wrapper.handle, wrapper.authorHandle, wrapper.author_handle, wrapper.traderHandle, wrapper.trader_handle, wrapper.traderName, wrapper.trader_name,
      author.handle, author.username, author.twitterHandle, author.twitter_handle,
      defaultHandle,
    ));
    const twitterHandle = cleanHandle(first(
      thesis.twitterHandle, thesis.twitter_handle, wrapper.twitterHandle, wrapper.twitter_handle,
      author.twitterHandle, author.twitter_handle, author.twitterUsername, author.twitter_username,
      author.handle, author.username, handle,
    ));
    const followersValue = first(
      thesis.followers, thesis.twitterFollowers, thesis.twitter_followers,
      wrapper.followers, wrapper.twitterFollowers, wrapper.twitter_followers,
      author.followers, author.followersCount, author.followers_count,
    );
    const followers = Number(followersValue);
    const fomoUrl = first(thesis.url, thesis.fomoUrl, thesis.fomo_url, wrapper.url, wrapper.fomoUrl, wrapper.fomo_url);
    const profileUrl = first(author.profileUrl, author.profile_url, thesis.profileUrl, thesis.profile_url, wrapper.profileUrl, wrapper.profile_url);

    parsed.push({
      stableId: String(stableId).trim(),
      body: String(bodyValue).trim(),
      publishedAt: publishedAt ?? null,
      publishedAtMs: timestampMs(publishedAt),
      handle: handle || null,
      caller: {
        handle: handle || null,
        twitterHandle: twitterHandle || handle || null,
        twitter: twitterHandle || handle ? `https://x.com/${encodeURIComponent(twitterHandle || handle)}` : null,
        followers: Number.isFinite(followers) && followers >= 0 ? followers : null,
      },
      token: address ? String(address).trim() : null,
      symbol: first(token.symbol, thesis.tokenSymbol, thesis.token_symbol, thesis.symbol, wrapper.tokenSymbol, wrapper.token_symbol, wrapper.symbol)
        ? String(first(token.symbol, thesis.tokenSymbol, thesis.token_symbol, thesis.symbol, wrapper.tokenSymbol, wrapper.token_symbol, wrapper.symbol)).trim()
        : null,
      chain: chain ?? null,
      fomoUrl: /^https:\/\//i.test(String(fomoUrl || "")) ? String(fomoUrl) : null,
      profileUrl: /^https:\/\//i.test(String(profileUrl || "")) ? String(profileUrl) : null,
      source,
    });
  }

  const unique = new Map();
  for (const item of parsed) if (!unique.has(item.stableId)) unique.set(item.stableId, item);
  return [...unique.values()];
}

export const parseFomoThesisFeed = (payload) => parseFomoThesisPayload(payload, { sourceKind: "official" });
export const parseFomoThesisRelay = (payload, handle = "") => parseFomoThesisPayload(payload, { sourceKind: "relay", handle });

function normalizeBscChain(value) {
  const candidate = typeof value === "object" && value !== null
    ? first(value.id, value.chainId, value.chain_id, value.slug, value.name)
    : value;
  if (Number(candidate) === 56) return BSC_CHAIN;
  const normalized = String(candidate || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (["bsc", "bnb", "bnb chain", "bnb smart chain", "binance smart chain"].includes(normalized)) return BSC_CHAIN;
  return null;
}

function hasChainClaim(value) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value !== "object") return true;
  return first(value.id, value.chainId, value.chain_id, value.slug, value.name) !== undefined;
}

function parseDexMarket(payload, token) {
  const target = String(token || "").toLowerCase();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.pairs) ? payload.pairs : [];
  return rows
    .filter((pair) => String(pair?.chainId || "").toLowerCase() === "bsc")
    .filter((pair) => [pair?.baseToken?.address, pair?.quoteToken?.address].some((address) => String(address || "").toLowerCase() === target))
    .map((pair) => ({
      pairAddress: String(pair?.pairAddress || "").trim(),
      dexId: String(pair?.dexId || "unknown").slice(0, 60),
      kind: /(?:v3|cl|concentrated)/i.test(`${pair?.dexId || ""} ${(pair?.labels || []).join(" ")}`) ? "v3" : "v2",
      liquidityUsd: Number(pair?.liquidity?.usd),
      sellsM5: Math.max(0, Number(pair?.txns?.m5?.sells || 0)),
      buysM5: Math.max(0, Number(pair?.txns?.m5?.buys || 0)),
      volumeM5: Math.max(0, Number(pair?.volume?.m5 || 0)),
      priceUsd: Number(pair?.priceUsd),
      marketCap: Number(pair?.marketCap ?? pair?.fdv),
      url: /^https:\/\//i.test(String(pair?.url || "")) ? pair.url : null,
    }))
    .filter((pair) => isAddress(pair.pairAddress) && Number.isFinite(pair.liquidityUsd) && pair.liquidityUsd > 0)
    .sort((left, right) => right.liquidityUsd - left.liquidityUsd)[0] || null;
}

export async function defaultResolveFomoCall(call, context = {}) {
  try {
    if (!isAddress(call?.token)) return null;
    const fetchImpl = context.fetchImpl || fetch;
    const response = await fetchImpl(`https://api.dexscreener.com/token-pairs/v1/bsc/${encodeURIComponent(call.token)}`, {
      headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const market = parseDexMarket(await response.json(), call.token);
    return market ? { chain: BSC_CHAIN, token: call.token, resolvedMarket: market, chainEvidence: "dexscreener_bsc_pair" } : null;
  } catch {
    return null;
  }
}

async function verifiedCaller(call, context) {
  const config = context.config || {};
  const minimumFollowers = Math.max(0, Number(config.fomoPublishedCallMinXFollowers ?? 10_000));
  const caller = { ...asObject(call.caller) };
  caller.handle = cleanHandle(first(caller.handle, call.handle));
  caller.twitterHandle = cleanHandle(first(caller.twitterHandle, caller.handle));
  const reportedFollowers = Number(caller.followers);
  if (Number.isFinite(reportedFollowers) && reportedFollowers >= 0) caller.reportedFollowers = reportedFollowers;
  if (!caller.twitterHandle) return null;
  try {
    const base = String(config.fomoCallFxTwitterApiBase || "https://api.fxtwitter.com").replace(/\/$/, "");
    const response = await (context.fetchImpl || fetch)(`${base}/2/profile/${encodeURIComponent(caller.twitterHandle)}`, {
      headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const user = asObject(payload?.user);
    const returnedHandle = cleanHandle(first(user.screen_name, user.username, user.handle));
    const followers = Number(first(user.followers, user.followers_count, user.followersCount));
    if (Number(payload?.code ?? 200) !== 200
      || returnedHandle.toLowerCase() !== caller.twitterHandle.toLowerCase()
      || !Number.isFinite(followers)
      || followers < minimumFollowers) return null;
    return {
      ...caller,
      handle: caller.handle || returnedHandle,
      twitterHandle: returnedHandle,
      twitter: `https://x.com/${encodeURIComponent(returnedHandle)}`,
      followers,
      followerVerification: "fxtwitter_public_profile",
    };
  } catch {
    return null;
  }
}

/** Production fail-closed qualification: real BSC pool + observed sell + local bytecode/owner checks. */
export async function defaultQualifyFomoThesis(call, context = {}) {
  try {
    if (!isAddress(call?.token) || !normalizeBscChain(call?.chain)) return { decision: "block", reason: "invalid_bsc_contract" };
    const fetchImpl = context.fetchImpl || fetch;
    const config = context.config || {};
    const caller = await verifiedCaller(call, context);
    if (!caller) return { decision: "block", reason: "caller_below_traffic_gate_or_unverified" };
    let market = call.resolvedMarket || null;
    if (!market) {
      const response = await fetchImpl(`https://api.dexscreener.com/token-pairs/v1/bsc/${encodeURIComponent(call.token)}`, {
        headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { decision: "block", reason: `dexscreener_http_${response.status}` };
      market = parseDexMarket(await response.json(), call.token);
    }
    const minimumLiquidity = Math.max(1, Number(config.fomoPublishedCallMinLiquidityUsd || 10_000));
    if (!market) return { decision: "block", reason: "no_verified_bsc_pool" };
    if (market.liquidityUsd < minimumLiquidity) return { decision: "block", reason: "insufficient_liquidity", market };
    if (market.sellsM5 < 1) return { decision: "block", reason: "no_observed_sell", market };

    const provider = context.bscProvider || new JsonRpcProvider(config.fomoCallBscRpcUrl || "https://bsc-rpc.publicnode.com", 56, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    const security = await assessLocalTokenSecurity(provider, call.token, [{ pool: market.pairAddress, kind: market.kind }]);
    security.metrics = { ...(security.metrics || {}), sellObserved: true };
    if (security.decision !== "pass" || security.metrics?.liquidityConfirmed !== true) {
      return { decision: "block", reason: security.reasons?.[0] || "local_security_not_passed", market, security };
    }
    return { decision: "pass", market, security, caller };
  } catch (error) {
    return { decision: "block", reason: `qualification_failed:${String(error?.message || error).slice(0, 120)}` };
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    seen: {},
    pending: {},
    initialized: {},
    cursors: {},
    health: { status: "initializing", checkedAt: null, sources: {} },
  };
}

async function readState(file, fsImpl) {
  try {
    const value = JSON.parse(await fsImpl.readFile(file, "utf8"));
    return {
      ...defaultState(),
      ...value,
      version: STATE_VERSION,
      seen: asObject(value.seen),
      pending: asObject(value.pending),
      initialized: asObject(value.initialized),
      cursors: asObject(value.cursors),
      health: { ...defaultState().health, ...asObject(value.health), sources: asObject(value.health?.sources) },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState();
    throw error;
  }
}

export async function atomicWriteFomoThesisState(file, value, fsImpl = fs) {
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

function websocketUrl(base, handle) {
  const url = new URL(`${String(base || FOMO_THESIS_RELAY_BASE).replace(/\/$/, "")}/getThesisByTrader/${encodeURIComponent(handle)}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function acceptedQualification(result) {
  return result === true || result?.qualified === true || result?.ok === true || result?.decision === "pass";
}

function acceptedDelivery(result) {
  return ["delivered", "queued"].includes(result?.status) || isTerminalAlertSuppression(result);
}

export function createFomoThesisMonitor(config, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const qualifyCall = dependencies.qualifyCallImpl || defaultQualifyFomoThesis;
  const resolveCall = dependencies.resolveCallImpl || defaultResolveFomoCall;
  const sendAlert = dependencies.sendAlertsImpl || (async () => { throw new Error("sendAlertsImpl is required"); });
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const WebSocketImpl = dependencies.WebSocketImpl === undefined ? WebSocket : dependencies.WebSocketImpl;
  const stateFile = path.join(config.dataDir, "fomo-thesis-state.json");
  const officialBase = String(config.fomoOfficialApiBase || FOMO_OFFICIAL_API_BASE).replace(/\/$/, "");
  const relayBase = String(config.fomoThesisRelayBase || FOMO_THESIS_RELAY_BASE).replace(/\/$/, "");
  const officialToken = String(config.fomoOfficialBearerToken || "").trim();
  const relayToken = String(config.fomoThesisRelayToken || "").trim();
  const handles = [...new Set((Array.isArray(config.fomoCallPublicHandles) ? config.fomoCallPublicHandles : [])
    .map(cleanHandle).filter(Boolean))];
  const bscOnly = config.fomoPublishedCallBscOnly !== false;
  const maximumAgeMs = Math.max(1_000, Number(config.fomoPublishedCallMaxAgeMs || 300_000));
  const intervalMs = Math.max(1_000, Number(config.fomoPublishedCallPollIntervalMs || 10_000));
  const websocketEnabled = config.fomoThesisRelayWebSocketEnabled !== false;
  let state = null;
  let started = false;
  let stopped = false;
  let pollTimer = null;
  let serial = Promise.resolve();
  let pendingCheck = null;
  const sockets = new Map();
  const reconnectTimers = new Map();

  const ensureState = async () => {
    if (!state) state = await readState(stateFile, fsImpl);
    return state;
  };

  const persist = async () => {
    const cutoff = now() - RETENTION_MS;
    for (const [id, seenAt] of Object.entries(state.seen)) if (Number(seenAt) < cutoff) delete state.seen[id];
    for (const [id, firstObservedAt] of Object.entries(state.pending)) if (Number(firstObservedAt) < cutoff) delete state.pending[id];
    await atomicWriteFomoThesisState(stateFile, state, fsImpl);
  };

  const serialize = (task) => {
    const current = serial.catch(() => {}).then(task);
    serial = current.catch(() => {});
    return current;
  };

  async function enforceBsc(call) {
    const explicitBsc = normalizeBscChain(call.chain);
    if (!bscOnly) return { ...call, chain: explicitBsc || call.chain };
    if (explicitBsc) return { ...call, chain: BSC_CHAIN };
    if (hasChainClaim(call.chain) || !resolveCall) return null;
    const resolved = await resolveCall(call, { config, fetchImpl });
    const resolvedChain = normalizeBscChain(first(resolved?.chain, resolved?.chainId, resolved?.chain_id));
    if (!resolvedChain) return null;
    return {
      ...call,
      ...asObject(resolved),
      stableId: call.stableId,
      body: call.body,
      publishedAt: call.publishedAt,
      publishedAtMs: call.publishedAtMs,
      handle: call.handle || resolved?.handle || null,
      token: call.token || resolved?.token || resolved?.contractAddress || null,
      source: call.source,
      chain: BSC_CHAIN,
    };
  }

  const seenKey = (record) => `${record.source.id}:${record.stableId}`;

  function baselineSnapshot(sourceKey, records, observedAt) {
    for (const record of records) {
      const namespacedId = seenKey(record);
      state.seen[namespacedId] = observedAt;
      delete state.pending[namespacedId];
    }
    state.initialized[sourceKey] = true;
    state.cursors[sourceKey] = Math.max(Number(state.cursors[sourceKey] || 0), ...records.map((record) => record.publishedAtMs || 0));
    return { baseline: records.length, delivered: 0 };
  }

  async function consume(sourceKey, records, observedAt) {
    const initialized = state.initialized[sourceKey] === true;
    const ordered = [...records].sort((left, right) => (left.publishedAtMs || 0) - (right.publishedAtMs || 0));
    if (!initialized) return baselineSnapshot(sourceKey, ordered, observedAt);

    let delivered = 0;
    for (const record of ordered) {
      const namespacedId = seenKey(record);
      if (state.seen[namespacedId]) continue;
      const firstObservedAt = Number(state.pending[namespacedId] || observedAt);
      state.pending[namespacedId] = firstObservedAt;
      const sourcePublishedMs = record.publishedAtMs;
      const publishedMs = sourcePublishedMs || firstObservedAt;
      if (publishedMs > observedAt + 60_000 || observedAt - publishedMs > maximumAgeMs) {
        state.seen[namespacedId] = observedAt;
        delete state.pending[namespacedId];
        if (sourcePublishedMs) state.cursors[sourceKey] = Math.max(Number(state.cursors[sourceKey] || 0), sourcePublishedMs);
        continue;
      }

      if (!record.token || !isAddress(record.token)) {
        state.seen[namespacedId] = observedAt;
        delete state.pending[namespacedId];
        continue;
      }
      const bscCall = await enforceBsc(record);
      if (!bscCall) {
        if (hasChainClaim(record.chain)) {
          state.seen[namespacedId] = observedAt;
          delete state.pending[namespacedId];
        }
        continue;
      }
      const qualification = await qualifyCall(bscCall, { config, fetchImpl, bscProvider: dependencies.bscProvider });
      if (!acceptedQualification(qualification)) continue;

      const caller = {
        ...asObject(record.caller),
        ...asObject(qualification?.caller),
      };
      caller.handle = cleanHandle(first(caller.handle, bscCall.handle)) || null;
      caller.twitterHandle = cleanHandle(first(caller.twitterHandle, caller.handle)) || null;
      caller.twitter ||= caller.twitterHandle ? `https://x.com/${encodeURIComponent(caller.twitterHandle)}` : null;
      const profileUrl = record.profileUrl || (caller.handle ? `https://fomo.family/profile/${encodeURIComponent(caller.handle)}` : "https://fomo.family");

      const event = {
        type: "fomo_family_top_call",
        signalKind: "fomo_published_call",
        eventKey: `fomo-published-call:${record.source.id}:${record.stableId}`,
        qualified: true,
        strong: true,
        callId: record.stableId,
        stableId: record.stableId,
        handle: caller.handle,
        caller,
        token: bscCall.token,
        contractAddress: bscCall.token,
        explorerUrl: `https://bscscan.com/token/${bscCall.token}`,
        symbol: bscCall.symbol || null,
        tokenSymbol: bscCall.symbol || null,
        chain: BSC_CHAIN,
        body: record.body,
        publishedAt: record.publishedAt || new Date(publishedMs).toISOString(),
        sourcePublishedAt: record.publishedAt || null,
        publishedAtEstimated: !sourcePublishedMs,
        timestamp: record.publishedAt || new Date(publishedMs).toISOString(),
        timestampMs: publishedMs,
        thesis: { id: record.stableId, text: record.body, handle: caller.handle, createdAt: record.publishedAt || new Date(publishedMs).toISOString() },
        fomoUrl: record.fomoUrl || profileUrl,
        profileUrl,
        market: qualification?.market || null,
        security: qualification?.security || null,
        qualification: typeof qualification === "object" ? qualification : { decision: "pass" },
        source: { ...record.source, url: record.source.id === "fomoscan_thesis_relay" ? relayBase : "https://fomo.family" },
        sourceTrust: record.source.trust,
        observedAt: new Date(observedAt).toISOString(),
      };
      const delivery = await sendAlert(config, event);
      if (!acceptedDelivery(delivery)) {
        throw new Error(`Fomo thesis delivery was not durably accepted: ${delivery?.status || "missing"}`);
      }
      state.seen[namespacedId] = observedAt;
      delete state.pending[namespacedId];
      if (sourcePublishedMs) state.cursors[sourceKey] = Math.max(Number(state.cursors[sourceKey] || 0), sourcePublishedMs);
      delivered += 1;
    }
    return { baseline: 0, delivered };
  }

  async function fetchJson(url, token) {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": "robinhood-launchpad-monitor" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function pollSource(sourceKey, sourceName, request, parser, observedAt) {
    try {
      const payload = await request();
      const records = parser(payload);
      const result = await consume(sourceKey, records, observedAt);
      state.health.sources[sourceKey] = { status: "healthy", checkedAt: new Date(observedAt).toISOString(), records: records.length, ...result };
    } catch (error) {
      state.health.sources[sourceKey] = { status: "error", checkedAt: new Date(observedAt).toISOString(), error: String(error?.message || error).slice(0, 180) };
      logger.error?.(`[fomo-thesis] ${sourceName}: ${error.message}`);
    }
  }

  async function runCheck() {
    await ensureState();
    const observedAt = now();
    if (config.fomoPublishedCallEnabled !== true || config.fomoPlatformSourcesEnabled === false) {
      state.health = { status: "disabled", checkedAt: new Date(observedAt).toISOString(), sources: state.health.sources || {} };
      await persist();
      return { status: "disabled" };
    }

    if (!officialToken) {
      state.health.sources.official = { status: "blocked_missing_credentials", checkedAt: new Date(observedAt).toISOString() };
    } else {
      await pollSource(
        "official", "official feed",
        () => fetchJson(`${officialBase}/feed?limit=50&feedTypes=thesis_created`, officialToken),
        (payload) => parseFomoThesisPayload(payload, { sourceKind: "official" }), observedAt,
      );
    }

    if (!relayToken) {
      state.health.sources.relay = { status: "blocked_missing_credentials", checkedAt: new Date(observedAt).toISOString() };
    } else if (!handles.length) {
      state.health.sources.relay = { status: "blocked_no_handles", checkedAt: new Date(observedAt).toISOString() };
    } else {
      for (const handle of handles) {
        const key = `relay:${handle.toLowerCase()}`;
        await pollSource(
          key, `relay @${handle}`,
          () => fetchJson(`${relayBase}/getThesisByTrader/${encodeURIComponent(handle)}`, relayToken),
          (payload) => parseFomoThesisPayload(payload, { sourceKind: "relay", handle }), observedAt,
        );
      }
      const statuses = handles.map((handle) => state.health.sources[`relay:${handle.toLowerCase()}`]?.status);
      state.health.sources.relay = {
        status: statuses.every((status) => status === "healthy") ? "healthy" : "degraded",
        checkedAt: new Date(observedAt).toISOString(), handles: handles.length,
      };
    }

    const noCredentials = !officialToken && !relayToken;
    const configuredStatuses = [
      officialToken ? state.health.sources.official?.status : null,
      relayToken ? state.health.sources.relay?.status : null,
    ].filter(Boolean);
    // One healthy lane must not hide a configured lane that is failing or
    // cannot subscribe. Missing credentials for an unused fallback are fine;
    // every source the operator actually configured must be healthy.
    state.health.status = noCredentials
      ? "blocked_missing_credentials"
      : configuredStatuses.length > 0 && configuredStatuses.every((status) => status === "healthy")
        ? "healthy"
        : "degraded";
    state.health.checkedAt = new Date(observedAt).toISOString();
    await persist();
    return { status: state.health.status };
  }

  // Timers may tick while a multi-source poll is still running or waiting for
  // a socket delivery. Join that poll instead of creating an unbounded queue
  // of obsolete polls. Distinct websocket events retain their own serial work.
  const check = () => {
    if (pendingCheck) return pendingCheck;
    const work = serialize(runCheck).finally(() => {
      if (pendingCheck === work) pendingCheck = null;
    });
    pendingCheck = work;
    return work;
  };

  function attachSocket(handle) {
    if (!started || stopped || !relayToken || !websocketEnabled || !WebSocketImpl) return;
    const key = handle.toLowerCase();
    let socket;
    try {
      socket = new WebSocketImpl(websocketUrl(relayBase, handle), [relayToken]);
    } catch (error) {
      logger.error?.(`[fomo-thesis] relay websocket @${handle}: ${error.message}`);
      return;
    }
    sockets.set(key, socket);
    const on = typeof socket.on === "function" ? socket.on.bind(socket) : socket.addEventListener?.bind(socket);
    on?.("message", (message) => {
      const raw = message?.data ?? message;
      serialize(async () => {
        await ensureState();
        try {
          const payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
          const observedAt = now();
          let frameType = cleanType(first(payload?.type, payload?.event, payload?.kind));
          if (!frameType && (payload?.ready !== undefined || payload?.subscribeOk !== undefined || payload?.subscribe_ok !== undefined)) frameType = "ready";
          if (!frameType && payload?.snapshot !== undefined) frameType = "snapshot";
          if (!frameType && payload?.thesis !== undefined) frameType = payload.thesis === "unavailable" ? "unavailable" : "thesis";
          if (!frameType && payload?.unavailable === true) frameType = "unavailable";
          const wsHealthKey = `relay-ws:${key}`;
          if (frameType === "ready" || frameType === "subscribe_ok" || frameType === "subscribeok") {
            const subscribeOk = first(payload?.subscribeOk, payload?.subscribe_ok, payload?.ready?.subscribeOk, payload?.data?.subscribeOk) === true;
            state.health.sources[wsHealthKey] = {
              status: subscribeOk ? "healthy" : "subscription_rejected",
              ready: true,
              subscribeOk,
              checkedAt: new Date(observedAt).toISOString(),
            };
            await persist();
            return;
          }
          if (frameType === "unavailable") {
            state.health.sources[wsHealthKey] = { status: "unavailable", ready: false, subscribeOk: false, checkedAt: new Date(observedAt).toISOString() };
            await persist();
            return;
          }
          const prior = asObject(state.health.sources[wsHealthKey]);
          if (prior.subscribeOk !== true) {
            state.health.sources[wsHealthKey] = {
              ...prior,
              status: "awaiting_verified_subscription",
              ready: prior.ready === true,
              subscribeOk: false,
              checkedAt: new Date(observedAt).toISOString(),
            };
            await persist();
            return;
          }
          const frameBody = frameType === "snapshot"
            ? first(payload?.snapshot, payload?.data, payload?.payload, payload)
            : frameType === "thesis"
              ? first(typeof payload?.thesis === "object" ? payload.thesis : undefined, payload?.data, payload?.payload, payload)
              : first(payload?.data, payload?.payload, payload);
          const records = parseFomoThesisPayload(frameBody, { sourceKind: "relay", handle });
          if (frameType === "snapshot") baselineSnapshot(`relay:${key}`, records, observedAt);
          else if (frameType === "thesis" || frameType === "thesis_created") await consume(`relay:${key}`, records, observedAt);
          else {
            state.health.sources[wsHealthKey] = { status: "ignored_frame", ready: false, subscribeOk: false, checkedAt: new Date(observedAt).toISOString(), frameType: frameType || "unknown" };
            await persist();
            return;
          }
          state.health.sources[wsHealthKey] = {
            ...prior,
            status: prior.subscribeOk === true ? "healthy" : "awaiting_ready",
            ready: prior.ready === true,
            subscribeOk: prior.subscribeOk === true,
            checkedAt: new Date(observedAt).toISOString(),
            records: records.length,
          };
          await persist();
        } catch (error) {
          logger.error?.(`[fomo-thesis] relay websocket message @${handle}: ${error.message}`);
        }
      });
    });
    on?.("close", () => {
      sockets.delete(key);
      if (stopped || !started) return;
      const timer = setTimeout(() => { reconnectTimers.delete(key); attachSocket(handle); }, 5_000);
      timer.unref?.();
      reconnectTimers.set(key, timer);
    });
    on?.("error", (error) => logger.error?.(`[fomo-thesis] relay websocket @${handle}: ${error?.message || "connection error"}`));
  }

  async function start() {
    if (started || config.fomoPublishedCallEnabled !== true || config.fomoPlatformSourcesEnabled === false) return;
    started = true;
    stopped = false;
    await check();
    for (const handle of handles) attachSocket(handle);
    pollTimer = setInterval(() => check().catch((error) => logger.error?.(`[fomo-thesis] poll: ${error.message}`)), intervalMs);
    pollTimer.unref?.();
  }

  async function stop() {
    stopped = true;
    started = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    for (const timer of reconnectTimers.values()) clearTimeout(timer);
    reconnectTimers.clear();
    for (const socket of sockets.values()) {
      try { socket.close(); } catch { /* already closed */ }
    }
    sockets.clear();
    await serial.catch(() => {});
  }

  if (dependencies.autoStart !== false) start().catch((error) => logger.error?.(`[fomo-thesis] startup: ${error.message}`));

  return {
    check,
    start,
    stop,
    stateFile,
    async getState() { await serial.catch(() => {}); await ensureState(); return structuredClone(state); },
  };
}
