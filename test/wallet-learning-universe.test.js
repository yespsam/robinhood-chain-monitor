import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLearningUniverse, balancedLearningSelection, walletResearchRole, mergeLearningProfiles } from '../src/wallet-learning-universe.js';
import { buildLearningReport, validLearningPolicy } from '../src/wallet-learning.js';
import { classifyWalletPersonas } from '../src/wallet-personas.js';
import { advanceLearningShadow } from '../src/wallet-learning-shadow.js';
import { NOW, teacher, address, trainingState } from './fixtures/wallet-learning.js';

test('candidate discovery expands to bounded diverse research including unsuccessful controls', () => {
  const profiles = {};
  for (const [chain, count] of [['robinhood', 550], ['bsc', 60], ['base', 2], ['eth', 30]]) for (let n = 1; n <= count; n++) {
    const w = teacher(n, chain); w.profile['7d'].realizedProfitUsd = -100; w.profile.unused = null; profiles[w.key] = w.profile;
  }
  const universe = discoverLearningUniverse({ flow: { profiles }, nowMs: NOW });
  assert.equal(Object.keys(universe).length, 500);
  const deep = balancedLearningSelection(Object.values(universe), 80, NOW);
  assert.equal(deep.length, 80); assert.equal(deep.filter(w => w.chain === 'base').length, 2);
  assert.ok(deep.filter(w => w.chain === 'eth').length >= 20);
  assert.ok(deep.every(w => walletResearchRole(w, NOW) === 'comparison'));
});
test('unverified explicit FOMO addresses are research only, never invented profitable teachers', () => {
  const w = teacher(); const u = discoverLearningUniverse({ flow: { trades: { robinhood: [{ chain: w.chain, wallet: w.wallet, tags: ['fomo'], at: NOW }] } }, nowMs: NOW });
  assert.equal(Object.keys(u).length, 1); assert.equal(walletResearchRole(u[w.key], NOW), 'unverified');
  assert.deepEqual(u[w.key].groups, ['research_observer', 'gmgn_fomo']);
  const report = buildLearningReport({ wallets: { [w.key]: { ...w, ...u[w.key] } }, universe: u }, NOW);
  assert.equal(report.qualifiedNow, 0); assert.equal(report.personaPolicies.length, 0);
});
test('chain-bound profile merge cannot revive foreign, older or blocked identities', () => {
  const w = teacher(), older = structuredClone(w.profile), foreign = teacher(2).profile;
  older['7d'].checkedAt = new Date(NOW - 1000).toISOString();
  assert.equal(mergeLearningProfiles(w.chain, w.wallet, w.profile, older, foreign)['7d'].checkedAt, w.profile['7d'].checkedAt);
  const source = { profiles: { [w.key]: w.profile } }, first = discoverLearningUniverse({ flow: source, nowMs: NOW });
  w.profile['7d'].tags = ['smart_degen', 'mev_bot'];
  assert.equal(Object.keys(discoverLearningUniverse({ flow: source, previous: first, nowMs: NOW })).length, 0);
  assert.equal(discoverLearningUniverse({ flow: { trades: { a: [{ chain: 'bsc', wallet: 'bad', tags: ['fomo'], at: NOW }] } }, nowMs: NOW })['bsc:bad'], undefined);
});
test('unknown statistics never turn into failure assertions and small samples have no persona', () => {
  const w = teacher(); w.statsError = 'learning_profile_incomplete'; assert.equal(walletResearchRole(w, NOW), 'unverified');
  const r = buildLearningReport({ wallets: { [w.key]: w } }, NOW);
  assert.equal(r.wallets[0].persona.labels.length, 0); assert.equal(r.wallets[0].persona.status, 'insufficient');
});
test('personas describe overlapping observed habits and conditional weaknesses, not fabricated narratives', () => {
  const base = { matchedSells: 20, matchedTokenCount: 5, medianHoldMs: 120000, observedSpanMs: 4 * 86400000, partialSells: 8,
    adds: 5, risingAdds: 4, fallingAdds: 0, winningExits: 8, losingExits: 3, medianWinningExit: .4, medianLosingExit: -.1,
    tooFastSells: 0, excludedTokens: 1, buyCount: 20, buySizeP90P10: 5, buyTokenCount: 5, largestTokenBuyShare: .6 };
  const p = classifyWalletPersonas(base);
  assert.deepEqual(p.labels.map(x => x.id), ['short_cycle', 'scale_out', 'pyramid', 'profit_asymmetry']);
  assert.ok(p.drawbacks.some(s => s.includes('四倍'))); assert.ok(p.drawbacks.some(s => s.includes('集中')));
  assert.ok(p.unknown.includes('真实买点与行情环境'));
  const fast = classifyWalletPersonas({ ...base, tooFastSells: 15 }); assert.equal(fast.labels[0].id, 'ultrafast'); assert.equal(fast.labels[0].adoptable, false);
  const down = classifyWalletPersonas({ ...base, risingAdds: 0, fallingAdds: 4 }); assert.ok(down.labels.some(x => x.id === 'average_down' && !x.adoptable));
  const lossy = classifyWalletPersonas({ ...base, medianLosingExit: -.8 }); assert.ok(lossy.drawbacks.some(s => s.includes('亏损退出幅度偏大')));
});
test('only qualified clean multi-teacher persona groups can produce bounded forward policies', () => {
  const s = trainingState(); const good = buildLearningReport(s, NOW);
  assert.equal(good.personaPolicies.length, 2); assert.equal(good.personaPolicies[0].personaId, 'short_cycle');
  assert.ok(validLearningPolicy(good.personaPolicies[0], 'robinhood', NOW));
  assert.equal(validLearningPolicy({ ...good.personaPolicies[0], personaId: 'average_down' }, 'robinhood', NOW), false);
  for (const change of [w => { w.historyGap = true; }, w => { w.statsError = 'bad'; }, w => { w.profile['7d'].realizedProfitUsd = -1; }]) {
    const copy = trainingState(); change(Object.values(copy.wallets)[0]); assert.equal(buildLearningReport(copy, NOW).personaPolicies.length, 0);
  }
});
test('persona candidate selection is chain bound, keeps independent paper controls and no automatic promotion', () => {
  const report = buildLearningReport(trainingState(), NOW);
  const pair = advanceLearningShadow(null, { report, chain: 'robinhood', evaluations: [], marksFor: () => [], enabled: true, nowMs: NOW });
  assert.equal(pair.latestPolicy.personaId, 'short_cycle'); assert.equal(pair.control.cash, 100); assert.equal(pair.student.execution, false);
  assert.equal(advanceLearningShadow(null, { report, chain: 'bsc', evaluations: [], marksFor: () => [], enabled: true, nowMs: NOW }), null);
});
