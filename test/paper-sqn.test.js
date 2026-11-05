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

test("SQN uses the sample standard deviation of closed-round PnL", () => {
  const values = [1, 2, 3, 4];
  const report = systemQualityNumber(values);
  const mean = 2.5;
  const stdev = Math.sqrt(5 / 3);
  assert.equal(report.closed, 4);
  assert.equal(report.expectancy, mean);
  assert.ok(Math.abs(report.stdev - stdev) < 1e-12);
  assert.ok(Math.abs(report.sqn - (mean / stdev) * Math.sqrt(4)) < 1e-12);
  assert.equal(systemQualityNumber(ones(30)).sqn, Infinity);
  assert.equal(systemQualityNumber(ones(30, -1)).sqn, -Infinity);
});

test("promotion requires SQN >= 1.6 and at least 30 closed rounds", () => {
  const belowCount = paperPromotionDecision({ trades: ones(29), sessionPresent: true, env: {} });
  assert.equal(belowCount.allow, false);
  assert.match(belowCount.reason, /已平仓 29 笔，少于 30/);
  const belowSqn = paperPromotionDecision({ trades: ones(30, -1), sessionPresent: true, env: {} });
  assert.equal(belowSqn.allow, false);
  assert.match(belowSqn.reason, /SQN/);
  const mixed = [];
  for (let i = 0; i < 15; i += 1) mixed.push(2, 0);
  const above = paperPromotionDecision({ trades: mixed, sessionPresent: true, env: {} });
  assert.equal(above.closed, 30);
  assert.ok(above.sqn >= 1.6);
  assert.equal(above.allow, true);
  assert.equal(above.reason, null);
});

test("a missing paper session is refused, and emergency env can disable the gate", () => {
  const missing = paperPromotionDecision({ trades: null, sessionPresent: false, env: {} });
  assert.equal(missing.allow, false);
  assert.match(missing.reason, /缺少当前模拟盘账本/);
  const disabled = paperPromotionDecision({
    trades: null, sessionPresent: false,
    env: { LIVE_REQUIRE_PAPER_SQN: "0", LIVE_REQUIRE_PAPER_CLOSED: "false" },
  });
  assert.equal(disabled.allow, true);
  assert.equal(disabled.disabled, true);
});

test("rounds are counted from buy and sell rows, not from partial sells", () => {
  const trades = [
    { side: "buy", chain: "bsc", address: "0x1", quantity: 2, realizedPnl: 0, atMs: 1 },
    { side: "sell", chain: "bsc", address: "0x1", quantity: 1, realizedPnl: -0.2, atMs: 2 },
    { side: "sell", chain: "bsc", address: "0x1", quantity: 1, realizedPnl: -0.3, atMs: 3 },
  ];
  const report = paperSqnReport(trades);
  assert.equal(report.closed, 1);
  assert.ok(Math.abs(report.expectancy - (-0.5)) < 1e-12);
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
    trades.push({ side: "buy", chain: "bsc", address, quantity: 1, realizedPnl: 0, atMs: i * 10 });
    trades.push({ side: "sell", chain: "bsc", address, quantity: 1, realizedPnl: 1, atMs: i * 10 + 1 });
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
  assert.equal(report.sqn, Infinity);
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
