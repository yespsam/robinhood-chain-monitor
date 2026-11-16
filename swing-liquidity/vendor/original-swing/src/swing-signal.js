// 低市值波段 (low-cap swing) — PAPER ONLY. Pure signal / exit / cost / metrics logic.
// This module never touches live trading. See docs/swing-paper.md.
export const STRATEGY_ID = 'paper-lowcap-swing';
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const STABLES_MAJORS = new Set(['USDT', 'USDC', 'BUSD', 'WBNB', 'BNB', 'BTCB', 'BTC', 'ETH', 'WETH', 'FDUSD', 'USD1', 'DAI', 'TUSD', 'UUSD', 'USDB', 'SOL', 'XAUT']);
export const QUOTES = new Set(['USDT', 'WBNB', 'USDC', 'BNB', 'BUSD', 'FDUSD', 'USD1']);

/** live is hard-coded false. SWING_LIVE=true is only read to REFUSE to start (see swingLiveRequested). */
export function loadConfig(env = process.env) {
  const e = k => env[`SWING_${k}`];
  return Object.freeze({
    enabled: bool(e('ENABLED'), true),
    live: false,                                          // hard-coded: paper only
    liveRequested: bool(e('LIVE'), false),                // runtime refuses to start when true
    strategyId: e('STRATEGY_ID') || STRATEGY_ID,
    // universe (BSC only)
    minMcapUsd: num(e('MIN_MCAP_USD'), 10_000),
    maxMcapUsd: num(e('MAX_MCAP_USD'), 3_000_000),        // mcap, FDV when mcap missing
    minLiquidityUsd: num(e('MIN_LIQ_USD'), 10_000),
    minVol24Usd: num(e('MIN_VOL24_USD'), 15_000),
    minVol1hUsd: num(e('MIN_VOL1H_USD'), 5_000),
    maxVolLiq24h: num(e('MAX_VOL_LIQ'), 60),
    // security (GoPlus, fail-closed)
    maxTaxPct: num(e('MAX_TAX_PCT'), 5),
    requireSecurity: bool(e('REQUIRE_SECURITY'), true),
    // entry: pullback from 4h high + green bounce on 5m bars
    pullbackPct: num(e('PULLBACK_PCT'), 30),
    maxPullbackPct: num(e('MAX_PULLBACK_PCT'), 70),       // deeper than this = likely dead/rug, skip
    lookbackMin: num(e('LOOKBACK_MIN'), 240),
    freshBarMaxMin: num(e('FRESH_BAR_MAX_MIN'), 15),      // last completed 5m bar must be this recent
    maxPriceDriftPct: num(e('MAX_PRICE_DRIFT_PCT'), 10),  // live price vs last bar close
    // exits
    tpPct: num(e('TP_PCT'), 20),
    shadowTpPcts: [30, 50],                               // logged only
    slPct: num(e('SL_PCT'), 15),
    maxHoldHours: num(e('MAX_HOLD_HOURS'), 24),
    liqExitFraction: num(e('LIQ_EXIT_FRACTION'), 0.5),
    // execution (paper)
    sizeUsd: num(e('SIZE_USD'), 20),
    maxPositions: num(e('MAX_POSITIONS'), 3),
    maxDailyEntries: num(e('MAX_DAILY_ENTRIES'), 8),
    cooldownHours: num(e('COOLDOWN_HOURS'), 1),
    // curve (内盘, Flap bonding curve) venue
    curveEnabled: bool(e('CURVE_ENABLED'), true),
    curveMinVol1hUsd: num(e('CURVE_MIN_VOL1H_USD'), 2_000),
    curveMinBuys1h: num(e('CURVE_MIN_BUYS_1H'), 15),
    curveMinBuyers1h: num(e('CURVE_MIN_BUYERS_1H'), 8),
    curveMinAgeMin: num(e('CURVE_MIN_AGE_MIN'), 30),
    curveProgressMin: num(e('CURVE_PROGRESS_MIN'), 20),
    curveProgressMax: num(e('CURVE_PROGRESS_MAX'), 90),
    curveMinReserveUsd: num(e('CURVE_MIN_RESERVE_USD'), 1_500),
    curveMaxTaxPct: num(e('CURVE_MAX_TAX_PCT'), 5),        // Portal buy/sell fee (getTokenV8Safe fields 12/13, bps) must be <= this; the actual per-side fee is charged from those fields (1% typical)
    curveTotalSupply: num(e('CURVE_TOTAL_SUPPLY'), 1e9),
    curveBackfillHours: num(e('CURVE_BACKFILL_HOURS'), 6),
    curveStateTtlSec: num(e('CURVE_STATE_TTL_SEC'), 90),
    curveMaxStateChecks: num(e('CURVE_MAX_STATE_CHECKS'), 400),
    writeOffAfterHours: num(e('WRITE_OFF_AFTER_HOURS'), 6),   // unpriceable position this long after max hold -> -100%
    // realistic meme cost tier
    buySlippagePct: num(e('BUY_SLIPPAGE_PCT'), 3),
    sellSlippagePct: num(e('SELL_SLIPPAGE_PCT'), 4),
    stopExtraSlippagePct: num(e('STOP_EXTRA_SLIPPAGE_PCT'), 5),
    feePct: num(e('FEE_PCT'), 0.25),                      // per side
    // live-promotion gate (information only; nothing here can enable live)
    gateDays: num(e('GATE_DAYS'), 14),
    gateClosed: num(e('GATE_CLOSED'), 200),
    gateAvgNetPct: num(e('GATE_AVG_NET_PCT'), 10),
    gateTpHitRate: num(e('GATE_TP_HIT_RATE'), 0.6),
    gateMaxDdUsd: num(e('GATE_MAX_DD_USD'), 30),
    gateTokenPosShare: num(e('GATE_TOKEN_POS_SHARE'), 0.5),
    // runtime
    pollSec: num(e('POLL_SEC'), 60),
    discoverySec: num(e('DISCOVERY_SEC'), 900),
    maxWatch: num(e('MAX_WATCH'), 200),
    gtDiscoverySec: num(e('GT_DISCOVERY_SEC'), 1800),      // GeckoTerminal lists are only a secondary discovery source
    dsQueriesPerCycle: num(e('DS_QUERIES_PER_CYCLE'), 16),
    chartMinGapSec: num(e('CHART_MIN_GAP_SEC'), 300),
    chartBudgetMs: num(e('CHART_BUDGET_MS'), 25_000),
    securityPerTick: num(e('SECURITY_PER_TICK'), 3),
    dataDir: e('DATA_DIR') || '',
  });
}

/** Market-cap bucket used for status comparison. */
export const mcapBucket = m => (m < 3e5 ? 'lt300k' : m < 1e6 ? '300k-1M' : '1M-3M');

export const swingLiveRequested = (env = process.env) => bool(env.SWING_LIVE, false);

/** Universe filter on a snapshot {symbol, quote, mcapUsd, liquidityUsd, vol:{h1,h24}}. loosen<1 relaxes thresholds (discovery stage). */
export function universeCheck(s, cfg, loosen = 1) {
  const fail = [];
  const chk = (ok, why) => { if (!ok) fail.push(why); };
  const sym = String(s.symbol || '').toUpperCase();
  chk(!STABLES_MAJORS.has(sym), 'stable_or_major');
  chk(QUOTES.has(String(s.quote || '').toUpperCase()), `quote_${s.quote}`);
  chk(s.mcapUsd > 0 && s.mcapUsd >= cfg.minMcapUsd * loosen && s.mcapUsd <= cfg.maxMcapUsd / loosen, 'mcap_out_of_range');
  chk(s.liquidityUsd >= cfg.minLiquidityUsd * loosen, 'liq_low');
  chk((s.vol?.h24 || 0) >= cfg.minVol24Usd * loosen, 'vol24_low');
  if (s.vol?.h1 != null) chk(s.vol.h1 >= cfg.minVol1hUsd * loosen, 'vol1h_low');
  if (s.liquidityUsd > 0) chk((s.vol?.h24 || 0) / s.liquidityUsd <= cfg.maxVolLiq24h, 'wash:vol24/liq');
  return { ok: fail.length === 0, reasons: fail };
}

/** Local (no-RPC) curve filter on rolling 1h trade stats {vol1hUsd,buys1h,buyers1h,ageMin}. */
export function curveLocalCheck(st, cfg) {
  const r = [];
  if (!(st.vol1hUsd >= cfg.curveMinVol1hUsd)) r.push('c_vol1h_low');
  if (!(st.buys1h >= cfg.curveMinBuys1h)) r.push('c_buys_low');
  if (!(st.buyers1h >= cfg.curveMinBuyers1h)) r.push('c_buyers_low');
  if (!(st.ageMin >= cfg.curveMinAgeMin)) r.push('c_too_young');
  return { ok: r.length === 0, reasons: r };
}
/** On-chain curve state check. cs = {status, reserveBnb, circ, thresh, priceBnb, quoteIsNative, taxBps = max(buy,sell) Portal fee in bps}. Prices converted with bnbUsd. */
export function curveStateCheck(cs, bnbUsd, cfg) {
  if (!cs) return { ok: false, reasons: ['c_no_state'] };
  const r = [], priceUsd = cs.priceBnb * bnbUsd, reserveUsd = cs.reserveBnb * bnbUsd, mcapUsd = priceUsd * cfg.curveTotalSupply;
  const progressPct = cs.thresh > 0 ? cs.circ / cs.thresh * 100 : null;
  if (cs.status !== 1) r.push('c_not_tradable_curve');
  if (!cs.quoteIsNative) r.push('c_quote_not_bnb');
  if (progressPct == null || progressPct < cfg.curveProgressMin || progressPct > cfg.curveProgressMax) r.push(`c_progress(${progressPct == null ? '?' : progressPct.toFixed(0)})`);
  if (!(cs.taxBps / 100 <= cfg.curveMaxTaxPct)) r.push('c_tax');
  if (!(reserveUsd >= cfg.curveMinReserveUsd)) r.push('c_reserve_low');
  if (!(mcapUsd >= cfg.minMcapUsd && mcapUsd <= cfg.maxMcapUsd)) r.push('mcap_out_of_range');
  if (!(priceUsd > 0)) r.push('c_no_price');
  return { ok: r.length === 0, reasons: r, priceUsd, reserveUsd, mcapUsd, progressPct };
}

/** GoPlus verdict; fail-closed: null / unknown fields => not ok. sec = raw normalized object from goplusSecurity. */
export function securityCheck(sec, cfg) {
  if (!sec) return { ok: !cfg.requireSecurity, reasons: ['security_unknown'] };
  const r = [];
  if (sec.honeypot) r.push('honeypot');
  if (sec.cannotBuy) r.push('cannot_buy');
  if (sec.cannotSellAll) r.push('cannot_sell_all');
  if (sec.buyTaxPct == null || sec.sellTaxPct == null) r.push('tax_unknown');
  else if (Math.max(sec.buyTaxPct, sec.sellTaxPct) > cfg.maxTaxPct) r.push(`tax>${cfg.maxTaxPct}%`);
  if (sec.openSource === false) r.push('closed_source');
  if (sec.hiddenOwner) r.push('hidden_owner');
  if (sec.ownerChangeBalance) r.push('owner_change_balance');
  return { ok: r.length === 0, reasons: r };
}

/**
 * Pullback entry on ascending COMPLETED 5m bars [{t(ms),o,h,l,c,v}].
 * Needs: >= pullbackPct below the highest high of the last lookbackMin minutes, last bar green and closing above the previous close.
 */
export function pullbackSignal(bars, cfg, nowMs, livePrice = null) {
  const fail = [];
  if (!Array.isArray(bars) || bars.length < 8) return { ok: false, reasons: ['bars_short'] };
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  const lastEnd = last.t + 300e3;
  if (lastEnd > nowMs) return { ok: false, reasons: ['last_bar_incomplete'] };
  if (nowMs - lastEnd > cfg.freshBarMaxMin * 60e3) fail.push('bars_stale');
  const win = bars.filter(b => b.t >= last.t - cfg.lookbackMin * 60e3 + 300e3);
  const hi = Math.max(...win.map(b => b.h));
  const pullbackPct = hi > 0 ? (1 - last.c / hi) * 100 : 0;
  if (!(pullbackPct >= cfg.pullbackPct)) fail.push(`pullback<${cfg.pullbackPct}%(${pullbackPct.toFixed(1)})`);
  if (pullbackPct > cfg.maxPullbackPct) fail.push(`pullback>${cfg.maxPullbackPct}%`);
  if (!(last.c > last.o)) fail.push('not_green');
  if (!(last.c > prev.c)) fail.push('not_above_prev_close');
  if (!(last.v > 0)) fail.push('no_volume_last_bar');
  if (livePrice != null && last.c > 0 && Math.abs(livePrice / last.c - 1) * 100 > cfg.maxPriceDriftPct) fail.push('price_drift');
  return { ok: fail.length === 0, reasons: fail, high: hi, pullbackPct, lastClose: last.c, barT: last.t };
}

// ---------- paper execution / exits / costs ----------
export function openPosition({ price, liquidityUsd, cfg, now, venue = 'dex', feePct = cfg.feePct, exitFeePct = feePct, buyTaxPct = 0, sellTaxPct = 0 }) {
  const fill = price * (1 + (cfg.buySlippagePct + buyTaxPct) / 100);
  const fee = cfg.sizeUsd * feePct / 100;
  const qty = (cfg.sizeUsd - fee) / fill;
  return { entryPrice: fill, refPrice: price, qty, costUsd: cfg.sizeUsd, entryFeeUsd: fee, entryAt: now,
    tpPrice: fill * (1 + cfg.tpPct / 100), stopPrice: fill * (1 - cfg.slPct / 100), liqAtEntry: liquidityUsd, peak: price, trough: price, venue, exitFeePct, sellTaxPct };
}

/** One price observation -> {type:'hold'|'sell', reason, stop, peak}. Order: stop, liquidity, tp, time. */
export function exitDecision(p, obs, cfg, now) {
  const { price, liquidityUsd } = obs;
  const peak = Math.max(p.peak ?? price, price);
  if (price <= p.stopPrice) return { type: 'sell', reason: 'stop_loss', stop: true, peak };
  if (liquidityUsd && p.liqAtEntry && liquidityUsd < p.liqAtEntry * cfg.liqExitFraction) return { type: 'sell', reason: 'liquidity_drop', stop: true, peak };
  if (price >= p.tpPrice) return { type: 'sell', reason: 'tp', stop: false, peak };
  if (now - p.entryAt >= cfg.maxHoldHours * 3600e3) return { type: 'sell', reason: 'max_hold', stop: false, peak };
  return { type: 'hold', peak };
}

/** Close at observed price. gross = pure price move on the nominal size (no slippage/fee); net includes every modelled cost. */
export function closeTrade(p, price, stop, cfg) {
  const sellSlip = cfg.sellSlippagePct + (p.sellTaxPct || 0) + (stop ? cfg.stopExtraSlippagePct : 0);
  const fill = price * (1 - sellSlip / 100);
  const gross = p.qty * fill;
  const exitFee = gross * (p.exitFeePct ?? cfg.feePct) / 100;
  const proceeds = gross - exitFee;
  const netUsd = proceeds - p.costUsd;
  const grossUsd = p.costUsd * (price / p.refPrice - 1);
  return { fill, proceeds, netUsd, netPct: netUsd / p.costUsd * 100, grossUsd, grossPct: grossUsd / p.costUsd * 100 };
}

/** Shadow tracker: did the same entry reach +30% / +50% before the -SL level or max hold? (info only) */
export function shadowStep(sh, price, cfg, now) {
  if (sh.done) return sh;
  sh.peak = Math.max(sh.peak, price);
  for (const t of cfg.shadowTpPcts) if (sh.hits[t] == null && price >= sh.entryPrice * (1 + t / 100)) sh.hits[t] = now;
  if (price <= sh.stopPrice) { sh.done = true; sh.endedBy = 'stop'; }
  else if (now - sh.entryAt >= cfg.maxHoldHours * 3600e3) { sh.done = true; sh.endedBy = 'time'; }
  return sh;
}

/** Status metrics + progress toward the live gate. closed = [{symbol,addr,netUsd,netPct,reason,closedAt}] */
export function summarize(closed, startedAtMs, nowMs, cfg, shadowDone = []) {
  const n = closed.length, ord = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
  const wins = ord.filter(c => c.netUsd > 0).length;
  const totalNetUsd = ord.reduce((a, c) => a + c.netUsd, 0);
  const avgNetPct = n ? ord.reduce((a, c) => a + c.netPct, 0) / n : null;
  let eq = 0, pk = 0, dd = 0; for (const c of ord) { eq += c.netUsd; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const tpHitRate = n ? ord.filter(c => c.reason === 'tp').length / n : null;
  const half = Math.floor(n / 2), h1 = ord.slice(0, half), h2 = ord.slice(half);
  const sum = a => a.reduce((x, c) => x + c.netUsd, 0);
  const byTok = new Map(); for (const c of ord) byTok.set(c.addr, (byTok.get(c.addr) || 0) + c.netUsd);
  const tokPos = [...byTok.values()].filter(v => v > 0).length;
  const days = (nowMs - startedAtMs) / 86400e3;
  const sh = shadowDone.length ? Object.fromEntries(cfg.shadowTpPcts.map(t => [`tp${t}HitRate`, +(shadowDone.filter(s => s.hits?.[t] != null).length / shadowDone.length).toFixed(3)])) : {};
  const gate = {
    days: { value: +days.toFixed(2), need: cfg.gateDays, ok: days >= cfg.gateDays },
    closed: { value: n, need: cfg.gateClosed, ok: n >= cfg.gateClosed },
    avgNetPct: { value: avgNetPct == null ? null : +avgNetPct.toFixed(2), need: `> ${cfg.gateAvgNetPct}`, ok: avgNetPct != null && avgNetPct > cfg.gateAvgNetPct },
    tpHitRate: { value: tpHitRate == null ? null : +tpHitRate.toFixed(3), need: `> ${cfg.gateTpHitRate}`, ok: tpHitRate != null && tpHitRate > cfg.gateTpHitRate },
    bothHalvesPositive: { value: n >= 2 ? [+sum(h1).toFixed(2), +sum(h2).toFixed(2)] : null, ok: n >= 2 && sum(h1) > 0 && sum(h2) > 0 },
    tokensPositiveShare: { value: byTok.size ? +(tokPos / byTok.size).toFixed(3) : null, need: `>= ${cfg.gateTokenPosShare}`, ok: byTok.size > 0 && tokPos / byTok.size >= cfg.gateTokenPosShare },
    maxDdUsd: { value: +dd.toFixed(2), need: `< ${cfg.gateMaxDdUsd}`, ok: n > 0 && dd < cfg.gateMaxDdUsd },
  };
  gate.allPass = Object.values(gate).every(g => g.ok);
  return { closedCount: n, winRate: n ? +(wins / n).toFixed(3) : null, avgNetPct: avgNetPct == null ? null : +avgNetPct.toFixed(2),
    totalNetUsd: +totalNetUsd.toFixed(2), maxDrawdownUsd: +dd.toFixed(2), tpHitRate: tpHitRate == null ? null : +tpHitRate.toFixed(3),
    tokensTraded: byTok.size, tokensPositive: tokPos, daysRunning: +days.toFixed(2), shadow: { n: shadowDone.length, ...sh }, gate };
}

/** Per venue / mcap bucket / venue x bucket stats of closed trades (record fields: venue, bucket, netUsd, netPct, reason). */
export function breakdown(closed) {
  const grp = (keyFn) => {
    const m = new Map();
    for (const c of closed) { const k = keyFn(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
    return Object.fromEntries([...m].map(([k, a]) => [k, { n: a.length, winRate: +(a.filter(c => c.netUsd > 0).length / a.length).toFixed(3),
      avgNetPct: +(a.reduce((x, c) => x + c.netPct, 0) / a.length).toFixed(2), totalNetUsd: +a.reduce((x, c) => x + c.netUsd, 0).toFixed(2),
      tpHitRate: +(a.filter(c => c.reason === 'tp').length / a.length).toFixed(3) }]));
  };
  return { byVenue: grp(c => c.venue || 'dex'), byBucket: grp(c => c.bucket || '?'), byVenueBucket: grp(c => `${c.venue || 'dex'}/${c.bucket || '?'}`) };
}
