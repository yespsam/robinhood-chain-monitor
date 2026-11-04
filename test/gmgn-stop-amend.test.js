import test from "node:test";
import assert from "node:assert/strict";
import { buildGmgnStopReplacePlan, runGmgnStopAmend, gmgnLossStopDropPercent } from "../src/gmgn-stop-amend.js";

const SOL = "So11111111111111111111111111111111111111112";
const WALLET = "9fB3nQ2mC7kR4tY8wL1pD6sA5eH3uJ2vN4xC8bM7qT";
const BASE = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const EVM = (digit) => `0x${digit.repeat(40)}`;

function arg(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("SOL breakeven stop sends the required priority fee and tip, and not EVM gas", () => {
  const plan = buildGmgnStopReplacePlan({
    chain: "sol", wallet: WALLET, baseToken: BASE, quoteToken: SOL,
    entryPrice: 0.001, stopPriceScale: 1, previousOrderId: "old-stop",
    env: {},
  });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.checkPrice, "0.001");
  assert.equal(plan.gmgnLossStopDropPercent, null, "breakeven is not a loss_stop drop percent");
  assert.equal(arg(plan.createArgs, "--priority-fee"), "0.00001");
  assert.equal(arg(plan.createArgs, "--tip-fee"), "0.00001");
  assert.equal(plan.createArgs.includes("--gas-price"), false);
  assert.equal(arg(plan.createArgs, "--slippage"), "15");
  assert.equal(plan.createArgs.includes("--auto-slippage"), false);
  assert.equal(arg(plan.createArgs, "--sub-order-type"), "stop_loss");
  assert.equal(arg(plan.cancelArgs, "--order-id"), "old-stop");
  assert.equal(gmgnLossStopDropPercent(0.8), "20");
});

test("BSC requires gas price and keeps a sub-minimum tip off the command", () => {
  const plan = buildGmgnStopReplacePlan({
    chain: "bsc", wallet: EVM("a"), baseToken: EVM("b"), quoteToken: EVM("c"),
    entryPrice: 2, stopPriceScale: 1.01, env: { LIVE_SL_SLIPPAGE_PERCENT: "12" },
  });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.checkPrice, "2.02");
  assert.equal(arg(plan.createArgs, "--gas-price"), "0.05");
  assert.equal(plan.createArgs.includes("--tip-fee"), false);
  assert.equal(plan.createArgs.includes("--priority-fee"), false);
  assert.equal(arg(plan.createArgs, "--slippage"), "12");
  const lowTip = buildGmgnStopReplacePlan({
    chain: "bsc", wallet: EVM("a"), baseToken: EVM("b"), quoteToken: EVM("c"),
    entryPrice: 2, stopPriceScale: 1, env: { LIVE_GMGN_TIP_FEE: "0.0000001" },
  });
  assert.ok(lowTip.errors.includes("bsc_tip_fee_below_minimum"));
  const lowSol = buildGmgnStopReplacePlan({
    chain: "sol", wallet: WALLET, baseToken: BASE, quoteToken: SOL,
    entryPrice: 1, stopPriceScale: 1, env: { LIVE_GMGN_TIP_FEE: "0.000001" },
  });
  assert.ok(lowSol.errors.includes("sol_tip_fee_below_minimum"));
});

test("a rejected create does not cancel the previous stop", () => {
  const plan = buildGmgnStopReplacePlan({
    chain: "base", wallet: EVM("1"), baseToken: EVM("2"), quoteToken: EVM("3"),
    entryPrice: 4, stopPriceScale: 1, previousOrderId: "keep-me", env: {},
  });
  assert.equal(plan.createArgs.includes("--tip-fee"), false);
  const calls = [];
  const failed = runGmgnStopAmend(plan, (args) => {
    calls.push(args[2]);
    return { exitCode: 1, stdout: JSON.stringify({ code: 7, msg: "fee rejected" }) };
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "fee rejected");
  assert.deepEqual(calls, ["create"]);
  const ok = runGmgnStopAmend(plan, (args) => {
    calls.push(args[2]);
    return { exitCode: 0, stdout: JSON.stringify({ code: 0, data: { order_id: args[2] === "create" ? "created" : "keep-me" } }) };
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.orderId, "created");
  assert.equal(ok.cancelledOrderId, "keep-me");
  assert.equal(ok.cancelError, null);
});

test("missing wallet is a plan error and does not call GMGN", () => {
  const plan = buildGmgnStopReplacePlan({
    chain: "sol", wallet: "", baseToken: BASE, quoteToken: SOL, entryPrice: 1, stopPriceScale: 1, env: {},
  });
  let called = false;
  const result = runGmgnStopAmend(plan, () => { called = true; return { exitCode: 0, stdout: "{}" }; });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_wallet");
});
