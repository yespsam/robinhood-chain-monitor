// Default-OFF live trading via `gmgn-cli swap` only. No private keys live in this repo.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
// gmgn-cli currency address for native BNB on bsc.
export const BSC_NATIVE_BNB = "0x0000000000000000000000000000000000000000";
// gmgn-cli currency address for native SOL (9 decimals, lamports).
export const SOL_NATIVE = "So11111111111111111111111111111111111111112";
// Per-chain spend asset: bsc spends BNB, sol spends SOL. Anything else is refused.
export const CHAIN_SPEC = {
  bsc: { asset: "bnb", native: BSC_NATIVE_BNB, decimals: 18 },
  sol: { asset: "sol", native: SOL_NATIVE, decimals: 9 },
};
export const normChain = (c) => { const s = String(c || "").toLowerCase(); return s === "solana" ? "sol" : s; };
// Derive a single-chain cfg (chain/wallet/spendAsset/gasReserve) from the multi-chain cfg.
export function chainCfg(cfg, chain = cfg.chain) {
  const c = normChain(chain);
  if (c === "sol") return { ...cfg, chain: "sol", wallet: cfg.solWallet, spendAsset: "sol", gasReserveNative: cfg.gasReserveSol };
  if (c === cfg.chain || c === "bsc") return { ...cfg, chain: c, gasReserveNative: cfg.gasReserveBnb };
  return { ...cfg, chain: c, unsupported: true };
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function loadLiveConfig(env = process.env, dataDir = env.DATA_DIR || "data") {
  return {
    // Never live under `node --test` on the real process env (fixtures must not reach GMGN).
    enabled: env.LIVE_TRADING_ENABLED === "true" && !(env === process.env && process.env.NODE_TEST_CONTEXT && process.env.LIVE_ALLOW_IN_TEST !== "1"),
    chain: env.LIVE_CHAIN || "bsc",
    // Chains live may mirror. sol spends SOL from LIVE_SOL_WALLET.
    chains: (env.LIVE_CHAINS || env.LIVE_CHAIN || "bsc").split(",").map((x) => normChain(x.trim())).filter(Boolean),
    solWallet: env.LIVE_SOL_WALLET || "",
    gasReserveSol: num(env.LIVE_GAS_RESERVE_SOL, 0.02),
    solPriorityFee: env.LIVE_SOL_PRIORITY_FEE || "0.0001",
    solTipFee: env.LIVE_SOL_TIP_FEE || "0.00001",
    wallet: (env.LIVE_WALLET || "").toLowerCase(),
    maxTotalUsd: num(env.LIVE_MAX_TOTAL_USD, 100),
    maxPerTradeUsd: num(env.LIVE_MAX_PER_TRADE_USD, 10),
    maxOpenPositions: num(env.LIVE_MAX_OPEN_POSITIONS, 5),
    dailyLossStopUsd: num(env.LIVE_DAILY_LOSS_STOP_USD, 30),
    // gmgn-cli --slippage is PERCENT (30 = 30%). Keep 10–30 for meme fills.
    maxSlippage: clamp(num(env.LIVE_MAX_SLIPPAGE, 30), 10, 30),
    // Default ON: volatile meme fills prefer GMGN auto slippage (mutually exclusive with --slippage).
    autoSlippage: env.LIVE_AUTO_SLIPPAGE !== "false",
    signalSource: env.LIVE_SIGNAL_SOURCE || "paper-atm-confirmed-pvp-v2",
    antiMev: env.LIVE_ANTI_MEV !== "false",
    takeProfitScale: env.LIVE_TP_PRICE_SCALE || "150",
    // GMGN price_scale 是相对开仓价的涨/跌百分比（实测：loss_stop 70 => check_price=open*0.30 即 -70%；
    // profit_stop 150 => open*2.5 即 +150%）。复盘(比格多栋 -69%)：默认止损改 20 => -20%。.env 显式 LIVE_SL_PRICE_SCALE 仍优先。
    stopLossScale: env.LIVE_SL_PRICE_SCALE || "20",
    // 止盈模式：ladder(默认)=分批出本+剩余 GMGN 原生追踪止盈(profit_stop_trace)；legacy=旧的全仓一次性止盈(LIVE_TP_PRICE_SCALE)。
    // 全部走 --sell-ratio-type hold_amount：每腿按触发时的剩余持仓计算 sell_ratio。
    takeProfitMode: env.LIVE_TP_MODE === "legacy" ? "legacy" : "ladder",
    principalTpScale: env.LIVE_TP1_PRICE_SCALE || "40",      // 出本腿：+40% 触发
    principalSellRatio: env.LIVE_TP1_SELL_RATIO || "50",     // 出本腿：卖出 50% 持仓
    trailActivateScale: env.LIVE_TRAIL_PRICE_SCALE || "100", // 追踪腿：涨到 +100% 后激活追踪
    trailDrawdownRate: env.LIVE_TRAIL_DRAWDOWN_RATE || "30", // 追踪腿：从激活后最高价回撤 30% 卖出剩余全部
    killFile: path.join(dataDir, "live-kill"),
    ledgerPath: path.join(dataDir, "live-gmgn-ledger.json"),
    spendAsset: (env.LIVE_SPEND_ASSET || "bnb").toLowerCase(),
    gasReserveBnb: num(env.LIVE_GAS_RESERVE_BNB, 0.02),
    crossChainEnabled: env.LIVE_CROSS_CHAIN_ENABLED === "true",
    orderPollMs: num(env.LIVE_ORDER_POLL_MS, 2000),
    orderPollMax: num(env.LIVE_ORDER_POLL_MAX, 30),
    // BSC condition-orders require --gas-price (gwei).
    gasPriceGwei: num(env.LIVE_GAS_PRICE_GWEI, 1),
    // Live-only permission, separate from paper: comma list of paper strategyId, "*" = any.
    strategyAllowlist: (env.LIVE_STRATEGY_ALLOWLIST || "*").split(",").map((x) => x.trim()).filter(Boolean),
    // Paper signal must reach the submit step within this age.
    maxSignalAgeMs: num(env.LIVE_MAX_SIGNAL_AGE_MS, 90_000),
    // H4: re-quote via `gmgn-cli order quote` right before submit; refuse on failure/bad fill.
    preSubmitQuote: env.LIVE_PRESUBMIT_QUOTE !== "false",
    maxQuoteLoss: num(env.LIVE_MAX_QUOTE_LOSS, 0.25),      // amount_out_usd/amount_in_usd >= 1-x
    maxPriceChase: num(env.LIVE_MAX_PRICE_CHASE, 0.5),     // quote price <= paper price*(1+x)
    // H1: poll GMGN strategy (TP/SL) orders to close positions and book realized PnL.
    closeSyncMs: num(env.LIVE_CLOSE_SYNC_MS, 60_000),
    // H2: live-only evidence gate in mirror (stricter than paper). Default ON.
    requireEvidence: env.LIVE_REQUIRE_EVIDENCE !== "false",
    maxTaxRate: num(env.LIVE_MAX_TAX_RATE, 0.06),
    maxEvidencePriceAgeMs: num(env.LIVE_MAX_EVIDENCE_PRICE_AGE_MS, 60_000),
    lockPath: path.join(dataDir, "live-gmgn-ledger.lock"),
    journalPath: path.join(dataDir, "live-orders.jsonl"),
    // AUTH_IP_BLOCKED circuit breaker: persisted; new orders stop until cooldown, then one probe.
    breakerPath: path.join(dataDir, "live-breaker.json"),
    ipBlockCooldownMs: num(env.LIVE_IP_BLOCK_COOLDOWN_MS, 30 * 60_000),
  };
}

const today = (now) => new Date(now).toISOString().slice(0, 10);
// Statuses that hold a reservation against caps. "submitting"/"uncertain" also block new orders
// until reconciled: a real position may exist that we cannot see.
export const RESERVING_STATUSES = new Set(["submitting", "pending", "uncertain", "open"]);
export const BLOCKING_STATUSES = new Set(["submitting", "uncertain"]);

// Missing file = fresh empty ledger. Unreadable/corrupt ledger THROWS: never treat as flat.
export function readLedger(p, fsx = fs) {
  let text;
  try { text = fsx.readFileSync(p, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return { positions: [], realized: {} };
    throw new Error(`live ledger unreadable: ${e.message}`);
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`live ledger corrupt: ${e.message}`); }
  if (!j || typeof j !== "object" || !Array.isArray(j.positions)) throw new Error("live ledger corrupt: positions missing");
  return { positions: j.positions, realized: j.realized && typeof j.realized === "object" ? j.realized : {} };
}
// Lenient reader for display-only callers (studio). Never use for gating.
export function readLedgerForDisplay(p, fsx = fs) {
  try { return readLedger(p, fsx); } catch (e) { return { positions: [], realized: {}, error: e.message }; }
}
export function writeLedgerAtomic(p, ledger, fsx = fs) {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fsx.writeFileSync(tmp, JSON.stringify({ positions: ledger.positions, realized: ledger.realized || {} }, null, 2));
  fsx.renameSync(tmp, p);
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// Cross-process exclusive lock (O_EXCL lock file). Stale if holder pid is dead or is us
// (callers already serialize in-process, so a lock "held by us" is a leftover from a reused pid).
export async function withLedgerLock(lockPath, fn, { fsx = fs, wait = sleep, timeoutMs = 240_000, now = Date.now } = {}) {
  const start = now();
  for (;;) {
    try {
      const fd = fsx.openSync(lockPath, "wx");
      try { fsx.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() })); } finally { fsx.closeSync(fd); }
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      let holder = null;
      try { holder = JSON.parse(fsx.readFileSync(lockPath, "utf8")); } catch {}
      const stale = holder?.pid ? (holder.pid === process.pid || !pidAlive(holder.pid)) : (now() - start > 5_000);
      if (stale) { try { fsx.unlinkSync(lockPath); } catch {} continue; }
      if (now() - start > timeoutMs) throw new Error("live ledger lock timeout");
      await wait(250);
    }
  }
  try { return await fn(); } finally { try { fsx.unlinkSync(lockPath); } catch {} }
}

const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));
// Pure gate check. Returns {ok:true} or {ok:false, reason}.
export function checkGates(cfg, order, state, { now = Date.now(), fsx = fs } = {}) {
  if (cfg.enabled !== true) return { ok: false, reason: "LIVE_TRADING_ENABLED is not true" };
  if (fsx.existsSync(cfg.killFile)) return { ok: false, reason: "kill switch present" };
  if (cfg.unsupported || (cfg.chains && !cfg.chains.includes(cfg.chain))) return { ok: false, reason: `chain ${cfg.chain} not enabled for live` };
  if (cfg.chain === "sol") { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cfg.wallet || "")) return { ok: false, reason: "LIVE_SOL_WALLET invalid" }; }
  else if (!/^0x[0-9a-f]{40}$/.test(cfg.wallet)) return { ok: false, reason: "LIVE_WALLET invalid" };
  if (order.source !== cfg.signalSource) return { ok: false, reason: `signal source ${order.source} not allowed` };
  if (/narrative/i.test(order.source || "") || /narrative/i.test(order.paperSessionId || "") || /narrative/i.test(order.paperStrategyId || "")) return { ok: false, reason: "narrative signals are shadow-only" };
  const allow = cfg.strategyAllowlist || ["*"];
  if (!allow.includes("*") && !allow.includes(String(order.paperStrategyId || ""))) return { ok: false, reason: `paper strategy ${order.paperStrategyId || "?"} not in LIVE_STRATEGY_ALLOWLIST` };
  if (order.signalAt != null) {
    const age = now - Number(order.signalAt);
    if (!Number.isFinite(age) || age > (cfg.maxSignalAgeMs ?? 90_000)) return { ok: false, reason: `stale signal (${Math.round(age / 1000)}s old)` };
  }
  const usd = Number(order.usd);
  if (!(usd > 0) || !Number.isFinite(usd)) return { ok: false, reason: "invalid order size" };
  if (usd > cfg.maxPerTradeUsd) return { ok: false, reason: "exceeds LIVE_MAX_PER_TRADE_USD" };
  const positions = state.positions || [];
  const blocking = positions.filter((p) => BLOCKING_STATUSES.has(p.status));
  if (blocking.length) return { ok: false, reason: `unresolved live order (${blocking.map((p) => `${p.status}:${p.orderId || p.id || p.token}`).join(",")}); reconcile first` };
  const held = positions.filter((p) => RESERVING_STATUSES.has(p.status));
  if (held.length >= cfg.maxOpenPositions) return { ok: false, reason: "max open positions" };
  const exposure = held.reduce((s, p) => s + Number(p.usd || 0), 0);
  if (!Number.isFinite(exposure)) return { ok: false, reason: "ledger exposure invalid" };
  if (exposure + usd > cfg.maxTotalUsd) return { ok: false, reason: "exceeds LIVE_MAX_TOTAL_USD" };
  const pnl = Number(state.realized?.[today(now)] || 0);
  if (!Number.isFinite(pnl) || pnl <= -cfg.dailyLossStopUsd) return { ok: false, reason: "daily loss stop hit" };
  // Balance is mandatory and must be a finite, non-negative number (NaN/missing => refuse).
  if (!finite(state.balanceUsd) || Number(state.balanceUsd) < 0) return { ok: false, reason: "balance unavailable" };
  if (usd > Number(state.balanceUsd)) return { ok: false, reason: "insufficient balance" };
  if (cfg.spendAsset === "sol") {
    if (!(Number(order.solPriceUsd) > 0) || !Number.isFinite(Number(order.solPriceUsd))) return { ok: false, reason: "SOL price unavailable" };
    const tip = Number(cfg.solTipFee), prio = Number(cfg.solPriorityFee);
    if (!(tip >= 0.00001 && tip <= 0.01) || !(prio > 0 && prio <= 0.01)) return { ok: false, reason: "invalid SOL tip/priority fee config" };
    if (state.balanceSol != null && !finite(state.balanceSol)) return { ok: false, reason: "SOL balance invalid" };
    if (state.balanceSol != null && usd / Number(order.solPriceUsd) + tip + prio > Number(state.balanceSol) - cfg.gasReserveSol) return { ok: false, reason: "insufficient SOL after fee reserve" };
  }
  if (cfg.spendAsset === "bnb") {
    if (!(Number(order.bnbPriceUsd) > 0) || !Number.isFinite(Number(order.bnbPriceUsd))) return { ok: false, reason: "BNB price unavailable" };
    if (state.balanceBnb != null) {
      if (!finite(state.balanceBnb)) return { ok: false, reason: "BNB balance invalid" };
      const spendable = Number(state.balanceBnb) - cfg.gasReserveBnb;
      if (usdToBnb(usd, order.bnbPriceUsd) > spendable) return { ok: false, reason: "insufficient BNB after gas reserve" };
    }
  }
  if (!cfg.autoSlippage && Number(order.slippage ?? cfg.maxSlippage) > cfg.maxSlippage) {
    return { ok: false, reason: "slippage above max" };
  }
  return { ok: true };
}


// H2: live-only evidence gate, at least as strict as paper and stricter on audits:
// paper may trade with missing auxiliary audits / unknown sellability; live may not.
const RELAXED_SAFETY = /monitored_paper_unknown_audit|aux_audit/i;
export function checkLiveEvidence(cfg, ev, { now = Date.now() } = {}) {
  if (!ev || typeof ev !== "object") return { ok: false, reason: "no paper entry evidence" };
  if (ev.paperEligible !== true) return { ok: false, reason: "paper evidence not eligible" };
  if (ev.entryPlan && ev.entryPlan.eligible === false) return { ok: false, reason: "entry plan not eligible" };
  if (ev.priceFresh === false || ev.marketFresh === false) return { ok: false, reason: "paper price/market not fresh" };
  const at = Date.parse(ev.priceObservedAt || "");
  if (!Number.isFinite(at) || now - at > (cfg.maxEvidencePriceAgeMs ?? 60_000)) return { ok: false, reason: "paper price observation too old/missing" };
  const sf = ev.safety;
  if (!sf || typeof sf !== "object") return { ok: false, reason: "no safety evidence" };
  if ((sf.missing || []).length) return { ok: false, reason: `safety fields missing: ${sf.missing.join("/")}` };
  if ((sf.blocked || []).length) return { ok: false, reason: `safety blocked: ${sf.blocked.join("/")}` };
  if ((sf.auditMissing || []).length) return { ok: false, reason: `audit missing (paper-only relaxation): ${sf.auditMissing.join("/")}` };
  if ((sf.warnings || []).length) return { ok: false, reason: `safety warnings: ${sf.warnings.join("/")}` };
  if (RELAXED_SAFETY.test(sf.policyVersion || "")) return { ok: false, reason: `relaxed paper safety policy ${sf.policyVersion}` };
  if (sf.sellabilityVerified === false) return { ok: false, reason: "sellability not verified" };
  if (sf.sellabilityFlags?.cannotSell === true || sf.sellabilityFlags?.canSell === false) return { ok: false, reason: "token flagged unsellable" };
  const tf = sf.taxFilter;
  if (tf?.blocked === true) return { ok: false, reason: "tax filter blocked" };
  const maxTax = cfg.maxTaxRate ?? 0.06;
  for (const k of ["buyTax", "sellTax"]) {
    const v = sf.metrics?.[k] ?? tf?.[k];
    if (v == null || !Number.isFinite(Number(v))) return { ok: false, reason: `${k} unknown` };
    if (Number(v) > maxTax) return { ok: false, reason: `${k} ${v} > ${maxTax}` };
  }
  return { ok: true };
}

// H4: fresh executable quote right before submit.
export async function preSubmitQuote(cfg, order, { run = runCli } = {}) {
  const a = buildSwapArgs(cfg, order);
  const get = (k) => a[a.indexOf(k) + 1];
  let r;
  try { r = await run(["order", "quote", "--chain", cfg.chain, "--from", cfg.wallet, "--input-token", get("--input-token"), "--output-token", order.token, "--amount", get("--amount"), "--slippage", String(cfg.maxSlippage || 30), "--raw"]); }
  catch (e) { return { ok: false, reason: `pre-submit quote failed: ${String(e.message).slice(0, 200)}` }; }
  const q = r?.raw || {};
  const out = Number(q.output_amount ?? q.tx?.amount_out);
  if (!(out > 0)) return { ok: false, reason: "pre-submit quote has no output" };
  const inUsd = Number(q.amount_in_usd), outUsd = Number(q.amount_out_usd);
  if (inUsd > 0 && Number.isFinite(outUsd) && outUsd / inUsd < 1 - (cfg.maxQuoteLoss ?? 0.25)) return { ok: false, reason: `quote loss too high (${outUsd.toFixed(2)}/${inUsd.toFixed(2)} USD)` };
  const px = Number(q.token_out_usd_price), paper = Number(order.paperPrice);
  if (paper > 0 && px > paper * (1 + (cfg.maxPriceChase ?? 0.5))) return { ok: false, reason: `price ran ${((px / paper - 1) * 100).toFixed(0)}% above paper entry` };
  return { ok: true, quote: { outputAmount: q.output_amount, amountInUsd: inUsd, amountOutUsd: outUsd, tokenUsdPrice: px, at: Date.now() } };
}

const sameToken = (chain, a, b) => chain === "sol" ? String(a) === String(b) : String(a || "").toLowerCase() === String(b || "").toLowerCase();
const listStrategy = async (run, chain, wallet, type) => {
  const r = await run(["order", "strategy", "list", "--chain", chain, "--type", type, "--group-tag", "STMix", "--from", wallet, "--limit", "100", "--raw"]);
  const list = r?.raw?.list;
  if (!Array.isArray(list)) throw new Error(`strategy list ${type} malformed`);
  return list;
};
// Match the GMGN TP/SL strategy order created by our swap: same token, created near our buy.
export function matchStrategy(p, list) {
  const t0 = Number(p.at || 0) - 300_000, t1 = Number(p.confirmedAt || p.at || 0) + 300_000;
  return list.filter((o) => sameToken(p.chain, o.base_token, p.token) && Number(o.create_time) >= t0 && Number(o.create_time) <= t1)
    .sort((x, y) => Number(y.create_time) - Number(x.create_time))[0] || null;
}
// Realized PnL of a finished strategy order. Unknown => conservative full loss (keeps daily stop safe).
export function strategyPnl(p, o) {
  const st = o.order_statistic || {};
  const prof = Number(st.usdt_profit);
  if (Number(st.success_sell_num) > 0 && Number.isFinite(prof)) return { pnl: prof, estimated: null };
  return { pnl: -Number(p.usd || 0), estimated: "conservative_full_loss" };
}
// Sell-side detail of a finished strategy order (GMGN strategy history). GMGN's list does not
// return the sell tx hash today (close_sign_hash is empty), so sellTxHash is usually null.
// fill = triggered condition order usdt_price; slippage is fill vs trigger check_price (gap+slippage).
export function strategyCloseDetail(o) {
  const n = (v) => { const x = Number(v); return v !== "" && v != null && Number.isFinite(x) ? x : null; };
  const trig = (o?.condition_orders || []).find((c) => c.status === "success") || null;
  const triggerPrice = n(trig?.check_price), fill = n(trig?.usdt_price) ?? n(o?.close_price);
  const open = n(o?.open_price) ?? n(o?.order_statistic?.buy_usdt_price);
  return {
    sellTxHash: o?.close_sign_hash || o?.close_hash || o?.sell_hash || null,
    closeTrigger: trig?.order_type || o?.place_action || null,
    closePriceScale: trig?.price_scale ?? null,
    openPriceUsd: open, triggerPriceUsd: triggerPrice, fillPriceUsd: fill,
    fillVsTrigger: fill != null && triggerPrice ? fill / triggerPrice - 1 : null,
    fillVsOpen: fill != null && open ? fill / open - 1 : null,
    sellSlippageSetting: o?.sell_param?.slippage ?? o?.slippage ?? null,
    sellAutoSlippage: o?.sell_param?.auto_slippage ?? o?.auto_slippage ?? null,
    soldAmount: o?.order_statistic?.success_sell_amount ?? null,
    triggerTime: n(trig?.trigger_time),
    // 分批模式下可能多腿成交：列出全部已成交腿（出本/追踪/止损）。
    closeLegs: (o?.condition_orders || []).filter((c) => c.status === "success").map((c) => ({ type: c.order_type, priceScale: c.price_scale ?? null, sellRatio: c.sell_ratio ?? null, drawdownRate: c.drawdown_rate || null, fillPriceUsd: n(c.usdt_price), triggerTime: n(c.trigger_time) })),
  };
}

export const usdToBnb = (usd, priceUsd) => Number(usd) / Number(priceUsd);
// USD size -> raw wei of BNB (18 decimals), floored to 1e-9 BNB precision.
export function usdToBnbWei(usd, priceUsd) {
  const gwei = Math.floor(usdToBnb(usd, priceUsd) * 1e9);
  return BigInt(gwei) * 10n ** 9n;
}

export const usdToLamports = (usd, priceUsd) => BigInt(Math.floor((Number(usd) / Number(priceUsd)) * 1e9));

// TP/SL legs attached to the buy. ladder: 出本 profit_stop(部分) + 剩余 profit_stop_trace(原生追踪) + 全仓 loss_stop。
export function buildConditionOrders(cfg) {
  const sl = { order_type: "loss_stop", side: "sell", price_scale: String(cfg.stopLossScale ?? "20"), sell_ratio: "100" };
  if (cfg.takeProfitMode === "legacy") return [{ order_type: "profit_stop", side: "sell", price_scale: String(cfg.takeProfitScale ?? "150"), sell_ratio: "100" }, sl];
  return [
    { order_type: "profit_stop", side: "sell", price_scale: String(cfg.principalTpScale ?? "40"), sell_ratio: String(cfg.principalSellRatio ?? "50") },
    { order_type: "profit_stop_trace", side: "sell", price_scale: String(cfg.trailActivateScale ?? "100"), sell_ratio: "100", drawdown_rate: String(cfg.trailDrawdownRate ?? "30") },
    sl,
  ];
}

export function buildSwapArgs(cfg, order) {
  const bnb = cfg.spendAsset === "bnb";
  const sol = cfg.spendAsset === "sol";
  const raw = sol ? usdToLamports(order.usd, order.solPriceUsd) : bnb ? usdToBnbWei(order.usd, order.bnbPriceUsd)
    : BigInt(Math.round(Number(order.usd) * 1e6)) * 10n ** 12n; // USDT BSC has 18 decimals
  const args = ["swap", "--chain", cfg.chain, "--from", cfg.wallet,
    "--input-token", order.inputToken || (sol ? SOL_NATIVE : bnb ? BSC_NATIVE_BNB : BSC_USDT), "--output-token", order.token,
    "--amount", raw.toString(),
    "--condition-orders", JSON.stringify(buildConditionOrders(cfg)), "--yes", "--raw"];
  if (cfg.takeProfitMode !== "legacy") args.push("--sell-ratio-type", "hold_amount");
  // Percent slippage (30=30%) OR --auto-slippage. Never pass fraction like 0.01.
  if (cfg.autoSlippage) args.push("--auto-slippage");
  else args.push("--slippage", String(clamp(Number(order.slippage ?? cfg.maxSlippage), 10, 30)));
  // BSC + condition-orders requires --gas-price (gwei).
  if (cfg.chain === "bsc") args.push("--gas-price", String(order.gasPriceGwei ?? cfg.gasPriceGwei ?? 1));
  // SOL + condition-orders requires both --priority-fee and --tip-fee (>= 0.00001 SOL).
  if (cfg.chain === "sol") args.push("--priority-fee", String(cfg.solPriorityFee || "0.0001"), "--tip-fee", String(cfg.solTipFee || "0.00001"));
  if (cfg.antiMev) args.push("--anti-mev");
  return args;
}

const trimResult = (r) => r && ({ orderId: r.orderId, status: r.status, raw: r.raw ?? r.final?.raw ?? null, submitRaw: r.submit?.raw ?? null });
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// State machine per order: submitting -> pending(orderId) -> open | failed | uncertain.
// Every transition is persisted (atomic write) and journaled BEFORE the next side effect.
// All buys are serialized in-process and across processes (ledger lock); caps are checked
// inside the lock against reserved (submitting/pending/uncertain/open) positions.
const IN_PROCESS_QUEUES = new Map();
export function createLiveTrader(baseCfg = loadLiveConfig(), { run = runCli, fsx = fs, log = console, wait = sleep, now = Date.now } = {}) {
  const cfg = baseCfg;
  const lockPath = cfg.lockPath || `${cfg.ledgerPath}.lock`;
  const journalPath = cfg.journalPath || path.join(path.dirname(cfg.ledgerPath), "live-orders.jsonl");
  let haltReason = null;
  // One in-process queue per ledger lock, shared by every trader instance in this process,
  // so the file lock's "held by our own pid = stale" rule is always sound.
  const serial = (fn) => { const tail = IN_PROCESS_QUEUES.get(lockPath) || Promise.resolve(); const r = tail.then(fn); IN_PROCESS_QUEUES.set(lockPath, r.catch(() => {})); return r; };
  const locked = (fn) => serial(() => withLedgerLock(lockPath, fn, { fsx, wait, now }));
  const journal = (e) => { try { fsx.appendFileSync(journalPath, JSON.stringify({ at: new Date(now()).toISOString(), ...e }) + "\n"); } catch {} };
  const persist = (ledger, why) => {
    try { writeLedgerAtomic(cfg.ledgerPath, ledger, fsx); return true; } catch (e) {
      haltReason = `ledger write failed (${why}): ${e.message}`;
      journal({ kind: "ledger_write_failed", why, error: e.message, positions: ledger.positions });
      log.error?.(`[live-gmgn] ${haltReason} — live halted in this process`);
      return false;
    }
  };
  const queryOrder = async (chain, orderId) => {
    const r = await run(["order", "get", "--chain", chain, "--order-id", String(orderId), "--raw"]);
    return String(extractOrderStatus(r.raw) || "").toLowerCase();
  };
  // Resolve pending/uncertain orders that have an orderId; orphaned "submitting" (crash
  // between persist and submit result) becomes "uncertain" and keeps blocking until manual resolve.
  async function reconcileLocked(ledger) {
    let changed = false;
    for (const p of ledger.positions) {
      if (p.status === "submitting") { p.status = "uncertain"; p.note = "found submitting at reconcile (crash?); check GMGN/chain then resolve"; changed = true; }
      if ((p.status === "pending" || p.status === "uncertain") && p.orderId) {
        let st = "";
        try { st = await queryOrder(p.chain, p.orderId); } catch (e) { log.warn?.(`[live-gmgn] reconcile ${p.orderId} query failed: ${e.message}`); if (/AUTH_IP_BLOCKED|source ip blocked/i.test(e.message || "")) armBreaker(e.message); continue; }
        const next = TERMINAL_OK.has(st) ? "open" : TERMINAL_BAD.has(st) ? "failed" : null;
        if (!next) continue;
        p.status = next; p.reconciledAt = now(); changed = true;
        journal({ kind: "reconcile", id: p.id, orderId: p.orderId, status: p.status, gmgn: st });
      }
    }
    if (changed && !persist(ledger, "reconcile")) throw new Error(haltReason);
    return ledger;
  }
  async function syncClosedLocked(ledger) {
    const open = ledger.positions.filter((p) => p.status === "open");
    if (!open.length) return { closed: [] };
    const closed = [];
    for (const chain of [...new Set(open.map((p) => p.chain))]) {
      const wallet = chainCfg(baseCfg, chain).wallet;
      if (!wallet) continue;
      const [running, history] = await Promise.all([listStrategy(run, chain, wallet, "open"), listStrategy(run, chain, wallet, "history")]);
      for (const p of open.filter((x) => x.chain === chain)) {
        if (matchStrategy(p, running)) continue;
        const h = matchStrategy(p, history);
        if (!h) continue;
        const { pnl, estimated } = strategyPnl(p, h);
        const at = Number(h.close_time) > 0 ? Number(h.close_time) : now();
        p.status = "closed"; p.closedAt = at; p.realizedPnlUsd = pnl; p.pnlEstimate = estimated;
        p.strategyOrderId = h.order_id; p.closeReason = h.reason_by || h.strategy_status || h.status;
        const detail = strategyCloseDetail(h); p.closeDetail = detail;
        const d = today(at); ledger.realized[d] = Number(ledger.realized[d] || 0) + pnl;
        journal({ kind: "closed", id: p.id, orderId: p.orderId, chain: p.chain, strategyOrderId: h.order_id, pnl, estimated, reason: p.closeReason, ...detail });
        closed.push({ id: p.id, token: p.token, chain: p.chain, pnl, estimated, strategyOrderId: h.order_id, closeReason: p.closeReason, ...detail });
      }
    }
    if (closed.length && !persist(ledger, "close-sync")) throw new Error(haltReason);
    return { closed };
  }
  const breakerPath = cfg.breakerPath || path.join(path.dirname(cfg.ledgerPath), "live-breaker.json");
  const readBreaker = () => { try { return JSON.parse(fsx.readFileSync(breakerPath, "utf8")); } catch { return null; } };
  const armBreaker = (reason) => {
    const prev = readBreaker();
    const b = { kind: "ip_blocked", reason: String(reason).slice(0, 300), at: now(), until: now() + (cfg.ipBlockCooldownMs ?? 1_800_000), hits: (prev?.hits || 0) + 1 };
    try { fsx.writeFileSync(breakerPath, JSON.stringify(b, null, 2)); } catch {}
    journal({ kind: "breaker_armed", ...b });
    log.error?.(`[live-gmgn] AUTH_IP_BLOCKED → circuit breaker armed until ${new Date(b.until).toISOString()}`);
  };
  const clearBreaker = () => { if (readBreaker()) { try { fsx.unlinkSync(breakerPath); } catch {} journal({ kind: "breaker_cleared" }); } };
  async function buyLocked(order, extraState) {
    const ccfg = chainCfg(baseCfg, order.chain || baseCfg.chain);
    const refuse = (reason) => { log.warn?.(`[live-gmgn] refused: ${reason}`); return { ok: false, reason }; };
    if (haltReason) return refuse(`live halted: ${haltReason}`);
    const br = readBreaker();
    if (br && now() < Number(br.until)) return refuse(`IP blocked circuit breaker until ${new Date(br.until).toISOString()} (${br.hits}x)`);
    let ledger;
    try { ledger = readLedger(cfg.ledgerPath, fsx); } catch (e) { return refuse(`${e.message}; refusing live trades`); }
    const pre = checkGates(ccfg, order, { ...ledger, ...extraState, positions: [] }, { fsx, now: now() });
    if (!pre.ok) return refuse(pre.reason); // cheap gates first, no CLI
    if (br || ledger.positions.some((p) => BLOCKING_STATUSES.has(p.status) || p.status === "pending")) {
      try { ledger = await reconcileLocked(ledger); } catch (e) { return refuse(`reconcile failed: ${e.message}`); }
    }
    // Book TP/SL closes first so freed slots and realized losses feed the gates.
    try { await syncClosedLocked(ledger); } catch (e) { log.warn?.(`[live-gmgn] close sync failed (positions stay open/counted): ${e.message}`); }
    const gate = checkGates(ccfg, order, { ...extraState, ...ledger }, { fsx, now: now() });
    if (!gate.ok) return refuse(gate.reason);
    let quote = null;
    if (cfg.preSubmitQuote !== false) {
      const q = await preSubmitQuote(ccfg, order, { run });
      if (!q.ok) return refuse(q.reason);
      quote = q.quote;
      // Clock may have moved while quoting; recheck signal age.
      const again = checkGates(ccfg, order, { ...extraState, ...ledger }, { fsx, now: now() });
      if (!again.ok) return refuse(again.reason);
    }
    const pos = {
      id: newId(), token: order.token, chain: ccfg.chain, usd: Number(order.usd), asset: ccfg.spendAsset,
      sol: order.solPriceUsd && ccfg.chain === "sol" ? Number(order.usd) / order.solPriceUsd : undefined, solPriceUsd: order.solPriceUsd,
      bnb: order.bnbPriceUsd ? usdToBnb(order.usd, order.bnbPriceUsd) : undefined, bnbPriceUsd: order.bnbPriceUsd,
      source: order.source, paperStrategyId: order.paperStrategyId, paperSessionId: order.paperSessionId, paperTradeId: order.paperTradeId,
      status: "submitting", at: now(), quote,
    };
    ledger.positions.push(pos);
    journal({ kind: "submitting", ...pos });
    if (!persist(ledger, "reserve")) return refuse(`could not reserve before submit: ${haltReason}`);
    let confirmed;
    try {
      confirmed = await submitAndConfirm(ccfg, order, { run, wait, log, onSubmitted: (orderId) => {
        pos.orderId = orderId; pos.status = "pending";
        journal({ kind: "pending", id: pos.id, orderId });
        persist(ledger, "pending");
      } });
    } catch (e) {
      if (/AUTH_IP_BLOCKED|source ip blocked/i.test(e.message || "")) armBreaker(e.message);
      const state = e.orderState || "uncertain";
      pos.status = state === "uncertain" ? "uncertain" : "failed";
      pos.error = String(e.message || e).slice(0, 600);
      if (e.orderId && !pos.orderId) pos.orderId = e.orderId;
      journal({ kind: pos.status, id: pos.id, orderId: pos.orderId, error: pos.error });
      persist(ledger, pos.status);
      throw e;
    }
    if (br) clearBreaker(); // probe after cooldown succeeded
    pos.status = "open"; pos.orderId = confirmed.orderId; pos.result = trimResult(confirmed); pos.confirmedAt = now();
    journal({ kind: "open", id: pos.id, orderId: pos.orderId, status: confirmed.status });
    const wrote = persist(ledger, "confirmed");
    return { ok: true, result: confirmed, positionId: pos.id, ...(wrote ? {} : { ledgerWriteError: haltReason }) };
  }
  return {
    enabled: cfg.enabled,
    get haltReason() { return haltReason; },
    breaker: () => readBreaker(),
    describe: () => `[live-gmgn] ${cfg.enabled ? "ENABLED" : "disabled"} chains=${(cfg.chains || [cfg.chain]).join(",")} sol=${cfg.solWallet || "-"} maxTotal=${cfg.maxTotalUsd} perTrade=${cfg.maxPerTradeUsd} asset=${cfg.spendAsset} gasReserve=${cfg.gasReserveBnb}BNB slippage=${cfg.autoSlippage ? "auto" : cfg.maxSlippage + "%"} source=${cfg.signalSource}`,
    async buy(order, extraState = {}) {
      if (cfg.enabled !== true) return { ok: false, reason: "LIVE_TRADING_ENABLED is not true" };
      return locked(() => buyLocked(order, extraState));
    },
    // Startup / on-demand reconciliation of pending/uncertain orders.
    reconcile: () => locked(async () => { const l = await reconcileLocked(readLedger(cfg.ledgerPath, fsx)); return l.positions.filter((p) => RESERVING_STATUSES.has(p.status) && p.status !== "open"); }),
    syncClosed: () => locked(async () => syncClosedLocked(readLedger(cfg.ledgerPath, fsx))),
    // Close an open position and book realized PnL into today's bucket (feeds daily loss stop).
    closePosition: ({ id, orderId, token, proceedsUsd, feesUsd = 0, at = now() }) => locked(async () => {
      const ledger = readLedger(cfg.ledgerPath, fsx);
      const p = ledger.positions.find((x) => x.status === "open" && ((id && x.id === id) || (orderId && x.orderId === orderId) || (!id && !orderId && token && x.token === token)));
      if (!p) return { ok: false, reason: "open position not found" };
      if (!Number.isFinite(Number(proceedsUsd)) || Number(proceedsUsd) < 0) return { ok: false, reason: "invalid proceedsUsd" };
      const pnl = Number(proceedsUsd) - Number(feesUsd || 0) - Number(p.usd || 0);
      p.status = "closed"; p.closedAt = at; p.proceedsUsd = Number(proceedsUsd); p.realizedPnlUsd = pnl;
      const d = today(at); ledger.realized[d] = Number(ledger.realized[d] || 0) + pnl;
      journal({ kind: "closed", id: p.id, orderId: p.orderId, pnl });
      if (!persist(ledger, "close")) return { ok: false, reason: haltReason };
      return { ok: true, pnl };
    }),
    // Manual resolution of an uncertain order after checking GMGN/chain by hand.
    resolve: ({ id, status }) => locked(async () => {
      if (!["open", "failed"].includes(status)) return { ok: false, reason: "status must be open|failed" };
      const ledger = readLedger(cfg.ledgerPath, fsx);
      const p = ledger.positions.find((x) => x.id === id || x.orderId === id);
      if (!p) return { ok: false, reason: "not found" };
      p.status = status; p.resolvedAt = now(); p.note = `${p.note || ""} manual resolve`.trim();
      journal({ kind: "resolve", id: p.id, orderId: p.orderId, status });
      return persist(ledger, "resolve") ? { ok: true } : { ok: false, reason: haltReason };
    }),
  };
}

export function tryParseJson(text = "") {
  const s = String(text || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}

export function extractOrderId(raw) {
  if (!raw || typeof raw !== "object") return null;
  return raw.order_id || raw.orderId || raw.result?.order_id || raw.data?.order_id || null;
}

export function extractOrderStatus(raw) {
  if (!raw || typeof raw !== "object") return null;
  return raw.status || raw.result?.status || raw.data?.status || null;
}

export function extractApiError(raw, stderr = "") {
  const parts = [];
  if (raw && typeof raw === "object") {
    const code = raw.code ?? raw.error_code ?? raw.result?.error_code ?? raw.error?.code;
    const err = raw.error ?? raw.error_status ?? raw.message ?? raw.result?.error_status;
    if (code != null && String(code) !== "0") parts.push(`code=${code}`);
    if (err) parts.push(typeof err === "string" ? err : JSON.stringify(err));
    if (raw.error_code && !String(parts).includes(String(raw.error_code))) parts.push(`error_code=${raw.error_code}`);
  }
  if (/AUTH_IP_BLOCKED|source ip blocked/i.test(stderr)) {
    const m = stderr.match(/source ip blocked\s+(\S+)/i);
    parts.push(`AUTH_IP_BLOCKED${m ? ` ip=${m[1]}` : ""}`);
  }
  return parts.filter(Boolean).join(" | ") || null;
}

const TERMINAL_OK = new Set(["confirmed", "successful", "success"]);
const TERMINAL_BAD = new Set(["failed", "expired", "error"]);
const tagged = (msg, orderState, orderId) => Object.assign(new Error(msg), { orderState, orderId });
// orderState on thrown errors: "rejected" (never accepted), "failed" (terminal bad), "uncertain" (may have filled).
export async function submitAndConfirm(cfg, order, { run = runCli, wait = sleep, log = console, onSubmitted } = {}) {
  let submit;
  try { submit = await run(buildSwapArgs(cfg, order)); } catch (e) {
    throw tagged(e.message, e.apiError || /HTTP 4\d\d/.test(e.message || "") ? "rejected" : "uncertain");
  }
  const orderId = extractOrderId(submit.raw) || submit.orderId;
  if (!orderId) {
    const apiErr = extractApiError(submit.raw, submit.stderr);
    throw tagged(`swap returned no order_id | ${summarizeCli(submit)}`, apiErr ? "rejected" : "uncertain");
  }
  try { onSubmitted?.(orderId, submit); } catch {}
  let last = submit;
  for (let i = 0; ; i++) {
    // Always judge the latest result, including the final poll.
    const st = String(extractOrderStatus(last.raw) || "").toLowerCase();
    if (st && TERMINAL_OK.has(st)) {
      return { orderId, status: extractOrderStatus(last.raw), submit, final: last, raw: last.raw, stdout: last.stdout, stderr: last.stderr };
    }
    if (st && TERMINAL_BAD.has(st)) {
      const apiErr = extractApiError(last.raw, last.stderr);
      throw tagged(`order ${orderId} ${st}${apiErr ? `: ${apiErr}` : ""} | ${summarizeCli(last)}`, "failed", orderId);
    }
    if (i >= cfg.orderPollMax) break;
    await wait(cfg.orderPollMs);
    try { last = await run(["order", "get", "--chain", cfg.chain, "--order-id", String(orderId), "--raw"]); }
    catch (e) { last = { raw: null, stderr: e.message }; }
    log.info?.(`[live-gmgn] order ${orderId} poll#${i + 1} status=${extractOrderStatus(last.raw) || "?"}`);
  }
  throw tagged(`order ${orderId} poll timeout after ${cfg.orderPollMax} tries (kept as uncertain for reconcile) | last=${summarizeCli(last)}`, "uncertain", orderId);
}

function summarizeCli(res = {}) {
  const apiErr = extractApiError(res.raw, res.stderr);
  return [
    apiErr,
    res.stderr ? `stderr: ${String(res.stderr).slice(0, 600)}` : "",
    res.stdout ? `stdout: ${String(res.stdout).slice(0, 600)}` : "",
  ].filter(Boolean).join(" | ");
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    // Child env MUST set this even if launchd parent lacks it. --yes alone is not enough.
    const env = { ...process.env, GMGN_ALLOW_AUTOMATED_TRADES: "1" };
    execFile("gmgn-cli", args, { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      const out = String(stdout || "");
      const err = String(stderr || "");
      const raw = tryParseJson(out);
      const apiErr = extractApiError(raw, err);
      const result = { stdout: out, stderr: err, raw, orderId: extractOrderId(raw), status: extractOrderStatus(raw), exitCode: e?.code ?? 0 };
      if (e || apiErr) {
        reject(Object.assign(new Error(cleanCliError(err, out, e, apiErr)), { apiError: apiErr || null, killed: !!e?.killed }));
        return;
      }
      resolve(result);
    });
  });
}

// gmgn-cli always prints a "confirmation required" summary to stderr before trading,
// even on the non-interactive (--yes + GMGN_ALLOW_AUTOMATED_TRADES=1) path. Strip it so the
// logged reason is the REAL failure (API/balance/route/IP error), not the summary banner.
export function cleanCliError(stderr = "", stdout = "", e = {}, apiErr = null) {
  const lines = String(stderr || "").split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/confirmation required|^-{4,}$|^(Chain|Wallet|Input token|Output token|Amount|Slippage):/.test(l)
      && !/Proceeding non-interactively/.test(l));
  const msg = [apiErr, lines.join(" | "), String(stdout || "").trim()].filter(Boolean).join(" | stdout: ");
  return (msg || e.message || "gmgn-cli failed").slice(0, 1200);
}

// Cross-chain top-up: gmgn-cli (checked 2026-11-01) has NO bridge/cross-chain command
// (only swap / multi-swap / order on a single chain). This stub keeps the same gates
// and refuses until a supported route exists; it never moves funds.
export async function crossChainTopUp(cfg, { toChain, usd } = {}, { fsx = fs } = {}) {
  if (cfg.enabled !== true) return { ok: false, reason: "LIVE_TRADING_ENABLED is not true" };
  if (fsx.existsSync(cfg.killFile)) return { ok: false, reason: "kill switch present" };
  if (!cfg.crossChainEnabled) return { ok: false, reason: "LIVE_CROSS_CHAIN_ENABLED is not true" };
  if (!(Number(usd) > 0) || Number(usd) > cfg.maxTotalUsd) return { ok: false, reason: "cross-chain amount outside caps" };
  return { ok: false, reason: `gmgn-cli has no cross-chain/bridge command yet (wanted ${usd} USD to ${toChain})` };
}
