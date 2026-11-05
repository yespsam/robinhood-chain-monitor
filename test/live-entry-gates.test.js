import test from "node:test";
import assert from "node:assert/strict";
import { checkGates, consecutiveLossPauseDecision, consecutiveLossStreak } from "../src/live-entry-gates.js";
import { advancePaperStrategyAccount, createPaperStrategyAccount, evaluatePaperStrategies } from "../src/paper-strategy-engine.js";
import { breakoutCandles, sourcedNarrative } from "./fixtures/paper-strategy-v2.js";

const offPromo = { LIVE_REQUIRE_PAPER_SQN: "0", LIVE_REQUIRE_PAPER_CLOSED: "0" };
const loss = (closedAtMs) => ({ realizedPnl: -1, closedAtMs });
const win = (closedAtMs) => ({ realizedPnl: 1, closedAtMs });

test("two live losses allow, three block, and a win resets the streak", () => {
  assert.equal(consecutiveLossStreak([loss(1), loss(2)]), 2);
  const two = consecutiveLossPauseDecision({ closedTrades: [loss(1), loss(2)], nowMs: 10, env: offPromo });
  assert.equal(two.allow, true);
  assert.equal(two.streak, 2);
  const three = consecutiveLossPauseDecision({ closedTrades: [loss(1), loss(2), loss(3)], nowMs: 10, env: offPromo });
  assert.equal(three.allow, false);
  assert.match(three.reason, /最近 3 笔已平仓全部亏损/);
  const reset = consecutiveLossPauseDecision({
    closedTrades: [loss(1), loss(2), loss(3), win(4), loss(5)], nowMs: 10, env: offPromo,
  });
  assert.equal(reset.streak, 1);
  assert.equal(reset.allow, true);
  assert.equal(consecutiveLossPauseDecision({ closedTrades: [loss(1), loss(2), loss(3)], env: { LIVE_CONSECUTIVE_LOSS_PAUSE: "0" } }).allow, true);
});

test("optional cooldown expires and a scratch ends the loss streak", () => {
  const recent = consecutiveLossPauseDecision({
    closedTrades: [loss(0), loss(60_000), loss(120_000)], nowMs: 130_000,
    env: { LIVE_CONSECUTIVE_LOSS_PAUSE_MINUTES: "10" },
  });
  assert.equal(recent.allow, false);
  assert.match(recent.reason, /冷却 10 分钟/);
  const later = consecutiveLossPauseDecision({
    closedTrades: [loss(0), loss(60_000), loss(120_000)], nowMs: 120_000 + 10 * 60_000,
    env: { LIVE_CONSECUTIVE_LOSS_PAUSE_MINUTES: "10" },
  });
  assert.equal(later.allow, true);
  assert.equal(consecutiveLossStreak([loss(1), { realizedPnl: 0, closedAtMs: 2 }, loss(3)]), 1);
});

test("daily loss is checked before the streak, then paper promotion", () => {
  const great = Array.from({ length: 30 }, () => 1);
  const daily = checkGates({
    closedTrades: [win(1)], trades: great, sessionPresent: true, nowMs: 10,
    dailyLoss: { allow: false, reason: "日亏损已达上限，拒绝 LIVE 新开仓" },
  });
  assert.equal(daily.allow, false);
  assert.equal(daily.gate, "daily_loss");
  assert.match(daily.reason, /日亏损/);
  const streak = checkGates({
    closedTrades: [loss(1), loss(2), loss(3)], trades: great, sessionPresent: true, nowMs: 10,
    dailyLoss: { allow: true },
  });
  assert.equal(streak.allow, false);
  assert.equal(streak.gate, "consecutive_loss");
  const promoted = checkGates({ closedTrades: [], trades: great, sessionPresent: true, nowMs: 10, dailyLoss: { allow: true } });
  assert.equal(promoted.allow, true);
  assert.equal(promoted.promotion.closed, 30);
});

const NOW = Date.parse("2026-09-20T10:00:00Z");
const CA = `0x${"c".repeat(40)}`;

function flapRow() {
  const iso = (value) => new Date(value).toISOString();
  const row = evaluatePaperStrategies({
    nowMs: NOW, marketStatus: "ok", observedAt: iso(NOW), klineStatus: "ok",
    token: { chain: "robinhood", address: CA, symbol: "TEST", marketStage: "internal", price: 1, liquidity: 60_000, volume: 10_000, isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0, launchpad: "flap", launchpadPlatform: "flap", bondingCurveProgress: 0.5, creationTimestamp: NOW - 600_000 },
    flow: { fresh: true, complete: true, status: "healthy", coverageGap: null, observedAt: iso(NOW), highProfitCount: 6, fomoCount: 3, uniqueBuyerCount: 10, smartMoneyCount: 4, netBuyUsd: 6_000, wallets: [] },
    narrative: sourcedNarrative(NOW, "robinhood", CA),
    candles: breakoutCandles(NOW),
  }).find((item) => item.strategyId === "internal");
  assert.equal(row.evidence.bondingCurveProgress, 0.5);
  assert.equal(row.evidence.bondingCurveProgressStatus, "known");
  assert.equal(row.evidence.curveProgressGate.allow, true);
  return row;
}

test("a flap buy keeps curve progress and refuses LIVE until the paper book qualifies", () => {
  const row = flapRow();
  const blocked = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), {
    evaluations: [row], nowMs: NOW, env: {}, gmgnStopClient: null,
  });
  assert.equal(blocked.trades.length, 1);
  assert.equal(blocked.trades[0].entryEvidence.bondingCurveProgress, 0.5);
  assert.equal(blocked.trades[0].entryEvidence.bondingCurveProgressStatus, "known");
  assert.equal(blocked.trades[0].entryEvidence.liveEntryGate.allow, false);
  assert.match(blocked.trades[0].entryEvidence.liveEntryGate.reason, /未达到 LIVE 晋升线/);
  assert.equal(Object.values(blocked.positions)[0].liveLadder, undefined);
  const decision = blocked.liveDecisions.at(-1);
  assert.equal(decision.kind, "live_entry_refused");
  assert.equal(decision.ok, false);
  assert.equal(decision.bondingCurveProgress, 0.5);
  assert.equal(decision.curveProgressGate.allow, true);
  const opened = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), {
    evaluations: [row], nowMs: NOW, gmgnStopClient: null,
    env: { LIVE_REQUIRE_PAPER_SQN: "0", LIVE_REQUIRE_PAPER_CLOSED: "0", LIVE_CONSECUTIVE_LOSS_PAUSE: "0" },
  });
  assert.equal(Object.values(opened.positions)[0].liveLadder.stopPriceScale, 0.8);
  assert.equal(opened.liveDecisions, undefined);
});
