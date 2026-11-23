import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiveManualApproval, LIVE_APPROVAL_CONFIRMATION, strategyCandidateId } from "../src/live-manual-approval.js";
import { createLiveTrader, loadLiveConfig, preSubmitQuote } from "../src/live-gmgn-trader.js";

const WALLET = "0x2938b003b1e3c2f95ae73046730b91f3af22f828";
const TOKEN = `0x${"1".repeat(40)}`;
const quiet = { warn() {}, info() {}, error() {} };
const tempDirs = [];

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempConfig(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-manual-approval-"));
  tempDirs.push(dataDir);
  const cfg = loadLiveConfig({
    LIVE_TRADING_ENABLED: "true",
    LIVE_CHAIN: "bsc",
    LIVE_CHAINS: "bsc",
    LIVE_WALLET: WALLET,
    LIVE_AUTO_SLIPPAGE: "false",
    LIVE_PRESUBMIT_QUOTE: "true",
    LIVE_REQUIRE_EVIDENCE: "false",
    LIVE_CLOSE_SYNC_MS: "0",
    ...extra,
  }, dataDir);
  return { cfg, dataDir };
}

function promotableTrades(now) {
  const trades = [];
  for (let i = 0; i < 30; i += 1) {
    const address = `0x${(i + 10).toString(16).padStart(40, "0")}`;
    trades.push({
      side: "buy", chain: "bsc", address, quantity: 1, atMs: now - 100_000 + i * 2,
      entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd: 1 } },
    });
    trades.push({ side: "sell", chain: "bsc", address, quantity: 1, realizedPnl: 0.8 + (i % 5) * 0.1, atMs: now - 99_999 + i * 2 });
  }
  return trades;
}

function makeStrategy(now, { chain = "bsc", evidence = null } = {}) {
  const evaluation = {
    token: { chain, address: TOKEN, symbol: "TEST", price: 1, observedAt: new Date(now).toISOString() },
    chain, address: TOKEN, at: new Date(now).toISOString(), decision: "可模拟", strategyId: "test_strategy",
    label: "Test Strategy", entryUsd: 10, score: 91, reasons: ["策略条件已满足"],
    evidence: evidence || {
      paperEligible: true, priceFresh: true, marketFresh: true, priceObservedAt: new Date(now).toISOString(),
      safety: {
        missing: [], blocked: [], auditMissing: [], warnings: [], policyVersion: "strict_v1",
        sellabilityVerified: true, sellabilityFlags: { cannotSell: false, canSell: true },
        metrics: { buyTax: 0.01, sellTax: 0.01 }, taxFilter: { blocked: false },
      },
    },
  };
  return {
    session: { id: "paper-session-test" },
    account: { trades: promotableTrades(now) },
    evaluations: [evaluation],
  };
}

function makeReadiness() {
  const fresh = { status: "fresh", ageMs: 1, observedAt: new Date().toISOString() };
  return { live: {
    enabled: true, killed: false, spendAsset: "bnb", bnb: 1, bnbPriceUsd: 500, balanceUsd: 490,
    observations: { bnb: fresh, bnbPriceUsd: fresh, spendBalance: { status: "not_requested" } },
  } };
}

function makeGmgn({ security = { is_honeypot: "no", rug_ratio: 0.1 }, quote = {} } = {}) {
  const calls = [];
  return {
    calls,
    async configCheck() { calls.push(["config", "--check"]); return true; },
    async run(args) {
      calls.push(args);
      if (args[0] === "token") return { raw: security };
      if (args[0] === "order" && args[1] === "quote") return { raw: {
        input_amount: "20000000000000000", output_amount: "100000000000000000000", min_output_amount: "90000000000000000000",
        amount_in_usd: "10", amount_out_usd: "10", token_out_usd_price: "1", slippage: "30", ...quote,
      } };
      throw new Error("unexpected mock GMGN command");
    },
  };
}

function makeService({ cfg, nowRef, strategy, gmgn, trader, readiness = makeReadiness(), idSequence = ["approval-1", "approval-2"] }) {
  let nextId = 0;
  return createLiveManualApproval({
    cfg, trader, strategyProvider: async () => strategy, readinessProvider: async () => readiness, gmgn,
    env: {}, now: () => nowRef.value, monotonicNow: () => nowRef.value, id: () => idSequence[nextId++] || `approval-${nextId}`,
  });
}

test("eligible strategy signal is listed without submitting; non-positive decisions and non-BSC are excluded", async () => {
  const nowRef = { value: Date.now() };
  const { cfg } = makeTempConfig();
  const strategy = makeStrategy(nowRef.value);
  strategy.evaluations.push({ ...strategy.evaluations[0], token: { ...strategy.evaluations[0].token, chain: "sol" }, chain: "sol", strategyId: "sol_strategy" });
  strategy.evaluations.push({ ...strategy.evaluations[0], token: { ...strategy.evaluations[0].token, address: `0x${"2".repeat(40)}` }, address: `0x${"2".repeat(40)}`, strategyId: "observe_strategy", decision: "观察" });
  strategy.evaluations.push({ ...strategy.evaluations[0], token: { ...strategy.evaluations[0].token, address: `0x${"3".repeat(40)}` }, address: `0x${"3".repeat(40)}`, strategyId: "blocked_strategy", decision: "不买" });
  const gmgn = makeGmgn();
  let buys = 0;
  const trader = { buy: async () => { buys += 1; return { ok: true }; }, async reconcile() {}, async syncClosed() {} };
  const service = makeService({ cfg, nowRef, strategy, gmgn, trader });
  const candidates = await service.listCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].chain, "bsc");
  assert.equal(buys, 0);
  assert.equal(gmgn.calls.length, 0);
});

test("prepare checks config, security and quote but does not submit; confirmation is explicit and one-shot", async () => {
  const nowRef = { value: Date.now() };
  const { cfg } = makeTempConfig();
  const strategy = makeStrategy(nowRef.value);
  const gmgn = makeGmgn();
  const buyOrders = [];
  const trader = { async reconcile() {}, async syncClosed() {}, async buy(order) { buyOrders.push(order); return { ok: true, result: { orderId: "gmgn-1", status: "confirmed" } }; } };
  const service = makeService({ cfg, nowRef, strategy, gmgn, trader });
  const candidateId = strategyCandidateId(strategy.evaluations[0]);
  const prepared = await service.prepare(candidateId);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.approval.minOutputAmount, "90000000000000000000");
  assert.equal(prepared.approval.security.rugRatio, 0.1);
  assert.equal(prepared.approval.conditionOrders.length, 3);
  assert.equal(buyOrders.length, 0);
  assert.equal(gmgn.calls.some((args) => Array.isArray(args) && args[0] === "order" && args[1] === "quote"), true);

  const missingConsent = await service.confirm(prepared.approval.id, "");
  assert.equal(missingConsent.ok, false);
  assert.equal(buyOrders.length, 0);
  const result = await service.confirm(prepared.approval.id, LIVE_APPROVAL_CONFIRMATION);
  assert.equal(result.ok, true);
  assert.equal(buyOrders.length, 1);
  assert.equal(buyOrders[0].manualCandidateId, candidateId);
  assert.equal((await service.confirm(prepared.approval.id, LIVE_APPROVAL_CONFIRMATION)).ok, false);
  assert.equal((await service.prepare(candidateId)).ok, false);
  assert.equal(buyOrders.length, 1);
});

test("expired proposal, unknown security, and config failure fail closed", async () => {
  const nowRef = { value: Date.now() };
  const { cfg } = makeTempConfig();
  const strategy = makeStrategy(nowRef.value);
  let buys = 0;
  const trader = { async reconcile() {}, async syncClosed() {}, async buy() { buys += 1; return { ok: true }; } };
  const candidateId = strategyCandidateId(strategy.evaluations[0]);
  const gmgn = makeGmgn();
  const service = makeService({ cfg, nowRef, strategy, gmgn, trader });
  const prepared = await service.prepare(candidateId);
  nowRef.value += 15_001;
  assert.equal((await service.confirm(prepared.approval.id, LIVE_APPROVAL_CONFIRMATION)).ok, false);
  assert.equal(buys, 0);

  nowRef.value = Date.now();
  const badStrategy = makeStrategy(nowRef.value);
  const badSafetyService = makeService({ cfg, nowRef, strategy: badStrategy, gmgn: makeGmgn({ security: {} }), trader });
  const badCandidate = strategyCandidateId(badStrategy.evaluations[0]);
  assert.equal((await badSafetyService.prepare(badCandidate)).ok, false);
  assert.equal(buys, 0);

  const missingRatioStrategy = makeStrategy(nowRef.value);
  const missingRatioService = makeService({ cfg, nowRef, strategy: missingRatioStrategy, gmgn: makeGmgn({ security: { is_honeypot: "no", rug_ratio: null } }), trader });
  assert.equal((await missingRatioService.prepare(strategyCandidateId(missingRatioStrategy.evaluations[0]))).ok, false);
  const blankRatioStrategy = makeStrategy(nowRef.value);
  const blankRatioService = makeService({ cfg, nowRef, strategy: blankRatioStrategy, gmgn: makeGmgn({ security: { is_honeypot: "no", rug_ratio: "" } }), trader });
  assert.equal((await blankRatioService.prepare(strategyCandidateId(blankRatioStrategy.evaluations[0]))).ok, false);

  const configStrategy = makeStrategy(nowRef.value);
  const failedConfigGmgn = { ...makeGmgn(), async configCheck() { throw new Error("private mock error"); } };
  const configFailureService = makeService({ cfg, nowRef, strategy: configStrategy, gmgn: failedConfigGmgn, trader });
  const configCandidate = strategyCandidateId(configStrategy.evaluations[0]);
  assert.equal((await configFailureService.prepare(configCandidate)).ok, false);
  assert.equal(buys, 0);
});

test("strategy candidate must be fresh and carry live safety evidence", async () => {
  const nowRef = { value: Date.now() };
  const { cfg } = makeTempConfig();
  const staleStrategy = makeStrategy(nowRef.value - 120_000);
  const gmgn = makeGmgn();
  let buys = 0;
  const trader = { async reconcile() {}, async syncClosed() {}, async buy() { buys += 1; return { ok: true }; } };
  const service = makeService({ cfg, nowRef, strategy: staleStrategy, gmgn, trader });
  const staleCandidate = strategyCandidateId(staleStrategy.evaluations[0]);
  assert.match((await service.prepare(staleCandidate)).reason, /过期/);
  assert.equal(gmgn.calls.length, 0);
  assert.equal(buys, 0);
});

test("actual trader refuses when submit-time quote differs from user-approved preview", async () => {
  const nowRef = { value: Date.now() };
  const { cfg } = makeTempConfig();
  const strategy = makeStrategy(nowRef.value);
  const previewGmgn = makeGmgn();
  const candidateId = strategyCandidateId(strategy.evaluations[0]);
  let swaps = 0;
  const trader = createLiveTrader(cfg, { now: () => nowRef.value, wait: async () => {}, log: quiet, run: async (args) => {
    if (args[0] === "order" && args[1] === "quote") return { raw: {
      input_amount: "20000000000000000", output_amount: "99000000000000000000", min_output_amount: "89000000000000000000",
      amount_in_usd: "10", amount_out_usd: "10", token_out_usd_price: "1", slippage: "30",
    } };
    if (args[0] === "swap") swaps += 1;
    throw new Error("unexpected command");
  } });
  const service = makeService({ cfg, nowRef, strategy, gmgn: previewGmgn, trader });
  const prepared = await service.prepare(candidateId);
  assert.equal(prepared.ok, true);
  const result = await service.confirm(prepared.approval.id, LIVE_APPROVAL_CONFIRMATION);
  assert.equal(result.ok, false);
  assert.match(result.reason, /报价与用户确认时不同/);
  assert.equal(swaps, 0);
  assert.equal(fs.existsSync(cfg.ledgerPath), false);
  assert.equal((await service.prepare(candidateId)).ok, true, "quote drift permits a fresh preview, never automatic resubmission");
});

test("auto-slippage preview uses the same mode as the submitted swap", async () => {
  const { cfg } = makeTempConfig({ LIVE_AUTO_SLIPPAGE: "true" });
  const calls = [];
  const quote = await preSubmitQuote(cfg, { ...makeStrategy(Date.now()).evaluations[0], token: TOKEN, chain: "bsc", usd: 10, bnbPriceUsd: 500, paperPrice: 1 }, {
    run: async (args) => {
      calls.push(args);
      return { raw: {
        input_amount: "20000000000000000", output_amount: "100", min_output_amount: "90",
        amount_in_usd: "10", amount_out_usd: "10", token_out_usd_price: "1", slippage: "17",
      } };
    },
  });
  assert.equal(quote.ok, true);
  assert.ok(calls[0].includes("--auto-slippage"));
  assert.ok(!calls[0].includes("--slippage"));
  assert.equal(quote.quote.slippage, "auto:17");
});

test("fixed-slippage quote uses the configured order tolerance", async () => {
  const { cfg } = makeTempConfig({ LIVE_AUTO_SLIPPAGE: "false", LIVE_MAX_SLIPPAGE: "24" });
  const calls = [];
  const quote = await preSubmitQuote(cfg, { ...makeStrategy(Date.now()).evaluations[0], token: TOKEN, chain: "bsc", usd: 10, bnbPriceUsd: 500, paperPrice: 1 }, {
    run: async (args) => {
      calls.push(args);
      return { raw: {
        input_amount: "20000000000000000", output_amount: "100", min_output_amount: "90",
        amount_in_usd: "10", amount_out_usd: "10", token_out_usd_price: "1", slippage: "24",
      } };
    },
  });
  assert.equal(quote.ok, true);
  assert.ok(calls[0].includes("--slippage"));
  assert.equal(calls[0][calls[0].indexOf("--slippage") + 1], "24");
  assert.equal(quote.quote.slippage, "24");
});

test("pre-submit quote rejects missing or malformed executable amounts", async () => {
  const { cfg } = makeTempConfig();
  const order = { ...makeStrategy(Date.now()).evaluations[0], token: TOKEN, chain: "bsc", usd: 10, bnbPriceUsd: 500, paperPrice: 1 };
  for (const raw of [
    { input_amount: "20000000000000000", output_amount: "0", min_output_amount: "0", slippage: "30" },
    { input_amount: "20000000000000001", output_amount: "100", min_output_amount: "90", slippage: "30" },
    { input_amount: "20000000000000000", output_amount: "100", min_output_amount: "101", slippage: "30" },
    { input_amount: "20000000000000000", output_amount: "100", min_output_amount: "90", slippage: "30.5" },
  ]) {
    const result = await preSubmitQuote(cfg, order, { run: async () => ({ raw }) });
    assert.equal(result.ok, false);
  }
});

test("status fails closed when the existing kill file is present", async () => {
  const { cfg, dataDir } = makeTempConfig();
  fs.writeFileSync(path.join(dataDir, "live-kill"), "stop\n");
  const nowRef = { value: Date.now() };
  const strategy = makeStrategy(nowRef.value);
  const service = makeService({ cfg, nowRef, strategy, gmgn: makeGmgn(), trader: { buy: async () => ({ ok: false }) } });
  assert.deepEqual(service.status(), { ready: false, reason: "急停文件存在；不会自动解除" });
});

test("ledger reservation prevents re-submitting the same manual strategy signal", async () => {
  const { cfg } = makeTempConfig({ LIVE_PRESUBMIT_QUOTE: "false" });
  let swaps = 0;
  const trader = createLiveTrader(cfg, { log: quiet, run: async (args) => {
    if (args[0] === "swap") { swaps += 1; return { raw: { order_id: "manual-once", status: "confirmed" } }; }
    return { raw: { status: "confirmed" } };
  } });
  const candidate = "candidate-sha256-unique";
  const order = { source: cfg.signalSource, token: TOKEN, chain: "bsc", usd: 10, bnbPriceUsd: 500,
    manualApprovalId: "approval-once", manualCandidateId: candidate, paperStrategyId: "test_strategy" };
  assert.equal((await trader.buy(order, { balanceUsd: 490, balanceBnb: 1 })).ok, true);
  const repeated = await trader.buy({ ...order, manualApprovalId: "approval-two" }, { balanceUsd: 490, balanceBnb: 1 });
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /already has a live ledger reservation/);
  assert.equal(swaps, 1);
});

test("manual route refuses a new signal while the same token has an open live reservation", async () => {
  const { cfg } = makeTempConfig({ LIVE_PRESUBMIT_QUOTE: "false" });
  let swaps = 0;
  const trader = createLiveTrader(cfg, { log: quiet, run: async (args) => {
    if (args[0] === "swap") { swaps += 1; return { raw: { order_id: "manual-once", status: "confirmed" } }; }
    return { raw: { status: "confirmed" } };
  } });
  const first = { source: cfg.signalSource, token: TOKEN, chain: "bsc", usd: 10, bnbPriceUsd: 500,
    manualApprovalId: "approval-one", manualCandidateId: "candidate-one", paperStrategyId: "test_strategy" };
  assert.equal((await trader.buy(first, { balanceUsd: 490, balanceBnb: 1 })).ok, true);
  const repeated = await trader.buy({ ...first, manualApprovalId: "approval-two", manualCandidateId: "candidate-two" }, { balanceUsd: 490, balanceBnb: 1 });
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /already has a live ledger reservation/);
  assert.equal(swaps, 1);
});

