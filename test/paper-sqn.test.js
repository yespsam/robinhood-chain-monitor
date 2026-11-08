import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadPaperSqnReport, paperPromotionDecision, paperSqnReport, systemQualityNumber } from "../src/paper-sqn.js";

const exec = promisify(execFile);
const ones = (n, value = 1) => Array.from({ length: n }, () => value);
const closedRounds = (rMultiples) => rMultiples.flatMap((r, i) => {
  const address = `0x${i.toString(16).padStart(40, "0")}`;
  return [
    { side: "buy", chain: "bsc", address, quantity: 1, realizedPnl: 0, atMs: i * 2,
      entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd: 1 } } },
    { side: "sell", chain: "bsc", address, quantity: 1, realizedPnl: r, atMs: i * 2 + 1 },
  ];
});

test("SQN uses the sample standard deviation of closed-round R multiples", () => {
  const values = [1, 2, 3, 4];
  const report = systemQualityNumber(values);
  const mean = 2.5;
  const stdev = Math.sqrt(5 / 3);
  assert.equal(report.closed, 4);
  assert.equal(report.expectancy, mean);
  assert.ok(Math.abs(report.stdev - stdev) < 1e-12);
  assert.ok(Math.abs(report.sqn - (mean / stdev) * Math.sqrt(4)) < 1e-12);
  assert.equal(systemQualityNumber(ones(30)).sqn, null, "zero-variance samples are undefined, not infinite proof");
  assert.equal(systemQualityNumber(ones(30, -1)).sqn, null);
});

test("promotion requires SQN >= 1.6 and at least 30 closed rounds", () => {
  const belowCount = paperPromotionDecision({ trades: closedRounds(ones(29, 0.5)), sessionPresent: true, env: {} });
  assert.equal(belowCount.allow, false);
  assert.match(belowCount.reason, /已平仓 29 笔，少于 30/);
  const belowSqn = paperPromotionDecision({ trades: closedRounds(ones(30, -1)), sessionPresent: true, env: {} });
  assert.equal(belowSqn.allow, false);
  assert.match(belowSqn.reason, /SQN/);
  const mixed = closedRounds(Array.from({ length: 30 }, (_, i) => i % 2 ? 0.5 : 2));
  const above = paperPromotionDecision({ trades: mixed, sessionPresent: true, env: {} });
  assert.equal(above.closed, 30);
  assert.equal(above.eligible, 30);
  assert.equal(above.riskMissing, 0);
  assert.ok(above.sqn >= 1.6);
  assert.equal(above.allow, true);
  assert.equal(above.reason, null);
});

test("a missing paper session or disabled promotion gate is refused", () => {
  const missing = paperPromotionDecision({ trades: null, sessionPresent: false, env: {} });
  assert.equal(missing.allow, false);
  assert.match(missing.reason, /缺少当前模拟盘账本/);
  const disabled = paperPromotionDecision({
    trades: null, sessionPresent: false,
    env: { LIVE_REQUIRE_PAPER_SQN: "0", LIVE_REQUIRE_PAPER_CLOSED: "false" },
  });
  assert.equal(disabled.allow, false);
  assert.equal(disabled.disabled, true);
  assert.match(disabled.reason, /保护门被关闭/);
  const partialDisabled = paperPromotionDecision({
    trades: closedRounds(ones(30, 0.5)), sessionPresent: true,
    env: { LIVE_REQUIRE_PAPER_SQN: "off" },
  });
  assert.equal(partialDisabled.allow, false);
  assert.match(partialDisabled.reason, /保护门被关闭/);
  const weakened = paperPromotionDecision({
    trades: closedRounds(ones(29, 0.5)), sessionPresent: true,
    env: { LIVE_REQUIRE_PAPER_SQN: "0.1", LIVE_REQUIRE_PAPER_CLOSED: "1" },
  });
  assert.equal(weakened.allow, false);
  assert.equal(weakened.requiredSqn, 1.6);
  assert.equal(weakened.requiredClosed, 30);
});

test("rounds are counted from buy and sell rows, not from partial sells", () => {
  const trades = [
    { side: "buy", chain: "bsc", address: "0x1", quantity: 2, realizedPnl: 0, atMs: 1,
      entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd: 2 } } },
    { side: "sell", chain: "bsc", address: "0x1", quantity: 1, realizedPnl: -0.2, atMs: 2 },
    { side: "sell", chain: "bsc", address: "0x1", quantity: 1, realizedPnl: -0.3, atMs: 3 },
  ];
  const report = paperSqnReport(trades);
  assert.equal(report.closed, 1);
  assert.equal(report.eligible, 1);
  assert.equal(report.riskMissing, 0);
  assert.ok(Math.abs(report.expectancy - (-0.25)) < 1e-12);
  assert.equal(report.sqn, null, "one completed round is insufficient to estimate sample deviation");
});

test("closed rounds without a versioned planned-risk denominator are ineligible for LIVE promotion", () => {
  const trades = [
    { side: "buy", chain: "bsc", address: "0x1", quantity: 1, atMs: 1 },
    { side: "sell", chain: "bsc", address: "0x1", quantity: 1, realizedPnl: 1, atMs: 2 },
  ];
  const report = paperSqnReport(trades);
  assert.equal(report.closed, 1);
  assert.equal(report.eligible, 0);
  assert.equal(report.riskMissing, 1);
  assert.equal(report.sqn, null);
  const decision = paperPromotionDecision({ trades: [...trades, ...closedRounds(ones(29, 0.5))], sessionPresent: true, env: {} });
  assert.equal(decision.allow, false);
  assert.equal(decision.riskMissing, 1);
  const enoughAfterGap = paperPromotionDecision({
    trades: [...trades, ...closedRounds(Array.from({ length: 30 }, (_, i) => i % 2 ? 0.5 : 2))],
    sessionPresent: true, env: {},
  });
  assert.equal(enoughAfterGap.allow, true);
  assert.equal(enoughAfterGap.eligible, 30);
  assert.equal(enoughAfterGap.riskMissing, 1);
});

test("legacy entryPlan stop-loss risk is accepted as the documented USD R denominator", () => {
  const report = paperSqnReport([
    { side: "buy", chain: "bsc", address: "0x2", quantity: 1, atMs: 1,
      entryEvidence: { entryPlan: { estimatedStopLossUsd: 2 } } },
    { side: "sell", chain: "bsc", address: "0x2", quantity: 1, realizedPnl: 0.5, atMs: 2 },
    { side: "buy", chain: "bsc", address: "0x3", quantity: 1, atMs: 3,
      entryEvidence: { entryPlan: { estimatedStopLossUsd: 0 } } },
    { side: "sell", chain: "bsc", address: "0x3", quantity: 1, realizedPnl: 1, atMs: 4 },
  ]);
  assert.equal(report.closed, 2);
  assert.equal(report.eligible, 0, "the later missing risk resets the trailing sample");
  assert.equal(report.riskMissing, 1);
  assert.equal(report.riskSources.legacy_stored, 1);
  assert.equal(report.riskSources.missing, 1);
  assert.equal(report.outcomeMissing, 0);
  assert.equal(report.sqn, null);
});

test("legacy risk is recomputed only from a frozen stop, size, and complete cost inputs", () => {
  const report = paperSqnReport([
    { side: "buy", chain: "bsc", address: "0x4", quantity: 10, price: 10, costBasisUsd: 100, atMs: 1,
      entryEvidence: { entryPlan: { stopPrice: 8 }, costAssumptions: { feeRate: 0.01, slippageRate: 0.02, sellTax: 0.03, gasUsd: 1 } } },
    { side: "sell", chain: "bsc", address: "0x4", quantity: 10, realizedPnl: 2.58, atMs: 2 },
  ]);
  assert.equal(report.closed, 1);
  assert.equal(report.eligible, 1);
  assert.equal(report.riskMissing, 0);
  assert.equal(report.riskSources.legacy_recomputed, 1);
  assert.ok(Math.abs(report.expectancy - 0.1) < 1e-12);
});

test("an explicit unknown versioned risk cannot fall back to older estimate fields", () => {
  const report = paperSqnReport([
    { side: "buy", chain: "bsc", address: "0x5", quantity: 1, atMs: 1,
      entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd: null },
        entryPlan: { estimatedStopLossUsd: 10, stopPrice: 8 },
        costAssumptions: { feeRate: 0.01, slippageRate: 0.01, sellTax: 0.01, gasUsd: 1 } } },
    { side: "sell", chain: "bsc", address: "0x5", quantity: 1, realizedPnl: 1, atMs: 2 },
  ]);
  assert.equal(report.closed, 1);
  assert.equal(report.eligible, 0);
  assert.equal(report.riskMissing, 1);
  assert.equal(report.riskSources.versioned, 1);
});

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "paper-sqn-"));
}

test("the loader prints SQN for the active ledger and fails closed when it is missing", async () => {
  const dir = await tempDir();
  const missing = await loadPaperSqnReport({ dataDir: dir, env: {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.promote, false);
  const id = "confirmed-pvp-v2-estimated-test";
  const trades = [];
  for (let i = 0; i < 30; i += 1) {
    const address = `0x${String(i).padStart(40, "a")}`;
    trades.push({ side: "buy", chain: "bsc", address, quantity: 1, realizedPnl: 0, atMs: i * 10,
      entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd: 1 } } });
    trades.push({ side: "sell", chain: "bsc", address, quantity: 1, realizedPnl: i % 2 ? 0.5 : 2, atMs: i * 10 + 1 });
  }
  const ledger = {
    schema: "yesp_atm_runtime_v1",
    session: { id },
    account: { mode: "paper", execution: false, signing: false, broadcast: false, trades },
  };
  await fs.writeFile(path.join(dir, `yesp-atm-${id}.json`), JSON.stringify(ledger));
  await fs.writeFile(path.join(dir, "yesp-atm-active-estimated-session.json"), JSON.stringify({ id }));
  const report = await loadPaperSqnReport({ dataDir: dir, env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.closed, 30);
  assert.equal(report.eligible, 30);
  assert.equal(report.riskMissing, 0);
  assert.ok(Number.isFinite(report.sqn));
  assert.ok(report.sqn >= 1.6);
  assert.equal(report.promote, true);
  assert.equal(report.sessionId, id);
  const live = { ...ledger, account: { ...ledger.account, execution: true } };
  const liveFile = path.join(dir, "live.json");
  await fs.writeFile(liveFile, JSON.stringify(live));
  const refused = await loadPaperSqnReport({ dataDir: dir, file: liveFile, env: {} });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /不是已关闭执行的模拟盘/);
  const { stdout, code } = await exec(process.execPath, ["scripts/paper-sqn-report.js", "--data-dir", dir], { cwd: process.cwd() }).then(
    (result) => ({ stdout: result.stdout, code: 0 }),
    (error) => ({ stdout: error.stdout, code: error.code }),
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).closed, 30);
  const absent = await exec(process.execPath, ["scripts/paper-sqn-report.js", "--data-dir", path.join(dir, "nope")], { cwd: process.cwd() }).then(
    (result) => ({ stdout: result.stdout, code: 0 }),
    (error) => ({ stdout: error.stdout, code: error.code }),
  );
  assert.equal(absent.code, 1);
  assert.equal(JSON.parse(absent.stdout).ok, false);
});
