import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCandidate, diagnosticQuote, diagnosticBuy, diagnosticSell, diagnosticTarget } from '../src/paper-diagnostic.js';
const now = Date.parse('2026-09-22T06:25:00Z');
const token = { chain: 'base', address: '0x1111111111111111111111111111111111111111', symbol: 'TEST' };
const quote = at => ({ ...token, status: 'ok', source: 'gmgn-cli-token-info', price: 1, observedAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString() });
const evaluation = () => ({ token, missing: ['正式门槛未通过'], reasons: [], evidence: { marketFresh: true, marketObservedAt: new Date(now).toISOString(), safety: { missing: [], blocked: [], metrics: { buyTax: 0, sellTax: 0 } }, liquidity: 50000, volume: { value: 2000 }, flowFresh: true, flow: { uniqueBuyerCount: 1, netBuyUsd: 200 } } });
const account = () => ({ mode: 'paper_diagnostic', execution: false, signing: false, broadcast: false, deadlineAt: new Date(now + 600000).toISOString(), cash: 100, realizedPnl: 0, position: null, trades: [] });
test('standalone diagnostic rechecks tax metrics even when an older safety summary says passed', () => {
  for (const field of ['buyTax', 'sellTax']) for (const value of [.060001, .07, null, false]) {
    const row = evaluation(); row.evidence.safety.metrics[field] = value;
    assert.equal(diagnosticCandidate(row, now), false);
    const state = account();
    assert.throws(() => diagnosticBuy(state, row, quote(now), now), { code: 'DIAG_TAX' });
    assert.equal(state.trades.length, 0); assert.equal(state.cash, 100);
  }
  const row = evaluation(); row.evidence.safety.metrics.buyTax = .06;
  assert.equal(diagnosticCandidate(row, now), true);
});
test('single-round flow check uses exactly ten virtual dollars and stops at two fills', () => {
  const s = { ...account(), targetFills: 2 };
  diagnosticBuy(s, evaluation(), quote(now), now);
  assert.equal(s.cash, 90); assert.equal(s.trades[0].amountUsd, 10);
  assert.equal(s.position.size.mode, 'fixed');
  assert.throws(() => diagnosticSell(s, quote(now), now), /重复/);
  diagnosticSell(s, quote(now + 10000), now + 10000);
  assert.equal(s.position, null); assert.equal(s.trades.length, 2);
  assert.ok(Math.abs(s.cash - 100 - s.realizedPnl) < 1e-10);
  assert.throws(() => diagnosticBuy(s, evaluation(), quote(now + 20000), now + 20000));
});
test('ten-dollar single-round check does not top up or shrink an insufficient budget', () => {
  const s = { ...account(), targetFills: 2, cash: 9.99 };
  assert.throws(() => diagnosticBuy(s, evaluation(), quote(now), now));
  assert.equal(s.cash, 9.99); assert.equal(s.position, null); assert.equal(s.trades.length, 0);
});
test('diagnostic ten fills use real-time-shaped evidence, actual cash compounding and isolated losses', () => {
  const s = account();
  for (let n = 0; n < 5; n++) {
    const at = now + n * 20000;
    diagnosticBuy(s, evaluation(), quote(at), at);
    assert.equal(s.trades.at(-1).size.budgetUsd, Math.floor((s.trades.at(-1).size.cashBeforeEntry * .02 + 1e-9) * 100) / 100);
    assert.throws(() => diagnosticSell(s, quote(at), at));
    diagnosticSell(s, quote(at + 10000), at + 10000);
  }
  assert.equal(s.trades.length, 10); assert.equal(s.position, null);
  assert.ok(s.cash < 100); assert.ok(Math.abs(s.cash - 100 - s.realizedPnl) < 1e-10);
  assert.throws(() => diagnosticBuy(s, evaluation(), quote(now + 110000), now + 110000));
});
test('unknown safety, stale quote, wrong address, and non-paper mode fail closed', () => {
  const e = evaluation(); e.evidence.safety.missing.push('卖出检测');
  assert.equal(diagnosticCandidate(e, now), false);
  const stale = evaluation(); stale.evidence.marketFresh = false;
  assert.equal(diagnosticCandidate(stale, now), false);
  assert.equal(diagnosticQuote(quote(now - 15001), token, now), false);
  assert.equal(diagnosticQuote({ ...quote(now), address: 'wrong' }, token, now), false);
  const s = account(); s.execution = true;
  assert.throws(() => diagnosticBuy(s, evaluation(), quote(now), now));
});
test('diagnostic reserves time for exit and rejects an uneconomic budget', () => {
  const s = account();
  assert.throws(() => diagnosticBuy(s, evaluation(), quote(now + 580000), now + 580000));
  s.cash = .10;
  assert.throws(() => diagnosticBuy(s, evaluation(), quote(now), now));
  assert.equal(s.cash, .10); assert.equal(s.trades.length, 0);
});

test('explicit twenty-fill run completes ten round trips with fresh evidence and no duplicate quotes', () => {
  const s = { ...account(), targetFills: 20 };
  for (let n = 0; n < 10; n++) {
    const at = now + n * 30000, e = evaluation(); e.evidence.marketObservedAt = new Date(at).toISOString();
    if (n) {
      const previous = structuredClone(e); previous.evidence.marketObservedAt = new Date(at - 20000).toISOString();
      assert.throws(() => diagnosticBuy(s, previous, quote(at - 20000), at - 19999), /重复/);
    }
    diagnosticBuy(s, e, quote(at), at);
    diagnosticSell(s, quote(at + 10000), at + 10000);
  }
  assert.equal(s.trades.length, 20); assert.equal(s.position, null);
  assert.equal(s.trades.filter(t => t.side === 'buy').length, 10);
  assert.equal(s.trades.filter(t => t.side === 'sell').length, 10);
  assert.ok(Math.abs(s.cash - 100 - s.realizedPnl) < 1e-10);
  assert.equal(new Set(s.trades.map(t => t.quote.observedAt)).size, 20);
  for (const targetFills of [0, 21, '20', NaN]) assert.throws(() => diagnosticTarget({ targetFills }));
});

test('diagnostic charges the full exit cost on near-zero prices and never backfills after deadline', () => {
  const s = account(); diagnosticBuy(s, evaluation(), quote(now), now);
  diagnosticSell(s, { ...quote(now + 10000), price: .0001 }, now + 10000);
  assert.ok(s.trades.at(-1).amountUsd < 0); assert.ok(s.trades.at(-1).pnlUsd < -2);
  assert.ok(Math.abs(s.cash - 100 - s.realizedPnl) < 1e-10);
  const late = account(); diagnosticBuy(late, evaluation(), quote(now), now);
  assert.throws(() => diagnosticSell(late, quote(now + 600000), now + 600000));
  assert.equal(late.trades.length, 1); assert.ok(late.position);
});

test('only explicit cleanup of a finished incomplete run permits a visibly late exit', () => {
  const s = account(); diagnosticBuy(s, evaluation(), quote(now), now);
  const at = now + 620000;
  assert.throws(() => diagnosticSell(s, quote(at), at, { settleAfterDeadline: true }));
  s.status = 'incomplete_open_position'; s.finishedAt = new Date(now + 600000).toISOString();
  assert.throws(() => diagnosticSell(s, quote(at - 20000), at, { settleAfterDeadline: true }));
  diagnosticSell(s, quote(at), at, { settleAfterDeadline: true });
  assert.equal(s.position, null); assert.equal(s.trades.at(-1).lateSettlement, true);
  assert.match(s.trades.at(-1).reason, /不计入/);
  assert.equal(s.trades.filter(t => Date.parse(t.at) < Date.parse(s.deadlineAt)).length, 1);
  assert.equal(s.deadlineAt, new Date(now + 600000).toISOString());
});
