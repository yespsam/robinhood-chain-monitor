import test from "node:test";
import assert from "node:assert/strict";
import { curveProgressEntryDecision, curveProgressBlocksEntry } from "../src/curve-progress-entry.js";
import { evaluatePaperStrategies, advancePaperStrategyAccount, createPaperStrategyAccount } from "../src/paper-strategy-engine.js";
import { breakoutCandles, sourcedNarrative } from "./fixtures/paper-strategy-v2.js";

const NOW = Date.parse("2026-09-20T10:00:00Z");
const CA = `0x${"a".repeat(40)}`;
const iso = (value) => new Date(value).toISOString();
const env = { CURVE_PROGRESS_ENTRY_FILTER: "true", CURVE_PROGRESS_MIN: "30", CURVE_PROGRESS_MAX: "70" };

function token(progress, extra = {}) {
  return {
    chain: "bsc", address: CA, marketStage: "internal", marketCategory: "new_creation",
    launchpadPlatform: "flap", bondingCurveProgress: progress, ...extra,
  };
}

test("in-range flap curve progress is allowed", () => {
  const decision = curveProgressEntryDecision({ token: token(0.5), env });
  assert.equal(decision.applied, true);
  assert.equal(decision.allow, true);
  assert.equal(decision.progressPct, 50);
  assert.equal(decision.reason, null);
  assert.equal(curveProgressEntryDecision({ token: token(0.3), env }).allow, true);
  assert.equal(curveProgressEntryDecision({ token: token(0.7), env }).allow, true);
});

test("progress below and above the window is skipped with a reason", () => {
  const below = curveProgressEntryDecision({ token: token(0.29), env });
  const above = curveProgressEntryDecision({ token: token(96), env: { ...env, CURVE_PROGRESS_MAX: "70" } });
  assert.equal(below.allow, false);
  assert.equal(below.decision, "观察");
  assert.match(below.reason, /29% 不在 30–70%/);
  assert.equal(above.progressPct, 96);
  assert.match(above.reason, /96% 不在 30–70%/);
});

test("missing flap curve progress skips, which is the LIVE default", () => {
  for (const progress of [null, undefined, Number.NaN, "nope"]) {
    const decision = curveProgressEntryDecision({ token: token(progress), env });
    assert.equal(decision.applied, true, String(progress));
    assert.equal(decision.allow, false);
    assert.match(decision.reason, /进度未知/);
  }
});

test("pool launch, external, and non-flap venues are not gated", () => {
  const pool = curveProgressEntryDecision({
    token: token(0.05, { marketStage: "external" }),
    event: { source: "flap_pool_launch", pool: { launchKind: "DIRECT_V2_POOL_TAX" } },
    env,
  });
  assert.equal(pool.applied, false);
  assert.equal(pool.allow, true);
  const external = curveProgressEntryDecision({ token: token(0.05, { marketStage: "external", marketCategory: "completed" }), env });
  assert.equal(external.applied, false);
  const four = curveProgressEntryDecision({ token: token(0.05, { launchpadPlatform: "fourmeme" }), env });
  assert.equal(four.applied, false);
  const firstThree = curveProgressEntryDecision({
    token: { chain: "bsc", marketStage: "unknown" },
    event: { source: "new_pool_first_three", pool: { platform: "flap" } },
    env,
  });
  assert.equal(firstThree.applied, false, "creation-order lane without a progress figure is unchanged");
  const knownEarly = curveProgressEntryDecision({
    token: { chain: "bsc", marketStage: "unknown", bondingCurveProgress: 0.1 },
    event: { source: "new_pool_first_three", pool: { platform: "flap" } },
    env,
  });
  assert.equal(knownEarly.allow, false);
});

test("filter can be disabled and bounds come from the environment", () => {
  const off = curveProgressEntryDecision({ token: token(0.01), env: { CURVE_PROGRESS_ENTRY_FILTER: "false" } });
  assert.equal(off.applied, false);
  assert.equal(off.allow, true);
  const wider = curveProgressEntryDecision({ token: token(0.2), env: { CURVE_PROGRESS_MIN: "10", CURVE_PROGRESS_MAX: "80" } });
  assert.equal(wider.allow, true);
  assert.equal(wider.minPct, 10);
});

test("strategy decisions log the skip and do not open a paper position", () => {
  const base = {
    nowMs: NOW, marketStatus: "ok", observedAt: iso(NOW), klineStatus: "ok",
    token: { chain: "robinhood", address: CA, symbol: "TEST", marketStage: "internal", price: 1, liquidity: 60_000, volume: 10_000, isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0, launchpad: "verified_feed_launchpad", creationTimestamp: NOW - 600_000 },
    flow: { fresh: true, complete: true, status: "healthy", coverageGap: null, observedAt: iso(NOW), highProfitCount: 6, fomoCount: 3, uniqueBuyerCount: 10, smartMoneyCount: 4, netBuyUsd: 6_000, wallets: [] },
    narrative: sourcedNarrative(NOW, "robinhood", CA),
    candles: breakoutCandles(NOW),
  };
  const open = evaluatePaperStrategies(base).find((row) => row.strategyId === "internal");
  assert.equal(open.decision, "可模拟");
  assert.equal(open.evidence.curveProgressGate, undefined);
  assert.equal(open.evidence.bondingCurveProgress, null);
  assert.equal(open.evidence.bondingCurveProgressStatus, "unknown");
  const low = evaluatePaperStrategies({ ...base, token: { ...base.token, launchpadPlatform: "flap", bondingCurveProgress: 0.1 } }).find((row) => row.strategyId === "internal");
  assert.equal(low.decision, "观察");
  assert.equal(low.evidence.paperEligible, false);
  assert.equal(low.evidence.entryPlan.eligible, false);
  assert.ok(low.reasons.some((reason) => reason.includes("10%") && reason.includes("30–70%")));
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [low], nowMs: NOW }).trades.length, 0);
  const inside = evaluatePaperStrategies({ ...base, token: { ...base.token, launchpadPlatform: "flap", bondingCurveProgress: 0.5 } }).find((row) => row.strategyId === "internal");
  assert.equal(inside.decision, "可模拟");
  assert.equal(inside.evidence.curveProgressGate.allow, true);
  assert.equal(inside.evidence.bondingCurveProgress, 0.5);
  assert.equal(inside.evidence.bondingCurveProgressStatus, "known");
  const missing = evaluatePaperStrategies({ ...base, token: { ...base.token, launchpadPlatform: "flap", bondingCurveProgress: null } }).find((row) => row.strategyId === "internal");
  assert.match(missing.reasons.join("\n"), /进度未知/);
  assert.equal(missing.evidence.bondingCurveProgress, null);
  assert.equal(missing.evidence.bondingCurveProgressStatus, "unknown");
  assert.equal(curveProgressBlocksEntry(missing.evidence), true);
  assert.equal(curveProgressBlocksEntry(inside.evidence), false);
  const graduated = evaluatePaperStrategies({ ...base, token: { ...base.token, marketStage: "external", launchpadPlatform: "flap", bondingCurveProgress: 0.05 } }).find((row) => row.strategyId === "smart_money");
  assert.equal(graduated.evidence.curveProgressGate, undefined);
  assert.equal(graduated.evidence.bondingCurveProgress, 0.05);
  assert.equal(graduated.evidence.bondingCurveProgressStatus, "known");
  assert.equal(graduated.decision, "可模拟");
});
