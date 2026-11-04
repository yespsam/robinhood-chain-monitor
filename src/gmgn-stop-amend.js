// Replace the on-exchange GMGN stop after the principal-out leg.
// Local price_scale stays a multiplier of entry/cost (1 = breakeven).
// GMGN `loss_stop` price_scale is a drop percent from entry ("20" = −20%).
// A breakeven or above-cost stop is sent as a limit stop_loss at the absolute
// check price (entryPrice * price_scale), which is the documented strategy
// create path. There is no separate amend verb: create the tighter stop first,
// then cancel the previous one. A failed create leaves the old stop in place
// and does not move local state.
//
// SOL strategy orders require both --priority-fee (>= 0.00001) and --tip-fee
// (>= 0.00001). BSC requires --gas-price (>= 0.05 gwei). Those flags are
// rejected on the wrong chain. The private key stays in the CLI environment;
// it is never placed on argv.
import { execFileSync } from "node:child_process";
import { liveStopSlippagePercent } from "./live-ladder-breakeven.js";

const MIN_SOL_FEE = 0.00001;
const MIN_BSC_GAS_GWEI = 0.05;
const MIN_BSC_TIP = 0.000001;

function feeNumber(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

export function formatCheckPrice(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value.toFixed(12).replace(/\.?0+$/, "");
}

// GMGN loss_stop price_scale is the drop percent. A stop at or above entry
// is not a drop, so the field is null and the absolute check price is used.
export function gmgnLossStopDropPercent(stopPriceScale) {
  const scale = Number(stopPriceScale);
  if (!Number.isFinite(scale) || scale <= 0 || scale >= 1) return null;
  const drop = (1 - scale) * 100;
  return String(Math.round(drop * 1e4) / 1e4);
}

function addressOk(chain, value) {
  if (typeof value !== "string" || value.length > 64) return false;
  if (chain === "sol") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function orderIdOk(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function chainStopFeeArgs(chain, env = process.env) {
  if (chain === "sol") {
    const priority = feeNumber(env.LIVE_GMGN_PRIORITY_FEE, MIN_SOL_FEE);
    const tip = feeNumber(env.LIVE_GMGN_TIP_FEE, MIN_SOL_FEE);
    if (!(priority >= MIN_SOL_FEE)) return { error: "sol_priority_fee_below_minimum" };
    if (!(tip >= MIN_SOL_FEE)) return { error: "sol_tip_fee_below_minimum" };
    return {
      args: ["--priority-fee", String(priority), "--tip-fee", String(tip)],
      priorityFee: String(priority), tipFee: String(tip), gasPrice: null,
    };
  }
  if (chain === "bsc") {
    const gas = feeNumber(env.LIVE_GMGN_GAS_PRICE, MIN_BSC_GAS_GWEI);
    if (!(gas >= MIN_BSC_GAS_GWEI)) return { error: "bsc_gas_price_below_minimum" };
    const args = ["--gas-price", String(gas)];
    let tipFee = null;
    if (env.LIVE_GMGN_TIP_FEE !== undefined && env.LIVE_GMGN_TIP_FEE !== "") {
      const tip = Number(env.LIVE_GMGN_TIP_FEE);
      if (!(tip >= MIN_BSC_TIP)) return { error: "bsc_tip_fee_below_minimum" };
      args.push("--tip-fee", String(tip));
      tipFee = String(tip);
    }
    return { args, priorityFee: null, tipFee, gasPrice: String(gas) };
  }
  if (chain === "eth" || chain === "base" || chain === "robinhood") {
    return { args: [], priorityFee: null, tipFee: null, gasPrice: null };
  }
  return { error: "unsupported_chain" };
}

export function buildGmgnStopReplacePlan({
  chain, wallet, baseToken, quoteToken, entryPrice, stopPriceScale, previousOrderId = null, env = process.env,
} = {}) {
  const errors = [];
  const name = String(chain || "").toLowerCase();
  const fees = chainStopFeeArgs(name, env);
  if (fees.error) errors.push(fees.error);
  if (!addressOk(name, wallet)) errors.push("missing_wallet");
  if (!addressOk(name, baseToken)) errors.push("missing_base_token");
  if (!addressOk(name, quoteToken)) errors.push("missing_quote_token");
  const scale = Number(stopPriceScale);
  const checkPrice = formatCheckPrice(Number(entryPrice) * scale);
  if (!checkPrice) errors.push("invalid_check_price");
  const slippagePercent = liveStopSlippagePercent(env);
  const createArgs = [
    "order", "strategy", "create",
    "--chain", name,
    "--from", wallet || "",
    "--base-token", baseToken || "",
    "--quote-token", quoteToken || "",
    "--order-type", "limit_order",
    "--sub-order-type", "stop_loss",
    "--check-price", checkPrice || "",
    "--amount-in-percent", "100",
    "--slippage", String(slippagePercent),
    "--limit-price-mode", "exact",
    ...(fees.args || []),
    "--raw",
  ];
  const cancelArgs = orderIdOk(previousOrderId) ? [
    "order", "strategy", "cancel",
    "--chain", name,
    "--from", wallet || "",
    "--order-id", previousOrderId,
    "--order-type", "limit_order",
    "--raw",
  ] : null;
  if (previousOrderId != null && previousOrderId !== "" && !cancelArgs) errors.push("invalid_previous_order_id");
  return {
    errors, createArgs, cancelArgs, checkPrice, slippagePercent,
    gmgnLossStopDropPercent: gmgnLossStopDropPercent(scale),
    priorityFee: fees.priorityFee ?? null,
    tipFee: fees.tipFee ?? null,
    gasPrice: fees.gasPrice ?? null,
    previousOrderId: cancelArgs ? previousOrderId : null,
  };
}

function parseBody(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  try { return JSON.parse(stdout); }
  catch { return null; }
}

function accepted(result, { requireOrderId }) {
  const exitCode = Number(result?.exitCode);
  const body = parseBody(result);
  if (!body || !Number.isInteger(exitCode)) return { ok: false, error: "gmgn_invalid_json", orderId: null };
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
  const orderId = typeof data.order_id === "string" ? data.order_id : null;
  const code = body.code;
  const codeOk = code === undefined || code === 0 || code === "0";
  if (exitCode !== 0 || !codeOk || (requireOrderId && !orderIdOk(orderId))) {
    const message = typeof body.msg === "string" ? body.msg : (typeof body.error === "string" ? body.error : "gmgn_rejected");
    return { ok: false, error: message.slice(0, 200), orderId: orderIdOk(orderId) ? orderId : null };
  }
  return { ok: true, orderId, isUpdate: data.is_update === true };
}

export function runGmgnStopAmend(plan, run) {
  if (!plan || plan.errors?.length) return { ok: false, error: plan?.errors?.[0] || "invalid_plan", stage: "plan", orderId: null };
  if (typeof run !== "function") return { ok: false, error: "gmgn_client_missing", stage: "plan", orderId: null };
  let created;
  try { created = run(plan.createArgs); }
  catch (error) {
    return { ok: false, error: "gmgn_create_threw", detail: String(error?.message || error).slice(0, 200), stage: "create", orderId: null };
  }
  const parsed = accepted(created, { requireOrderId: true });
  if (!parsed.ok) return { ok: false, error: parsed.error, stage: "create", orderId: null };
  let cancelError = null;
  if (plan.cancelArgs) {
    try {
      const cancelled = accepted(run(plan.cancelArgs), { requireOrderId: false });
      if (!cancelled.ok) cancelError = cancelled.error;
    } catch (error) {
      cancelError = "gmgn_cancel_threw";
    }
  }
  return {
    ok: true, stage: "create", orderId: parsed.orderId, isUpdate: parsed.isUpdate,
    cancelError, cancelledOrderId: cancelError ? null : plan.previousOrderId,
  };
}

export function gmgnAmendEnabled(env = process.env) {
  return !/^false$/i.test(String(env?.LIVE_GMGN_STOP_AMEND ?? ""));
}

export function createGmgnCliStopClient({ env = process.env, execFile = execFileSync } = {}) {
  return {
    run(args) {
      if (!gmgnAmendEnabled(env)) return { exitCode: 1, stdout: JSON.stringify({ code: 1, error: "gmgn_amend_disabled" }), stderr: "" };
      const bin = env.GMGN_CLI_PATH || "gmgn-cli";
      try {
        const stdout = execFile(bin, args, { encoding: "utf8", timeout: 20_000, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
        return { exitCode: 0, stdout: String(stdout || ""), stderr: "" };
      } catch (error) {
        return {
          exitCode: Number.isInteger(error?.status) ? error.status : 1,
          stdout: String(error?.stdout || ""),
          stderr: String(error?.stderr || error?.message || "gmgn_cli_unavailable").slice(0, 300),
        };
      }
    },
  };
}
