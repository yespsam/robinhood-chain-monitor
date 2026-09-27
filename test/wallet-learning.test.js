import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLearningTeachers, parseWalletActivity, mergeLearningActivity, analyzeWalletHabits, buildLearningReport, validLearningPolicy } from '../src/wallet-learning.js';
import { renderWalletLearning } from '../dashboard/wallet-learning.js';

test('collection compatibility and per-wallet failures are visible even when the last request succeeded', () => {
  const html = renderWalletLearning({ wallets: [], profileCollection: { singleWalletChains: ['bsc'], incompleteWallets: 4, missingWallets: 2 }, lastError: null });
  assert.match(html, /币安链已启用逐地址兼容查询/);
  assert.match(html, /统计异常 4 个，接口漏回待补 2 个/);
  assert.match(html, /采集缺失不代表钱包亏损/);
});
import { NOW, address, teacher, row, raw, trainingState } from './fixtures/wallet-learning.js';

test('teachers need fresh dual-window profit evidence and explicit tags, not roster claims', () => {
  const w = teacher();
  const picked = selectLearningTeachers({ profiles: { [w.key]: w.profile } }, {}, NOW);
  assert.equal(picked.length, 1); assert.deepEqual(picked[0].groups, ['gmgn_smartmoney', 'gmgn_fomo']); assert.equal(picked[0].fomoOfficial, false);
  assert.equal(selectLearningTeachers({ profiles: { [w.key]: w.profile } }, {}, NOW + 7200001).length, 0);
  w.profile['7d'].tags = ['mev_bot']; assert.equal(selectLearningTeachers({ profiles: { [w.key]: w.profile } }, {}, NOW).length, 0);
  assert.equal(selectLearningTeachers({}, { publicOnchain: { smartMoney: { roster: { a: { qualified: true, wallet: address(1) } } } } }, NOW).length, 0);
});
test('actual activity aliases, cursor, identity, amount consistency and non-trade contamination', () => {
  const parsed = parseWalletActivity({ data: { activities: [raw(1), raw(2, 'transfer')], next: 'abc' } }, 'robinhood', address(1), NOW);
  assert.equal(parsed.rows[0].side, 'buy'); assert.equal(parsed.rows[1].side, 'unattributable'); assert.equal(parsed.next, 'abc');
  for (const patch of [{ wallet: address(2) }, { chain: 'bsc' }, { timestamp: NOW / 1000 + 31 }, { transaction_hash: 'bad' }, { type: 'sell' }, { token: {} }])
    assert.throws(() => parseWalletActivity({ activities: [raw(1, 'buy', patch)] }, 'robinhood', address(1), NOW));
  assert.equal(parseWalletActivity({ activities: [raw(1, 'buy', { cost_usd: '100' })] }, 'robinhood', address(1), NOW).rows[0].side, 'unattributable');
});
test('dedup is idempotent, revisions quarantine and remain quarantined', () => {
  const a = row(1), repeated = mergeLearningActivity([a], [a], NOW); assert.equal(repeated.length, 1);
  const revised = mergeLearningActivity(repeated, [{ ...a, usd: 20 }], NOW); assert.equal(revised[0].side, 'unattributable');
  assert.equal(mergeLearningActivity(revised, [a], NOW)[0].side, 'unattributable');
  assert.equal(mergeLearningActivity([row(1, 'buy', { at: NOW - 31 * 86400000 })], [], NOW).length, 0);
});
test('partial sells use FIFO quantity basis, not total buy dollar amount', () => {
  const h = analyzeWalletHabits([row(1), row(2, 'sell', { at: NOW - 50000, quantity: 4, usd: 8, price: 2 }), row(3, 'sell', { at: NOW - 10000, quantity: 6, usd: 9, price: 1.5 })]);
  assert.equal(h.matchedSells, 2); assert.equal(h.partialSells, 1); assert.equal(h.openLots, 0);
  assert.equal(h.matches[0].grossReturn, 1); assert.equal(h.matches[1].grossReturn, .5);
});
test('oversells, missing buys, transfers and ambiguous opposite same-second legs exclude entire token', () => {
  for (const rows of [[row(1, 'sell')], [row(1), row(2, 'sell', { quantity: 11 })], [row(1), row(2, 'unattributable')], [row(1), row(2, 'sell', { at: row(1).at })]]) {
    const h = analyzeWalletHabits(rows); assert.equal(h.matchedSells, 0); assert.equal(h.excludedTokens, 1);
  }
});
test('three-second profitable trades remain descriptive and cannot train exit policy', () => {
  const h = analyzeWalletHabits([row(1), row(2, 'sell', { at: row(1).at + 3000, usd: 25, price: 2.5 })]);
  assert.equal(h.tooFastSells, 1); assert.equal(h.copyableMatchedSells, 0); assert.equal(h.medianWinningExit, null);
});
test('minimum teachers, records, token breadth, time span and chain separation gate readiness', () => {
  const s = trainingState(), report = buildLearningReport(s, NOW);
  assert.equal(report.policies.length, 2); const p = report.policies[0];
  assert.equal(p.maxHoldMs, 120000); assert.ok(Math.abs(p.lossCutRate - .1) < 1e-10); assert.ok(validLearningPolicy(p, 'robinhood', NOW));
  assert.equal(validLearningPolicy(p, 'bsc', NOW), false); assert.equal(validLearningPolicy(p, 'robinhood', NOW + 7200001), false);
  delete s.wallets[teacher(3).key]; assert.equal(buildLearningReport(s, NOW).policies.length, 0);
  for (const mutate of [s => { Object.values(s.wallets)[2].chain = 'bsc'; }, s => { for (const w of Object.values(s.wallets)) w.rows = w.rows.slice(0, 10); }, s => { for (const w of Object.values(s.wallets)) w.rows = w.rows.map(r => ({ ...r, at: NOW - 120000 + r.at % 100000 })); }]) {
    const state = trainingState(); mutate(state); assert.equal(buildLearningReport(state, NOW).policies.length, 0);
  }
});
test('policy numeric bounds and no lookahead, and Chinese UI escapes source text', () => {
  const report = buildLearningReport(trainingState(), NOW), p = report.policies[0];
  for (const patch of [{ lossCutRate: .5 }, { maxHoldMs: 86400000 }, { teacherCount: Infinity }, { trainedAt: new Date(NOW + 1).toISOString() }, { trainingEndAt: new Date(NOW + 1).toISOString() }]) assert.equal(!!validLearningPolicy({ ...p, ...patch }, 'robinhood', NOW), false);
  report.wallets[0].wallet = '<script>alert(1)</script>';
  const html = renderWalletLearning(report); assert.equal(html.includes('<script>'), false); assert.match(html, /不代表已确认官方身份/); assert.match(html, /尚未启动/);
  report.wallets[0].checkedAt = null; report.wallets[0].lastError = 'GMGN_REQUEST_BUSY';
  assert.match(renderWalletLearning(report), /上次请求未完成，等待轮询重试/);
});
