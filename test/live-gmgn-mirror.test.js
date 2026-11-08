import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLiveMirror } from "../src/live-gmgn-mirror.js";

const address = (n) => `0x${String(n).padStart(40, "0")}`;
const session = { id: "confirmed-pvp-v2-isolated-test" };

function liveConfig(dir) {
  return {
    enabled: true, chain: "bsc", chains: ["bsc"], spendAsset: "usdt",
    wallet: address(900), maxPerTradeUsd: 10, gasReserveBnb: 0,
    ledgerPath: path.join(dir, "live-gmgn-ledger.json"),
    requireEvidence: false, closeSyncMs: 0,
  };
}

function candidateTrade() {
  return {
    side: "buy", id: "paper-entry", chain: "bsc", address: address(999), symbol: "MOCK",
    quantity: 1, price: 1, costBasisUsd: 10, atMs: 1_800_000_000_000,
  };
}

function qualifiedPaperHistory() {
  const trades = [];
  for (let i = 0; i < 30; i += 1) {
    const token = address(i + 1);
    const riskUsd = 1;
    const r = [0.8, 1, 1.2][i % 3];
    trades.push({ side: "buy", chain: "bsc", address: token, quantity: 1, costBasisUsd: 10,
      atMs: i * 2, entryEvidence: { paperRisk: { version: "paper_planned_stop_r_v1", riskUsd } } });
    trades.push({ side: "sell", chain: "bsc", address: token, quantity: 1, realizedPnl: r * riskUsd, atMs: i * 2 + 1 });
  }
  return trades;
}

test("promotion refusal occurs before balance reads or trader calls", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-mirror-gate-"));
  try {
    let balanceReads = 0;
    let buys = 0;
    const mirror = createLiveMirror({
      cfg: liveConfig(dir), env: {}, now: () => 1_800_000_000_100,
      readBalance: async () => { balanceReads += 1; return 100; },
      trader: { buy: async () => { buys += 1; return { ok: true }; } },
      log: { warn() {}, error() {} },
    });
    const trades = [candidateTrade()];
    const result = await mirror(0, { trades }, session);
    assert.equal(result.length, 1);
    assert.equal(result[0].ok, false);
    assert.match(result[0].reason, /未达到 LIVE 晋升线/);
    assert.equal(balanceReads, 0);
    assert.equal(buys, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qualified paper history reaches only injected mock balance/trader adapters", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-mirror-mock-"));
  try {
    let balanceReads = 0;
    const calls = [];
    const mirror = createLiveMirror({
      cfg: liveConfig(dir), env: {}, now: () => 1_800_000_000_100,
      readBalance: async () => { balanceReads += 1; return 100; },
      trader: { buy: async (...args) => { calls.push(args); return { ok: true, orderId: "mock-only" }; } },
      log: { warn() {}, error() {} },
    });
    const trades = [...qualifiedPaperHistory(), candidateTrade()];
    const result = await mirror(trades.length - 1, { trades }, session);
    assert.equal(result.length, 1);
    assert.equal(result[0].ok, true);
    assert.equal(balanceReads, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].token, address(999));
    assert.equal(calls[0][0].chain, "bsc");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
