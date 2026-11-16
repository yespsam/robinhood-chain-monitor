// Liquidity-first low-cap swing — PAPER ONLY.
// Pure screening, ranking, swing confirmation, cost identity, and ledger guards.
// This module does not read a wallet, sign, or submit an order. `live` is hard-coded false.
// Nothing here is a claim that the rules make money.

export const STRATEGY_ID = 'paper-lowcap-swing-liquidity';
export const LEGACY_STRATEGY_ID = 'paper-lowcap-swing';
export const LEGACY_DATA_DIR_NAME = 'swing';
export const BAR_MS = 300_000;

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const STABLES_MAJORS = new Set(['USDT', 'USDC', 'BUSD', 'WBNB', 'BNB', 'BTCB', 'BTC', 'ETH', 'WETH', 'FDUSD', 'USD1', 'DAI', 'TUSD', 'UUSD', 'USDB', 'SOL', 'XAUT']);
export const QUOTES = new Set(['USDT', 'WBNB', 'USDC', 'BNB', 'BUSD', 'FDUSD', 'USD1']);

/** live is hard-coded false. SWING_LIVE=true is only a refusal flag. */
export function loadConfig(env = process.env) {
  const e = k => env[`SWING_${k}`];
  return Object.freeze({
    enabled: bool(e('ENABLED'), true),
    live: false,
    liveRequested: bool(e('LIVE'), false),
    strategyId: e('STRATEGY_ID') || STRATEGY_ID,
    // Universe. Cap ceiling stays $3M. Depth is judged against the $20 clip, not a single loose floor.
    minMcapUsd: num(e('MIN_MCAP_USD'), 10_000),
    maxMcapUsd: num(e('MAX_MCAP_USD'), 3_000_000),
    minLiquidityUsd: num(e('MIN_LIQ_USD'), 25_000),
    minLiqToSize: num(e('MIN_LIQ_TO_SIZE'), 1_250),
    maxImpactPct: num(e('MAX_IMPACT_PCT'), 1),
    // DEX reported liquidity is total USD, not a quote reserve. 0.35 is a conservative assumption
    // (tighter than "half the pool") and is NOT an executable quote. Curve reserves do not use it.
    quoteReserveFraction: num(e('QUOTE_RESERVE_FRACTION'), 0.35),
    minVol24Usd: num(e('MIN_VOL24_USD'), 20_000),
    minVol1hUsd: num(e('MIN_VOL1H_USD'), 4_000),
    minVol6hUsd: num(e('MIN_VOL6H_USD'), 8_000),
    maxVolLiq24h: num(e('MAX_VOL_LIQ'), 40),
    minBuys1h: num(e('MIN_BUYS_1H'), 12),
    minSells1h: num(e('MIN_SELLS_1H'), 12),
    minBuys6h: num(e('MIN_BUYS_6H'), 40),
    minSells6h: num(e('MIN_SELLS_6H'), 40),
    minSideRatio: num(e('MIN_SIDE_RATIO'), 0.35),
    minActiveBars: num(e('MIN_ACTIVE_BARS'), 8),
    activeBarWindow: num(e('ACTIVE_BAR_WINDOW'), 12),
    // Candles. 48 closed 5m bars cover 4h from the open of the first bar to the close of the last.
    minClosedBars: num(e('MIN_CLOSED_BARS'), 48),
    minHistoryMin: num(e('MIN_HISTORY_MIN'), 240),
    maxMissingBars: num(e('MAX_MISSING_BARS'), 1),
    freshBarMaxMin: num(e('FRESH_BAR_MAX_MIN'), 10),
    maxPriceDriftPct: num(e('MAX_PRICE_DRIFT_PCT'), 5),
    maxSnapAgeSec: num(e('MAX_SNAP_AGE_SEC'), 90),
    // Swing confirmation. These are structural defaults, not a fit to the 13-trade paper sample.
    pullbackMinPct: num(e('PULLBACK_MIN_PCT'), 8),
    pullbackMaxPct: num(e('PULLBACK_MAX_PCT'), 35),
    stabilizeBars: num(e('STABILIZE_BARS'), 6),
    bounceFromLowPct: num(e('BOUNCE_FROM_LOW_PCT'), 1.5),
    maxRecentDropPct: num(e('MAX_RECENT_DROP_PCT'), 6),
    minBarsSinceHigh: num(e('MIN_BARS_SINCE_HIGH'), 6),
    maxBarVolMultiple: num(e('MAX_BAR_VOL_MULTIPLE'), 8),
    // Exits. Target is net of modeled costs, not a +20% spot print.
    targetNetPct: num(e('TARGET_NET_PCT'), 20),
    slSpotPct: num(e('SL_SPOT_PCT'), 12),
    maxHoldHours: num(e('MAX_HOLD_HOURS'), 18),
    liqExitFraction: num(e('LIQ_EXIT_FRACTION'), 0.6),
    // Costs. Cushions and the unknown-fee LP allowance are a model, not measured slippage.
    modelCushionBuyPct: num(e('MODEL_CUSHION_BUY_PCT'), 0.8),
    modelCushionSellPct: num(e('MODEL_CUSHION_SELL_PCT'), 1.2),
    modelLpFeePct: num(e('MODEL_LP_FEE_PCT'), 0.25),
    modelStopCushionPct: num(e('MODEL_STOP_CUSHION_PCT'), 0.5),
    // Paper book.
    sizeUsd: num(e('SIZE_USD'), 20),
    maxPositions: num(e('MAX_POSITIONS'), 3),
    maxDailyEntries: num(e('MAX_DAILY_ENTRIES'), 6),
    cooldownHours: num(e('COOLDOWN_HOURS'), 4),
    stopCooldownHours: num(e('STOP_COOLDOWN_HOURS'), 12),
    maxStopsInWindow: num(e('MAX_STOPS_IN_WINDOW'), 2),
    stopWindowHours: num(e('STOP_WINDOW_HOURS'), 24),
    knifeBanHours: num(e('KNIFE_BAN_HOURS'), 24),
    // Ranking weights. An ordering key only — not a probability.
    wImpact: num(e('W_IMPACT'), 0.45),
    wDepth: num(e('W_DEPTH'), 0.35),
    wTwoSided: num(e('W_TWO_SIDED'), 0.20),
    // Security.
    maxTaxPct: num(e('MAX_TAX_PCT'), 5),
    requireSecurity: bool(e('REQUIRE_SECURITY'), true),
    // Curve venue. Reserve is the observed BNB reserve, never a filled-in number.
    curveEnabled: bool(e('CURVE_ENABLED'), true),
    curveMinVol1hUsd: num(e('CURVE_MIN_VOL1H_USD'), 3_000),
    curveMinBuys1h: num(e('CURVE_MIN_BUYS_1H'), 12),
    curveMinSells1h: num(e('CURVE_MIN_SELLS_1H'), 8),
    curveMinBuyers1h: num(e('CURVE_MIN_BUYERS_1H'), 8),
    curveMinSellers1h: num(e('CURVE_MIN_SELLERS_1H'), 5),
    curveMinActiveBars1h: num(e('CURVE_MIN_ACTIVE_BARS_1H'), 4),
    curveMinAgeMin: num(e('CURVE_MIN_AGE_MIN'), 45),
    curveProgressMin: num(e('CURVE_PROGRESS_MIN'), 20),
    curveProgressMax: num(e('CURVE_PROGRESS_MAX'), 90),
    curveMinReserveUsd: num(e('CURVE_MIN_RESERVE_USD'), 8_000),
    curveMaxTaxPct: num(e('CURVE_MAX_TAX_PCT'), 5),
    curveTotalSupply: num(e('CURVE_TOTAL_SUPPLY'), 1e9),
    curveBackfillHours: num(e('CURVE_BACKFILL_HOURS'), 6),
    curveStateTtlSec: num(e('CURVE_STATE_TTL_SEC'), 90),
    curveMaxStateChecks: num(e('CURVE_MAX_STATE_CHECKS'), 400),
    writeOffAfterHours: num(e('WRITE_OFF_AFTER_HOURS'), 6),
    // Informational only. allPass does not flip `live` and is not wired to live-entry gates.
    gateDays: num(e('GATE_DAYS'), 14),
    gateClosed: num(e('GATE_CLOSED'), 200),
    gateAvgNetPct: num(e('GATE_AVG_NET_PCT'), 10),
    gateTpHitRate: num(e('GATE_TP_HIT_RATE'), 0.6),
    gateMaxDdUsd: num(e('GATE_MAX_DD_USD'), 30),
    gateTokenPosShare: num(e('GATE_TOKEN_POS_SHARE'), 0.5),
    pollSec: num(e('POLL_SEC'), 60),
    discoverySec: num(e('DISCOVERY_SEC'), 900),
    maxWatch: num(e('MAX_WATCH'), 200),
    gtDiscoverySec: num(e('GT_DISCOVERY_SEC'), 1800),
    dsQueriesPerCycle: num(e('DS_QUERIES_PER_CYCLE'), 16),
    chartMinGapSec: num(e('CHART_MIN_GAP_SEC'), 300),
    chartBudgetMs: num(e('CHART_BUDGET_MS'), 25_000),
    securityPerTick: num(e('SECURITY_PER_TICK'), 3),
    dataDir: e('DATA_DIR') || '',
  });
}

export function swingLiveRequested(env = process.env) {
  return bool(env.SWING_LIVE, false);
}

/** Refuse a config that would blur the paper invariant or the legacy book. */
export function assertConfig(cfg) {
  const bad = [];
  if (cfg.live !== false) bad.push('live');
  if (cfg.strategyId === LEGACY_STRATEGY_ID) bad.push('legacy_strategy_id');
  if (!(cfg.strategyId && cfg.strategyId !== LEGACY_STRATEGY_ID)) bad.push('strategy_id');
  if (!(cfg.sizeUsd > 0)) bad.push('size');
  if (!(cfg.maxPositions >= 1)) bad.push('max_positions');
  if (!(cfg.targetNetPct > 0 && cfg.targetNetPct < 500)) bad.push('target_net');
  if (!(cfg.maxImpactPct > 0 && cfg.maxImpactPct < 50)) bad.push('max_impact');
  if (!(cfg.quoteReserveFraction > 0 && cfg.quoteReserveFraction < 1)) bad.push('quote_reserve_fraction');
  if (!(cfg.modelCushionBuyPct >= 0 && cfg.modelCushionSellPct >= 0 && cfg.modelLpFeePct >= 0)) bad.push('model_costs');
  if (!(cfg.slSpotPct > 0 && cfg.slSpotPct < 100)) bad.push('sl');
  if (!(cfg.minHistoryMin >= 30 && cfg.minClosedBars >= 8)) bad.push('history');
  if (cfg.pullbackMinPct < 0 || cfg.pullbackMaxPct <= cfg.pullbackMinPct) bad.push('pullback_band');
  const w = cfg.wImpact + cfg.wDepth + cfg.wTwoSided;
  if (!(w > 0)) bad.push('weights');
  if (bad.length) {
    const err = new Error(`invalid liquidity-swing config: ${bad.join(',')}`);
    err.code = 'BAD_CONFIG';
    throw err;
  }
}

export const mcapBucket = m => (m < 3e5 ? 'lt300k' : m < 1e6 ? '300k-1M' : '1M-3M');

export function minLiquidityRequired(cfg) {
  return Math.max(cfg.minLiquidityUsd, cfg.sizeUsd * cfg.minLiqToSize);
}

/**
 * Price-impact estimate for the configured clip.
 * Executable quotes and observed quote reserves are quote-backed.
 * DEX total-liquidity × quoteReserveFraction is a labeled model, not a quote.
 * A stale or partial executable quote fails closed and does not fall back.
 */
export function impactAssessment(input, cfg, now) {
  const reasons = [];
  const sizeUsd = input.sizeUsd ?? cfg.sizeUsd;
  const hasExec = input.executableBuyImpactPct != null || input.executableSellImpactPct != null
    || input.executableAt != null || input.executableSource != null;
  let impactPct = null;
  let impactSellPct = null;
  let impactSource = null;
  let reserveUsed = null;
  let reserveBasis = null;
  if (hasExec) {
    const fresh = Number.isFinite(input.executableAt) && now - input.executableAt <= cfg.maxSnapAgeSec * 1000;
    const complete = Number.isFinite(input.executableBuyImpactPct) && input.executableBuyImpactPct >= 0
      && Number.isFinite(input.executableSellImpactPct) && input.executableSellImpactPct >= 0;
    if (!fresh || !complete) reasons.push('executable_quote_unusable');
    else {
      impactPct = input.executableBuyImpactPct;
      impactSellPct = input.executableSellImpactPct;
      impactSource = 'executable_quote';
      reserveBasis = input.executableSource || 'executable_quote';
    }
  } else if (input.quoteReserveUsd != null) {
    if (!(Number(input.quoteReserveUsd) > 0)) reasons.push('quote_reserve_not_positive');
    else {
      impactPct = impactSellPct = sizeUsd / Number(input.quoteReserveUsd) * 100;
      impactSource = 'observed_quote_reserve';
      reserveUsed = Number(input.quoteReserveUsd);
      reserveBasis = 'observed_quote_reserve';
    }
  } else if (input.totalLiquidityUsd != null) {
    if (!(Number(input.totalLiquidityUsd) > 0)) reasons.push('liquidity_not_positive');
    else {
      const reserve = Number(input.totalLiquidityUsd) * cfg.quoteReserveFraction;
      impactPct = impactSellPct = sizeUsd / reserve * 100;
      impactSource = 'reported_liquidity_fraction';
      reserveUsed = reserve;
      reserveBasis = 'reported_total_liquidity * quoteReserveFraction';
    }
  } else reasons.push('no_liquidity_or_quote');
  if (impactPct != null && impactPct > cfg.maxImpactPct) reasons.push('impact_high');
  if (impactSellPct != null && impactSellPct > cfg.maxImpactPct) reasons.push('impact_high');
  const unique = [...new Set(reasons)];
  return {
    ok: unique.length === 0,
    reasons: unique,
    impactPct,
    impactSellPct,
    impactSource,
    reserveUsed,
    reserveBasis,
    quoteBacked: impactSource === 'executable_quote' || impactSource === 'observed_quote_reserve',
    modelReserveAssumption: impactSource === 'reported_liquidity_fraction',
  };
}

function feeKnown(v) {
  return v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
}

/**
 * Full paper cost. Impact comes from impactAssessment.
 * Known token tax or curve fee is required. Unknown DEX LP fee uses modelLpFeePct and is labeled `model`.
 * Cushions are always added and are not measurements.
 */
export function costEstimate(input, cfg, now) {
  const impact = impactAssessment(input, cfg, now);
  const reasons = [...impact.reasons];
  if (!feeKnown(input.knownBuyFeePct) || !feeKnown(input.knownSellFeePct)) reasons.push('fee_or_tax_unknown');
  let lpFeePct = input.knownLpFeePct;
  let lpFeeSource = 'venue';
  if (lpFeePct == null || lpFeePct === '') {
    lpFeePct = cfg.modelLpFeePct;
    lpFeeSource = 'model';
  } else if (!feeKnown(lpFeePct)) reasons.push('lp_fee_invalid');
  const unique = [...new Set(reasons)];
  const ok = unique.length === 0;
  const buyTax = ok ? Number(input.knownBuyFeePct) : null;
  const sellTax = ok ? Number(input.knownSellFeePct) : null;
  const lp = ok ? Number(lpFeePct) : null;
  const appliedBuyPct = ok ? impact.impactPct + buyTax + lp + cfg.modelCushionBuyPct : null;
  const appliedSellPct = ok ? impact.impactSellPct + sellTax + lp + cfg.modelCushionSellPct : null;
  if (ok && (!(appliedBuyPct < 80) || !(appliedSellPct < 80))) {
    return { ...impact, ok: false, reasons: [...unique, 'applied_cost_invalid'], appliedBuyPct: null, appliedSellPct: null, lpFeePct: lp, lpFeeSource, knownBuyFeePct: buyTax, knownSellFeePct: sellTax, modelCushionBuyPct: cfg.modelCushionBuyPct, modelCushionSellPct: cfg.modelCushionSellPct };
  }
  return {
    ...impact,
    ok,
    reasons: unique,
    knownBuyFeePct: buyTax,
    knownSellFeePct: sellTax,
    lpFeePct: lp,
    lpFeeSource,
    modelCushionBuyPct: cfg.modelCushionBuyPct,
    modelCushionSellPct: cfg.modelCushionSellPct,
    appliedBuyPct,
    appliedSellPct,
  };
}

function sideRatio(buys, sells) {
  if (!(buys > 0) || !(sells > 0)) return 0;
  return Math.min(buys, sells) / Math.max(buys, sells);
}

function txnSide(txns, key) {
  const row = txns?.[key];
  if (!row || !Number.isFinite(Number(row.buys)) || !Number.isFinite(Number(row.sells))) return null;
  return { buys: Number(row.buys), sells: Number(row.sells) };
}

/** Hard gates for a DEX snapshot. Fails closed when price, liquidity, or trade counts are missing or stale. */
export function poolScreen(s, cfg, now) {
  const reasons = [];
  const sym = String(s.symbol || '').toUpperCase();
  if (STABLES_MAJORS.has(sym)) reasons.push('stable_or_major');
  if (!QUOTES.has(String(s.quote || '').toUpperCase())) reasons.push(`quote_${s.quote ?? 'missing'}`);
  if (!(s.mcapUsd > 0) || s.mcapUsd < cfg.minMcapUsd || s.mcapUsd > cfg.maxMcapUsd) reasons.push('mcap_out_of_range');
  if (!(s.price > 0)) reasons.push('no_price');
  if (!Number.isFinite(s.at) || now - s.at > cfg.maxSnapAgeSec * 1000) reasons.push('stale_snapshot');
  if (s.liquidityUsd == null || s.liquidityUsd === '') reasons.push('no_liquidity');
  else if (!(Number(s.liquidityUsd) > 0)) reasons.push('liquidity_not_positive');
  else if (Number(s.liquidityUsd) < minLiquidityRequired(cfg)) reasons.push('liq_low');
  const vol = s.vol || {};
  if (!((vol.h24 || 0) >= cfg.minVol24Usd)) reasons.push('vol24_low');
  if (!((vol.h6 || 0) >= cfg.minVol6hUsd)) reasons.push('vol6h_low');
  if (!((vol.h1 || 0) >= cfg.minVol1hUsd)) reasons.push('vol1h_low');
  if (Number(s.liquidityUsd) > 0 && (vol.h24 || 0) / Number(s.liquidityUsd) > cfg.maxVolLiq24h) reasons.push('wash_vol_liq');
  const h1 = txnSide(s.txns, 'h1');
  const h6 = txnSide(s.txns, 'h6');
  if (!h1 || !h6) reasons.push('no_trade_counts');
  else {
    if (h1.buys < cfg.minBuys1h) reasons.push('buys_1h_low');
    if (h1.sells < cfg.minSells1h) reasons.push('sells_1h_low');
    if (h6.buys < cfg.minBuys6h) reasons.push('buys_6h_low');
    if (h6.sells < cfg.minSells6h) reasons.push('sells_6h_low');
    const r1 = sideRatio(h1.buys, h1.sells);
    const r6 = sideRatio(h6.buys, h6.sells);
    if (r1 < cfg.minSideRatio || r6 < cfg.minSideRatio) reasons.push('one_sided');
  }
  const impact = impactAssessment({
    sizeUsd: cfg.sizeUsd,
    totalLiquidityUsd: s.liquidityUsd,
    quoteReserveUsd: s.quoteReserveUsd,
    executableBuyImpactPct: s.executableBuyImpactPct,
    executableSellImpactPct: s.executableSellImpactPct,
    executableAt: s.executableAt,
    executableSource: s.executableSource,
  }, cfg, now);
  for (const r of impact.reasons) if (!reasons.includes(r)) reasons.push(r);
  const h1n = h1 ? sideRatio(h1.buys, h1.sells) : 0;
  const h6n = h6 ? sideRatio(h6.buys, h6.sells) : 0;
  return {
    ok: reasons.length === 0,
    reasons,
    impact,
    sideBalance: Math.min(h1n, h6n),
    liquidityUsd: Number(s.liquidityUsd) || 0,
    volumeUsd24h: vol.h24 || 0,
  };
}

/**
 * Ordering key only. Higher means deeper, lower-impact, and more two-sided persistence.
 * Raw volume is intentionally absent so a busy shallow pool cannot outrank a deeper book.
 * depthN is scaled around 1,000× the clip so the hard liquidity floor stays a gate, not a second score cutoff.
 */
export function qualityScore(features, cfg) {
  const liq = Number(features.liquidityUsd);
  const depth = liq > 0 && cfg.sizeUsd > 0 ? Math.log10(liq / cfg.sizeUsd) : 0;
  const depthN = Math.max(0, Math.min(1, (depth - 3) / 2));
  const impactPct = Number(features.impactPct);
  const impactN = Number.isFinite(impactPct) ? Math.max(0, Math.min(1, 1 - impactPct / cfg.maxImpactPct)) : 0;
  const balance = Math.max(0, Math.min(1, Number(features.sideBalance) || 0));
  const persist = Math.max(0, Math.min(1, Number(features.persistence) || 0));
  const score = cfg.wImpact * impactN + cfg.wDepth * depthN + cfg.wTwoSided * balance * persist;
  return { score, depthN, impactN, balance, persist };
}

export function rankCandidates(rows, cfg) {
  return rows.map(row => ({ ...row, quality: qualityScore(row, cfg) }))
    .sort((a, b) => b.quality.score - a.quality.score
      || b.liquidityUsd - a.liquidityUsd
      || String(a.addr).localeCompare(String(b.addr)));
}

/** Closed-candle swing confirmation. Reference high is the max close, so a single wick cannot invent a dip. */
export function swingConfirm(bars, cfg, nowMs, livePrice = null) {
  const reasons = [];
  if (!Array.isArray(bars) || bars.length === 0) return { ok: false, reasons: ['bars_missing'] };
  const closed = [];
  const seen = new Set();
  const ordered = [...bars].sort((a, b) => a.t - b.t || 0);
  for (const b of ordered) {
    if (!b || !Number.isFinite(b.t) || !Number.isFinite(b.o) || !Number.isFinite(b.h) || !Number.isFinite(b.l) || !Number.isFinite(b.c) || !(b.c > 0) || !(b.h >= b.l)) {
      reasons.push('bar_invalid');
      continue;
    }
    if (seen.has(b.t)) continue;
    seen.add(b.t);
    if (b.t + BAR_MS > nowMs) continue;
    closed.push(b);
  }
  if (reasons.includes('bar_invalid')) return { ok: false, reasons: [...new Set(reasons)] };
  if (!closed.length) return { ok: false, reasons: ['history_short'] };
  const last = closed[closed.length - 1];
  const win = closed.filter(b => b.t >= last.t - cfg.minHistoryMin * 60_000);
  if (win.length < 2) return { ok: false, reasons: ['history_short'] };
  const coverageMin = (last.t + BAR_MS - win[0].t) / 60_000;
  if (closed.length < cfg.minClosedBars || win.length < cfg.minClosedBars || coverageMin + cfg.maxMissingBars * 5 < cfg.minHistoryMin) reasons.push('history_short');
  let missing = 0;
  for (let i = 1; i < win.length; i++) {
    const delta = win[i].t - win[i - 1].t;
    if (delta < BAR_MS) { reasons.push('history_overlap'); break; }
    const miss = Math.round(delta / BAR_MS) - 1;
    if (miss > 0) missing += miss;
    if (miss > cfg.maxMissingBars) { reasons.push('history_gap'); break; }
  }
  if (missing > cfg.maxMissingBars && !reasons.includes('history_gap')) reasons.push('history_gap');
  if ((nowMs - (last.t + BAR_MS)) / 60_000 > cfg.freshBarMaxMin) reasons.push('bars_stale');
  if (reasons.some(r => r === 'history_short' || r === 'history_gap' || r === 'history_overlap' || r === 'bars_stale')) {
    return { ok: false, reasons: [...new Set(reasons)], coverageMin };
  }
  const refHigh = Math.max(...win.map(b => b.c));
  const wickHigh = Math.max(...win.map(b => b.h));
  const pullbackPct = refHigh > 0 ? (1 - last.c / refHigh) * 100 : 0;
  if (!(pullbackPct >= cfg.pullbackMinPct)) reasons.push('pullback_shallow');
  if (pullbackPct > cfg.pullbackMaxPct) reasons.push('pullback_deep');
  let highIdx = 0;
  for (let i = 0; i < win.length; i++) if (win[i].c === refHigh) highIdx = i;
  const barsSinceHigh = win.length - 1 - highIdx;
  if (barsSinceHigh < cfg.minBarsSinceHigh) reasons.push('high_too_recent');
  const stab = win.slice(-cfg.stabilizeBars);
  const stabMax = Math.max(...stab.map(b => b.c));
  const stabMin = Math.min(...stab.map(b => b.c));
  const recentDropPct = stabMax > 0 ? (stabMax - last.c) / stabMax * 100 : 0;
  if (recentDropPct > cfg.maxRecentDropPct) reasons.push('recent_drop');
  const bouncePct = stabMin > 0 ? (last.c / stabMin - 1) * 100 : 0;
  if (bouncePct < cfg.bounceFromLowPct) reasons.push('no_bounce');
  const prev = win[win.length - 2];
  if (!(last.c > last.o)) reasons.push('not_green');
  if (!prev || !(last.c > prev.c)) reasons.push('not_above_prev_close');
  if (!(last.v > 0)) reasons.push('no_volume_last_bar');
  const volWin = win.slice(-cfg.activeBarWindow);
  const active = volWin.filter(b => b.v > 0).length;
  if (active < cfg.minActiveBars) reasons.push('activity_sparse');
  const greens = volWin.filter(b => b.c > b.o).length;
  const reds = volWin.filter(b => b.c < b.o).length;
  if (greens < 1 || reds < 1) reasons.push('one_sided_bars');
  const priorVol = volWin.slice(0, -1).map(b => b.v).filter(v => v > 0).sort((a, b) => a - b);
  if (priorVol.length) {
    const mid = priorVol[Math.floor((priorVol.length - 1) / 2)];
    if (mid > 0 && last.v > mid * cfg.maxBarVolMultiple) reasons.push('climax_bar');
  }
  if (!(livePrice > 0)) reasons.push('no_live_price');
  else if (Math.abs(livePrice / last.c - 1) * 100 > cfg.maxPriceDriftPct) reasons.push('price_drift');
  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    refHigh,
    wickHigh,
    pullbackPct,
    lastClose: last.c,
    barT: last.t,
    barsSinceHigh,
    recentDropPct,
    bouncePct,
    activeBars: active,
    activeBarFraction: volWin.length ? active / volWin.length : 0,
    wickOverClosePct: refHigh > 0 ? (wickHigh / refHigh - 1) * 100 : null,
    coverageMin,
  };
}

/** Spot multiple that nets `targetNetPct` after the applied buy and sell costs. Identity, not a forecast. */
export function targetSpot(entrySpot, appliedBuyPct, appliedSellPct, targetNetPct) {
  const b = appliedBuyPct / 100;
  const s = appliedSellPct / 100;
  const t = targetNetPct / 100;
  if (!(entrySpot > 0) || !(b < 10) || !(s < 1) || !(t > -1)) return null;
  return entrySpot * (1 + t) * (1 + b) / (1 - s);
}

export function openPosition({ spot, cost, cfg, now, venue = 'dex', liquidityUsd = null, quoteReserveUsd = null }) {
  if (!cost?.ok) throw new Error('refusing to open without a cost estimate');
  const tpSpot = targetSpot(spot, cost.appliedBuyPct, cost.appliedSellPct, cfg.targetNetPct);
  if (!(tpSpot > spot)) throw new Error('refusing to open without a solvable net target');
  const entryFill = spot * (1 + cost.appliedBuyPct / 100);
  const qty = cfg.sizeUsd / entryFill;
  return {
    entrySpot: spot,
    entryPrice: entryFill,
    qty,
    costUsd: cfg.sizeUsd,
    entryAt: now,
    tpPrice: tpSpot,
    stopPrice: spot * (1 - cfg.slSpotPct / 100),
    peak: spot,
    trough: spot,
    venue,
    liqAtEntry: liquidityUsd,
    quoteReserveAtEntry: quoteReserveUsd,
    appliedBuyPct: cost.appliedBuyPct,
    appliedSellPct: cost.appliedSellPct,
    cost,
  };
}

export function modeledNetPct(pos, spot, sellPct) {
  if (!(spot > 0) || !(pos.qty > 0)) return null;
  const proceeds = pos.qty * spot * (1 - sellPct / 100);
  return (proceeds - pos.costUsd) / pos.costUsd * 100;
}

const STOP_REASONS = new Set(['stop_loss', 'liquidity_drop', 'impact_widened', 'unsellable_writeoff']);

/**
 * Exit order: missing/stale price holds (caller may later write off);
 * lost depth or lost sellability exits defensively;
 * spot stop; net target only with a fresh impact still inside the cap;
 * max hold last.
 */
export function exitDecision(pos, obs, cfg, now) {
  const peak = Math.max(pos.peak ?? obs.price ?? pos.entrySpot, obs.price ?? pos.entrySpot);
  if (!(obs.price > 0) || obs.stale || !Number.isFinite(obs.at) || now - obs.at > cfg.maxSnapAgeSec * 1000) {
    return { type: 'hold', reason: 'stale_or_missing_price', stop: false, peak, takeProfit: false };
  }
  if (obs.sellable === false) return { type: 'sell', reason: 'unsellable_writeoff', stop: true, peak, takeProfit: false, writeoff: true };
  const liq = obs.liquidityUsd;
  if (pos.liqAtEntry > 0 && liq != null && liq < pos.liqAtEntry * cfg.liqExitFraction) {
    return { type: 'sell', reason: 'liquidity_drop', stop: true, peak, takeProfit: false };
  }
  if (obs.impactPct != null && obs.impactPct > cfg.maxImpactPct) {
    return { type: 'sell', reason: 'impact_widened', stop: true, peak, takeProfit: false };
  }
  if (obs.price <= pos.stopPrice) return { type: 'sell', reason: 'stop_loss', stop: true, peak, takeProfit: false };
  const sellPct = freshSellPct(pos, obs, cfg, false);
  const net = sellPct == null ? null : modeledNetPct(pos, obs.price, sellPct);
  if (net != null && net >= cfg.targetNetPct && obs.impactFresh) {
    return { type: 'sell', reason: 'tp', stop: false, peak, takeProfit: true, sellPct, netPct: net };
  }
  if ((obs.price >= pos.tpPrice || (net != null && net >= cfg.targetNetPct)) && !obs.impactFresh) {
    return { type: 'hold', reason: 'tp_blocked_no_fresh_impact', stop: false, peak, takeProfit: false };
  }
  if (now - pos.entryAt >= cfg.maxHoldHours * 3600e3) return { type: 'sell', reason: 'max_hold', stop: false, peak, takeProfit: false };
  return { type: 'hold', reason: 'hold', stop: false, peak, takeProfit: false };
}

/** Sell-side percent used to book a close. Stop-like reasons add the model stop cushion. */
export function freshSellPct(pos, obs, cfg, stop) {
  const tax = pos.cost?.knownSellFeePct;
  const lp = pos.cost?.lpFeePct;
  if (!feeKnown(tax) || !feeKnown(lp)) return null;
  let impact = null;
  // A defensive exit may book a known but out-of-cap impact. A take-profit may not.
  if (obs.impactSellPct != null && obs.impactSellPct >= 0 && (stop || obs.impactFresh)) impact = obs.impactSellPct;
  else if (stop && pos.cost?.impactSellPct != null) impact = pos.cost.impactSellPct;
  else return null;
  return impact + Number(tax) + Number(lp) + cfg.modelCushionSellPct + (stop ? cfg.modelStopCushionPct : 0);
}

export function closeTrade(pos, spot, sellPct, { writeoff = false } = {}) {
  if (writeoff || !(spot > 0) || sellPct == null) {
    return {
      fill: 0, proceeds: 0, netUsd: -pos.costUsd, netPct: -100,
      grossUsd: null, grossPct: null, sellPct: null, writeoff: true,
    };
  }
  const fill = spot * (1 - sellPct / 100);
  const proceeds = pos.qty * fill;
  const netUsd = proceeds - pos.costUsd;
  const grossUsd = pos.costUsd * (spot / pos.entrySpot - 1);
  return {
    fill, proceeds, netUsd, netPct: netUsd / pos.costUsd * 100,
    grossUsd, grossPct: grossUsd / pos.costUsd * 100, sellPct, writeoff: false,
  };
}

function flag(sec, key, badReason, unknownReason, reasons) {
  if (typeof sec[key] !== 'boolean') reasons.push(unknownReason);
  else if (sec[key]) reasons.push(badReason);
}

export function securityCheck(sec, cfg) {
  if (!sec) return { ok: !cfg.requireSecurity, reasons: ['security_unknown'] };
  const reasons = [];
  flag(sec, 'honeypot', 'honeypot', 'honeypot_unknown', reasons);
  flag(sec, 'cannotBuy', 'cannot_buy', 'cannot_buy_unknown', reasons);
  flag(sec, 'cannotSellAll', 'cannot_sell_all', 'cannot_sell_unknown', reasons);
  flag(sec, 'hiddenOwner', 'hidden_owner', 'hidden_owner_unknown', reasons);
  flag(sec, 'ownerChangeBalance', 'owner_change_balance', 'owner_change_balance_unknown', reasons);
  if (sec.buyTaxPct == null || sec.sellTaxPct == null) reasons.push('tax_unknown');
  else if (Math.max(sec.buyTaxPct, sec.sellTaxPct) > cfg.maxTaxPct) reasons.push(`tax>${cfg.maxTaxPct}%`);
  if (sec.openSource !== true) reasons.push('closed_or_unknown_source');
  if (!Number.isFinite(sec.at)) reasons.push('security_timestamp_missing');
  return { ok: reasons.length === 0, reasons };
}

export function curveActivityCheck(st, cfg) {
  const reasons = [];
  if (!st) return { ok: false, reasons: ['c_no_activity'] };
  if (!(st.vol1hUsd >= cfg.curveMinVol1hUsd)) reasons.push('c_vol1h_low');
  if (!(st.buys1h >= cfg.curveMinBuys1h)) reasons.push('c_buys_low');
  if (!(st.sells1h >= cfg.curveMinSells1h)) reasons.push('c_sells_low');
  if (!(st.buyers1h >= cfg.curveMinBuyers1h)) reasons.push('c_buyers_low');
  if (!(st.sellers1h >= cfg.curveMinSellers1h)) reasons.push('c_sellers_low');
  if (!(st.activeBars1h >= cfg.curveMinActiveBars1h)) reasons.push('c_activity_sparse');
  if (!(st.ageMin >= cfg.curveMinAgeMin)) reasons.push('c_too_young');
  const ratio = sideRatio(st.buys1h, st.sells1h);
  if (ratio < cfg.minSideRatio) reasons.push('c_one_sided');
  return { ok: reasons.length === 0, reasons, sideBalance: ratio };
}

/** On-chain curve state. Missing fields stay missing — reserve and price are never invented. */
export function curveStateCheck(cs, bnbUsd, cfg, now) {
  if (!cs) return { ok: false, reasons: ['c_no_state'] };
  if (!(bnbUsd > 0)) return { ok: false, reasons: ['c_no_bnb_usd'] };
  const reasons = [];
  if (!Number.isFinite(cs.at) || now - cs.at > cfg.curveStateTtlSec * 1000) reasons.push('c_state_stale');
  const priceUsd = cs.priceBnb > 0 ? cs.priceBnb * bnbUsd : null;
  const reserveUsd = cs.reserveBnb > 0 ? cs.reserveBnb * bnbUsd : null;
  const mcapUsd = priceUsd != null ? priceUsd * cfg.curveTotalSupply : null;
  const progressPct = cs.thresh > 0 && cs.circ != null ? cs.circ / cs.thresh * 100 : null;
  if (cs.status !== 1) reasons.push('c_not_tradable_curve');
  if (!cs.quoteIsNative) reasons.push('c_quote_not_bnb');
  if (progressPct == null || progressPct < cfg.curveProgressMin || progressPct > cfg.curveProgressMax) reasons.push('c_progress');
  if (cs.buyFeeBps == null || cs.sellFeeBps == null) reasons.push('c_fee_unknown');
  else if (Math.max(cs.buyFeeBps, cs.sellFeeBps) / 100 > cfg.curveMaxTaxPct) reasons.push('c_tax');
  if (!(reserveUsd >= cfg.curveMinReserveUsd)) reasons.push('c_reserve_low');
  if (!(mcapUsd >= cfg.minMcapUsd && mcapUsd <= cfg.maxMcapUsd)) reasons.push('mcap_out_of_range');
  if (!(priceUsd > 0)) reasons.push('c_no_price');
  return { ok: reasons.length === 0, reasons, priceUsd, reserveUsd, mcapUsd, progressPct };
}

/**
 * Re-check one curve candidate. Missing activity, state, BNB/USD, or reserve stays a reason.
 * This does not substitute a DEX liquidity figure for a missing curve reserve.
 */
export function evaluateCurveEntry(entry, cfg, now) {
  const activity = curveActivityCheck(entry?.activity, cfg);
  const state = curveStateCheck(entry?.state, entry?.bnbUsd, cfg, now);
  const reasons = [...activity.reasons, ...state.reasons];
  let impact = null;
  if (state.reserveUsd != null) {
    impact = impactAssessment({ sizeUsd: cfg.sizeUsd, quoteReserveUsd: state.reserveUsd }, cfg, now);
    for (const r of impact.reasons) if (!reasons.includes(r)) reasons.push(r);
  } else if (!reasons.includes('c_reserve_low') && !reasons.includes('c_no_state') && !reasons.includes('c_no_bnb_usd')) {
    reasons.push('c_reserve_low');
  }
  return {
    ok: activity.ok && state.ok && impact?.ok === true,
    reasons: [...new Set(reasons)],
    activity,
    state,
    impact,
  };
}

/** Read-only view over a CurveBook-shaped object. Returns null when the token is absent. */
export function curveActivityFromBook(book, addr, now) {
  const tk = book?.tokens?.get?.(addr);
  if (!tk) return null;
  const win = (tk.win || []).filter(x => now - x.t <= 3600e3);
  const buyers = new Set(win.filter(x => x.side === 'b').map(x => x.trader));
  const sellers = new Set(win.filter(x => x.side === 's').map(x => x.trader));
  const bars = [...(tk.bars?.values?.() || [])].filter(b => b.t + BAR_MS <= now && now - (b.t + BAR_MS) <= 3600e3 && b.v > 0);
  return {
    vol1hUsd: win.reduce((a, x) => a + (Number(x.usd) || 0), 0),
    buys1h: win.filter(x => x.side === 'b').length,
    sells1h: win.filter(x => x.side === 's').length,
    buyers1h: buyers.size,
    sellers1h: sellers.size,
    activeBars1h: bars.length,
    ageMin: Number.isFinite(tk.firstT) ? (now - tk.firstT) / 60e3 : null,
    lastT: tk.lastT ?? null,
    lastPrice: tk.lastPrice ?? null,
  };
}

export function dayKey(now) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

export function entryBlock(addr, book, cfg, now) {
  if (book.positions?.[addr]) return 'duplicate';
  if ((book.knifeBan?.[addr] || 0) > now) return 'knife_ban';
  if ((book.cooldown?.[addr] || 0) > now) return 'cooldown';
  if (Object.keys(book.positions || {}).length >= cfg.maxPositions) return 'max_positions';
  const day = dayKey(now);
  if ((book.entriesByDay?.[day] || 0) >= cfg.maxDailyEntries) return 'daily_cap';
  return null;
}

export function isStopReason(reason) {
  return STOP_REASONS.has(reason);
}

/** Update cooldown / falling-knife ban. Returns the next book fields (mutates the plain object). */
export function noteClose(book, addr, reason, cfg, now) {
  book.cooldown = book.cooldown || {};
  book.knifeBan = book.knifeBan || {};
  book.stopTimes = book.stopTimes || {};
  const stop = isStopReason(reason);
  const hours = stop ? cfg.stopCooldownHours : cfg.cooldownHours;
  book.cooldown[addr] = now + hours * 3600e3;
  if (stop) {
    const windowMs = cfg.stopWindowHours * 3600e3;
    const prev = (book.stopTimes[addr] || []).filter(t => now - t <= windowMs);
    prev.push(now);
    book.stopTimes[addr] = prev;
    if (prev.length >= cfg.maxStopsInWindow) book.knifeBan[addr] = now + cfg.knifeBanHours * 3600e3;
  }
  return book;
}

export function summarize(closed, startedAtMs, nowMs, cfg) {
  const n = closed.length;
  const ord = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
  const wins = ord.filter(c => c.netUsd > 0).length;
  const totalNetUsd = ord.reduce((a, c) => a + c.netUsd, 0);
  const avgNetPct = n ? ord.reduce((a, c) => a + c.netPct, 0) / n : null;
  let eq = 0, pk = 0, dd = 0;
  for (const c of ord) { eq += c.netUsd; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const tpHitRate = n ? ord.filter(c => c.reason === 'tp').length / n : null;
  const half = Math.floor(n / 2);
  const h1 = ord.slice(0, half);
  const h2 = ord.slice(half);
  const sum = a => a.reduce((x, c) => x + c.netUsd, 0);
  const byTok = new Map();
  for (const c of ord) byTok.set(c.addr, (byTok.get(c.addr) || 0) + c.netUsd);
  const tokPos = [...byTok.values()].filter(v => v > 0).length;
  const days = (nowMs - startedAtMs) / 86400e3;
  const gate = {
    informationalOnly: true,
    authorizesLive: false,
    days: { value: +days.toFixed(2), need: cfg.gateDays, ok: days >= cfg.gateDays },
    closed: { value: n, need: cfg.gateClosed, ok: n >= cfg.gateClosed },
    avgNetPct: { value: avgNetPct == null ? null : +avgNetPct.toFixed(2), need: `> ${cfg.gateAvgNetPct}`, ok: avgNetPct != null && avgNetPct > cfg.gateAvgNetPct },
    tpHitRate: { value: tpHitRate == null ? null : +tpHitRate.toFixed(3), need: `> ${cfg.gateTpHitRate}`, ok: tpHitRate != null && tpHitRate > cfg.gateTpHitRate },
    bothHalvesPositive: { value: n >= 2 ? [+sum(h1).toFixed(2), +sum(h2).toFixed(2)] : null, ok: n >= 2 && sum(h1) > 0 && sum(h2) > 0 },
    tokensPositiveShare: { value: byTok.size ? +(tokPos / byTok.size).toFixed(3) : null, need: `>= ${cfg.gateTokenPosShare}`, ok: byTok.size > 0 && tokPos / byTok.size >= cfg.gateTokenPosShare },
    maxDdUsd: { value: +dd.toFixed(2), need: `< ${cfg.gateMaxDdUsd}`, ok: n > 0 && dd < cfg.gateMaxDdUsd },
  };
  const checks = ['days', 'closed', 'avgNetPct', 'tpHitRate', 'bothHalvesPositive', 'tokensPositiveShare', 'maxDdUsd'];
  gate.allPass = checks.every(k => gate[k].ok);
  return {
    closedCount: n,
    winRate: n ? +(wins / n).toFixed(3) : null,
    avgNetPct: avgNetPct == null ? null : +avgNetPct.toFixed(2),
    totalNetUsd: +totalNetUsd.toFixed(2),
    maxDrawdownUsd: +dd.toFixed(2),
    tpHitRate: tpHitRate == null ? null : +tpHitRate.toFixed(3),
    tokensTraded: byTok.size,
    tokensPositive: tokPos,
    daysRunning: +days.toFixed(2),
    gate,
  };
}

/**
 * Refuse the legacy directory name and any ledger whose strategy id is not ours.
 * Read-only: this function never writes.
 */
export async function assertIsolatedLedger(dir, strategyId, fsPromises) {
  const pathMod = await import('node:path');
  const resolved = pathMod.resolve(dir);
  if (pathMod.basename(resolved) === LEGACY_DATA_DIR_NAME) {
    const err = new Error(`refusing legacy data directory ${resolved}`);
    err.code = 'LEGACY_LEDGER';
    throw err;
  }
  if (strategyId === LEGACY_STRATEGY_ID) {
    const err = new Error('refusing legacy strategy id paper-lowcap-swing');
    err.code = 'LEGACY_STRATEGY';
    throw err;
  }
  const statePath = pathMod.join(resolved, 'state.json');
  const ledgerPath = pathMod.join(resolved, 'ledger.jsonl');
  let state = null;
  try {
    state = JSON.parse(await fsPromises.readFile(statePath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (state && state.strategyId && state.strategyId !== strategyId) {
    const err = new Error(`refusing foreign ledger strategy ${state.strategyId} in ${resolved}`);
    err.code = 'FOREIGN_LEDGER';
    throw err;
  }
  const hasBook = state && ((state.positions && Object.keys(state.positions).length) || (state.closed && state.closed.length) || (state.ledgerStrategyId));
  if (state && !state.strategyId && hasBook) {
    const err = new Error(`refusing unlabeled ledger in ${resolved}`);
    err.code = 'FOREIGN_LEDGER';
    throw err;
  }
  try {
    const text = await fsPromises.readFile(ledgerPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch {
        const err = new Error(`refusing unreadable ledger line in ${resolved}`);
        err.code = 'FOREIGN_LEDGER';
        throw err;
      }
      if (row.strategyId && row.strategyId !== strategyId) {
        const err = new Error(`ledger contains ${row.strategyId}`);
        err.code = 'FOREIGN_LEDGER';
        throw err;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { resolved, state };
}
