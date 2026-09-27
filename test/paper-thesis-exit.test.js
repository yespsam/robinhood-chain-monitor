import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { THESIS_EXIT_VERSION, THESIS_EXIT_POLICY, assessThesisExit } from '../src/paper-thesis-exit.js';
import { createExitComparison, validateExitComparison, advanceExitComparison, exitComparisonSummary } from '../src/paper-exit-comparison.js';
import { createPaperStrategyAccount, advancePaperStrategyAccount, evaluatePaperStrategies, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { opportunityChart } from '../src/paper-opportunity-policy.js';
import { renderExitComparison } from '../dashboard/exit-comparison.js';

const NOW = Date.parse('2026-09-24T03:00:00Z'), CA = `0x${'a'.repeat(40)}`, iso = ms => new Date(ms).toISOString();
const token = { chain: 'base', address: CA, symbol: 'OFFLINE_ONLY', price: 1.03, marketStage: 'external', liquidity: 60000, volume: 5000,
  isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .01, bundlerRate: .01, buyTax: 0, sellTax: 0 };
const modes = { allowExploratory: true, pvpMode: true, confirmedMode: true, evidenceHoldMode: true, continuousPaperMode: true, opportunityMode: true };
function entryBars(now = NOW) {
  const rows = Array.from({ length: 24 }, (_, i) => { const p = i < 8 ? .8 + i * .025 : 1; return [p, p + .01, p - .005, p, 100]; });
  rows[23] = [1, 1.035, .999, 1.03, 180];
  return rows.map(([open, high, low, close, volume], i) => ({ time: now - (rows.length - i) * 60000, open, high, low, close, volume }));
}
function entry() {
  const row = evaluatePaperStrategies({ ...modes, nowMs: NOW, token, observedAt: iso(NOW), marketStatus: 'ok', priceObservedAt: iso(NOW),
    requireFastQuote: true, compoundingCash: 100, fixedEntryUsd: 10, flow: {}, klineStatus: 'ok', candles: entryBars(),
    quoteHistory: [-4000, 0].map(d => ({ ...token, price: d ? 1.028 : 1.03, status: 'ok', observedAt: iso(NOW + d) })) })[0];
  assert.equal(row.decision, '可模拟'); return row;
}
function position() { return { ...token, openedAt: iso(NOW), entryPrice: 1.03, exitExperiment: { ...THESIS_EXIT_POLICY },
  entryEvidence: { flowDiagnostics: { provider: 'gmgn' }, opportunity: { basis: 'ohlcv', pattern: { reclaimPrice: 1 } } } }; }
function mark(now = NOW + 180000, closes = [1.04, .98, .96], volume = 130) {
  const rows = Array.from({ length: 30 }, (_, i) => ({ time: now - (30 - i) * 60000, open: 1.04, high: 1.05, low: 1.03, close: 1.04, volume: 100 }));
  closes.forEach((close, i) => { rows[27 + i] = { ...rows[27 + i], open: close + .01, high: close + .015, low: close - .01, close, volume: i === 2 ? volume : 100 }; });
  return { ...token, status: 'ok', price: closes.at(-1), observedAt: iso(now),
    structureChart: { ...opportunityChart(rows, 'ok', now), chain: token.chain, address: CA } };
}

test('two broken closes require sell volume, whereas three independently closed bars establish persistence', () => {
  assert.equal(assessThesisExit(position(), mark(), NOW + 180000).exit, true);
  const quiet = assessThesisExit(position(), mark(NOW + 180000, [1.04, .98, .96], 50), NOW + 180000);
  assert.equal(quiet.exit, false); assert.equal(quiet.structure.twoBelow, true);
  const persistent = assessThesisExit(position(), mark(NOW + 180000, [.99, .98, .96], 50), NOW + 180000);
  assert.equal(persistent.exit, true); assert.match(persistent.reason, /三根/);
});

test('volume spike plus upper wick requires a following closed breakdown and fresh quote', () => {
  const p = position(); p.entryEvidence.opportunity.pattern.reclaimPrice = .8;
  const m = mark(), rows = m.structureChart.rows;
  Object.assign(rows.at(-2), { open: 1.08, high: 1.5, low: 1.02, close: 1.05, volume: 240 });
  Object.assign(rows.at(-1), { open: 1.04, high: 1.05, low: .98, close: 1, volume: 100 });
  m.price = .99;
  assert.equal(assessThesisExit(p, m, NOW + 180000).structure.distribution, true);
  m.price = 1.03;
  assert.equal(assessThesisExit(p, m, NOW + 180000).exit, false);
});

test('foreign, future, stale, gapped and unfinished candles cannot manufacture a structure exit', () => {
  for (const mutate of [m => { m.address = `0x${'b'.repeat(40)}`; }, m => { m.observedAt = iso(NOW + 200000); },
    m => { m.observedAt = iso(NOW + 160000); }, m => { m.structureChart.chain = 'bsc'; },
    m => { m.structureChart.rows.splice(4, 1); }, m => { m.structureChart.rows = m.structureChart.rows.slice(-4); },
    m => { m.structureChart.ready = false; }]) {
    const m = mark(); mutate(m); assert.equal(assessThesisExit(position(), m, NOW + 180000).exit, false, mutate.toString());
  }
  const m = mark(NOW + 1000); m.structureChart.rows.at(-1).time = NOW + 60000;
  assert.equal(assessThesisExit(position(), m, NOW + 1000).exit, false);
});

test('missing chart is unavailable, not proof of a healthy trend', () => {
  const m = mark(); delete m.structureChart;
  const d = assessThesisExit(position(), m, NOW + 180000);
  assert.equal(d.exit, false); assert.equal(d.status, 'unavailable'); assert.match(d.reason, /不据此认定趋势仍有效/);
});

test('same-provider complete sell flow needs distinct observations separated by thirty seconds', () => {
  const p = position();
  const m = t => ({ ...token, price: 1, status: 'ok', observedAt: iso(t), flow: { ...token, status: 'healthy', provider: 'gmgn',
    complete: true, fresh: true, netBuyUsd: -600, smartMoneySellerCount: 2, observedAt: iso(t) } });
  let d = assessThesisExit(p, m(NOW + 1000), NOW + 1000); p.thesisFlowWatch = d.flowWatch;
  assert.equal(d.exit, false);
  d = assessThesisExit(p, m(NOW + 1000), NOW + 1000); assert.equal(d.flowWatch.count, 1);
  d = assessThesisExit(p, m(NOW + 31000), NOW + 31000); assert.equal(d.exit, true);
  for (const mutate of [f => { f.provider = 'binance_kol'; }, f => { f.complete = false; }, f => { f.fresh = false; }, f => { f.address = 'foreign'; }]) {
    const bad = m(NOW + 32000); mutate(bad.flow); assert.equal(assessThesisExit(p, bad, NOW + 32000).exit, false);
  }
});

test('verified calls remain context, cannot override breakdown or alone create an exit', () => {
  const p = position(), m = mark();
  m.narrative = { caBound: true, sources: [{ chain: 'base', tokenAddress: CA, sourceAuthenticated: true,
    sourceKind: 'authenticated_call', sourceUrl: 'https://example.com/call/1', sourceId: 'source-1', sourceAt: iso(NOW + 1000),
    authorKey: 'author-1', sourceText: 'AI agent mainnet launched with a new community integration and full product roadmap.' }] };
  const d = assessThesisExit(p, m, NOW + 180000);
  assert.equal(d.sentiment.independentSources, 1); assert.equal(d.exit, true);
  m.narrative.sources[0].sourceAuthenticated = false;
  assert.equal(assessThesisExit(p, m, NOW + 180000).sentiment.independentSources, 0);
  delete m.structureChart;
  assert.equal(assessThesisExit(p, m, NOW + 180000).exit, false);
});

test('experiment cancels fixed stops and multiple targets without altering main trades or charging synthetic returns', () => {
  const original = createPaperStrategyAccount({ nowMs: NOW }), before = JSON.stringify(original), evaluation = entry();
  let pair = advanceExitComparison(createExitComparison(original, NOW), { evaluations: [evaluation], marksFor: () => [], enabled: true, nowMs: NOW });
  assert.equal(pair.control.cash, 90); assert.equal(pair.dynamic.cash, 90); assert.equal(JSON.stringify(original), before);
  const opened = JSON.stringify(pair.dynamic.trades[0]);
  const update = (price, t) => { pair = advanceExitComparison(pair, { marksFor: () => [{ ...token, status: 'ok', price, observedAt: iso(t) }], nowMs: t }); };
  update(.8, NOW + 1000);
  assert.equal(pair.control.trades.length, 2); assert.equal(pair.dynamic.trades.length, 1);
  update(3.2, NOW + 2000);
  assert.equal(pair.dynamic.trades.length, 1, 'neither 2x nor 3x sells');
  update(.2, NOW + 3000);
  assert.equal(pair.dynamic.trades.length, 1, 'no concealed trailing percentage stop');
  assert.equal(pair.dynamic.positions[`base:${CA}`].exitStatus.activeStopPrice, null);
  assert.equal(JSON.stringify(pair.dynamic.trades[0]), opened);
  assert.ok(exitComparisonSummary(pair).dynamic.equityChange < -7, 'open loss is included');
  assert.equal(validateExitComparison(pair), true);
  const foreign = structuredClone(pair.dynamic); delete foreign.exitExperimentVersion;
  assert.throws(() => validatePaperStrategyAccount(foreign), /isolated/);
});

test('dynamic invalidation records effective exit version, model costs and actual evidence', () => {
  let pair = advanceExitComparison(createExitComparison(createPaperStrategyAccount({ nowMs: NOW }), NOW), { evaluations: [entry()], marksFor: () => [], enabled: true, nowMs: NOW });
  pair = advanceExitComparison(pair, { marksFor: () => [mark()], nowMs: NOW + 180000 });
  const exit = pair.dynamic.trades.at(-1);
  assert.equal(exit.side, 'sell'); assert.equal(exit.exitEvidence.exitPolicyVersion, THESIS_EXIT_VERSION);
  assert.equal(exit.exitEvidence.activeStopPrice, null); assert.ok(exit.costsUsd > 0);
  assert.equal(exit.exitEvidence.thesisDecision.exit, true);
  assert.equal(pair.dynamic.execution, false); assert.equal(pair.dynamic.signing, false); assert.equal(pair.dynamic.broadcast, false);
});

test('existing lots retain their frozen rules even when copied into the experiment', () => {
  const main = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { ...modes, evaluations: [entry()], nowMs: NOW });
  const pair = createExitComparison(main, NOW + 1000);
  assert.deepEqual(pair.dynamic.positions, main.positions);
  const next = advanceExitComparison(pair, { marksFor: () => [{ ...token, status: 'ok', price: .8, observedAt: iso(NOW + 2000) }], nowMs: NOW + 2000 });
  assert.equal(next.control.trades.length, 2); assert.equal(next.dynamic.trades.length, 2);
  assert.equal(next.dynamic.trades.at(-1).exitEvidence.exitPolicyVersion, 'structure_hold_v2');
});

test('runtime persists comparison across restarts and monitors experiment-only holdings after main exit', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-thesis-test-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let now = NOW, price = 1.029; const calls = [];
  const market = { trending: async () => ({ status: 'ok', observedAt: iso(now), tokens: [token] }),
    trenches: async () => ({ status: 'ok', observedAt: iso(now), tokens: [] }),
    kline: async args => ({ ...args, status: 'ok', candles: entryBars() }),
    quote: async args => { calls.push(args.address); return { ...args, status: 'ok', price, observedAt: iso(now) }; } };
  const options = { ...modes, thesisExitExperiment: true, dataDir, chain: 'base', chains: ['base'], market, now: () => now,
    fixedEntryUsd: 10, evidenceLoader: () => ({}) };
  const runtime = createPaperStrategyRuntime(options);
  let stored;
  try {
    await runtime.runOnce(); await runtime.runOnce(); await runtime.refreshQuote(); now += 4000; price = 1.03;
    await runtime.refreshQuote(); await runtime.runOnce();
    let s = runtime.snapshot();
    assert.equal(s.account.trades.length, 1); assert.equal(s.exitComparison.dynamic.entries, 1); assert.equal(s.exitComparison.control.entries, 1);
    now += 4000; price = .8; await runtime.refreshQuote(); await runtime.exitOnce();
    s = runtime.snapshot(); assert.equal(s.account.trades.length, 2); assert.equal(s.exitComparison.dynamic.positions.length, 1);
    await runtime.setEnabled(false);
    stored = JSON.parse(await fs.readFile(runtime.stateFile, 'utf8')).exitComparison;
    assert.equal(stored.dynamic.trades.length, 1);
  } finally { await runtime.stop(); }
  now += 2000; const resumed = createPaperStrategyRuntime(options);
  try {
    await resumed.runOnce(); assert.equal(resumed.snapshot().exitComparison.startedAt, stored.startedAt);
    assert.equal(resumed.snapshot().exitComparison.dynamic.positions.length, 1);
    const n = calls.length; await resumed.refreshQuote(); await resumed.exitOnce();
    assert.ok(calls.length > n); assert.equal(resumed.snapshot().enabled, false);
    const file = JSON.parse(await fs.readFile(resumed.stateFile, 'utf8'));
    assert.deepEqual(file.exitComparison.dynamic.trades, stored.dynamic.trades);
    assert.equal(validateExitComparison(file.exitComparison), true);
  } finally { await resumed.stop(); }
});

test('UI distinguishes experimental no-stop exits, no data and net equity including open losses', () => {
  const pair = exitComparisonSummary(createExitComparison(createPaperStrategyAccount({ nowMs: NOW }), NOW));
  pair.dynamic.equityChange = -7;
  pair.dynamic.positions = [{ chain: 'base', address: CA, symbol: '<img src=x>', markStatus: 'stale', status: { reason: '等待新鲜量价' } }];
  pair.control.positions = [{ chain:'base', address:CA, symbol:'CONTROL_ONLY', entryLogic:'<script>entry</script>', entryUsd:10, costBasisUsd:8, openedAt:iso(NOW) }];
  pair.control.recentTrades = [{ chain:'base', address:CA, symbol:'CONTROL_BUY', atMs:NOW, side:'buy', netUsd:-10, costsUsd:.4, realizedPnl:0, reason:'<script>trade</script>' }];
  pair.dynamic.recentTrades = [{ chain:'base', address:CA, symbol:'DYNAMIC_SELL', atMs:NOW, side:'sell', netUsd:12, costsUsd:.5, realizedPnl:2 }];
  const html = renderExitComparison(pair);
  assert.match(html, /不是主账户切换/); assert.match(html, /-7.00 U/); assert.match(html, /报价过期/);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script|NaN|Invalid Date/);
  for(const text of ['CONTROL_ONLY','CONTROL_BUY','DYNAMIC_SELL','买入依据','成交依据','-10.00 U','+12.00 U','+2.00 U','&lt;script&gt;','不再次扣除'])assert.ok(html.includes(text),text);
});
