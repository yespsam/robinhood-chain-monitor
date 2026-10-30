import test from 'node:test';
import assert from 'node:assert/strict';
import { opportunityChart } from '../src/paper-opportunity-policy.js';
import { evaluatePaperStrategyFocusShadow, PAPER_STRATEGY_FOCUS_SHADOW_VERSION } from '../src/paper-strategy-focus-shadow.js';

const NOW = Date.parse('2026-10-30T00:00:00Z');
const CA = `0x${'a'.repeat(40)}`;
const iso = n => new Date(n).toISOString();

function secondBreakoutRows(now = NOW) {
  const values = [
    ...Array.from({ length: 10 }, () => [1, 1.02, .98, 1, 100]),
    [1.08, 1.75, 1.07, 1.68, 180],
    [1.45, 1.48, 1.36, 1.39, 150],
    [1.39, 1.4, 1.25, 1.3, 130],
    [1.3, 1.3, 1.26, 1.29, 100],
    [1.29, 1.31, 1.27, 1.3, 100],
    [1.3, 1.32, 1.28, 1.31, 100],
    [1.31, 1.31, 1.29, 1.3, 100],
    [1.31, 1.43, 1.3, 1.42, 200],
  ];
  return values.map(([open, high, low, close, volume], i) => ({
    time: now - (values.length - i) * 60_000, open, high, low, close, volume,
  }));
}

function input({ chain = 'bsc', marketStage = 'external', rows = secondBreakoutRows(), nowMs = NOW,
  quoteStatus = 'ok', costAssumptions = { notionalUsd: 10, feeRate: .003, slippageRate: .003, sellTax: 0, gasUsd: .02 } } = {}) {
  const token = { chain, address: CA, marketStage, price: 1.425 };
  const chart = opportunityChart(rows, 'ok', nowMs);
  const quoteHistory = [
    { chain, address: CA, status: quoteStatus, price: 1.41, observedAt: iso(nowMs - 4_000) },
    { chain, address: CA, status: quoteStatus, price: token.price, observedAt: iso(nowMs - 1_000) },
  ];
  return { token, marketStage, chart, quoteHistory, nowMs, costAssumptions, budgetUsd: 10 };
}

test('second-breakout shadow recognizes impulse, retracement, base and fresh cost-covered confirmation without authorizing a fill', () => {
  const result = evaluatePaperStrategyFocusShadow(input());
  assert.equal(result.version, PAPER_STRATEGY_FOCUS_SHADOW_VERSION);
  assert.equal(result.externalSecondBreakout.status, 'candidate', JSON.stringify(result.externalSecondBreakout));
  assert.equal(result.externalSecondBreakout.metrics.consolidationBars, 5);
  assert.ok(result.externalSecondBreakout.metrics.impulseRise >= .25);
  assert.ok(result.externalSecondBreakout.metrics.pullback >= .15);
  assert.equal(result.externalSecondBreakout.quoteConfirmation.ready, true);
  assert.equal(result.externalSecondBreakout.economics.ready, true);
  assert.equal(result.entryAllowed, false);
  assert.equal(result.paperFillAllowed, false);
  assert.equal(result.operatorFootprint.status, 'unknown', 'price structure alone is not an operator identity claim');
});

test('stale, mismatched, incomplete or uneconomic inputs stay research-only and fail closed', () => {
  const good = input();
  const cases = [
    { ...good, chart: { ready: false, reason: 'stale_closed_bars', rows: [] } },
    { ...good, quoteHistory: good.quoteHistory.map(q => ({ ...q, observedAt: iso(NOW - 20_000) })) },
    { ...good, quoteHistory: good.quoteHistory.map(q => ({ ...q, chain: 'sol' })) },
    { ...good, costAssumptions: null },
    { ...good, costAssumptions: { ...good.costAssumptions, gasUsd: null } },
    { ...good, costAssumptions: { ...good.costAssumptions, slippageRate: .2 } },
  ];
  for (const item of cases) {
    const result = evaluatePaperStrategyFocusShadow(item);
    assert.notEqual(result.externalSecondBreakout.status, 'candidate');
    assert.equal(result.entryAllowed, false);
    assert.equal(result.paperFillAllowed, false);
  }
});

test('a pullback without a second close above the post-pullback base is only watched', () => {
  const rows = secondBreakoutRows();
  rows[rows.length - 1] = { ...rows.at(-1), open: 1.31, high: 1.33, close: 1.32, volume: 200 };
  const result = evaluatePaperStrategyFocusShadow(input({ rows }));
  assert.equal(result.externalSecondBreakout.status, 'watching_base');
  assert.equal(result.externalSecondBreakout.signalReady, false);
  assert.match(result.externalSecondBreakout.reasons.join(' '), /尚未被收盘价有效突破/);
});

test('internal focus rejects generic burst signals and unsupported chain coverage', () => {
  const token = { chain: 'bsc', address: CA, price: 1 };
  const burst = { version: 'bsc_internal_burst_v1', chain: 'bsc', address: CA,
    source: 'internal_burst', paperOnly: true, sourceAt: iso(NOW), netBuyUsd: 900 };
  const bsc = evaluatePaperStrategyFocusShadow({ token, marketStage: 'internal', nowMs: NOW, collectiveSignal: burst });
  assert.equal(bsc.internalSmartMoney.status, 'no_verified_smart_money');
  assert.equal(bsc.internalSmartMoney.entryAllowed, false);
  const sol = evaluatePaperStrategyFocusShadow({ token: { ...token, chain: 'sol' }, marketStage: 'internal', nowMs: NOW });
  assert.equal(sol.internalSmartMoney.status, 'unsupported_coverage');
  assert.equal(sol.entryAllowed, false);
  assert.equal(sol.paperFillAllowed, false);
});

test('internal smart-money signal is not treated as an external breakout setup', () => {
  const result = evaluatePaperStrategyFocusShadow({ ...input({ marketStage: 'internal' }) });
  assert.equal(result.externalSecondBreakout.status, 'not_applicable');
  assert.equal(result.internalSmartMoney.status, 'no_verified_smart_money');
});
