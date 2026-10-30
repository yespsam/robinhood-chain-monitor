import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaperStrategyFocusSimulator, PAPER_STRATEGY_FOCUS_SIMULATION_VERSION } from '../src/paper-strategy-focus-simulator.js';

const START = Date.parse('2026-10-30T00:00:00.000Z');
const CA = `0x${'a'.repeat(40)}`;
const at = ms => new Date(ms).toISOString();

function eligibleEvaluation(nowMs = START) {
  return {
    token: { chain: 'bsc', address: CA, symbol: 'TEST', price: 1.42 },
    observedAt: at(nowMs), entryUsd: 10,
    evidence: {
      marketStage: 'external', priceFresh: true, marketFresh: true, liquidity: 100_000,
      safety: { blocked: [], missing: [] },
      costAssumptions: { notionalUsd: 9.7, feeRate: .003, slippageRate: .01, buyTax: .01,
        sellTax: .01, gasUsd: .02, estimatedRoundTripCostRate: .06 },
      narrativeThesis: { researchOnly: true, chain: 'bsc', address: CA,
        relationship: { kind: 'direct_ca' },
        event: { label: '公开催化', kind: 'product_delivery', warning: false,
          claimStatus: '原文主张，未独立证实', sourceAt: at(nowMs - 10_000), sourceUrl: 'https://example.test/source' },
        sources: [{ url: 'https://example.test/source', binding: 'direct_ca' }],
        catalyst: { phase: 'fresh', ageMs: 10_000 },
        demand: { status: 'buying', observedAt: at(nowMs - 1_000), recentNetBuyers: 2, netBuyUsd: 350 },
        market: { ready: true }, invalidation: { blockNewNarrativeEntry: false } },
      strategyFocusShadow: { version: 'smartmoney_second_breakout_shadow_v1', researchOnly: true,
        marketStage: 'external', stageConflict: false,
        externalSecondBreakout: { version: 'external_second_breakout_pattern_v1', status: 'candidate', signalReady: true,
          quoteConfirmation: { ready: true, confirmedAt: at(nowMs), count: 2 },
          economics: { ready: true, netRewardRisk: 1.5 },
          metrics: { closedAt: at(nowMs), support: 1.3, targetPrice: 1.55 } },
      },
    },
  };
}

async function withSimulator(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-focus-sim-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let clock = START;
  const simulator = createPaperStrategyFocusSimulator({ dataDir, now: () => clock, ...options });
  await simulator.initialize();
  return { simulator, dataDir, setNow: value => { clock = value; } };
}

test('strictly admitted external second breakout opens only an isolated paper-sidecar position', async t => {
  const { simulator, dataDir } = await withSimulator(t);
  const result = await simulator.advance({ evaluations: [eligibleEvaluation()], nowMs: START });
  assert.equal(result.version, PAPER_STRATEGY_FOCUS_SIMULATION_VERSION);
  assert.equal(result.mode, 'paper_sidecar');
  assert.equal(result.execution, false);
  assert.equal(result.signing, false);
  assert.equal(result.broadcast, false);
  assert.equal(result.entries, 1);
  assert.equal(result.openPositions, 1);
  assert.equal(result.cashUsd, 90);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'paper-strategy-focus-simulation-v1.json'), 'utf8'));
  assert.equal(persisted.trades[0].side, 'buy');
  assert.equal(persisted.positions[0].address, CA);
  assert.equal(persisted.mode, 'paper_sidecar');
  assert.equal(persisted.execution, false);
});

test('internal stage, unresolved stage conflict, missing thesis, or dangerous taxes fail closed', async t => {
  const { simulator } = await withSimulator(t);
  const base = eligibleEvaluation();
  const cases = [
    { ...base, evidence: { ...base.evidence, marketStage: 'internal', strategyFocusShadow: { ...base.evidence.strategyFocusShadow, marketStage: 'internal' } } },
    { ...base, evidence: { ...base.evidence, strategyFocusShadow: { ...base.evidence.strategyFocusShadow, stageConflict: true } } },
    { ...base, evidence: { ...base.evidence, narrativeThesis: null } },
    { ...base, evidence: { ...base.evidence, narrativeThesis: { ...base.evidence.narrativeThesis,
      relationship: { kind: 'name_only' } } } },
    { ...base, evidence: { ...base.evidence, narrativeThesis: { ...base.evidence.narrativeThesis,
      demand: { ...base.evidence.narrativeThesis.demand, recentNetBuyers: 1 } } } },
    { ...base, evidence: { ...base.evidence, narrativeThesis: { ...base.evidence.narrativeThesis,
      event: { ...base.evidence.narrativeThesis.event, sourceAt: at(START - 60 * 60_000 - 1) } } } },
    { ...base, evidence: { ...base.evidence, costAssumptions: { ...base.evidence.costAssumptions, buyTax: .07 } } },
    { ...base, evidence: { ...base.evidence, safety: { blocked: ['honeypot'], missing: [] } } },
  ];
  for (const evaluation of cases) {
    const result = await simulator.advance({ evaluations: [evaluation], nowMs: START });
    assert.equal(result.entries, 0);
    assert.equal(result.openPositions, 0);
  }
  const latest = simulator.snapshot().latestChecks.at(-1);
  assert.equal(latest.result, 'rejected');
});

test('same candle touching stop and target exits conservatively at the stop, with model costs', async t => {
  const { simulator, setNow } = await withSimulator(t);
  await simulator.advance({ evaluations: [eligibleEvaluation()], nowMs: START });
  setNow(START + 60_000);
  const result = await simulator.advance({ marks: [{ chain: 'bsc', address: CA, status: 'ok', price: 1.4,
    observedAt: at(START + 60_000), chart: { ready: true, chain: 'bsc', address: CA,
      last: { time: START }, rows: [{ time: START, open: 1.4, high: 1.6, low: 1.2, close: 1.45 }] } }], nowMs: START + 60_000 });
  assert.equal(result.openPositions, 0);
  assert.equal(result.completedTrades, 1);
  const close = result.recentTrades.at(-1);
  assert.match(close.exitReason, /保守按止损先触发/);
  assert.equal(close.exitPrice, 1.3);
  assert.equal(close.execution, false);
});

test('an unfinished one-minute candle cannot trigger a paper exit', async t => {
  const { simulator, setNow } = await withSimulator(t);
  await simulator.advance({ evaluations: [eligibleEvaluation()], nowMs: START });
  setNow(START + 30_000);
  const result = await simulator.advance({ marks: [{ chain: 'bsc', address: CA, status: 'ok', price: 1.4,
    observedAt: at(START + 30_000), chart: { ready: true, chain: 'bsc', address: CA,
      last: { time: START }, rows: [{ time: START, open: 1.4, high: 1.6, low: 1.2, close: 1.45 }] } }], nowMs: START + 30_000 });
  assert.equal(result.openPositions, 1);
  assert.equal(result.completedTrades, 0);
  assert.equal(result.positions[0].lastProcessedCandleClosedAt, at(START));
});

test('stale or unavailable marks report unrealized PnL as unknown instead of zero', async t => {
  const { simulator } = await withSimulator(t);
  await simulator.advance({ evaluations: [eligibleEvaluation()], nowMs: START });
  const result = await simulator.advance({ marks: [], nowMs: START + 30_000 });
  assert.equal(result.openPositions, 1);
  assert.equal(result.unrealizedPnlUsd, null);
  assert.equal(result.positions[0].markStatus, 'stale');
});
