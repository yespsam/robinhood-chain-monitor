import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { id, Interface } from "ethers";
import {
  attachGmgnObservedWallet,
  classifyFomoAlertDelivery,
  createFomoCallMonitor,
  detectBaseFirstBuys,
  detectOfficialBscCurveBuys,
  detectSolanaFirstBuys,
  evaluateGoPlusBscTokenSecurity,
  parseCopeActivities,
  parseCopeConvergences,
  parseCopeLeaderboard,
  parseDexScreenerMarket,
  parseFomoScanProfile,
  parseGmgnBscKolCandidates,
  parseGmgnBscSmartMoneyBuys,
  parseGmgnWalletStats,
  qualifyGmgnSmartMoneyWallet,
  selectVerifiedBscKols,
  selectFreshFomoXCallRoster,
  selectTopTrafficBloggers,
} from "../src/fomo-call-monitor.js";
import { isRelevantAlert, isStrongAlert, sendAlerts, telegramButtons } from "../src/alerts.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";

const BASE_TOKEN = "0x1111111111111111111111111111111111111111";
const BASE_POOL = "0x2222222222222222222222222222222222222222";
const SECOND_BASE_TOKEN = "0x4444444444444444444444444444444444444444";
const SECOND_BASE_POOL = "0x5555555555555555555555555555555555555555";
const SOL_TOKEN = "DezX7iJ4W8VqRXPpWLNq6YYr5ky2nrSR1GvSa8L7pump";
const SOL_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosg7eK";
const SOL_TOKEN_ACCOUNT_A = "9xQeWvG816bUx9EPjHmaT23yvVMVqSakQW9pDRD2PiY";
const SOL_TOKEN_ACCOUNT_B = "SysvarRent111111111111111111111111111111111";
const BASE_WALLET = "0x3333333333333333333333333333333333333333";
const FOUR_MANAGER = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const CACHED_FOUR_MANAGER = "0x9999999999999999999999999999999999999999";
const RECOVERED_FOUR_MANAGER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FOUR_CURVE_SOURCE_URL = "https://four.meme/meme-api/v1/public/address";
const FLAP_PORTAL = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";

function testBlockHash(blockNumber) {
  return `0x${(BigInt(blockNumber) + 100_000n).toString(16).padStart(64, "0")}`;
}

function ok(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function safeGoPlusRow(overrides = {}) {
  return {
    is_open_source: "1",
    is_in_dex: "1",
    owner_address: "",
    buy_tax: "0.05",
    sell_tax: "0.05",
    is_proxy: "0",
    is_mintable: "0",
    is_honeypot: "0",
    cannot_sell_all: "0",
    cannot_buy: "0",
    is_blacklisted: "0",
    is_whitelisted: "0",
    transfer_pausable: "0",
    trading_cooldown: "0",
    can_take_back_ownership: "0",
    owner_change_balance: "0",
    hidden_owner: "0",
    selfdestruct: "0",
    external_call: "0",
    personal_slippage_modifiable: "0",
    slippage_modifiable: "0",
    anti_whale_modifiable: "0",
    ...overrides,
  };
}

function goPlusPayload(token, row) {
  return { code: 1, result: { [token.toLowerCase()]: row } };
}

function qualifiedSmartWalletProfile(wallet, nowMs) {
  return {
    scheme: "gmgn_wallet_stats_dual_window_v1",
    wallet,
    chainId: 56,
    source: "gmgn_portfolio_stats",
    qualified: true,
    tags: ["launchpad_smart", "axiom"],
    createdAt: new Date(nowMs - 365 * 24 * 60 * 60_000).toISOString(),
    createdTokenCount: 0,
    feedObservedAt: new Date(nowMs - 1_000).toISOString(),
    statsCheckedAt: new Date(nowMs - 1_000).toISOString(),
    windows: {
      "7d": { realizedProfitUsd: 6_000, winRate: 0.62, realizedRoi: 0.02, tokenCount: 100, buyCount: 100, sellCount: 90 },
      "30d": { realizedProfitUsd: 20_000, winRate: 0.65, realizedRoi: 0.03, tokenCount: 200, buyCount: 300, sellCount: 280 },
    },
  };
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-call-monitor-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function writeCurveCircuitState(dataDir, current) {
  const checkedAt = new Date(current - 11 * 60_000).toISOString();
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    health: {
      status: "partial",
      source: "gmgn_profitable_wallet_onchain",
      checkedAt,
      lastSuccessAt: checkedAt,
      lastError: null,
      consecutiveFailures: 0,
    },
    publicOnchain: {
      initializedAt: checkedAt,
      curveSourcesCheckedAt: checkedAt,
      curveSourcesStatus: "healthy",
      fourMemeManagers: [CACHED_FOUR_MANAGER],
      bscSilentBaselinePending: false,
      bscNextBlock: 101,
      smartMoney: {
        initializedAt: checkedAt,
        feedInitializedAt: checkedAt,
        feedCheckedAt: new Date(current).toISOString(),
        feedStatus: "empty",
        candidates: {},
        roster: {},
        admittedWallets: [],
        seenTrades: {},
        pendingTrades: {},
        chainProofedTransactions: {},
        statsCheckedAt: new Date(current).toISOString(),
        statsStatus: "healthy",
        exactTradeStatus: "not_configured",
      },
    },
  }));
}

function createCurveCircuitMonitor(dataDir, clock, fetchImpl, logs) {
  return createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 24 * 60 * 60_000,
    fomoCallTelemetryPersistIntervalMs: 24 * 60 * 60_000,
  }, {
    autoStart: false,
    now: () => clock.current,
    wallNow: () => clock.current,
    discoverSmartMoneyTradesImpl: async () => { throw new Error("fresh smart-money feed must not poll"); },
    fetchSmartMoneyStatsImpl: async () => { throw new Error("empty roster must not fetch stats"); },
    fetchImpl,
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {},
    evmRpcImpl: async () => { throw new Error("empty roster must not scan BSC"); },
    logger: {
      error: (message) => logs.errors.push(message),
      info: (message) => logs.infos.push(message),
    },
  });
}

function smartCheckpointState(current, options = {}) {
  const wallet = String(options.wallet || BASE_WALLET).toLowerCase();
  const checkedAt = new Date(current).toISOString();
  const walletProfile = qualifiedSmartWalletProfile(wallet, current);
  const candidate = {
    wallet,
    tags: [...walletProfile.tags],
    firstSeenAt: current - 60_000,
    lastSeenAt: current - 1_000,
    lastTradeAt: current - 1_000,
    feedObservedAt: new Date(current - 1_000).toISOString(),
    profileStatus: options.profileStatus || "qualified",
    lastStatsAttemptAt: options.lastStatsAttemptAt ?? current - 1_000,
    nextStatsAttemptAt: options.nextStatsAttemptAt ?? current + 60 * 60_000,
    walletProfile,
    eoaVerified: true,
    eoaCheckedAt: checkedAt,
    walletCode: "0x",
  };
  return {
    version: 10,
    ...(options.checkpointRevision ? {
      fomoCallCheckpoint: {
        version: 1,
        revision: options.checkpointRevision,
        updatedAt: options.checkpointUpdatedAt || checkedAt,
      },
    } : {}),
    health: {
      status: "healthy",
      source: "gmgn_profitable_wallet_onchain",
      checkedAt,
      lastSuccessAt: checkedAt,
      lastError: null,
      consecutiveFailures: 0,
      durationMs: 0,
    },
    publicOnchain: {
      initializedAt: checkedAt,
      curveSourcesCheckedAt: checkedAt,
      curveSourcesStatus: "healthy",
      curveSourcesError: null,
      curveSourcesNextRetryAt: null,
      bscSilentBaselinePending: false,
      bscNextBlock: options.bscNextBlock ?? 101,
      coverage: {
        profiles: "disabled",
        curves: "healthy",
        solana: "not_configured",
        base: "not_configured",
        bsc: "healthy",
        smartMoney: {
          feed: "healthy", stats: "healthy", qualification: "healthy",
          fresh: 1, lastKnownGood: 0, exactTrades: "not_configured", admitted: 1,
        },
      },
      smartMoney: {
        initializedAt: checkedAt,
        feedInitializedAt: checkedAt,
        feedCheckedAt: checkedAt,
        feedStatus: "healthy",
        feedError: null,
        feedFailureCount: 0,
        feedNextRetryAt: null,
        lastFeedSuccessAt: checkedAt,
        candidates: { [wallet]: candidate },
        roster: options.includeRoster === false ? {} : {
          [wallet]: {
            monitorKind: "smart_money_performance",
            wallet,
            baseAddress: wallet,
            walletProfile,
            lastTradeAt: candidate.lastTradeAt,
            eoaVerified: true,
            eoaCheckedAt: checkedAt,
            walletCode: "0x",
            source: "gmgn_profitable_wallet_onchain",
            sourceClassification: {
              id: "gmgn_public_performance_wallet",
              gmgnTags: [...walletProfile.tags],
              includesKolTag: false,
              fomoOfficial: false,
              identityVerified: false,
            },
          },
        },
        admittedWallets: options.includeRoster === false ? [] : [wallet],
        seenTrades: {},
        pendingTrades: {},
        chainProofedTransactions: {},
        statsCheckedAt: checkedAt,
        statsStatus: "healthy",
        statsError: null,
        qualificationCoverage: {
          status: "healthy", admitted: 1, fresh: 1, lastKnownGood: 0, checkedAt,
        },
        exactTradeStatus: "not_configured",
        rateLimitedUntil: null,
      },
    },
  };
}

function checkpointBscDependencies(clock, options = {}) {
  return {
    autoStart: false,
    now: () => clock.current,
    wallNow: () => clock.current,
    discoverSmartMoneyTradesImpl: async () => { throw new Error("fresh feed must not poll"); },
    fetchSmartMoneyStatsImpl: async () => { throw new Error("fresh stats schedule must not poll"); },
    fetchImpl: async (url) => { throw new Error(`fresh curve inventory must not poll ${url}`); },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {},
    evmRpcImpl: async (_url, method) => {
      if (method === "eth_blockNumber") return `0x${Number(clock.head).toString(16)}`;
      throw new Error(`unexpected single RPC ${method}`);
    },
    evmRpcBatchImpl: async (_url, calls) => calls.map(({ params }) => {
      const blockNumber = Number(BigInt(params[0]));
      return {
        number: params[0],
        hash: testBlockHash(blockNumber),
        timestamp: `0x${Math.floor(clock.current / 1_000).toString(16)}`,
        transactions: [],
      };
    }),
    logger: { error() {}, info() {} },
    ...options,
  };
}

function probedDurableFs(directory, probe = {}) {
  const normalizedDirectory = path.resolve(directory);
  return {
    readFile: (...args) => fs.readFile(...args),
    stat: (...args) => fs.stat(...args),
    mkdir: (...args) => fs.mkdir(...args),
    rename: (...args) => fs.rename(...args),
    rm: (...args) => fs.rm(...args),
    chmod: async (...args) => {
      probe.chmodCount = Number(probe.chmodCount || 0) + 1;
      return fs.chmod(...args);
    },
    open: async (target, ...args) => {
      const handle = await fs.open(target, ...args);
      const isDirectory = path.resolve(String(target)) === normalizedDirectory;
      return new Proxy(handle, {
        get(handleTarget, property) {
          if (property === "sync") {
            return async () => {
              if (isDirectory) {
                probe.directorySyncCount = Number(probe.directorySyncCount || 0) + 1;
                if (probe.failDirectorySyncAt === probe.directorySyncCount) {
                  throw new Error("simulated checkpoint directory fsync failure");
                }
              } else {
                probe.fileSyncCount = Number(probe.fileSyncCount || 0) + 1;
              }
              return handleTarget.sync();
            };
          }
          const value = handleTarget[property];
          return typeof value === "function" ? value.bind(handleTarget) : value;
        },
      });
    },
  };
}

async function injectedAtomicWrite(file, value, failPhase = null) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${file}.${failPhase || "success"}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (failPhase === "rename") throw new Error("simulated main rename failure");
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
    if (failPhase === "directory fsync") throw new Error("simulated main directory fsync failure");
    const directoryHandle = await fs.open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

test("standalone worker exits before touching state when embedded mode is selected", async (t) => {
  const dataDir = await fixture(t);
  const entrypoint = new URL("../src/fomo-worker.js", import.meta.url);
  const child = spawn(process.execPath, [entrypoint.pathname], {
    cwd: path.dirname(entrypoint.pathname),
    env: { ...process.env, FOMO_CALL_STANDALONE: "false", DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("standalone worker did not stop after mode gating"));
    }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(result, { code: 0, signal: null });
  await assert.rejects(fs.access(path.join(dataDir, "fomo-call-state.json")), (error) => error?.code === "ENOENT");
  await assert.rejects(fs.access(path.join(dataDir, "fomo-alerts", "alert-outbox.json")), (error) => error?.code === "ENOENT");
});

test("ranks Fomo-related bloggers by followers after applying on-chain quality gates", () => {
  const parsed = parseCopeLeaderboard({ leaderboard: [
    { handle: "profitable", followers: 20_000, pnl: 50_000, num_trades: 200, total_volume: 2_000_000 },
    { handle: "largest", followers: 100_000, pnl: 10_000, num_trades: 40, total_volume: 500_000 },
    { handle: "inactive", followers: 1_000_000, pnl: 1, num_trades: 2, total_volume: 10 },
    { handle: "losing", followers: 500_000, pnl: -10, num_trades: 500, total_volume: 5_000_000 },
  ] });
  const top = selectTopTrafficBloggers(parsed, { limit: 10, minimumTrades: 20, minimumVolume: 100_000 });
  assert.deepEqual(top.map((item) => item.handle), ["largest", "profitable"]);
  assert.equal(top[0].trafficRank, 1);
  assert.equal(top[0].leaderboardRank, 2, "profit rank and traffic rank remain separate metrics");
});

test("parses GMGN BSC KOL candidates and marks handle-wallet attribution ambiguity", () => {
  const alphaWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const betaWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const clearWallet = "0xcccccccccccccccccccccccccccccccccccccccc";
  const alternateAlphaWallet = "0xdddddddddddddddddddddddddddddddddddddddd";
  const candidates = parseGmgnBscKolCandidates({ data: { list: [
    {
      maker: alphaWallet,
      maker_info: { twitter_username: "@Alpha", tags: ["FOMO", "kol"] },
      timestamp: 1_800_000_000,
    },
    {
      maker: alphaWallet.toUpperCase().replace("0X", "0x"),
      maker_info: { twitter_username: "alpha", tags: ["fomo", "KOL", "fomo"] },
      timestamp: 1_800_000_010,
    },
    {
      maker: alternateAlphaWallet,
      maker_info: { twitter_username: "ALPHA", tags: ["fomo", "kol"] },
      timestamp: 1_800_000_020,
    },
    {
      maker: betaWallet,
      maker_info: { twitter_username: "beta", tags: ["fomo", "kol"] },
      timestamp: 1_800_000_005,
    },
    {
      maker: betaWallet,
      maker_info: { twitter_username: "gamma", tags: ["fomo", "kol"] },
      timestamp: 1_800_000_006,
    },
    {
      maker: clearWallet,
      maker_info: { twitter_username: "clear", tags: ["fomo", "kol"] },
      timestamp: 1_800_000_030,
    },
    {
      maker: "0xffffffffffffffffffffffffffffffffffffffff",
      maker_info: { twitter_username: "wash", tags: ["fomo", "kol", "wash_trader"] },
      timestamp: 1_800_000_031,
    },
    {
      maker: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      maker_info: { twitter_username: "arb", tags: ["fomo", "kol", "arbitrager"] },
      timestamp: 1_800_000_032,
    },
    { maker: betaWallet, maker_info: { twitter_username: "not-a-handle", tags: ["kol"] } },
    { maker: "0x1234", maker_info: { twitter_username: "broken_wallet", tags: ["kol"] } },
    { maker: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", maker_info: { twitter_username: "untagged", tags: ["smart_money"] } },
  ] } });

  assert.deepEqual(candidates.map((candidate) => candidate.handle.toLowerCase()), ["alpha", "beta", "clear", "gamma"]);

  const alpha = candidates.find((candidate) => candidate.handle.toLowerCase() === "alpha");
  assert.equal(alpha.wallet, alternateAlphaWallet, "the newest valid observation remains the display wallet");
  assert.deepEqual(alpha.wallets, [alphaWallet, alternateAlphaWallet]);
  assert.deepEqual(alpha.twitterHandles.map((handle) => handle.toLowerCase()), ["alpha"]);
  assert.equal(alpha.ambiguousWallets, true);
  assert.equal(alpha.ambiguousHandles, false);
  assert.equal(alpha.ambiguousIdentity, true);

  const beta = candidates.find((candidate) => candidate.handle === "beta");
  const gamma = candidates.find((candidate) => candidate.handle === "gamma");
  assert.deepEqual(beta.wallets, [betaWallet]);
  assert.deepEqual(beta.twitterHandles.map((handle) => handle.toLowerCase()).sort(), ["beta", "gamma"]);
  assert.equal(beta.ambiguousWallets, false);
  assert.equal(beta.ambiguousHandles, true);
  assert.equal(beta.ambiguousIdentity, true);
  assert.deepEqual(gamma.twitterHandles.map((handle) => handle.toLowerCase()).sort(), ["beta", "gamma"]);
  assert.equal(gamma.ambiguousIdentity, true);

  const clear = candidates.find((candidate) => candidate.handle === "clear");
  assert.deepEqual(clear, {
    handle: "clear",
    wallet: clearWallet,
    wallets: [clearWallet],
    twitterHandles: ["clear"],
    ambiguousWallets: false,
    ambiguousHandles: false,
    ambiguousIdentity: false,
    tags: ["fomo", "kol"],
    discoveredAt: 1_800_000_030_000,
    source: "gmgn_bsc_kol_feed",
  });
});

test("parses only clean GMGN BSC smart-money buys without trusting its position flag", () => {
  const observedAtMs = Date.parse("2027-01-15T00:00:00Z");
  const wallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const tx = `0x${"a".repeat(64)}`;
  const [trade] = parseGmgnBscSmartMoneyBuys({ list: [
    {
      transaction_hash: tx,
      maker: wallet,
      base_address: BASE_TOKEN,
      amount_usd: 0,
      timestamp: observedAtMs / 1_000,
      side: "buy",
      is_open_or_close: 0,
      base_token: { symbol: "NEW", launchpad: "flap" },
      maker_info: { tags: ["app_smart_money", "axiom"] },
    },
    {
      transaction_hash: `0x${"b".repeat(64)}`,
      maker: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      base_address: BASE_TOKEN,
      timestamp: observedAtMs / 1_000,
      side: "sell",
      maker_info: { tags: ["smart_degen"] },
    },
    {
      transaction_hash: `0x${"c".repeat(64)}`,
      maker: "0xcccccccccccccccccccccccccccccccccccccccc",
      base_address: BASE_TOKEN,
      timestamp: observedAtMs / 1_000,
      side: "buy",
      maker_info: { tags: ["smart_degen", "wash_trader"] },
    },
  ] }, { observedAtMs });
  assert.equal(trade.wallet, wallet);
  assert.equal(trade.transactionHash, tx);
  assert.equal(trade.amountUsd, null, "zero/missing USD is not a qualification floor");
  assert.deepEqual(trade.tags, ["app_smart_money", "axiom"], "GMGN smart-money feed provenance must not require the smart_degen label");
  assert.equal(trade.sourceReportedPositionFlag, 0, "the source flag remains display-only evidence");
  assert.equal(trade.openPositionReported, undefined);
});

test("qualifies a GMGN wallet only when both fresh performance windows pass", () => {
  const nowMs = Date.parse("2027-01-15T00:00:00Z");
  const wallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const raw = (period, overrides = {}) => ({
    wallet_address: wallet,
    realized_profit: period === "7d" ? "6258.72" : "17458.42",
    realized_profit_pnl: period === "7d" ? "0.017249" : "0.01963",
    buy: period === "7d" ? 1476 : 3610,
    sell: period === "7d" ? 1478 : 3616,
    last_timestamp: nowMs / 1_000 - 60,
    pnl_stat: { token_num: period === "7d" ? 223 : 510, winrate: period === "7d" ? 0.62011 : 0.63172 },
    common: {
      tags: ["fomo", "smart_degen"],
      created_at: nowMs / 1_000 - 365 * 24 * 60 * 60,
      created_token_count: 0,
    },
    ...overrides,
  });
  const sevenDay = parseGmgnWalletStats(raw("7d"), { wallet, period: "7d", checkedAtMs: nowMs });
  const thirtyDay = parseGmgnWalletStats(raw("30d"), { wallet, period: "30d", checkedAtMs: nowMs });
  const profile = qualifyGmgnSmartMoneyWallet(sevenDay, thirtyDay, { nowMs });
  assert.equal(profile.scheme, "gmgn_wallet_stats_dual_window_v1");
  assert.equal(profile.windows["7d"].tokenCount, 223);
  assert.equal(profile.windows["30d"].realizedProfitUsd, 17_458.42);
  assert.equal(profile.createdTokenCount, 0);
  const alternateTags7d = parseGmgnWalletStats(raw("7d", { common: {
    tags: ["launchpad_smart", "axiom"],
    created_at: nowMs / 1_000 - 365 * 24 * 60 * 60,
    created_token_count: 0,
  } }), { wallet, period: "7d", checkedAtMs: nowMs });
  const alternateTags30d = parseGmgnWalletStats(raw("30d", { common: {
    tags: ["launchpad_smart", "axiom"],
    created_at: nowMs / 1_000 - 365 * 24 * 60 * 60,
    created_token_count: 0,
  } }), { wallet, period: "30d", checkedAtMs: nowMs });
  assert.equal(qualifyGmgnSmartMoneyWallet(alternateTags7d, alternateTags30d, { nowMs })?.qualified, true);
  assert.equal(qualifyGmgnSmartMoneyWallet({ ...sevenDay, winRate: 0.5999 }, thirtyDay, { nowMs }), null);
  assert.equal(qualifyGmgnSmartMoneyWallet(sevenDay, { ...thirtyDay, createdTokenCount: 11 }, { nowMs }), null);
  assert.equal(parseGmgnWalletStats(raw("7d", { common: { tags: ["smart_degen", "mev_bot"], created_at: 1, created_token_count: 0 } }), {
    wallet, period: "7d", checkedAtMs: nowMs,
  }), null);
});

test("smart-only producer migrates v9, silently baselines, rate-limits GMGN, and delivers exact swap/curve first buys", async (t) => {
  const smartWallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const baselineToken = "0x4444444444444444444444444444444444444444";
  const baselineTx = `0x${"7".repeat(64)}`;
  const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const usdt = "0x55d398326f99059ff775485246999027b3197955";
  const transferTopicAddress = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const erc20 = new Interface([
    "function balanceOf(address) view returns(uint256)",
    "function decimals() view returns(uint8)",
    "function symbol() view returns(string)",
  ]);
  const fourState = new Interface([
    "function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)",
    "function _tradingHalt() view returns(bool)",
  ]);
  const fourEvents = new Interface([
    "event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)",
    "event TokenSale(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)",
  ]);
  let telegramCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\//);
    telegramCalls += 1;
    return ok({ ok: true, result: { message_id: telegramCalls } });
  });
  t.mock.method(console, "info", () => {});

  async function runScenario(mode) {
    const curveMode = ["curve", "curve_quote_outage", "curve_quote_bad_data", "curve_quote_decode_error", "curve_event_decode_error"].includes(mode);
    const shouldDeliver = ["swap", "profile_only_kol", "trade_only_kol", "curve", "token_created_same_block"].includes(mode);
    const profileTags = ["swap", "profile_only_kol"].includes(mode)
      ? ["smart_degen", "kol", "gmgn"]
      : (["trade_only_kol", "dirty_trade_tag"].includes(mode)
        ? ["smart_degen", "gmgn"]
        : ["launchpad_smart", "axiom"]);
    const baselineTradeTags = ["profile_only_kol", "trade_only_kol", "dirty_trade_tag"].includes(mode)
      ? ["GMGN", "smart_degen"]
      : profileTags;
    const currentTradeTags = mode === "trade_only_kol"
      ? ["KOL", "smart_degen", "kol"]
      : (mode === "dirty_trade_tag"
        ? ["smart_degen", "MEV_BOT"]
        : (mode === "profile_only_kol" ? ["gmgn", "SMART_DEGEN"] : profileTags));
    const expectedGmgnTags = mode === "trade_only_kol"
      ? ["smart_degen", "gmgn", "kol"]
      : profileTags;
    const dataDir = await fixture(t);
    const startedAt = Date.now() - 120_000;
    const baselineAt = startedAt + 31_000;
    const buyAt = startedAt + 62_000;
    const hashDigit = ({
      curve: "9",
      swap: "8",
      profile_only_kol: "8",
      trade_only_kol: "8",
      dirty_trade_tag: "8",
      pool_mismatch: "a",
      zero_payment: "b",
      from_mismatch: "c",
      receipt_failed: "d",
      token_mismatch: "e",
      zero_position: "f",
      tx_hash_mismatch: "1",
      receipt_hash_mismatch: "2",
      receipt_status_missing: "5",
      receipt_status_unsupported: "6",
      transaction_hash_missing: "0",
      receipt_hash_missing: "3",
      receipt_status_false: "4",
      receipt_block_mismatch: "a",
      block_identity_mismatch: "b",
      block_timestamp_missing: "c",
      transaction_from_missing: "7",
      transaction_from_invalid: "8",
      transaction_block_hash_missing: "9",
      receipt_block_hash_missing: "a",
      receipt_block_hash_mismatch: "b",
      block_hash_mismatch: "c",
      block_timestamp_future: "d",
      receipt_logs_missing: "e",
      receipt_logs_nonarray: "f",
      log_tx_hash_mismatch: "1",
      log_block_number_mismatch: "2",
      log_block_hash_mismatch: "3",
      head_decimal: "4",
      head_unsafe: "5",
      curve_quote_outage: "6",
      zero_position_outage: "7",
      token_created_code_outage: "8",
      receipt_from_missing: "9",
      receipt_from_invalid: "a",
      receipt_from_mismatch: "b",
      log_identity_missing: "c",
      log_removed: "d",
      curve_quote_bad_data: "e",
      curve_quote_decode_error: "f",
      curve_event_decode_error: "1",
      balance_decode_error: "2",
      decimals_decode_error: "3",
      token_created_code_bad_data: "4",
      token_created_same_block: "5",
      token_created_not_same_block: "6",
      receipt_failed_from_missing: "7",
      receipt_failed_from_mismatch: "8",
      receipt_failed_empty_logs: "9",
      receipt_logs_empty: "a",
    })[mode];
    const transactionHash = `0x${hashDigit.repeat(64)}`;
    const blockHash = testBlockHash(999);
    const pool = curveMode ? FOUR_MANAGER : BASE_POOL;
    let current = startedAt;
    let wallClock = startedAt;
    let stage = 0;
    let copeCalls = 0;
    const gmgnStarts = [];
    const captured = [];
    const trade = (token, transaction, timestampMs, tags) => ({
      scheme: "gmgn_smartmoney_trade_v1",
      wallet: smartWallet,
      token,
      transactionHash: transaction,
      logIndex: null,
      side: "buy",
      occurredAt: new Date(timestampMs).toISOString(),
      observedAt: new Date(current).toISOString(),
      timestampMs,
      tags,
      tokenSymbol: curveMode ? "CURVE" : "SWAP",
      launchpad: curveMode ? "fourmeme" : null,
      amountUsd: null,
      sourceReportedPositionFlag: 0,
      feedSource: "gmgn_track_smartmoney",
      eligible: true,
      blockedTags: [],
    });
    const baselineTrade = trade(baselineToken, baselineTx, baselineAt, baselineTradeTags);
    const buyTrade = trade(BASE_TOKEN, transactionHash, buyAt, currentTradeTags);
    if (mode === "dirty_trade_tag") {
      buyTrade.eligible = false;
      buyTrade.blockedTags = ["mev_bot"];
    }
    const stats = (period, checkedAtMs) => ({
      wallet: smartWallet,
      period,
      realizedProfitUsd: period === "7d" ? 6_258.72 : 17_458.42,
      winRate: period === "7d" ? 0.62011 : 0.63172,
      realizedRoi: period === "7d" ? 0.017249 : 0.01963,
      tokenCount: period === "7d" ? 223 : 510,
      buyCount: period === "7d" ? 1_476 : 3_610,
      sellCount: period === "7d" ? 1_478 : 3_616,
      lastTradeAt: new Date(checkedAtMs - 1_000).toISOString(),
      createdAt: new Date(checkedAtMs - 365 * 24 * 60 * 60_000).toISOString(),
      createdTokenCount: 0,
      tags: profileTags,
      checkedAt: new Date(checkedAtMs).toISOString(),
    });
    const receiptToken = mode === "token_mismatch" ? SECOND_BASE_TOKEN : BASE_TOKEN;
    const tokenTransfer = {
      address: receiptToken,
      logIndex: "0x4",
      topics: [id("Transfer(address,address,uint256)"), transferTopicAddress(pool), transferTopicAddress(smartWallet)],
      data: `0x${(10n ** 18n).toString(16).padStart(64, "0")}`,
    };
    let receiptLogs;
    if (curveMode) {
      const purchase = fourEvents.encodeEventLog(fourEvents.getEvent("TokenPurchase"), [
        BASE_TOKEN, smartWallet, 1n, 10n ** 18n, 1n, 0n, 1n, 1n,
      ]);
      receiptLogs = [tokenTransfer, {
        address: FOUR_MANAGER,
        topics: purchase.topics,
        data: mode === "curve_event_decode_error" ? "0x" : purchase.data,
      }];
    } else {
      receiptLogs = [{
        address: BASE_POOL,
        topics: [id("Swap(address,uint256,uint256,uint256,uint256,address)")],
        data: "0x",
      }, tokenTransfer];
    }
    receiptLogs = receiptLogs.map((log) => ({
      ...log,
      transactionHash,
      blockNumber: "0x3e7",
      blockHash,
    }));
    if (mode === "log_tx_hash_mismatch") receiptLogs[0].transactionHash = `0x${"f".repeat(64)}`;
    if (mode === "log_block_number_mismatch") receiptLogs[0].blockNumber = "0x3e6";
    if (mode === "log_block_hash_mismatch") receiptLogs[0].blockHash = testBlockHash(998);
    if (mode === "log_identity_missing") delete receiptLogs[0].transactionHash;
    if (mode === "log_removed") receiptLogs[0].removed = true;
    const receipt = {
      status: ["receipt_failed", "receipt_failed_from_missing", "receipt_failed_from_mismatch", "receipt_failed_empty_logs"].includes(mode)
        ? "0x0"
        : (mode === "receipt_status_missing"
          ? undefined
          : (mode === "receipt_status_false" ? false : (mode === "receipt_status_unsupported" ? "0x2" : "0x1"))),
      transactionHash: mode === "receipt_hash_missing"
        ? undefined
        : (mode === "receipt_hash_mismatch" ? `0x${"3".repeat(64)}` : transactionHash),
      blockNumber: mode === "receipt_block_mismatch" ? "0x3e6" : "0x3e7",
      blockHash: mode === "receipt_block_hash_missing"
        ? undefined
        : (mode === "receipt_block_hash_mismatch" ? testBlockHash(998) : blockHash),
      from: mode === "receipt_from_missing"
        || mode === "receipt_failed_from_missing"
        ? undefined
        : (mode === "receipt_from_invalid"
          ? "not-an-address"
          : (["receipt_from_mismatch", "receipt_failed_from_mismatch"].includes(mode) ? BASE_WALLET : smartWallet)),
      logs: mode === "receipt_logs_missing"
        ? undefined
        : (mode === "receipt_logs_nonarray"
          ? {}
          : (["receipt_failed_empty_logs", "receipt_logs_empty"].includes(mode) ? [] : receiptLogs)),
    };
    const transaction = {
      hash: mode === "transaction_hash_missing"
        ? undefined
        : (mode === "tx_hash_mismatch" ? `0x${"4".repeat(64)}` : transactionHash),
      from: mode === "transaction_from_missing"
        ? undefined
        : (mode === "transaction_from_invalid" ? "not-an-address" : (mode === "from_mismatch" ? BASE_WALLET : smartWallet)),
      to: pool,
      value: mode === "zero_payment" ? "0x0" : "0x1",
      blockNumber: "0x3e7",
      blockHash: mode === "transaction_block_hash_missing" ? undefined : blockHash,
    };
    const tokenInfoResult = () => fourState.encodeFunctionResult("_tokenInfos", [
      BASE_TOKEN,
      "0x0000000000000000000000000000000000000000",
      1n,
      10n ** 27n,
      1n,
      1n,
      BigInt(Math.floor((current - 1_000) / 1_000)),
      1n,
      10n ** 18n,
      1n,
      1n,
      1n,
      0n,
    ]);
    const bscHistoricalProvider = {
      call: async (request) => {
        if (request.data.startsWith(fourState.getFunction("_tokenInfos").selector)) {
          if (mode === "curve_quote_outage") throw new Error("simulated curve quote infrastructure outage");
          if (mode === "curve_quote_bad_data") {
            const error = new Error("simulated curve quote BAD_DATA");
            error.code = "BAD_DATA";
            throw error;
          }
          if (mode === "curve_quote_decode_error") return "0x";
          return tokenInfoResult();
        }
        if (request.data.startsWith(erc20.getFunction("balanceOf").selector)) {
          if (mode === "zero_position_outage") throw new Error("simulated historical balance infrastructure outage");
          if (["token_created_code_outage", "token_created_same_block", "token_created_not_same_block"].includes(mode)) {
            const error = new Error("simulated missing historical state");
            error.code = "CALL_EXCEPTION";
            throw error;
          }
          if (mode === "token_created_code_bad_data") {
            const error = new Error("simulated missing historical state");
            error.code = "CALL_EXCEPTION";
            throw error;
          }
          if (mode === "balance_decode_error") return "0x";
          return erc20.encodeFunctionResult("balanceOf", [mode === "zero_position" ? 1n : 0n]);
        }
        if (request.data.startsWith(erc20.getFunction("decimals").selector)) {
          if (mode === "decimals_decode_error") return "0x";
          return erc20.encodeFunctionResult("decimals", [18]);
        }
        throw new Error(`unexpected historical call ${request.data.slice(0, 10)}`);
      },
      getCode: async (_address, blockTag) => {
        if (mode === "token_created_code_outage") throw new Error("simulated getCode infrastructure outage");
        if (mode === "token_created_code_bad_data") {
          const error = new Error("simulated getCode BAD_DATA");
          error.code = "BAD_DATA";
          throw error;
        }
        if (mode === "token_created_same_block") return blockTag === 998 ? "0x" : "0x01";
        if (mode === "token_created_not_same_block") return "0x01";
        return "0x01";
      },
    };
    const bscProvider = curveMode ? {
      getCode: async () => "0x01",
      call: async (request) => {
        if (request.data.startsWith(fourState.getFunction("_tokenInfos").selector)) return tokenInfoResult();
        if (request.data.startsWith(fourState.getFunction("_tradingHalt").selector)) return fourState.encodeFunctionResult("_tradingHalt", [false]);
        if (request.data.startsWith(erc20.getFunction("symbol").selector)) return erc20.encodeFunctionResult("symbol", ["CURVE"]);
        throw new Error(`unexpected curve call ${request.data.slice(0, 10)}`);
      },
    } : {};
    const config = {
      dataDir,
      monitorScope: "focus3",
      ponsMonitorEnabled: false,
      fomoCallEnabled: true,
      fomoBuyMonitorEnabled: false,
      fomoSmartMoneyMonitorEnabled: true,
      copeApiKey: "must-not-be-used",
      fomoCallPublicHandles: [],
      fomoCallSharedRosterEnabled: false,
      fomoCallDynamicDiscoveryEnabled: false,
      fomoCallBscOnly: true,
      fomoCallNewWalletLookbackBlocks: 0,
      fomoCallBscConfirmations: 0,
      fomoCallBscMaxCatchupBlocks: 20,
      fomoCallBscRpcUrl: "https://bsc.example/rpc",
      fomoCallMinLiquidityUsd: 10_000,
      fomoCallMaxSignalAgeMs: 300_000,
      fomoCallMaxPairAgeMs: 30 * 24 * 60 * 60_000,
      fomoCallMaxEmitsPerCheck: 3,
      fomoCallGoPlusEnabled: false,
      fomoSmartMoneyDiscoveryIntervalMs: 30_000,
      fomoSmartMoneyStatsBatchLimit: 1,
      fomoSmartMoneyStatsRequestIntervalMs: 3_000,
      fomoSmartMoneyQualifiedCacheMs: 30 * 60_000,
      fomoSmartMoneyRejectedCacheMs: 60 * 60_000,
      fomoSmartMoneyMaxStatsAgeMs: 2 * 60 * 60_000,
      fomoSmartMoneyCandidateRetentionMs: 24 * 60 * 60_000,
      blockedContracts: new Set(),
      telegramToken: "test-bot-token",
      telegramChatId: "123456789",
      telegramStrongAlerts: true,
      alertBilingualEnabled: true,
      alertChineseTranslationEnabled: false,
      alertTelegramDeliveryMaxAgeMs: 7_200_000,
      webhookUrl: "",
    };
    await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
      version: 9,
      topBloggers: [{ handle: "legacy", baseAddress: BASE_WALLET }],
      pending: {
        legacy: { call: { kind: "top_blogger_first_buy", timestampMs: startedAt }, firstSeenAt: startedAt },
      },
      seenCalls: { "legacy-seen": startedAt },
      publicOnchain: {
        bscNextBlock: 1_001,
        bscSilentBaselinePending: false,
        bscLookbackRequested: false,
      },
    }));
    const monitor = createFomoCallMonitor(config, {
      autoStart: false,
      now: () => current,
      wallNow: () => wallClock,
      sleepImpl: async (delayMs) => { wallClock += delayMs; },
      discoverSmartMoneyTradesImpl: async () => {
        gmgnStarts.push({ kind: "feed", at: wallClock });
        if (stage === 0) return [];
        return stage === 1 ? [baselineTrade] : [baselineTrade, buyTrade];
      },
      fetchSmartMoneyStatsImpl: async (wallet, period, checkedAtMs) => {
        assert.equal(wallet, smartWallet);
        gmgnStarts.push({ kind: period, at: wallClock });
        return stats(period, checkedAtMs);
      },
      fetchImpl: async (url) => {
        const text = String(url);
        if (text.includes("four.meme/meme-api/v1/public/address")) return ok({
          code: 0,
          data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
        });
        if (text.includes("api.cope.capital")) {
          copeCalls += 1;
          throw new Error("legacy Cope lane must stay disabled");
        }
        if (text.includes(`/bsc/${BASE_TOKEN}`) && !curveMode) return ok({ pairs: [{
          chainId: "bsc",
          pairAddress: mode === "pool_mismatch" ? SECOND_BASE_POOL : BASE_POOL,
          dexId: "pancakeswap",
          baseToken: { address: BASE_TOKEN, symbol: "SWAP" },
          quoteToken: { address: wbnb },
          liquidity: { usd: 80_000 },
          volume: { m5: 25_000 },
          txns: { m5: { buys: 30, sells: 4 } },
          pairCreatedAt: buyAt - 60_000,
          marketCap: 900_000,
          priceUsd: "0.001",
        }] });
        if (text.includes(`/bsc/${wbnb}`)) return ok({ pairs: [{
          chainId: "bsc",
          pairAddress: "0x7777777777777777777777777777777777777777",
          baseToken: { address: wbnb },
          quoteToken: { address: usdt },
          priceUsd: "600",
          liquidity: { usd: 2_000_000 },
        }] });
        throw new Error(`unexpected producer fetch ${url}`);
      },
      baseProvider: {},
      bscProvider,
      bscHistoricalProvider,
      evmRpcImpl: async (_rpcUrl, method, params) => {
        if (method === "eth_getCode" && String(params?.[0]).toLowerCase() === smartWallet) return "0x";
        if (method === "eth_blockNumber") {
          if (mode === "head_decimal") return "1000";
          if (mode === "head_unsafe") return "0x20000000000000";
          return "0x3e8";
        }
        if (method === "eth_getTransactionByHash" && params?.[0] === transactionHash) return transaction;
        if (method === "eth_getTransactionReceipt" && params?.[0] === transactionHash) return receipt;
        if (method === "eth_getBlockByNumber" && params?.[0] === "0x3e7") return {
          number: mode === "block_identity_mismatch" ? 998 : 999,
          hash: mode === "block_hash_mismatch" ? testBlockHash(998) : blockHash,
          timestamp: mode === "block_timestamp_missing"
            ? undefined
            : `0x${Math.floor((mode === "block_timestamp_future" ? buyAt + 61_000 : buyAt) / 1_000).toString(16)}`,
          transactions: [],
        };
        if (method === "eth_getLogs" && curveMode) {
          const sale = fourEvents.encodeEventLog(fourEvents.getEvent("TokenSale"), [
            BASE_TOKEN, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1n, 1n, 1n, 0n, 1n, 1n,
          ]);
          return [{ address: FOUR_MANAGER, transactionHash: `0x${"6".repeat(64)}`, topics: sale.topics, data: sale.data }];
        }
        throw new Error(`unexpected producer EVM RPC ${method}`);
      },
      evmRpcBatchImpl: async (_rpcUrl, calls) => {
        assert.equal(calls.length, 0, "preserved cursor at safeHead+1 must not replay blocks for a newly admitted wallet");
        return [];
      },
      assessEvmSecurityImpl: async () => ({
        decision: "pass",
        label: "pass",
        reasons: [],
        warnings: [],
        metrics: { liquidityConfirmed: true },
      }),
      sendAlertsImpl: async (runtimeConfig, event) => {
        captured.push(event);
        assert.equal(isMonitoringSourceEnabled(runtimeConfig, event), true, `${mode} producer event must pass the real source route`);
        assert.equal(isRelevantAlert(event), true, `${mode} producer event must pass the real relevance gate`);
        return sendAlerts(runtimeConfig, event);
      },
      logger: { error() {} },
    });

    await monitor.check();
    let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
    assert.equal(state.version, 10);
    assert.equal(state.publicOnchain.bscNextBlock, 1_001, "v9 BSC cursor must survive the v10 smart-money migration");
    assert.equal(state.publicOnchain.bscSilentBaselinePending, false);
    assert.equal(state.publicOnchain.smartMoney.feedInitializedAt, null, "an empty feed must not initialize the baseline");
    assert.equal(Object.keys(state.pending).length, 0, "legacy pending buys must be discarded in smart-only mode");
    assert.equal(state.topBloggers[0].handle, "legacy", "legacy state may be retained for rollback but must not be refreshed or scanned");
    assert.equal(state.coverageSummary.monitoredTopCount, 0, "smart-only coverage must ignore the retained legacy roster");

    stage = 1;
    current = baselineAt;
    await monitor.check();
    state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
    assert.equal(captured.length, 0, "the first non-empty GMGN feed is a silent baseline");
    assert.equal(state.publicOnchain.smartMoney.baseline.mode, "silent_first_nonempty_feed");
    assert.equal(Object.keys(state.publicOnchain.smartMoney.pendingTrades).length, 0);
    assert.deepEqual(state.publicOnchain.smartMoney.admittedWallets, [smartWallet]);

    stage = 2;
    current = buyAt;
    const emitted = await monitor.check();
    if (!shouldDeliver) {
      assert.equal(captured.length, 0, `${mode} evidence must fail closed before alert routing`);
      assert.equal(emitted, null);
      assert.equal(copeCalls, 0, "legacy Cope calls must remain completely disabled");
      const rejectedState = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
      const pendingKey = `${transactionHash}:${smartWallet}:${BASE_TOKEN}`;
      if ([
        "tx_hash_mismatch",
        "receipt_hash_mismatch",
        "transaction_hash_missing",
        "receipt_hash_missing",
        "receipt_status_missing",
        "receipt_status_unsupported",
        "receipt_status_false",
        "receipt_block_mismatch",
        "block_identity_mismatch",
        "block_timestamp_missing",
        "transaction_from_missing",
        "transaction_from_invalid",
        "transaction_block_hash_missing",
        "receipt_block_hash_missing",
        "receipt_block_hash_mismatch",
        "block_hash_mismatch",
        "block_timestamp_future",
        "receipt_logs_missing",
        "receipt_logs_nonarray",
        "log_tx_hash_mismatch",
        "log_block_number_mismatch",
        "log_block_hash_mismatch",
        "curve_quote_outage",
        "zero_position_outage",
        "token_created_code_outage",
        "receipt_from_missing",
        "receipt_from_invalid",
        "receipt_from_mismatch",
        "log_identity_missing",
        "log_removed",
        "curve_quote_bad_data",
        "curve_quote_decode_error",
        "curve_event_decode_error",
        "balance_decode_error",
        "decimals_decode_error",
        "token_created_code_bad_data",
        "token_created_not_same_block",
        "receipt_failed_from_missing",
        "receipt_failed_from_mismatch",
        "receipt_failed",
        "receipt_logs_empty",
      ].includes(mode)) {
        assert.equal(rejectedState.publicOnchain.smartMoney.pendingTrades[pendingKey]?.attempts, 1,
          `${mode} is inconclusive infrastructure evidence and must remain retryable until the five-minute TTL`);
      } else if (["head_decimal", "head_unsafe"].includes(mode)) {
        assert.ok(rejectedState.publicOnchain.smartMoney.pendingTrades[pendingKey],
          `${mode} must retain the exact trade when the safe head cannot be proven`);
        assert.equal(Number(rejectedState.publicOnchain.smartMoney.pendingTrades[pendingKey]?.attempts || 0), 0,
          `${mode} fails before an exact transaction attempt is made`);
      } else {
        assert.equal(rejectedState.publicOnchain.smartMoney.pendingTrades[pendingKey], undefined,
          `${mode} is a conclusive non-buy and must not clog exact retries`);
      }
      if (mode === "dirty_trade_tag") {
        assert.equal(rejectedState.publicOnchain.smartMoney.candidates[smartWallet]?.profileStatus, "revoked_blocked_tag");
        assert.deepEqual(rejectedState.publicOnchain.smartMoney.candidates[smartWallet]?.tags,
          ["gmgn", "smart_degen", "mev_bot"], "the actual trade's dirty maker tag must remain auditable");
        assert.equal(rejectedState.publicOnchain.smartMoney.roster[smartWallet], undefined,
          "a dirty current feed trade must revoke admission before exact evidence can emit");
      }
      return;
    }
    assert.equal(captured.length, 1);
    assert.equal(emitted?.signalKind, "high_profit_high_winrate_wallet_buy");
    assert.equal(emitted?.source?.id, "gmgn_profitable_wallet_onchain");
    assert.equal(emitted?.source?.trust, "public_onchain_profiled");
    assert.equal(emitted?.caller, null);
    assert.equal(emitted?.walletBinding, null);
    assert.equal(emitted?.walletAttribution, null);
    assert.equal(emitted?.fomoUrl, undefined);
    assert.equal(emitted?.profileUrl, undefined);
    assert.equal(emitted?.action, "buy");
    assert.equal(emitted?.platform?.id, "smart-money");
    assert.deepEqual(emitted?.walletProfile?.tags, profileTags);
    assert.deepEqual(emitted?.sourceTrade?.tags, expectedGmgnTags,
      `${mode} must preserve the normalized profile + candidate/current-trade tag union`);
    assert.deepEqual(emitted?.sourceClassification, {
      id: "gmgn_public_performance_wallet",
      gmgnTags: expectedGmgnTags,
      includesKolTag: expectedGmgnTags.includes("kol"),
      fomoOfficial: false,
      identityVerified: false,
    });
    assert.deepEqual(emitted?.positionSemantics, {
      id: "new_position_after_previous_block_zero",
      label: "前一区块零仓后的新建仓",
      proofBoundary: "previous_block",
      lifetimeFirstBuyVerified: false,
      transactionImmediatePreBalanceVerified: false,
    });
    assert.equal(emitted?.sourceTrade?.paymentRaw, "1", "one wei of verified positive payment must pass without a USD floor");
    assert.equal(emitted?.sourceTrade?.executionPool, pool);
    assert.equal(emitted?.sourceTrade?.exactExecutionPoolVerified, true);
    assert.equal(emitted?.transactionProof?.executionPool, pool);
    assert.equal(emitted?.transactionProof?.eoaVerified, true);
    assert.equal(emitted?.transactionProof?.walletCode, "0x");
    assert.equal(emitted?.executionPool, pool);
    assert.equal(emitted?.executionPairVerified, true);
    assert.equal(emitted?.exactExecutionPoolVerified, true);
    assert.equal(emitted?.sourceTrade?.swapVerified, !curveMode);
    assert.equal(emitted?.sourceTrade?.curveBuyVerified, curveMode);
    assert.equal(copeCalls, 0, "legacy Cope calls must remain completely disabled");
    assert.ok(gmgnStarts.every((entry, index) => index === 0 || entry.at - gmgnStarts[index - 1].at >= 3_000),
      `all GMGN feed/stats starts must share one 3s slot: ${JSON.stringify(gmgnStarts)}`);
    assert.deepEqual(gmgnStarts.map((entry) => entry.kind), ["feed", "feed", "7d", "30d", "feed"]);
  }

  await runScenario("swap");
  await t.test("profile-only KOL tag is preserved in the exact normalized producer union", async () => {
    await runScenario("profile_only_kol");
  });
  await t.test("trade-only KOL tag is preserved without creating a Fomo or KOL identity claim", async () => {
    await runScenario("trade_only_kol");
  });
  await t.test("dirty current trade maker tag revokes the wallet and never emits", async () => {
    await runScenario("dirty_trade_tag");
  });
  await runScenario("curve");
  await runScenario("token_created_same_block");
  for (const mode of [
    "pool_mismatch",
    "zero_payment",
    "from_mismatch",
    "receipt_failed",
    "receipt_failed_empty_logs",
    "receipt_logs_empty",
    "token_mismatch",
    "zero_position",
    "tx_hash_mismatch",
    "receipt_hash_mismatch",
    "transaction_hash_missing",
    "receipt_hash_missing",
    "receipt_status_missing",
    "receipt_status_unsupported",
    "receipt_status_false",
    "receipt_block_mismatch",
    "block_identity_mismatch",
    "block_timestamp_missing",
    "transaction_from_missing",
    "transaction_from_invalid",
    "transaction_block_hash_missing",
    "receipt_block_hash_missing",
    "receipt_block_hash_mismatch",
    "block_hash_mismatch",
    "block_timestamp_future",
    "receipt_logs_missing",
    "receipt_logs_nonarray",
    "log_tx_hash_mismatch",
    "log_block_number_mismatch",
    "log_block_hash_mismatch",
    "head_decimal",
    "head_unsafe",
    "curve_quote_outage",
    "zero_position_outage",
    "token_created_code_outage",
    "receipt_from_missing",
    "receipt_from_invalid",
    "receipt_from_mismatch",
    "log_identity_missing",
    "log_removed",
    "curve_quote_bad_data",
    "curve_quote_decode_error",
    "curve_event_decode_error",
    "balance_decode_error",
    "decimals_decode_error",
    "token_created_code_bad_data",
    "token_created_not_same_block",
    "receipt_failed_from_missing",
    "receipt_failed_from_mismatch",
  ]) await runScenario(mode);
  assert.equal(telegramCalls, 5, "each real producer path must reach Telegram exactly once");
});

test("exact smart-money work ignores unknown backlog, purges rejected wallets, and caps admitted checks at three", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2027-01-15T00:00:00Z");
  const smartWallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const rejectedWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const walletProfile = qualifiedSmartWalletProfile(smartWallet, current);
  const trade = (wallet, index, timestampMs) => ({
    scheme: "gmgn_smartmoney_trade_v1",
    wallet,
    token: BASE_TOKEN,
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    logIndex: null,
    side: "buy",
    occurredAt: new Date(timestampMs).toISOString(),
    observedAt: new Date(current).toISOString(),
    timestampMs,
    firstSeenAt: timestampMs,
    tags: ["launchpad_smart", "axiom"],
    eligible: true,
  });
  const pendingTrades = {};
  for (let index = 0; index < 500; index += 1) {
    const wallet = `0x${(index + 100).toString(16).padStart(40, "0")}`;
    pendingTrades[`unknown-${index}`] = trade(wallet, index + 100, current - 120_000 + index);
  }
  pendingTrades.rejected = trade(rejectedWallet, 200, current - 60_000);
  for (let index = 0; index < 4; index += 1) {
    pendingTrades[`admitted-${index}`] = trade(smartWallet, index + 300, current - 30_000 + index);
  }
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    publicOnchain: {
      curveSourcesCheckedAt: new Date(current).toISOString(),
      curveSourcesStatus: "healthy",
      fourMemeManagers: [FOUR_MANAGER],
      bscNextBlock: 1_001,
      bscSilentBaselinePending: false,
      bscLookbackRequested: false,
      smartMoney: {
        feedInitializedAt: new Date(current - 60_000).toISOString(),
        feedCheckedAt: new Date(current).toISOString(),
        feedStatus: "healthy",
        candidates: {
          [smartWallet]: {
            wallet: smartWallet,
            tags: ["launchpad_smart", "axiom"],
            firstSeenAt: current - 60_000,
            lastSeenAt: current,
            profileStatus: "qualified",
            nextStatsAttemptAt: current + 30 * 60_000,
            walletProfile,
          },
          [rejectedWallet]: {
            wallet: rejectedWallet,
            tags: ["launchpad_smart"],
            firstSeenAt: current - 60_000,
            lastSeenAt: current,
            profileStatus: "rejected_7d",
            nextStatsAttemptAt: current + 60 * 60_000,
          },
        },
        roster: {
          [smartWallet]: {
            monitorKind: "smart_money_performance",
            wallet: smartWallet,
            baseAddress: smartWallet,
            walletProfile,
            eoaVerified: true,
            eoaCheckedAt: new Date(current).toISOString(),
            walletCode: "0x",
            source: "gmgn_profitable_wallet_onchain",
          },
        },
        admittedWallets: [smartWallet],
        seenTrades: {},
        pendingTrades,
        statsStatus: "healthy",
      },
    },
  }));
  let transactionCalls = 0;
  let receiptCalls = 0;
  let statsCalls = 0;
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoCallBscConfirmations: 0,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
    fomoCallMaxSignalAgeMs: 300_000,
    fomoSmartMoneyDiscoveryIntervalMs: 30_000,
  }, {
    autoStart: false,
    now: () => current,
    wallNow: () => current,
    discoverSmartMoneyTradesImpl: async () => { throw new Error("fresh feed cache must prevent discovery"); },
    fetchSmartMoneyStatsImpl: async () => { statsCalls += 1; return null; },
    fetchImpl: async (url) => { throw new Error(`unexpected fetch ${url}`); },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {},
    evmRpcImpl: async (_url, method) => {
      if (method === "eth_blockNumber") return "0x3e8";
      if (method === "eth_getTransactionByHash") { transactionCalls += 1; return null; }
      if (method === "eth_getTransactionReceipt") { receiptCalls += 1; return null; }
      throw new Error(`unexpected exact RPC ${method}`);
    },
    logger: { error() {} },
  });
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(transactionCalls, 3, "only the three earliest admitted exact trades may consume RPC work");
  assert.equal(receiptCalls, 3);
  assert.equal(statsCalls, 0, "cached qualification must keep stats behind exact work without refreshing");
  assert.equal(state.publicOnchain.smartMoney.pendingTrades.rejected, undefined);
  assert.equal(Object.keys(state.publicOnchain.smartMoney.pendingTrades).filter((key) => key.startsWith("unknown-")).length, 496,
    "four admitted trades must displace old unknown work instead of being dropped by the 500 cap");
  assert.equal(state.publicOnchain.smartMoney.pendingTrades["admitted-0"].attempts, 1);
  assert.equal(state.publicOnchain.smartMoney.pendingTrades["admitted-1"].attempts, 1);
  assert.equal(state.publicOnchain.smartMoney.pendingTrades["admitted-2"].attempts, 1);
  assert.equal(state.publicOnchain.smartMoney.pendingTrades["admitted-3"].attempts, undefined);
  assert.equal(state.publicOnchain.smartMoney.exactTradeStatus, "partial");
});

test("BSC smart-wallet scan batches ninety-one failed receipts and advances without running token proofs", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2027-01-15T00:00:00Z");
  const smartWallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const walletProfile = qualifiedSmartWalletProfile(smartWallet, current);
  let wallClock = current;
  const phaseOrder = [];
  const transactionsByBlock = new Map();
  const transactionsByHash = new Map();
  for (let index = 0; index < 91; index += 1) {
    const blockNumber = 950 + Math.floor(index / 2);
    const transaction = {
      hash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      from: smartWallet,
      to: FOUR_MANAGER,
      value: "0x1",
      blockNumber: `0x${blockNumber.toString(16)}`,
      blockHash: testBlockHash(blockNumber),
    };
    if (!transactionsByBlock.has(blockNumber)) transactionsByBlock.set(blockNumber, []);
    transactionsByBlock.get(blockNumber).push(transaction);
    transactionsByHash.set(transaction.hash, transaction);
  }
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    publicOnchain: {
      curveSourcesCheckedAt: new Date(current).toISOString(),
      curveSourcesStatus: "healthy",
      fourMemeManagers: [FOUR_MANAGER],
      bscNextBlock: 950,
      bscSilentBaselinePending: false,
      bscLookbackRequested: false,
      smartMoney: {
        feedInitializedAt: new Date(current - 60_000).toISOString(),
        feedCheckedAt: new Date(current - 31_000).toISOString(),
        feedStatus: "healthy",
        candidates: {
          [smartWallet]: {
            wallet: smartWallet,
            tags: ["launchpad_smart", "axiom"],
            firstSeenAt: current - 60_000,
            lastSeenAt: current,
            profileStatus: "qualified",
            nextStatsAttemptAt: current - 1,
            walletProfile,
          },
        },
        roster: {
          [smartWallet]: {
            monitorKind: "smart_money_performance",
            wallet: smartWallet,
            baseAddress: smartWallet,
            walletProfile,
            eoaVerified: true,
            eoaCheckedAt: new Date(current).toISOString(),
            walletCode: "0x",
            source: "gmgn_profitable_wallet_onchain",
          },
        },
        admittedWallets: [smartWallet],
        pendingTrades: {},
        seenTrades: {},
        statsStatus: "healthy",
      },
    },
  }));
  const receiptBatchSizes = [];
  const receiptBatchUrls = [];
  let proofCalls = 0;
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoCallBscConfirmations: 0,
    fomoCallBscMaxCatchupBlocks: 900,
    fomoCallBscStaleCursorBlocks: 900,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    wallNow: () => wallClock,
    sleepImpl: async (delayMs) => { wallClock += delayMs; },
    discoverSmartMoneyTradesImpl: async () => { phaseOrder.push("feed"); return []; },
    fetchSmartMoneyStatsImpl: async () => { phaseOrder.push("stats"); return null; },
    fetchImpl: async (url) => { throw new Error(`unexpected fetch ${url}`); },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {
      call: async () => { proofCalls += 1; throw new Error("failed receipts must not reach token proof"); },
      getCode: async () => { proofCalls += 1; throw new Error("failed receipts must not reach token proof"); },
    },
    evmRpcImpl: async (_url, method) => {
      assert.equal(method, "eth_blockNumber");
      return "0x3e8";
    },
    evmRpcBatchImpl: async (rpcUrl, calls) => {
      if (calls.every((call) => call.method === "eth_getBlockByNumber")) {
        phaseOrder.push("bsc_blocks");
        return calls.map((call) => {
          const blockNumber = Number(BigInt(call.params[0]));
          return {
            number: call.params[0],
            hash: testBlockHash(blockNumber),
            timestamp: `0x${Math.floor(current / 1_000).toString(16)}`,
            transactions: transactionsByBlock.get(blockNumber) || [],
          };
        });
      }
      assert.ok(calls.every((call) => call.method === "eth_getTransactionReceipt"));
      receiptBatchSizes.push(calls.length);
      receiptBatchUrls.push(rpcUrl);
      return calls.map((call) => {
        const transaction = transactionsByHash.get(call.params[0]);
        return {
          status: "0x0",
          transactionHash: call.params[0],
          blockNumber: transaction.blockNumber,
          blockHash: transaction.blockHash,
          from: transaction.from,
          logs: [],
        };
      });
    },
    logger: { error() {} },
  });
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.deepEqual(receiptBatchSizes.sort((left, right) => left - right), [11, 20, 20, 20, 20]);
  assert.ok(receiptBatchUrls.every((url) => url === "https://bsc-dataseed-public.bnbchain.org"),
    "receipt batches must avoid the observed publicnode historical 403 path");
  assert.equal(proofCalls, 0);
  assert.equal(state.publicOnchain.bscNextBlock, 1_001);
  assert.deepEqual(state.publicOnchain.smartMoney.chainProofedTransactions, {});
  assert.ok(phaseOrder.indexOf("feed") < phaseOrder.indexOf("bsc_blocks"));
  assert.ok(phaseOrder.lastIndexOf("bsc_blocks") < phaseOrder.indexOf("stats"),
    `stats must not delay feed/exact or the realtime BSC scan: ${JSON.stringify(phaseOrder)}`);
});

test("BSC smart-wallet proof cap resumes at the first unfinished block without losing its transaction", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2027-01-15T00:00:00Z");
  const smartWallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const walletProfile = qualifiedSmartWalletProfile(smartWallet, current);
  const transferTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const transactions = Array.from({ length: 4 }, (_, index) => ({
    hash: `0x${(index + 700).toString(16).padStart(64, "0")}`,
    from: smartWallet,
    to: BASE_POOL,
    value: "0x1",
    blockNumber: 997 + index,
    blockHash: testBlockHash(997 + index),
  }));
  let head = 1_000;
  let proofShouldFail = false;
  let invalidReceiptStatus = false;
  let booleanReceiptStatus = false;
  let mismatchedFailedReceipt = false;
  let failedReceiptFromFault = null;
  let failedReceiptNonemptyLogs = false;
  let mismatchedBlockIdentity = false;
  let invalidHead = null;
  let blockHashMissing = false;
  let futureBlockTimestamp = false;
  let transactionIdentityFault = null;
  let receiptIdentityFault = null;
  let receiptLogsFault = null;
  let receiptLogIdentityFault = null;
  let receiptFromFault = null;
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    publicOnchain: {
      curveSourcesCheckedAt: new Date(current).toISOString(),
      curveSourcesStatus: "healthy",
      fourMemeManagers: [FOUR_MANAGER],
      bscNextBlock: 997,
      bscSilentBaselinePending: false,
      smartMoney: {
        feedInitializedAt: new Date(current - 60_000).toISOString(),
        feedCheckedAt: new Date(current).toISOString(),
        feedStatus: "healthy",
        candidates: { [smartWallet]: {
          wallet: smartWallet,
          tags: ["launchpad_smart", "axiom"],
          firstSeenAt: current - 60_000,
          lastSeenAt: current,
          profileStatus: "qualified",
          nextStatsAttemptAt: current + 30 * 60_000,
          walletProfile,
        } },
        roster: { [smartWallet]: {
          monitorKind: "smart_money_performance",
          wallet: smartWallet,
          baseAddress: smartWallet,
          walletProfile,
          eoaVerified: true,
          eoaCheckedAt: new Date(current).toISOString(),
          walletCode: "0x",
          source: "gmgn_profitable_wallet_onchain",
        } },
        admittedWallets: [smartWallet],
        pendingTrades: {},
        seenTrades: {},
        chainProofedTransactions: {},
        statsStatus: "healthy",
      },
    },
  }));
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoCallBscConfirmations: 0,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    wallNow: () => current,
    discoverSmartMoneyTradesImpl: async () => { throw new Error("fresh feed cache must prevent discovery"); },
    fetchSmartMoneyStatsImpl: async () => { throw new Error("qualified cache must prevent stats"); },
    fetchImpl: async (url) => { throw new Error(`unexpected fetch ${url}`); },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {
      call: async () => {
        if (proofShouldFail) throw new Error("simulated historical proof outage");
        return "0x";
      },
      getCode: async () => {
        if (proofShouldFail) throw new Error("simulated historical code outage");
        return "0x01";
      },
    },
    evmRpcImpl: async (_url, method) => {
      assert.equal(method, "eth_blockNumber");
      if (invalidHead !== null) return invalidHead;
      return `0x${head.toString(16)}`;
    },
    evmRpcBatchImpl: async (_url, calls) => {
      if (calls.every((call) => call.method === "eth_getBlockByNumber")) return calls.map((call) => {
        const blockNumber = Number(BigInt(call.params[0]));
        const returnedTransactions = transactions
          .filter((transaction) => transaction.blockNumber === blockNumber)
          .map((transaction) => {
            if (!transactionIdentityFault || transaction.blockNumber !== head) return transaction;
            if (transactionIdentityFault === "hash_missing") return { ...transaction, hash: undefined };
            if (transactionIdentityFault === "from_missing") return { ...transaction, from: undefined };
            if (transactionIdentityFault === "block_number_mismatch") return { ...transaction, blockNumber: blockNumber - 1 };
            if (transactionIdentityFault === "block_hash_missing") return { ...transaction, blockHash: undefined };
            if (transactionIdentityFault === "block_hash_mismatch") return { ...transaction, blockHash: testBlockHash(blockNumber - 1) };
            return transaction;
          });
        return {
          number: mismatchedBlockIdentity ? blockNumber + 1 : blockNumber,
          hash: blockHashMissing ? undefined : testBlockHash(mismatchedBlockIdentity ? blockNumber + 1 : blockNumber),
          timestamp: `0x${Math.floor((futureBlockTimestamp ? current + 61_000 : current) / 1_000).toString(16)}`,
          transactions: returnedTransactions,
        };
      });
      return calls.map((call) => {
        if (mismatchedFailedReceipt) return {
          status: "0x0",
          transactionHash: `0x${"f".repeat(64)}`,
          blockNumber: transactions.find((transaction) => transaction.hash === call.params[0])?.blockNumber,
          blockHash: transactions.find((transaction) => transaction.hash === call.params[0])?.blockHash,
          from: smartWallet,
          logs: [],
        };
        const transaction = transactions.find((item) => item.hash === call.params[0]);
        if (failedReceiptFromFault) return {
          status: "0x0",
          transactionHash: call.params[0],
          blockNumber: transaction.blockNumber,
          blockHash: transaction.blockHash,
          from: failedReceiptFromFault === "missing" ? undefined : BASE_WALLET,
          logs: [],
        };
        const logs = [{
          address: BASE_TOKEN,
          topics: [id("Transfer(address,address,uint256)"), transferTopic(BASE_POOL), transferTopic(smartWallet)],
          data: `0x${"1".padStart(64, "0")}`,
          transactionHash: call.params[0],
          blockNumber: transaction.blockNumber,
          blockHash: transaction.blockHash,
        }];
        if (receiptLogIdentityFault === "transaction_hash") logs[0].transactionHash = `0x${"f".repeat(64)}`;
        if (receiptLogIdentityFault === "block_number") logs[0].blockNumber = `0x${(transaction.blockNumber - 1).toString(16)}`;
        if (receiptLogIdentityFault === "block_hash") logs[0].blockHash = testBlockHash(transaction.blockNumber - 1);
        if (receiptLogIdentityFault === "transaction_hash_missing") delete logs[0].transactionHash;
        if (receiptLogIdentityFault === "block_number_missing") delete logs[0].blockNumber;
        if (receiptLogIdentityFault === "block_hash_missing") delete logs[0].blockHash;
        if (receiptLogIdentityFault === "removed") logs[0].removed = true;
        if (proofShouldFail) logs.unshift({
          address: BASE_POOL,
          topics: [id("Swap(address,uint256,uint256,uint256,uint256,address)")],
          data: "0x",
          transactionHash: call.params[0],
          blockNumber: transaction.blockNumber,
          blockHash: transaction.blockHash,
        });
        return {
          status: failedReceiptNonemptyLogs
            ? "0x0"
            : (invalidReceiptStatus ? undefined : (booleanReceiptStatus ? false : "0x1")),
          transactionHash: call.params[0],
          blockNumber: receiptIdentityFault === "block_number" ? transaction.blockNumber - 1 : transaction.blockNumber,
          blockHash: receiptIdentityFault === "block_hash_missing"
            ? undefined
            : (receiptIdentityFault === "block_hash_mismatch" ? testBlockHash(transaction.blockNumber - 1) : transaction.blockHash),
          from: receiptFromFault === "missing"
            ? undefined
            : (receiptFromFault === "invalid" ? "not-an-address" : (receiptFromFault === "mismatch" ? BASE_WALLET : smartWallet)),
          logs: receiptLogsFault === "missing" ? undefined : (receiptLogsFault === "nonarray" ? {} : logs),
        };
      });
    },
    logger: { error() {} },
  });
  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_000, "the cursor must stop before the fourth unproved transaction");
  assert.deepEqual(Object.keys(state.publicOnchain.smartMoney.chainProofedTransactions).sort(), transactions.slice(0, 3).map((item) => item.hash).sort());

  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_001);
  assert.deepEqual(Object.keys(state.publicOnchain.smartMoney.chainProofedTransactions).sort(), transactions.map((item) => item.hash).sort());

  const failedTransaction = {
    hash: `0x${(999).toString(16).padStart(64, "0")}`,
    from: smartWallet,
    to: BASE_POOL,
    value: "0x1",
    blockNumber: 1_001,
    blockHash: testBlockHash(1_001),
  };
  transactions.push(failedTransaction);
  head = 1_001;
  proofShouldFail = true;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_001, "a proof outage must not advance beyond the failed candidate block");
  assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);

  proofShouldFail = false;
  invalidReceiptStatus = true;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_001, "a missing receipt status must fail closed at the same block");
  assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);

  invalidReceiptStatus = false;
  booleanReceiptStatus = true;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_001, "boolean false must not be coerced into a failed receipt status");
  assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);

  booleanReceiptStatus = false;
  mismatchedFailedReceipt = true;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_001,
    "even status-zero empty receipts must match the requested transaction before the cursor advances");
  assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);

  mismatchedFailedReceipt = false;
  for (const fault of ["missing", "mismatch"]) {
    failedReceiptFromFault = fault;
    await monitor.check();
    state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
    assert.equal(state.publicOnchain.bscNextBlock, 1_001,
      `even status-zero receipts with sender fault ${fault} must stop the cursor`);
    assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);
  }
  failedReceiptFromFault = null;
  failedReceiptNonemptyLogs = true;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_001,
    "a status-zero receipt with nonempty logs is internally inconsistent and must stop the cursor");
  assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);
  failedReceiptNonemptyLogs = false;
  mismatchedBlockIdentity = true;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 1_001, "a batch block identity mismatch must not advance the cursor");
  assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);

  const assertCursorStops = async (message) => {
    await monitor.check();
    state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
    assert.equal(state.publicOnchain.bscNextBlock, 1_001, message);
    assert.equal(state.publicOnchain.smartMoney.chainProofedTransactions[failedTransaction.hash], undefined);
  };
  mismatchedBlockIdentity = false;
  invalidHead = "1001";
  await assertCursorStops("a non-hex head must not advance the BSC cursor");
  invalidHead = "0x20000000000000";
  await assertCursorStops("an unsafe-integer head must not advance the BSC cursor");
  invalidHead = null;
  blockHashMissing = true;
  await assertCursorStops("a missing BSC block hash must stop the cursor");
  blockHashMissing = false;
  futureBlockTimestamp = true;
  await assertCursorStops("a future-dated BSC block must stop the cursor");
  futureBlockTimestamp = false;
  for (const fault of ["hash_missing", "from_missing", "block_number_mismatch", "block_hash_missing", "block_hash_mismatch"]) {
    transactionIdentityFault = fault;
    await assertCursorStops(`BSC transaction identity fault ${fault} must stop the cursor`);
  }
  transactionIdentityFault = null;
  for (const fault of ["block_number", "block_hash_missing", "block_hash_mismatch"]) {
    receiptIdentityFault = fault;
    await assertCursorStops(`BSC receipt identity fault ${fault} must stop the cursor`);
  }
  receiptIdentityFault = null;
  for (const fault of ["missing", "nonarray"]) {
    receiptLogsFault = fault;
    await assertCursorStops(`BSC receipt logs fault ${fault} must stop the cursor`);
  }
  receiptLogsFault = null;
  for (const fault of ["missing", "invalid", "mismatch"]) {
    receiptFromFault = fault;
    await assertCursorStops(`BSC successful receipt sender fault ${fault} must stop the cursor`);
  }
  receiptFromFault = null;
  for (const fault of [
    "transaction_hash", "block_number", "block_hash",
    "transaction_hash_missing", "block_number_missing", "block_hash_missing", "removed",
  ]) {
    receiptLogIdentityFault = fault;
    await assertCursorStops(`BSC receipt log identity fault ${fault} must stop the cursor`);
  }
});

test("GMGN RATE_LIMIT_BANNED reset_at stops all feed and stats CLI work until reset", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.now();
  const resetAtSeconds = Math.floor((current + 5 * 60_000) / 1_000);
  let feedCalls = 0;
  let statsCalls = 0;
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    copeApiKey: "must-not-be-used",
    fomoCallBscOnly: true,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
    fomoSmartMoneyDiscoveryIntervalMs: 30_000,
    fomoSmartMoneyStatsRequestIntervalMs: 3_000,
  }, {
    autoStart: false,
    now: () => current,
    discoverSmartMoneyTradesImpl: async () => {
      feedCalls += 1;
      throw new Error(JSON.stringify({ code: 429, error: "RATE_LIMIT_BANNED", reset_at: resetAtSeconds }));
    },
    fetchSmartMoneyStatsImpl: async () => { statsCalls += 1; return null; },
    fetchImpl: async (url) => {
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({ code: 0, data: [] });
      throw new Error(`legacy/API fetch must stay disabled: ${url}`);
    },
    baseProvider: {},
    bscProvider: {},
    evmRpcImpl: async () => { throw new Error("no BSC roster exists yet"); },
    logger: { error() {} },
  });
  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(feedCalls, 1);
  assert.equal(statsCalls, 0, "stats must not start after a feed 429");
  assert.equal(Date.parse(state.publicOnchain.smartMoney.rateLimitedUntil), resetAtSeconds * 1_000);

  current += 30_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(feedCalls, 1, "polling during reset_at cooldown would extend the upstream ban");
  assert.equal(statsCalls, 0);
  assert.equal(state.publicOnchain.smartMoney.feedStatus, "rate_limited");
  assert.equal(state.publicOnchain.smartMoney.statsStatus, "rate_limited");
});

test("GMGN smart-money feed uses persisted 1m, 2m, 5m backoff and recovers without a timeout storm", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2027-01-15T00:00:00Z") };
  await writeCurveCircuitState(dataDir, clock.current);
  const initial = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  initial.publicOnchain.smartMoney.feedCheckedAt = new Date(clock.current - 60_000).toISOString();
  initial.publicOnchain.smartMoney.feedStatus = "healthy";
  initial.publicOnchain.smartMoney.feedFailureCount = 0;
  initial.publicOnchain.smartMoney.feedNextRetryAt = null;
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(initial));

  let feedCalls = 0;
  let recover = false;
  const dependencies = {
    autoStart: false,
    now: () => clock.current,
    wallNow: () => clock.current,
    discoverSmartMoneyTradesImpl: async () => {
      feedCalls += 1;
      if (!recover) throw new Error("ConnectTimeout");
      return [];
    },
    fetchSmartMoneyStatsImpl: async () => { throw new Error("empty candidate set must not request stats"); },
    fetchImpl: async (url) => { throw new Error(`fresh curve inventory must not poll ${url}`); },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {},
    evmRpcImpl: async () => { throw new Error("empty roster must not scan BSC"); },
    logger: { error() {}, info() {} },
  };
  const config = {
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 15_000,
  };

  const first = createFomoCallMonitor(config, dependencies);
  await first.check();
  let checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(feedCalls, 1);
  assert.equal(checked.publicOnchain.smartMoney.feedFailureCount, 1);
  assert.equal(checked.publicOnchain.smartMoney.feedNextRetryAt, new Date(clock.current + 60_000).toISOString());
  await first.stop();

  clock.current += 30_000;
  const restarted = createFomoCallMonitor(config, dependencies);
  await restarted.check();
  assert.equal(feedCalls, 1, "feed retry cooldown survives process restart");
  clock.current += 30_000;
  await restarted.check();
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(feedCalls, 2);
  assert.equal(checked.publicOnchain.smartMoney.feedFailureCount, 2);
  assert.equal(checked.publicOnchain.smartMoney.feedNextRetryAt, new Date(clock.current + 2 * 60_000).toISOString());

  clock.current += 119_000;
  await restarted.check();
  assert.equal(feedCalls, 2, "the second ConnectTimeout must not create a rapid retry loop");
  clock.current += 1_000;
  await restarted.check();
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(feedCalls, 3);
  assert.equal(checked.publicOnchain.smartMoney.feedFailureCount, 3);
  assert.equal(checked.publicOnchain.smartMoney.feedNextRetryAt, new Date(clock.current + 5 * 60_000).toISOString());

  clock.current += 299_000;
  await restarted.check();
  assert.equal(feedCalls, 3);
  recover = true;
  clock.current += 1_000;
  await restarted.check();
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(feedCalls, 4);
  assert.equal(checked.publicOnchain.smartMoney.feedStatus, "empty");
  assert.equal(checked.publicOnchain.smartMoney.feedFailureCount, 0);
  assert.equal(checked.publicOnchain.smartMoney.feedNextRetryAt, null);
  assert.equal(checked.publicOnchain.smartMoney.lastFeedSuccessAt, new Date(clock.current).toISOString());
  await restarted.stop();
});

test("expired smart-wallet stats retain a bounded LKG roster across outage and restart, then recover before BSC scanning", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2027-01-15T00:00:00Z"), head: 100 };
  const wallet = BASE_WALLET.toLowerCase();
  const state = smartCheckpointState(clock.current, {
    nextStatsAttemptAt: clock.current - 1,
    bscNextBlock: 101,
  });
  const staleAt = new Date(clock.current - 3 * 60 * 60_000).toISOString();
  state.publicOnchain.smartMoney.candidates[wallet].walletProfile.statsCheckedAt = staleAt;
  state.publicOnchain.smartMoney.candidates[wallet].eoaCheckedAt = staleAt;
  state.publicOnchain.smartMoney.roster[wallet].walletProfile.statsCheckedAt = staleAt;
  state.publicOnchain.smartMoney.roster[wallet].eoaCheckedAt = staleAt;
  state.publicOnchain.smartMoney.qualificationCoverage = {
    status: "last_known_good", admitted: 1, fresh: 0, lastKnownGood: 1, checkedAt: staleAt,
  };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(state));

  let statsMode = "outage";
  let statsCalls = 0;
  let bscHeadCalls = 0;
  const statsFor = (period, checkedAtMs) => {
    const profile = qualifiedSmartWalletProfile(wallet, checkedAtMs);
    return {
      wallet,
      period,
      ...profile.windows[period],
      lastTradeAt: new Date(checkedAtMs - 1_000).toISOString(),
      createdAt: profile.createdAt,
      createdTokenCount: profile.createdTokenCount,
      tags: profile.tags,
      checkedAt: new Date(checkedAtMs).toISOString(),
    };
  };
  const dependencies = checkpointBscDependencies(clock, {
    sleepImpl: async () => {},
    fetchSmartMoneyStatsImpl: async (_wallet, period, checkedAtMs) => {
      statsCalls += 1;
      if (statsMode === "outage") return null;
      return statsFor(period, checkedAtMs);
    },
    evmRpcImpl: async (_url, method) => {
      if (method === "eth_getCode") return "0x";
      if (method === "eth_blockNumber") {
        bscHeadCalls += 1;
        return "0x64";
      }
      throw new Error(`unexpected LKG RPC ${method}`);
    },
  });
  const config = {
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
    fomoSmartMoneyQualifiedCacheMs: 60_000,
    fomoSmartMoneyMaxStatsAgeMs: 2 * 60 * 60_000,
    fomoSmartMoneyCandidateRetentionMs: 24 * 60 * 60_000,
  };

  const monitor = createFomoCallMonitor(config, dependencies);
  await monitor.check();
  let checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(statsCalls, 1, "invalid/null 7d stats is a transient outage, not a deterministic rejection");
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].profileStatus, "qualified_degraded_stats");
  assert.deepEqual(checked.publicOnchain.smartMoney.admittedWallets, [wallet]);
  assert.ok(checked.publicOnchain.smartMoney.roster[wallet], "the last-known-good profile must not be erased");
  assert.deepEqual(checked.publicOnchain.smartMoney.qualificationCoverage, {
    status: "last_known_good", admitted: 1, fresh: 0, lastKnownGood: 1,
    checkedAt: new Date(clock.current).toISOString(),
  });
  assert.equal(checked.publicOnchain.coverage.bsc, "partial",
    "LKG keeps the roster/cursor but cannot emit or advance the BSC scanner before fresh stats");
  assert.equal(checked.publicOnchain.bscNextBlock, 101);
  assert.equal(bscHeadCalls, 0);
  await monitor.stop();

  clock.current += 30_000;
  const restarted = createFomoCallMonitor(config, dependencies);
  await restarted.check();
  assert.equal(statsCalls, 1, "restart must honor the persisted one-minute transient retry schedule");
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.deepEqual(checked.publicOnchain.smartMoney.admittedWallets, [wallet]);

  statsMode = "healthy";
  clock.current += 31_000;
  await restarted.check();
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(statsCalls, 3, "the due LKG wallet refreshes both 7d and 30d before block scanning resumes");
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].profileStatus, "qualified");
  assert.equal(checked.publicOnchain.smartMoney.qualificationCoverage.status, "healthy");
  assert.equal(checked.publicOnchain.smartMoney.qualificationCoverage.fresh, 1);
  assert.equal(checked.publicOnchain.coverage.bsc, "healthy");
  assert.equal(bscHeadCalls, 1);
  await restarted.stop();
});

test("a due last-known-good wallet cannot be starved by a large newer candidate queue", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2027-01-15T00:00:00Z"), head: 100 };
  const wallet = BASE_WALLET.toLowerCase();
  const state = smartCheckpointState(clock.current, { nextStatsAttemptAt: clock.current - 1 });
  const staleAt = new Date(clock.current - 3 * 60 * 60_000).toISOString();
  state.publicOnchain.smartMoney.candidates[wallet].walletProfile.statsCheckedAt = staleAt;
  state.publicOnchain.smartMoney.candidates[wallet].eoaCheckedAt = staleAt;
  state.publicOnchain.smartMoney.roster[wallet].walletProfile.statsCheckedAt = staleAt;
  state.publicOnchain.smartMoney.roster[wallet].eoaCheckedAt = staleAt;
  for (let index = 0; index < 100; index += 1) {
    const candidateWallet = `0x${(10_000 + index).toString(16).padStart(40, "0")}`;
    state.publicOnchain.smartMoney.candidates[candidateWallet] = {
      wallet: candidateWallet,
      tags: ["smart_degen"],
      firstSeenAt: clock.current - 60_000,
      lastSeenAt: clock.current - index,
      lastTradeAt: clock.current - index,
      feedObservedAt: new Date(clock.current).toISOString(),
      profileStatus: "stats_error",
      nextStatsAttemptAt: clock.current - 1,
    };
  }
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(state));
  const requestedWallets = [];
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
    fomoSmartMoneyStatsBatchLimit: 1,
  }, checkpointBscDependencies(clock, {
    fetchSmartMoneyStatsImpl: async (requestedWallet) => {
      requestedWallets.push(requestedWallet);
      return null;
    },
    evmRpcImpl: async () => { throw new Error("stale qualification must freeze BSC scanning"); },
  }));
  await monitor.check();
  assert.deepEqual(requestedWallets, [wallet]);
  await monitor.stop();
});

test("transient smart-wallet stats failures persist 1m, 2m, 5m backoff across restart and never become deterministic rejection", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2027-01-15T00:00:00Z"), head: 100 };
  const wallet = BASE_WALLET.toLowerCase();
  const state = smartCheckpointState(clock.current, {
    includeRoster: false,
    nextStatsAttemptAt: clock.current - 1,
  });
  const smartMoney = state.publicOnchain.smartMoney;
  const candidate = smartMoney.candidates[wallet];
  candidate.profileStatus = "stats_error";
  candidate.statsFailureCount = 0;
  delete candidate.walletProfile;
  delete candidate.eoaVerified;
  delete candidate.eoaCheckedAt;
  delete candidate.walletCode;
  smartMoney.qualificationCoverage = {
    status: "empty", admitted: 0, fresh: 0, lastKnownGood: 0,
    checkedAt: new Date(clock.current).toISOString(),
  };
  state.publicOnchain.coverage.smartMoney = {
    feed: "healthy", stats: "degraded", qualification: "empty",
    fresh: 0, lastKnownGood: 0, exactTrades: "not_configured", admitted: 0,
  };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(state));

  let statsCalls = 0;
  let statsMode = "outage";
  const dependencies = checkpointBscDependencies(clock, {
    sleepImpl: async () => {},
    fetchSmartMoneyStatsImpl: async (requestedWallet, period, checkedAtMs) => {
      statsCalls += 1;
      assert.equal(requestedWallet, wallet);
      if (statsMode === "healthy") {
        const profile = qualifiedSmartWalletProfile(wallet, checkedAtMs);
        return {
          wallet, period, ...profile.windows[period],
          lastTradeAt: new Date(checkedAtMs - 1_000).toISOString(),
          createdAt: profile.createdAt,
          createdTokenCount: profile.createdTokenCount,
          tags: profile.tags,
          checkedAt: new Date(checkedAtMs).toISOString(),
        };
      }
      if (statsCalls === 1) return null;
      if (statsCalls === 2) throw new Error("ConnectTimeout");
      return { wallet, period, checkedAt: new Date(checkedAtMs).toISOString() };
    },
    evmRpcImpl: async (_url, method) => {
      if (method === "eth_getCode") return "0x";
      throw new Error(`no BSC scan is expected before admission: ${method}`);
    },
  });
  const config = {
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
    fomoSmartMoneyStatsBatchLimit: 1,
  };
  const persistedNextAttemptAt = async () => {
    const checkpoint = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-checkpoint.json"), "utf8"));
    return checkpoint.smartMoney.wallets[wallet].nextStatsAttemptAt;
  };

  const first = createFomoCallMonitor(config, dependencies);
  await first.check();
  let checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(statsCalls, 1);
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].profileStatus, "stats_error");
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].statsFailureCount, 1);
  assert.equal(await persistedNextAttemptAt(), clock.current + 60_000);
  await first.stop();

  clock.current += 30_000;
  const restarted = createFomoCallMonitor(config, dependencies);
  await restarted.check();
  assert.equal(statsCalls, 1, "the persisted first backoff survives restart");

  clock.current += 30_000;
  await restarted.check();
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(statsCalls, 2);
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].statsFailureCount, 2);
  assert.equal(await persistedNextAttemptAt(), clock.current + 2 * 60_000);

  clock.current += 119_000;
  await restarted.check();
  assert.equal(statsCalls, 2);
  clock.current += 1_000;
  await restarted.check();
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(statsCalls, 3);
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].statsFailureCount, 3);
  assert.equal(await persistedNextAttemptAt(), clock.current + 5 * 60_000);
  assert.equal(checked.publicOnchain.smartMoney.admittedWallets.length, 0,
    "null, timeout, and incomplete data must not synthesize an LKG admission");

  statsMode = "healthy";
  clock.current += 299_000;
  await restarted.check();
  assert.equal(statsCalls, 3);
  clock.current += 1_000;
  await restarted.check();
  checked = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(statsCalls, 5, "a due healthy retry fetches the complete 7d and 30d pair");
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].profileStatus, "qualified");
  assert.equal(checked.publicOnchain.smartMoney.candidates[wallet].statsFailureCount, 0);
  assert.deepEqual(checked.publicOnchain.smartMoney.admittedWallets, [wallet]);
  await restarted.stop();
});

test("Four.Meme curve HTTP 403 circuit escalates 15m, 1h, then 6h without request or log storms", async (t) => {
  const dataDir = await fixture(t);
  const startedAt = Date.parse("2026-08-24T09:00:00.000Z");
  const clock = { current: startedAt };
  const logs = { errors: [], infos: [] };
  let requests = 0;
  await writeCurveCircuitState(dataDir, clock.current);
  const monitor = createCurveCircuitMonitor(dataDir, clock, async (url) => {
    assert.equal(url, FOUR_CURVE_SOURCE_URL);
    requests += 1;
    return { ok: false, status: 403, headers: { get: () => null } };
  }, logs);

  const observedBackoffs = [];
  let previousRequests = 0;
  for (let minute = 0; minute <= 120; minute += 1) {
    await monitor.check();
    if (requests !== previousRequests) {
      const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
      observedBackoffs.push(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].retryAfterMs);
      previousRequests = requests;
    }
    clock.current += 60_000;
  }
  assert.equal(requests, 3, "two hours may probe only at t=0, t=15m, and t=75m");
  assert.deepEqual(observedBackoffs, [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
  assert.equal(logs.errors.length, 3, "only circuit transitions are logged");
  assert.ok(logs.errors.every((message) => message.includes("circuit open until")));
  assert.deepEqual(logs.infos, []);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.curveSourcesStatus, "partial");
  assert.equal(state.publicOnchain.curveSourcesError, "public source HTTP 403");
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].reason, "http_403");
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].failureCount, 3);
  assert.ok(state.publicOnchain.fourMemeManagers.includes(CACHED_FOUR_MANAGER), "last verified manager set stays active");

  clock.current = Date.parse(state.publicOnchain.curveSourcesNextRetryAt);
  await monitor.check();
  await monitor.stop();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(requests, 4);
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].failureCount, 4);
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].retryAfterMs, 24 * 60 * 60_000);
  assert.equal(logs.errors.length, 4, "the eventual fourth probe adds one 24-hour transition log");
});

test("Four.Meme curve circuit survives restart, probes at expiry, and clears once on recovery", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2026-08-24T12:00:00.000Z") };
  const logs = { errors: [], infos: [] };
  let requests = 0;
  let recovered = false;
  await writeCurveCircuitState(dataDir, clock.current);
  const fetchImpl = async (url) => {
    assert.equal(url, FOUR_CURVE_SOURCE_URL);
    requests += 1;
    if (!recovered) return { ok: false, status: 403, headers: { get: () => null } };
    return ok({
      code: 0,
      data: [{ networkCode: "BSC", name: "TokenManagerV2", address: RECOVERED_FOUR_MANAGER }],
    });
  };

  const first = createCurveCircuitMonitor(dataDir, clock, fetchImpl, logs);
  await first.check();
  await first.stop();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  const retryAt = Date.parse(state.publicOnchain.curveSourcesNextRetryAt);
  assert.equal(retryAt, clock.current + 15 * 60_000);

  clock.current += 5 * 60_000;
  recovered = true;
  const restarted = createCurveCircuitMonitor(dataDir, clock, fetchImpl, logs);
  await restarted.check();
  assert.equal(requests, 1, "restart inside the persisted circuit cannot probe");
  clock.current = retryAt;
  await restarted.check();
  assert.equal(requests, 2, "the expiry tick performs one half-open probe");
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL], undefined);
  assert.equal(state.publicOnchain.curveSourcesStatus, "healthy");
  assert.equal(state.publicOnchain.curveSourcesError, null);
  assert.equal(state.publicOnchain.curveSourcesNextRetryAt, null);
  assert.equal(state.publicOnchain.fourMemeManagers.includes(CACHED_FOUR_MANAGER), false,
    "a recovered verified inventory resumes the existing replacement semantics");
  assert.ok(state.publicOnchain.fourMemeManagers.includes(RECOVERED_FOUR_MANAGER));
  assert.equal(logs.infos.length, 1);
  assert.match(logs.infos[0], /recovered/);

  clock.current += 60_000;
  await restarted.check();
  await restarted.stop();
  assert.equal(requests, 2, "healthy source resumes its ten-minute cadence");
  assert.equal(logs.infos.length, 1, "recovery is logged only once");
});

test("Four.Meme curve HTTP 429 honors Retry-After and a later timeout uses short backoff", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2026-08-24T15:00:00.000Z") };
  const logs = { errors: [], infos: [] };
  let requests = 0;
  await writeCurveCircuitState(dataDir, clock.current);
  const monitor = createCurveCircuitMonitor(dataDir, clock, async (url) => {
    assert.equal(url, FOUR_CURVE_SOURCE_URL);
    requests += 1;
    if (requests === 1) return { ok: false, status: 429, headers: { get: () => "120" } };
    if (requests === 2) {
      const error = new Error("curve inventory timed out");
      error.name = "TimeoutError";
      throw error;
    }
    return ok({ code: 0, data: [{ networkCode: "BSC", name: "TokenManager", address: RECOVERED_FOUR_MANAGER }] });
  }, logs);

  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].reason, "http_429");
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].retryAfterMs, 120_000);
  clock.current += 119_000;
  await monitor.check();
  assert.equal(requests, 1);
  clock.current += 1_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].reason, "timeout");
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].failureCount, 1);
  assert.equal(state.publicOnchain.curveSourceControls[FOUR_CURVE_SOURCE_URL].retryAfterMs, 60_000);
  clock.current += 59_000;
  await monitor.check();
  assert.equal(requests, 2);
  clock.current += 1_000;
  await monitor.check();
  await monitor.stop();
  assert.equal(requests, 3);
  assert.equal(logs.errors.length, 2);
  assert.equal(logs.infos.length, 1);
});

test("stable health-only ticks coalesce full-state writes to one per sixty seconds", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T08:00:00.000Z");
  const checkedAt = new Date(current).toISOString();
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    health: {
      status: "partial",
      source: "gmgn_profitable_wallet_onchain",
      checkedAt,
      lastSuccessAt: checkedAt,
      lastError: null,
      consecutiveFailures: 0,
      durationMs: 0,
    },
    publicOnchain: {
      initializedAt: checkedAt,
      curveSourcesCheckedAt: checkedAt,
      curveSourcesStatus: "healthy",
      bscSilentBaselinePending: false,
      bscNextBlock: 101,
      coverage: {
        profiles: "disabled",
        curves: "healthy",
        solana: "not_configured",
        base: "not_configured",
        bsc: "not_configured",
        smartMoney: {
          feed: "empty", stats: "partial", qualification: "empty",
          fresh: 0, lastKnownGood: 0, exactTrades: "not_configured", admitted: 0,
        },
      },
      smartMoney: {
        initializedAt: checkedAt,
        feedInitializedAt: checkedAt,
        feedCheckedAt: checkedAt,
        feedStatus: "empty",
        feedError: null,
        feedFailureCount: 0,
        feedNextRetryAt: null,
        lastFeedSuccessAt: checkedAt,
        candidates: {},
        roster: {},
        admittedWallets: [],
        seenTrades: {},
        pendingTrades: {},
        chainProofedTransactions: {},
        statsCheckedAt: checkedAt,
        statsStatus: "degraded",
        statsError: "no fresh or last-known-good qualified wallets",
        qualificationCoverage: {
          status: "empty", admitted: 0, fresh: 0, lastKnownGood: 0, checkedAt,
        },
        exactTradeStatus: "not_configured",
        rateLimitedUntil: null,
      },
    },
  }));
  const writes = [];
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
    fomoCallTelemetryPersistIntervalMs: 60_000,
  }, {
    autoStart: false,
    now: () => current,
    wallNow: () => current,
    discoverSmartMoneyTradesImpl: async () => { throw new Error("fresh feed telemetry must not poll"); },
    fetchSmartMoneyStatsImpl: async () => { throw new Error("an empty candidate roster must not fetch stats"); },
    fetchImpl: async (url) => { throw new Error(`fresh curve telemetry must not fetch ${url}`); },
    baseProvider: {},
    bscProvider: {},
    evmRpcImpl: async () => { throw new Error("an empty roster must not scan BSC"); },
    onStateWrite: (entry) => writes.push(entry),
    logger: { error() {} },
  });

  await monitor.check();
  current += 12_000;
  await monitor.check();
  current += 18_000;
  await monitor.check();
  assert.equal(writes.length, 0, "three health/checkedAt-only ticks in thirty seconds must not rewrite the 1.9MB state");

  current += 30_000;
  await monitor.check();
  assert.deepEqual(writes.map((entry) => entry.reason), ["telemetry"]);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(persisted.coverageSummary.complete, false);
  assert.ok(persisted.coverageSummary.incompleteReasons.includes("no_admitted_smart_money_wallets"));
});

test("eleven BSC cursor advances in thirty-five seconds use the small checkpoint instead of the main state", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2026-08-24T08:05:00.000Z"), head: 103 };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(smartCheckpointState(clock.current)));
  const mainWrites = [];
  const checkpointWrites = [];
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
    fomoCallTelemetryPersistIntervalMs: 60_000,
  }, checkpointBscDependencies(clock, {
    onStateWrite: (entry) => mainWrites.push(entry),
    onCheckpointWrite: (entry) => checkpointWrites.push(entry),
  }));

  for (let index = 0; index < 11; index += 1) {
    await monitor.check();
    if (index < 10) {
      clock.current += 3_500;
      clock.head += 1;
    }
  }

  assert.ok(mainWrites.length <= 2, `cursor-only checks wrote the main state ${mainWrites.length} times`);
  assert.equal(checkpointWrites.length, 11);
  const checkpointFile = path.join(dataDir, "fomo-call-checkpoint.json");
  const checkpoint = JSON.parse(await fs.readFile(checkpointFile, "utf8"));
  assert.equal(checkpoint.revision, 11);
  assert.equal(checkpoint.bscNextBlock, 112);
  assert.equal((await fs.stat(checkpointFile)).mode & 0o777, 0o600);
  assert.ok((await fs.stat(checkpointFile)).size < (await fs.stat(path.join(dataDir, "fomo-call-state.json"))).size);

  const mainWritesBeforeStop = mainWrites.length;
  await monitor.stop();
  const absorbed = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(absorbed.publicOnchain.bscNextBlock, 112);
  assert.equal(absorbed.fomoCallCheckpoint.revision, 11);
  assert.equal(mainWrites.length, mainWritesBeforeStop + 1, "stop performs one final checkpoint absorption");
});

test("checkpoint creation, replacement, and main absorption cross both file and directory durability barriers", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2026-08-24T08:05:40.000Z"), head: 103 };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(smartCheckpointState(clock.current)));
  await fs.chmod(path.join(dataDir, "fomo-call-state.json"), 0o644);
  const checkpointProbe = {};
  const stateProbe = {};
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
    fomoCallTelemetryPersistIntervalMs: 60_000,
  }, checkpointBscDependencies(clock, {
    checkpointFsImpl: probedDurableFs(dataDir, checkpointProbe),
    stateFsImpl: probedDurableFs(dataDir, stateProbe),
  }));

  await monitor.check();
  assert.equal(checkpointProbe.fileSyncCount, 1, "first missing-sidecar creation fsyncs its complete temp file");
  assert.equal(checkpointProbe.directorySyncCount, 1, "first missing-sidecar creation fsyncs the parent directory");
  clock.current += 3_500;
  clock.head += 1;
  await monitor.check();
  assert.equal(checkpointProbe.fileSyncCount, 2, "existing-sidecar replacement fsyncs its complete temp file");
  assert.equal(checkpointProbe.directorySyncCount, 2, "existing-sidecar replacement fsyncs the rename directory entry");
  const stateFileSyncsBeforeStop = Number(stateProbe.fileSyncCount || 0);
  const stateDirectorySyncsBeforeStop = Number(stateProbe.directorySyncCount || 0);
  await monitor.stop();
  assert.equal(stateProbe.fileSyncCount, stateFileSyncsBeforeStop + 1, "main checkpoint absorption fsyncs the full state file");
  assert.equal(stateProbe.directorySyncCount, stateDirectorySyncsBeforeStop + 1, "main absorption fsyncs its parent directory");
  assert.equal((await fs.stat(path.join(dataDir, "fomo-call-state.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dataDir, "fomo-call-checkpoint.json"))).mode & 0o777, 0o600);
});

test("a checkpoint directory-fsync failure stays unabsorbed and the same monitor safely refetches", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2026-08-24T08:05:50.000Z"), head: 103 };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(smartCheckpointState(clock.current)));
  const probe = { failDirectorySyncAt: 1 };
  let blockFetches = 0;
  const checkpointWrites = [];
  const normalBatch = checkpointBscDependencies(clock).evmRpcBatchImpl;
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
  }, checkpointBscDependencies(clock, {
    checkpointFsImpl: probedDurableFs(dataDir, probe),
    evmRpcBatchImpl: async (...args) => {
      blockFetches += 1;
      return normalBatch(...args);
    },
    onCheckpointWrite: (entry) => checkpointWrites.push(entry),
  }));

  await monitor.check();
  let main = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(main.publicOnchain.bscNextBlock, 101);
  assert.equal(main.fomoCallCheckpoint?.revision, 0, "an ambiguous sidecar rename is not absorbed into main");
  assert.equal(checkpointWrites.length, 0, "the failed directory barrier never reports a durable revision");
  assert.equal(blockFetches, 1);

  clock.current += 1_000;
  await monitor.check();
  assert.equal(blockFetches, 2, "the same instance ignores the uncertain sidecar and refetches the old cursor");
  assert.equal(checkpointWrites.length, 1);
  await monitor.stop();
  main = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(main.publicOnchain.bscNextBlock, 102);
  assert.equal(main.fomoCallCheckpoint.revision, 1);
});

test("legacy sensitive state files tighten to 0600 on read and chmod failure is fail-closed", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-24T08:05:55.000Z");
  const mainFile = path.join(dataDir, "fomo-call-state.json");
  const checkpointFile = path.join(dataDir, "fomo-call-checkpoint.json");
  await fs.writeFile(mainFile, JSON.stringify(smartCheckpointState(current, { bscNextBlock: 500, checkpointRevision: 1 })));
  await fs.writeFile(checkpointFile, JSON.stringify({
    version: 1,
    revision: 2,
    updatedAt: new Date(current + 1_000).toISOString(),
    bscNextBlock: 400,
    smartMoney: { rateLimitedUntil: null, wallets: {} },
  }));
  await fs.chmod(mainFile, 0o644);
  await fs.chmod(checkpointFile, 0o644);
  const monitor = createFomoCallMonitor({ dataDir, fomoCallEnabled: false }, {
    autoStart: false,
    now: () => current + 2_000,
    baseProvider: {},
    bscProvider: {},
    logger: { error() {} },
  });
  await monitor.check();
  await monitor.stop();
  assert.equal((await fs.stat(mainFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(checkpointFile)).mode & 0o777, 0o600);

  const blockedDir = await fixture(t);
  const blockedMain = path.join(blockedDir, "fomo-call-state.json");
  const blockedCheckpoint = path.join(blockedDir, "fomo-call-checkpoint.json");
  await fs.writeFile(blockedMain, JSON.stringify(smartCheckpointState(current)));
  await fs.writeFile(blockedCheckpoint, JSON.stringify({
    version: 1,
    revision: 1,
    updatedAt: new Date(current).toISOString(),
    bscNextBlock: 101,
    smartMoney: { rateLimitedUntil: null, wallets: {} },
  }));
  const blockedFs = probedDurableFs(blockedDir, {});
  blockedFs.chmod = async (target, mode) => {
    if (path.resolve(String(target)) === path.resolve(blockedCheckpoint)) {
      throw Object.assign(new Error("simulated sensitive checkpoint chmod failure"), { code: "EACCES" });
    }
    return fs.chmod(target, mode);
  };
  const blocked = createFomoCallMonitor({ dataDir: blockedDir, fomoCallEnabled: false }, {
    autoStart: false,
    now: () => current,
    checkpointFsImpl: blockedFs,
    baseProvider: {},
    bscProvider: {},
    logger: { error() {} },
  });
  await assert.rejects(() => blocked.check(), /sensitive checkpoint chmod failure/);
});

test("a transient final main rename or directory barrier failure can be retried by a second stop", async (t) => {
  for (const phase of ["rename", "directory fsync"]) {
    const dataDir = await fixture(t);
    const clock = { current: Date.parse("2026-08-24T08:05:58.000Z"), head: 103 };
    await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(smartCheckpointState(clock.current)));
    let stoppingPhase = false;
    let stopWrites = 0;
    const successfulWrites = [];
    const monitor = createFomoCallMonitor({
      dataDir,
      fomoCallEnabled: true,
      fomoBuyMonitorEnabled: false,
      fomoSmartMoneyMonitorEnabled: true,
      fomoCallBscOnly: true,
      fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
      fomoCallTelemetryPersistIntervalMs: 60_000,
    }, checkpointBscDependencies(clock, {
      atomicWriteImpl: async (file, value) => {
        if (!stoppingPhase) return injectedAtomicWrite(file, value);
        stopWrites += 1;
        return injectedAtomicWrite(file, value, stopWrites === 1 ? phase : null);
      },
      onStateWrite: (entry) => successfulWrites.push(entry),
    }));
    await monitor.check();
    successfulWrites.length = 0;
    stoppingPhase = true;

    await assert.rejects(() => monitor.stop(), new RegExp(`simulated main ${phase}`));
    assert.equal(await monitor.check(), null, "a failed stop never restores polling");
    const secondStop = monitor.stop();
    await secondStop;
    assert.equal(monitor.stop(), secondStop, "the successful retry becomes the permanent idempotent stop boundary");
    assert.equal(stopWrites, 2);
    assert.equal(successfulWrites.length, 1, "only the barrier-complete absorption is reported");
    const main = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
    const checkpoint = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-checkpoint.json"), "utf8"));
    assert.equal(main.fomoCallCheckpoint.revision, checkpoint.revision);
    assert.equal(main.publicOnchain.bscNextBlock, checkpoint.bscNextBlock);
    assert.equal((await fs.stat(path.join(dataDir, "fomo-call-state.json"))).mode & 0o777, 0o600);
  }
});

test("stats-only scheduling is checkpointed and survives restart without another profile request", async (t) => {
  const dataDir = await fixture(t);
  const clock = { current: Date.parse("2026-08-24T08:06:00.000Z"), head: 100 };
  const wallet = BASE_WALLET.toLowerCase();
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(smartCheckpointState(clock.current, {
    nextStatsAttemptAt: clock.current - 1,
  })));
  const mainWrites = [];
  const checkpointWrites = [];
  let statsCalls = 0;
  const statsFor = (period) => {
    const profile = qualifiedSmartWalletProfile(wallet, clock.current);
    return {
      wallet,
      period,
      ...profile.windows[period],
      lastTradeAt: new Date(clock.current - 1_000).toISOString(),
      createdAt: profile.createdAt,
      createdTokenCount: profile.createdTokenCount,
      tags: profile.tags,
      checkedAt: new Date(clock.current).toISOString(),
    };
  };
  const dependencies = checkpointBscDependencies(clock, {
    fetchSmartMoneyStatsImpl: async (_wallet, period) => {
      statsCalls += 1;
      return statsFor(period);
    },
    sleepImpl: async () => {},
    evmRpcImpl: async (_url, method) => {
      if (method === "eth_getCode") return "0x";
      if (method === "eth_blockNumber") return "0x64";
      throw new Error(`unexpected RPC ${method}`);
    },
    onStateWrite: (entry) => mainWrites.push(entry),
    onCheckpointWrite: (entry) => checkpointWrites.push(entry),
  });
  const config = {
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
    fomoSmartMoneyQualifiedCacheMs: 60_000,
    fomoCallTelemetryPersistIntervalMs: 60_000,
  };
  const monitor = createFomoCallMonitor(config, dependencies);
  await monitor.check();
  assert.equal(statsCalls, 2);
  assert.equal(mainWrites.length, 0, "stable profile timestamps and stats schedule must not rewrite the main state");
  assert.deepEqual(checkpointWrites.map(({ reason }) => reason), ["smart-money-roster-exact"]);
  const checkpoint = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-checkpoint.json"), "utf8"));
  assert.equal(checkpoint.smartMoney.wallets[wallet].lastStatsAttemptAt, clock.current);
  assert.equal(checkpoint.smartMoney.wallets[wallet].nextStatsAttemptAt, clock.current + 60_000);
  await monitor.stop();

  clock.current += 1_000;
  const restarted = createFomoCallMonitor(config, dependencies);
  await restarted.check();
  await restarted.stop();
  assert.equal(statsCalls, 2, "restart must honor the sidecar schedule instead of immediately refetching stats");
});

test("checkpoint merge is revision-first, accepts a legitimate cursor rewind, and never revives removed or rejected wallets", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-24T08:07:00.000Z");
  const wallet = BASE_WALLET.toLowerCase();
  const rejectedWallet = "0x7777777777777777777777777777777777777777";
  const removedWallet = "0x8888888888888888888888888888888888888888";
  const state = smartCheckpointState(current, {
    bscNextBlock: 500,
    checkpointRevision: 3,
    lastStatsAttemptAt: 100,
    nextStatsAttemptAt: 200,
  });
  state.publicOnchain.smartMoney.candidates[rejectedWallet] = {
    wallet: rejectedWallet,
    tags: ["launchpad_smart"],
    profileStatus: "rejected_7d",
    lastStatsAttemptAt: 111,
    nextStatsAttemptAt: 222,
  };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(state));
  await fs.writeFile(path.join(dataDir, "fomo-call-checkpoint.json"), JSON.stringify({
    version: 1,
    revision: 4,
    updatedAt: new Date(current + 1_000).toISOString(),
    bscNextBlock: 400,
    smartMoney: {
      rateLimitedUntil: null,
      wallets: {
        [wallet]: { lastStatsAttemptAt: 300, nextStatsAttemptAt: 400 },
        [rejectedWallet]: { lastStatsAttemptAt: 999, nextStatsAttemptAt: 1_000 },
        [removedWallet]: { lastStatsAttemptAt: 999, nextStatsAttemptAt: 1_000 },
      },
    },
  }));
  const monitor = createFomoCallMonitor({ dataDir, fomoCallEnabled: false }, {
    autoStart: false,
    now: () => current + 2_000,
    baseProvider: {},
    bscProvider: {},
    logger: { error() {} },
  });
  await monitor.check();
  await monitor.stop();
  const merged = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(merged.publicOnchain.bscNextBlock, 400, "newer revision may intentionally rewind the cursor");
  assert.equal(merged.publicOnchain.smartMoney.candidates[wallet].nextStatsAttemptAt, 400);
  assert.equal(merged.publicOnchain.smartMoney.candidates[rejectedWallet].nextStatsAttemptAt, 222);
  assert.equal(merged.publicOnchain.smartMoney.candidates[removedWallet], undefined);
  assert.equal(merged.fomoCallCheckpoint.revision, 4);

  const sameRevisionDir = await fixture(t);
  const sameRevisionState = smartCheckpointState(current, { bscNextBlock: 500, checkpointRevision: 4 });
  await fs.writeFile(path.join(sameRevisionDir, "fomo-call-state.json"), JSON.stringify(sameRevisionState));
  await fs.writeFile(path.join(sameRevisionDir, "fomo-call-checkpoint.json"), JSON.stringify({
    version: 1,
    revision: 4,
    updatedAt: new Date(current + 1_000).toISOString(),
    bscNextBlock: 390,
    smartMoney: { rateLimitedUntil: null, wallets: {} },
  }));
  const sameRevision = createFomoCallMonitor({ dataDir: sameRevisionDir, fomoCallEnabled: false }, {
    autoStart: false,
    now: () => current + 2_000,
    baseProvider: {},
    bscProvider: {},
    logger: { error() {} },
  });
  await sameRevision.check();
  await sameRevision.stop();
  const sameRevisionMerged = JSON.parse(await fs.readFile(path.join(sameRevisionDir, "fomo-call-state.json"), "utf8"));
  assert.equal(sameRevisionMerged.publicOnchain.bscNextBlock, 390, "same revision uses the newer updatedAt");
});

test("old or corrupt checkpoints fall back to main and a rename failure never advances the durable BSC cursor", async (t) => {
  const current = Date.parse("2026-08-24T08:08:00.000Z");
  for (const checkpointValue of [
    JSON.stringify({
      version: 1,
      revision: 2,
      updatedAt: new Date(current + 60_000).toISOString(),
      bscNextBlock: 900,
      smartMoney: { rateLimitedUntil: null, wallets: {} },
    }),
    "{not-json",
    JSON.stringify({ version: 0, revision: 99, updatedAt: new Date(current).toISOString() }),
  ]) {
    const dataDir = await fixture(t);
    await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(smartCheckpointState(current, {
      bscNextBlock: 500,
      checkpointRevision: 3,
    })));
    await fs.writeFile(path.join(dataDir, "fomo-call-checkpoint.json"), checkpointValue);
    const monitor = createFomoCallMonitor({ dataDir, fomoCallEnabled: false }, {
      autoStart: false,
      now: () => current,
      baseProvider: {},
      bscProvider: {},
      logger: { error() {} },
    });
    await monitor.check();
    await monitor.stop();
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
    assert.equal(state.publicOnchain.bscNextBlock, 500);
    assert.equal(state.fomoCallCheckpoint.revision, 3);
  }

  const dataDir = await fixture(t);
  const clock = { current, head: 103 };
  const lookbackState = smartCheckpointState(current, { bscNextBlock: 500 });
  lookbackState.publicOnchain.bscLookbackRequested = true;
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(lookbackState));
  let blockFetches = 0;
  const normalBatch = checkpointBscDependencies(clock).evmRpcBatchImpl;
  const checkpointFsImpl = {
    readFile: (...args) => fs.readFile(...args),
    stat: (...args) => fs.stat(...args),
    mkdir: (...args) => fs.mkdir(...args),
    open: (...args) => fs.open(...args),
    chmod: (...args) => fs.chmod(...args),
    rm: (...args) => fs.rm(...args),
    rename: async () => { throw Object.assign(new Error("simulated checkpoint rename failure"), { code: "EIO" }); },
  };
  const failing = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoCallNewWalletLookbackBlocks: 1,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
  }, checkpointBscDependencies(clock, {
    checkpointFsImpl,
    evmRpcBatchImpl: async (...args) => {
      blockFetches += 1;
      return normalBatch(...args);
    },
  }));
  await failing.check();
  await failing.stop();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 500, "failed rename must leave the main cursor at the last durable value");
  assert.equal(state.publicOnchain.bscLookbackRequested, true, "failed rewind checkpoint must retain the durable lookback request");
  await assert.rejects(fs.readFile(path.join(dataDir, "fomo-call-checkpoint.json"), "utf8"), { code: "ENOENT" });

  clock.current += 1_000;
  const restarted = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoCallNewWalletLookbackBlocks: 1,
    fomoSmartMoneyDiscoveryIntervalMs: 10 * 60_000,
  }, checkpointBscDependencies(clock, {
    evmRpcBatchImpl: async (...args) => {
      blockFetches += 1;
      return normalBatch(...args);
    },
  }));
  await restarted.check();
  await restarted.stop();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.bscNextBlock, 102);
  assert.equal(state.publicOnchain.bscLookbackRequested, false);
  assert.equal(blockFetches, 2, "restart safely refetches the block whose cursor checkpoint failed");
});

test("a feed pending trade survives a post-checkpoint exception and monitor restart", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T08:10:00.000Z");
  const checkedAt = new Date(current - 60_000).toISOString();
  const wallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const transactionHash = `0x${"a".repeat(64)}`;
  const pendingKey = `${transactionHash}:${wallet}:${BASE_TOKEN}`;
  const trade = {
    scheme: "gmgn_smartmoney_trade_v1",
    transactionHash,
    wallet,
    token: BASE_TOKEN,
    chainId: 56,
    side: "buy",
    timestampMs: current - 1_000,
    occurredAt: new Date(current - 1_000).toISOString(),
    observedAt: new Date(current).toISOString(),
    tags: ["launchpad_smart", "axiom"],
    eligible: true,
  };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    health: { status: "partial", source: "gmgn_profitable_wallet_onchain", checkedAt, lastError: null, consecutiveFailures: 0 },
    publicOnchain: {
      initializedAt: checkedAt,
      curveSourcesCheckedAt: new Date(current).toISOString(),
      curveSourcesStatus: "healthy",
      bscSilentBaselinePending: false,
      bscNextBlock: 101,
      smartMoney: {
        initializedAt: checkedAt,
        feedInitializedAt: checkedAt,
        feedCheckedAt: checkedAt,
        feedStatus: "healthy",
        candidates: {},
        roster: {},
        admittedWallets: [],
        seenTrades: {},
        pendingTrades: {},
        chainProofedTransactions: {},
        statsStatus: "healthy",
        exactTradeStatus: "not_configured",
      },
    },
  }));
  let feedCalls = 0;
  let injected = false;
  const dependencies = {
    autoStart: false,
    now: () => current,
    wallNow: () => current,
    discoverSmartMoneyTradesImpl: async () => { feedCalls += 1; return [trade]; },
    fetchSmartMoneyStatsImpl: async () => { throw new Error("stats temporarily unavailable"); },
    fetchImpl: async (url) => { throw new Error(`fresh curve source must not fetch ${url}`); },
    baseProvider: {},
    bscProvider: {},
    evmRpcImpl: async () => { throw new Error("an unqualified wallet must not scan BSC"); },
    logger: { error() {} },
  };
  const config = {
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 15_000,
  };
  const first = createFomoCallMonitor(config, {
    ...dependencies,
    onStateWrite: ({ reason }) => {
      if (!injected && reason === "smart-money-feed-exact") {
        injected = true;
        throw new Error("simulated process exception immediately after durable feed checkpoint");
      }
    },
  });
  await first.check();
  first.stop();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.ok(state.publicOnchain.smartMoney.pendingTrades[pendingKey], "the atomic checkpoint precedes the injected exception");

  current += 1_000;
  const restarted = createFomoCallMonitor(config, dependencies);
  await restarted.check();
  restarted.stop();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(feedCalls, 1, "restart reuses the persisted feed cursor/check time");
  assert.ok(state.publicOnchain.smartMoney.pendingTrades[pendingKey], "restart retains the exact pending trade for retry");
});

test("a durable BSC baseline checkpoint survives a crash before main absorption and scans every block added while down", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T08:20:00.000Z");
  let head = 100;
  let injected = false;
  let rejectMainAfterCheckpoint = false;
  let headCalls = 0;
  const restartedBlocks = [];
  const config = {
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    fomoSmartMoneyMonitorEnabled: false,
    fomoCallBscOnly: true,
    fomoCallPublicHandles: ["alpha"],
    fomoCallPublicTopLimit: 1,
    fomoCallBscConfirmations: 0,
    fomoCallBscMaxCatchupBlocks: 20,
  };
  const commonDependencies = {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => {
      if (String(url).includes("/get-user/alpha")) return ok({
        username: "alpha",
        displayName: "Alpha",
        social: { followers: 150_000 },
        fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
        wallets: { evm: { status: "verified", address: BASE_WALLET } },
      });
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
      });
      throw new Error(`unexpected URL ${url}`);
    },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {},
    evmRpcImpl: async (_url, method) => {
      assert.equal(method, "eth_blockNumber");
      headCalls += 1;
      return `0x${head.toString(16)}`;
    },
    logger: { error() {} },
  };
  const first = createFomoCallMonitor(config, {
    ...commonDependencies,
    atomicWriteImpl: async (file, value) => {
      if (rejectMainAfterCheckpoint) {
        throw new Error("simulated process crash before main baseline absorption");
      }
      return injectedAtomicWrite(file, value);
    },
    onCheckpointWrite: ({ reason }) => {
      if (!injected && reason === "onchain-cursors-pending") {
        injected = true;
        rejectMainAfterCheckpoint = true;
        throw new Error("simulated process exception immediately after the BSC sidecar checkpoint");
      }
    },
  });
  await first.check();
  // Deliberately do not call stop(): a process crash cannot absorb the sidecar.
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  const checkpoint = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-checkpoint.json"), "utf8"));
  assert.equal(state.publicOnchain.bscSilentBaselinePending, true,
    "main still exposes the exact pre-absorption crash window");
  assert.equal(checkpoint.bscNextBlock, 101);
  assert.equal(checkpoint.bscSilentBaselinePending, false,
    "the durable cursor consumes the silent baseline in the same sidecar revision");

  current += 12_000;
  head = 104;
  const restarted = createFomoCallMonitor(config, {
    ...commonDependencies,
    evmRpcBatchImpl: async (_url, calls) => calls.map(({ method, params }) => {
      assert.equal(method, "eth_getBlockByNumber");
      const blockNumber = Number(BigInt(params[0]));
      restartedBlocks.push(blockNumber);
      return {
        number: params[0],
        hash: testBlockHash(blockNumber),
        timestamp: `0x${Math.floor(current / 1_000).toString(16)}`,
        transactions: [],
      };
    }),
  });
  await restarted.check();
  await restarted.stop();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.deepEqual(restartedBlocks, [101, 102, 103, 104],
    "restart resumes at the durable cursor instead of resetting to the new safeHead+1");
  assert.equal(state.publicOnchain.bscNextBlock, 105);
  assert.equal(state.publicOnchain.bscSilentBaselinePending, false);
  assert.equal(headCalls, 2);
});

test("stop waits for an active check checkpoint and permanently closes the monitor", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-24T08:30:00.000Z");
  const checkedAt = new Date(current - 60_000).toISOString();
  const wallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const transactionHash = `0x${"d".repeat(64)}`;
  const pendingKey = `${transactionHash}:${wallet}:${BASE_TOKEN}`;
  const trade = {
    scheme: "gmgn_smartmoney_trade_v1",
    transactionHash,
    wallet,
    token: BASE_TOKEN,
    chainId: 56,
    side: "buy",
    timestampMs: current - 1_000,
    occurredAt: new Date(current - 1_000).toISOString(),
    observedAt: new Date(current).toISOString(),
    tags: ["launchpad_smart", "axiom"],
    eligible: true,
  };
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    health: { status: "partial", source: "gmgn_profitable_wallet_onchain", checkedAt, lastError: null, consecutiveFailures: 0 },
    publicOnchain: {
      initializedAt: checkedAt,
      curveSourcesCheckedAt: new Date(current).toISOString(),
      curveSourcesStatus: "healthy",
      bscSilentBaselinePending: false,
      bscNextBlock: 101,
      smartMoney: {
        initializedAt: checkedAt,
        feedInitializedAt: checkedAt,
        feedCheckedAt: checkedAt,
        feedStatus: "healthy",
        candidates: {},
        roster: {},
        admittedWallets: [],
        seenTrades: {},
        pendingTrades: {},
        chainProofedTransactions: {},
        statsStatus: "healthy",
        exactTradeStatus: "not_configured",
      },
    },
  }));
  let releaseFeed;
  let signalFeedStarted;
  const feedGate = new Promise((resolve) => { releaseFeed = resolve; });
  const feedStarted = new Promise((resolve) => { signalFeedStarted = resolve; });
  const writes = [];
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoSmartMoneyDiscoveryIntervalMs: 15_000,
  }, {
    autoStart: false,
    now: () => current,
    wallNow: () => current,
    discoverSmartMoneyTradesImpl: async () => {
      signalFeedStarted();
      await feedGate;
      return [trade];
    },
    fetchSmartMoneyStatsImpl: async () => { throw new Error("stats temporarily unavailable"); },
    fetchImpl: async (url) => { throw new Error(`fresh curve source must not fetch ${url}`); },
    baseProvider: {},
    bscProvider: {},
    evmRpcImpl: async () => { throw new Error("an unqualified wallet must not scan BSC"); },
    onStateWrite: (entry) => writes.push(entry),
    logger: { error() {} },
  });

  const checking = monitor.check();
  await feedStarted;
  let stopSettled = false;
  const stopBoundary = monitor.stop();
  const firstStop = stopBoundary.then(() => { stopSettled = true; });
  const secondStop = monitor.stop();
  await Promise.resolve();
  assert.equal(stopSettled, false, "stop must wait while the producer is before its durable feed checkpoint");
  assert.equal(secondStop, stopBoundary, "stop is idempotent and shares one completion boundary");

  releaseFeed();
  await checking;
  await firstStop;
  assert.equal(stopSettled, true);
  assert.ok(writes.some(({ reason }) => reason === "smart-money-feed-exact"));
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.ok(state.publicOnchain.smartMoney.pendingTrades[pendingKey], "the active check checkpoint is durable before stop resolves");
  const writeCount = writes.length;
  assert.equal(await monitor.check(), null, "a stopped monitor cannot start another check");
  assert.equal(writes.length, writeCount);
});

test("state pruning hard-caps queues and compacts each unknown wallet-token pair to its earliest buy", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.now();
  const smartWallet = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
  const smartSeen = Object.fromEntries(Array.from({ length: 5_010 }, (_, index) => [
    `0x${index.toString(16).padStart(64, "0")}:${smartWallet}:${BASE_TOKEN}`,
    current + index,
  ]));
  const smartPending = Object.fromEntries(Array.from({ length: 510 }, (_, index) => [
    `pending-${index}`,
    {
      scheme: "gmgn_smartmoney_trade_v1",
      wallet: smartWallet,
      token: BASE_TOKEN,
      transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
      side: "buy",
      tags: ["app_smart_money"],
      timestampMs: current + index,
      firstSeenAt: current + index,
    },
  ]));
  const pending = Object.fromEntries(Array.from({ length: 1_010 }, (_, index) => [
    `public-${index}`,
    {
      call: {
        kind: "high_profit_high_winrate_wallet_buy",
        timestampMs: current + index,
        walletAddress: smartWallet,
        token: BASE_TOKEN,
      },
      firstSeenAt: current + index,
    },
  ]));
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify({
    version: 10,
    pending,
    seenCalls: Object.fromEntries(Array.from({ length: 20_010 }, (_, index) => [`seen-${index}`, current + index])),
    seenConvergences: Object.fromEntries(Array.from({ length: 10_010 }, (_, index) => [`convergence-${index}`, current + index])),
    alertedTokens: Object.fromEntries(Array.from({ length: 10_010 }, (_, index) => [`token-${index}`, current + index])),
    publicOnchain: {
      smartMoney: {
        seenTrades: smartSeen,
        pendingTrades: smartPending,
      },
    },
  }));
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoSmartMoneyMonitorEnabled: true,
    fomoCallBscOnly: true,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    discoverSmartMoneyTradesImpl: async () => [],
    fetchImpl: async (url) => {
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({ code: 0, data: [] });
      throw new Error(`unexpected fetch ${url}`);
    },
    baseProvider: {},
    bscProvider: {},
    logger: { error() {} },
  });
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(Object.keys(state.seenCalls).length, 20_000);
  assert.equal(Object.keys(state.seenConvergences).length, 10_000);
  assert.equal(Object.keys(state.alertedTokens).length, 10_000);
  assert.equal(Object.keys(state.pending).length, 1_000);
  assert.ok(state.pending["public-0"], "top-level pending cap must retain the earliest signal");
  assert.equal(Object.keys(state.publicOnchain.smartMoney.seenTrades).length, 5_000);
  assert.equal(Object.keys(state.publicOnchain.smartMoney.pendingTrades).length, 1);
  assert.ok(state.publicOnchain.smartMoney.pendingTrades["pending-0"], "pair compaction must retain the earliest first-buy candidate");
});

test("attaches only fresh and unambiguous GMGN-observed wallets", () => {
  const nowMs = Date.parse("2027-01-15T00:00:00Z");
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const candidate = {
    handle: "alpha",
    wallet,
    wallets: [wallet],
    twitterHandles: ["alpha"],
    ambiguousWallets: false,
    ambiguousHandles: false,
    ambiguousIdentity: false,
    tags: ["fomo", "kol"],
    discoveredAt: nowMs - (24 * 60 * 60_000) + 1,
    source: "gmgn_bsc_kol_feed",
  };

  const attached = attachGmgnObservedWallet(candidate, null, nowMs);
  assert.equal(attached.handle, "alpha");
  assert.equal(attached.baseAddress, wallet);
  assert.equal(attached.twitterHandle, "alpha");
  assert.equal(attached.twitterIdentityObserved, true);
  assert.deepEqual(attached.walletBinding, {
    status: "observed",
    verified: false,
    proofSource: "gmgn_bsc_kol_feed",
    wallet,
    handle: "alpha",
    twitterHandle: "alpha",
    tags: ["fomo", "kol"],
    observedAt: new Date(candidate.discoveredAt).toISOString(),
    lastCheckedAt: new Date(candidate.discoveredAt).toISOString(),
    ambiguousIdentity: false,
    ambiguousWallets: false,
    ambiguousHandles: false,
    candidateSource: "gmgn_bsc_kol_feed",
  });

  for (const invalid of [
    { ...candidate, ambiguousWallets: true, ambiguousIdentity: true },
    { ...candidate, ambiguousHandles: true, ambiguousIdentity: true },
    { ...candidate, ambiguousIdentity: true },
    { ...candidate, discoveredAt: nowMs - (24 * 60 * 60_000) - 1 },
    { ...candidate, discoveredAt: nowMs + 60_001 },
    { ...candidate, discoveredAt: null },
    { ...candidate, discoveredAt: undefined },
    { ...candidate, tags: ["kol", "fomo", "wash_trader"] },
    { ...candidate, tags: ["kol", "fomo", "arbitrager"] },
  ]) {
    assert.equal(attachGmgnObservedWallet(invalid, null, nowMs), null);
  }
});

test("selects every verified active BSC KOL at the 10k boundary and deduplicates wallets", () => {
  const nowMs = Date.parse("2027-01-15T00:00:00Z");
  const profile = (handle, followers, wallet, overrides = {}) => ({
    handle,
    followers: followers + 123,
    xFollowers: followers,
    xProfile: {
      id: `${Math.abs([...handle].reduce((total, character) => total + character.charCodeAt(0), 0)) + 10_000}`,
      handle,
      protected: false,
      source: "fxtwitter_public_profile",
      checkedAt: new Date(nowMs).toISOString(),
    },
    totalVolume: overrides.totalVolume ?? 1_000_000,
    baseAddress: wallet,
    bscTransactionCount: overrides.bscTransactionCount ?? 1,
    bscActivityCheckedAt: new Date(nowMs).toISOString(),
    twitterIdentityVerified: true,
    twitterHandle: handle,
    walletBinding: {
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      ...overrides.walletBinding,
    },
  });
  const boundaryWallet = "0x1000000000000000000000000000000000000001";
  const duplicateWallet = "0x2000000000000000000000000000000000000002";
  const selected = selectVerifiedBscKols([
    profile("exactly10k", 10_000, boundaryWallet),
    profile("below", 9_999, "0x3000000000000000000000000000000000000003"),
    profile("unverified", 500_000, "0x4000000000000000000000000000000000000004", {
      walletBinding: { status: "unverified", verified: false, proofSource: "fomoscan" },
    }),
    profile("wrongProof", 400_000, "0x5000000000000000000000000000000000000005", {
      walletBinding: { status: "verified", verified: true, proofSource: "gmgn" },
    }),
    profile("verifiedFlagFalse", 350_000, "0x7000000000000000000000000000000000000007", {
      walletBinding: { status: "verified", verified: false, proofSource: "fomoscan" },
    }),
    {
      ...profile("missingXFollowers", 250_000, "0x8000000000000000000000000000000000000008"),
      xFollowers: undefined,
    },
    profile("inactive", 300_000, "0x6000000000000000000000000000000000000006", { bscTransactionCount: 0 }),
    profile("duplicateLower", 20_000, duplicateWallet.toUpperCase().replace("0X", "0x"), { totalVolume: 9_000_000 }),
    profile("duplicateHigher", 30_000, duplicateWallet, { totalVolume: 1 }),
  ], {
    minimumFollowers: 10_000,
    requireTwitter: true,
    requireBscActivity: true,
    nowMs,
  });

  assert.deepEqual(selected.map((entry) => entry.handle), ["duplicateHigher", "exactly10k"]);
  assert.deepEqual(selected.map((entry) => entry.trafficRank), [1, 2]);
  assert.equal(selected.filter((entry) => entry.baseAddress.toLowerCase() === duplicateWallet).length, 1);
});

test("GMGN-observed wallets require explicit admission and an FxTwitter user id", () => {
  const nowMs = Date.parse("2027-01-15T00:00:00Z");
  const wallet = "0x9000000000000000000000000000000000000009";
  const observed = {
    ...attachGmgnObservedWallet({
      handle: "observed_kol",
      wallet,
      wallets: [wallet],
      twitterHandles: ["observed_kol"],
      ambiguousWallets: false,
      ambiguousHandles: false,
      ambiguousIdentity: false,
      tags: ["kol", "fomo"],
      discoveredAt: nowMs - 60_000,
      source: "gmgn_bsc_kol_feed",
    }, null, nowMs),
    xFollowers: 10_000,
    xProfile: {
      id: "123456789",
      handle: "observed_kol",
      source: "fxtwitter_public_profile",
      checkedAt: new Date(nowMs).toISOString(),
    },
    bscTransactionCount: 1,
    bscActivityCheckedAt: new Date(nowMs).toISOString(),
  };
  const options = {
    minimumFollowers: 10_000,
    requireTwitter: true,
    requireBscActivity: true,
    requireRecentIdentity: true,
    nowMs,
  };

  assert.deepEqual(selectVerifiedBscKols([observed], options), [], "observed wallets are opt-in, never silently treated as verified");
  const selected = selectVerifiedBscKols([observed], { ...options, allowGmgnObservedWallets: true });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].handle, "observed_kol");
  assert.equal(selected[0].baseAddress, wallet);

  const missingXId = { ...observed, xProfile: { ...observed.xProfile, id: null } };
  assert.deepEqual(selectVerifiedBscKols([missingXId], { ...options, allowGmgnObservedWallets: true }), []);
});

test("shared Fomo X roster admits only fresh exact bindings and clean GMGN observations", () => {
  const nowMs = Date.parse("2027-01-15T00:00:00Z");
  const checkedAt = new Date(nowMs - 60_000).toISOString();
  const fomoWallet = "0x9100000000000000000000000000000000000001";
  const gmgnWallet = "0x9200000000000000000000000000000000000002";
  const payload = {
    version: 2,
    health: { status: "healthy", checkedAt },
    initialized: {
      fomo_kol: { xUserId: "10001", initializedAt: checkedAt, latestId: "1" },
      gmgn_kol: { xUserId: "10002", initializedAt: checkedAt, latestId: "2" },
    },
    roster: {
      fomo_kol: {
        handle: "fomo_kol",
        wallet: fomoWallet,
        source: "fomoscan_verified_profile",
        tags: ["kol", "fomo"],
        discoveredAt: nowMs - 60_000,
        ambiguousIdentity: false,
        ambiguousWallets: false,
        ambiguousHandles: false,
        xProfile: { id: "10001", handle: "fomo_kol", followers: 25_000, protected: false, checkedAt },
        bscActivity: { count: 3, checkedAt },
        walletBinding: {
          status: "verified",
          verified: true,
          proofSource: "fomoscan",
          wallet: fomoWallet,
          handle: "fomo_kol",
          twitterHandle: "fomo_kol",
          xProfileId: "10001",
          checkedAt,
        },
      },
      gmgn_kol: {
        handle: "gmgn_kol",
        wallet: gmgnWallet,
        wallets: [gmgnWallet],
        twitterHandles: ["gmgn_kol"],
        source: "gmgn_bsc_kol_feed",
        tags: ["kol", "fomo"],
        discoveredAt: nowMs - 60_000,
        ambiguousIdentity: false,
        ambiguousWallets: false,
        ambiguousHandles: false,
        xProfile: { id: "10002", handle: "gmgn_kol", followers: 30_000, protected: false, checkedAt },
        bscActivity: { count: 9, checkedAt },
      },
    },
  };
  const options = {
    nowMs,
    maximumStateAgeMs: 10 * 60_000,
    maximumProofAgeMs: 24 * 60 * 60_000,
    minimumFollowers: 10_000,
  };

  const selected = selectFreshFomoXCallRoster(payload, options);
  assert.equal(selected.status, "healthy");
  assert.deepEqual(selected.profiles.map((profile) => profile.handle).sort(), ["fomo_kol", "gmgn_kol"]);
  const verified = selected.profiles.find((profile) => profile.handle === "fomo_kol");
  assert.equal(verified.walletBinding.xProfileId, "10001");
  assert.equal(verified.candidateSource, "fomoscan_verified_profile");
  const observed = selected.profiles.find((profile) => profile.handle === "gmgn_kol");
  assert.equal(observed.walletBinding.status, "observed");
  assert.equal(observed.candidateSource, "gmgn_bsc_kol_feed");

  const emptyXTimelineBaseline = structuredClone(payload);
  emptyXTimelineBaseline.initialized = {};
  assert.deepEqual(
    selectFreshFomoXCallRoster(emptyXTimelineBaseline, options).profiles.map((profile) => profile.handle).sort(),
    ["fomo_kol", "gmgn_kol"],
    "an empty X timeline baseline must not disable an independently proven wallet-buy roster",
  );

  const noFomoBinding = structuredClone(payload);
  noFomoBinding.roster.fomo_kol.walletBinding = null;
  assert.deepEqual(
    selectFreshFomoXCallRoster(noFomoBinding, options).profiles.map((profile) => profile.handle),
    ["gmgn_kol"],
    "a Fomo seed without a current FomoScan binding must not be relabeled as GMGN",
  );

  const dirtyOnly = structuredClone(noFomoBinding);
  dirtyOnly.roster.gmgn_kol.tags.push("wash_trader");
  assert.equal(selectFreshFomoXCallRoster(dirtyOnly, options).status, "empty");

  const staleProof = structuredClone(payload);
  staleProof.roster.fomo_kol.walletBinding.checkedAt = new Date(nowMs - 24 * 60 * 60_000 - 1).toISOString();
  staleProof.roster.gmgn_kol.bscActivity.checkedAt = new Date(nowMs - 24 * 60 * 60_000 - 1).toISOString();
  assert.equal(selectFreshFomoXCallRoster(staleProof, options).status, "empty");

  const duplicateWallet = structuredClone(payload);
  duplicateWallet.roster.gmgn_kol.wallet = fomoWallet;
  duplicateWallet.roster.gmgn_kol.wallets = [fomoWallet];
  assert.equal(selectFreshFomoXCallRoster(duplicateWallet, options).status, "empty");

  const staleState = structuredClone(payload);
  staleState.health.checkedAt = new Date(nowMs - 10 * 60_000 - 1).toISOString();
  assert.deepEqual(selectFreshFomoXCallRoster(staleState, options), {
    status: "stale",
    reason: "fomo_x_call_health_not_fresh",
    profiles: [],
  });
});

test("GoPlus BSC gate is fail-closed and supplements only missing cannot_sell_all with observed sells", () => {
  const explicit = evaluateGoPlusBscTokenSecurity(
    goPlusPayload(BASE_TOKEN, safeGoPlusRow()),
    BASE_TOKEN,
    { maximumTax: 0.10, observedSell: true },
  );
  assert.equal(explicit.decision, "pass");
  assert.equal(explicit.metrics.cannotSellAllEvidence, "goplus_explicit_zero");

  const realSampleShape = safeGoPlusRow();
  delete realSampleShape.cannot_sell_all;
  const supplemented = evaluateGoPlusBscTokenSecurity(
    goPlusPayload(BASE_TOKEN, realSampleShape),
    BASE_TOKEN,
    { maximumTax: 0.10, observedSell: true },
  );
  assert.equal(supplemented.decision, "pass");
  assert.equal(supplemented.metrics.cannotSellAllEvidence, "supplemented_by_observed_sell");
  assert.equal(
    evaluateGoPlusBscTokenSecurity(goPlusPayload(BASE_TOKEN, realSampleShape), BASE_TOKEN, { maximumTax: 0.10 }).decision,
    "pending",
  );

  for (const row of [
    safeGoPlusRow({ is_honeypot: "1" }),
    safeGoPlusRow({ cannot_sell_all: "1" }),
    safeGoPlusRow({ sell_tax: "0.1001" }),
    safeGoPlusRow({ is_proxy: "1" }),
    safeGoPlusRow({ is_mintable: "1" }),
    safeGoPlusRow({ owner_address: "0x9300000000000000000000000000000000000003" }),
  ]) {
    assert.equal(
      evaluateGoPlusBscTokenSecurity(goPlusPayload(BASE_TOKEN, row), BASE_TOKEN, { maximumTax: 0.10, observedSell: true }).decision,
      "block",
    );
  }
  const missingOwner = safeGoPlusRow();
  delete missingOwner.owner_address;
  assert.equal(
    evaluateGoPlusBscTokenSecurity(goPlusPayload(BASE_TOKEN, missingOwner), BASE_TOKEN, { maximumTax: 0.10, observedSell: true }).decision,
    "pending",
  );
  assert.equal(evaluateGoPlusBscTokenSecurity({ code: 1, result: {} }, BASE_TOKEN).decision, "pending");
});

test("Fomo token dedup advances only after an auditable alert acceptance", () => {
  assert.equal(classifyFomoAlertDelivery({ status: "delivered" }), "accepted");
  assert.equal(classifyFomoAlertDelivery({ status: "queued" }), "accepted");
  assert.equal(classifyFomoAlertDelivery({ status: "suppressed", terminal: true }), "suppressed");
  assert.equal(classifyFomoAlertDelivery({ status: "suppressed", reason: "not_relevant" }), "suppressed");
  assert.throws(() => classifyFomoAlertDelivery({ status: "suppressed", terminal: false }), /unknown status: suppressed/);
  assert.throws(() => classifyFomoAlertDelivery({ status: "suppressed", disposition: "retry" }), /unknown status: suppressed/);
  assert.throws(() => classifyFomoAlertDelivery({ status: "failed" }), /unknown status: failed/);
  assert.throws(() => classifyFomoAlertDelivery(undefined), /unknown status: missing/);
  assert.throws(() => classifyFomoAlertDelivery({ status: "unknown" }), /unknown status: unknown/);
});

test("parses only real buys and rejects sells, transfers, invalid chains and malformed tokens", () => {
  const rows = parseCopeActivities({ activities: [
    { id: "buy-base", fomo_handle: "alpha", chain: "base", action: "buy", token_mint: BASE_TOKEN, token_symbol: "NEW", usd_amount: 5_000, timestamp: 1_800_000_000 },
    { id: "buy-sol", fomo_handle: "alpha", chain: "solana", action: "buy", token_mint: SOL_TOKEN, token_symbol: "SOLNEW", usd_amount: 2_000, timestamp: 1_800_000_001 },
    { id: "sell", fomo_handle: "alpha", chain: "base", action: "sell", token_mint: BASE_TOKEN, usd_amount: 9_000, timestamp: 1_800_000_002 },
    { id: "transfer", fomo_handle: "alpha", chain: "base", action: "transfer", token_mint: BASE_TOKEN, usd_amount: 9_000, timestamp: 1_800_000_003 },
    { id: "buy-bsc", fomo_handle: "alpha", chain: "bsc", action: "buy", token_mint: BASE_TOKEN, usd_amount: 9_000, timestamp: 1_800_000_004 },
    { id: "wrong-chain", fomo_handle: "alpha", chain: "ethereum", action: "buy", token_mint: BASE_TOKEN, usd_amount: 9_000, timestamp: 1_800_000_005 },
  ] });
  assert.deepEqual(rows.map((item) => item.callId), ["buy-base", "buy-sol", "buy-bsc"]);
  assert.equal(rows[2].chain.id, 56);
  assert.equal(rows[0].timestampMs, 1_800_000_000_000);
});

test("maps only verified public Fomo wallets and recognizes a Solana zero-balance swap as first entry", () => {
  const profile = parseFomoScanProfile({
    username: "alpha",
    social: { followers: 150_000 },
    fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
    wallets: {
      solana: { status: "verified", address: SOL_WALLET },
      evm: { status: "unverified", address: "0x3333333333333333333333333333333333333333" },
    },
  });
  assert.equal(profile.solanaAddress, SOL_WALLET);
  assert.equal(profile.baseAddress, null);

  const transaction = {
    slot: 123,
    blockTime: 1_800_000_000,
    transaction: { message: { accountKeys: [
      { pubkey: SOL_WALLET, signer: true, writable: true },
      { pubkey: SOL_TOKEN_ACCOUNT_A, signer: false, writable: true },
      { pubkey: SOL_TOKEN_ACCOUNT_B, signer: false, writable: true },
    ] } },
    meta: {
      err: null,
      fee: 5_000,
      logMessages: ["Program log: Instruction: Swap"],
      preBalances: [2_000_000_000, 2_039_280, 2_039_280],
      postBalances: [1_000_000_000, 2_039_280, 2_039_280],
      preTokenBalances: [
        { accountIndex: 1, owner: SOL_WALLET, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mint: SOL_TOKEN, uiTokenAmount: { amount: "0", decimals: 6 } },
        { accountIndex: 2, owner: SOL_WALLET, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mint: SOL_TOKEN, uiTokenAmount: { amount: "0", decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, owner: SOL_WALLET, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mint: SOL_TOKEN, uiTokenAmount: { amount: "1000000", decimals: 6 } },
        { accountIndex: 2, owner: SOL_WALLET, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mint: SOL_TOKEN, uiTokenAmount: { amount: "1500000", decimals: 6 } },
      ],
    },
  };
  const exactProof = {
    status: "verified",
    complete: true,
    walletSignerVerified: true,
    outputOwnerVerified: true,
    scope: "wallet_mint_all_token_accounts",
    phase: "immediately_before_transaction",
    source: "historical_owner_state",
    wallet: SOL_WALLET,
    signature: "signature-1",
    slot: 123,
    mint: SOL_TOKEN,
    totalWalletPreRaw: "0",
    netAcquiredRaw: "2500000",
  };
  const proof = new Map([[SOL_TOKEN, exactProof]]);
  const calls = detectSolanaFirstBuys(transaction, SOL_WALLET, "signature-1", proof);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tokenAmount, 2.5);
  assert.equal(calls[0].positionProof.scope, "wallet_mint_all_token_accounts");
  assert.equal(calls[0].positionProof.outputTokenAccounts.length, 2);
  assert.equal(detectSolanaFirstBuys(transaction, SOL_WALLET, "signature-unproved").length, 0);
  assert.equal(detectSolanaFirstBuys(transaction, SOL_WALLET, "signature-current-only", new Map([[SOL_TOKEN, 2_500_000n]])).length, 0);
  assert.equal(detectSolanaFirstBuys(transaction, SOL_WALLET, "signature-1", new Map([[
    SOL_TOKEN,
    { ...exactProof, totalWalletPreRaw: "100" },
  ]])).length, 0);
  assert.equal(detectSolanaFirstBuys({
    ...transaction,
    transaction: { message: { accountKeys: [
      { pubkey: SOL_WALLET, signer: false, writable: true },
      { pubkey: SOL_TOKEN_ACCOUNT_A, signer: false, writable: true },
      { pubkey: SOL_TOKEN_ACCOUNT_B, signer: false, writable: true },
    ] } },
  }, SOL_WALLET, "signature-nonsigner", proof).length, 0);
  assert.equal(detectSolanaFirstBuys({ ...transaction, meta: { ...transaction.meta, logMessages: ["Program log: Transfer"] } }, SOL_WALLET, "signature-2", proof).length, 0);
});

test("FomoScan profiles remain eligible for independent X verification when Fomo follower counts are absent", () => {
  const profile = parseFomoScanProfile({
    username: "alpha",
    wallets: {
      evm: { status: "verified", address: BASE_WALLET },
    },
    twitter: "https://x.com/alpha",
  }, "alpha");
  assert.equal(profile.followers, 0);
  assert.equal(profile.fomoFollowers, null);
  assert.equal(profile.twitterHandle, "alpha");
  assert.equal(profile.walletBinding.verified, true);
});

test("Base first-entry proof reads the prior block and rejects a plain transfer", async () => {
  const padTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const transfer = {
    address: BASE_TOKEN,
    topics: [id("Transfer(address,address,uint256)"), padTopic(BASE_POOL), padTopic(BASE_WALLET)],
    data: `0x${(10n ** 18n).toString(16).padStart(64, "0")}`,
  };
  const swap = { address: BASE_POOL, topics: [id("Swap(address,uint256,uint256,uint256,uint256,address)")], data: "0x" };
  const blockTags = [];
  const provider = { call: async (request) => {
    blockTags.push(request.blockTag);
    return blockTags.length === 1 ? `0x${"0".repeat(64)}` : `0x${(18).toString(16).padStart(64, "0")}`;
  } };
  const transaction = { from: BASE_WALLET, value: 10n ** 18n, hash: `0x${"a".repeat(64)}` };
  const block = { number: "0x64", timestamp: `0x${(1_800_000_000).toString(16)}` };
  const calls = await detectBaseFirstBuys(provider, transaction, { status: 1, logs: [swap, transfer] }, block, BASE_WALLET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tokenAmount, 1);
  assert.equal(calls[0].paymentVerification, "transaction_native_value");
  assert.equal(calls[0].valuationBasis, "transaction_native_value");
  assert.equal(calls[0].executionPool, BASE_POOL);
  assert.equal(calls[0].positionProof.previousBalanceRaw, "0");
  assert.deepEqual(blockTags, [99, "0x64"]);
  assert.equal((await detectBaseFirstBuys(provider, transaction, { status: 1, logs: [transfer] }, block, BASE_WALLET)).length, 0);
  const secondToken = "0x4444444444444444444444444444444444444444";
  const secondTransfer = { ...transfer, address: secondToken };
  const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
  const multiOutputProvider = { call: async (request) => request.data.startsWith(erc20.getFunction("balanceOf").selector)
    ? erc20.encodeFunctionResult("balanceOf", [0n])
    : erc20.encodeFunctionResult("decimals", [18]) };
  assert.equal(
    (await detectBaseFirstBuys(multiOutputProvider, transaction, { status: 1, logs: [swap, transfer, secondTransfer] }, block, BASE_WALLET)).length,
    0,
    "a multi-output swap must fail closed instead of assigning the full transaction value to every token",
  );
  const quoteTransfer = {
    address: secondToken,
    topics: [id("Transfer(address,address,uint256)"), padTopic(BASE_WALLET), padTopic(BASE_POOL)],
    data: `0x${(5n * 10n ** 17n).toString(16).padStart(64, "0")}`,
  };
  const [ambiguous] = await detectBaseFirstBuys(multiOutputProvider, transaction, { status: 1, logs: [swap, transfer, quoteTransfer] }, block, BASE_WALLET);
  assert.equal(ambiguous.paymentVerification, "ambiguous_multi_asset_outflow");
  assert.equal(ambiguous.valuationBasis, "estimated_received_token_value");
  assert.equal(ambiguous.amountNative, null, "ambiguous msg.value must not be presented as the token's exact spend");
});

test("recognizes exact official Four.Meme and Flap curve buys but rejects a spoofed emitter", async () => {
  const padTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const transfer = {
    address: BASE_TOKEN,
    topics: [id("Transfer(address,address,uint256)"), padTopic(FOUR_MANAGER), padTopic(BASE_WALLET)],
    data: `0x${(10n ** 18n).toString(16).padStart(64, "0")}`,
  };
  const four = new Interface(["event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)"]);
  const fourEvent = four.encodeEventLog(four.getEvent("TokenPurchase"), [
    BASE_TOKEN, BASE_WALLET, 1n, 10n ** 18n, 9n * 10n ** 17n, 5n * 10n ** 16n, 1n, 1n,
  ]);
  const flap = new Interface(["event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)"]);
  const flapEvent = flap.encodeEventLog(flap.getEvent("TokenBought"), [
    1_800_000_000n, BASE_TOKEN, BASE_WALLET, 10n ** 18n, 8n * 10n ** 17n, 5n * 10n ** 16n, 1n,
  ]);
  const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
  const fourState = new Interface(["function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)"]);
  const flapState = new Interface(["function getTokenV5(address) view returns(tuple(uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID) state)"]);
  const proofProvider = (platform, quote = "0x0000000000000000000000000000000000000000") => ({ call: async (request) => {
    if (request.data.startsWith(fourState.getFunction("_tokenInfos").selector)) {
      return fourState.encodeFunctionResult("_tokenInfos", [BASE_TOKEN, quote, 0n, 10n ** 27n, 1n, 1n, 1n, 1n, 10n ** 18n, 1n, 1n, 1n, 0n]);
    }
    if (request.data.startsWith(flapState.getFunction("getTokenV5").selector)) {
      return flapState.encodeFunctionResult("getTokenV5", [[1, 10n ** 18n, 1n, 1n, 0, 1n, 1n, 1n, 1n, quote, false, `0x${"0".repeat(64)}`]]);
    }
    if (request.data.startsWith(erc20.getFunction("balanceOf").selector)) return erc20.encodeFunctionResult("balanceOf", [0n]);
    if (request.data.startsWith(erc20.getFunction("decimals").selector)) return erc20.encodeFunctionResult("decimals", [18]);
    throw new Error(`unexpected ${platform} proof call ${request.data.slice(0, 10)}`);
  } });
  const transaction = { from: BASE_WALLET, value: 10n ** 18n, hash: `0x${"b".repeat(64)}` };
  const block = { number: "0x64", timestamp: `0x${(1_800_000_000).toString(16)}` };
  const fourCalls = await detectOfficialBscCurveBuys(proofProvider("four"), transaction, { status: 1, logs: [
    transfer,
    { address: FOUR_MANAGER, topics: fourEvent.topics, data: fourEvent.data },
  ] }, block, BASE_WALLET);
  assert.equal(fourCalls.length, 1);
  assert.equal(fourCalls[0].launchpad.id, "fourmeme");
  assert.equal(fourCalls[0].amountNative, 0.95);

  const flapCalls = await detectOfficialBscCurveBuys(proofProvider("flap"), { ...transaction, hash: `0x${"c".repeat(64)}` }, { status: 1, logs: [
    transfer,
    { address: FLAP_PORTAL, topics: flapEvent.topics, data: flapEvent.data },
  ] }, block, BASE_WALLET);
  assert.equal(flapCalls.length, 1);
  assert.equal(flapCalls[0].launchpad.id, "flap");

  const spoofed = await detectOfficialBscCurveBuys(proofProvider("four"), transaction, { status: 1, logs: [
    transfer,
    { address: BASE_POOL, topics: fourEvent.topics, data: fourEvent.data },
  ] }, block, BASE_WALLET);
  assert.equal(spoofed.length, 0);
});

test("recognizes a Four.Meme ERC20-quote curve buy by its exact wallet spend", async () => {
  const quote = "0x55d398326f99059ff775485246999027b3197955";
  const padTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const rawSpend = 95n * 10n ** 16n;
  const transfer = (token, from, to, amount) => ({
    address: token,
    topics: [id("Transfer(address,address,uint256)"), padTopic(from), padTopic(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  });
  const four = new Interface(["event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)"]);
  const event = four.encodeEventLog(four.getEvent("TokenPurchase"), [
    BASE_TOKEN, BASE_WALLET, 1n, 10n ** 18n, 9n * 10n ** 17n, 5n * 10n ** 16n, 1n, 1n,
  ]);
  const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
  const fourState = new Interface(["function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)"]);
  const provider = { call: async (request) => {
    if (request.data.startsWith(fourState.getFunction("_tokenInfos").selector)) {
      return fourState.encodeFunctionResult("_tokenInfos", [BASE_TOKEN, quote, 0n, 10n ** 27n, 1n, 1n, 1n, 1n, 10n ** 18n, 1n, 1n, 1n, 0n]);
    }
    if (request.data.startsWith(erc20.getFunction("balanceOf").selector)) return erc20.encodeFunctionResult("balanceOf", [0n]);
    if (request.data.startsWith(erc20.getFunction("decimals").selector)) return erc20.encodeFunctionResult("decimals", [18]);
    throw new Error(`unexpected proof call ${request.data.slice(0, 10)}`);
  } };
  const transaction = { from: BASE_WALLET, value: 0n, hash: `0x${"d".repeat(64)}` };
  const block = { number: "0x64", timestamp: `0x${(1_800_000_000).toString(16)}` };
  const logs = [
    transfer(BASE_TOKEN, FOUR_MANAGER, BASE_WALLET, 10n ** 18n),
    transfer(quote, BASE_WALLET, FOUR_MANAGER, rawSpend),
    { address: FOUR_MANAGER, topics: event.topics, data: event.data },
  ];
  const calls = await detectOfficialBscCurveBuys(provider, transaction, { status: 1, logs }, block, BASE_WALLET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].paymentToken, quote);
  assert.equal(calls[0].paymentRaw, rawSpend.toString());
  assert.equal(calls[0].paymentVerification, "official_event+erc20_transfer");
  assert.equal((await detectOfficialBscCurveBuys(provider, transaction, { status: 1, logs: logs.filter((log) => log.address !== quote) }, block, BASE_WALLET)).length, 0);
  assert.equal((await detectOfficialBscCurveBuys(provider, { ...transaction, value: 10n ** 17n }, {
    status: 1,
    logs: logs.filter((log) => log.address !== quote),
  }, block, BASE_WALLET)).length, 0, "native router value cannot replace a missing ERC20 quote transfer");
  const withNativeDust = await detectOfficialBscCurveBuys(provider, { ...transaction, value: 10n ** 15n }, { status: 1, logs }, block, BASE_WALLET);
  assert.equal(withNativeDust[0].paymentToken, quote, "an exact ERC20 spend remains authoritative when msg.value is also present");
  assert.equal(withNativeDust[0].paymentVerification, "official_event+erc20_transfer");
  const mismatched = logs.map((log) => log.address === quote ? transfer(quote, BASE_WALLET, FOUR_MANAGER, rawSpend / 2n) : log);
  assert.equal((await detectOfficialBscCurveBuys(provider, transaction, { status: 1, logs: mismatched }, block, BASE_WALLET)).length, 0);
  const missingQuoteState = { call: async (request) => {
    if (request.data.startsWith(fourState.getFunction("_tokenInfos").selector)) throw new Error("archive state unavailable");
    if (request.data.startsWith(erc20.getFunction("balanceOf").selector)) return erc20.encodeFunctionResult("balanceOf", [0n]);
    if (request.data.startsWith(erc20.getFunction("decimals").selector)) return erc20.encodeFunctionResult("decimals", [18]);
    throw new Error("unexpected proof call");
  } };
  assert.equal((await detectOfficialBscCurveBuys(missingQuoteState, { ...transaction, value: 10n ** 18n }, { status: 1, logs }, block, BASE_WALLET)).length, 0);
});

test("parses multi-buyer convergence and DEX sell/liquidity evidence", () => {
  const [call] = parseCopeConvergences({ events: [{
    id: 7,
    token: { mint: BASE_TOKEN, symbol: "NEW", chain: "base" },
    wallet_count: 2,
    wallets: [{ handle: "alpha", amount_usd: 3_000 }, { handle: "beta", amount_usd: 4_000 }],
    total_usd_in: 7_000,
    detected_at: 1_800_000_000,
  }] });
  assert.equal(call.buyerCount, 2);
  assert.equal(call.totalUsd, 7_000);

  const market = parseDexScreenerMarket({ pairs: [{
    chainId: "base",
    pairAddress: BASE_POOL,
    dexId: "aerodrome",
    baseToken: { address: BASE_TOKEN, symbol: "NEW" },
    liquidity: { usd: 50_000 },
    volume: { m5: 12_345 },
    txns: { m5: { buys: 20, sells: 3 } },
    pairCreatedAt: 1_799_999_000_000,
    marketCap: 800_000,
  }] }, { id: 8453, slug: "base" }, BASE_TOKEN);
  assert.equal(market.liquidityUsd, 50_000);
  assert.equal(market.sellsM5, 3);
  assert.equal(market.tokenSymbol, "NEW");
});

test("missing Cope key activates the public verified-wallet baseline and never scrapes fomo.family", async (t) => {
  const dataDir = await fixture(t);
  const urls = [];
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: ["alpha"],
    fomoCallPublicTopLimit: 1,
    fomoCallSolanaRpcUrl: "https://solana.example/rpc",
  }, {
    autoStart: false,
    fetchImpl: async (url, options = {}) => {
      urls.push(String(url));
      if (String(url).includes("/get-user/alpha")) return ok({
        username: "alpha",
        displayName: "Alpha",
        social: { followers: 150_000 },
        fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
        wallets: {
          solana: { status: "verified", address: SOL_WALLET },
          evm: { status: "verified", address: "0x3333333333333333333333333333333333333333" },
        },
        twitter: "https://x.com/alpha",
      });
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", networkCode: "BSC" }],
      });
      if (String(url) === "https://solana.example/rpc") {
        assert.equal(JSON.parse(options.body).method, "getSignaturesForAddress");
        return ok({ jsonrpc: "2.0", id: 1, result: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
    baseProvider: { getBlockNumber: async () => 100 },
    bscProvider: { getBlockNumber: async () => 200 },
    evmRpcImpl: async (_url, method) => {
      assert.equal(method, "eth_blockNumber");
      return "0x64";
    },
    logger: { error() {} },
  });
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.health.status, "partial");
  assert.equal(state.health.source, "fomoscan_onchain");
  assert.equal(state.topBloggers[0].handle, "alpha");
  assert.equal(state.publicOnchain.coverage.solana, "not_configured");
  assert.equal(state.publicOnchain.coverage.base, "healthy");
  assert.equal(state.publicOnchain.coverage.bsc, "healthy");
  assert.equal(state.coverageSummary.candidatePoolSize, 1);
  assert.equal(state.coverageSummary.monitoredTopCount, 1);
  assert.deepEqual(state.coverageSummary.missingChains, ["solana"]);
  assert.equal(state.coverageSummary.profileFreshness.status, "unknown");
  assert.equal(state.coverageSummary.gaps.count, 0);
  assert.deepEqual(state.coverageSummary.convergence, {
    configured: false,
    available: false,
    source: null,
    reason: "cope_not_configured",
  });
  assert.equal(state.coverageSummary.complete, false);
  assert.ok(urls.every((url) => !url.includes("prod-api.fomo.family") && !url.includes("api.cope.capital")));
});

test("partial public profile refresh keeps the last verified top blogger", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2027-01-15T00:00:00Z");
  let stage = 0;
  const profile = (handle, followers, address) => ({
    username: handle,
    social: { followers },
    fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
    wallets: {
      solana: { status: "unverified", address: null },
      evm: { status: "verified", address },
    },
  });
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: ["alpha", "beta"],
    fomoCallPublicTopLimit: 1,
    fomoCallPublicProfilePollIntervalMs: 5 * 60_000,
    fomoCallBaseRpcUrl: "https://base.example/rpc",
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => {
      if (String(url).includes("/get-user/alpha")) {
        if (stage === 1) throw new Error("alpha profile temporarily unavailable");
        return ok(profile("alpha", 150_000, BASE_WALLET));
      }
      if (String(url).includes("/get-user/beta")) {
        return ok(profile("beta", stage === 0 ? 100_000 : 149_000, "0x4444444444444444444444444444444444444444"));
      }
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
      });
      throw new Error(`unexpected URL ${url}`);
    },
    baseProvider: {},
    bscProvider: {},
    evmRpcImpl: async (_rpcUrl, method) => {
      assert.equal(method, "eth_blockNumber");
      return "0x64";
    },
    logger: { error() {} },
  });

  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.topBloggers[0].handle, "alpha");
  assert.equal(state.publicOnchain.profileCoverage, "healthy");

  stage = 1;
  current += 6 * 60_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.topBloggers[0].handle, "alpha", "a transient profile failure must not evict the previous verified top account");
  assert.equal(state.publicOnchain.profiles.alpha.followers, 150_000);
  assert.equal(state.publicOnchain.profiles.beta.followers, 149_000, "successful profiles should still refresh during partial coverage");
  assert.equal(state.publicOnchain.profileCoverage, "partial");
  assert.equal(state.publicOnchain.coverage.profiles, "partial");
  assert.equal(state.health.status, "partial");

  stage = 2;
  current += 61_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.profileCoverage, "healthy", "partial public profile coverage retries after one minute");
  assert.equal(state.health.status, "partial", "unknown profile freshness and unavailable convergence remain visible after source recovery");
});

test("monitorAllEligible scans a fresh GMGN maker without a Fomo profile and emits attribution, not binding", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2027-01-15T00:00:00Z");
  let stage = 0;
  const configuredHandles = Array.from({ length: 11 }, (_, index) => `kol${String(index + 1).padStart(2, "0")}`);
  const dynamicHandle = "dynamic_kol";
  const wallets = new Map([...configuredHandles, dynamicHandle].map((handle, index) => [
    handle,
    `0x${(index + 10).toString(16).padStart(40, "0")}`,
  ]));
  const xIds = new Map([...configuredHandles, dynamicHandle].map((handle, index) => [handle, String(900_000 + index)]));
  const dynamicWallet = wallets.get(dynamicHandle);
  const transactionHash = `0x${"9".repeat(64)}`;
  const rawNativeSpend = 2n * 10n ** 18n;
  const requestedBlocks = [];
  let goPlusRequests = 0;
  const alerts = [];
  const transferTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const receipt = {
    status: "0x1",
    transactionHash,
    blockNumber: "0x3e3",
    blockHash: testBlockHash(995),
    from: dynamicWallet,
    logs: [
      {
        address: BASE_POOL,
        topics: [id("Swap(address,uint256,uint256,uint256,uint256,address)")],
        data: "0x",
        transactionHash,
        blockNumber: "0x3e3",
        blockHash: testBlockHash(995),
      },
      {
        address: BASE_TOKEN,
        topics: [id("Transfer(address,address,uint256)"), transferTopic(BASE_POOL), transferTopic(dynamicWallet)],
        data: `0x${(10n ** 18n).toString(16).padStart(64, "0")}`,
        transactionHash,
        blockNumber: "0x3e3",
        blockHash: testBlockHash(995),
      },
    ],
  };
  const erc20 = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
  const profile = (handle) => ({
    username: handle,
    displayName: handle,
    social: { followers: handle === dynamicHandle ? 250_000 : 20_000 + Number(handle.slice(-2)) },
    fomoStats: { numTrades: 100, totalVolume: 1_000_000 },
    wallets: {
      solana: { status: "unverified", address: null },
      evm: { status: "verified", address: wallets.get(handle) },
    },
    twitter: `https://x.com/${handle}`,
  });
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: configuredHandles,
    fomoCallMonitorAllEligible: true,
    fomoCallAllowGmgnObservedWallets: true,
    fomoCallGmgnAttributionMaxAgeMs: 24 * 60 * 60_000,
    fomoCallMinXFollowers: 10_000,
    fomoCallRequireTwitterIdentity: true,
    fomoCallRequireBscActivity: true,
    fomoCallBscOnly: true,
    fomoCallDynamicDiscoveryEnabled: true,
    fomoCallDynamicDiscoveryIntervalMs: 60_000,
    fomoCallNewWalletLookbackBlocks: 20,
    fomoCallBscConfirmations: 0,
    fomoCallBscMaxCatchupBlocks: 100,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
    fomoCallMinBuyUsd: 1_000,
    fomoCallMinLiquidityUsd: 10_000,
    fomoCallMaxSignalAgeMs: 300_000,
    fomoCallStrictBuyProvenance: true,
    fomoCallGoPlusEnabled: true,
    fomoCallGoPlusApiBase: "https://api.gopluslabs.io/api/v1/token_security",
    fomoCallGoPlusTimeoutMs: 8_000,
    fomoCallGoPlusMaxTaxBps: 1_000,
  }, {
    autoStart: false,
    now: () => current,
    discoverBscKolCandidatesImpl: async () => stage === 0 ? [] : [{
      handle: dynamicHandle,
      wallet: dynamicWallet,
      wallets: [dynamicWallet],
      twitterHandles: [dynamicHandle],
      ambiguousWallets: false,
      ambiguousHandles: false,
      ambiguousIdentity: false,
      tags: ["kol", "fomo"],
      discoveredAt: current,
      source: "gmgn_bsc_kol_feed",
    }],
    fetchImpl: async (url) => {
      const profileMatch = String(url).match(/\/get-user\/([^/?]+)/);
      if (profileMatch) {
        const handle = decodeURIComponent(profileMatch[1]);
        if (handle === dynamicHandle) return {
          ok: false,
          status: 404,
          json: async () => ({ error: "not found" }),
          text: async () => "not found",
        };
        return ok(profile(handle));
      }
      if (String(url).includes("/search?") && String(url).includes(`q=${dynamicHandle}`)) return ok({ results: [] });
      const xProfileMatch = String(url).match(/\/2\/profile\/([^/?]+)/);
      if (xProfileMatch) {
        const handle = decodeURIComponent(xProfileMatch[1]);
        return ok({
          code: 200,
          user: {
            id: xIds.get(handle),
            screen_name: handle,
            followers: handle === dynamicHandle ? 250_000 : 20_000 + Number(handle.slice(-2)),
            protected: false,
          },
        });
      }
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
      });
      if (String(url).includes("api.gopluslabs.io/api/v1/token_security/56")) {
        goPlusRequests += 1;
        const row = safeGoPlusRow();
        delete row.cannot_sell_all;
        return ok(goPlusPayload(BASE_TOKEN, row));
      }
      if (String(url).includes(`/bsc/${BASE_TOKEN}`)) return ok({ pairs: [{
        chainId: "bsc",
        pairAddress: BASE_POOL,
        dexId: "pancakeswap",
        baseToken: { address: BASE_TOKEN, symbol: "NEW" },
        quoteToken: { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" },
        liquidity: { usd: 80_000 },
        volume: { m5: 25_000 },
        txns: { m5: { buys: 30, sells: 4 } },
        pairCreatedAt: current - 60_000,
        marketCap: 900_000,
        priceUsd: "0.001",
      }] });
      if (String(url).includes("/bsc/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c")) return ok({ pairs: [{
        chainId: "bsc",
        pairAddress: "0x7777777777777777777777777777777777777777",
        baseToken: { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" },
        quoteToken: { address: "0x55d398326f99059ff775485246999027b3197955" },
        priceUsd: "600",
        liquidity: { usd: 2_000_000 },
      }] });
      throw new Error(`unexpected URL ${url}`);
    },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {
      failOnProofError: true,
      call: async (request) => {
        if (request.data.startsWith(erc20.getFunction("balanceOf").selector)) return erc20.encodeFunctionResult("balanceOf", [0n]);
        if (request.data.startsWith(erc20.getFunction("decimals").selector)) return erc20.encodeFunctionResult("decimals", [18]);
        throw new Error(`unexpected historical call ${request.data.slice(0, 10)}`);
      },
      getCode: async () => "0x01",
    },
    evmRpcImpl: async (_rpcUrl, method, params) => {
      if (method === "eth_blockNumber") return "0x3e8";
      if (method === "eth_getTransactionReceipt" && params[0] === transactionHash) return receipt;
      throw new Error(`unexpected EVM RPC ${method}`);
    },
    evmRpcBatchImpl: async (_rpcUrl, calls) => {
      if (calls.every((call) => call.method === "eth_getTransactionCount")) return calls.map(() => "0x1");
      if (calls.every((call) => call.method === "eth_getTransactionReceipt")) return calls.map(() => receipt);
      assert.ok(calls.every((call) => call.method === "eth_getBlockByNumber"));
      return calls.map((call) => {
        const blockNumber = Number(BigInt(call.params[0]));
        requestedBlocks.push(blockNumber);
        return {
          number: call.params[0],
          hash: testBlockHash(blockNumber),
          timestamp: `0x${Math.floor(current / 1_000).toString(16)}`,
          transactions: blockNumber === 995 ? [{
            hash: transactionHash,
            from: dynamicWallet,
            to: BASE_POOL,
            value: `0x${rawNativeSpend.toString(16)}`,
            blockNumber: call.params[0],
            blockHash: testBlockHash(blockNumber),
          }] : [],
        };
      });
    },
    assessEvmSecurityImpl: async () => ({
      decision: "pass",
      label: "pass",
      reasons: [],
      warnings: [],
      metrics: { liquidityConfirmed: true },
    }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
    logger: { error() {} },
  });

  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.topBloggers.length, 11, "monitorAllEligible must not inherit the top-10 display limit");
  assert.equal(state.publicOnchain.bscNextBlock, 1001);
  assert.deepEqual(requestedBlocks, [], "cold start must establish a silent safe-head baseline without replaying prior blocks");

  stage = 1;
  current += 61_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.topBloggers.length, 12);
  assert.ok(state.topBloggers.some((entry) => entry.handle === dynamicHandle));
  assert.deepEqual(requestedBlocks, Array.from({ length: 20 }, (_, index) => 981 + index));
  assert.equal(state.publicOnchain.bscNextBlock, 1001, "the rewind must scan contiguously back to the saved head");
  assert.deepEqual(state.publicOnchain.lastWalletExpansion, {
    addedCount: 1,
    lookbackBlocks: 20,
    observedAt: new Date(current).toISOString(),
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].caller.handle, dynamicHandle);
  assert.equal(alerts[0].caller.identitySource, "gmgn+fxtwitter");
  assert.equal(alerts[0].caller.xProfileId, xIds.get(dynamicHandle));
  assert.equal(alerts[0].walletAddress, dynamicWallet);
  assert.equal(alerts[0].walletBinding, null, "an observed GMGN maker must never be presented as a verified Fomo binding");
  assert.deepEqual(alerts[0].walletAttribution, {
    scheme: "gmgn_x_maker_observation_v1",
    status: "observed",
    verified: false,
    candidateSource: "gmgn_bsc_kol_feed",
    ambiguousIdentity: false,
    ambiguousWallets: false,
    ambiguousHandles: false,
    monitoringWallet: dynamicWallet,
    xHandle: dynamicHandle,
    fomoTagged: true,
    tags: ["kol", "fomo"],
    observedAt: new Date(current).toISOString(),
    source: "gmgn_bsc_kol_feed",
    xProfileId: xIds.get(dynamicHandle),
    xFollowersCheckedAt: new Date(current).toISOString(),
    bscActivityCheckedAt: new Date(current).toISOString(),
    bscTransactionCount: 1,
  });
  assert.equal(alerts[0].source.id, "gmgn_kol_onchain");
  assert.equal(alerts[0].source.trust, "public_onchain_attributed");
  assert.equal(alerts[0].profileUrl, null);
  assert.equal(alerts[0].positionProof.wallet, dynamicWallet);
  assert.equal(alerts[0].positionProof.token, BASE_TOKEN);
  assert.equal(alerts[0].positionProof.transactionHash, transactionHash);
  assert.equal(alerts[0].positionProof.blockNumber, 995);
  assert.equal(goPlusRequests, 1);
  assert.equal(alerts[0].security.metrics.goPlus.provider, "goplus_token_security_v1");
  assert.equal(alerts[0].security.metrics.goPlus.cannotSellAllEvidence, "supplemented_by_observed_sell");
  assert.equal(alerts[0].security.metrics.coverage.sellability, "supplemented_by_observed_sell");
});

test("BSC activation safety records a stale-tail gap without silent rebaseline and honors zero lookback", async (t) => {
  const current = Date.parse("2027-01-15T00:00:00Z");
  const checkedAt = new Date(current).toISOString();
  const staleDir = await fixture(t);
  const cachedBlogger = {
    id: "alpha",
    handle: "alpha",
    displayName: "Alpha",
    followers: 150_000,
    baseAddress: BASE_WALLET,
    profileFreshness: "fresh",
  };
  await fs.writeFile(path.join(staleDir, "fomo-call-state.json"), JSON.stringify({
    version: 9,
    topBloggers: [cachedBlogger],
    watchlist: { id: "public-onchain", name: "fomo-public", handles: ["alpha"] },
    publicOnchain: {
      candidateHandles: ["alpha"],
      discoveryStatus: "disabled",
      profilesCheckedAt: checkedAt,
      profiles: { alpha: cachedBlogger },
      profileCoverage: "healthy",
      curveSourcesCheckedAt: checkedAt,
      curveSourcesStatus: "healthy",
      fourMemeManagers: [FOUR_MANAGER],
      bscNextBlock: 100,
      bscSilentBaselinePending: false,
      bscLookbackRequested: true,
    },
  }));
  let staleBatchRequests = 0;
  const staleRequestedBlocks = [];
  const staleMonitor = createFomoCallMonitor({
    dataDir: staleDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: ["alpha"],
    fomoCallSharedRosterEnabled: false,
    fomoCallDynamicDiscoveryEnabled: false,
    fomoCallBscOnly: true,
    fomoCallBscConfirmations: 0,
    fomoCallBscMaxCatchupBlocks: 20,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => { throw new Error(`unexpected fetch ${url}`); },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {},
    evmRpcImpl: async (_url, method) => {
      assert.equal(method, "eth_blockNumber");
      return "0x3e8";
    },
    evmRpcBatchImpl: async (_url, calls) => {
      staleBatchRequests += 1;
      assert.ok(calls.every((call) => call.method === "eth_getBlockByNumber"));
      return calls.map((call) => {
        const blockNumber = Number(BigInt(call.params[0]));
        staleRequestedBlocks.push(blockNumber);
        return {
          number: call.params[0],
          hash: testBlockHash(blockNumber),
          timestamp: `0x${Math.floor(current / 1_000).toString(16)}`,
          transactions: [],
        };
      });
    },
    logger: { error() {} },
  });
  await staleMonitor.check();
  const staleState = JSON.parse(await fs.readFile(path.join(staleDir, "fomo-call-state.json"), "utf8"));
  assert.equal(staleBatchRequests, 1);
  assert.deepEqual(staleRequestedBlocks, Array.from({ length: 20 }, (_, index) => 981 + index));
  assert.equal(staleState.publicOnchain.bscNextBlock, 1001);
  assert.equal(staleState.publicOnchain.bscLookbackRequested, false);
  assert.equal(staleState.publicOnchain.bscBaseline, null);
  assert.deepEqual(staleState.publicOnchain.coverageGaps.at(-1), {
    chain: "bsc",
    fromBlock: 100,
    toBlock: 980,
    reason: "backlog_exceeded_signal_window",
    observedAt: checkedAt,
  });
  assert.equal(staleState.health.status, "partial", "a running stale cursor gap must remain observable");

  const zeroLookbackDir = await fixture(t);
  await fs.writeFile(path.join(zeroLookbackDir, "fomo-call-state.json"), JSON.stringify({
    version: 9,
    topBloggers: [],
    publicOnchain: {
      bscNextBlock: 1001,
      bscSilentBaselinePending: false,
      bscLookbackRequested: false,
    },
  }));
  let blockBatchRequests = 0;
  const zeroLookbackMonitor = createFomoCallMonitor({
    dataDir: zeroLookbackDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: ["alpha"],
    fomoCallMonitorAllEligible: true,
    fomoCallMinXFollowers: 10_000,
    fomoCallRequireTwitterIdentity: true,
    fomoCallRequireBscActivity: true,
    fomoCallSharedRosterEnabled: false,
    fomoCallDynamicDiscoveryEnabled: false,
    fomoCallBscOnly: true,
    fomoCallNewWalletLookbackBlocks: 0,
    fomoCallBscConfirmations: 0,
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => {
      if (String(url).includes("/get-user/alpha")) return ok({
        username: "alpha",
        social: { followers: 150_000 },
        fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
        wallets: { evm: { status: "verified", address: BASE_WALLET } },
        twitter: "https://x.com/alpha",
      });
      if (String(url).includes("/2/profile/alpha")) return ok({
        code: 200,
        user: { id: "123456789", screen_name: "alpha", followers: 150_000, protected: false },
      });
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
      });
      throw new Error(`unexpected fetch ${url}`);
    },
    baseProvider: {},
    bscProvider: {},
    bscHistoricalProvider: {},
    evmRpcImpl: async (_url, method) => {
      assert.equal(method, "eth_blockNumber");
      return "0x3e8";
    },
    evmRpcBatchImpl: async (_url, calls) => {
      if (calls.every((call) => call.method === "eth_getTransactionCount")) return calls.map(() => "0x1");
      blockBatchRequests += 1;
      throw new Error("lookback=0 must not fetch pre-admission blocks");
    },
    logger: { error() {} },
  });
  await zeroLookbackMonitor.check();
  const zeroState = JSON.parse(await fs.readFile(path.join(zeroLookbackDir, "fomo-call-state.json"), "utf8"));
  assert.equal(zeroState.topBloggers[0].handle, "alpha");
  assert.equal(blockBatchRequests, 0);
  assert.equal(zeroState.publicOnchain.bscNextBlock, 1001);
  assert.equal(zeroState.publicOnchain.bscLookbackRequested, false);
  assert.equal(zeroState.publicOnchain.lastWalletExpansion, undefined);
});

test("Base EVM batches advance the cursor through every contiguous fetched block", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2027-01-15T00:00:00Z");
  let baseHead = 100;
  const baseBatchGroups = [];
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: ["alpha"],
    fomoCallPublicTopLimit: 1,
    fomoCallBaseRpcUrl: "https://base.example/rpc",
    fomoCallBscRpcUrl: "https://bsc.example/rpc",
    fomoCallBaseConfirmations: 0,
    fomoCallBscConfirmations: 0,
    fomoCallBaseMaxCatchupBlocks: 100,
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => {
      if (String(url).includes("/get-user/alpha")) return ok({
        username: "alpha",
        social: { followers: 150_000 },
        fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
        wallets: {
          solana: { status: "unverified", address: null },
          evm: { status: "verified", address: BASE_WALLET },
        },
      });
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
      });
      throw new Error(`unexpected URL ${url}`);
    },
    baseProvider: {},
    bscProvider: {},
    evmRpcImpl: async (rpcUrl, method) => {
      assert.equal(method, "eth_blockNumber");
      return rpcUrl === "https://base.example/rpc" ? `0x${baseHead.toString(16)}` : "0xc8";
    },
    evmRpcBatchImpl: async (rpcUrl, calls) => {
      assert.equal(rpcUrl, "https://base.example/rpc", "the unchanged BSC head must not need a block batch");
      assert.ok(calls.every((call) => call.method === "eth_getBlockByNumber"));
      const blockNumbers = calls.map((call) => Number(BigInt(call.params[0])));
      baseBatchGroups.push(blockNumbers);
      return calls.map((call) => ({
        number: call.params[0],
        timestamp: `0x${Math.floor(current / 1_000).toString(16)}`,
        transactions: [],
      }));
    },
    logger: { error() {} },
  });

  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.baseNextBlock, 101, "the first pass establishes a silent safe-head baseline");

  baseHead = 112;
  current += 12_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.deepEqual(baseBatchGroups.map((group) => group.length).sort((left, right) => left - right), [2, 10]);
  assert.deepEqual(
    baseBatchGroups.flat().sort((left, right) => left - right),
    Array.from({ length: 12 }, (_, index) => 101 + index),
  );
  assert.equal(state.publicOnchain.baseNextBlock, 113, "cursor advances to the block immediately after the safe head");
  assert.equal(state.publicOnchain.coverage.base, "healthy");
});

test("Solana backlog beyond 200 signatures records a gap, advances the latest cursor and recovers", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2027-01-15T00:00:00Z");
  let stage = 0;
  let page = 0;
  let transactionFetches = 0;
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: ["alpha"],
    fomoCallPublicTopLimit: 1,
    fomoCallSolanaRpcUrl: "https://solana.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/get-user/alpha")) return ok({
        username: "alpha",
        social: { followers: 150_000 },
        fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
        wallets: {
          solana: { status: "verified", address: SOL_WALLET },
          evm: { status: "inactive", address: null },
        },
      });
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
      });
      if (String(url) !== "https://solana.example/rpc") throw new Error(`unexpected URL ${url}`);
      const request = JSON.parse(options.body);
      if (request.method === "getTransaction") {
        transactionFetches += 1;
        return ok({
          jsonrpc: "2.0",
          id: 1,
          result: {
            blockTime: Math.floor(current / 1_000),
            transaction: { message: { accountKeys: [] } },
            meta: { err: null, logMessages: [] },
          },
        });
      }
      assert.equal(request.method, "getSignaturesForAddress");
      const rpcOptions = request.params[1];
      if (stage === 0) return ok({ jsonrpc: "2.0", id: 1, result: [{ signature: "baseline", err: null }] });
      if (stage === 2) {
        assert.equal(rpcOptions.until, "sig-200", "the next poll must start after the newly advanced cursor");
        return ok({ jsonrpc: "2.0", id: 1, result: [] });
      }
      assert.equal(stage, 1);
      assert.equal(rpcOptions.until, "baseline");
      if (rpcOptions.limit === 1) {
        assert.equal(page, 8, "overflow is probed only after eight complete 25-signature pages");
        return ok({ jsonrpc: "2.0", id: 1, result: [{ signature: "sig-overflow", err: null }] });
      }
      assert.equal(rpcOptions.limit, 25);
      const high = 200 - page * 25;
      const signatures = Array.from({ length: 25 }, (_, index) => ({ signature: `sig-${high - index}`, err: null }));
      page += 1;
      return ok({ jsonrpc: "2.0", id: 1, result: signatures });
    },
    baseProvider: {},
    bscProvider: {},
    verifySolanaFirstPositionImpl: async () => null,
    logger: { error() {} },
  });

  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.solanaCursors[SOL_WALLET], "baseline");

  stage = 1;
  current += 12_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(page, 8);
  assert.equal(transactionFetches, 200);
  assert.equal(state.publicOnchain.solanaCursors[SOL_WALLET], "sig-200", "truncation must advance to the newest processed signature");
  const gap = state.publicOnchain.coverageGaps.find((entry) => entry.reason === "signature_backlog_exceeded_200");
  assert.deepEqual({
    chain: gap?.chain,
    wallet: gap?.wallet,
    fromSignature: gap?.fromSignature,
    toSignature: gap?.toSignature,
  }, {
    chain: "solana",
    wallet: SOL_WALLET,
    fromSignature: "baseline",
    toSignature: "sig-1",
  });
  assert.equal(state.publicOnchain.coverage.solana, "degraded");

  stage = 2;
  current += 12_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(state.publicOnchain.solanaCursors[SOL_WALLET], "sig-200");
  assert.equal(state.publicOnchain.coverage.solana, "healthy");
  assert.equal(state.health.status, "partial", "an unresolved coverage gap must keep overall health partial after scanning recovers");
  assert.equal(state.coverageSummary.gaps.count, 1);
  assert.equal(state.coverageSummary.gaps.byChain.solana.count, 1);
});

test("Solana transaction details are skipped with a gap after three failed polls", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2027-01-15T00:00:00Z");
  let stage = 0;
  let transactionFetches = 0;
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "",
    fomoCallPublicHandles: ["alpha"],
    fomoCallPublicTopLimit: 1,
    fomoCallSolanaRpcUrl: "https://solana.example/rpc",
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/get-user/alpha")) return ok({
        username: "alpha",
        social: { followers: 150_000 },
        fomoStats: { numTrades: 500, totalVolume: 10_000_000 },
        wallets: {
          solana: { status: "verified", address: SOL_WALLET },
          evm: { status: "inactive", address: null },
        },
      });
      if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
        code: 0,
        data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
      });
      if (String(url) !== "https://solana.example/rpc") throw new Error(`unexpected URL ${url}`);
      const request = JSON.parse(options.body);
      if (request.method === "getTransaction") {
        transactionFetches += 1;
        return ok({ jsonrpc: "2.0", id: 1, result: null });
      }
      assert.equal(request.method, "getSignaturesForAddress");
      const rpcOptions = request.params[1];
      if (stage === 0) return ok({ jsonrpc: "2.0", id: 1, result: [{ signature: "baseline", err: null }] });
      if (stage <= 3) {
        assert.equal(rpcOptions.until, "baseline", "cursor stays put while the transaction remains retryable");
        return ok({ jsonrpc: "2.0", id: 1, result: [{ signature: "retry-sig", err: null }] });
      }
      assert.equal(rpcOptions.until, "retry-sig", "the fourth poll must continue beyond the skipped signature");
      return ok({ jsonrpc: "2.0", id: 1, result: [] });
    },
    baseProvider: {},
    bscProvider: {},
    verifySolanaFirstPositionImpl: async () => null,
    logger: { error() {} },
  });

  await monitor.check();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    stage = attempt;
    current += 12_000;
    await monitor.check();
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
    assert.equal(state.publicOnchain.solanaCursors[SOL_WALLET], "baseline");
    assert.equal(state.publicOnchain.solanaFailures[SOL_WALLET]["retry-sig"], attempt);
    assert.equal(state.publicOnchain.coverageGaps.some((entry) => entry.signature === "retry-sig"), false);
  }

  stage = 3;
  current += 12_000;
  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(transactionFetches, 3);
  assert.equal(state.publicOnchain.solanaCursors[SOL_WALLET], "retry-sig");
  assert.equal(state.publicOnchain.solanaFailures[SOL_WALLET]["retry-sig"], undefined);
  const gaps = state.publicOnchain.coverageGaps.filter((entry) => entry.signature === "retry-sig");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "transaction_unavailable_after_3_attempts");
  assert.equal(state.health.status, "partial");
  assert.equal(state.coverageSummary.gaps.count, 1);

  stage = 4;
  current += 12_000;
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(transactionFetches, 3, "the permanently unavailable transaction must not be fetched forever");
  assert.equal(state.publicOnchain.coverageGaps.filter((entry) => entry.signature === "retry-sig").length, 1);
  assert.equal(state.publicOnchain.coverage.solana, "healthy");
});

test("one poll safely emits multiple new tokens while deduplicating same-token candidates", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2027-01-15T00:00:00Z");
  let stage = 0;
  const alerts = [];
  const activityTx = `0x${"e".repeat(64)}`;
  const activity = (id, token, symbol, transactionHash = activityTx) => ({
    id,
    fomo_handle: "alpha",
    chain: "base",
    action: "buy",
    token_mint: token,
    token_symbol: symbol,
    usd_amount: 5_000,
    timestamp: Math.floor(current / 1_000),
    tx_hash: transactionHash,
    block_number: 123_456,
  });
  const fetchImpl = async (url) => {
    if (String(url).includes("/get-user/alpha")) return ok({
      username: "alpha",
      social: { followers: 150_000 },
      fomoStats: { numTrades: 200, totalVolume: 5_000_000 },
      wallets: { solana: { status: "verified", address: SOL_WALLET }, evm: { status: "verified", address: BASE_WALLET } },
      twitter: "https://x.com/alpha",
    });
    if (String(url).includes("four.meme/meme-api/v1/public/address")) return ok({
      code: 0,
      data: [{ name: "TokenManager3", address: FOUR_MANAGER, networkCode: "BSC" }],
    });
    if (String(url) === "https://solana.example/rpc") return ok({ jsonrpc: "2.0", id: 1, result: [] });
    if (url.includes("api.dexscreener.com")) {
      const second = url.toLowerCase().includes(SECOND_BASE_TOKEN);
      return ok({ pairs: [{
      chainId: "base",
      pairAddress: second ? SECOND_BASE_POOL : BASE_POOL,
      dexId: "aerodrome",
      baseToken: { address: second ? SECOND_BASE_TOKEN : BASE_TOKEN },
      liquidity: { usd: 80_000 },
      volume: { m5: 25_000 },
      txns: { m5: { buys: 30, sells: 4 } },
      pairCreatedAt: current - 60_000,
      marketCap: 900_000,
      }] });
    }
    if (url.includes("/v1/leaderboard")) return ok({ leaderboard: [{ handle: "alpha", display_name: "Alpha", followers: 150_000, pnl: 20_000, num_trades: 200, total_volume: 5_000_000, base_address: BASE_WALLET }] });
    if (url.endsWith("/v1/watchlists")) return ok({ watchlists: [{ id: "wl-1", name: "fomo-top-traffic", handles: ["alpha"] }] });
    if (url.includes("/v1/activity/poll")) return ok(stage === 0
      ? { count: 0, latest_at: Math.floor(current / 1_000) }
      : { count: stage === 1 ? 3 : 1, latest_at: Math.floor(current / 1_000) });
    if (url.includes("/v1/activity?")) return ok({ activities: stage === 1 ? [
      activity("buy-1", BASE_TOKEN, "NEW"),
      activity("buy-duplicate-same-token", BASE_TOKEN, "NEW", `0x${"d".repeat(64)}`),
      activity("buy-second-token", SECOND_BASE_TOKEN, "SECOND", `0x${"f".repeat(64)}`),
    ] : [activity("buy-2", BASE_TOKEN, "NEW")] });
    if (url.includes("/positions")) return ok({ positions: [
      { token_mint: BASE_TOKEN, chain: "base", status: "open", buy_count: 1, first_buy_at: Math.floor(current / 1_000) },
      { token_mint: SECOND_BASE_TOKEN, chain: "base", status: "open", buy_count: 1, first_buy_at: Math.floor(current / 1_000) },
    ] });
    if (url.includes("/theses")) return ok({ theses: [{ handle: "alpha", token_mint: BASE_TOKEN, chain: "base", comment: "first thesis", created_at: new Date(current).toISOString(), position: { is_closed: false } }] });
    if (url.includes("/v1/convergence")) return ok({ events: [] });
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createFomoCallMonitor({
    dataDir,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    copeApiKey: "cope_test",
    fomoCallPublicHandles: ["alpha"],
    fomoCallPublicTopLimit: 1,
    fomoCallSolanaRpcUrl: "https://solana.example/rpc",
    fomoCallPollIntervalMs: 12_000,
    fomoCallMinBuyUsd: 1_000,
    fomoCallMinLiquidityUsd: 10_000,
    fomoCallMaxSignalAgeMs: 300_000,
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl,
    baseProvider: {},
    bscProvider: {},
    evmRpcImpl: async () => "0x64",
    assessEvmSecurityImpl: async () => ({ decision: "pass", label: "pass", reasons: [], warnings: [], metrics: { liquidityConfirmed: true } }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
    logger: { error() {} },
  });

  await monitor.check();
  assert.equal(alerts.length, 0, "first poll must only establish a baseline");

  stage = 1;
  current += 12_000;
  const emitted = await monitor.check();
  assert.equal(alerts.length, 2);
  assert.ok(Array.isArray(emitted));
  assert.equal(emitted.length, 2);
  assert.deepEqual(new Set(alerts.map((alert) => alert.token)), new Set([BASE_TOKEN, SECOND_BASE_TOKEN]));
  assert.equal(alerts[0].signalKind, "top_blogger_first_buy");
  assert.equal(alerts[0].caller.trafficRank, 1);
  assert.equal(alerts[0].thesis.text, "first thesis");
  assert.equal(alerts[0].security.metrics.sellObserved, true);
  assert.equal(alerts[0].transactionHash, activityTx);
  assert.equal(alerts[0].transactionUrl, `https://basescan.org/tx/${activityTx}`);
  assert.equal(alerts[0].blockNumber, 123_456);
  assert.equal(alerts[0].walletAddress, BASE_WALLET);
  assert.equal(alerts[0].executionPool, BASE_POOL);
  assert.equal(alerts[0].executionDex, "aerodrome");
  assert.equal(alerts[0].executionPairVerified, false, "the market best pair must not be mislabeled as receipt-verified execution");
  assert.equal(alerts[0].paymentVerification, "authorized_public_api_reported_usd");
  assert.equal(alerts[0].valuationBasis, "source_reported_usd");
  assert.equal(alerts[0].positionProof.source, "cope_capital_positions");
  assert.equal(alerts[0].positionProof.complete, false);
  assert.equal(alerts[0].candidatePoolSize, 1);
  assert.equal(alerts[0].monitoredTopCount, 1);
  assert.equal(alerts[0].coverage.candidatePoolSize, 1);

  stage = 2;
  current += 12_000;
  await monitor.check();
  assert.equal(alerts.length, 2, "same-token candidates in the same and later polls must remain silent");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8"));
  assert.equal(Object.keys(state.alertedTokens).length, 2);
});

test("Fomo call Telegram alert is strong, gated, concise and has copy/GMGN/Fomo actions", () => {
  const event = {
    type: "fomo_family_top_call",
    callId: "call-1",
    signalKind: "top_blogger_first_buy",
    action: "buy",
    qualified: true,
    source: { trust: "authorized_public_api" },
    chain: { id: 8453, name: "Base", gmgn: "base" },
    token: BASE_TOKEN,
    market: { liquidityUsd: 50_000, sellsM5: 1 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    explorerUrl: `https://basescan.org/token/${BASE_TOKEN}`,
    fomoUrl: `https://fomo.family/coin?address=${BASE_TOKEN}&chainId=8453`,
    profileUrl: "https://fomo.family/profile/alpha",
  };
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  const buttons = telegramButtons(event).inline_keyboard.flat();
  assert.equal(buttons.find((button) => button.copy_text)?.copy_text.text, BASE_TOKEN);
  assert.match(buttons.find((button) => button.text.includes("GMGN")).url, /gmgn\.ai\/base\/token/);
  assert.ok(buttons.some((button) => button.text.includes("Fomo")));
  assert.equal(isRelevantAlert({ ...event, source: { id: "fomoscan_onchain", trust: "public_onchain_verified" } }), true);
  assert.equal(isRelevantAlert({
    ...event,
    source: { id: "fomoscan_onchain", trust: "public_onchain_verified" },
    market: { curveVerified: true, liquidityUsd: 0 },
  }), true);
  const publicSolana = {
    ...event,
    source: { id: "fomoscan_onchain", trust: "public_onchain_verified" },
    chain: { id: 1_399_811_149, name: "Solana", slug: "solana", gmgn: "sol" },
    token: SOL_TOKEN,
  };
  assert.equal(isRelevantAlert(publicSolana), false, "a public Solana call cannot bypass exact historical first-position proof");
  assert.equal(isRelevantAlert({
    ...publicSolana,
    positionProof: {
      status: "verified",
      complete: true,
      walletSignerVerified: true,
      outputOwnerVerified: true,
      scope: "wallet_mint_all_token_accounts",
      phase: "immediately_before_transaction",
      source: "historical_owner_state",
      totalWalletPreRaw: "0",
    },
  }), true);
  assert.equal(isRelevantAlert({ ...event, security: { decision: "unknown", metrics: {} } }), false);
});
