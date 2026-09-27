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
