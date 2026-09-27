import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceBinanceFlowFeed, binanceFeedCoverage, buildBinanceFlowEvidence, normalizeBinanceFlowRow, validBinanceFlowState, binanceProfileCandidates } from '../src/binance-flow-evidence.js';
import { buildPaperDualFlowEvidence } from '../src/paper-strategy-evidence.js';
import { NOW, CA, OTHER, row, wallet, warmFeed, stateFor, profilesFor } from './fixtures/binance-flow.js';
const evidence = (feed, more = {}) => buildBinanceFlowEvidence({ state: stateFor(feed), chain: 'robinhood', address: CA, kind: 'kol', nowMs: NOW, ...more });

test('Binance exact chain/CA/log/time validation rejects malformed identities', () => {
  for (const changes of [{ chainId: '56' }, { logId: null }, { logId: '' }, { logId: '-1' }, { txHash: 'fake' }, { address: 'fake' }, { ca: null }, { ts: NOW }, { ts: NOW / 1000 + 60 }])
    assert.throws(() => normalizeBinanceFlowRow(row(1, changes), 'robinhood', 'kol', NOW));
  assert.equal(normalizeBinanceFlowRow(row(), 'robinhood', 'kol', NOW).at, NOW - 20000);
});

test('short, old or empty first page never establishes continuous five-minute coverage', () => {
  for (const rows of [[], [row()], [row(1, { ts: NOW / 1000 - 400 })]]) {
    const feed = advanceBinanceFlowFeed(null, { code: '000000', data: rows }, 'robinhood', 'kol', NOW, NOW);
    assert.equal(binanceFeedCoverage(feed, NOW).complete, false);
  }
  let feed;
  for (let t = NOW - 360000; t <= NOW; t += 30000) feed = advanceBinanceFlowFeed(feed, { code: '000000', data: [] }, 'robinhood', 'smartmoney', t, t);
  assert.equal(binanceFeedCoverage(feed, NOW).coverageGap, 'binance_no_verified_feed');
});

test('verified continuous session becomes usable, stale/disconnected/restarted sessions rebuild', () => {
  const feed = warmFeed([row()]);
  assert.equal(binanceFeedCoverage(feed, NOW).complete, true);
  assert.equal(binanceFeedCoverage(feed, NOW + 120000).complete, false);
  for (const prior of [{ ...feed, coverage: null }, feed]) {
    const at = NOW + 120000;
    const next = advanceBinanceFlowFeed(prior, { code: '000000', data: [row()] }, 'robinhood', 'kol', at, at);
    assert.equal(binanceFeedCoverage(next, at).complete, false);
  }
  const disjoint = advanceBinanceFlowFeed(feed, { code: '000000', data: [row(3, { ts: NOW / 1000 + 25 })] }, 'robinhood', 'kol', NOW + 30000, NOW + 30000);
  assert.equal(binanceFeedCoverage(disjoint, NOW + 30000).complete, false);
});

test('deduplicate by chain/hash/logId; different logs remain distinct; revision is conservative', () => {
  const first = row();
  const feed = warmFeed([first, first, row(1, { txUsdValue: '1200' }), row(1, { logId: '2', txUsdValue: '300' })]);
  const result = evidence(feed);
  assert.equal(result.complete, true); assert.equal(result.uniqueBuyerCount, 1); assert.equal(result.netBuyUsd, 1300);
  assert.equal(result.fomoCount, null); assert.equal(result.fomoSupported, false);
  const sells = evidence(warmFeed([row(1, { tradeSideCategory: 29, txUsdValue: '800' }), row(1, { tradeSideCategory: 29, txUsdValue: '900' })]));
  assert.equal(sells.netBuyUsd, -900);
});

test('unknown transaction types and conflicting immutable legs isolate only the affected token', () => {
  for (const extra of [row(2, { tradeSideCategory: 100001 }), row(1, { address: wallet(3) }), row(1, { tradeSideCategory: 29 })]) {
    const feed = warmFeed([row(), extra]);
    assert.equal(evidence(feed).complete, false);
    assert.equal(evidence(feed).coverageGap, 'binance_token_record_unverified');
  }
  const feed = warmFeed([row(), row(2, { ca: OTHER, tradeSideCategory: 100002 })]);
  assert.equal(evidence(feed).complete, true);
});

test('labels are not profit evidence; GMGN exact-wallet seven/thirty-day profiles remain mandatory', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1)), feed = warmFeed(rows);
  assert.equal(evidence(feed).highProfitCount, 0);
  assert.equal(evidence(feed).smartMoneyCount, 0);
  const gmgnState = profilesFor(rows), result = evidence(feed, { gmgnState });
  assert.equal(result.highProfitCount, 6); assert.equal(result.profileCheckedCount, 6); assert.equal(result.smartMoneyCount, 6);
  delete gmgnState.profiles[`robinhood:${rows[0].address}`]['30d'];
  assert.equal(evidence(feed, { gmgnState }).highProfitCount, 5);
  const malformed = structuredClone(gmgnState); malformed.profiles[`robinhood:${rows[1].address}`]['7d'].chain = 'bsc';
  assert.equal(evidence(feed, { gmgnState: malformed }).highProfitCount, 4);
});

test('secondary candidate queue supplies profiles, never turns a label into an approved buyer', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1)), state = stateFor(warmFeed(rows));
  assert.equal(validBinanceFlowState(state), true);
  assert.deepEqual(binanceProfileCandidates(state, 'robinhood', NOW), rows.map(r => r.address));
  assert.deepEqual(binanceProfileCandidates(state, 'robinhood', NOW + 120000), []);
  const broken = structuredClone(state); broken.chains.robinhood.feeds.kol.rows[0].chain = 'bsc';
  assert.equal(validBinanceFlowState(broken), false);
});

test('dual source chooses one complete cohort, never sums copies and respects holding source', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1)), binanceState = stateFor(warmFeed(rows)), gmgn = profilesFor(rows);
  const secondary = buildPaperDualFlowEvidence({ state: gmgn, binanceState, chain: 'robinhood', address: CA, nowMs: NOW });
  assert.equal(secondary.provider, 'binance_kol'); assert.equal(secondary.netBuyUsd, 6000); assert.equal(secondary.complete, true);
  assert.equal(secondary.sources.length, 3);
  gmgn.chains = { robinhood: { status: 'healthy', feedCoverage: Object.fromEntries(['smartmoney', 'kol'].map(k => [k, { valid: true, startAt: NOW - 360000, endAt: NOW, observedAt: NOW }])) } };
  gmgn.trades = { robinhood: rows.map(r => ({ chain: 'robinhood', tokenAddress: CA, wallet: r.address, side: 'buy', amountUsd: 1000, at: r.ts * 1000, hash: r.txHash, tags: [] })) };
  const primary = buildPaperDualFlowEvidence({ state: gmgn, binanceState, chain: 'robinhood', address: CA, nowMs: NOW });
  assert.equal(primary.provider, 'gmgn'); assert.equal(primary.netBuyUsd, 6000);
  const pinned = buildPaperDualFlowEvidence({ state: gmgn, chain: 'robinhood', address: CA, nowMs: NOW, preferredProvider: 'binance_kol' });
  assert.equal(pinned.provider, 'binance_kol'); assert.equal(pinned.complete, false);
});
