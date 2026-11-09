import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiveManualApproval, LIVE_APPROVAL_CONFIRMATION, strategyCandidateId } from "../src/live-manual-approval.js";
import { loadLiveConfig, preSubmitQuote } from "../src/live-gmgn-trader.js";

const WALLET = "0x2938b003b1e3c2f95ae73046730b91f3af22f828";
const TOKEN = `0x${"1".repeat(40)}`;
const tempDirs = [];
test.afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function config(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-manual-confirm-")); tempDirs.push(dataDir);
  return loadLiveConfig({ LIVE_TRADING_ENABLED: "true", LIVE_CHAIN: "bsc", LIVE_CHAINS: "bsc", LIVE_WALLET: WALLET,
    LIVE_AUTO_SLIPPAGE: "false", LIVE_PRESUBMIT_QUOTE: "true", LIVE_REQUIRE_EVIDENCE: "false", LIVE_CLOSE_SYNC_MS: "0", ...extra }, dataDir);
}

function paperTrades(now) {
  const trades = [];
  for (let i = 0; i < 30; i += 1) {
    const address = `0x${(i + 10).toString(16).padStart(40, "0")}`;
    trades.push({ side: "buy", chain: "bsc", address, quantity: 1, atMs: now - 100_000 + i * 2, entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd: 1 } } });
    trades.push({ side: "sell", chain: "bsc", address, quantity: 1, realizedPnl: 0.8 + (i % 5) * 0.1, atMs: now - 99_999 + i * 2 });
  }
  return trades;
}

function strategy(now, { securityEvidence = true, decision = "可模拟", observedAt = now } = {}) {
  return { session: { id: "paper-session" }, account: { trades: paperTrades(now) }, evaluations: [{
    token: { chain: "bsc", address: TOKEN, symbol: "TEST", price: 1, observedAt: new Date(observedAt).toISOString() },
    chain: "bsc", address: TOKEN, at: new Date(observedAt).toISOString(), decision, strategyId: "strategy_test", label: "策略测试",
    entryUsd: 10, score: 91, reasons: ["符合模拟策略"], evidence: securityEvidence ? {
      paperEligible: true, priceFresh: true, marketFresh: true, priceObservedAt: new Date(now).toISOString(),
      safety: { missing: [], blocked: [], auditMissing: [], warnings: [], policyVersion: "strict_v1", sellabilityVerified: true,
        sellabilityFlags: { cannotSell: false, canSell: true }, metrics: { buyTax: 0.01, sellTax: 0.01 }, taxFilter: { blocked: false } },
    } : { paperEligible: true, priceFresh: true, marketFresh: true, priceObservedAt: new Date(now).toISOString(), safety: { policyVersion: "strict_v1", missing: [], blocked: [], auditMissing: [], warnings: [], sellabilityVerified: true, metrics: { buyTax: 0.01, sellTax: 0.01 } } },
  }] };
}

function gmgn({ security = { is_honeypot: "no", rug_ratio: 0.1 }, quote = {} } = {}) {
  const calls = [];
  return { calls, async configCheck() { calls.push(["config", "--check"]); }, async run(args) {
    calls.push(args);
    if (args[0] === "token") return { raw: security };
    if (args[0] === "order" && args[1] === "quote") return { raw: { input_amount: "20000000000000000", output_amount: "100000000000000000000", min_output_amount: "90000000000000000000", amount_in_usd: "10", amount_out_usd: "10", token_out_usd_price: "1", slippage: "30", ...quote } };
    throw new Error("unexpected mock command");
  } };
}

function readiness() {
  const observation = { status: "fresh", ageMs: 1, observedAt: new Date().toISOString() };
  return { live: { enabled: true, killed: false, spendAsset: "bnb", bnb: 1, bnbPriceUsd: 500, balanceUsd: 490,
    observations: { bnb: observation, bnbPriceUsd: observation, spendBalance: { status: "not_requested" } } } };
}

function service({ cfg, nowRef, strategySnapshot, gmgnClient, trader, ready = readiness() }) {
  return createLiveManualApproval({ cfg, trader, strategyProvider: async () => strategySnapshot, readinessProvider: async () => ready,
    gmgn: gmgnClient, env: {}, now: () => nowRef.value, monotonicNow: () => nowRef.value, id: () => "approval-test" });
}

test("strategy creates candidate and preview only; exact one-shot confirmation is required", async () => {
  const nowRef = { value: Date.now() }, cfg = config(), snapshot = strategy(nowRef.value), api = gmgn();
  const buys = [];
  const trader = { async reconcile() {}, async syncClosed() {}, async buy(order) { buys.push(order); return { ok: true, result: { orderId: "mock-order", status: "confirmed" } }; } };
  const flow = service({ cfg, nowRef, strategySnapshot: snapshot, gmgnClient: api, trader });
  const id = strategyCandidateId(snapshot.evaluations[0]);
  assert.equal((await flow.listCandidates()).length, 1);
  assert.equal(buys.length, 0);
  const preview = await flow.prepare(id);
  assert.equal(preview.ok, true);
  assert.equal(preview.approval.minOutputAmount, "90000000000000000000");
  assert.equal(buys.length, 0);
  assert.equal((await flow.confirm(preview.approval.id, "")).ok, false);
  assert.equal(buys.length, 0);
  assert.equal((await flow.confirm(preview.approval.id, LIVE_APPROVAL_CONFIRMATION)).ok, true);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].manualCandidateId, id);
  assert.equal((await flow.confirm(preview.approval.id, LIVE_APPROVAL_CONFIRMATION)).ok, false);
  assert.equal((await flow.prepare(id)).ok, false);
});

test("stale signal, unknown GMGN security, and live-kill all fail closed", async () => {
  const nowRef = { value: Date.now() }, cfg = config();
  let buys = 0;
  const trader = { async reconcile() {}, async syncClosed() {}, async buy() { buys += 1; return { ok: true }; } };
  const stale = strategy(nowRef.value, { observedAt: nowRef.value - 120_000 });
  const staleFlow = service({ cfg, nowRef, strategySnapshot: stale, gmgnClient: gmgn(), trader });
  assert.match((await staleFlow.prepare(strategyCandidateId(stale.evaluations[0]))).reason, /过期/);
  const unknown = strategy(nowRef.value);
  const unknownFlow = service({ cfg, nowRef, strategySnapshot: unknown, gmgnClient: gmgn({ security: { is_honeypot: "no" } }), trader });
  assert.equal((await unknownFlow.prepare(strategyCandidateId(unknown.evaluations[0]))).ok, false);
  fs.writeFileSync(cfg.killFile, "stop\n");
  assert.equal(service({ cfg, nowRef, strategySnapshot: unknown, gmgnClient: gmgn(), trader }).status().ready, false);
  assert.equal(buys, 0);
});

test("pre-submit quote binds exact input, output, minimum and configured slippage", async () => {
  const cfg = config({ LIVE_AUTO_SLIPPAGE: "false", LIVE_MAX_SLIPPAGE: "24" });
  const order = { token: TOKEN, chain: "bsc", usd: 10, bnbPriceUsd: 500, paperPrice: 1 };
  let args;
  const ok = await preSubmitQuote(cfg, order, { run: async (argv) => { args = argv; return { raw: { input_amount: "20000000000000000", output_amount: "100", min_output_amount: "90", amount_in_usd: "10", amount_out_usd: "10", token_out_usd_price: "1", slippage: "24" } }; } });
  assert.equal(ok.ok, true);
  assert.equal(args[args.indexOf("--slippage") + 1], "24");
  for (const raw of [
    { input_amount: "20000000000000001", output_amount: "100", min_output_amount: "90", slippage: "24" },
    { input_amount: "20000000000000000", output_amount: "0", min_output_amount: "0", slippage: "24" },
    { input_amount: "20000000000000000", output_amount: "100", min_output_amount: "101", slippage: "24" },
    { input_amount: "20000000000000000", output_amount: "100", min_output_amount: "90", slippage: "24.5" },
  ]) assert.equal((await preSubmitQuote(cfg, order, { run: async () => ({ raw }) })).ok, false);
});
