import test from "node:test";
import assert from "node:assert/strict";
import { applyPrincipalOutStop, createLiveLadder, principalOutConfirmed } from "../src/live-ladder-breakeven.js";
import { advancePaperStrategyAccount, createPaperStrategyAccount, evaluatePaperStrategies, validatePaperStrategyAccount } from "../src/paper-strategy-engine.js";
import { breakoutCandles, sourcedNarrative } from "./fixtures/paper-strategy-v2.js";

const ENTRY = 0.001;
const on = { LIVE_BREAKEVEN_AFTER_PRINCIPAL: "true", LIVE_BREAKEVEN_CUSHION_BPS: "0" };

test("TP1 confirmation moves the remaining stop to cost as price_scale 1", () => {
  const open = createLiveLadder({ entryPrice: ENTRY });
  assert.equal(open.semantics, "price_scale");
  assert.equal(open.stopPriceScale, 0.8);
  assert.equal(open.absoluteStopPrice, ENTRY * 0.8);
  assert.equal(open.breakevenApplied, false);

  const held = applyPrincipalOutStop(open, { tp1Confirmed: false, remainingQuantity: 40, entryPrice: ENTRY, env: on });
  assert.equal(held.stopPriceScale, 0.8);
  assert.equal(held.breakevenApplied, false);
  assert.match(held.reason, /未确认/);

  const moved = applyPrincipalOutStop(open, { tp1Confirmed: true, remainingQuantity: 40, entryPrice: ENTRY, env: on });
  assert.equal(moved.tp1Status, "confirmed");
  assert.equal(moved.stopPriceScale, 1);
  assert.equal(moved.absoluteStopPrice, ENTRY);
  assert.equal(moved.breakevenApplied, true);
  assert.match(moved.reason, /price_scale 1/);
  const again = applyPrincipalOutStop(moved, { tp1Confirmed: false, remainingQuantity: 40, entryPrice: ENTRY, env: on });
  assert.equal(again.stopPriceScale, 1, "a later non-event must not restore the deep stop");
});

test("flat remainder and a disabled switch do not invent a breakeven stop", () => {
  const open = createLiveLadder({ entryPrice: ENTRY });
  const flat = applyPrincipalOutStop(open, { tp1Confirmed: true, remainingQuantity: 0, entryPrice: ENTRY, env: on });
  assert.equal(flat.flat, true);
  assert.equal(flat.stopPriceScale, null);
  assert.equal(flat.breakevenApplied, false);
  assert.match(flat.reason, /已平/);
  const off = applyPrincipalOutStop(open, {
    tp1Confirmed: true, remainingQuantity: 10, entryPrice: ENTRY,
    env: { LIVE_BREAKEVEN_AFTER_PRINCIPAL: "false" },
  });
  assert.equal(off.stopPriceScale, 0.8);
  assert.equal(off.breakevenApplied, false);
  const cushion = applyPrincipalOutStop(open, {
    tp1Confirmed: true, remainingQuantity: 10, entryPrice: ENTRY,
    env: { LIVE_BREAKEVEN_CUSHION_BPS: "100" },
  });
  assert.equal(cushion.stopPriceScale, 1.01);
  assert.equal(cushion.absoluteStopPrice, ENTRY * 1.01);
  assert.equal(cushion.cushionBps, 100);
});

test("principal-out is the partial that returns the entry budget while size remains", () => {
  assert.equal(principalOutConfirmed({ entryUsd: 10, returnedUsd: 9.9, remainingQuantity: 4 }), false);
  assert.equal(principalOutConfirmed({ entryUsd: 10, returnedUsd: 10, remainingQuantity: 4 }), true);
  assert.equal(principalOutConfirmed({ entryUsd: 10, returnedUsd: 10, remainingQuantity: 0 }), false);
  assert.equal(principalOutConfirmed({ entryUsd: 10, returnedUsd: 1, remainingQuantity: 4, explicit: true }), true);
});

test("a confirmed paper partial that recovers principal raises the live ladder stop", () => {
  const NOW = Date.parse("2026-09-20T10:00:00Z");
  const CA = `0x${"c".repeat(40)}`;
  const iso = (value) => new Date(value).toISOString();
  const input = {
    nowMs: NOW, marketStatus: "ok", observedAt: iso(NOW), klineStatus: "ok",
    token: { chain: "robinhood", address: CA, symbol: "TEST", marketStage: "internal", price: 1, liquidity: 60_000, volume: 10_000, isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0, launchpad: "verified_feed_launchpad", launchpadPlatform: "flap", bondingCurveProgress: 0.5, creationTimestamp: NOW - 600_000 },
    flow: { fresh: true, complete: true, status: "healthy", coverageGap: null, observedAt: iso(NOW), highProfitCount: 6, fomoCount: 3, uniqueBuyerCount: 10, smartMoneyCount: 4, netBuyUsd: 6_000, wallets: [] },
    narrative: sourcedNarrative(NOW, "robinhood", CA),
    candles: breakoutCandles(NOW),
  };
  const row = evaluatePaperStrategies(input).find((item) => item.strategyId === "internal");
  assert.equal(row.decision, "可模拟");
  let account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [row], nowMs: NOW });
  let position = Object.values(account.positions)[0];
  assert.equal(position.liveLadder.semantics, "price_scale");
  assert.equal(position.liveLadder.stopPriceScale, 0.8);
  assert.equal(position.liveLadder.breakevenApplied, false);
  const mark = (price, nowMs) => ({ chain: "robinhood", address: CA, price, status: "ok", observedAt: iso(nowMs) });
  account = advancePaperStrategyAccount(account, { marks: [mark(2, NOW + 1_000)], nowMs: NOW + 1_000 });
  position = Object.values(account.positions)[0];
  assert.equal(validatePaperStrategyAccount(account), true);
  const returned = account.trades.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum + trade.netUsd, 0);
  if (returned + 1e-6 >= position.entryUsd) {
    assert.equal(position.liveLadder.stopPriceScale, 1);
    assert.equal(position.liveLadder.absoluteStopPrice, position.entryPrice);
    assert.equal(account.trades.filter((trade) => trade.side === "sell").at(-1).exitEvidence.liveLadder.stopPriceScale, 1);
  } else {
    assert.equal(position.liveLadder.stopPriceScale, 0.8);
    account = advancePaperStrategyAccount(account, { marks: [mark(5, NOW + 2_000)], nowMs: NOW + 2_000 });
    position = Object.values(account.positions)[0];
    assert.ok(position, "a 5x partial should leave a runner");
    assert.equal(position.liveLadder.breakevenApplied, true);
    assert.equal(position.liveLadder.stopPriceScale, 1);
    assert.equal(position.liveLadder.absoluteStopPrice, position.entryPrice);
    assert.equal(position.liveLadder.semantics, "price_scale");
  }
});
