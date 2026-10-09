import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";
import {
  classifyFomoXCallText,
  classifyKolSelfLaunchText,
  createFomoXCallMonitor,
  selectFomoXCallCandidates,
} from "../src/fomo-x-call-monitor.js";
import {
  CAPITAL_KOL_CATALOG_PUBLISHED_AT,
  createCapitalKolEventSnapshot,
} from "../src/capital-kol-catalog.js";
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

test("FOMO cancellation skips seed and binding calls but keeps independent GMGN-to-X monitoring", async t => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-10-07T08:00:00Z") };
  const rowsRef = { value: [candidate(nowRef.value)] }, tweetsRef = { value: [] };
  const requests = [], alerts = [];
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, requests, alerts,
    configOverrides: { fomoPlatformSourcesEnabled: false, fomoCallPublicHandles: ["alpha"] },
    discoverVerifiedSeedImpl: async () => { throw new Error("cancelled FOMO source called"); },
    resolveBindingImpl: async () => { throw new Error("cancelled FOMO binding called"); },
  });
  t.after(() => monitor.stop());
  await monitor.check();
  const state = await monitor.getState();
  assert.equal(state.health.sources.fomoscanSeeds.status, "disabled_by_user");
  assert.ok(requests.some(url => url.includes("fxtwitter.test/2/profile/alpha")));
  assert.ok(requests.some(url => url.includes("/statuses?count=40")));
  assert.equal(requests.some(url => url.includes("fomoscan")), false);
  assert.equal(state.roster.alpha.source, "gmgn_bsc_kol_feed");
});

test("X rotation fills cached rejection slots with due timelines and retries the rejection only when due", async t => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-10-07T08:00:00Z") };
  const rowsRef = { value: [candidate(nowRef.value), candidate(nowRef.value - 1000, {
    handle: "beta", twitterHandles: ["beta"], wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    wallets: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  })] };
  const requests = [];
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef: { value: [] }, alerts: [],
    configOverrides: { fomoXCallBatchSize: 1 },
    fetchImpl: async url => {
      requests.push(url);
      const handle = url.endsWith("/alpha") ? "alpha" : "beta";
      return url.includes("/statuses?")
        ? { ok: true, status: 200, json: async () => ({ code: 200, results: [] }) }
        : { ok: true, status: 200, json: async () => ({ code: 200, user: {
          id: handle === "alpha" ? X_ID : "99999", screen_name: handle,
          followers: handle === "alpha" ? 9999 : 25000, protected: false,
        } }) };
    },
  });
  t.after(() => monitor.stop());
  await monitor.check(); // alpha rejected
  nowRef.value += 5000; await monitor.check(); // beta
  nowRef.value += 5000; await monitor.check(); // skip alpha, check beta again
  assert.equal(requests.filter(url => url.endsWith("/alpha")).length, 1);
  assert.equal(requests.filter(url => url.includes("/statuses?")).length, 2);
  let state = await monitor.getState();
  assert.equal(state.health.rejectedCount, 1);
  assert.equal(state.health.backlogCount, 1, "do not hide the rejected identity from coverage");
  nowRef.value = state.roster.alpha.admissionRejectedUntil;
  await monitor.check();
  assert.equal(requests.filter(url => url.endsWith("/alpha")).length, 2);
});

test("cancelled cached FOMO binding cannot block a retained GMGN X profile refresh", async t => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-10-07T08:00:00Z") };
  const rowsRef = { value: [candidate(nowRef.value)] }, tweetsRef = { value: [timelineTweet("900", "baseline", nowRef.value)] };
  const binding = { status: "verified", verified: true, proofSource: "fomoscan", wallet: WALLET,
    handle: "alpha", twitterHandle: "alpha", checkedAt: new Date(nowRef.value).toISOString(), lastCheckedAt: new Date(nowRef.value).toISOString() };
  const first = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts: [], binding });
  await first.check(); await first.stop();
  assert.equal((await first.getState()).roster.alpha.walletBinding.proofSource, "fomoscan");
  nowRef.value += 2 * 60 * 60_000; rowsRef.value = [candidate(nowRef.value)];
  const requests = [];
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts: [], requests,
    configOverrides: { fomoPlatformSourcesEnabled: false },
    resolveBindingImpl: async () => { throw new Error("cancelled binding queried"); },
  });
  t.after(() => monitor.stop());
  await monitor.check();
  const state = await monitor.getState();
  assert.equal(state.roster.alpha.walletBinding, null);
  assert.equal(state.roster.alpha.admissionRejectionReason, undefined);
  assert.ok(requests.some(url => url.includes("/statuses?")));
  assert.equal(state.initialized.alpha.latestId, "900", "existing cursor preserved");
});

function capitalCatalogFixtureDependencies(overrides = {}) {
  const snapshot = {
    schemaVersion: 1,
    catalogVersion: overrides.catalogVersion || "test.1",
    catalogHash: overrides.catalogHash || `sha256:${"a".repeat(64)}`,
    catalogId: "alpha-capital",
    subjectType: "person",
    handle: "alpha",
    xUserId: X_ID,
    canonicalName: "Alpha Capital",
    category: "web2_tech",
    affiliation: { name: "Alpha Labs", officialDomains: ["alpha.example"] },
    background: {
      zh: "Alpha Labs 创始人兼首席执行官，长期参与科技与人工智能投资。",
      en: "Founder and CEO of Alpha Labs, active in technology and artificial-intelligence investing.",
    },
    backgroundEvidence: [{
      kind: "official_role",
      url: "https://alpha.example/leadership",
      status: "primary_verified",
      checkedAt: "2026-09-06",
    }],
    reviewStatus: "reviewed",
    identityKey: `capital-kol:x:${X_ID}`,
  };
  const entry = {
    id: snapshot.catalogId,
    subjectType: "person",
    handle: snapshot.handle,
    expectedXUserId: snapshot.xUserId,
    canonicalName: snapshot.canonicalName,
    category: snapshot.category,
  };
  return {
    snapshot,
    dependencies: {
      listCapitalKolsImpl: () => [entry],
      verifyCapitalKolCatalogIntegrityImpl: () => ({ valid: true, reasons: [] }),
      capitalKolCatalogFreshnessImpl: () => ({ valid: true, ageMs: 0 }),
      getCapitalKolCatalogManifestImpl: () => ({
        version: snapshot.catalogVersion,
        hash: snapshot.catalogHash,
        publishedAt: "2026-09-06T00:00:00.000Z",
        count: 1,
        categories: [snapshot.category],
        followersPolicy: "display_only",
      }),
      createCapitalKolEventSnapshotImpl: (value) => {
        const handle = typeof value === "string" ? value : value?.handle;
        return String(handle || "").toLowerCase() === "alpha" ? structuredClone(snapshot) : null;
      },
      bindCapitalKolRuntimeIdentityImpl: (observation) => String(observation?.xUserId) === X_ID
        && String(observation?.observedHandle).toLowerCase() === "alpha"
        ? {
          status: "admitted",
          monitorEligible: true,
          snapshot: structuredClone(snapshot),
          binding: { handle: "alpha", xUserId: X_ID, source: "fxtwitter_public_profile", observedAt: observation.observedAt },
        }
        : { status: "quarantined", monitorEligible: false, reason: "expected_x_user_id_mismatch" },
    },
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
    kolLaunchMonitorEnabled: false,
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
  getBscActivityImpl = async () => 7,
  sendAlertsImpl,
  fetchImpl,
  logger = quietLogger,
  extraDependencies = {},
}) {
  const tweetArchive = new Map();
  return createFomoXCallMonitor(config(dataDir, configOverrides), {
    autoStart: false,
    now: () => nowRef.value,
    logger,
    discoverCandidatesImpl: async () => rowsRef.value,
    ...(getBscActivityImpl === null ? {} : { getBscActivityImpl }),
    resolveVerifiedBindingImpl: resolveBindingImpl || (async (candidateRow) => binding || candidateRow.walletBinding || null),
    discoverVerifiedSeedImpl,
    qualifyCallImpl,
    sendAlertsImpl: sendAlertsImpl || (async (_config, event) => { alerts.push(event); return { status: "delivered" }; }),
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
    ...extraDependencies,
  });
}

async function baselineVerifiedSeed({ dataDir, nowRef, tweetsRef, baselineId = "900" }) {
  const checkedAt = new Date(nowRef.value).toISOString();
  const binding = {
    status: "verified",
    verified: true,
    proofSource: "fomoscan",
    wallet: WALLET,
    handle: "alpha",
    twitterHandle: "alpha",
    checkedAt,
    lastCheckedAt: checkedAt,
  };
  tweetsRef.value = [timelineTweet(baselineId, "verified seed baseline", nowRef.value - 1_000)];
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef: { value: [] },
    tweetsRef,
    alerts: [],
    configOverrides: { fomoCallPublicHandles: ["alpha"] },
    discoverVerifiedSeedImpl: async () => ({
      ...candidate(nowRef.value),
      source: "fomoscan_verified_profile",
      walletBinding: binding,
    }),
  });
  await monitor.check();
  await monitor.waitForDiscovery();
  await monitor.check();
  await monitor.stop();
  return binding;
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

test("self-launch text requires original, recent BSC issuer language and one explicitly labeled contract", () => {
  assert.deepEqual(classifyKolSelfLaunchText(`I just launched my token on BNB Smart Chain. CA ${TOKEN}`), {
    relevant: true,
    launchLanguage: true,
    reason: "self_declared_launch_with_exact_contract",
    token: TOKEN,
  });
  assert.equal(classifyKolSelfLaunchText(`我刚发了一个币，在 BNB链。CA ${TOKEN}`).relevant, true);
  assert.equal(classifyKolSelfLaunchText(`Official contract: ${TOKEN}`).reason, "missing_first_person_launch_language");
  assert.equal(classifyKolSelfLaunchText(`Official token is live. CA ${TOKEN}`).reason, "missing_first_person_launch_language");
  assert.equal(classifyKolSelfLaunchText("I launched my token today on BSC").reason, "missing_contract_address");
  assert.equal(classifyKolSelfLaunchText(`We just launched our coin on BSC. CA ${TOKEN} and ${TOKEN_TWO}`).reason, "ambiguous_contract_addresses");
  assert.equal(classifyKolSelfLaunchText("I just launched my token on BSC. CA 0x0000000000000000000000000000000000000000").reason,
    "invalid_zero_contract_address");
  assert.equal(classifyKolSelfLaunchText(`Scam warning: I just launched my token on BSC. CA ${TOKEN}`).reason, "negative_exit_or_warning_language");
  assert.equal(classifyKolSelfLaunchText(`CZ said: "I just launched my token on BSC. CA ${TOKEN}"`).reason,
    "reported_or_hypothetical_launch_language");
  assert.equal(classifyKolSelfLaunchText(`Quoting the founder: I just launched my token on BSC. CA ${TOKEN}`).reason,
    "reported_or_hypothetical_launch_language");
  assert.equal(classifyKolSelfLaunchText(`A report: “I just launched my token on BSC. CA ${TOKEN}”`).reason,
    "reported_or_hypothetical_launch_language");
  assert.equal(classifyKolSelfLaunchText(`Imagine I just launched my token on BSC. CA ${TOKEN}`).reason,
    "reported_or_hypothetical_launch_language");
  assert.equal(classifyKolSelfLaunchText(`假设我刚发了一个币，在 BNB链。CA ${TOKEN}`).reason,
    "reported_or_hypothetical_launch_language");
  assert.equal(classifyKolSelfLaunchText(`I just launched my token on Base. CA ${TOKEN}`).reason,
    "ambiguous_or_unsupported_chain");
  assert.equal(classifyKolSelfLaunchText(`I just launched my token on BSC and Base. CA ${TOKEN}`).reason,
    "ambiguous_or_unsupported_chain");
  assert.equal(classifyKolSelfLaunchText(`I just launched my token on BSC testnet. CA ${TOKEN}`).reason,
    "testnet_launch_not_supported");
  assert.equal(classifyKolSelfLaunchText(`I just launched my token on BSC. Treasury ${TOKEN}`).reason,
    "contract_not_explicitly_labeled_ca");
  assert.equal(classifyKolSelfLaunchText(`I launched my token on BSC in 2021. It is live. CA ${TOKEN}`).reason,
    "historical_launch_language");
  assert.equal(classifyKolSelfLaunchText(`My token is live on BSC since 2021. CA ${TOKEN}`).reason,
    "historical_launch_language");
  assert.equal(classifyKolSelfLaunchText(`Joking: I just launched my token on BSC. CA ${TOKEN}`).reason,
    "non_literal_launch_language");
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

test("verified first-person launch emits follower, self-described background and watch-only CA context", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T06:30:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("150", "ordinary baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const profileRef = {
    value: {
      id: X_ID,
      screen_name: "alpha",
      name: "Alpha Research",
      description: "Onchain researcher and founder.",
      followers: 1_234_567,
      protected: false,
    },
  };
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    profileRef,
    configOverrides: { fomoXCallEnabled: false, kolLaunchMonitorEnabled: true },
  });
  await monitor.check();

  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("151", `I just launched my token on BNB Smart Chain. CA ${TOKEN}`, nowRef.value - 500),
    ...tweetsRef.value,
  ];
  const result = await monitor.check();
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  const event = alerts[0];
  assert.equal(event.signalKind, "kol_self_launch");
  assert.equal(event.eventKey, `kol-self-launch:${X_ID}:151:56:${TOKEN}`);
  assert.equal(event.strong, false);
  assert.equal(event.token, TOKEN);
  assert.equal(event.caller.xProfileId, X_ID);
  assert.equal(event.caller.followers, 1_234_567);
  assert.equal(event.caller.displayName, "Alpha Research");
  assert.deepEqual(event.caller.background, {
    status: "self_described",
    text: "Onchain researcher and founder.",
    source: "fxtwitter_public_profile",
    sourceUrl: "https://x.com/alpha",
    observedAt: new Date(nowRef.value - 5_000).toISOString(),
  });
  assert.deepEqual(event.launchClaim, {
    status: "self_declared",
    explicitIssuerLanguage: true,
    onchainCreatorVerified: false,
    caSource: "official_x_oembed",
    chainVerification: "declared_only",
    chainSource: "declared_bsc_in_x_post",
  });
  assert.deepEqual(event.shadow, {
    decision: "watch",
    executable: false,
    reasonCodes: ["creator_not_onchain_verified", "holder_lp_cluster_coverage_incomplete"],
  });
  assert.equal(event.simulationOnly, true);

  const routeConfig = {
    ...config(dataDir),
    monitorScope: "focus3",
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoCallAllowGmgnObservedWallets: true,
    fomoCallGmgnAttributionMaxAgeMs: 86_400_000,
    kolLaunchMonitorEnabled: true,
  };
  assert.equal(isMonitoringSourceEnabled(routeConfig, event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal((await monitor.getState()).alertedTokens[TOKEN], undefined,
    "a KOL launch claim must not globally suppress another KOL's claim for the same CA");
});

test("reviewed capital person bypasses wallet and follower gates but only emits an exact self-launch", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-09-06T08:00:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("200", "catalog baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const requests = [];
  let bscActivityCalls = 0;
  const profileRef = {
    value: {
      id: X_ID,
      screen_name: "alpha",
      name: "Alpha Capital",
      description: "Mutable X bio must not become reviewed background.",
      followers: 0,
      protected: false,
    },
  };
  const catalog = capitalCatalogFixtureDependencies();
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    requests,
    profileRef,
    getBscActivityImpl: async () => { bscActivityCalls += 1; return 0; },
    configOverrides: {
      fomoXCallEnabled: true,
      kolLaunchMonitorEnabled: true,
      kolCapitalRosterEnabled: true,
      kolCapitalCatalogMaximumAgeMs: 180 * 86_400_000,
      fomoXCallMinXFollowers: 10_000_000,
    },
    extraDependencies: catalog.dependencies,
  });
  await monitor.check();

  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("201", `I am buying this. CA ${TOKEN_TWO}`, nowRef.value - 500),
    ...tweetsRef.value,
  ];
  const ordinary = await monitor.check();
  assert.equal(ordinary.delivered, 0);
  assert.equal(alerts.length, 0);
  assert.equal(requests.filter((url) => url.startsWith("https://publish.x.test/oembed?")).length, 0,
    "ordinary calls from catalog-only people are consumed before oEmbed");

  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("202", `I just launched my token on BNB Smart Chain. CA ${TOKEN}`, nowRef.value - 500),
    ...tweetsRef.value,
  ];
  const launch = await monitor.check();
  assert.equal(launch.delivered, 1);
  assert.equal(bscActivityCalls, 0, "catalog people must not be forced through a wallet activity gate");
  assert.equal(alerts.length, 1);
  const event = alerts[0];
  assert.equal(event.signalKind, "kol_self_launch");
  assert.equal(event.qualified, false);
  assert.equal(event.socialClaimVerified, true);
  assert.equal(event.caller.followers, 0);
  assert.equal(event.caller.identitySource, "reviewed_catalog+fxtwitter");
  assert.equal(event.caller.background.status, "primary_verified");
  assert.equal(event.caller.background.textZh, catalog.snapshot.background.zh);
  assert.equal(event.caller.background.textEn, catalog.snapshot.background.en);
  assert.equal(event.caller.background.sourceUrl, "https://alpha.example/leadership");
  assert.deepEqual(event.capitalKolSnapshot, catalog.snapshot);
  assert.deepEqual(event.caller.capitalKolSnapshot, catalog.snapshot);
  assert.deepEqual(event.caller.capitalKolBinding, {
    handle: "alpha",
    xUserId: X_ID,
    source: "fxtwitter_public_profile",
    observedAt: new Date(nowRef.value - 10_000).toISOString(),
  });
  assert.equal("walletAddress" in event, false);
  assert.equal("bscTransactionCount" in event.caller, false);
  const state = await monitor.getState();
  assert.equal(state.health.sources.capitalCatalog.status, "healthy");
  assert.equal(state.health.sources.capitalCatalog.admitted, 1);
  assert.equal(state.health.sources.x.rotationSlaBreached, false);
});

test("reviewed catalog expansion preserves an unchanged person's cursor and sees the next launch", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-09-06T08:05:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("205", "catalog baseline", nowRef.value - 1_000)] };
  const profileRef = {
    value: { id: X_ID, screen_name: "alpha", followers: 0, protected: false },
  };
  const firstCatalog = capitalCatalogFixtureDependencies();
  const firstMonitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts: [],
    profileRef,
    configOverrides: {
      fomoXCallEnabled: false,
      kolLaunchMonitorEnabled: true,
      kolCapitalRosterEnabled: true,
    },
    extraDependencies: firstCatalog.dependencies,
  });
  assert.equal((await firstMonitor.check()).delivered, 0);
  assert.equal((await firstMonitor.getState()).cursors.alpha, "205");
  await firstMonitor.stop();

  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("206", `I just launched my token on BSC today. CA ${TOKEN}`, nowRef.value - 100),
    ...tweetsRef.value,
  ];
  const expandedCatalog = capitalCatalogFixtureDependencies({
    catalogVersion: "test.2",
    catalogHash: `sha256:${"b".repeat(64)}`,
  });
  const alerts = [];
  const secondMonitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    profileRef,
    configOverrides: {
      fomoXCallEnabled: false,
      kolLaunchMonitorEnabled: true,
      kolCapitalRosterEnabled: true,
    },
    extraDependencies: expandedCatalog.dependencies,
  });
  const result = await secondMonitor.check();
  const state = await secondMonitor.getState();
  assert.equal(result.delivered, 1, "a catalog-only hash change must not silently rebaseline the next post");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tweet.id, "206");
  assert.equal(state.cursors.alpha, "206");
  assert.equal(state.initialized.alpha.catalogHash, expandedCatalog.snapshot.catalogHash);
  assert.equal(state.roster.alpha.capitalKolSnapshot.catalogHash, expandedCatalog.snapshot.catalogHash);
});

test('opt-in narrative capture persists exact no-CA KOL text without publishing or treating it as a launch',async t=>{
  const dataDir=await fixture(t),nowRef={value:Date.parse('2026-09-06T08:00:00Z')};
  const rowsRef={value:[]},tweetsRef={value:[timelineTweet('200','baseline',nowRef.value-1000)]},alerts=[],requests=[];
  const catalog=capitalCatalogFixtureDependencies();
  const options={dataDir,nowRef,rowsRef,tweetsRef,alerts,requests,
    profileRef:{value:{id:X_ID,screen_name:'alpha',name:'Alpha Capital',followers:0,protected:false}},
    configOverrides:{fomoXCallEnabled:true,kolLaunchMonitorEnabled:true,kolCapitalRosterEnabled:true,paperNarrativeRecallEnabled:true},
    extraDependencies:catalog.dependencies};
  let monitor=createHarness(options);await monitor.check();
  nowRef.value+=5000;tweetsRef.value=[timelineTweet('201','robotaxi orbital starlight autonomous fleet',nowRef.value-500),...tweetsRef.value];
  await monitor.check();let state=await monitor.getState();
  assert.equal(alerts.length,0);const record=state.narrativeObservations['alpha:201'];
  assert.equal(record.type,'kol_narrative_observation');assert.equal(record.tweet.sourceVerifiedBy,'official_x_oembed');
  assert.equal(record.tweet.text,'robotaxi orbital starlight autonomous fleet');assert.equal(record.caller.capitalKolBinding.xUserId,X_ID);
  assert.equal(record.token,undefined);assert.equal(record.tweet.isQuote,false);assert.equal(record.tweet.isReply,false);
  const checks=requests.filter(x=>x.includes('/oembed?')).length;await monitor.check();
  assert.equal(requests.filter(x=>x.includes('/oembed?')).length,checks,'replayed post does not refetch or refresh its time');
  await monitor.stop();monitor=createHarness(options);await monitor.check();state=await monitor.getState();
  assert.deepEqual(state.narrativeObservations['alpha:201'],record);await monitor.stop();
});

test("reviewed capital person is quarantined on a pinned numeric X id mismatch", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-09-06T08:10:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("210", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const requests = [];
  const profileRef = {
    value: { id: "999999999", screen_name: "alpha", followers: 999_999_999, protected: false },
  };
  const catalog = capitalCatalogFixtureDependencies();
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    requests,
    profileRef,
    configOverrides: { kolLaunchMonitorEnabled: true, kolCapitalRosterEnabled: true },
    extraDependencies: catalog.dependencies,
  });
  const result = await monitor.check();
  assert.equal(result.delivered, 0);
  assert.equal(result.rejected, 1);
  assert.equal(alerts.length, 0);
  assert.equal(requests.some((url) => url.includes("/statuses?")), false);
  assert.equal(requests.some((url) => url.startsWith("https://publish.x.test/oembed?")), false);
  const state = await monitor.getState();
  assert.match(state.roster.alpha.admissionRejectionReason, /pinned X id/u);
  assert.equal(state.health.sources.capitalCatalog.runtimeQuarantined, 1);
  assert.equal(state.cursors.alpha, undefined);
});

test("unknown configured capital category fails closed and degrades health instead of reporting zero-candidate healthy", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-09-06T08:15:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [] };
  const alerts = [];
  const catalog = capitalCatalogFixtureDependencies();
  const validMonitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    configOverrides: {
      fomoXCallEnabled: false,
      kolLaunchMonitorEnabled: true,
      kolCapitalRosterEnabled: true,
      kolCapitalCategories: ["web2_tech"],
    },
    extraDependencies: catalog.dependencies,
  });
  await validMonitor.check();
  assert.ok((await validMonitor.getState()).roster.alpha,
    "fixture must persist a previously valid catalog candidate before the invalid-category restart");
  await validMonitor.stop();

  let invalidListed = 0;
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    configOverrides: {
      fomoXCallEnabled: false,
      kolLaunchMonitorEnabled: true,
      kolCapitalRosterEnabled: true,
      kolCapitalCategories: ["web2_tech", "unknown_capital_category"],
    },
    extraDependencies: {
      ...catalog.dependencies,
      listCapitalKolsImpl: () => {
        invalidListed += 1;
        return catalog.dependencies.listCapitalKolsImpl();
      },
    },
  });

  const result = await monitor.check();
  const state = await monitor.getState();
  assert.equal(result.status, "degraded");
  assert.equal(result.roster, 0);
  assert.equal(invalidListed, 0, "an invalid category set must fail before catalog candidates are admitted");
  assert.equal(alerts.length, 0);
  assert.equal(state.health.status, "degraded");
  assert.match(state.health.lastError, /unknown_categories:unknown_capital_category/u);
  assert.deepEqual(state.health.sources.capitalCatalog.unknownCategories, ["unknown_capital_category"]);
  assert.equal(state.health.sources.capitalCatalog.status, "error");
  assert.equal(state.health.sources.capitalCatalog.admitted, 0);
  assert.equal(state.health.sources.capitalCatalog.quarantined, 1);
  assert.deepEqual(state.roster, {}, "the invalid restart must remove previously persisted catalog candidates");
});

test("capital-person launch remains watch-only when pool qualification is unavailable", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-09-06T08:20:00.000Z") };
  const rowsRef = { value: [] };
  const tweetsRef = { value: [timelineTweet("220", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const catalog = capitalCatalogFixtureDependencies();
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    profileRef: { value: { id: X_ID, screen_name: "alpha", followers: 1, protected: false } },
    qualifyCallImpl: async () => { throw new Error("RPC unavailable"); },
    configOverrides: { fomoXCallEnabled: false, kolLaunchMonitorEnabled: true, kolCapitalRosterEnabled: true },
    extraDependencies: catalog.dependencies,
  });
  await monitor.check();
  nowRef.value += 5_000;
  tweetsRef.value = [
    timelineTweet("221", `I just launched my token on BSC today. CA ${TOKEN}`, nowRef.value - 100),
    ...tweetsRef.value,
  ];
  const result = await monitor.check();
  assert.equal(result.delivered, 1);
  assert.equal(alerts[0].market, undefined);
  assert.equal(alerts[0].security.decision, "unknown");
  assert.equal(alerts[0].launchClaim.chainVerification, "declared_only");
  assert.equal(alerts[0].launchClaim.chainSource, "declared_bsc_in_x_post");
  assert.equal(alerts[0].shadow.executable, false);
  assert.equal(Object.keys((await monitor.getState()).pending).length, 0);
});

test("real reviewed catalog snapshot passes the final alert route with zero followers", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse(CAPITAL_KOL_CATALOG_PUBLISHED_AT) + 60_000 };
  const rowsRef = { value: [] };
  const capitalSnapshot = createCapitalKolEventSnapshot("VitalikButerin");
  assert.ok(capitalSnapshot);
  const makeTweet = (id, text, at) => ({
    id: String(id),
    text,
    created_timestamp: Math.floor(at / 1_000),
    url: `https://x.com/VitalikButerin/status/${id}`,
    author: { id: capitalSnapshot.xUserId, screen_name: "VitalikButerin", name: "Vitalik Buterin" },
    replying_to: null,
  });
  const tweetsRef = { value: [makeTweet("230", "baseline", nowRef.value - 1_000)] };
  const alerts = [];
  const fetchImpl = async (url) => {
    if (url === "https://api.fxtwitter.test/2/profile/vitalikbuterin") {
      return jsonResponse(200, {
        code: 200,
        user: {
          id: capitalSnapshot.xUserId,
          screen_name: "VitalikButerin",
          name: "Vitalik Buterin",
          followers: 0,
          protected: false,
        },
      });
    }
    if (url === `https://api.fxtwitter.test/2/profile/id:${capitalSnapshot.xUserId}/statuses?count=40`) {
      return jsonResponse(200, { code: 200, results: tweetsRef.value });
    }
    if (url.startsWith("https://publish.x.test/oembed?")) {
      const requested = new URL(url).searchParams.get("url");
      const id = requested.match(/\/status\/(\d+)$/u)?.[1];
      const tweet = tweetsRef.value.find((item) => item.id === id);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          author_url: "https://x.com/VitalikButerin",
          url: `https://x.com/VitalikButerin/status/${id}`,
          html: `<blockquote><p>${tweet.text}</p>&mdash; Vitalik Buterin (@VitalikButerin) <a href="https://x.com/VitalikButerin/status/${id}">September 6, 2026</a></blockquote>`,
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts,
    fetchImpl,
    getBscActivityImpl: async () => { throw new Error("catalog lane requested BSC person activity"); },
    configOverrides: {
      fomoXCallEnabled: false,
      kolLaunchMonitorEnabled: true,
      kolCapitalRosterEnabled: true,
      kolCapitalCategories: ["crypto_founder"],
      kolCapitalCatalogMaximumAgeMs: 180 * 86_400_000,
      fomoXCallMinXFollowers: 10_000_000,
    },
  });
  await monitor.check();
  nowRef.value += 5_000;
  tweetsRef.value = [
    makeTweet("231", `I just launched my token on BNB Smart Chain. CA ${TOKEN}`, nowRef.value - 100),
    ...tweetsRef.value,
  ];
  const result = await monitor.check();
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].capitalKolSnapshot, capitalSnapshot);
  const routeConfig = {
    ...config(dataDir),
    fomoCallEnabled: true,
    kolLaunchMonitorEnabled: true,
    kolCapitalRosterEnabled: true,
    kolLaunchMinXFollowers: 10_000_000,
  };
  assert.equal(isMonitoringSourceEnabled(routeConfig, alerts[0]), true,
    "an exact reviewed catalog snapshot must bypass the numeric follower gate");
  assert.equal(isRelevantAlert(alerts[0]), true);
  const tamperedBinding = structuredClone(alerts[0]);
  tamperedBinding.caller.capitalKolBinding.xUserId = "999999999";
  assert.equal(isMonitoringSourceEnabled(routeConfig, tamperedBinding), false);
  assert.equal(isRelevantAlert(tamperedBinding), false);
});

test("retryable X alert suppression keeps the tweet pending while terminal suppression consumes it", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T06:10:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("100", "ordinary baseline", nowRef.value - 1_000)] };
  const alerts = [];
  let delivery = { status: "suppressed", disposition: "retry", terminal: false };
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts,
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return delivery; },
  });
  await monitor.check();

  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("101", `I am buying this. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  await monitor.check();
  let state = await monitor.getState();
  assert.ok(state.pending["alpha:101"]);
  assert.equal(state.seenTweetContracts[`101:${TOKEN}`], undefined);

  delivery = { status: "delivered" };
  nowRef.value += 5_000;
  await monitor.check();
  state = await monitor.getState();
  assert.equal(state.pending["alpha:101"], undefined);
  assert.ok(state.seenTweetContracts[`101:${TOKEN}`]);

  delivery = { status: "suppressed", disposition: "terminal", terminal: true, reason: "not_relevant" };
  nowRef.value += 5_000;
  tweetsRef.value = [timelineTweet("102", `I am buying this. CA ${TOKEN_TWO}`, nowRef.value - 500), ...tweetsRef.value];
  await monitor.check();
  state = await monitor.getState();
  assert.equal(state.pending["alpha:102"], undefined);
  assert.ok(state.seenTweetContracts[`102:${TOKEN_TWO}`]);
  assert.equal(state.alertedTokens[TOKEN_TWO], undefined);
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
    timelineTweet("206", `I just launched my token on BSC. CA ${TOKEN}`, nowRef.value - 50, {
      quote_tweet: { id: "999" },
      raw_text: { text: `I just launched my token on BSC. CA ${TOKEN}`, facets: [] },
    }),
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

test("a same-wallet handle migration drops the old runtime and silently baselines the new handle", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T12:30:00.000Z") };
  const betaId = "223456789012345678";
  const rowsRef = { value: [candidate(nowRef.value)] };
  const alerts = [];
  const requests = [];
  const timelines = {
    alpha: [timelineTweet("100", "alpha baseline", nowRef.value - 1_000)],
    beta: [],
  };
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/2/profile/alpha")) {
      return jsonResponse(200, { code: 200, user: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } });
    }
    if (url.endsWith("/2/profile/beta")) {
      return jsonResponse(200, { code: 200, user: { id: betaId, screen_name: "beta", followers: 25_000, protected: false } });
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) return jsonResponse(200, { code: 200, results: timelines.alpha });
    if (url.includes(`/2/profile/id:${betaId}/statuses`)) return jsonResponse(200, { code: 200, results: timelines.beta });
    if (url.startsWith("https://publish.x.test/oembed?")) {
      const requested = new URL(url).searchParams.get("url");
      const [, handle, id] = requested.match(/x\.com\/([^/]+)\/status\/(\d+)$/) || [];
      const tweet = timelines[handle]?.find((item) => String(item.id) === id);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          author_url: `https://x.com/${handle}`,
          url: requested,
          html: `<blockquote><p>${tweet.text}</p>&mdash; ${handle} (@${handle}) <a href="${requested}">August 19, 2026</a></blockquote>`,
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef: { value: [] },
    alerts,
    requests,
    fetchImpl,
    qualifyCallImpl: async (call) => call.handle === "alpha" ? {
      decision: "block",
      reason: "hold old handle pending",
      market: { liquidityUsd: 25_000 },
      security: { decision: "block", metrics: { liquidityConfirmed: false, sellObserved: true } },
    } : passQualification(),
  });

  await monitor.check();
  nowRef.value += 5_000;
  timelines.alpha = [timelineTweet("101", `I am buying this. CA ${TOKEN}`, nowRef.value - 500), ...timelines.alpha];
  await monitor.check();
  assert.ok((await monitor.getState()).pending["alpha:101"]);

  nowRef.value += 5_000;
  rowsRef.value = [candidate(nowRef.value, { handle: "beta", twitterHandles: ["beta"] })];
  timelines.beta = [timelineTweet("201", `I am buying on the renamed handle. CA ${TOKEN_TWO}`, nowRef.value - 500, {
    author: { id: betaId, screen_name: "beta", name: "Beta" },
    url: "https://x.com/beta/status/201",
  })];
  await monitor.check();
  let state = await monitor.getState();
  assert.equal(alerts.length, 0, "the migration snapshot must be a silent baseline");
  assert.equal(state.roster.alpha, undefined);
  assert.equal(state.initialized.alpha, undefined);
  assert.equal(state.cursors.alpha, undefined);
  assert.deepEqual(state.pending, {});
  assert.equal(state.roster.beta.wallet, WALLET);
  assert.equal(state.cursors.beta, "201");

  nowRef.value += 5_000;
  timelines.beta = [timelineTweet("202", `I am buying after the baseline. CA ${TOKEN}`, nowRef.value - 500, {
    author: { id: betaId, screen_name: "beta", name: "Beta" },
    url: "https://x.com/beta/status/202",
  }), ...timelines.beta];
  const result = await monitor.check();
  state = await monitor.getState();
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].handle, "beta");
  assert.equal(state.cursors.beta, "202");
  assert.equal(requests.filter((url) => url.startsWith("https://publish.x.test/oembed?"))
    .some((url) => new URL(url).searchParams.get("url")?.endsWith("/status/201")), false,
  "the migration baseline must never be replayed through oEmbed");
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
  assert.equal(first.status, "degraded");
  nowRef.value += 5_000;
  const second = await monitor.check();
  assert.equal(second.status, "degraded");
  assert.equal(requests.filter((url) => url.endsWith("/2/profile/alpha")).length, 1);
  const state = await monitor.getState();
  assert.equal(state.health.rejectedCount, 1);
  assert.equal(state.health.activeCount, 0);
  assert.equal(state.health.backlogCount, 1);
  assert.equal(state.health.sources.x.coverage, "source_limited");
  assert.equal(state.health.sources.x.failures, 0);
  assert.match(state.health.coverage.admissionRejections.alpha.reason, /followers 9999 below required 10000/);
  assert.equal(Date.parse(state.health.coverage.admissionRejections.alpha.retryAt), state.roster.alpha.admissionRejectedUntil);
});

test("22 live timelines out of 41 keep coverage degraded but record a clean operational success", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-09-11T02:00:00.000Z");
  const nowRef = { value: startedAt };
  const identities = Array.from({ length: 41 }, (_, index) => ({
    handle: `kol${String(index).padStart(2, "0")}`,
    id: `8${String(index + 1).padStart(17, "0")}`,
    wallet: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    admitted: index < 22,
  }));
  const byHandle = new Map(identities.map((identity) => [identity.handle, identity]));
  const byId = new Map(identities.map((identity) => [identity.id, identity]));
  const rowsRef = { value: identities.map((identity) => candidate(startedAt, {
    handle: identity.handle,
    wallet: identity.wallet,
    wallets: [identity.wallet],
    twitterHandles: [identity.handle],
  })) };
  const fetchImpl = async (url) => {
    const profileMatch = url.match(/\/2\/profile\/([a-z0-9_]+)$/u);
    if (profileMatch) {
      const identity = byHandle.get(profileMatch[1]);
      return jsonResponse(200, { code: 200, user: {
        id: identity.id,
        screen_name: identity.handle,
        followers: identity.admitted ? 25_000 : 9_999,
        protected: false,
      } });
    }
    const timelineMatch = url.match(/\/2\/profile\/id:(\d+)\/statuses\?count=40$/u);
    if (timelineMatch) {
      const identity = byId.get(timelineMatch[1]);
      const index = identities.indexOf(identity);
      return jsonResponse(200, { code: 200, results: [timelineTweet(String(10_000 + index), "baseline", startedAt - 1_000, {
        author: { id: identity.id, screen_name: identity.handle, name: identity.handle },
        url: `https://x.com/${identity.handle}/status/${10_000 + index}`,
      })] });
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
    configOverrides: { fomoXCallBatchSize: 100, fomoXCallConcurrency: 10 },
  });

  const result = await monitor.check();
  const state = await monitor.getState();
  const checkedAt = new Date(startedAt).toISOString();
  assert.equal(result.status, "degraded");
  assert.equal(state.health.status, "degraded");
  assert.equal(state.health.sources.x.status, "partial");
  assert.equal(state.health.sources.x.coverage, "source_limited");
  assert.equal(state.health.eligibleCount, 41);
  assert.equal(state.health.liveCount, 22);
  assert.equal(state.health.rejectedCount, 19);
  assert.equal(state.health.operationalStatus, "healthy");
  assert.equal(state.health.sources.x.operationalStatus, "healthy");
  assert.equal(state.health.sources.x.operationalSuccesses, 22);
  assert.equal(state.health.lastOperationalSuccessAt, checkedAt);
  assert.equal(state.health.sources.x.lastOperationalSuccessAt, checkedAt);
  assert.equal(state.health.lastSuccessAt, null, "coverage-complete success remains distinct from operational success");
  assert.equal(state.health.consecutiveFailures, 0);
  assert.match(state.health.lastError, /X effective coverage limited: 22\/41/u);
});

test("a total X transport failure increments once while circuit cooling does not inflate the counter", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-09-11T02:10:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef: { value: [] },
    alerts: [],
    fetchImpl: async () => {
      const error = new Error("FxTwitter timed out");
      error.name = "TimeoutError";
      throw error;
    },
  });

  let result = await monitor.check();
  let state = await monitor.getState();
  assert.equal(result.status, "degraded");
  assert.equal(state.health.operationalStatus, "error");
  assert.equal(state.health.consecutiveFailures, 1);
  assert.equal(state.health.lastOperationalSuccessAt, null);
  assert.equal(state.health.sources.x.operationalSuccesses, 0);

  nowRef.value += 5_000;
  result = await monitor.check();
  state = await monitor.getState();
  assert.equal(result.status, "degraded");
  assert.equal(state.health.operationalStatus, "backoff");
  assert.equal(state.health.consecutiveFailures, 1, "an open circuit is not another failed transport attempt");
  assert.equal(state.health.lastOperationalSuccessAt, null);
});

test("a partial X cycle refreshes operational success without claiming a clean cycle", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-09-11T02:15:00.000Z");
  const nowRef = { value: startedAt };
  const betaWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const betaId = "223456789012345678";
  let alphaAvailable = false;
  const rowsRef = { value: [
    candidate(startedAt),
    candidate(startedAt, {
      handle: "beta",
      wallet: betaWallet,
      wallets: [betaWallet],
      twitterHandles: ["beta"],
    }),
  ] };
  const fetchImpl = async (url) => {
    if (url.endsWith("/2/profile/alpha")) {
      return jsonResponse(200, { code: 200, user: {
        id: X_ID, screen_name: "alpha", followers: 25_000, protected: false,
      } });
    }
    if (url.endsWith("/2/profile/beta")) {
      return jsonResponse(200, { code: 200, user: {
        id: betaId, screen_name: "beta", followers: 25_000, protected: false,
      } });
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) {
      if (!alphaAvailable) {
        const error = new Error("alpha timeline timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return jsonResponse(200, { code: 200, results: [
        timelineTweet("12500", "baseline", nowRef.value - 1_000),
      ] });
    }
    if (url.includes(`/2/profile/id:${betaId}/statuses`)) {
      const error = new Error("beta timeline timed out");
      error.name = "TimeoutError";
      throw error;
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
    configOverrides: { fomoXCallBatchSize: 10 },
  });

  await monitor.check();
  let state = await monitor.getState();
  assert.equal(state.health.operationalStatus, "error");
  assert.equal(state.health.consecutiveFailures, 1);
  assert.equal(state.health.lastOperationalSuccessAt, null);

  alphaAvailable = true;
  nowRef.value += 60_000;
  const result = await monitor.check();
  state = await monitor.getState();
  const checkedAt = new Date(nowRef.value).toISOString();
  assert.equal(result.status, "degraded");
  assert.equal(state.health.operationalStatus, "partial");
  assert.equal(state.health.sources.x.operationalSuccesses, 1);
  assert.equal(state.health.lastOperationalSuccessAt, checkedAt);
  assert.equal(state.health.sources.x.lastOperationalSuccessAt, checkedAt);
  assert.equal(state.health.consecutiveFailures, 1,
    "partial liveness must not manufacture the clean cycle needed to reset a retained failure streak");
});

test("a clean recovered timeline resets operational failures even while another identity keeps coverage partial", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-09-11T02:20:00.000Z");
  const nowRef = { value: startedAt };
  const betaWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const betaId = "223456789012345678";
  const rowsRef = { value: [
    candidate(startedAt),
    candidate(startedAt, { handle: "beta", wallet: betaWallet, wallets: [betaWallet], twitterHandles: ["beta"] }),
  ] };
  let alphaAvailable = false;
  const fetchImpl = async (url) => {
    if (url.endsWith("/2/profile/alpha")) {
      if (!alphaAvailable) {
        const error = new Error("FxTwitter timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return jsonResponse(200, { code: 200, user: {
        id: X_ID, screen_name: "alpha", followers: 25_000, protected: false,
      } });
    }
    if (url.endsWith("/2/profile/beta")) {
      return jsonResponse(200, { code: 200, user: {
        id: betaId, screen_name: "beta", followers: 9_999, protected: false,
      } });
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) {
      return jsonResponse(200, { code: 200, results: [timelineTweet("12000", "baseline", nowRef.value - 1_000)] });
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
    configOverrides: { fomoXCallBatchSize: 10 },
  });

  await monitor.check();
  let state = await monitor.getState();
  assert.equal(state.health.operationalStatus, "error");
  assert.equal(state.health.consecutiveFailures, 1);

  alphaAvailable = true;
  nowRef.value += 60_000;
  const recoveredAt = new Date(nowRef.value).toISOString();
  const recovered = await monitor.check();
  state = await monitor.getState();
  assert.equal(recovered.status, "degraded");
  assert.equal(state.health.status, "degraded");
  assert.equal(state.health.liveCount, 1);
  assert.equal(state.health.rejectedCount, 1);
  assert.equal(state.health.operationalStatus, "healthy");
  assert.equal(state.health.sources.x.operationalStatus, "healthy");
  assert.equal(state.health.lastOperationalSuccessAt, recoveredAt);
  assert.equal(state.health.consecutiveFailures, 0);
  assert.equal(state.health.lastSuccessAt, null);
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
  await monitor.check();
  await monitor.waitForDiscovery();
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
  await monitor.check();
  await monitor.waitForDiscovery();
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
  await monitor.waitForDiscovery();
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

test("a restarted verified seed clears its binding and freezes the cursor on FomoScan 404 or exact-match mismatch", async (t) => {
  const cases = [
    ["HTTP 404", () => {
      const error = new Error("HTTP 404 FomoScan");
      error.httpStatus = 404;
      throw error;
    }],
    ["200 handle-wallet mismatch", (_candidate, nowMs) => ({
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      handle: "different_handle",
      twitterHandle: "different_handle",
      checkedAt: new Date(nowMs).toISOString(),
      lastCheckedAt: new Date(nowMs).toISOString(),
    })],
  ];
  for (const [label, refreshBinding] of cases) {
    await t.test(label, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-binding-hard-"));
      try {
        const nowRef = { value: Date.parse("2026-08-19T14:22:00.000Z") };
        const tweetsRef = { value: [] };
        await baselineVerifiedSeed({ dataDir, nowRef, tweetsRef, baselineId: "835" });
        nowRef.value += 60_000;
        tweetsRef.value = [timelineTweet("836", `I am buying but the binding is revoked. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
        const alerts = [];
        const requests = [];
        const restarted = createHarness({
          dataDir,
          nowRef,
          rowsRef: { value: [] },
          tweetsRef,
          alerts,
          requests,
          resolveBindingImpl: async (candidateRow) => refreshBinding(candidateRow, nowRef.value),
        });
        const result = await restarted.check();
        const state = await restarted.getState();
        assert.equal(result.status, "degraded");
        assert.equal(result.delivered, 0);
        assert.equal(alerts.length, 0);
        assert.equal(state.roster.alpha.walletBinding, null);
        assert.equal(state.cursors.alpha, "835", "a hard binding failure must not advance the durable X cursor");
        assert.equal(state.seenTweets["alpha:836"], undefined);
        assert.equal(state.pending["alpha:836"], undefined);
        assert.ok(Number(state.roster.alpha.admissionRejectedUntil) > nowRef.value);
        assert.equal(requests.some((url) => url.includes("/statuses")), false);
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("a restarted verified seed may reuse a fresh binding on FomoScan 503 and keep polling", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:24:00.000Z") };
  const tweetsRef = { value: [] };
  const binding = await baselineVerifiedSeed({ dataDir, nowRef, tweetsRef, baselineId: "838" });
  nowRef.value += 60_000;
  tweetsRef.value = [timelineTweet("839", `I am buying while FomoScan is transiently unavailable. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  const alerts = [];
  const requests = [];
  const restarted = createHarness({
    dataDir,
    nowRef,
    rowsRef: { value: [] },
    tweetsRef,
    alerts,
    requests,
    resolveBindingImpl: async () => {
      const error = new Error("HTTP 503 FomoScan");
      error.httpStatus = 503;
      throw error;
    },
  });
  const result = await restarted.check();
  const state = await restarted.getState();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.equal(state.cursors.alpha, "839");
  assert.deepEqual(state.roster.alpha.walletBinding, binding);
  assert.equal(requests.some((url) => url.includes(`/2/profile/id:${X_ID}/statuses`)), true);
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
  await monitor.waitForDiscovery();
  assert.deepEqual(calls.sort(), ["alpha", "beta"]);
  let state = await monitor.getState();
  assert.equal(state.health.sources.fomoscanSeeds.status, "partial");
  assert.equal(state.health.sources.fomoscanSeeds.backlog, 1);
  assert.deepEqual(Object.keys(state.verifiedSeedFailures), ["beta"]);

  nowRef.value += 5_000;
  await monitor.check();
  assert.equal(calls.length, 2, "failed seeds must not retry every five seconds");

  nowRef.value += 55_000;
  await monitor.check();
  await monitor.waitForDiscovery();
  state = await monitor.getState();
  assert.deepEqual(calls, ["alpha", "beta", "beta"]);
  assert.deepEqual(state.verifiedSeedFailures, {});
  assert.equal(state.health.sources.fomoscanSeeds.status, "healthy");
  assert.equal(state.health.sources.fomoscanSeeds.backlog, 0);
});

test("a hung FomoScan seed batch is single-flight and cannot consume the hot timeline budget", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:40:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("870", "baseline", nowRef.value - 1_000)] };
  const requests = [];
  let seedCalls = 0;
  let releaseSeed;
  const blockedSeed = new Promise((resolve) => { releaseSeed = resolve; });
  const seedHandles = Array.from({ length: 29 }, (_, index) => `seed${index}`);
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef,
    alerts: [],
    requests,
    configOverrides: {
      fomoCallPublicHandles: seedHandles,
      fomoXCallVerifiedSeedBatchSize: 6,
      fomoXCallRequestTimeoutMs: 30_000,
    },
    discoverVerifiedSeedImpl: async () => {
      seedCalls += 1;
      return blockedSeed;
    },
  });

  const hotCheck = (label) => Promise.race([
    monitor.check(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded the hot-loop budget`)), 250)),
  ]);
  const first = await hotCheck("first check");
  assert.equal(first.active, 1);
  assert.equal(first.status, "degraded", "pending configured discovery remains source-limited without blocking live polling");
  nowRef.value += 5_000;
  const second = await hotCheck("second check");
  assert.equal(second.active, 1);
  assert.equal(seedCalls, 2, "only the bounded worker count may enter a blocked six-handle batch");
  assert.equal(requests.filter((url) => url.includes(`/2/profile/id:${X_ID}/statuses`)).length, 2);
  let state = await monitor.getState();
  assert.equal(state.health.sources.fomoscanSeeds.inFlight, true);
  assert.equal(state.health.sources.fomoscanSeeds.backlog, 29);
  assert.equal(state.health.liveCount, 1);

  releaseSeed(null);
  await monitor.waitForDiscovery();
  state = await monitor.getState();
  assert.equal(seedCalls, 6, "only one bounded batch may finish after the blocked calls release");
  assert.equal(state.health.sources.fomoscanSeeds.inFlight, false);
  assert.equal(state.health.sources.fomoscanSeeds.backlog, 23);
});

test("bounded FomoScan discovery persists its cursor across restart", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:45:00.000Z") };
  const handles = ["seedone", "seedtwo", "seedthree", "seedfour", "seedfive"];
  const calls = [];
  const makeMonitor = () => createHarness({
    dataDir,
    nowRef,
    rowsRef: { value: [] },
    tweetsRef: { value: [] },
    alerts: [],
    configOverrides: { fomoCallPublicHandles: handles, fomoXCallVerifiedSeedBatchSize: 2 },
    discoverVerifiedSeedImpl: async (handle) => { calls.push(handle); return null; },
  });

  const firstMonitor = makeMonitor();
  await firstMonitor.check();
  await firstMonitor.waitForDiscovery();
  let state = await firstMonitor.getState();
  assert.deepEqual(calls, handles.slice(0, 2));
  assert.equal(state.verifiedSeedCursor, 2);
  assert.equal(state.health.sources.fomoscanSeeds.backlog, 3);
  assert.equal(state.verifiedSeedCheckedAt, null);
  await firstMonitor.stop();

  const restarted = makeMonitor();
  await restarted.check();
  await restarted.waitForDiscovery();
  state = await restarted.getState();
  assert.deepEqual(calls, handles.slice(0, 4));
  assert.equal(state.verifiedSeedCursor, 4);
  assert.equal(state.health.sources.fomoscanSeeds.backlog, 1);

  await restarted.check();
  await restarted.waitForDiscovery();
  state = await restarted.getState();
  assert.deepEqual(calls, handles);
  assert.equal(state.verifiedSeedCursor, 0);
  assert.equal(state.health.sources.fomoscanSeeds.backlog, 0);
  assert.equal(state.verifiedSeedCheckedAt, new Date(nowRef.value).toISOString());
});

test("stop cancels blocked seed discovery, waits for its final write, and leaves no late mutation", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-08-19T14:50:00.000Z") };
  let seedCalls = 0;
  let releaseIgnoredDependency;
  const ignoredAbort = new Promise((resolve) => { releaseIgnoredDependency = resolve; });
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef: { value: [] },
    tweetsRef: { value: [] },
    alerts: [],
    configOverrides: { fomoCallPublicHandles: ["alpha"] },
    discoverVerifiedSeedImpl: async () => {
      seedCalls += 1;
      return ignoredAbort;
    },
  });
  await monitor.check();
  assert.equal(seedCalls, 1);
  await Promise.race([
    monitor.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stop did not cancel blocked discovery")), 250)),
  ]);
  const stoppedState = await monitor.getState();
  const stoppedFile = await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8");
  assert.equal(stoppedState.health.sources.fomoscanSeeds.inFlight, false);
  assert.equal(stoppedState.health.sources.fomoscanSeeds.status, "stopped");

  releaseIgnoredDependency(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await monitor.getState(), stoppedState);
  assert.equal(await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8"), stoppedFile);
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

test("a fresh persisted numeric identity survives a transient profile timeout and keeps polling after restart", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:00:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const tweetsRef = { value: [timelineTweet("880", "baseline", startedAt - 1_000)] };
  const first = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts: [] });
  await first.check();
  await first.stop();

  nowRef.value += 60_000;
  tweetsRef.value = [timelineTweet("881", `I am buying after restart. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  const alerts = [];
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/2/profile/alpha")) {
      const error = new Error("profile timed out");
      error.name = "TimeoutError";
      throw error;
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) {
      return jsonResponse(200, { code: 200, results: tweetsRef.value });
    }
    if (url.startsWith("https://publish.x.test/oembed?")) {
      const requested = new URL(url).searchParams.get("url");
      const id = requested.match(/\/status\/(\d+)$/)?.[1];
      const tweet = tweetsRef.value.find((item) => String(item.id) === id);
      return { ok: true, status: 200, text: async () => JSON.stringify(oembed(id, tweet.text)) };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const restarted = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, requests, fetchImpl });
  const result = await restarted.check();
  const state = await restarted.getState();
  assert.equal(result.status, "healthy");
  assert.equal(result.active, 1);
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].reason, "timeout");
  assert.deepEqual(state.health.sources.x.profileFallbackHandles, ["alpha"]);
  assert.equal(state.health.sources.x.effectiveTransportBackoffs, 0);
  assert.equal(state.health.cachedCount, 1);
  assert.equal(state.health.freshCount, 1);
  assert.equal(state.health.liveCount, 1);
  assert.equal(requests.filter((url) => url.includes(`/2/profile/id:${X_ID}/statuses`)).length, 1);
});

test("a fresh exact-wallet BSC activity cache survives 429 across restart and a single due probe recovers", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:05:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const tweetsRef = { value: [timelineTweet("880", "baseline", startedAt - 1_000)] };
  const alerts = [];
  const requests = [];
  let activityMode = "healthy";
  let activityCalls = 0;
  const getBscActivityImpl = async (wallet) => {
    assert.equal(wallet, WALLET);
    activityCalls += 1;
    if (activityMode === "rate_limited") {
      const error = new Error("BSC activity HTTP 429");
      error.httpStatus = 429;
      error.retryAfter = "120";
      throw error;
    }
    return activityMode === "recovered" ? 9 : 7;
  };
  const harnessOptions = {
    dataDir, nowRef, rowsRef, tweetsRef, alerts, requests, getBscActivityImpl,
  };
  let monitor = createHarness(harnessOptions);
  await monitor.check();
  assert.equal(activityCalls, 1);

  activityMode = "rate_limited";
  nowRef.value += 60_000;
  const failedAt = nowRef.value;
  tweetsRef.value = [timelineTweet("881", `I am buying through the BSC outage. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  let result = await monitor.check();
  let state = await monitor.getState();
  assert.equal(result.status, "degraded");
  assert.equal(result.active, 1, "the timeline stays live on a fresh positive exact-wallet proof");
  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.equal(state.cursors.alpha, "881");
  assert.equal(state.roster.alpha.bscActivity.wallet, WALLET);
  assert.equal(state.roster.alpha.bscActivity.count, 7);
  assert.equal(state.roster.alpha.bscActivityRefreshHealth.status, "cached_activity_fallback");
  assert.equal(state.transportCircuits["bsc_activity:alpha"].reason, "http_429");
  assert.equal(state.transportCircuits["bsc_activity:alpha"].retryAfterMs, 120_000);
  assert.equal(state.transportCircuits["bsc_activity:alpha"].nextRetryAt, failedAt + 120_000);
  assert.deepEqual(state.health.sources.x.bscActivityFallbackHandles, ["alpha"]);
  assert.deepEqual(state.health.sources.x.degradedSourceHandles, ["alpha"]);
  assert.equal(activityCalls, 2);
  await monitor.stop();

  nowRef.value = failedAt + 119_999;
  monitor = createHarness(harnessOptions);
  result = await monitor.check();
  state = await monitor.getState();
  assert.equal(result.status, "degraded");
  assert.equal(result.active, 1);
  assert.equal(activityCalls, 2, "restart must honor the persisted Retry-After without probing early");
  assert.equal(state.transportCircuits["bsc_activity:alpha"].nextRetryAt, failedAt + 120_000);

  activityMode = "recovered";
  nowRef.value = failedAt + 120_000;
  result = await monitor.check();
  state = await monitor.getState();
  assert.equal(activityCalls, 3, "only the due handle performs one recovery probe");
  assert.equal(result.status, "healthy");
  assert.equal(result.active, 1);
  assert.equal(state.transportCircuits["bsc_activity:alpha"], undefined);
  assert.equal(state.roster.alpha.bscActivity.count, 9);
  assert.equal(state.roster.alpha.bscActivity.checkedAt, new Date(nowRef.value).toISOString());
  assert.equal(state.roster.alpha.bscActivityRefreshHealth, undefined);
  assert.deepEqual(state.health.sources.x.bscActivityFallbackHandles, []);
});

test("short-aged legacy BSC activity without a wallet requires a successful RPC refresh", async (t) => {
  for (const exactInitializedWallet of [true, false]) {
    await t.test(exactInitializedWallet ? "exact initialized wallet" : "mismatched initialized wallet", async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-bsc-legacy-"));
      try {
        const startedAt = Date.parse("2026-08-24T10:05:30.000Z");
        const nowRef = { value: startedAt };
        const rowsRef = { value: [candidate(startedAt)] };
        const tweetsRef = { value: [timelineTweet("885", "baseline", startedAt - 1_000)] };
        const initial = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts: [] });
        await initial.check();
        await initial.stop();

        const stateFile = path.join(dataDir, "fomo-x-call-state.json");
        const legacy = JSON.parse(await fs.readFile(stateFile, "utf8"));
        delete legacy.roster.alpha.bscActivity.wallet;
        if (!exactInitializedWallet) legacy.initialized.alpha.wallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        await fs.writeFile(stateFile, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

        nowRef.value += 5_000;
        tweetsRef.value = [timelineTweet("886", `I am buying during legacy migration. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
        const alerts = [];
        let activityHealthy = false;
        const monitor = createHarness({
          dataDir, nowRef, rowsRef, tweetsRef, alerts,
          getBscActivityImpl: async () => {
            if (activityHealthy) return 9;
            const error = new Error("BSC activity timed out");
            error.name = "TimeoutError";
            throw error;
          },
        });
        let result = await monitor.check();
        let state = await monitor.getState();
        assert.equal(result.delivered, 0);
        assert.equal(result.active, 0);
        assert.equal(alerts.length, 0);
        assert.equal(state.cursors.alpha, "885");
        assert.equal(state.roster.alpha.bscActivity.wallet, undefined);
        assert.deepEqual(state.health.sources.x.bscActivityFallbackHandles, []);
        assert.deepEqual(state.health.sources.x.effectiveCircuitHandles, ["alpha"]);
        assert.ok(state.health.coverage.reasonsByHandle.alpha.includes("bsc_identity_wallet_unbound"));

        if (exactInitializedWallet) {
          activityHealthy = true;
          nowRef.value = state.transportCircuits["bsc_activity:alpha"].nextRetryAt;
          rowsRef.value = [candidate(nowRef.value)];
          result = await monitor.check();
          state = await monitor.getState();
          assert.equal(result.delivered, 1);
          assert.equal(alerts.length, 1);
          assert.equal(state.cursors.alpha, "886");
          assert.equal(state.roster.alpha.bscActivity.wallet, WALLET);
          assert.equal(state.roster.alpha.bscActivity.count, 9);
          assert.equal(state.transportCircuits["bsc_activity:alpha"], undefined);
        }
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("reliable BSC network failures plus HTTP 408 and 425 may use only a fresh positive cache", async (t) => {
  const cases = [
    {
      label: "DNS failure",
      fail: () => {
        const error = new TypeError("fetch failed");
        error.cause = Object.assign(new Error("getaddrinfo ENOTFOUND bsc-rpc.test"), { code: "ENOTFOUND" });
        throw error;
      },
      reason: "network_error",
      networkErrorCode: "ENOTFOUND",
    },
    {
      label: "connection reset",
      fail: () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); },
      reason: "network_error",
      networkErrorCode: "ECONNRESET",
    },
    {
      label: "undici socket closed",
      fail: () => {
        const error = new TypeError("fetch failed");
        error.cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
        throw error;
      },
      reason: "network_error",
      networkErrorCode: "UND_ERR_SOCKET",
    },
    {
      label: "undici connect timeout",
      fail: () => {
        const error = new TypeError("fetch failed");
        error.cause = Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
        throw error;
      },
      reason: "network_error",
      networkErrorCode: "UND_ERR_CONNECT_TIMEOUT",
    },
    {
      label: "HTTP 408",
      fail: () => { const error = new Error("BSC activity HTTP 408"); error.httpStatus = 408; throw error; },
      reason: "http_408",
    },
    {
      label: "HTTP 425",
      fail: () => { const error = new Error("BSC activity HTTP 425"); error.httpStatus = 425; throw error; },
      reason: "http_425",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-bsc-transient-"));
      try {
        const startedAt = Date.parse("2026-08-24T10:06:00.000Z");
        const nowRef = { value: startedAt };
        const rowsRef = { value: [candidate(startedAt)] };
        const tweetsRef = { value: [timelineTweet("890", "baseline", startedAt - 1_000)] };
        const alerts = [];
        let failed = false;
        const monitor = createHarness({
          dataDir, nowRef, rowsRef, tweetsRef, alerts,
          getBscActivityImpl: async () => failed ? entry.fail() : 7,
        });
        await monitor.check();
        failed = true;
        nowRef.value += 60_000;
        tweetsRef.value = [timelineTweet("891", `I am buying through a transient network failure. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
        const result = await monitor.check();
        const state = await monitor.getState();
        const circuit = state.transportCircuits["bsc_activity:alpha"];
        assert.equal(result.status, "degraded");
        assert.equal(result.active, 1);
        assert.equal(result.delivered, 1);
        assert.equal(alerts.length, 1);
        assert.equal(state.cursors.alpha, "891");
        assert.equal(circuit.reason, entry.reason);
        assert.equal(circuit.networkErrorCode, entry.networkErrorCode);
        assert.deepEqual(state.health.sources.x.bscActivityFallbackHandles, ["alpha"]);
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("only explicit JSON-RPC rate-limit errors receive BSC cached fallback", async (t) => {
  const cases = [
    {
      label: "JSON-RPC -32005 rate limit",
      payload: { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } },
      fallback: true,
      reason: "http_429",
    },
    {
      label: "unknown JSON-RPC error",
      payload: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution failed" } },
      fallback: false,
      reason: "transport_error",
    },
    {
      label: "missing JSON-RPC result",
      payload: { jsonrpc: "2.0", id: 1 },
      fallback: false,
      reason: "transport_error",
    },
    {
      label: "illegal JSON-RPC result hex",
      payload: { jsonrpc: "2.0", id: 1, result: "not-hex" },
      fallback: false,
      reason: "transport_error",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-bsc-rpc-"));
      try {
        const startedAt = Date.parse("2026-08-24T10:06:30.000Z");
        const nowRef = { value: startedAt };
        const rowsRef = { value: [candidate(startedAt)] };
        const tweetsRef = { value: [timelineTweet("895", "baseline", startedAt - 1_000)] };
        const alerts = [];
        const requests = [];
        let failed = false;
        const fetchImpl = async (url) => {
          requests.push(url);
          if (url === "https://bsc-rpc.test") {
            return jsonResponse(200, failed ? entry.payload : { jsonrpc: "2.0", id: 1, result: "0x7" });
          }
          if (url.endsWith("/2/profile/alpha")) {
            return jsonResponse(200, { code: 200, user: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } });
          }
          if (url.includes(`/2/profile/id:${X_ID}/statuses`)) {
            return jsonResponse(200, { code: 200, results: tweetsRef.value });
          }
          if (url.startsWith("https://publish.x.test/oembed?")) {
            const requested = new URL(url).searchParams.get("url");
            const id = requested.match(/\/status\/(\d+)$/)?.[1];
            const tweet = tweetsRef.value.find((item) => String(item.id) === id);
            return { ok: true, status: 200, text: async () => JSON.stringify(oembed(id, tweet.text)) };
          }
          throw new Error(`unexpected URL ${url}`);
        };
        const monitor = createHarness({
          dataDir, nowRef, rowsRef, tweetsRef, alerts, requests, fetchImpl, getBscActivityImpl: null,
        });
        await monitor.check();
        failed = true;
        nowRef.value += 60_000;
        const failedAt = nowRef.value;
        tweetsRef.value = [timelineTweet("896", `I am buying through a classified RPC failure. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
        const result = await monitor.check();
        const state = await monitor.getState();
        const circuit = state.transportCircuits["bsc_activity:alpha"];
        assert.equal(circuit.reason, entry.reason);
        assert.equal(result.delivered, entry.fallback ? 1 : 0);
        assert.equal(result.active, entry.fallback ? 1 : 0);
        assert.equal(alerts.length, entry.fallback ? 1 : 0);
        assert.equal(state.cursors.alpha, entry.fallback ? "896" : "895");
        assert.equal(requests.filter((url) => url.includes("/statuses")).length, entry.fallback ? 2 : 1);
        if (entry.fallback) {
          assert.equal(circuit.retryAfterMs, undefined);
          assert.equal(circuit.nextRetryAt, failedAt + 15 * 60_000,
            "a JSON-RPC rate limit without Retry-After uses the bounded existing 429 backoff");
          assert.deepEqual(state.health.sources.x.bscActivityFallbackHandles, ["alpha"]);
        } else {
          assert.deepEqual(state.health.sources.x.bscActivityFallbackHandles, []);
          assert.deepEqual(state.health.sources.x.effectiveCircuitHandles, ["alpha"]);
        }
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("BSC activity hard failures and expired proof freeze the tweet cursor", async (t) => {
  const cases = [
    {
      label: "HTTP 404 with fresh cache",
      advanceMs: 60_000,
      fail: async () => { const error = new Error("BSC activity HTTP 404"); error.httpStatus = 404; throw error; },
      circuitReason: "http_404",
    },
    {
      label: "malformed 200 with fresh cache",
      advanceMs: 60_000,
      fail: async () => "not-a-transaction-count",
      circuitReason: "transport_error",
    },
    {
      label: "zero transaction count",
      advanceMs: 60_000,
      fail: async () => 0,
      circuitReason: null,
      rejected: true,
    },
    {
      label: "timeout with cache older than 24 hours",
      advanceMs: 24 * 60 * 60_000 + 1,
      fail: async () => { const error = new Error("BSC activity timed out"); error.name = "TimeoutError"; throw error; },
      circuitReason: "timeout",
      refreshCandidate: true,
    },
    {
      label: "timeout with a mismatched cached wallet",
      advanceMs: 5_000,
      fail: async () => { const error = new Error("BSC activity timed out"); error.name = "TimeoutError"; throw error; },
      circuitReason: "timeout",
      tamperActivityWallet: true,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-bsc-hard-"));
      try {
        const startedAt = Date.parse("2026-08-24T10:07:00.000Z");
        const nowRef = { value: startedAt };
        const rowsRef = { value: [candidate(startedAt)] };
        const tweetsRef = { value: [timelineTweet("900", "baseline", startedAt - 1_000)] };
        const alerts = [];
        const requests = [];
        let failed = false;
        const harnessOptions = {
          dataDir, nowRef, rowsRef, tweetsRef, alerts, requests,
          configOverrides: { fomoXCallAttributionMaxAgeMs: 2 * 24 * 60 * 60_000 },
          getBscActivityImpl: async () => failed ? entry.fail() : 7,
        };
        let monitor = createHarness(harnessOptions);
        await monitor.check();
        if (entry.tamperActivityWallet) {
          await monitor.stop();
          const stateFile = path.join(dataDir, "fomo-x-call-state.json");
          const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
          persisted.roster.alpha.bscActivity.wallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          await fs.writeFile(stateFile, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
          monitor = createHarness(harnessOptions);
        }
        failed = true;
        nowRef.value += entry.advanceMs;
        if (entry.refreshCandidate) rowsRef.value = [candidate(nowRef.value)];
        tweetsRef.value = [timelineTweet("901", `I am buying but BSC proof must fail closed. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
        const result = await monitor.check();
        const state = await monitor.getState();
        assert.equal(result.status, "degraded");
        assert.equal(result.active, 0);
        assert.equal(result.delivered, 0);
        assert.equal(alerts.length, 0);
        assert.equal(state.cursors.alpha, "900");
        assert.equal(requests.filter((url) => url.includes(`/2/profile/id:${X_ID}/statuses`)).length, 1,
          "a hard or unproven BSC identity result must not fetch the next timeline page");
        if (entry.circuitReason) {
          assert.equal(state.transportCircuits["bsc_activity:alpha"].reason, entry.circuitReason);
          assert.deepEqual(state.health.sources.x.effectiveCircuitHandles, ["alpha"]);
          assert.ok(state.health.coverage.reasonsByHandle.alpha.some((reason) => reason.startsWith("bsc_activity_")));
        } else {
          assert.equal(state.transportCircuits["bsc_activity:alpha"], undefined);
          assert.equal(state.roster.alpha.bscActivity.count, 0, "a valid zero invalidates the former positive cache");
          assert.ok(Number(state.roster.alpha.admissionRejectedUntil) > nowRef.value);
        }
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("a 36-handle BSC outage has bounded requests and transition-only logs while cached timelines continue", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:09:00.000Z");
  const nowRef = { value: startedAt };
  const identities = Object.fromEntries(Array.from({ length: 36 }, (_, index) => {
    const handle = `fomo${index}`;
    return [handle, {
      id: String(123_456_789_000_000_000n + BigInt(index)),
      wallet: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      tweetId: String(10_000 + index),
    }];
  }));
  const rowsRef = { value: Object.entries(identities).map(([handle, identity]) => candidate(startedAt, {
    handle,
    wallet: identity.wallet,
    wallets: [identity.wallet],
    twitterHandles: [handle],
  })) };
  const requests = [];
  const { logger, entries } = captureLogger();
  let activityOutage = false;
  let activityCalls = 0;
  const activitySignals = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    for (const [handle, identity] of Object.entries(identities)) {
      if (url.endsWith(`/2/profile/${handle}`)) {
        return jsonResponse(200, { code: 200, user: {
          id: identity.id, screen_name: handle, followers: 25_000, protected: false,
        } });
      }
      if (url.includes(`/2/profile/id:${identity.id}/statuses`)) {
        return jsonResponse(200, { code: 200, results: [timelineTweet(identity.tweetId, `${handle} baseline`, nowRef.value - 1_000, {
          author: { id: identity.id, screen_name: handle, name: handle },
          url: `https://x.com/${handle}/status/${identity.tweetId}`,
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
    configOverrides: { fomoXCallBatchSize: 50, fomoXCallConcurrency: 10 },
    getBscActivityImpl: async (_wallet, { signal }) => {
      activityCalls += 1;
      activitySignals.push(signal);
      if (activityOutage) {
        const error = new Error("BSC activity timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return 7;
    },
  });
  let result = await monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.active, 36);
  assert.equal(activityCalls, 36);
  assert.ok(activitySignals.every((signal) => getEventListeners(signal, "abort").length === 0),
    "successful injected dependencies must not retain lifecycle listeners");

  activityOutage = true;
  nowRef.value += 60_000;
  result = await monitor.check();
  let state = await monitor.getState();
  assert.equal(result.status, "degraded");
  assert.equal(result.active, 36);
  assert.equal(activityCalls, 72);
  assert.equal(entries.warn.filter((message) => message.includes("bsc_activity")).length, 36);
  assert.equal(entries.error.length, 0);
  assert.ok(activitySignals.every((signal) => getEventListeners(signal, "abort").length === 0),
    "failed injected dependencies must release lifecycle listeners after their race settles");
  assert.equal(state.health.sources.x.transportBackoffs, 36);
  assert.equal(state.health.sources.x.effectiveTransportBackoffs, 0);
  assert.equal(state.health.sources.x.bscActivityFallbackHandles.length, 36);
  assert.equal(state.health.sources.x.degradedSourceHandles.length, 36);

  const timelineRequestsBeforeCooling = requests.filter((url) => url.includes("/statuses")).length;
  for (let poll = 1; poll <= 10; poll += 1) {
    nowRef.value += 5_000;
    result = await monitor.check();
    assert.equal(result.active, 36);
  }
  state = await monitor.getState();
  assert.equal(activityCalls, 72, "all open per-handle circuits must make zero BSC requests during cooling");
  assert.equal(entries.warn.filter((message) => message.includes("bsc_activity")).length, 36,
    "cooling polls must not repeat per-handle outage logs");
  assert.equal(entries.error.length, 0, "transport backoffs are summarized as health, not error spam");
  assert.equal(requests.filter((url) => url.includes("/statuses")).length, timelineRequestsBeforeCooling + 10 * 36,
    "fresh exact-wallet activity cache keeps every timeline in the hot loop");
  assert.equal(state.health.status, "degraded");
});

test("stop aborts a blocked BSC activity refresh without advancing the cursor and restart resumes the gap", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:11:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const tweetsRef = { value: [timelineTweet("920", "baseline", startedAt - 1_000)] };
  const alerts = [];
  const { logger, entries } = captureLogger();
  let blocked = false;
  let activityStarted = false;
  let releaseActivity;
  const blockedActivity = new Promise((resolve) => { releaseActivity = resolve; });
  let monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts, logger,
    getBscActivityImpl: async () => {
      if (!blocked) return 7;
      activityStarted = true;
      return blockedActivity;
    },
  });
  await monitor.check();
  nowRef.value += 60_000;
  blocked = true;
  tweetsRef.value = [timelineTweet("921", `I am buying after a restart. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  const interruptedCheck = monitor.check();
  while (!activityStarted) await new Promise((resolve) => setImmediate(resolve));
  await Promise.race([
    monitor.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stop did not abort blocked BSC activity")), 250)),
  ]);
  await interruptedCheck;
  let state = await monitor.getState();
  assert.equal(state.cursors.alpha, "920");
  assert.equal(state.transportCircuits["bsc_activity:alpha"], undefined);
  assert.equal(alerts.length, 0);
  assert.equal(entries.error.length, 0, "an intentional lifecycle cancellation is not logged as a source failure");
  const stoppedState = structuredClone(state);
  const stoppedFile = await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8");
  releaseActivity(99);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await monitor.getState(), stoppedState, "an ignored dependency completion must not mutate stopped state");
  assert.equal(await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8"), stoppedFile);

  blocked = false;
  monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, getBscActivityImpl: async () => 9 });
  const recovered = await monitor.check();
  state = await monitor.getState();
  assert.equal(recovered.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.equal(state.cursors.alpha, "921", "restart processes the gap from the last committed cursor exactly once");
});

test("stop drains two pre-queued checks without letting the second create a late BSC request or write", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:13:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const tweetsRef = { value: [timelineTweet("930", "baseline", startedAt - 1_000)] };
  const requests = [];
  let activityCalls = 0;
  let firstBlocked = false;
  let releaseFirstActivity;
  const firstActivity = new Promise((resolve) => { releaseFirstActivity = resolve; });
  const neverSettles = new Promise(() => {});
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts: [], requests,
    getBscActivityImpl: async () => {
      activityCalls += 1;
      if (activityCalls === 1) return 7;
      if (activityCalls === 2) {
        firstBlocked = true;
        return firstActivity;
      }
      return neverSettles;
    },
  });
  await monitor.check();
  const durableState = await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8");
  nowRef.value += 60_000;
  tweetsRef.value = [timelineTweet("931", `I am buying after queued shutdown. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];

  const firstQueued = monitor.check();
  while (!firstBlocked) await new Promise((resolve) => setImmediate(resolve));
  const requestsAtStop = requests.length;
  const secondQueued = monitor.check();
  await Promise.race([
    monitor.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stop waited for the second queued BSC dependency")), 750)),
  ]);
  assert.equal((await firstQueued).status, "stopped");
  assert.equal((await secondQueued).status, "stopped");
  assert.equal(activityCalls, 2, "the second pre-queued check must not create a BSC request after stop");
  assert.equal(requests.length, requestsAtStop, "the second pre-queued check must not create any source request after stop");
  assert.equal(await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8"), durableState,
    "an aborted check and its queued successor must not replace the durable state");
  assert.equal((await monitor.getState()).cursors.alpha, "930");

  releaseFirstActivity(99);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activityCalls, 2);
  assert.equal(await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8"), durableState);
  assert.deepEqual(unhandled, []);
});

test("slow Fomo X polls coalesce concurrent requests without replaying a queued backlog", async (t) => {
  const dataDir = await fixture(t);
  const nowRef = { value: Date.parse("2026-09-17T07:00:00.000Z") };
  const rowsRef = { value: [candidate(nowRef.value)] };
  const tweetsRef = { value: [timelineTweet("940", "baseline", nowRef.value - 1_000)] };
  let activityStarted;
  const entered = new Promise((resolve) => { activityStarted = resolve; });
  let releaseActivity;
  const blocked = new Promise((resolve) => { releaseActivity = resolve; });
  let activityCalls = 0;
  const monitor = createHarness({
    dataDir, nowRef, rowsRef, tweetsRef, alerts: [],
    getBscActivityImpl: async () => {
      activityCalls += 1;
      if (activityCalls === 1) { activityStarted(); await blocked; }
      return 7;
    },
  });
  t.after(() => monitor.stop());
  const first = monitor.check();
  await entered;
  const repeated = Array.from({ length: 50 }, () => monitor.check());
  assert.ok(repeated.every((promise) => promise === first));
  releaseActivity();
  const results = await Promise.all([first, ...repeated]);
  assert.ok(results.every((result) => result === results[0]));
  assert.equal(activityCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activityCalls, 1, "missed ticks must not be replayed after recovery");
  nowRef.value += 60_000;
  await monitor.check();
  assert.equal(activityCalls, 2, "a subsequent poll after completion still performs fresh work");
});

test("stop reloads a background seed write that completed while the active BSC check was blocked", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:14:00.000Z");
  const nowRef = { value: startedAt };
  const seedHandle = "seedone";
  const seedWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const seedId = "223456789012345678";
  const rowsRef = { value: [candidate(startedAt)] };
  const requests = [];
  let bscBlocked = true;
  let bscStarted = false;
  let releaseBlockedBsc;
  const blockedBsc = new Promise((resolve) => { releaseBlockedBsc = resolve; });
  let releaseSeed;
  const seedDiscovery = new Promise((resolve) => { releaseSeed = resolve; });
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/2/profile/alpha")) {
      return jsonResponse(200, { code: 200, user: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } });
    }
    if (url.endsWith(`/2/profile/${seedHandle}`)) {
      return jsonResponse(200, { code: 200, user: { id: seedId, screen_name: seedHandle, followers: 30_000, protected: false } });
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) {
      return jsonResponse(200, { code: 200, results: [timelineTweet("940", "alpha baseline", nowRef.value - 1_000)] });
    }
    if (url.includes(`/2/profile/id:${seedId}/statuses`)) {
      return jsonResponse(200, { code: 200, results: [timelineTweet("950", "seed baseline", nowRef.value - 1_000, {
        author: { id: seedId, screen_name: seedHandle, name: "Seed One" },
        url: `https://x.com/${seedHandle}/status/950`,
      })] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createHarness({
    dataDir,
    nowRef,
    rowsRef,
    tweetsRef: { value: [] },
    alerts: [],
    requests,
    fetchImpl,
    configOverrides: { fomoCallPublicHandles: [seedHandle], fomoXCallVerifiedSeedBatchSize: 1 },
    discoverVerifiedSeedImpl: async () => seedDiscovery,
    getBscActivityImpl: async () => {
      if (!bscBlocked) return 7;
      bscStarted = true;
      return blockedBsc;
    },
  });

  const activeCheck = monitor.check();
  while (!bscStarted) await new Promise((resolve) => setImmediate(resolve));
  const checkedAt = new Date(nowRef.value).toISOString();
  releaseSeed(candidate(nowRef.value, {
    handle: seedHandle,
    wallet: seedWallet,
    wallets: [seedWallet],
    twitterHandles: [seedHandle],
    source: "fomoscan_verified_profile",
    origin: "fomoscan_verified_profile",
    candidateSource: "fomoscan_verified_profile",
    walletBinding: {
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      wallet: seedWallet,
      handle: seedHandle,
      twitterHandle: seedHandle,
      checkedAt,
      lastCheckedAt: checkedAt,
    },
  }));
  await monitor.waitForDiscovery();
  let disk = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8"));
  assert.deepEqual(Object.keys(disk.roster).sort(), ["alpha", seedHandle], "the background seed writer durably owns the newer roster");

  await Promise.race([
    monitor.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stop did not drain the background seed race")), 750)),
  ]);
  assert.equal((await activeCheck).status, "stopped");
  disk = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8"));
  assert.deepEqual(await monitor.getState(), disk, "stop must reload the final owner-only durable state after every writer drains");
  assert.deepEqual(Object.keys(disk.roster).sort(), ["alpha", seedHandle]);
  releaseBlockedBsc(99);
  await new Promise((resolve) => setImmediate(resolve));

  bscBlocked = false;
  await monitor.start();
  let state = await monitor.getState();
  assert.ok(state.roster[seedHandle], "same-instance restart must not overwrite the durable seed with a stale rollback snapshot");
  await monitor.stop();
  state = await monitor.getState();
  disk = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-x-call-state.json"), "utf8"));
  assert.ok(state.roster[seedHandle]);
  assert.deepEqual(state, disk);
});

test("profile 404 remains fail-closed even while cached identity evidence is fresh", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T10:15:00.000Z");
  const nowRef = { value: startedAt };
  const rowsRef = { value: [candidate(startedAt)] };
  const tweetsRef = { value: [timelineTweet("890", "baseline", startedAt - 1_000)] };
  const alerts = [];
  const requests = [];
  let profileMissing = false;
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/2/profile/alpha")) {
      return profileMissing
        ? jsonResponse(404, { code: 404, message: "User not found" })
        : jsonResponse(200, { code: 200, user: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } });
    }
    if (url.includes(`/2/profile/id:${X_ID}/statuses`)) return jsonResponse(200, { code: 200, results: tweetsRef.value });
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createHarness({ dataDir, nowRef, rowsRef, tweetsRef, alerts, requests, fetchImpl });
  await monitor.check();
  profileMissing = true;
  nowRef.value += 60_000;
  tweetsRef.value = [timelineTweet("891", `I am buying but must not pass 404. CA ${TOKEN}`, nowRef.value - 500), ...tweetsRef.value];
  const result = await monitor.check();
  const state = await monitor.getState();
  assert.equal(result.status, "degraded");
  assert.equal(result.admitted, 1);
  assert.equal(result.active, 0);
  assert.equal(alerts.length, 0);
  assert.equal(requests.filter((url) => url.includes(`/2/profile/id:${X_ID}/statuses`)).length, 1, "timeline must not run after a hard profile 404");
  assert.equal(state.transportCircuits["fxtwitter_profile:alpha"].reason, "http_404");
  assert.deepEqual(state.health.sources.x.effectiveCircuitHandles, ["alpha"]);
  assert.ok(state.health.coverage.reasonsByHandle.alpha.includes("profile_http_404"));
});

test("protected, mismatched, and non-numeric X identities remain fail-closed admission gates", async (t) => {
  const cases = [
    ["protected", { id: X_ID, screen_name: "alpha", followers: 25_000, protected: true }],
    ["mismatched handle", { id: X_ID, screen_name: "beta", followers: 25_000, protected: false }],
    ["non-numeric id", { id: "not-numeric", screen_name: "alpha", followers: 25_000, protected: false }],
  ];
  for (const [label, profile] of cases) {
    await t.test(label, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-gate-"));
      try {
        const nowRef = { value: Date.parse("2026-08-24T10:20:00.000Z") };
        const requests = [];
        const monitor = createHarness({
          dataDir,
          nowRef,
          rowsRef: { value: [candidate(nowRef.value)] },
          tweetsRef: { value: [] },
          alerts: [],
          requests,
          profileRef: { value: profile },
        });
        const result = await monitor.check();
        const state = await monitor.getState();
        assert.equal(result.status, "degraded");
        assert.equal(result.active, 0);
        assert.equal(state.health.rejectedCount, 1);
        assert.equal(state.transportCircuits["fxtwitter_profile:alpha"], undefined);
        assert.equal(requests.some((url) => url.includes("/statuses")), false);
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  }
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
  assert.equal(recovered.status, "degraded", "recovery of alpha cannot hide beta's now-stale timeline");
  assert.equal(state.transportCircuits[circuitKey], undefined);
  assert.equal(state.cursors.alpha, "100");
  assert.equal(state.health.activeCount, 2);
  assert.equal(state.health.cachedCount, 3);
  assert.equal(state.health.freshCount, 3);
  assert.equal(state.health.backlogCount, 1);

  nowRef.value += 5_000;
  const refreshed = await monitor.check();
  state = await monitor.getState();
  assert.equal(refreshed.status, "healthy");
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
