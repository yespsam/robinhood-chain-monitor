import test from "node:test";
import assert from "node:assert/strict";
import { loadLiveConfig, chainCfg, checkGates, buildSwapArgs, createLiveTrader, cleanCliError, tryParseJson, extractOrderId, extractApiError, submitAndConfirm } from "../src/live-gmgn-trader.js";
import { createLiveMirror, newConfirmedBuys } from "../src/live-gmgn-mirror.js";

const W = "0x" + "1".repeat(40);
const order = { source: "paper-atm-confirmed-pvp-v2", usd: 10, token: "0x" + "a".repeat(40), bnbPriceUsd: 700 };
const base = (o = {}) => ({ ...loadLiveConfig({ LIVE_PRESUBMIT_QUOTE: "false", LIVE_REQUIRE_EVIDENCE: "false", LIVE_CLOSE_SYNC_MS: "0", LIVE_TRADING_ENABLED: "true", LIVE_WALLET: W, LIVE_AUTO_SLIPPAGE: "true" }, "/nonexistent"), ...o });
const empty = { positions: [], realized: {} };
const nofs = { existsSync: () => false };

test("disabled by default", () => {
  assert.match(checkGates(loadLiveConfig({ LIVE_WALLET: W }), order, empty, { fsx: nofs }).reason, /not true/);
});

test("gates allow valid order", () => {
  assert.equal(checkGates(base(), order, { ...empty, balanceUsd: 1000, balanceBnb: 1 }, { fsx: nofs }).ok, true);
});

test("swap args use --auto-slippage by default (percent path, not fraction)", () => {
  const a = buildSwapArgs(base(), order);
  assert.ok(a.includes("--auto-slippage"));
  assert.ok(!a.includes("--slippage"));
  assert.ok(a.includes("--yes"));
  assert.ok(a.includes("--raw"));
  assert.ok(a.includes("--anti-mev"));
  assert.ok(a.includes("--condition-orders"));
});

test("swap args use percent slippage 10-30 when auto off", () => {
  const a = buildSwapArgs(base({ autoSlippage: false, maxSlippage: 30 }), { ...order, slippage: 30 });
  assert.equal(a[a.indexOf("--slippage") + 1], "30");
  assert.ok(!a.includes("--auto-slippage"));
});

test("SOL condition-order swaps include the required priority and tip fees", () => {
  const cfg = chainCfg(loadLiveConfig({
    LIVE_TRADING_ENABLED: "true",
    LIVE_SOL_WALLET: "So11111111111111111111111111111111111111112",
    LIVE_SOL_PRIORITY_FEE: "0.0001",
    LIVE_SOL_TIP_FEE: "0.00001",
  }, "/nonexistent"), "sol");
  const args = buildSwapArgs(cfg, {
    source: "paper-atm-confirmed-pvp-v2",
    chain: "sol",
    usd: 10,
    solPriceUsd: 200,
    token: "So11111111111111111111111111111111111111112",
  });
  assert.equal(args[args.indexOf("--priority-fee") + 1], "0.0001");
  assert.equal(args[args.indexOf("--tip-fee") + 1], "0.00001");
  assert.ok(args.includes("--condition-orders"));
  assert.ok(!args.includes("--gas-price"));
});

test("cleanCliError strips confirmation banner and keeps AUTH_IP_BLOCKED", () => {
  const stderr = `\n⚠️  Swap — confirmation required\n--------------------------------\n  Chain:        bsc\n  Wallet:       ${W}\n  Amount:       1\n  Slippage:     auto\n[gmgn-cli] Proceeding non-interactively (--yes + GMGN_ALLOW_AUTOMATED_TRADES=1).\n[gmgn-cli] POST /v1/trade/swap failed: HTTP 403 code=403 error=AUTH_IP_BLOCKED message=source ip blocked 103.26.164.82\n`;
  const msg = cleanCliError(stderr, "", { message: "x" });
  assert.match(msg, /AUTH_IP_BLOCKED/);
  assert.doesNotMatch(msg, /confirmation required/);
});

test("extractOrderId / api error from raw json", () => {
  assert.equal(extractOrderId({ order_id: "abc" }), "abc");
  assert.match(extractApiError({ code: 403, error: "AUTH_IP_BLOCKED" }), /403/);
  assert.deepEqual(tryParseJson('{"order_id":"x","status":"pending"}').order_id, "x");
});

test("submitAndConfirm polls until confirmed", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args[0]);
    if (args[0] === "swap") return { stdout: '{"order_id":"oid1","status":"pending"}', stderr: "", raw: { order_id: "oid1", status: "pending" }, orderId: "oid1" };
    return { stdout: '{"order_id":"oid1","status":"confirmed"}', stderr: "", raw: { order_id: "oid1", status: "confirmed" }, orderId: "oid1" };
  };
  const out = await submitAndConfirm(base({ orderPollMs: 1, orderPollMax: 5 }), order, { run, wait: async () => {} });
  assert.equal(out.orderId, "oid1");
  assert.equal(out.status, "confirmed");
  assert.ok(calls.includes("swap") && calls.includes("order"));
});

test("disabled trader never runs cli", async () => {
  let ran = false;
  const t = createLiveTrader(loadLiveConfig({ LIVE_WALLET: W }), { run: () => { ran = true; }, log: { warn() {} } });
  assert.equal((await t.buy(order)).ok, false); assert.equal(ran, false);
});

const acct = { trades: [{ side: "buy", chain: "bsc", address: "0x" + "2".repeat(40), costBasisUsd: 25 }] };
const sess = { id: "confirmed-pvp-v2-estimated-20260928" };
function promotableAccount(current = acct.trades[0]) {
  const trades = [];
  for (let i = 0; i < 30; i += 1) {
    const address = `0x${i.toString(16).padStart(40, "0")}`;
    trades.push({ side: "buy", chain: "bsc", address, quantity: 1, atMs: i * 2,
      entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd: 1 }, liveEntryGate: { allow: true } } });
    trades.push({ side: "sell", chain: "bsc", address, quantity: 1, realizedPnl: i % 2 ? 0.5 : 2, atMs: i * 2 + 1 });
  }
  return { account: { trades: [...trades, current] }, beforeCount: trades.length };
}

test("mirror disabled → no CLI, no balance read", async () => {
  let ran = 0;
  const m = createLiveMirror({ cfg: loadLiveConfig({ LIVE_WALLET: W }), readBalance: () => { ran++; }, trader: { buy: () => { ran++; } } });
  assert.deepEqual(await m(0, acct, sess), []); assert.equal(ran, 0);
});

test("mirror ignores non-confirmed sessions (e.g. narrative)", () => {
  assert.deepEqual(newConfirmedBuys(0, acct, { id: "narrative-shadow" }), []);
});

test("enabled mock → CLI invoked with auto-slippage, capped to $10, polls order", async () => {
  let args;
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "lg-"));
  const cfg = { ...loadLiveConfig({ LIVE_PRESUBMIT_QUOTE: "false", LIVE_REQUIRE_EVIDENCE: "false", LIVE_CLOSE_SYNC_MS: "0", LIVE_TRADING_ENABLED: "true", LIVE_WALLET: W }, dir), orderPollMs: 1, orderPollMax: 3 };
  const run = async (a) => {
    if (a[0] === "swap") { args = a; return { stdout: '{"order_id":"o1","status":"pending"}', stderr: "", raw: { order_id: "o1", status: "pending" }, orderId: "o1" }; }
    return { stdout: '{"order_id":"o1","status":"confirmed"}', stderr: "", raw: { order_id: "o1", status: "confirmed" }, orderId: "o1" };
  };
  const trader = createLiveTrader(cfg, { run, log: { warn() {}, info() {} }, wait: async () => {} });
  const { account, beforeCount } = promotableAccount();
  const [r] = await createLiveMirror({ cfg, env: {}, trader, readBalance: async () => 100, readPrice: async () => 700 })(beforeCount, account, sess);
  assert.equal(r.ok, true);
  assert.equal(args[args.indexOf("--output-token") + 1], account.trades[beforeCount].address);
  assert.ok(args.includes("--auto-slippage"));
  assert.ok(args.includes("--anti-mev"));
  assert.match(args[args.indexOf("--condition-orders") + 1], /loss_stop/);
});
test("mirror blocks an insufficient paper promotion sample before balance reads or order submission", async () => {
  let balanceReads = 0, traderCalls = 0;
  const cfg = { ...loadLiveConfig({ LIVE_PRESUBMIT_QUOTE: "false", LIVE_REQUIRE_EVIDENCE: "false", LIVE_CLOSE_SYNC_MS: "0", LIVE_TRADING_ENABLED: "true", LIVE_WALLET: W }, "/nonexistent"), closeSyncMs: 0 };
  const result = await createLiveMirror({ cfg, env: {}, trader: { buy: async () => { traderCalls++; return { ok: true }; } },
    readBalance: async () => { balanceReads++; return 100; }, readPrice: async () => 700 })(0, acct, sess);
  assert.equal(traderCalls, 0);
  assert.equal(balanceReads, 0);
  assert.match(result[0].reason, /已平仓 0 笔，少于 30/);
});

test("enabled, wrong source / zero balance → refuse", async () => {
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "lg-"));
  const t = createLiveTrader(loadLiveConfig({ LIVE_PRESUBMIT_QUOTE: "false", LIVE_REQUIRE_EVIDENCE: "false", LIVE_CLOSE_SYNC_MS: "0", LIVE_TRADING_ENABLED: "true", LIVE_WALLET: W }, dir), { run: () => { throw new Error("ran"); }, log: { warn() {} } });
  assert.equal((await t.buy({ ...order, source: "x" })).ok, false);
  assert.equal((await t.buy(order, { balanceUsd: 0 })).ok, false);
  assert.equal((await t.buy({ ...order, source: "narrative-sniper" })).ok, false);
});
