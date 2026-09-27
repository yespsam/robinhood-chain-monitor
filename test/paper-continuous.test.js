import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { confirmedAccountGate, CONTINUOUS_PAPER_VERSION } from '../src/paper-confirmed-policy.js';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';

const NOW = Date.parse('2026-09-24T02:00:00Z');
const iso = ms => new Date(ms).toISOString();
const address = id => `0x${id.toString(16).padStart(40, '0')}`;
function signal(id, nowMs = NOW, cash = 100, continuousPaperMode = true) {
  const token = { chain: 'base', address: address(id), symbol: 'OFFLINE_TEST', price: 1.01, liquidity: 60000, volume: 5000,
    isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .01, bundlerRate: .01, buyTax: 0, sellTax: 0 };
  const input = { nowMs, token, marketStatus: 'ok', observedAt: iso(nowMs), priceObservedAt: iso(nowMs), allowExploratory: true,
    pvpMode: true, confirmedMode: true, evidenceHoldMode: true, continuousPaperMode, compoundingCash: cash, fixedEntryUsd: 10,
    flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(nowMs), highProfitCount: 0, fomoCount: 0,
      smartMoneyCount: 1, uniqueBuyerCount: 2, netBuyUsd: 600,
      pulse: { windowMs: 90000, recentBuyerCount: 2, recentNetBuyUsd: 600, lastBuyAt: nowMs - 1 } },
    quoteHistory: [1, 1.006, 1.01].map((price, i) => ({ ...token, price, status: 'ok', observedAt: iso(nowMs - (2-i)*6000) })) };
  return evaluatePaperStrategies(input)[0];
}
const fresh = () => createPaperStrategyAccount({ nowMs: NOW });
const advance = (account, evaluations, nowMs = NOW, extra = {}) => advancePaperStrategyAccount(account, {
  evaluations, nowMs, confirmedMode: true, continuousPaperMode: true, ...extra });
const mark = (id, nowMs, price) => ({ chain: 'base', address: address(id), status: 'ok', price, observedAt: iso(nowMs) });

test('continuous paper removes frequency and position-count caps but never overdrafts fixed-ten cash', () => {
  const a = advance(fresh(), Array.from({ length: 12 }, (_, i) => signal(i + 1)));
  assert.equal(a.trades.length, 10);
  assert.equal(Object.keys(a.positions).length, 10);
  assert.equal(a.cash, 0);
  assert.ok(a.trades.every(t => t.netUsd === -10 && t.entryEvidence.accountPolicy.version === CONTINUOUS_PAPER_VERSION));
  assert.equal(validatePaperStrategyAccount(a), true);
  const restored = advancePaperStrategyAccount(JSON.parse(JSON.stringify(a)), { enabled: false, nowMs: NOW + 1000 });
  assert.equal(Object.keys(restored.positions).length, 10, 'rollback must still manage all previously opened positions');
  assert.equal(a.execution, false); assert.equal(a.signing, false); assert.equal(a.broadcast, false);
  const legacy = advancePaperStrategyAccount(fresh(), { evaluations: [signal(1, NOW, 100, false), signal(2, NOW, 100, false)], nowMs: NOW, confirmedMode: true });
  assert.equal(legacy.trades.length, 1, 'bounded mode retains minimum entry interval');
});

test('continuous mode crosses old daily/total drawdown, daily entries and same-token loss/cooldown limits without resetting history', () => {
  let a = fresh(), nowMs = NOW;
  for (let i = 0; i < 26; i++) {
    a = advance(a, [signal(1, nowMs, a.cash)], nowMs);
    assert.equal(a.trades.length, i * 2 + 1, `round ${i + 1} opens`);
    nowMs += 1000;
    a = advance(a, [], nowMs, { enabled: false, marks: [mark(1, nowMs, .94)] });
    assert.equal(a.trades.length, (i + 1) * 2);
    nowMs += 1000;
  }
  assert.ok(a.realizedPnl < -10);
  assert.equal(a.stats.exits, 26);
  assert.equal(validatePaperStrategyAccount(a), true);
  const options = { continuousPaperMode: true };
  const gate = confirmedAccountGate(a, nowMs, { chain: 'base', address: address(1) }, { lastBuyAt: nowMs - 1 }, null, options);
  assert.equal(gate.allowed, true); assert.equal(gate.dailyEntries, 26);
  assert.ok(gate.warnings.some(w => w.includes('原 3%')));
  assert.ok(gate.warnings.some(w => w.includes('原 10%')));
  assert.match(gate.lossReview.note, /不停机/);
  assert.equal(confirmedAccountGate(a, nowMs).allowed, false, 'rollback keeps legacy protection');
  const restored = JSON.parse(JSON.stringify(a));
  assert.equal(advance(restored, [signal(2, nowMs, a.cash)], nowMs).trades.length, 53);
});

test('continuous mode retains old-flow deduplication and cannot reopen a closed lot on the same old pulse', () => {
  let a = advance(fresh(), [signal(1)]);
  a = advance(a, [], NOW + 1000, { marks: [mark(1, NOW + 1000, .94)], enabled: false });
  const row = signal(1, NOW + 2000, a.cash);
  row.evidence.confirmedPolicy.pulse.lastBuyAt = NOW - 1;
  assert.equal(advance(a, [row], NOW + 2000).trades.length, 2);
  row.evidence.confirmedPolicy.pulse.lastBuyAt = NOW + 1999;
  const b = advance(a, [row], NOW + 2000);
  assert.equal(b.trades.length, 3, 'new evidence can enter without thirty-minute cooldown');
  assert.equal(advance(b, [row], NOW + 2000).trades.length, 3, 'already held token is not pyramided');
});

test('continuous mode remains opt-in for module callers and cannot turn on execution or leak into shadows', () => {
  const row = signal(1);
  assert.equal(advancePaperStrategyAccount(fresh(), { evaluations: [row], nowMs: NOW, confirmedMode: true }).trades.length, 0);
  assert.throws(() => advancePaperStrategyAccount(fresh(), { nowMs: NOW, continuousPaperMode: true }), /requires confirmed/);
  for (const field of ['execution', 'signing', 'broadcast']) {
    const a = fresh(); a[field] = true;
    assert.throws(() => advance(a, [row]));
    assert.throws(() => confirmedAccountGate(a, NOW, null, null, null, { continuousPaperMode: true }), /paper-main only/);
  }
  const shadow = { ...fresh(), variant: 'learning_control' };
  assert.throws(() => advance(shadow, [row]), /paper-main only/);
});

test('continuous mode does not invent stale fills, ignore missing evidence, change manual pause or refill cash', () => {
  assert.equal(advance(fresh(), [signal(1)], NOW, { enabled: false }).trades.length, 0);
  const poor = createPaperStrategyAccount({ initialCash: 9.99, nowMs: NOW });
  assert.equal(advance(poor, [signal(1)]).trades.length, 0);
  assert.equal(advance(fresh(), [signal(1)], NOW + 16000).trades.length, 0);
  const missing = signal(1); missing.missing.push('真实报价');
  assert.equal(advance(fresh(), [missing]).trades.length, 0);
  const a = advance(fresh(), [signal(1)]);
  assert.equal(advance(a, [], NOW + 20000, { marks: [mark(1, NOW, .01)] }).trades.length, 1);
  const stopped = advance(a, [], NOW + 21000, { marks: [mark(1, NOW + 21000, .94)] });
  assert.match(stopped.trades.at(-1).reason, /止损/);
  assert.equal(stopped.trades.at(-1).exitEvidence.accountPolicyVersion, CONTINUOUS_PAPER_VERSION);
  assert.equal(stopped.initialCash, 100);
});

test('review segregates continuous entries from bounded entries instead of relabeling old results', () => {
  const legacy = advancePaperStrategyAccount(fresh(), { evaluations: [signal(1, NOW, 100, false)], nowMs: NOW, confirmedMode: true });
  const closed = advance(legacy, [], NOW + 1000, { marks: [mark(1, NOW + 1000, .94)], enabled: false });
  const prior = JSON.stringify(closed.trades);
  let a = advance(closed, [signal(2, NOW + 2000, closed.cash)], NOW + 2000);
  a = advance(a, [], NOW + 3000, { marks: [mark(2, NOW + 3000, .94)], enabled: false });
  assert.equal(JSON.stringify(a.trades.slice(0, 2)), prior);
  const review = confirmedAccountGate(a, NOW + 3000, null, null, null, { continuousPaperMode: true }).traderReview;
  assert.deepEqual(new Set(review.cohorts.map(c => c.accountPolicyVersion)), new Set(['bounded_paper_v1', CONTINUOUS_PAPER_VERSION]));
});

test('dashboard describes continuous mode without claiming that entry criteria or real-money locks were removed', async () => {
  const app = await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /全天候模拟已开启/);
  assert.match(app, /满足买点且余额足够时交易/);
  assert.match(app, /c.accountPolicyVersion === 'continuous_paper_v1'/);
  const server = await readFile(new URL('../scripts/dashboard-server.js', import.meta.url), 'utf8');
  assert.match(server, /continuousPaperMode: confirmedMode && process.env.PAPER_CONTINUOUS_MODE !== '0'/);
});
