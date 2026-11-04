// Local ladder state for the LIVE mirror of paper-atm-confirmed-pvp-v2.
// The exchange amend lives in gmgn-stop-amend.js. Local price_scale is a
// multiplier of entry/cost and is updated only after that amend succeeds.
//
//   0.8 = the original −20% stop
//   1.4 = the +~40% principal-out (TP1) leg
//   1.0 = breakeven at entry/cost
// Absolute trigger price is entryPrice * price_scale.
// GMGN's own loss_stop price_scale field is a drop percent ("20" = −20%),
// not this multiplier. The amend translates and sends an absolute check price.
// An optional cushion is basis points above cost (100 bps → 1.01).
// price_scale 1 is the entry price. It is not the paper engine's
// fee-adjusted breakeven, which also loads gas and modeled sell friction.

export const LIVE_LADDER_VERSION = "live_ladder_v1";
export const LIVE_LADDER_STOP_PRICE_SCALE = 0.8;
export const LIVE_LADDER_TP1_PRICE_SCALE = 1.4;

function disabled(value) {
  return /^false$/i.test(String(value ?? ""));
}

function cushionBps(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1000) return 0;
  return value;
}

export function liveBreakevenConfig(env = process.env) {
  const enabled = !disabled(env?.LIVE_BREAKEVEN_AFTER_PRINCIPAL);
  const cushion = cushionBps(env?.LIVE_BREAKEVEN_CUSHION_BPS);
  return {
    enabled,
    cushionBps: cushion,
    priceScale: 1 + cushion / 10_000,
    semantics: "price_scale",
  };
}

export function liveStopSlippagePercent(env = process.env) {
  const raw = env?.LIVE_SL_SLIPPAGE_PERCENT;
  if (raw === undefined || raw === null || raw === "") return 15;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) return 15;
  return value;
}

export function createLiveLadder({ entryPrice, chain = null, baseToken = null, quoteToken = null, wallet = null, stopOrderId = null } = {}) {
  const price = Number(entryPrice);
  return {
    version: LIVE_LADDER_VERSION,
    semantics: "price_scale",
    entryPrice: Number.isFinite(price) && price > 0 ? price : null,
    chain, baseToken, quoteToken, wallet, stopOrderId,
    originalStopPriceScale: LIVE_LADDER_STOP_PRICE_SCALE,
    tp1PriceScale: LIVE_LADDER_TP1_PRICE_SCALE,
    stopPriceScale: LIVE_LADDER_STOP_PRICE_SCALE,
    absoluteStopPrice: Number.isFinite(price) && price > 0 ? price * LIVE_LADDER_STOP_PRICE_SCALE : null,
    breakevenApplied: false,
    tp1Status: "open",
    flat: false,
    reason: "TP1/principal-out 未确认，剩余仓位保持原 −20% 止损（price_scale 0.8）",
  };
}

function absoluteStop(entryPrice, priceScale) {
  const price = Number(entryPrice);
  return Number.isFinite(price) && price > 0 && Number.isFinite(priceScale) ? price * priceScale : null;
}

// tp1Confirmed: the principal-out partial has filled.
// remainingQuantity: size still open after that fill. Zero / negative is flat.
// A later call that says TP1 never confirmed does not loosen a stop already
// moved to breakeven.
export function applyPrincipalOutStop(ladder, { tp1Confirmed = false, remainingQuantity = null, entryPrice = null, env = process.env } = {}) {
  const prior = ladder && typeof ladder === "object" ? ladder : createLiveLadder({ entryPrice });
  const price = Number.isFinite(Number(entryPrice)) && Number(entryPrice) > 0 ? Number(entryPrice) : prior.entryPrice;
  const config = liveBreakevenConfig(env);
  const flat = !(Number(remainingQuantity) > 0);
  if (tp1Confirmed !== true) {
    if (prior.breakevenApplied === true) {
      return { ...prior, entryPrice: price, flat, reason: "TP1 已确认，止损保持在成本（price_scale），不退回原深止损" };
    }
    const stopPriceScale = prior.originalStopPriceScale ?? LIVE_LADDER_STOP_PRICE_SCALE;
    return {
      ...prior,
      version: LIVE_LADDER_VERSION,
      semantics: "price_scale",
      entryPrice: price,
      stopPriceScale,
      absoluteStopPrice: absoluteStop(price, stopPriceScale),
      breakevenApplied: false,
      tp1Status: "open",
      flat,
      reason: "TP1/principal-out 未确认，剩余仓位保持原 −20% 止损（price_scale 0.8）",
    };
  }
  if (flat) {
    return {
      ...prior,
      version: LIVE_LADDER_VERSION,
      semantics: "price_scale",
      entryPrice: price,
      stopPriceScale: null,
      absoluteStopPrice: null,
      breakevenApplied: false,
      tp1Status: "confirmed",
      flat: true,
      reason: "本金腿确认后仓位已平，不再挂剩余止损",
    };
  }
  if (!config.enabled) {
    const stopPriceScale = prior.originalStopPriceScale ?? LIVE_LADDER_STOP_PRICE_SCALE;
    return {
      ...prior,
      version: LIVE_LADDER_VERSION,
      semantics: "price_scale",
      entryPrice: price,
      stopPriceScale,
      absoluteStopPrice: absoluteStop(price, stopPriceScale),
      breakevenApplied: false,
      tp1Status: "confirmed",
      flat: false,
      cushionBps: config.cushionBps,
      reason: "本金腿已确认，但 LIVE_BREAKEVEN_AFTER_PRINCIPAL=false，剩余止损保持 price_scale 0.8",
    };
  }
  return {
    ...prior,
    version: LIVE_LADDER_VERSION,
    semantics: "price_scale",
    entryPrice: price,
    originalStopPriceScale: prior.originalStopPriceScale ?? LIVE_LADDER_STOP_PRICE_SCALE,
    tp1PriceScale: prior.tp1PriceScale ?? LIVE_LADDER_TP1_PRICE_SCALE,
    stopPriceScale: config.priceScale,
    absoluteStopPrice: absoluteStop(price, config.priceScale),
    breakevenApplied: true,
    tp1Status: "confirmed",
    flat: false,
    cushionBps: config.cushionBps,
    reason: config.cushionBps
      ? `本金腿已确认，剩余止损上移到成本 + ${config.cushionBps} bps（price_scale ${config.priceScale}，绝对价 = 入场价 × price_scale）`
      : "本金腿已确认，剩余止损上移到入场/成本（price_scale 1，绝对价 = 入场价 × 1；不含纸面手续费上浮）",
  };
}

export function principalOutConfirmed({ entryUsd, returnedUsd, remainingQuantity, explicit = false } = {}) {
  if (!(Number(remainingQuantity) > 0)) return false;
  if (explicit === true) return true;
  return Number.isFinite(Number(entryUsd)) && Number.isFinite(Number(returnedUsd))
    && Number(returnedUsd) + 1e-6 >= Number(entryUsd);
}
