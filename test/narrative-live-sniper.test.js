import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyNarrativeHook, extractHotKeywords, hotspotFromPost, tokenMatchesHotspot } from "../src/hot-narrative-record.js";
import { markFastDevRug, rankFastDevs, recordFastDevLaunch } from "../src/fast-dev-registry.js";
import {
  buildNarrativeGmgnBuyPlan,
  createNarrativeLiveRuntime,
  evaluateNarrativeLiveEntry,
  launchFromAlert,
  narrativeLiveClosedTrades,
  narrativeLiveConfig,
  readFastDevDashboard,
  readHotNarrativeDashboard,
  readLiveDecisions,
  usdToRawAmount,
} from "../src/narrative-live-sniper.js";

const WALLET = `0x${"1".repeat(40)}`;
const TOKEN = `0x${"a".repeat(40)}`;
const TOKEN_B = `0x${"d".repeat(40)}`;
const DEV = `0x${"b".repeat(40)}`;
const DEV_SLOW = `0x${"c".repeat(40)}`;
const T0 = Date.parse("2026-11-06T09:00:00Z");

function liveEnv(extra = {}) {
  return {
    NARRATIVE_LIVE_ENABLED: "true",
    LIVE_GMGN_WALLET: WALLET,
    LIVE_CONSECUTIVE_LOSS_PAUSE: "0",
    NARRATIVE_LIVE_PRIORITY_ONLY: "true",
    LIVE_GMGN_STOP_AMEND: "false",
    ...extra,
  };
}

function heyi(at = T0, text = "Which colored pill do you choose?") {
  return {
    author: "heyibinance",
    userId: "1003840309166366721",
    url: "https://x.com/heyibinance/status/2118626855976931477",
    text,
    at,
    observedAt: at,
    isQuote: true,
    isReply: false,
  };
}

function hotspot(at = T0) {
  return hotspotFromPost(heyi(at), at);
}

function pill(at = T0 + 5_000, extra = {}) {
  return {
    chain: "bsc",
    address: TOKEN,
    name: "Colored Pill",
    symbol: "PILL",
    creator: DEV,
    launchedAt: at,
    buyTax: 0,
    sellTax: 0,
    isHoneypot: false,
    securityDecision: "pass",
    quoteUsd: 600,
    quoteDecimals: 18,
    entryPrice: 0.0001,
    ...extra,
  };
}

function decide(extra = {}, env = liveEnv(), nowMs = T0 + 30_000) {
  const spot = extra.hotspot || hotspot();
  const token = extra.token || pill();
  const matched = tokenMatchesHotspot(spot, token);
  return evaluateNarrativeLiveEntry({
    hotspot: spot,
    token,
    matchedKeywords: extra.matchedKeywords || matched,
    nowMs,
    env,
    priorBuys: extra.priorBuys || [],
    closedTrades: extra.closedTrades || [],
    dev: extra.dev || { knownFast: false, rug: false },
  });
}

test("何一 quote and a short CZ reply are priority hooks; keywords keep the pill phrase", () => {
  const words = extractHotKeywords("Which colored pill do you choose?").map((item) => item.text);
  assert.ok(words.includes("colored pill"));
  assert.ok(words.includes("pill"));
  const spot = hotspot();
  assert.equal(spot.priority, true);
  assert.equal(spot.hook, "heyi_quote");
  assert.equal(spot.url, "https://x.com/heyibinance/status/2118626855976931477");
  assert.deepEqual(tokenMatchesHotspot(spot, { name: "Colored Pill", symbol: "PILL" }).includes("colored pill"), true);
  assert.equal(tokenMatchesHotspot(spot, { name: "Doge", symbol: "DOGE" }).length, 0);
  const reply = classifyNarrativeHook({ author: "cz_binance", isReply: true, text: "giggle" });
  assert.equal(reply.priority, true);
  assert.equal(reply.hook, "cz_reply");
  assert.equal(classifyNarrativeHook({ author: "cz_binance", isReply: true, text: "x".repeat(141) }).priority, false);
  assert.equal(classifyNarrativeHook({ author: "elonmusk", isQuote: true, text: "pill" }).hook, "watched_account");
  assert.equal(narrativeLiveConfig({}).enabled, false);
  assert.equal(narrativeLiveConfig({}).priorityOnly, true);
  assert.equal(narrativeLiveConfig({}).sizeUsd, 5);
  assert.equal(narrativeLiveConfig({}).dailyCount, 3);
  assert.equal(narrativeLiveConfig({}).dailyBudgetUsd, 15);
  assert.equal(narrativeLiveConfig({}).windowMs, 600_000);
});

test("the buy window refuses a launch before the post, a late launch, and a late read", () => {
  const open = decide();
  assert.equal(open.allow, true);
  assert.equal(open.decision.liveLadder.stopPriceScale, 0.8);
  assert.equal(open.decision.liveLadder.tp1PriceScale, 1.4);
  const early = decide({ token: pill(T0 - 1_000) });
  assert.equal(early.allow, false);
  assert.equal(early.gate, "window");
  const lateLaunch = decide({ token: pill(T0 + 600_001) }, liveEnv(), T0 + 600_001);
  assert.equal(lateLaunch.allow, false);
  assert.equal(lateLaunch.gate, "window");
  const lateRead = decide({ token: pill(T0 + 5_000) }, liveEnv(), T0 + 600_001);
  assert.equal(lateRead.allow, false);
  assert.equal(lateRead.gate, "window");
});

test("daily count, daily budget, and token dedupe each refuse on their own", () => {
  const buy = (address, atMs, sizeUsd = 5) => ({ kind: "narrative_live_buy", ok: true, submitted: true, chain: "bsc", address, atMs, sizeUsd });
  const counted = decide({
    priorBuys: [buy(TOKEN_B, T0 + 1_000), buy(`0x${"e".repeat(40)}`, T0 + 2_000), buy(`0x${"f".repeat(40)}`, T0 + 3_000)],
  });
  assert.equal(counted.allow, false);
  assert.equal(counted.gate, "daily_count");
  const budget = decide({
    priorBuys: [buy(TOKEN_B, T0 + 1_000, 6), buy(`0x${"e".repeat(40)}`, T0 + 2_000, 6)],
  }, liveEnv({ NARRATIVE_LIVE_DAILY_BUDGET_USD: "12", NARRATIVE_LIVE_DAILY_COUNT: "10" }));
  assert.equal(budget.allow, false);
  assert.equal(budget.gate, "daily_budget");
  const duplicate = decide({ priorBuys: [buy(TOKEN, T0 - 86_400_000)] });
  assert.equal(duplicate.allow, false);
  assert.equal(duplicate.gate, "dedupe");
  const refusedOnly = decide({ priorBuys: [{ kind: "narrative_live_refused", ok: false, submitted: false, chain: "bsc", address: TOKEN, atMs: T0, sizeUsd: 5 }] });
  assert.equal(refusedOnly.allow, true);
});

test("honeypot, tax, missing security, and the consecutive-loss pause stay in front of a buy", () => {
  assert.equal(decide({ token: pill(T0 + 5_000, { isHoneypot: true }) }).gate, "honeypot");
  assert.equal(decide({ token: pill(T0 + 5_000, { buyTax: 0.07 }) }).gate, "tax");
  assert.equal(decide({ token: pill(T0 + 5_000, { securityDecision: null, sellable: false }) }).gate, "security");
  const paused = decide({
    closedTrades: [{ realizedPnl: -1, closedAtMs: 1 }, { realizedPnl: -1, closedAtMs: 2 }, { realizedPnl: -1, closedAtMs: 3 }],
  }, liveEnv({ LIVE_CONSECUTIVE_LOSS_PAUSE: "3" }));
  assert.equal(paused.allow, false);
  assert.equal(paused.gate, "consecutive_loss");
  assert.match(paused.reason, /最近 3 笔已平仓全部亏损/);
  const closes = narrativeLiveClosedTrades([
    { kind: "narrative_live_close", realizedPnl: -2, closedAtMs: 4 },
    { kind: "narrative_live_buy", ok: true },
  ]);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].realizedPnl, -2);
});

test("fast devs rank by median lag, a single launch is not a repeat, and a rug is not a positive signal", () => {
  let registry = { version: 1, wallets: {} };
  const add = (wallet, address, lag) => {
    registry = recordFastDevLaunch(registry, { chain: "bsc", wallet, address, hotspotId: "heyibinance:1", lagSeconds: lag, atMs: T0 + lag * 1000 });
  };
  add(DEV, TOKEN, 8);
  add(DEV, TOKEN, 8);
  assert.equal(rankFastDevs(registry).length, 0);
  add(DEV, TOKEN_B, 12);
  add(DEV_SLOW, `0x${"9".repeat(40)}`, 100);
  add(DEV_SLOW, `0x${"8".repeat(40)}`, 140);
  const ranked = rankFastDevs(registry, { minLaunches: 2, maxMedianSeconds: 180 });
  assert.equal(ranked[0].wallet, DEV);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].medianLagSeconds, 10);
  assert.equal(ranked[0].knownFast, true);
  assert.equal(ranked[1].wallet, DEV_SLOW);
  assert.equal(ranked[1].knownFast, true);
  registry = markFastDevRug(registry, { chain: "bsc", wallet: DEV_SLOW, rug: true });
  const after = rankFastDevs(registry, { minLaunches: 2, maxMedianSeconds: 180 });
  assert.equal(after.some((row) => row.wallet === DEV_SLOW), false);
  assert.equal(after[0].knownFast, true);
});

test("a disabled lane records the match and does not call GMGN", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-live-"));
  const calls = [];
  const runtime = createNarrativeLiveRuntime({
    dataDir: dir,
    now: () => T0 + 30_000,
    env: liveEnv({ NARRATIVE_LIVE_ENABLED: "false" }),
    buyClient: { run(args) { calls.push(args); return { exitCode: 0, stdout: "{}" }; } },
  });
  assert.equal((await runtime.observePost(heyi())).status, "recorded");
  const result = await runtime.observeLaunch(pill());
  assert.equal(result.status, "refused");
  assert.equal(result.gate, "disabled");
  assert.equal(calls.length, 0);
  const rows = await readLiveDecisions(path.join(dir, "live-decisions.jsonl"));
  assert.equal(rows.at(-1).kind, "narrative_live_refused");
  assert.equal(rows.at(-1).ok, false);
  assert.equal(rows.at(-1).chain, "bsc");
  assert.equal(rows.at(-1).address, TOKEN);
  const hot = await readHotNarrativeDashboard(dir);
  assert.equal(hot.execution, false);
  assert.equal(hot.hotspots[0].matches.length, 1);
  assert.equal(hot.hotspots[0].matches[0].lagSeconds, 5);
  await runtime.stop();
});

test("an armed buy is deduped, keeps the ladder, and ranks the dev that repeated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-live-"));
  const calls = [];
  const stops = [];
  let clock = T0 + 20_000;
  const runtime = createNarrativeLiveRuntime({
    dataDir: dir,
    now: () => clock,
    env: liveEnv({ NARRATIVE_LIVE_DAILY_COUNT: "10", NARRATIVE_LIVE_BLOCK_RUG_DEVS: "true", NARRATIVE_LIVE_RUG_WALLETS: DEV_SLOW, LIVE_GMGN_STOP_AMEND: "true" }),
    buyClient: { run(args) { calls.push(args); return { exitCode: 0, stdout: JSON.stringify({ code: 0, data: { order_id: `buy-${calls.length}` } }) }; } },
    stopClient: { run(args) { stops.push(args); return { exitCode: 0, stdout: JSON.stringify({ code: 0, data: { order_id: "stop-1" } }) }; } },
  });
  await runtime.observePost(heyi());
  const first = await runtime.observeLaunch(pill(T0 + 5_000));
  assert.equal(first.status, "bought");
  assert.equal(first.decision.ok, true);
  assert.equal(first.decision.kind, "narrative_live_buy");
  assert.equal(first.decision.orderId, "buy-1");
  assert.equal(first.decision.liveLadder.stopPriceScale, 0.8);
  assert.equal(first.decision.stop.ok, true);
  assert.equal(first.decision.fastDev, null);
  assert.ok(calls[0].includes("swap"));
  assert.ok(calls[0].includes(TOKEN));
  assert.equal(calls[0].includes(process.env.GMGN_PRIVATE_KEY || "no-such-secret"), false);
  assert.match(JSON.stringify(calls[0]), /--amount/);
  assert.ok(stops[0].includes("stop_loss"));
  const again = await runtime.observeLaunch(pill(T0 + 6_000));
  assert.equal(again.gate, "dedupe");
  assert.equal(calls.length, 1);
  clock = T0 + 40_000;
  const second = await runtime.observeLaunch(pill(T0 + 8_000, { address: TOKEN_B }));
  assert.equal(second.status, "bought");
  assert.equal(second.decision.fastDev.wallet, DEV);
  assert.equal(second.decision.fastDev.rank, 1);
  assert.equal(second.decision.fastDev.count, 2);
  const board = await readFastDevDashboard(dir, liveEnv());
  assert.equal(board.execution, false);
  assert.equal(board.ranked[0].wallet, DEV);
  assert.equal(board.ranked[0].medianLagSeconds, 6.5);
  const rug = await runtime.observeLaunch(pill(T0 + 9_000, { address: `0x${"e".repeat(40)}`, creator: DEV_SLOW }));
  assert.equal(rug.gate, "rug_dev");
  const rows = await readLiveDecisions(runtime.decisionFile);
  assert.ok(rows.some((row) => row.kind === "narrative_live_buy" && row.ok === true && row.address === TOKEN));
  assert.ok(rows.some((row) => row.kind === "narrative_live_refused" && row.gate === "dedupe"));
  await runtime.stop();
});

test("non-priority posts stay recorded but do not buy while priority-only is on", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-live-"));
  const calls = [];
  const runtime = createNarrativeLiveRuntime({
    dataDir: dir,
    now: () => T0 + 10_000,
    env: liveEnv(),
    buyClient: { run() { calls.push(1); return { exitCode: 0, stdout: "{}" }; } },
  });
  const post = {
    author: "elonmusk",
    url: "https://x.com/elonmusk/status/2118626855976931477",
    text: "Which colored pill do you choose?",
    at: T0,
    observedAt: T0,
    isQuote: false,
    isReply: false,
  };
  assert.equal((await runtime.observePost(post)).hotspot.priority, false);
  const result = await runtime.observeLaunch(pill());
  assert.equal(result.gate, "priority_source");
  assert.equal(calls.length, 0);
  await runtime.stop();
});

test("quote USD converts to a raw GMGN amount and the plan never carries a key", () => {
  const raw = usdToRawAmount(5, 600, 18);
  assert.equal(raw, "8333333333333333");
  const plan = buildNarrativeGmgnBuyPlan({
    chain: "sol",
    wallet: "1".repeat(32),
    inputToken: "So11111111111111111111111111111111111111112",
    outputToken: "2".repeat(32),
    amountRaw: raw,
    slippagePercent: 10,
    env: { GMGN_PRIVATE_KEY: "super-secret", LIVE_GMGN_PRIORITY_FEE: "0.00001", LIVE_GMGN_TIP_FEE: "0.00001" },
  });
  assert.equal(plan.errors.length, 0);
  assert.ok(plan.args.includes("--priority-fee"));
  assert.equal(JSON.stringify(plan).includes("super-secret"), false);
  assert.equal(launchFromAlert({ type: "twitter_post", text: "pill" }), null);
  const launch = launchFromAlert({
    type: "bsc_launchpad_update",
    chainId: 56,
    blockTimestamp: T0 / 1000,
    creator: DEV,
    tokens: [{ token: TOKEN, name: "Colored Pill", symbol: "PILL" }],
  });
  assert.equal(launch.chain, "bsc");
  assert.equal(launch.address, TOKEN);
  assert.equal(launch.launchedAt, T0);
});
