import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfitLeaderboard, mergeProfitLeaderboards, validProfitLeaderboard } from '../src/profit-leaderboard.js';
import { discoverLearningUniverse, walletResearchRole } from '../src/wallet-learning-universe.js';

const NOW = Date.parse('2026-09-22T05:00:00Z'), CA = `0x${'a'.repeat(40)}`, wallet = i => `0x${i.toString(16).padStart(40, '0')}`;
const row = (i, more = {}) => ({ address: wallet(i), addr_type: 0, is_suspicious: false, realized_profit: 100, unrealized_profit: 20,
  profit: 120, history_transfer_in_amount: 0, history_transfer_out_amount: 0, tags: [], maker_token_tags: [], ...more });
const parse = (rows, extra = {}) => parseProfitLeaderboard({ data: { list: rows } }, { chain: 'bsc', address: CA, observedAt: new Date(NOW).toISOString(), ...extra });

test('leaderboards use explicit realized profit and distinguish wallet addresses from token accounts', () => {
  const result = parse([row(1, { account_address: wallet(99) }), row(2, { realized_profit: null, profit: 1000 }), row(3, { realized_profit: -1 })]);
  assert.equal(result.observedRows, 3); assert.equal(result.omitted, 2); assert.equal(result.entries[0].wallet, wallet(1));
  assert.equal(result.entries[0].sources[0].realizedProfitUsd, 100); assert.equal(result.entries[0].sources[0].unrealizedProfitUsd, 20);
  assert.equal(result.entries[0].researchEligible, true); assert.equal(result.entries[0].sources[0].sourceRank, 1);
});
test('transfer attribution, suspicious wallets, pools and insider/bundler labels remain flagged rather than teachers', () => {
  const result = parse([row(1, { history_transfer_out_amount: 50 }), row(2, { is_suspicious: true }), row(3, { addr_type: 2 }),
    row(4, { maker_token_tags: ['bundler'] }), row(5, { history_transfer_in_amount: null }), row(6, { tags: ['rat_trader'] })]);
  assert.equal(result.entries.length, 6); assert.ok(result.entries.every(row => !row.researchEligible));
  const state = mergeProfitLeaderboards(null, result.entries, NOW); assert.equal(validProfitLeaderboard(state), true);
  assert.equal(Object.keys(discoverLearningUniverse({ leaderboard: state, nowMs: NOW })).length, 0);
});
test('ranked but untagged wallets enter research without fabricated smartmoney/FOMO identity or profit qualifications', () => {
  const state = mergeProfitLeaderboards(null, parse([row(1)]).entries, NOW);
  const u = discoverLearningUniverse({ leaderboard: state, nowMs: NOW }), w = u[`bsc:${wallet(1)}`];
  assert.equal(w.source, 'gmgn_token_profit_leaderboard'); assert.deepEqual(w.groups, ['research_observer']);
  assert.deepEqual(w.tags, []); assert.equal(walletResearchRole(w, NOW), 'unverified');
  assert.equal(w.leaderboard.sources[0].tokenAddress, CA);
});
test('same wallet multi-token observations deduplicate without summing profit; issues and bounded state survive refresh', () => {
  let state = mergeProfitLeaderboards(null, parse([row(1)]).entries, NOW);
  state = mergeProfitLeaderboards(state, parse([row(1, { realized_profit: 50 })], { address: wallet(55) }).entries, NOW);
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].sources.length, 2);
  assert.equal(state.entries[0].realizedProfitUsd, undefined);
  state = mergeProfitLeaderboards(state, parse([row(1, { tags: ['bundler'] })]).entries, NOW);
  state = mergeProfitLeaderboards(state, parse([row(1)], { observedAt: new Date(NOW + 1000).toISOString() }).entries, NOW + 1000);
  assert.equal(state.entries[0].researchEligible, false); assert.equal(validProfitLeaderboard(state), true);
  assert.throws(() => mergeProfitLeaderboards({}, [], NOW), /state_invalid/);
  const invalid = structuredClone(state); invalid.entries[0].sources[0].chain = 'eth'; assert.equal(validProfitLeaderboard(invalid), false);
});
test('newly flagged ranking observations revoke prior leaderboard eligibility without restoring it from old records', () => {
  let state = mergeProfitLeaderboards(null, parse([row(1), row(2, { tags: ['smart_degen'] })]).entries, NOW);
  const previous = discoverLearningUniverse({ leaderboard: state, nowMs: NOW });
  state = mergeProfitLeaderboards(state, parse([row(1, { history_transfer_in_amount: 20 }),
    row(2, { tags: ['smart_degen'], history_transfer_in_amount: 20 })]).entries, NOW);
  const next = discoverLearningUniverse({ leaderboard: state, previous, wallets: previous, nowMs: NOW });
  assert.equal(next[`bsc:${wallet(1)}`], undefined);
  assert.equal(next[`bsc:${wallet(2)}`].leaderboard.researchEligible, false);
});
test('foreign-chain, missing realized profit, invalid Solana identities and duplicate rows fail closed', () => {
  assert.throws(() => parseProfitLeaderboard({ chain: 'eth', list: [row(1)] }, { chain: 'bsc', address: CA, observedAt: new Date(NOW).toISOString() }), /identity_invalid/);
  assert.equal(parse([row(1, { chain: 'eth' })]).entries.length, 0);
  assert.throws(() => parse([row(1), row(1)]), /duplicate_wallet/);
  assert.throws(() => parse([row(1)], { chain: 'sol' }), /response_invalid/);
  const sol = 'A'.repeat(32), owner = 'B'.repeat(32);
  assert.equal(parse([{ ...row(1), address: owner }], { chain: 'sol', address: sol }).entries[0].wallet, owner);
});
