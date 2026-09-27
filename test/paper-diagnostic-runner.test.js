import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperDiagnosticRunner } from '../src/paper-diagnostic-runner.js';

const NOW = Date.parse('2026-09-22T10:00:00Z'), iso = n => new Date(n).toISOString();
const token = { chain: 'base', address: `0x${'1'.repeat(40)}`, symbol: 'OFFLINE_FIXTURE' };
function fixture(targetFills = 20) {
  let clock = NOW, price = 1, response, snapshotFailure, saveFailure, loadHold;
  const saves = [], calls = [];
  const evaluation = () => ({ token, missing: [], reasons: [], evidence: { marketFresh: true, marketObservedAt: iso(clock),
    safety: { missing: [], blocked: [], metrics: { buyTax: 0, sellTax: 0 } }, liquidity: 50000,
    volume: { value: 2000 }, flowFresh: true, flow: { uniqueBuyerCount: 1, netBuyUsd: 200 } } });
  const quote = () => ({ ...token, status: 'ok', source: 'gmgn-cli-token-info', price, observedAt: iso(clock), receivedAt: iso(clock) });
  const runner = createPaperDiagnosticRunner({ initialState: { mode: 'paper_diagnostic', execution: false, signing: false, broadcast: false,
    status: 'running', entriesEnabled: true, deadlineAt: iso(NOW + 600000), cash: 100, realizedPnl: 0, position: null, trades: [], issues: [], targetFills },
    now: () => clock, market: { quote: async token => { calls.push(token.purpose); return response ? response() : quote(); } },
    loadSnapshot: async () => { if (loadHold) await loadHold; if (snapshotFailure) throw snapshotFailure; return { evaluations: [evaluation()] }; },
    persist: async s => { if (saveFailure) throw saveFailure; saves.push(s); } });
  return { runner, saves, calls, quote, setClock: n => { clock = NOW + n; }, setPrice: n => { price = n; },
    setResponse: fn => { response = fn; }, setLoadHold: p => { loadHold = p; },
    failLoad: error => { snapshotFailure = error; }, failSave: error => { saveFailure = error; } };
}
test('single-round runner persists one ten-dollar buy and one fresh sell then completes', async () => {
  const f = fixture(2); await f.runner.entryOnce();
  assert.equal(f.runner.snapshot().trades[0].amountUsd, 10);
  f.setClock(45000); await f.runner.exitOnce();
  assert.equal(f.runner.done(), true); assert.equal(f.runner.snapshot().status, 'completed');
  assert.equal(f.saves.at(-1).trades.length, 2); assert.equal(f.saves.at(-1).position, null);
  await f.runner.entryOnce(); assert.deepEqual(f.calls, ['entry', 'exit']);
});
test('independent diagnostic quote checks stop a falling position before the old 15-second sleep', async () => {
  const f = fixture(); await f.runner.entryOnce(); f.setClock(3000); f.setPrice(.9);
  await Promise.all([f.runner.exitOnce(), f.runner.exitOnce(), f.runner.entryOnce()]);
  const s = f.runner.snapshot(); assert.equal(s.trades.length, 2); assert.equal(s.position, null);
  assert.match(s.trades[1].reason, /5%/); assert.deepEqual(f.calls, ['entry', 'exit']);
  assert.ok(Math.abs(s.cash - 100 - s.realizedPnl) < 1e-9);
});
test('diagnostic uses net cost timeout and max holding rather than blindly exiting every 15 seconds', async () => {
  const f = fixture(); await f.runner.entryOnce();
  f.setClock(15000); await f.runner.exitOnce(); assert.ok(f.runner.snapshot().position);
  f.setClock(45000); await f.runner.exitOnce(); assert.match(f.runner.snapshot().trades[1].reason, /45 秒/);
  f.setClock(50000); await f.runner.entryOnce(); f.setPrice(2);
  f.setClock(100000); await f.runner.exitOnce(); assert.ok(f.runner.snapshot().position);
  f.setClock(230000); await f.runner.exitOnce(); assert.match(f.runner.snapshot().trades.at(-1).reason, /180 秒/);
});
test('deadline drains with a genuinely fresh late quote, never counts it toward target', async () => {
  const f = fixture(); await f.runner.entryOnce(); f.setClock(599000);
  let release; f.setResponse(() => new Promise(resolve => { release = resolve; }));
  const job = f.runner.exitOnce(); await new Promise(resolve => setImmediate(resolve));
  f.setClock(601000); release(f.quote()); await job;
  const s = f.runner.snapshot(); assert.equal(s.status, 'incomplete'); assert.equal(s.position, null);
  assert.equal(s.trades[1].lateSettlement, true); assert.equal(s.entriesEnabled, false);
  assert.equal(s.trades.filter(t => Date.parse(t.at) < Date.parse(s.deadlineAt)).length, 1);
  await f.runner.entryOnce(); assert.equal(f.runner.snapshot().trades.length, 2);
});
test('failed/stale exit preserves position after deadline and exposes safe exact refusal', async () => {
  const f = fixture(); await f.runner.entryOnce(); f.setClock(601000);
  f.setResponse(() => ({ status: 'unavailable', reasonCode: 'GMGN_REQUEST_BUSY' }));
  await f.runner.exitOnce(); let s = f.runner.snapshot();
  assert.equal(s.status, 'incomplete_open_position'); assert.ok(s.position); assert.equal(s.exitMonitor.running, true);
  assert.equal(s.issues.at(-1).code, 'DIAG_QUOTE_UNAVAILABLE');
  assert.equal(s.issues.at(-1).details.upstreamCode, 'GMGN_REQUEST_BUSY');
  f.setResponse(() => ({ ...f.quote(), observedAt: iso(NOW) })); await f.runner.exitOnce();
  s = f.runner.snapshot(); assert.equal(s.issues.at(-1).code, 'DIAG_QUOTE_STALE'); assert.equal(s.trades.length, 1);
  f.setResponse(null); await f.runner.exitOnce(); assert.equal(f.runner.snapshot().position, null);
});
test('stop request is not blocked by pending candidate research and prevents a late buy', async () => {
  const f = fixture(); let release;
  f.setLoadHold(new Promise(resolve => { release = resolve; }));
  const pending = f.runner.entryOnce(); await new Promise(resolve => setImmediate(resolve));
  await f.runner.stopEntries(); await f.runner.exitOnce(); assert.equal(f.runner.done(), true);
  release(); await pending; assert.equal(f.runner.snapshot().trades.length, 0);
});
test('manual stop retains exit management and ignores unknown source diagnostics', async () => {
  const f = fixture(); f.failLoad(new Error('SECRET_KEY=do_not_expose')); await f.runner.entryOnce();
  assert.equal(f.runner.snapshot().issues.at(-1).code, 'DIAG_SOURCE_UNAVAILABLE');
  assert.ok(!JSON.stringify(f.runner.snapshot()).includes('SECRET_KEY'));
  f.failLoad(null); await f.runner.entryOnce(); await f.runner.stopEntries();
  assert.equal(f.runner.done(), false); f.setClock(1000); await f.runner.exitOnce();
  assert.equal(f.runner.done(), true); assert.equal(f.runner.snapshot().trades.length, 2);
});
test('save failure cannot publish an unpersisted sell or duplicate the eventual fill', async () => {
  const f = fixture(); await f.runner.entryOnce(); f.setClock(4000); f.setPrice(.9);
  let release; f.setResponse(() => new Promise(resolve => { release = resolve; }));
  const job = f.runner.exitOnce(); await new Promise(resolve => setImmediate(resolve));
  f.failSave(new Error('fixture disk full')); release(f.quote()); await assert.rejects(job, /disk full/);
  assert.equal(f.runner.snapshot().trades.length, 1); assert.ok(f.runner.snapshot().position);
  f.failSave(null); f.setResponse(null); await f.runner.exitOnce();
  assert.equal(f.runner.snapshot().trades.length, 2); assert.equal(f.saves.at(-1).trades.length, 2);
});
