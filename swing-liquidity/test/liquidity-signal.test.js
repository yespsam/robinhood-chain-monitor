import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_ID, LEGACY_STRATEGY_ID, loadConfig, assertConfig, swingLiveRequested, impactAssessment, costEstimate,
  poolScreen, qualityScore, rankCandidates, swingConfirm, targetSpot, openPosition, exitDecision, freshSellPct,
  closeTrade, securityCheck, curveActivityCheck, curveStateCheck, curveActivityFromBook, evaluateCurveEntry,
  entryBlock, noteClose, summarize, mcapBucket, minLiquidityRequired,
} from '../src/liquidity-signal.js';
import { buildSwingBars } from '../src/offline-fixture.js';

const cfg = loadConfig({});
const NOW = Date.UTC(2026, 10, 16, 4, 0, 0);

function txns(ok = true) {
  return ok
    ? { h1: { buys: 20, sells: 16 }, h6: { buys: 80, sells: 64 } }
    : { h1: { buys: 40, sells: 1 }, h6: { buys: 80, sells: 64 } };
}
function snap(over = {}) {
  return {
    symbol: 'PEPE', quote: 'WBNB', price: 1, at: NOW, mcapUsd: 400_000, liquidityUsd: 80_000,
    vol: { h1: 8_000, h6: 20_000, h24: 60_000 }, txns: txns(), ...over,
  };
}

test('defaults: paper identity, $20, max 3, cap ceiling, net target', () => {
  assert.equal(cfg.live, false);
  assert.equal(cfg.strategyId, STRATEGY_ID);
  assert.equal(cfg.sizeUsd, 20);
  assert.equal(cfg.maxPositions, 3);
  assert.equal(cfg.maxMcapUsd, 3_000_000);
  assert.equal(cfg.targetNetPct, 20);
  assert.equal(cfg.slSpotPct, 12);
  assert.equal(minLiquidityRequired(cfg), 25_000);
  assert.equal(cfg.quoteReserveFraction, 0.35);
  assert.equal(cfg.modelCushionBuyPct, 0.8);
  assert.equal(cfg.modelCushionSellPct, 1.2);
  assert.equal(cfg.modelLpFeePct, 0.25);
  assert.equal(cfg.wImpact + cfg.wDepth + cfg.wTwoSided, 1);
  assert.equal(swingLiveRequested({}), false);
  assert.equal(swingLiveRequested({ SWING_LIVE: 'true' }), true);
  const forced = loadConfig({ SWING_LIVE: 'true', SWING_STRATEGY_ID: 'custom-paper' });
  assert.equal(forced.live, false);
  assert.equal(forced.liveRequested, true);
  assert.equal(forced.strategyId, 'custom-paper');
  assert.throws(() => assertConfig({ ...cfg, live: true }), /live/);
  assert.throws(() => assertConfig({ ...cfg, strategyId: LEGACY_STRATEGY_ID }), /legacy_strategy_id/);
});

test('liquidity ordering ignores raw volume', () => {
  const deep = { addr: 'deep', liquidityUsd: 200_000, impactPct: 0.03, sideBalance: 0.9, persistence: 0.9, volumeUsd24h: 30_000 };
  const busy = { addr: 'busy', liquidityUsd: 30_000, impactPct: 0.22, sideBalance: 0.9, persistence: 0.9, volumeUsd24h: 900_000 };
  const ranked = rankCandidates([busy, deep], cfg);
  assert.equal(ranked[0].addr, 'deep');
  assert.ok(ranked[0].quality.score > ranked[1].quality.score);
  assert.ok(qualityScore(deep, cfg).depthN > qualityScore(busy, cfg).depthN);
  assert.equal(qualityScore({ ...busy, volumeUsd24h: 1 }, cfg).score, qualityScore(busy, cfg).score);
});

test('high-volume shallow pool is rejected', () => {
  const screen = poolScreen(snap({
    liquidityUsd: 8_000,
    vol: { h1: 80_000, h6: 300_000, h24: 900_000 },
    txns: { h1: { buys: 200, sells: 180 }, h6: { buys: 800, sells: 700 } },
  }), cfg, NOW);
  assert.equal(screen.ok, false);
  assert.ok(screen.reasons.includes('liq_low'));
  assert.ok(screen.reasons.includes('wash_vol_liq'));
  assert.ok(poolScreen(snap(), cfg, NOW).ok);
});

test('missing and stale market data fail closed', () => {
  assert.ok(poolScreen(snap({ price: null }), cfg, NOW).reasons.includes('no_price'));
  assert.ok(poolScreen(snap({ price: 0 }), cfg, NOW).reasons.includes('no_price'));
  assert.ok(poolScreen(snap({ at: NOW - 91_000 }), cfg, NOW).reasons.includes('stale_snapshot'));
  assert.ok(poolScreen(snap({ at: null }), cfg, NOW).reasons.includes('stale_snapshot'));
  assert.ok(poolScreen(snap({ liquidityUsd: null }), cfg, NOW).reasons.includes('no_liquidity'));
  assert.ok(poolScreen(snap({ txns: { h1: { buys: 20, sells: 16 } } }), cfg, NOW).reasons.includes('no_trade_counts'));
  assert.ok(poolScreen(snap({ vol: { h1: 100, h6: 20_000, h24: 60_000 } }), cfg, NOW).reasons.includes('vol1h_low'));
  assert.ok(poolScreen(snap({ txns: txns(false) }), cfg, NOW).reasons.includes('one_sided'));
  assert.ok(poolScreen(snap({ mcapUsd: 3_100_000 }), cfg, NOW).reasons.includes('mcap_out_of_range'));
  assert.equal(mcapBucket(2e5), 'lt300k');
});

test('price-impact cap: executable quote overrides a rosy liquidity figure and does not fall back when stale', () => {
  const rosy = impactAssessment({ sizeUsd: 20, totalLiquidityUsd: 500_000, executableBuyImpactPct: 2, executableSellImpactPct: 2.4, executableAt: NOW, executableSource: 'router' }, cfg, NOW);
  assert.equal(rosy.ok, false);
  assert.ok(rosy.reasons.includes('impact_high'));
  assert.equal(rosy.impactSource, 'executable_quote');
  assert.equal(rosy.quoteBacked, true);
  assert.ok(rosy.impactPct > 1);
  const stale = impactAssessment({ sizeUsd: 20, totalLiquidityUsd: 500_000, executableBuyImpactPct: 0.1, executableSellImpactPct: 0.1, executableAt: NOW - 120_000, executableSource: 'router' }, cfg, NOW);
  assert.ok(stale.reasons.includes('executable_quote_unusable'));
  assert.equal(stale.impactPct, null);
  const partial = impactAssessment({ sizeUsd: 20, totalLiquidityUsd: 500_000, executableBuyImpactPct: 0.1, executableAt: NOW, executableSource: 'router' }, cfg, NOW);
  assert.ok(partial.reasons.includes('executable_quote_unusable'));
  const thinReserve = impactAssessment({ sizeUsd: 20, quoteReserveUsd: 1_500 }, cfg, NOW);
  assert.ok(thinReserve.reasons.includes('impact_high'));
  assert.equal(thinReserve.impactSource, 'observed_quote_reserve');
  const model = impactAssessment({ sizeUsd: 20, totalLiquidityUsd: 80_000 }, cfg, NOW);
  assert.equal(model.ok, true);
  assert.equal(model.modelReserveAssumption, true);
  assert.equal(model.quoteBacked, false);
  assert.ok(Math.abs(model.impactPct - (20 / (80_000 * 0.35) * 100)) < 1e-9);
  const missing = impactAssessment({ sizeUsd: 20 }, cfg, NOW);
  assert.ok(missing.reasons.includes('no_liquidity_or_quote'));
});

test('swing history: short, gap, single miss, wick, crash, stale, drift', () => {
  const good = buildSwingBars(NOW);
  const ok = swingConfirm(good.bars, cfg, NOW, good.lastClose);
  assert.deepEqual(ok.reasons, []);
  assert.equal(ok.ok, true);
  assert.ok(ok.pullbackPct >= 8 && ok.pullbackPct <= 35);
  const short = buildSwingBars(NOW, { n: 20 });
  assert.ok(swingConfirm(short.bars, cfg, NOW, short.lastClose).reasons.includes('history_short'));
  const gap = buildSwingBars(NOW, { dropFrom: 20, dropCount: 3 });
  const gapR = swingConfirm(gap.bars, cfg, NOW, gap.lastClose);
  assert.equal(gapR.ok, false);
  assert.ok(gapR.reasons.includes('history_gap'));
  const oneMiss = buildSwingBars(NOW, { dropFrom: 20, dropCount: 1 });
  const one = swingConfirm(oneMiss.bars, cfg, NOW, oneMiss.lastClose);
  assert.equal(one.ok, true, one.reasons.join(','));
  const wick = buildSwingBars(NOW, { flat: true, wick: true });
  const wickR = swingConfirm(wick.bars, cfg, NOW, wick.lastClose);
  assert.equal(wickR.ok, false);
  assert.ok(wickR.reasons.includes('pullback_shallow'));
  assert.ok(wickR.refHigh < 1.05);
  assert.ok(wickR.wickHigh > 4);
  const crash = buildSwingBars(NOW, { crash: true });
  assert.ok(swingConfirm(crash.bars, cfg, NOW, crash.lastClose).reasons.includes('recent_drop'));
  const stale = swingConfirm(good.bars, cfg, good.lastT + 300_000 + 11 * 60_000, good.lastClose);
  assert.ok(stale.reasons.includes('bars_stale'));
  assert.ok(swingConfirm(good.bars, cfg, NOW, good.lastClose * 1.08).reasons.includes('price_drift'));
  assert.ok(swingConfirm(good.bars, cfg, NOW, null).reasons.includes('no_live_price'));
  assert.ok(swingConfirm([], cfg, NOW, 1).reasons.includes('bars_missing'));
});

test('cost-adjusted take-profit is +20% net, not +20% spot', () => {
  const cost = costEstimate({ totalLiquidityUsd: 100_000, knownBuyFeePct: 1, knownSellFeePct: 1 }, cfg, NOW);
  assert.equal(cost.ok, true);
  assert.equal(cost.lpFeeSource, 'model');
  assert.equal(cost.quoteBacked, false);
  assert.equal(cost.modelReserveAssumption, true);
  const pos = openPosition({ spot: 1, cost, cfg, now: NOW, liquidityUsd: 100_000 });
  const solved = targetSpot(1, cost.appliedBuyPct, cost.appliedSellPct, 20);
  assert.ok(Math.abs(pos.tpPrice - solved) < 1e-9);
  const atTarget = closeTrade(pos, pos.tpPrice, cost.appliedSellPct);
  assert.ok(Math.abs(atTarget.netPct - 20) < 1e-6);
  assert.ok(atTarget.grossPct > atTarget.netPct);
  const nominal = closeTrade(pos, 1.2, cost.appliedSellPct);
  assert.ok(nominal.grossPct === 20 || Math.abs(nominal.grossPct - 20) < 1e-9);
  assert.ok(nominal.netPct < 20);
  const quote = costEstimate({
    quoteReserveUsd: 40_000, knownBuyFeePct: 1, knownSellFeePct: 1, knownLpFeePct: 0,
  }, cfg, NOW);
  assert.equal(quote.quoteBacked, true);
  assert.equal(quote.modelReserveAssumption, false);
  assert.equal(quote.lpFeeSource, 'venue');
  assert.ok(costEstimate({ totalLiquidityUsd: 100_000 }, cfg, NOW).reasons.includes('fee_or_tax_unknown'));
});

test('stop is a spot rule and books worse than the spot move once the stop cushion is included', () => {
  const cost = costEstimate({ quoteReserveUsd: 50_000, knownBuyFeePct: 0, knownSellFeePct: 0, knownLpFeePct: 0 }, cfg, NOW);
  const pos = openPosition({ spot: 1, cost, cfg, now: 0, liquidityUsd: 50_000, quoteReserveUsd: 50_000 });
  assert.ok(Math.abs(pos.stopPrice - 0.88) < 1e-12);
  const obs = { price: 0.88, at: 1000, stale: false, liquidityUsd: 50_000, impactPct: cost.impactPct, impactSellPct: cost.impactSellPct, impactFresh: true, sellable: true };
  const d = exitDecision(pos, obs, cfg, 1000);
  assert.equal(d.reason, 'stop_loss');
  const sell = freshSellPct(pos, obs, cfg, true);
  assert.ok(sell > cost.appliedSellPct);
  const booked = closeTrade(pos, 0.88, sell);
  assert.ok(booked.grossPct < 0);
  assert.ok(booked.netPct < booked.grossPct);
  const held = exitDecision(pos, { ...obs, price: 0.9 }, cfg, 1000);
  assert.equal(held.type, 'hold');
});

test('take-profit requires a fresh in-cap impact; missing and stale prices do not book a win', () => {
  const cost = costEstimate({ quoteReserveUsd: 50_000, knownBuyFeePct: 0, knownSellFeePct: 0, knownLpFeePct: 0 }, cfg, NOW);
  const pos = openPosition({ spot: 1, cost, cfg, now: 0, quoteReserveUsd: 50_000 });
  const rich = { price: pos.tpPrice * 1.02, at: 1000, stale: false, liquidityUsd: 50_000, impactPct: cost.impactPct, impactSellPct: cost.impactSellPct, impactFresh: true, sellable: true };
  assert.equal(exitDecision(pos, rich, cfg, 1000).reason, 'tp');
  const noImpact = exitDecision(pos, { ...rich, impactFresh: false, impactPct: null, impactSellPct: null }, cfg, 1000);
  assert.equal(noImpact.type, 'hold');
  assert.equal(noImpact.reason, 'tp_blocked_no_fresh_impact');
  const stale = exitDecision(pos, { ...rich, at: 1000 - 120_000 }, cfg, 1000);
  assert.equal(stale.reason, 'stale_or_missing_price');
  const missing = exitDecision(pos, { price: null, at: null, stale: true }, cfg, 1000);
  assert.equal(missing.type, 'hold');
  const unsellable = exitDecision(pos, { ...rich, price: 1, sellable: false }, cfg, 1000);
  assert.equal(unsellable.reason, 'unsellable_writeoff');
  assert.equal(unsellable.writeoff, true);
  const wide = exitDecision(pos, { ...rich, price: 1, impactPct: cfg.maxImpactPct + 0.1, impactFresh: false }, cfg, 1000);
  assert.equal(wide.reason, 'impact_widened');
});

test('duplicate, cooldown, and repeated stopouts', () => {
  const book = { positions: { a: {} }, cooldown: {}, knifeBan: {}, stopTimes: {}, entriesByDay: {} };
  assert.equal(entryBlock('a', book, cfg, NOW), 'duplicate');
  noteClose(book, 'b', 'stop_loss', cfg, NOW);
  assert.equal(entryBlock('b', { ...book, positions: {} }, cfg, NOW + 1000), 'cooldown');
  assert.ok(book.cooldown.b - NOW >= cfg.stopCooldownHours * 3600e3 - 1);
  noteClose(book, 'b', 'stop_loss', cfg, NOW + 1000);
  assert.ok(book.knifeBan.b > NOW);
  assert.equal(entryBlock('b', { ...book, positions: {} }, cfg, NOW + 2000), 'knife_ban');
  const tpBook = { positions: {}, cooldown: {}, knifeBan: {}, stopTimes: {}, entriesByDay: {} };
  noteClose(tpBook, 'c', 'tp', cfg, NOW);
  assert.ok(tpBook.cooldown.c - NOW < cfg.stopCooldownHours * 3600e3);
  assert.equal(tpBook.knifeBan.c, undefined);
});

test('security and curve state fail closed when fields are missing', () => {
  const ok = { honeypot: false, cannotBuy: false, cannotSellAll: false, buyTaxPct: 0, sellTaxPct: 1, openSource: true, hiddenOwner: false, ownerChangeBalance: false, at: NOW };
  assert.equal(securityCheck(ok, cfg).ok, true);
  assert.ok(securityCheck(null, cfg).reasons.includes('security_unknown'));
  assert.ok(securityCheck({ ...ok, honeypot: true }, cfg).reasons.includes('honeypot'));
  assert.ok(securityCheck({ ...ok, cannotSellAll: '1' }, cfg).reasons.includes('cannot_sell_unknown'));
  assert.ok(securityCheck({ ...ok, buyTaxPct: null }, cfg).reasons.includes('tax_unknown'));
  assert.ok(securityCheck({ ...ok, openSource: false }, cfg).reasons.includes('closed_or_unknown_source'));
  const activity = { vol1hUsd: 5_000, buys1h: 20, sells1h: 12, buyers1h: 10, sellers1h: 6, activeBars1h: 5, ageMin: 80 };
  assert.equal(curveActivityCheck(activity, cfg).ok, true);
  assert.ok(curveActivityCheck({ ...activity, sells1h: 0 }, cfg).reasons.includes('c_sells_low'));
  assert.ok(curveActivityCheck(null, cfg).reasons.includes('c_no_activity'));
  const cs = { status: 1, reserveBnb: 20, circ: 400e6, thresh: 800e6, priceBnb: 2e-7, quoteIsNative: true, buyFeeBps: 100, sellFeeBps: 100, at: NOW };
  const v = curveStateCheck(cs, 600, cfg, NOW);
  assert.equal(v.ok, true, v.reasons.join());
  assert.ok(Math.abs(v.reserveUsd - 12_000) < 1e-6);
  assert.ok(curveStateCheck(null, 600, cfg, NOW).reasons.includes('c_no_state'));
  assert.ok(curveStateCheck(cs, null, cfg, NOW).reasons.includes('c_no_bnb_usd'));
  assert.ok(curveStateCheck({ ...cs, reserveBnb: 0 }, 600, cfg, NOW).reasons.includes('c_reserve_low'));
  assert.ok(curveStateCheck({ ...cs, at: NOW - 120_000 }, 600, cfg, NOW).reasons.includes('c_state_stale'));
  assert.ok(curveStateCheck({ ...cs, buyFeeBps: null }, 600, cfg, NOW).reasons.includes('c_fee_unknown'));
  const book = { tokens: new Map() };
  assert.equal(curveActivityFromBook(book, 'missing', NOW), null);
  const judged = evaluateCurveEntry({ activity, state: cs, bnbUsd: 600 }, cfg, NOW);
  assert.equal(judged.ok, true, judged.reasons.join());
  assert.equal(judged.impact.quoteBacked, true);
  const missingReserve = evaluateCurveEntry({ activity, state: null, bnbUsd: 600 }, cfg, NOW);
  assert.equal(missingReserve.ok, false);
  assert.ok(missingReserve.reasons.includes('c_no_state'));
  assert.equal(missingReserve.impact, null);
});

test('informational gate does not authorize live', () => {
  const none = summarize([], 0, 1000, cfg);
  assert.equal(none.gate.allPass, false);
  assert.equal(none.gate.authorizesLive, false);
  const many = Array.from({ length: 220 }, (_, i) => ({ addr: 't' + (i % 5), netUsd: 3, netPct: 15, reason: 'tp', closedAt: i * 1000 }));
  const g = summarize(many, 0, 15 * 86400e3, cfg);
  assert.equal(g.gate.allPass, true);
  assert.equal(g.gate.authorizesLive, false);
});
