import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyFomoXCallText,
  createFomoXCallMonitor,
  selectFomoXCallCandidates,
} from "../src/fomo-x-call-monitor.js";
import { isRelevantAlert } from "../src/alerts.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const TOKEN_TWO = "0x2222222222222222222222222222222222222222";
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const X_ID = "123456789012345678";
const quietLogger = { error() {}, warn() {}, info() {}, log() {} };

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-call-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function candidate(nowMs, overrides = {}) {
  return {
    handle: "alpha",
    wallet: WALLET,
    wallets: [WALLET],
    twitterHandles: ["alpha"],
    ambiguousWallets: false,
    ambiguousHandles: false,
    ambiguousIdentity: false,
    tags: ["kol", "fomo"],
    discoveredAt: nowMs - 10_000,
    source: "gmgn_bsc_kol_feed",
    ...overrides,
  };
}

function timelineTweet(id, text, nowMs, overrides = {}) {
  return {
    id: String(id),
    text,
    created_timestamp: Math.floor(nowMs / 1_000),
    url: `https://x.com/alpha/status/${id}`,
    author: { id: X_ID, screen_name: "alpha", name: "Alpha" },
    replying_to: null,
    ...overrides,
  };
}

function oembed(id, text, overrides = {}) {
  return {
    author_url: "https://x.com/alpha",
    url: `https://x.com/alpha/status/${id}`,
    html: `<blockquote><p>${text}</p>&mdash; Alpha (@alpha) <a href="https://x.com/alpha/status/${id}">August 19, 2026</a></blockquote>`,
    ...overrides,
  };
}

function passQualification() {
  return {
    decision: "pass",
    market: { liquidityUsd: 25_000, pairAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", sellsM5: 3 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
  };
}

function captureLogger() {
  const entries = { error: [], warn: [], info: [], log: [] };
  return {
    entries,
    logger: Object.fromEntries(Object.keys(entries).map((level) => [level, (message) => entries[level].push(String(message))])),
  };
}

function jsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => payload,
  };
}

function config(dataDir, overrides = {}) {
  return {
    dataDir,
    fomoXCallEnabled: true,
    fomoXCallPollIntervalMs: 5_000,
    fomoXCallDiscoveryIntervalMs: 5_000,
    fomoXCallAttributionMaxAgeMs: 86_400_000,
    fomoXCallProfileRefreshMs: 60_000,
    fomoXCallMaxPostAgeMs: 300_000,
    fomoXCallTokenDedupMs: 2_592_000_000,
    fomoXCallMinXFollowers: 10_000,
    fomoXCallMinLiquidityUsd: 10_000,
    fomoXCallCandidateLimit: 100,
    fomoXCallBatchSize: 10,
    fomoXCallConcurrency: 2,
    fomoXCallRequestTimeoutMs: 1_000,
    fomoCallFxTwitterApiBase: "https://api.fxtwitter.test",
    fomoScanApiBase: "https://api.fomoscan.test",
    fomoCallBscRpcUrl: "https://bsc-rpc.test",
    fomoXCallOembedBase: "https://publish.x.test/oembed",
    ...overrides,
  };
}

function createHarness({
  dataDir,
  nowRef,
  rowsRef,
  tweetsRef,
  alerts,
  qualifyCallImpl = async () => passQualification(),
  binding = null,
  requests = [],
  profileRef = { value: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } },
  configOverrides = {},
  discoverVerifiedSeedImpl,
  resolveBindingImpl,
  fetchImpl,
  logger = quietLogger,
}) {
  const tweetArchive = new Map();
  return createFomoXCallMonitor(config(dataDir, configOverrides), {
    autoStart: false,
    now: () => nowRef.value,
    logger,
    discoverCandidatesImpl: async () => rowsRef.value,
    getBscActivityImpl: async () => 7,
    resolveVerifiedBindingImpl: resolveBindingImpl || (async (candidateRow) => binding || candidateRow.walletBinding || null),
    discoverVerifiedSeedImpl,
    qualifyCallImpl,
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
    fetchImpl: fetchImpl || (async (url) => {
      requests.push(url);
      if (url === "https://api.fxtwitter.test/2/profile/alpha") {
        return { ok: true, status: 200, json: async () => ({ code: 200, user: profileRef.value }) };
      }
      if (url === `https://api.fxtwitter.test/2/profile/id:${X_ID}/statuses?count=40`) {
        for (const tweet of tweetsRef.value) tweetArchive.set(String(tweet.id), tweet);
        return { ok: true, status: 200, json: async () => ({ code: 200, results: tweetsRef.value }) };
      }
      if (url.startsWith("https://publish.x.test/oembed?")) {
        const requested = new URL(url).searchParams.get("url");
        const id = requested.match(/\/status\/(\d+)$/)?.[1];
        const tweet = tweetsRef.value.find((item) => String(item.id) === id) || tweetArchive.get(String(id));
        return { ok: true, status: 200, text: async () => JSON.stringify(oembed(id, tweet.text)) };
      }
      throw new Error(`unexpected URL ${url}`);
    }),
  });
}

test("call text requires an explicit call word and exactly one EVM contract", () => {
  assert.deepEqual(classifyFomoXCallText(`Buying this now. CA ${TOKEN}`), {
    relevant: true,
    reason: "explicit_call_with_exact_contract",
    token: TOKEN,
  });
  assert.equal(classifyFomoXCallText(`Contract: ${TOKEN}`).reason, "missing_first_person_positive_call");
  assert.equal(classifyFomoXCallText("Buying this now").reason, "missing_contract_address");
  assert.equal(classifyFomoXCallText(`I am buying ${TOKEN} and ${TOKEN_TWO}`).reason, "ambiguous_contract_addresses");
  assert.equal(classifyFomoXCallText("买入 0xnotanaddress").reason, "missing_contract_address");
  assert.equal(classifyFomoXCallText(`Do not buy this scam. CA ${TOKEN}`).reason, "negative_exit_or_warning_language");
  assert.equal(classifyFomoXCallText(`I sold my position. CA ${TOKEN}`).reason, "negative_exit_or_warning_language");
  assert.equal(classifyFomoXCallText(`不要买这个貔貅盘 ${TOKEN}`).reason, "negative_exit_or_warning_language");
  assert.equal(classifyFomoXCallText(`Scam warning: avoid this CA ${TOKEN}`).reason, "negative_exit_or_warning_language");
  assert.equal(classifyFomoXCallText(`I am short this. CA ${TOKEN}`).reason, "negative_exit_or_warning_language");
  assert.equal(classifyFomoXCallText(`This token has buy pressure. CA ${TOKEN}`).reason, "missing_first_person_positive_call");
});

test("roster admits only recent clean unique kol+fomo mappings without ranking by trades", () => {
  const nowMs = Date.parse("2026-08-19T06:00:00.000Z");
  const secondWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const sharedWallet = "0xcccccccccccccccccccccccccccccccccccccccc";
  const selected = selectFomoXCallCandidates([
    candidate(nowMs, { handle: "clean", twitterHandles: ["clean"], numTrades: 1 }),
    candidate(nowMs, { handle: "wash", twitterHandles: ["wash"], wallet: secondWallet, wallets: [secondWallet], tags: ["kol", "fomo", "wash_trader"], numTrades: 99_999 }),
    candidate(nowMs, { handle: "arb", twitterHandles: ["arb"], wallet: "0xdddddddddddddddddddddddddddddddddddddddd", wallets: ["0xdddddddddddddddddddddddddddddddddddddddd"], tags: ["kol", "fomo", "arbitrager"] }),
    candidate(nowMs, { handle: "ambiguous", twitterHandles: ["ambiguous"], wallet: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", wallets: ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", WALLET], ambiguousWallets: true }),
    candidate(nowMs, { handle: "stale", twitterHandles: ["stale"], wallet: "0xffffffffffffffffffffffffffffffffffffffff", wallets: ["0xffffffffffffffffffffffffffffffffffffffff"], discoveredAt: nowMs - 86_400_001 }),
    candidate(nowMs, { handle: "shared_a", twitterHandles: ["shared_a"], wallet: sharedWallet, wallets: [sharedWallet] }),
    candidate(nowMs, { handle: "shared_b", twitterHandles: ["shared_b"], wallet: sharedWallet, wallets: [sharedWallet] }),
  ], { nowMs, maximumAgeMs: 86_400_000 });
  assert.deepEqual(selected.map(({ handle }) => handle), ["clean"]);
  assert.equal(selected[0].source, "gmgn_bsc_kol_feed");
  assert.equal(selected[0].candidateSource, "gmgn_bsc_kol_feed");
  assert.equal(selected[0].origin, "gmgn_bsc_kol_feed");
  assert.equal(selected[0].fomoTagged, true);
});

test("first timeline is silent; a new oEmbed-verified X call emits one observed-attribution event", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T06:00:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("100", "ordinary baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const requests = [];
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, requests });

  assert.equal((await monitor.check()).status, "healthy");
  assert.equal(alerts.length, 0);
  assert.equal(requests.some((url) => url.startsWith("https://publish.x.test/oembed?")), false, "baseline must not call oEmbed");

  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("101", `Buying the breakout. CA ${TOKEN}`, nowRef.value - 500),
    ...tweetsRef.value,
  ];
  const result = await monitor.check();
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  const event = alerts[0];
  assert.equal(event.type, "fomo_family_top_call");
  assert.equal(event.signalKind, "fomo_x_call");
  assert.equal(event.source.id, "fomo_linked_x_post");
  assert.equal(event.source.trust, "public_x_identity_linked");
  assert.equal(event.sourceTrust, "public_x_identity_linked");
  assert.equal(event.candidateSource, "gmgn_bsc_kol_feed");
  assert.equal(event.origin, "gmgn_bsc_kol_feed");
  assert.equal(event.official, false);
  assert.equal(event.fomoOfficial, false);
  assert.deepEqual(event.tweet, {
    id: "101",
    url: "https://x.com/alpha/status/101",
    handle: "alpha",
    xUserId: X_ID,
    sourceVerifiedBy: "official_x_oembed",
    text: `Buying the breakout. CA ${TOKEN}`,
    createdAt: new Date(Math.floor((nowRef.value - 500) / 1_000) * 1_000).toISOString(),
  });
  assert.deepEqual(event.caller, {
    handle: "alpha",
    twitter: "https://x.com/alpha",
    xProfileId: X_ID,
    followers: 25_000,
    followersSyncedAt: new Date(nowRef.value - 5_000).toISOString(),
    identitySource: "gmgn+fxtwitter",
    bscTransactionCount: 7,
    bscActivityCheckedAt: new Date(nowRef.value - 5_000).toISOString(),
  });
  assert.equal(event.walletAddress, WALLET);
  assert.equal(event.walletBinding, null);
  assert.deepEqual(event.walletAttribution, {
    scheme: "gmgn_x_maker_observation_v1",
    status: "observed",
    verified: false,
    source: "gmgn_bsc_kol_feed",
    candidateSource: "gmgn_bsc_kol_feed",
    origin: "gmgn_bsc_kol_feed",
    monitoringWallet: WALLET,
    xHandle: "alpha",
    xProfileId: X_ID,
    tags: ["kol", "fomo"],
    fomoTagged: true,
    ambiguousIdentity: false,
    ambiguousWallets: false,
    ambiguousHandles: false,
    observedAt: new Date(rowsRef.value[0].discoveredAt).toISOString(),
    xFollowersCheckedAt: new Date(nowRef.value - 5_000).toISOString(),
    bscActivityCheckedAt: new Date(nowRef.value - 5_000).toISOString(),
    bscTransactionCount: 7,
  });
  assert.equal(event.chain.id, 56);
  assert.equal(event.token, TOKEN);
  assert.equal(event.market.liquidityUsd, 25_000);
  assert.equal(event.security.decision, "pass");
  const routeConfig = {
    ...config(dataDir),
    monitorScope: "focus3",
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoCallAllowGmgnObservedWallets: true,
    fomoCallGmgnAttributionMaxAgeMs: 86_400_000,
  };
  assert.equal(isMonitoringSourceEnabled(routeConfig, event), true, "the monitor's real observed event shape must pass focus routing");
  assert.equal(isRelevantAlert(event), true, "the monitor's real observed event shape must pass alert relevance");

  const state = await monitor.getState();
  assert.equal(state.alertedTokens[TOKEN].tweetId, "101");
  assert.equal(Object.keys(state.pending).length, 0);
  const mode = (await fs.stat(path.join(dataDir, "fomo-x-call-state.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("reply, repost, weak text and ambiguous CA are ignored before oEmbed", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T07:00:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("200", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const requests = [];
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, requests });
  await monitor.check();
  requests.length = 0;

  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("205", `Buying ${TOKEN} and ${TOKEN_TWO}`, nowRef.value - 100),
    timelineTweet("204", `CA ${TOKEN}`, nowRef.value - 200),
    timelineTweet("203", `Buying ${TOKEN}`, nowRef.value - 300, { replying_to: "10" }),
    timelineTweet("202", `Buying ${TOKEN}`, nowRef.value - 400, { author: { id: "999", screen_name: "foreign" }, reposted_by: { id: X_ID, screen_name: "alpha" }, url: "https://x.com/foreign/status/202" }),
    ...tweetsRef.value,
  ];
  await monitor.check();
  assert.equal(alerts.length, 0);
  assert.equal(requests.some((url) => url.startsWith("https://publish.x.test/oembed?")), false);
});

test("local security failure remains pending and is retried even after the cursor advances", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T08:00:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("300", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  let attempts = 0;
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    qualifyCallImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? { decision: "block", reason: "liquidity_not_confirmed", market: { liquidityUsd: 50_000 }, security: { decision: "block", metrics: { liquidityConfirmed: false, sellObserved: true } } }
        : passQualification();
    },
  });
  await monitor.check();
  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("301", `Accumulating now. CA ${TOKEN}`, nowRef.value - 100), ...tweetsRef.value];
  await monitor.check();
  let state = await monitor.getState();
  assert.equal(alerts.length, 0);
  assert.ok(state.pending["alpha:301"]);
  assert.equal(state.pending["alpha:301"].tweet.id, "301");
  assert.equal(state.cursors.alpha, "301");

  nowRef.value += 5_000;
  tweetsRef.value = tweetsRef.value.filter((tweet) => tweet.id !== "301");
  await monitor.check();
  state = await monitor.getState();
  assert.equal(alerts.length, 1);
  assert.equal(attempts, 2);
  assert.equal(state.pending["alpha:301"], undefined);

  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("302", `Buying again. CA ${TOKEN}`, nowRef.value - 100), ...tweetsRef.value];
  await monitor.check();
  assert.equal(alerts.length, 1, "the same token is globally deduplicated after durable acceptance");
});

test("a pending tweet snapshot expires after ten minutes and cannot replay from an old timeline gap", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T08:30:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("350", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  let attempts = 0;
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    configOverrides: { fomoXCallPendingMaxAgeMs: 600_000 },
    qualifyCallImpl: async () => {
      attempts += 1;
      return {
        decision: "block",
        reason: "liquidity_not_confirmed",
        market: { liquidityUsd: 50_000 },
        security: { decision: "block", metrics: { liquidityConfirmed: false, sellObserved: true } },
      };
    },
  });
  await monitor.check();
  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("351", `I am accumulating now. CA ${TOKEN}`, nowRef.value - 100), ...tweetsRef.value];
  await monitor.check();
  assert.ok((await monitor.getState()).pending["alpha:351"]);
  assert.equal(attempts, 1);

  nowRef.value += 600_001;
  rowsRef.value = [candidate(nowRef.value)];
  tweetsRef.value = tweetsRef.value.filter((tweet) => tweet.id !== "351");
  await monitor.check();
  const state = await monitor.getState();
  assert.equal(state.pending["alpha:351"], undefined);
  assert.equal(attempts, 1, "expired snapshots must not be re-qualified or replayed");
  assert.equal(alerts.length, 0);
});

test("a FomoScan-exact wallet match emits binding rather than GMGN observed attribution", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.now() };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("400", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const binding = {
    status: "verified",
    verified: true,
    proofSource: "fomoscan",
    wallet: WALLET,
    handle: "alpha",
    twitterHandle: "alpha",
    verifiedAt: new Date(nowRef.value - 300_000).toISOString(),
    lastCheckedAt: new Date(nowRef.value - 60_000).toISOString(),
  };
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, binding });
  await monitor.check();
  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("401", `Bullish and buying. CA ${TOKEN}`, nowRef.value - 100), ...tweetsRef.value];
  await monitor.check();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].walletBinding, { ...binding, checkedAt: binding.lastCheckedAt, xProfileId: X_ID });
  assert.equal("walletAttribution" in alerts[0], false);
  assert.deepEqual(alerts[0].identityLink, { state: "verified_wallet", source: "fomoscan+fxtwitter" });
  assert.equal(alerts[0].caller.identitySource, "fomoscan+fxtwitter");
  const routeConfig = {
    ...config(dataDir), monitorScope: "focus3", fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false, fomoCallAllowGmgnObservedWallets: true,
  };
  assert.equal(isMonitoringSourceEnabled(routeConfig, alerts[0]), true);
  assert.equal(isRelevantAlert(alerts[0]), true);
  const stale = structuredClone(alerts[0]);
  stale.walletBinding.checkedAt = new Date(Date.now() - 86_500_000).toISOString();
  stale.walletBinding.lastCheckedAt = stale.walletBinding.checkedAt;
  assert.equal(isMonitoringSourceEnabled(routeConfig, stale), false);
  assert.equal(isRelevantAlert(stale), false);
});

test("an empty first timeline stays uninitialized until a non-empty snapshot can be silently baselined", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-19T10:00:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const tweetsRef = { value: [] };
  const alerts = [];
  const requests = [];
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, requests });
  await monitor.check();
  let state = await monitor.getState();
  assert.equal(state.initialized.alpha, undefined);
  assert.equal(alerts.length, 0);

  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("502", `Buying the fresh call. CA ${TOKEN}`, nowRef.value - 1_000),
    timelineTweet("501", `Buying an old snapshot item. CA ${TOKEN_TWO}`, startedAt - 60_000),
  ];
  await monitor.check();
  state = await monitor.getState();
  assert.equal(alerts.length, 0);
  assert.equal(state.cursors.alpha, "502");
  assert.equal(requests.some((url) => url.startsWith("https://publish.x.test/oembed?")), false);

  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("503", `I am buying the first post after baseline. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  await monitor.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tweet.id, "503");
});

test("a clean GMGN mapping is revoked immediately when a later snapshot is dirty or ambiguous", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T11:00:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("600", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts });
  await monitor.check();
  assert.ok((await monitor.getState()).roster.alpha);

  nowRef.value += 5_000;
  rowsRef.value = [candidate(nowRef.value, { tags: ["kol", "fomo", "wash_trader"] })];
  const result = await monitor.check();
  const state = await monitor.getState();
  assert.equal(result.status, "healthy_no_candidates");
  assert.equal(state.roster.alpha, undefined);
  assert.equal(state.initialized.alpha, undefined);
  assert.equal(state.cursors.alpha, undefined);

  nowRef.value += 5_000;
  rowsRef.value = [candidate(nowRef.value)];
  await monitor.check();
  assert.ok((await monitor.getState()).roster.alpha);

  nowRef.value += 5_000;
  rowsRef.value = [candidate(nowRef.value, { twitterHandles: ["alpha", "beta"], ambiguousHandles: true })];
  await monitor.check();
  assert.equal((await monitor.getState()).roster.alpha, undefined);
});

test("a changed wallet clears the old cursor and silently re-baselines the new attribution", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T12:00:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("700", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    qualifyCallImpl: async () => ({
      decision: "block",
      reason: "liquidity_not_confirmed",
      market: { liquidityUsd: 20_000 },
      security: { decision: "block", metrics: { liquidityConfirmed: false, sellObserved: true } },
    }),
  });
  await monitor.check();

  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("701", `I am buying before the wallet changes. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  await monitor.check();
  assert.ok((await monitor.getState()).pending["alpha:701"]);

  const replacement = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  nowRef.value += 5_000;
  rowsRef.value = [candidate(nowRef.value, { wallet: replacement, wallets: [replacement] })];
  tweetsRef.value = [timelineTweet("702", `I am buying after a wallet change. CA ${TOKEN_TWO}`, nowRef.value - 500), ...tweetsRef.value];
  await monitor.check();
  const state = await monitor.getState();
  assert.equal(alerts.length, 0, "a post from before the new wallet baseline must not be re-attributed");
  assert.equal(state.roster.alpha.wallet, replacement);
  assert.equal(state.cursors.alpha, "702");
  assert.deepEqual(state.pending, {});
});

test("an ineligible X profile is cached instead of being requested every five seconds", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T13:00:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [] };
  const alerts = [];
  const requests = [];
  const profileRef = { value: { id: X_ID, screen_name: "alpha", followers: 9_999, protected: false } };
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, requests, profileRef });
  const first = await monitor.check();
  assert.equal(first.status, "healthy_no_admitted");
  nowRef.value += 5_000;
  const second = await monitor.check();
  assert.equal(second.status, "healthy_no_admitted");
  assert.equal(requests.filter((url) => url.endsWith("/2/profile/alpha")).length, 1);
  const state = await monitor.getState();
  assert.equal(state.health.rejectedCount, 1);
  assert.equal(state.health.sources.x.failures, 0);
});

test("fresh FomoScan verified public handles seed the roster without a GMGN trade", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:00:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("800", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const checkedAt = new Date(nowRef.value).toISOString();
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    configOverrides: { fomoCallPublicHandles: ["alpha"] },
    discoverVerifiedSeedImpl: async (handle) => ({
      ...candidate(nowRef.value),
      handle,
      twitterHandles: [handle],
      source: "fomoscan_verified_profile",
      walletBinding: {
        status: "verified", verified: true, proofSource: "fomoscan", wallet: WALLET,
        handle, twitterHandle: handle, checkedAt, lastCheckedAt: checkedAt,
      },
    }),
  });
  const result = await monitor.check();
  const state = await monitor.getState();
  assert.equal(result.status, "healthy");
  assert.equal(result.admitted, 1);
  assert.equal(state.roster.alpha.source, "fomoscan_verified_profile");
  assert.equal(state.roster.alpha.walletBinding.verified, true);
  assert.equal(state.health.sources.fomoscanSeeds.verified, 1);
  assert.equal(alerts.length, 0);
});

test("a FomoScan seed without a fresh verified binding is rejected and never downgraded to GMGN attribution", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:10:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("820", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    configOverrides: { fomoCallPublicHandles: ["alpha"] },
    discoverVerifiedSeedImpl: async (handle) => ({
      ...candidate(nowRef.value),
      handle,
      twitterHandles: [handle],
      source: "fomoscan_verified_profile",
      walletBinding: null,
    }),
  });
  const result = await monitor.check();
  const state = await monitor.getState();
  assert.equal(result.status, "healthy_no_candidates");
  assert.equal(state.roster.alpha, undefined);
  assert.equal(alerts.length, 0);
});

test("a transient FomoScan binding refresh failure preserves the last successful binding for at most its freshness window", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:20:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("830", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const checkedAt = new Date(nowRef.value).toISOString();
  const binding = {
    status: "verified", verified: true, proofSource: "fomoscan", wallet: WALLET,
    handle: "alpha", twitterHandle: "alpha", checkedAt, lastCheckedAt: checkedAt,
  };
  let resolveAttempts = 0;
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    configOverrides: { fomoCallPublicHandles: ["alpha"], fomoXCallVerifiedSeedRefreshMs: 60_000 },
    discoverVerifiedSeedImpl: async (handle) => ({
      ...candidate(nowRef.value), handle, twitterHandles: [handle], source: "fomoscan_verified_profile", walletBinding: binding,
    }),
    resolveBindingImpl: async () => {
      resolveAttempts += 1;
      if (resolveAttempts > 1) throw new Error("temporary FomoScan 503");
      return binding;
    },
  });
  await monitor.check();
  nowRef.value += 60_000;
  tweetsRef.value = [timelineTweet("831", `I am buying this. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  const result = await monitor.check();
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].walletBinding.proofSource, "fomoscan");
  assert.equal(alerts[0].walletBinding.checkedAt, checkedAt);
  assert.equal(alerts[0].walletBinding.xProfileId, X_ID);
  assert.equal("walletAttribution" in alerts[0], false);
});

test("a fresh persisted legacy FomoScan seed can migrate its proof cache once without affecting GMGN candidates", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:25:00.000Z") };
  const legacy = candidate(nowRef.value, { source: "fomoscan_verified_profile" });
  await fs.writeFile(path.join(dataDir, "fomo-x-call-state.json"), `${JSON.stringify({
    version: 2,
    roster: { alpha: legacy },
    discoveryCheckedAt: new Date(nowRef.value).toISOString(),
  })}\n`);
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("840", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    resolveBindingImpl: async () => { throw new Error("temporary FomoScan 503"); },
  });
  const result = await monitor.check();
  const state = await monitor.getState();
  assert.equal(result.status, "healthy");
  assert.equal(state.roster.alpha.walletBinding.cacheMigrated, true);
  assert.equal(state.roster.alpha.walletBinding.proofSource, "fomoscan");
  assert.equal(state.roster.alpha.walletBinding.checkedAt, new Date(legacy.discoveredAt).toISOString());
});

test("a partial FomoScan seed check retries only failed handles on a bounded backoff", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:30:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("850", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const calls = [];
  let betaAttempts = 0;
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    configOverrides: {
      fomoCallPublicHandles: ["alpha", "beta"],
      fomoXCallVerifiedSeedRetryMs: 60_000,
      fomoXCallVerifiedSeedRefreshMs: 1_800_000,
    },
    discoverVerifiedSeedImpl: async (handle) => {
      calls.push(handle);
      if (handle === "beta") {
        betaAttempts += 1;
        if (betaAttempts === 1) throw new Error("HTTP 503");
        return null;
      }
      const checkedAt = new Date(nowRef.value).toISOString();
      return {
        ...candidate(nowRef.value), handle, twitterHandles: [handle], source: "fomoscan_verified_profile",
        walletBinding: {
          status: "verified", verified: true, proofSource: "fomoscan", wallet: WALLET,
          handle, twitterHandle: handle, checkedAt, lastCheckedAt: checkedAt,
        },
      };
    },
  });
  await monitor.check();
  assert.deepEqual(calls.sort(), ["alpha", "beta"]);
  let state = await monitor.getState();
  assert.equal(state.health.sources.fomoscanSeeds.status, "partial");
  assert.deepEqual(Object.keys(state.verifiedSeedFailures), ["beta"]);

  nowRef.value += 5_000;
  await monitor.check();
  assert.equal(calls.length, 2, "failed seeds must not retry every five seconds");

  nowRef.value += 55_000;
  await monitor.check();
  state = await monitor.getState();
  assert.deepEqual(calls, ["alpha", "beta", "beta"]);
  assert.deepEqual(state.verifiedSeedFailures, {});
  assert.equal(state.health.sources.fomoscanSeeds.status, "healthy");
});

test("empty discovery is healthy but has no admitted identities and never sends", async (t) => {
  const dataDir = await fixture(t);
  const monitor = createFomoXCallMonitor(config(dataDir), {
    autoStart: false,
    logger: quietLogger,
    discoverCandidatesImpl: async () => [],
    sendAlertsImpl: async () => { throw new Error("must not send"); },
  });
  const result = await monitor.check();
  assert.equal(result.status, "healthy_no_candidates");
  const state = await monitor.getState();
  assert.equal(state.health.status, "healthy_no_candidates");
  assert.equal(state.health.sources.gmgn.status, "healthy");
  assert.equal(state.health.eligibleCount, 0);
});

test("a profile 404 opens a six-hour per-handle circuit that survives restart while other handles continue", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:30:00.000Z");
  const nowRef = { value: startedAt };
  const betaWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const betaId = "223456789012345678";
  const favezyId = "323456789012345678";
  const rowsRef = { value: [
    candidate(startedAt, { handle: "favezy_", twitterHandles: ["favezy_"] }),
    candidate(startedAt, { handle: "beta", twitterHandles: ["beta"], wallet: betaWallet, wallets: [betaWallet] }),
  ] };
  const requests = [];
  const { logger, entries } = captureLogger();
  let favezyAvailable = false;
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/2/profile/favezy_")) {
      return favezyAvailable
        ? jsonResponse(200, { code: 200, user: { id: favezyId, screen_name: "favezy_", followers: 25_000, protected: false } })
        : jsonResponse(404, { code: 404, message: "User not found" });
    }
    if (url.endsWith("/2/profile/beta")) {
      return jsonResponse(200, { code: 200, user: { id: betaId, screen_name: "beta", followers: 25_000, protected: false } });
    }
    if (url.includes(`/2/profile/id:${betaId}/statuses`)) {
      return jsonResponse(200, { code: 200, results: [timelineTweet("700", "beta baseline", startedAt - 1_000, {
        author: { id: betaId, screen_name: "beta", name: "Beta" }, url: "https://x.com/beta/status/700",
      })] });
    }
    if (url.includes(`/2/profile/id:${favezyId}/statuses`)) {
      return jsonResponse(200, { code: 200, results: [timelineTweet("800", "favezy baseline", nowRef.value - 1_000, {
        author: { id: favezyId, screen_name: "favezy_", name: "Favezy" }, url: "https://x.com/favezy_/status/800",
      })] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const harnessOptions = {
    dataDir, nowRef, rowsRef, tweetsRef: { value: [] }, alerts: [], fetchImpl, logger,
    configOverrides: { fomoXCallProfileRefreshMs: 86_400_000 },
  };

  let monitor = createHarness(harnessOptions);
  await monitor.check();
  let state = await monitor.getState();
  const circuitKey = "fxtwitter_profile:favezy_";
  assert.equal(state.transportCircuits[circuitKey].reason, "http_404");
  assert.equal(state.transportCircuits[circuitKey].nextRetryAt, startedAt + 6 * 60 * 60_000);
  assert.equal(state.cursors.favezy_, undefined);
  assert.deepEqual(Object.keys(state.seenTweets).filter((key) => key.startsWith("favezy_:")), []);
  assert.equal(state.cursors.beta, "700", "the healthy handle must still baseline in the same batch");
  assert.equal(entries.warn.length, 1);
  assert.match(entries.warn[0], /fxtwitter_profile @favezy_ http_404/);
  assert.equal(entries.error.length, 0);

  nowRef.value = startedAt + 2 * 60 * 60_000;
  monitor = createHarness(harnessOptions);
  await monitor.check();
  assert.equal(requests.filter((url) => url.endsWith("/2/profile/favezy_")).length, 1, "restart must retain the open circuit");
  assert.equal(requests.filter((url) => url.includes(`/2/profile/id:${betaId}/statuses`)).length, 2, "other handles must continue polling");
  assert.equal(entries.warn.length, 1, "an open circuit must not repeat its transition log");

  nowRef.value = startedAt + 6 * 60 * 60_000 - 1;
  await monitor.check();
  assert.equal(requests.filter((url) => url.endsWith("/2/profile/favezy_")).length, 1);
  favezyAvailable = true;
  nowRef.value = startedAt + 6 * 60 * 60_000;
  await monitor.check();
  state = await monitor.getState();
  assert.equal(requests.filter((url) => url.endsWith("/2/profile/favezy_")).length, 2);
  assert.equal(state.transportCircuits[circuitKey], undefined);
  assert.equal(state.cursors.favezy_, "800");
  assert.equal(entries.info.filter((message) => message.includes("fxtwitter_profile @favezy_ recovered")).length, 1);
});

test("an open transport circuit outside the current batch keeps X health source-limited until its successful probe", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:45:00.000Z");
  const nowRef = { value: startedAt };
  const betaWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const gammaWallet = "0xcccccccccccccccccccccccccccccccccccccccc";
  const identities = {
    alpha: { id: X_ID, wallet: WALLET },
    beta: { id: "223456789012345678", wallet: betaWallet },
    gamma: { id: "323456789012345678", wallet: gammaWallet },
  };
  const rowsRef = { value: Object.entries(identities).map(([handle, identity]) => candidate(startedAt, {
    handle,
    wallet: identity.wallet,
    wallets: [identity.wallet],
    twitterHandles: [handle],
  })) };
  const requests = [];
  const { logger, entries } = captureLogger();
  let alphaAvailable = false;
  const fetchImpl = async (url) => {
    requests.push(url);
    for (const [handle, identity] of Object.entries(identities)) {
      if (url.endsWith(`/2/profile/${handle}`)) {
        if (handle === "alpha" && !alphaAvailable) return jsonResponse(404, { code: 404, message: "User not found" });
        return jsonResponse(200, { code: 200, user: {
          id: identity.id,
          screen_name: handle,
          followers: 25_000,
          protected: false,
        } });
      }
      if (url.includes(`/2/profile/id:${identity.id}/statuses`)) {
        return jsonResponse(200, { code: 200, results: [timelineTweet(handle === "alpha" ? "100" : handle === "beta" ? "200" : "300", `${handle} baseline`, nowRef.value - 1_000, {
          author: { id: identity.id, screen_name: handle, name: handle },
          url: `https://x.com/${handle}/status/${handle === "alpha" ? "100" : handle === "beta" ? "200" : "300"}`,
        })] });
      }
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef: { value: [] },
    alerts: [],
    fetchImpl,
    logger,
    configOverrides: { fomoXCallBatchSize: 1, fomoXCallProfileRefreshMs: 86_400_000 },
  });

  await monitor.check();
  let state = await monitor.getState();
  const circuitKey = "fxtwitter_profile:alpha";
  const retryAt = startedAt + 6 * 60 * 60_000;
  assert.equal(state.transportCircuits[circuitKey].nextRetryAt, retryAt);
  assert.equal(state.health.status, "degraded");
  assert.equal(state.health.sources.x.status, "partial");
  assert.equal(state.health.sources.x.coverage, "source_limited");
  assert.equal(state.health.sources.x.transportBackoffs, 1);
  assert.equal(state.health.sources.x.transportOpen, 1);
  assert.equal(state.health.sources.x.transportProbeDue, 0);
  assert.deepEqual(state.health.sources.x.handles, ["alpha"]);
  assert.deepEqual(state.health.sources.x.reasons, ["http_404"]);
  assert.equal(state.health.sources.x.nextRetryAt, new Date(retryAt).toISOString());
  assert.match(state.health.lastError, /coverage limited/);

  nowRef.value += 5_000;
  const healthyHandleBatch = await monitor.check();
  state = await monitor.getState();
  assert.equal(healthyHandleBatch.status, "degraded", "a healthy beta batch cannot hide alpha's persisted coverage gap");
  assert.equal(state.cursors.beta, "200", "other handles continue while alpha is cooling down");
  assert.equal(requests.filter((url) => url.endsWith("/2/profile/alpha")).length, 1);
  assert.equal(state.health.sources.x.transportBackoffs, 1);
  assert.deepEqual(state.health.sources.x.handles, ["alpha"]);

  nowRef.value = retryAt;
  const dueOutsideBatch = await monitor.check();
  state = await monitor.getState();
  assert.equal(dueOutsideBatch.status, "degraded");
  assert.equal(state.cursors.gamma, "300");
  assert.equal(state.health.sources.x.status, "partial");
  assert.equal(state.health.sources.x.transportOpen, 0);
  assert.equal(state.health.sources.x.transportProbeDue, 1);
  assert.equal(state.health.sources.x.nextRetryAt, new Date(retryAt).toISOString());
  assert.equal(requests.filter((url) => url.endsWith("/2/profile/alpha")).length, 1, "a due circuit is probe_due until its handle rotates into the batch");

  alphaAvailable = true;
  const recovered = await monitor.check();
  state = await monitor.getState();
  assert.equal(recovered.status, "healthy");
  assert.equal(state.transportCircuits[circuitKey], undefined);
  assert.equal(state.cursors.alpha, "100");
  assert.equal(state.health.status, "healthy");
  assert.equal(state.health.sources.x.status, "healthy");
  assert.equal(state.health.sources.x.coverage, "complete");
  assert.equal(state.health.sources.x.transportBackoffs, 0);
  assert.equal(state.health.sources.x.transportOpen, 0);
  assert.equal(state.health.sources.x.transportProbeDue, 0);
  assert.deepEqual(state.health.sources.x.handles, []);
  assert.deepEqual(state.health.sources.x.reasons, []);
  assert.equal(state.health.sources.x.nextRetryAt, null);
  assert.equal(state.health.lastError, null);
  assert.equal(entries.info.filter((message) => message.includes("fxtwitter_profile @alpha recovered")).length, 1);
});

test("timeline 404 probes are bounded over two hours and never advance cursor or seen state", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T11:00:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const requests = [];
  const { logger, entries } = captureLogger();
  let timelineMode = "baseline";
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/2/profile/alpha")) {
      return jsonResponse(200, { code: 200, user: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } });
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) {
      if (timelineMode === "fail") return jsonResponse(404, { code: 404, message: "Timeline not found" });
      const id = timelineMode === "recovered" ? "101" : "100";
      return jsonResponse(200, { code: 200, results: [timelineTweet(id, "ordinary update", nowRef.value - 1_000)] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef: { value: [] }, alerts: [], fetchImpl, logger,
    configOverrides: { fomoXCallProfileRefreshMs: 86_400_000 },
  });
  await monitor.check();
  assert.equal((await monitor.getState()).cursors.alpha, "100");

  timelineMode = "fail";
  nowRef.value += 5_000;
  const firstFailureAt = nowRef.value;
  await monitor.check();
  for (let elapsed = 5 * 60_000; elapsed <= 2 * 60 * 60_000; elapsed += 5 * 60_000) {
    nowRef.value = firstFailureAt + elapsed;
    await monitor.check();
  }
  let state = await monitor.getState();
  const timelineRequests = () => requests.filter((url) => url.includes(`/2/profile/id:${X_ID}/statuses`)).length;
  assert.equal(timelineRequests(), 4, "baseline plus only the initial, 15-minute, and 1-hour probes are allowed in two hours");
  assert.equal(entries.warn.filter((message) => message.includes("fxtwitter_timeline @alpha http_404")).length, 3);
  assert.equal(entries.error.length, 0);
  assert.equal(state.transportCircuits["fxtwitter_timeline:alpha"].failureCount, 3);
  assert.equal(state.transportCircuits["fxtwitter_timeline:alpha"].nextRetryAt, firstFailureAt + 75 * 60_000 + 6 * 60 * 60_000);
  assert.equal(state.cursors.alpha, "100");
  assert.deepEqual(Object.keys(state.seenTweets), []);

  timelineMode = "recovered";
  nowRef.value = state.transportCircuits["fxtwitter_timeline:alpha"].nextRetryAt;
  await monitor.check();
  state = await monitor.getState();
  assert.equal(timelineRequests(), 5);
  assert.equal(state.transportCircuits["fxtwitter_timeline:alpha"], undefined);
  assert.equal(state.cursors.alpha, "101");
  assert.ok(state.seenTweets["alpha:101"], "the first recovered response must process the unadvanced cursor gap");
  assert.equal(entries.info.filter((message) => message.includes("fxtwitter_timeline @alpha recovered")).length, 1);
});

test("FxTwitter 429 honors Retry-After across skipped checks", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T12:00:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  let available = false;
  let profileRequests = 0;
  const { logger, entries } = captureLogger();
  const fetchImpl = async (url) => {
    if (url.endsWith("/2/profile/alpha")) {
      profileRequests += 1;
      return available
        ? jsonResponse(200, { code: 200, user: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } })
        : jsonResponse(429, { code: 429 }, { "retry-after": "120" });
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) {
      return jsonResponse(200, { code: 200, results: [timelineTweet("200", "baseline", nowRef.value - 1_000)] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef: { value: [] }, alerts: [], fetchImpl, logger });
  await monitor.check();
  let state = await monitor.getState();
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].reason, "http_429");
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].retryAfterMs, 120_000);
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].nextRetryAt, startedAt + 120_000);

  nowRef.value = startedAt + 119_999;
  await monitor.check();
  assert.equal(profileRequests, 1);
  available = true;
  nowRef.value = startedAt + 120_000;
  await monitor.check();
  state = await monitor.getState();
  assert.equal(profileRequests, 2);
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"], undefined);
  assert.equal(entries.warn.length, 1);
  assert.equal(entries.info.filter((message) => message.includes("fxtwitter_profile @alpha recovered")).length, 1);
});

test("FxTwitter timeouts use a short exponential circuit instead of retrying every poll", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T13:00:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  let profileRequests = 0;
  const { logger, entries } = captureLogger();
  const fetchImpl = async (url) => {
    if (!url.endsWith("/2/profile/alpha")) throw new Error(`unexpected URL ${url}`);
    profileRequests += 1;
    throw new DOMException("request timed out", "TimeoutError");
  };
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef: { value: [] }, alerts: [], fetchImpl, logger });
  await monitor.check();
  let state = await monitor.getState();
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].reason, "timeout");
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].nextRetryAt, startedAt + 60_000);

  nowRef.value = startedAt + 59_999;
  await monitor.check();
  assert.equal(profileRequests, 1);
  nowRef.value = startedAt + 60_000;
  await monitor.check();
  state = await monitor.getState();
  assert.equal(profileRequests, 2);
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].failureCount, 2);
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].nextRetryAt, startedAt + 6 * 60_000);
  nowRef.value = startedAt + 6 * 60_000 - 1;
  await monitor.check();
  assert.equal(profileRequests, 2);
  assert.equal(entries.warn.filter((message) => message.includes("fxtwitter_profile @alpha timeout")).length, 2);
  assert.equal(entries.error.length, 0);
});
