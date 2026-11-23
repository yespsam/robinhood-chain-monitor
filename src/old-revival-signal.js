// 老盘重启 (old-token revival) — PAPER ONLY. Pure signal / exit / cost logic.
// This module never touches live trading. See docs/old-revival-paper.md.
export const STRATEGY_ID = 'paper-old-revival';
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export function loadConfig(env = process.env) {
  const e = k => env[`OLD_REVIVAL_${k}`];
  return Object.freeze({
    enabled: bool(e('ENABLED'), false),
    live: bool(e('LIVE'), false),                 // must stay false; runtime refuses to start otherwise
    strategyId: e('STRATEGY_ID') || STRATEGY_ID,
    // candidates
    minAgeHours: num(e('MIN_AGE_HOURS'), 12),
    maxAgeDays: num(e('MAX_AGE_DAYS'), 14),
    requireFlapSuffix: bool(e('REQUIRE_FLAP_SUFFIX'), true), // Flap vanity addresses end in 7777 / 8888
    // chart shape (hourly bars)
    minDrawdownPct: num(e('MIN_DRAWDOWN_PCT'), 70),     // ATH -> trough
    maxPriceToAth: num(e('MAX_PRICE_TO_ATH'), 0.5),     // still >=50% below ATH
    maxReboundFromLow: num(e('MAX_REBOUND_FROM_LOW'), 3), // price/low-after-ATH, avoid chasing
    baseHours: num(e('BASE_HOURS'), 6),
    baseMaxRange: num(e('BASE_MAX_RANGE'), 1.8),        // hi/lo of base window (excl. trigger hour)
    // trigger
    spike5m: num(e('VOL_SPIKE_5M'), 3),
    spike1h: num(e('VOL_SPIKE_1H'), 3),
    spikeMode: (e('SPIKE_MODE') || 'either'),          // either | both
    minH1VolUsd: num(e('MIN_H1_VOL_USD'), 1500),
    minBuyRatio: num(e('MIN_BUY_RATIO'), 0.55),         // buys/(buys+sells) over h1 (tx count)
    minBuysH1: num(e('MIN_BUYS_H1'), 8),
    requireHoldersRising: bool(e('REQUIRE_HOLDERS_RISING'), true),
    holdersRiseMinPct: num(e('HOLDERS_RISE_MIN_PCT'), 1),
    requireNetBuy: bool(e('REQUIRE_NET_BUY'), true),     // Binance netBuy>0 when known
    requireSmart: bool(e('REQUIRE_SMART'), false),       // smart-money / KOL holder: bonus unless true
    // safety
    minLiquidityUsd: num(e('MIN_LIQ_USD'), 20000),
    minMcapUsd: num(e('MIN_MCAP_USD'), 30000),
    maxMcapUsd: num(e('MAX_MCAP_USD'), 20_000_000),
    maxVolMcap24h: num(e('MAX_VOL_MCAP'), 8),           // wash-trade: 24h vol / mcap
    maxVolLiq24h: num(e('MAX_VOL_LIQ'), 40),
    maxTxPerWallet: num(e('MAX_TX_PER_WALLET'), 12),    // wash-trade: txns / unique wallets (GeckoTerminal)
    maxTaxPct: num(e('MAX_TAX_PCT'), 5),
    requireSecurity: bool(e('REQUIRE_SECURITY'), true),  // GoPlus check; fail-closed
    // execution (paper)
    cashUsd: num(e('CASH_USD'), 200),
    sizeUsd: num(e('SIZE_USD'), 20),
    maxPositions: num(e('MAX_POSITIONS'), 5),
    maxDailyEntries: num(e('MAX_DAILY_ENTRIES'), 10),
    cooldownHours: num(e('COOLDOWN_HOURS'), 12),
    entrySlippagePct: num(e('ENTRY_SLIPPAGE_PCT'), 2),
    exitSlippagePct: num(e('EXIT_SLIPPAGE_PCT'), 3),
    stopExtraSlippagePct: num(e('STOP_EXTRA_SLIPPAGE_PCT'), 5),
    feePct: num(e('FEE_PCT'), 0.25),                     // per side (Pancake v2 pool fee)
    // exits (mirrors LIVE ladder shape but tighter stop)
    stopPct: num(e('STOP_PCT'), 15),
    tp1Pct: num(e('TP1_PCT'), 40),
    tp1SellFraction: num(e('TP1_SELL_FRACTION'), 0.7),
    breakevenAfterTp1: bool(e('BREAKEVEN_AFTER_TP1'), true),
    trailActivatePct: num(e('TRAIL_ACTIVATE_PCT'), 70),
    trailDrawdownPct: num(e('TRAIL_DRAWDOWN_PCT'), 30),
    maxHoldHours: num(e('MAX_HOLD_HOURS'), 24),
    liqExitFraction: num(e('LIQ_EXIT_FRACTION'), 0.5),   // exit if liquidity < 50% of entry
    // runtime
    pollSec: num(e('POLL_SEC'), 60),
    discoverySec: num(e('DISCOVERY_SEC'), 300),
    maxWatch: num(e('MAX_WATCH'), 150),
    dataDir: e('DATA_DIR') || '',
  });
}

export const isFlapAddress = a => /^0x[0-9a-fA-F]{36}(7777|8888)$/.test(a || '');

/** Volume spike vs baseline, from rolling windows (m5,h1,h6 in USD). */
export function volumeSpike({ m5 = 0, h1 = 0, h6 = 0 }) {
  const priorH1 = Math.max(h1 - m5, 0) / 11;                 // avg 5m bar in the rest of the hour
  const baseH = Math.max(h6 - h1, 0) / 5;                    // avg hourly vol of the prior 5h
  const r5 = priorH1 > 0 ? m5 / priorH1 : (m5 > 0 ? Infinity : 0);
  const r1 = baseH > 0 ? h1 / baseH : (h1 > 0 ? Infinity : 0);
  // a spike on a dead baseline is capped so a single $50 swap cannot look like 1000x
  return { r5, r1, baseHourlyUsd: baseH };
}

/** Chart shape on ascending hourly bars [{t,o,h,l,c,v}] ending with the current (partial) hour. */
export function chartShape(bars, cfg) {
  if (!Array.isArray(bars) || bars.length < Math.max(cfg.baseHours + 2, 6)) return { ok: false, reason: 'chart_too_short' };
  let athIdx = 0;
  for (let i = 0; i < bars.length; i++) if (bars[i].h > bars[athIdx].h) athIdx = i;
  const ath = bars[athIdx].h;
  let low = Infinity;
  for (let i = athIdx; i < bars.length; i++) if (bars[i].l < low) low = bars[i].l;
  const last = bars[bars.length - 1];
  const price = last.c;
  const maxDrawdownPct = (1 - low / ath) * 100;
  const baseBars = bars.slice(-(cfg.baseHours + 1), -1);      // exclude the trigger hour
  const baseHi = Math.max(...baseBars.map(b => b.h)), baseLo = Math.min(...baseBars.map(b => b.l));
  const baseRange = baseLo > 0 ? baseHi / baseLo : Infinity;
  return { ok: true, ath, athIdx, low, price, maxDrawdownPct, priceToAth: price / ath,
    reboundFromLow: price / low, baseRange, bars: bars.length };
}

/** Evaluate a candidate. f = features. Returns {pass, reasons[], bonus[], score}. */
export function evaluate(f, cfg) {
  const fail = [], bonus = [];
  const chk = (ok, why) => { if (!ok) fail.push(why); };
  chk(f.ageHours >= cfg.minAgeHours, `age<${cfg.minAgeHours}h`);
  chk(f.ageHours <= cfg.maxAgeDays * 24, `age>${cfg.maxAgeDays}d`);
  chk(f.liquidityUsd >= cfg.minLiquidityUsd, `liq<${cfg.minLiquidityUsd}`);
  chk(f.mcapUsd >= cfg.minMcapUsd && f.mcapUsd <= cfg.maxMcapUsd, 'mcap_out_of_range');
  // wash trading
  if (f.mcapUsd > 0) chk(f.vol24 / f.mcapUsd <= cfg.maxVolMcap24h, `wash:vol24/mcap=${(f.vol24 / f.mcapUsd).toFixed(1)}`);
  if (f.liquidityUsd > 0) chk(f.vol24 / f.liquidityUsd <= cfg.maxVolLiq24h, 'wash:vol24/liq');
  if (f.txPerWallet != null) chk(f.txPerWallet <= cfg.maxTxPerWallet, `wash:tx/wallet=${f.txPerWallet.toFixed(1)}`);
  // chart
  const c = f.chart;
  if (!c?.ok) fail.push(c?.reason || 'no_chart');
  else {
    chk(c.maxDrawdownPct >= cfg.minDrawdownPct, `dd<${cfg.minDrawdownPct}%(${c.maxDrawdownPct.toFixed(0)})`);
    chk(c.priceToAth <= cfg.maxPriceToAth, `near_ath(${c.priceToAth.toFixed(2)})`);
    chk(c.reboundFromLow <= cfg.maxReboundFromLow, `chasing(${c.reboundFromLow.toFixed(1)}x_from_low)`);
    chk(c.baseRange <= cfg.baseMaxRange, `no_base(range ${c.baseRange.toFixed(2)}x)`);
  }
  // trigger
  const s = volumeSpike(f.vol);
  const ok5 = s.r5 >= cfg.spike5m, ok1 = s.r1 >= cfg.spike1h;
  chk(cfg.spikeMode === 'both' ? ok5 && ok1 : ok5 || ok1, `no_spike(r5=${fmt(s.r5)},r1=${fmt(s.r1)})`);
  chk(f.vol.h1 >= cfg.minH1VolUsd, `h1vol<${cfg.minH1VolUsd}`);
  if (f.buys != null) {
    const tot = f.buys + f.sells;
    chk(f.buys >= cfg.minBuysH1, `buys_h1<${cfg.minBuysH1}`);
    chk(tot > 0 && f.buys / tot >= cfg.minBuyRatio, `buy_ratio<${cfg.minBuyRatio}`);
  } else fail.push('no_txns');
  if (f.netBuyUsd != null) chk(f.netBuyUsd > 0 || !cfg.requireNetBuy, 'net_buy<=0');
  if (cfg.requireHoldersRising) {
    if (f.holdersRisePct == null) fail.push('holders_unknown');
    else chk(f.holdersRisePct >= cfg.holdersRiseMinPct, `holders_flat(${f.holdersRisePct.toFixed(1)}%)`);
  }
  if (f.smartHolders > 0) bonus.push(`smart${f.smartHolders}`);
  if (f.kolHolders > 0) bonus.push(`kol${f.kolHolders}`);
  if (cfg.requireSmart && !bonus.length) fail.push('no_smart_money');
  // security
  const sec = f.security;
  if (!sec) { if (cfg.requireSecurity) fail.push('security_unknown'); }
  else {
    if (sec.honeypot) fail.push('honeypot');
    if (sec.cannotSellAll) fail.push('cannot_sell_all');
    if (Math.max(sec.buyTaxPct || 0, sec.sellTaxPct || 0) > cfg.maxTaxPct) fail.push(`tax>${cfg.maxTaxPct}%`);
  }
  const score = Math.max(0, 50 + bonus.length * 10 + Math.min(20, Math.log2(Math.max(1, Math.min(s.r1, s.r5, 64))) * 4) - fail.length * 15);
  return { pass: fail.length === 0, reasons: fail, bonus, score: Math.round(score), spike: s };
}
const fmt = x => (Number.isFinite(x) ? x.toFixed(1) : 'inf');

// ---------- paper execution / exits ----------
export function openPosition({ price, liquidityUsd, cfg, now }) {
  const slip = Math.max(cfg.entrySlippagePct, (cfg.sizeUsd / Math.max(liquidityUsd, 1)) * 200) / 100; // size/liq*2 impact floor
  const fill = price * (1 + slip);
  const fee = cfg.sizeUsd * cfg.feePct / 100;
  const qty = (cfg.sizeUsd - fee) / fill;
  return { entryPrice: fill, refPrice: price, qty, costUsd: cfg.sizeUsd, entryFeeUsd: fee, entryAt: now,
    peak: price, tp1Done: false, stopPrice: fill * (1 - cfg.stopPct / 100), proceedsUsd: 0, qtyOpen: qty, liqAtEntry: liquidityUsd };
}

/** Returns an action {type:'hold'|'sell', fraction, reason, fillPrice} for one price observation. */
export function exitDecision(p, obs, cfg, now) {
  const { price, liquidityUsd } = obs;
  const pnlPct = (price / p.entryPrice - 1) * 100;
  const peak = Math.max(p.peak, price);
  const sellPx = (stop) => price * (1 - (cfg.exitSlippagePct + (stop ? cfg.stopExtraSlippagePct : 0)) / 100);
  if (price <= p.stopPrice) return { type: 'sell', fraction: 1, reason: p.tp1Done ? 'breakeven_stop' : 'stop_loss', fillPrice: sellPx(true), peak };
  if (liquidityUsd && p.liqAtEntry && liquidityUsd < p.liqAtEntry * cfg.liqExitFraction) return { type: 'sell', fraction: 1, reason: 'liquidity_drop', fillPrice: sellPx(true), peak };
  if (!p.tp1Done && pnlPct >= cfg.tp1Pct) return { type: 'sell', fraction: cfg.tp1SellFraction, reason: 'tp1', fillPrice: sellPx(false), peak, setBreakeven: cfg.breakevenAfterTp1 };
  if (p.tp1Done && (peak / p.entryPrice - 1) * 100 >= cfg.trailActivatePct && price <= peak * (1 - cfg.trailDrawdownPct / 100))
    return { type: 'sell', fraction: 1, reason: 'trailing_stop', fillPrice: sellPx(false), peak };
  if (now - p.entryAt >= cfg.maxHoldHours * 3600e3) return { type: 'sell', fraction: 1, reason: 'max_hold', fillPrice: sellPx(false), peak };
  return { type: 'hold', peak };
}

export function sellProceeds(qty, fillPrice, cfg) {
  const gross = qty * fillPrice;
  return gross - gross * cfg.feePct / 100;
}
