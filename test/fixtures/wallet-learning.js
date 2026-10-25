export const NOW = Date.parse('2026-09-22T00:00:00Z');
export const address = n => `0x${n.toString(16).padStart(40, '0')}`;
export const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
export function teacher(n = 1, chain = 'robinhood', now = NOW, tags = ['smart_degen', 'fomo']) {
  const wallet = address(n), key = `${chain}:${wallet}`;
  const profile = Object.fromEntries(['7d', '30d'].map(period => [period, { chain, wallet, period, checkedAt: new Date(now).toISOString(),
    realizedProfitUsd: 20000, realizedRoi: .2, winRate: .8, tokenCount: 200, buyCount: 200, sellCount: 200, tags,
    createdAt: Math.floor(now / 1000) - 60 * 86400, lastTradeAt: Math.floor(now / 1000) - 60, createdTokenCount: 0 }]));
  return { key, chain, wallet, profile, groups: ['gmgn_smartmoney', 'gmgn_fomo'], rows: [], pages: 0, cursors: [], nextCursor: null, firstSeenAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString() };
}
export function row(n, side = 'buy', overrides = {}) {
  return { chain: 'robinhood', wallet: address(1), token: address(100), hash: hash(n), at: NOW - 120000 + n * 1000, side, quantity: 10, usd: 10, price: 1, symbol: 'FIXTURE', ...overrides };
}
export function raw(n, side = 'buy', overrides = {}) {
  return { chain: 'robinhood', wallet: address(1), token: { address: address(100), symbol: 'FIXTURE' }, tx_hash: hash(n), timestamp: NOW / 1000 - 120 + n,
    event_type: side, token_amount: '10', cost_usd: '10', price_usd: '1', ...overrides };
}
export function trainingState() {
  return { wallets: Object.fromEntries([1, 2, 3].map(n => {
    const w = teacher(n);
    w.rows = Array.from({ length: 10 }, (_, i) => {
      const at = NOW - 5 * 86400000 + i * 40000000, token = address(100 + i);
      return [row(i * 2 + 1, 'buy', { wallet: w.wallet, token, at }), row(i * 2 + 2, 'sell', { wallet: w.wallet, token, at: at + 120000, usd: 9, price: .9 })];
    }).flat();
    return [w.key, w];
  })) };
}

// Synthetic, explicitly reviewed evidence belongs only to policy tests. The
// generic teacher() fixture remains an ordinary profitability candidate.
export function reviewedTeacherRegistry(wallets = Object.values(trainingState().wallets), now = NOW) {
  const iso = value => new Date(value).toISOString(), day = 86400000;
  return { version: KOL_TEACHER_POLICY_VERSION, entries: Object.fromEntries(wallets.map((w, index) => {
    const handle = `fixturekol${index + 1}`, reviewedAt = iso(now);
    const review = { version: KOL_TEACHER_POLICY_VERSION, reviewId: `synthetic-review-${index + 1}`, chain: w.chain, wallet: w.wallet,
      reviewedAt, validUntil: iso(now + day),
      identity: { subjectId: String(100000 + index), handle, publicPersonReviewed: true,
        gmgn: { source: 'gmgn_portfolio_stats', chain: w.chain, wallet: w.wallet, handle, kol: true, xVerified: true,
          checkedAt: reviewedAt, evidenceRef: 'docs/fixture-gmgn.json' },
        firstParty: { url: `https://x.com/${handle}/status/${123456789 + index}`, chain: w.chain, wallet: w.wallet, handle,
          claim: 'wallet_ownership', checkedAt: reviewedAt, evidenceRef: 'docs/fixture-binding.json' } },
      stability: { source: 'audited_public_trade_inventory', evidenceRef: 'docs/fixture-cost-inventory.json', checkedAt: reviewedAt,
        weeks: Array.from({ length: 4 }, (_, week) => ({ startAt: iso(now - (4 - week) * 7 * day), endAt: iso(now - (3 - week) * 7 * day),
          grossRealizedPnlUsd: 100, costsUsd: 10, closedPositions: 10,
          tokens: Array.from({ length: 10 }, (_, token) => address(100 + token)),
          coverageComplete: true, inventoryReconciled: true, costsVerified: true })),
        maxDrawdownRate: .1, largestWinningTokenShare: .2, transfersReconciled: true,
        openPositionCount: 0, unrealizedPnlUsd: 0, openPositionsValuedAt: reviewedAt, lossExamples: [hash(999)] } };
    return [w.key, review];
  })) };
}

export function reviewedTeacherSelection(chain = 'robinhood', now = NOW) {
  const wallets = [1, 2, 3].map(n => teacher(n, chain, now)), reviews = reviewedTeacherRegistry(wallets, now);
  return { version: KOL_TEACHER_POLICY_VERSION, teachers: wallets.map(w => {
    const { identityId, reviewId, reviewedAt, validUntil, evidenceDigest } = assessKolLearningTeacher(w, reviews, now);
    return { key: w.key, identityId, reviewId, reviewedAt, validUntil, evidenceDigest };
  }) };
}
import { KOL_TEACHER_POLICY_VERSION, assessKolLearningTeacher } from '../../src/kol-learning-teachers.js';
