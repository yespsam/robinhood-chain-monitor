import test from "node:test";
import assert from "node:assert/strict";
import { loadLiveConfig, checkGates, buildSwapArgs, createLiveTrader, crossChainTopUp, submitAndConfirm, BSC_NATIVE_BNB } from "../src/live-gmgn-trader.js";
const W = "0x2938b003b1e3c2f95ae73046730b91f3af22f828";
const base = (o = {}) => ({ ...loadLiveConfig({ LIVE_PRESUBMIT_QUOTE: "false", LIVE_REQUIRE_EVIDENCE: "false", LIVE_CLOSE_SYNC_MS: "0", LIVE_TRADING_ENABLED: "true", LIVE_WALLET: W }, "/nonexistent"), ...o });
const nofs = { existsSync: () => false };
const order = { source: "paper-atm-confirmed-pvp-v2", usd: 10, token: "0x" + "1".repeat(40), bnbPriceUsd: 500 };
const empty = { positions: [], realized: {} };
const okEmpty = { ...empty, balanceUsd: 1000 };
test("disabled by default", () => {
  assert.equal(loadLiveConfig({}).enabled, false);
  assert.match(checkGates(loadLiveConfig({ LIVE_WALLET: W }), order, empty, { fsx: nofs }).reason, /not true/);
});
test("passes when all ok", () => assert.equal(checkGates(base(), order, okEmpty, { fsx: nofs }).ok, true));
test("kill switch", () => assert.match(checkGates(base(), order, empty, { fsx: { existsSync: () => true } }).reason, /kill/));
test("max per trade", () => assert.match(checkGates(base(), { ...order, usd: 10.01 }, empty, { fsx: nofs }).reason, /PER_TRADE/));
test("max total", () => {
  const st = { positions: Array(4).fill({ status: "open", usd: 23 }), realized: {} };
  assert.match(checkGates(base(), order, st, { fsx: nofs }).reason, /TOTAL/);
});
test("max open positions", () => {
  const st = { positions: Array(5).fill({ status: "open", usd: 1 }), realized: {} };
  assert.match(checkGates(base(), order, st, { fsx: nofs }).reason, /open positions/);
});
test("daily loss stop", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  assert.match(checkGates(base(), order, { positions: [], realized: { "2026-11-01": -30 } }, { fsx: nofs, now }).reason, /daily loss/);
});
test("balance and narrative refused", () => {
  assert.match(checkGates(base(), order, { ...empty, balanceUsd: 5 }, { fsx: nofs }).reason, /balance/);
  assert.equal(checkGates(base(), { ...order, source: "narrative-sniper" }, empty, { fsx: nofs }).ok, false);
});
test("swap args include anti-mev and TP/SL", () => {
  const a = buildSwapArgs(base(), order);
  assert.ok(a.includes("--anti-mev")); assert.ok(a.includes("--condition-orders"));
  assert.equal(a[a.indexOf("--amount") + 1], "20000000000000000"); // $10 @ $500 = 0.02 BNB
  assert.equal(a[a.indexOf("--input-token") + 1], BSC_NATIVE_BNB);
});
test("usdt mode still supported", () => {
  const a = buildSwapArgs(base({ spendAsset: "usdt" }), order);
  assert.equal(a[a.indexOf("--amount") + 1], "10000000000000000000");
});
test("gas reserve enforced and price required", () => {
  assert.match(checkGates(base(), order, { ...okEmpty, balanceBnb: 0.035 }, { fsx: nofs }).reason, /gas reserve/);
  assert.equal(checkGates(base(), order, { ...okEmpty, balanceBnb: 0.041 }, { fsx: nofs }).ok, true);
  assert.match(checkGates(base(), { ...order, bnbPriceUsd: undefined }, okEmpty, { fsx: nofs }).reason, /price/);
});
test("cross-chain stub never moves funds", async () => {
  assert.equal((await crossChainTopUp(base({ crossChainEnabled: true }), { toChain: "sol", usd: 10 }, { fsx: nofs })).ok, false);
  assert.match((await crossChainTopUp(loadLiveConfig({}), { usd: 10 })).reason, /not true/);
});
test("disabled trader never runs cli", async () => {
  let ran = false;
  const t = createLiveTrader(loadLiveConfig({ LIVE_WALLET: W }), { run: () => { ran = true; }, log: { warn() {} } });
  assert.equal((await t.buy(order)).ok, false); assert.equal(ran, false);
});
import { createLiveMirror, newConfirmedBuys } from "../src/live-gmgn-mirror.js";
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
test("enabled mock → CLI invoked with expected args, capped to $10", async () => {
  let args;
  const cfg = tmpCfg();
  const { account, beforeCount } = promotableAccount();
  const trader = createLiveTrader(cfg, { run: async (a) => { if (a[0] === "order") return { raw: { status: "confirmed" } }; args = a; return { raw: { order_id: "o1", status: "pending" } }; }, wait: async () => {}, log: { warn() {}, info() {} } });
  const [r] = await createLiveMirror({ cfg, env: {}, trader, readBalance: async () => 0.2, readPrice: async () => 500 })(beforeCount, account, sess);
  assert.equal(r.ok, true);
  assert.equal(args[args.indexOf("--output-token") + 1], account.trades[beforeCount].address);
  assert.equal(args[args.indexOf("--amount") + 1], "20000000000000000");
  assert.ok(args.includes("--anti-mev"));
  assert.match(args[args.indexOf("--condition-orders") + 1], /loss_stop/);
});
test("mirror refuses a new buy before balance reads when the paper promotion sample is insufficient", async () => {
  let balanceReads = 0, traderCalls = 0;
  const cfg = { ...tmpCfg(), requireEvidence: false, closeSyncMs: 0 };
  const result = await createLiveMirror({ cfg, env: {}, trader: { buy: async () => { traderCalls++; return { ok: true }; } },
    readBalance: async () => { balanceReads++; return 100; }, readPrice: async () => 500 })(0, acct, sess);
  assert.equal(traderCalls, 0);
  assert.equal(balanceReads, 0);
  assert.match(result[0].reason, /已平仓 0 笔，少于 30/);
});
test("enabled, wrong source / zero balance → refuse", async () => {
  const t = createLiveTrader(tmpCfg(), { run: () => { throw new Error("ran"); }, log: { warn() {} } });
  assert.equal((await t.buy({ ...order, source: "x" })).ok, false);
  assert.equal((await t.buy(order, { balanceUsd: 0 })).ok, false);
  assert.equal((await t.buy({ ...order, source: "narrative-sniper" })).ok, false);
});

test("slippage: auto by default, else percent clamped 10..30", () => {
  const o = { ...order };
  assert.ok(buildSwapArgs(base(), o).includes("--auto-slippage"));
  const a = buildSwapArgs(base({ autoSlippage: false }), { ...o, slippage: 0.01 });
  assert.ok(!a.includes("--auto-slippage"));
  assert.equal(a[a.indexOf("--slippage") + 1], "10");
  const b = buildSwapArgs(base({ autoSlippage: false }), { ...o, slippage: 99 });
  assert.equal(b[b.indexOf("--slippage") + 1], "30");
});
test("submitAndConfirm polls order get until confirmed", async () => {
  const calls = []; const seq = ["pending", "confirmed"];
  const run = async (a) => { calls.push(a); return a[0] === "order" ? { raw: { status: seq.shift() } } : { raw: { order_id: "x9" } }; };
  const r = await submitAndConfirm(base({ orderPollMax: 5 }), order, { run, wait: async () => {}, log: {} });
  assert.equal(r.orderId, "x9"); assert.equal(r.status, "confirmed");
  assert.equal(calls.filter(c => c[0] === "order").length, 2);
  assert.deepEqual(calls[1].slice(0, 2), ["order", "get"]);
});
test("submitAndConfirm surfaces failed status and missing order_id", async () => {
  const run = async (a) => a[0] === "order" ? { raw: { status: "failed", error_status: "slippage" } } : { raw: { order_id: "f1" } };
  await assert.rejects(submitAndConfirm(base(), order, { run, wait: async () => {}, log: {} }), /f1 failed.*slippage/);
  await assert.rejects(submitAndConfirm(base(), order, { run: async () => ({ raw: {}, stderr: "AUTH_IP_BLOCKED source ip blocked 1.2.3.4" }), wait: async () => {}, log: {} }), /no order_id.*AUTH_IP_BLOCKED/);
});
test("runCli source sets GMGN_ALLOW_AUTOMATED_TRADES=1 for child", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/live-gmgn-trader.js", import.meta.url), "utf8");
  assert.match(src, /GMGN_ALLOW_AUTOMATED_TRADES:\s*"1"/);
});
test("sol swap args include priority-fee and tip-fee with condition-orders", () => {
  const a = buildSwapArgs(base({ chain: "sol", spendAsset: "sol", wallet: "So1Wa11et111111111111111111111111111111111" }), { ...order, token: "BngAfLZxaWN2QvpFhRbUHydYGr8zA7YTSA178G8Epump", solPriceUsd: 100 });
  assert.ok(a.includes("--condition-orders"));
  assert.ok(Number(a[a.indexOf("--priority-fee") + 1]) > 0);
  assert.ok(a.includes("--tip-fee"));
  assert.ok(Number(a[a.indexOf("--tip-fee") + 1]) >= 0.00001);
  assert.ok(!a.includes("--gas-price"));
});

// ---- C1/C2/H4/H5 regression: concurrency, state machine, corrupt ledger, reconcile ----
import fsReal from "node:fs";
import os from "node:os";
import pathMod from "node:path";
const tmpCfg = (o = {}) => {
  const dir = fsReal.mkdtempSync(pathMod.join(os.tmpdir(), "live-gmgn-"));
  return { ...loadLiveConfig({ LIVE_PRESUBMIT_QUOTE: "false", LIVE_REQUIRE_EVIDENCE: "false", LIVE_CLOSE_SYNC_MS: "0", LIVE_TRADING_ENABLED: "true", LIVE_WALLET: W, LIVE_ORDER_POLL_MAX: "3" }, dir), ...o, _dir: dir };
};
const okBal = { balanceUsd: 1000, balanceBnb: 10 };
const quiet = { warn() {}, info() {}, error() {} };
const ledgerOf = (cfg) => JSON.parse(fsReal.readFileSync(cfg.ledgerPath, "utf8"));
test("C1: concurrent buys with maxOpen=1 submit only ONE order and ledger keeps it", async () => {
  const cfg = tmpCfg({ maxOpenPositions: 1, maxTotalUsd: 10 });
  let submits = 0;
  const run = async (a) => { if (a[0] === "swap") { submits++; await new Promise((r) => setTimeout(r, 20)); return { raw: { order_id: `o${submits}` } }; } return { raw: { status: "confirmed" } }; };
  const t = createLiveTrader(cfg, { run, wait: async () => {}, log: quiet });
  const rs = await Promise.all([t.buy(order, okBal), t.buy({ ...order, token: "0x" + "3".repeat(40) }, okBal)]);
  assert.equal(submits, 1);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.match(rs.find((r) => !r.ok).reason, /max open positions|TOTAL/);
  assert.equal(ledgerOf(cfg).positions.filter((p) => p.status === "open").length, 1);
});
test("C1: two trader instances (cross-process style) on same ledger still respect caps", async () => {
  const cfg = tmpCfg({ maxOpenPositions: 1 });
  let submits = 0;
  const run = async (a) => { if (a[0] === "swap") { submits++; await new Promise((r) => setTimeout(r, 30)); return { raw: { order_id: `o${submits}`, status: "confirmed" } }; } return { raw: { status: "confirmed" } }; };
  const a = createLiveTrader(cfg, { run, log: quiet }), b = createLiveTrader(cfg, { run, log: quiet });
  await Promise.all([a.buy(order, okBal), b.buy(order, okBal)]);
  assert.equal(submits, 1);
});
test("C2: reservation persisted BEFORE submit (submitting state on disk)", async () => {
  const cfg = tmpCfg();
  let seen;
  const run = async (a) => { if (a[0] === "swap") { seen = ledgerOf(cfg).positions[0]?.status; return { raw: { order_id: "z1", status: "confirmed" } }; } };
  await createLiveTrader(cfg, { run, log: quiet }).buy(order, okBal);
  assert.equal(seen, "submitting");
  assert.equal(ledgerOf(cfg).positions[0].status, "open");
});
test("C2: poll timeout => uncertain, reserved, blocks new buys; reconcile resolves to open", async () => {
  const cfg = tmpCfg({ orderPollMax: 2 });
  let gmgn = "pending";
  const run = async (a) => a[0] === "swap" ? { raw: { order_id: "u1" } } : { raw: { status: gmgn } };
  const t = createLiveTrader(cfg, { run, wait: async () => {}, log: quiet });
  await assert.rejects(t.buy(order, okBal), /timeout/);
  assert.equal(ledgerOf(cfg).positions[0].status, "uncertain");
  assert.equal(ledgerOf(cfg).positions[0].orderId, "u1");
  let submits = 0;
  const t2 = createLiveTrader(cfg, { run: async (a) => { if (a[0] === "swap") submits++; return run(a); }, wait: async () => {}, log: quiet });
  const r = await t2.buy(order, okBal);
  assert.equal(r.ok, false); assert.match(r.reason, /unresolved/); assert.equal(submits, 0);
  gmgn = "confirmed";
  assert.deepEqual(await t2.reconcile(), []);
  assert.equal(ledgerOf(cfg).positions[0].status, "open");
});
test("C2: network error on submit => uncertain; HTTP 4xx => failed (not reserved)", async () => {
  const cfg = tmpCfg();
  const t = createLiveTrader(cfg, { run: async () => { throw new Error("socket hang up"); }, log: quiet });
  await assert.rejects(t.buy(order, okBal));
  assert.equal(ledgerOf(cfg).positions[0].status, "uncertain");
  const cfg2 = tmpCfg();
  const t2 = createLiveTrader(cfg2, { run: async () => { throw new Error("POST /v1/trade/swap failed: HTTP 400 code=400"); }, log: quiet });
  await assert.rejects(t2.buy(order, okBal));
  assert.equal(ledgerOf(cfg2).positions[0].status, "failed");
  await assert.rejects(t2.buy(order, okBal), /HTTP 400/); // failed order does not block: retried submit, not "unresolved"
});
test("C2: corrupt ledger refuses (never treated as flat) and runs no CLI", async () => {
  const cfg = tmpCfg();
  fsReal.writeFileSync(cfg.ledgerPath, "{not json");
  let ran = false;
  const r = await createLiveTrader(cfg, { run: () => { ran = true; }, log: quiet }).buy(order, okBal);
  assert.equal(r.ok, false); assert.match(r.reason, /corrupt/); assert.equal(ran, false);
});
test("C2: orphan 'submitting' (crash) becomes uncertain and blocks", async () => {
  const cfg = tmpCfg();
  fsReal.writeFileSync(cfg.ledgerPath, JSON.stringify({ positions: [{ id: "x", status: "submitting", usd: 10, token: "t" }], realized: {} }));
  let ran = 0;
  const r = await createLiveTrader(cfg, { run: () => { ran++; }, log: quiet }).buy(order, okBal);
  assert.equal(r.ok, false); assert.equal(ran, 0);
  assert.equal(ledgerOf(cfg).positions[0].status, "uncertain");
});
test("H5: confirmed on the LAST allowed poll is a success, not a timeout", async () => {
  const run = async (a) => a[0] === "order" ? { raw: { status: "confirmed" } } : { raw: { order_id: "L1" } };
  const r = await submitAndConfirm(base({ orderPollMax: 1 }), order, { run, wait: async () => {}, log: {} });
  assert.equal(r.status, "confirmed");
});
test("H4: NaN / missing balance refused", () => {
  assert.match(checkGates(base(), order, { ...empty, balanceUsd: NaN }, { fsx: nofs }).reason, /balance unavailable/);
  assert.match(checkGates(base(), order, empty, { fsx: nofs }).reason, /balance unavailable/);
  assert.match(checkGates(base(), order, { ...empty, balanceUsd: 100, balanceBnb: NaN }, { fsx: nofs }).reason, /BNB balance invalid/);
});
test("H4: stale signal refused", () => {
  const now = Date.now();
  assert.match(checkGates(base(), { ...order, signalAt: now - 120_000 }, okEmpty, { fsx: nofs, now }).reason, /stale/);
  assert.equal(checkGates(base(), { ...order, signalAt: now - 5_000 }, okEmpty, { fsx: nofs, now }).ok, true);
});
test("H1: closePosition frees the slot and books realized loss into daily stop", async () => {
  const cfg = tmpCfg({ maxOpenPositions: 1, dailyLossStopUsd: 5 });
  const run = async () => ({ raw: { order_id: "c1", status: "confirmed" } });
  const t = createLiveTrader(cfg, { run, log: quiet });
  const r = await t.buy(order, okBal);
  assert.equal(r.ok, true);
  assert.equal((await t.closePosition({ id: r.positionId, proceedsUsd: 4 })).pnl, -6);
  const r2 = await t.buy(order, okBal);
  assert.match(r2.reason, /daily loss/);
});
test("H2: live strategy allowlist separate from paper permission; narrative session refused", () => {
  const c = base({ strategyAllowlist: ["confirmed_pvp"] });
  assert.match(checkGates(c, { ...order, paperStrategyId: "other" }, okEmpty, { fsx: nofs }).reason, /ALLOWLIST/);
  assert.equal(checkGates(c, { ...order, paperStrategyId: "confirmed_pvp" }, okEmpty, { fsx: nofs }).ok, true);
  assert.match(checkGates(base(), { ...order, paperSessionId: "narrative-x" }, okEmpty, { fsx: nofs }).reason, /narrative/);
});
test("sol tip fee validated", () => {
  const c = base({ chain: "sol", spendAsset: "sol", wallet: "So1Wa11et111111111111111111111111111111111", chains: ["sol"], solTipFee: "0" });
  assert.match(checkGates(c, { ...order, solPriceUsd: 100 }, okEmpty, { fsx: nofs }).reason, /tip/);
});

// ---- H1 / H2 / H4 round 2 ----
import { checkLiveEvidence, preSubmitQuote, strategyPnl } from "../src/live-gmgn-trader.js";
const goodEv = (now) => ({ paperEligible: true, priceFresh: true, marketFresh: true, priceObservedAt: new Date(now - 5000).toISOString(), entryPlan: { eligible: true },
  safety: { missing: [], blocked: [], auditMissing: [], policyVersion: "collective_source_checks_v1", sellabilityVerified: true, metrics: { buyTax: 0.02, sellTax: 0.02 }, taxFilter: { blocked: false } } });
test("H2: live evidence gate passes strict evidence, refuses paper-only relaxations", () => {
  const now = Date.now(), c = base();
  assert.equal(checkLiveEvidence(c, goodEv(now), { now }).ok, true);
  const bad = (f) => { const e = goodEv(now); f(e); return checkLiveEvidence(c, e, { now }).reason; };
  assert.match(bad((e) => { e.safety.auditMissing = ["LP 锁定"]; }), /audit missing/);
  assert.match(bad((e) => { e.safety.policyVersion = "monitored_paper_unknown_audit_v1"; }), /relaxed/);
  assert.match(bad((e) => { e.safety.sellabilityVerified = false; }), /sellability/);
  assert.match(bad((e) => { e.safety.metrics.sellTax = 0.1; }), /sellTax/);
  assert.match(bad((e) => { delete e.safety.metrics.buyTax; }), /buyTax unknown/);
  assert.match(bad((e) => { e.priceObservedAt = new Date(now - 600_000).toISOString(); }), /too old/);
  assert.match(checkLiveEvidence(c, undefined).reason, /no paper/);
});
test("H2: mirror refuses trade lacking live evidence without calling trader", async () => {
  let called = 0;
  const cfg = { ...base(), requireEvidence: true, closeSyncMs: 0 };
  const { account, beforeCount } = promotableAccount();
  const r = await createLiveMirror({ cfg, env: {}, trader: { buy: async () => { called++; return { ok: true }; } }, readBalance: async () => 1, readPrice: async () => 500 })(beforeCount, account, sess);
  assert.equal(called, 0); assert.match(r[0].reason, /evidence/);
});
const quoteRun = (q) => async (a) => (a[1] === "quote" ? { raw: q } : a[0] === "swap" ? { raw: { order_id: "q1", status: "confirmed" } } : { raw: { list: [] } });
test("H4: pre-submit quote refuses failure / empty / heavy loss / price chase; passes good quote", async () => {
  const c = base();
  assert.equal((await preSubmitQuote(c, order, { run: async () => { throw new Error("timeout"); } })).ok, false);
  assert.match((await preSubmitQuote(c, order, { run: quoteRun({}) })).reason, /no output/);
  assert.match((await preSubmitQuote(c, order, { run: quoteRun({ output_amount: "5", amount_in_usd: "10", amount_out_usd: "6" }) })).reason, /loss/);
  assert.match((await preSubmitQuote(c, { ...order, paperPrice: 1 }, { run: quoteRun({ output_amount: "5", amount_in_usd: "10", amount_out_usd: "9.8", token_out_usd_price: "2" }) })).reason, /above paper/);
  assert.equal((await preSubmitQuote(c, { ...order, paperPrice: 1 }, { run: quoteRun({ output_amount: "5", amount_in_usd: "10", amount_out_usd: "9.8", token_out_usd_price: "1.1" }) })).ok, true);
});
test("H4: trader with preSubmitQuote refuses on bad quote and never submits", async () => {
  const cfg = tmpCfg({ preSubmitQuote: true });
  let swaps = 0;
  const run = async (a) => { if (a[0] === "swap") swaps++; return a[1] === "quote" ? { raw: {} } : { raw: { order_id: "x", status: "confirmed" } }; };
  const r = await createLiveTrader(cfg, { run, log: quiet }).buy(order, okBal);
  assert.equal(r.ok, false); assert.match(r.reason, /quote/); assert.equal(swaps, 0);
  assert.equal(fsReal.existsSync(cfg.ledgerPath), false);
});
test("H1: TP/SL strategy finished on GMGN => position closed, PnL booked, daily stop enforced", async () => {
  const cfg = tmpCfg({ maxOpenPositions: 1, dailyLossStopUsd: 5 });
  let phase = "open";
  const t0 = Date.now();
  const strat = (stats) => ({ base_token: order.token.toUpperCase().replace("0X", "0x"), create_time: t0 + 1000, close_time: t0 + 60_000, order_id: "s1", reason_by: "loss_stop", order_statistic: stats });
  const run = async (a) => {
    if (a[0] === "swap") return { raw: { order_id: "b1", status: "confirmed" } };
    if (a[1] === "strategy") { const type = a[a.indexOf("--type") + 1]; if (phase === "open") return { raw: { list: type === "open" ? [strat({})] : [] } }; return { raw: { list: type === "open" ? [] : [strat({ success_sell_num: 1, usdt_profit: "-7" })] } }; }
    return { raw: { status: "confirmed" } };
  };
  const t = createLiveTrader(cfg, { run, log: quiet, now: () => t0 });
  assert.equal((await t.buy(order, okBal)).ok, true);
  assert.deepEqual((await t.syncClosed()).closed, []); // still running
  phase = "done";
  const r = await t.syncClosed();
  assert.equal(r.closed[0].pnl, -7);
  assert.equal(r.closed[0].chain, "bsc");
  const l = ledgerOf(cfg);
  assert.equal(l.positions[0].status, "closed");
  assert.equal(Object.values(l.realized)[0], -7);
  assert.match((await t.buy(order, okBal)).reason, /daily loss/);
});
test("H1: finished strategy without sell stats books conservative full loss", () => {
  assert.deepEqual(strategyPnl({ usd: 10 }, { order_statistic: { success_sell_num: 0 } }), { pnl: -10, estimated: "conservative_full_loss" });
});

// ---- Medium 1 / 2 / 3 ----
import { redactText, publicDecision } from "../src/live-redact.js";
test("M1: AUTH_IP_BLOCKED arms persisted breaker; blocks new buys; probe after cooldown clears it", async () => {
  const cfg = tmpCfg({ ipBlockCooldownMs: 1000 });
  let clock = 1_000_000, blocked = true, swaps = 0;
  const run = async (a) => { if (a[0] === "swap") { swaps++; if (blocked) throw Object.assign(new Error("HTTP 403 AUTH_IP_BLOCKED source ip blocked 1.2.3.4"), { apiError: "AUTH_IP_BLOCKED" }); return { raw: { order_id: "p1", status: "confirmed" } }; } return { raw: { list: [] } }; };
  const t = createLiveTrader(cfg, { run, log: quiet, now: () => clock });
  await assert.rejects(t.buy(order, okBal), /AUTH_IP_BLOCKED/);
  assert.ok(fsReal.existsSync(cfg.breakerPath));
  const r = await t.buy(order, okBal);
  assert.match(r.reason, /circuit breaker/); assert.equal(swaps, 1);
  // a fresh process (new trader) still sees the persisted breaker
  assert.match((await createLiveTrader(cfg, { run, log: quiet, now: () => clock }).buy(order, okBal)).reason, /circuit breaker/);
  clock += 2000; blocked = false;
  assert.equal((await t.buy(order, okBal)).ok, true);
  assert.equal(fsReal.existsSync(cfg.breakerPath), false);
});
test("M2: redaction strips keys/query/ips/home paths; public decision drops raw result", () => {
  const raw = "GET https://api.x.com/v1?apikey=abc123 failed api_key=SUPERSECRET at /Users/qohfq/x ip 103.26.164.82 " + "Z".repeat(60);
  const r = redactText(raw, 1000);
  for (const bad of ["abc123", "SUPERSECRET", "qohfq", "103.26.164.82", "Z".repeat(60)]) assert.ok(!r.includes(bad), bad);
  const tx = "0x" + "a".repeat(64);
  assert.ok(redactText(`tx ${tx}`).includes(tx));
  const d = publicDecision({ at: "x", kind: "error", reason: "AUTH_IP_BLOCKED source ip blocked 1.2.3.4", result: "{secret}", balanceSol: 1 });
  assert.equal(d.result, undefined); assert.equal(d.balanceSol, undefined); assert.equal(d.errorCategory, "ip_blocked");
});
test("M3: live config is forced OFF under node --test on the real process env", () => {
  const prev = process.env.LIVE_TRADING_ENABLED; process.env.LIVE_TRADING_ENABLED = "true";
  try { assert.equal(loadLiveConfig().enabled, false); } finally { if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED; else process.env.LIVE_TRADING_ENABLED = prev; }
});

test("ladder TP: partial principal + native trailing + full SL, hold_amount", async () => {
  const { buildConditionOrders, loadLiveConfig } = await import("../src/live-gmgn-trader.js");
  const cfg = loadLiveConfig({});
  assert.equal(cfg.takeProfitMode, "ladder"); assert.equal(cfg.stopLossScale, "20");
  const legs = buildConditionOrders(cfg);
  assert.deepEqual(legs, [
    { order_type: "profit_stop", side: "sell", price_scale: "40", sell_ratio: "50" },
    { order_type: "profit_stop_trace", side: "sell", price_scale: "100", sell_ratio: "100", drawdown_rate: "30" },
    { order_type: "loss_stop", side: "sell", price_scale: "20", sell_ratio: "100" },
  ]);
  const a = buildSwapArgs({ ...base(), ...cfg, chain: "bsc", wallet: base().wallet, spendAsset: "bnb" }, order);
  assert.equal(a[a.indexOf("--sell-ratio-type") + 1], "hold_amount");
  const legacy = loadLiveConfig({ LIVE_TP_MODE: "legacy", LIVE_TP_PRICE_SCALE: "150" });
  assert.deepEqual(buildConditionOrders(legacy).map((x) => x.order_type), ["profit_stop", "loss_stop"]);
  assert.ok(!buildSwapArgs({ ...base(), ...legacy, chain: "bsc", wallet: base().wallet, spendAsset: "bnb" }, order).includes("--sell-ratio-type"));
  const env = loadLiveConfig({ LIVE_TP1_PRICE_SCALE: "30", LIVE_TP1_SELL_RATIO: "60", LIVE_TRAIL_PRICE_SCALE: "200", LIVE_TRAIL_DRAWDOWN_RATE: "25" });
  assert.deepEqual(buildConditionOrders(env).slice(0, 2).map((x) => [x.price_scale, x.sell_ratio, x.drawdown_rate]), [["30", "60", undefined], ["200", "100", "25"]]);
});
