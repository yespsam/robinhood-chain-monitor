import { BINANCE_FLOW_CHAINS, BINANCE_FLOW_SCHEMA, advanceBinanceFlowFeed } from '../../src/binance-flow-evidence.js';
export const NOW = Date.parse('2026-09-22T01:00:00Z');
export const CA = `0x${'a'.repeat(40)}`, OTHER = `0x${'b'.repeat(40)}`;
export const wallet = i => `0x${i.toString(16).padStart(40, '0')}`;
export const row = (i = 1, overrides = {}) => ({ chainId: '4663', txHash: `0x${i.toString(16).padStart(64, '0')}`, logId: String(i),
  address: wallet(i), ca: CA, ts: NOW / 1000 - 20, tradeSideCategory: 19, txUsdValue: '1000', tokenName: 'OFFLINE_FIXTURE', ...overrides });
export function warmFeed(rows, { chain = 'robinhood', kind = 'kol', at = NOW } = {}) {
  const anchor = row(999, { chainId: BINANCE_FLOW_CHAINS[chain], ca: OTHER, ts: (at - 400_000) / 1000 });
  let feed;
  for (let t = at - 360_000; t <= at; t += 30_000) feed = advanceBinanceFlowFeed(feed,
    { code: '000000', success: true, data: [anchor, ...rows.filter(r => r.ts * 1000 <= t)] }, chain, kind, t, t);
  return feed;
}
export const stateFor = (feed, kind = 'kol') => ({ schema: BINANCE_FLOW_SCHEMA, mode: 'readonly', updatedAt: NOW, nextChainIndex: 0, cooldownUntil: 0,
  chains: { robinhood: { feeds: { [kind]: feed } } } });
export function profilesFor(rows) {
  return { profiles: Object.fromEntries(rows.map(r => [`robinhood:${r.address}`, Object.fromEntries(['7d', '30d'].map(period => [period,
    { chain: 'robinhood', wallet: r.address, period, checkedAt: new Date(NOW).toISOString(), realizedProfitUsd: 20000, realizedRoi: .1,
      winRate: .8, tokenCount: 120, buyCount: 100, sellCount: 100, tags: [], createdAt: NOW / 1000 - 40 * 86400, lastTradeAt: NOW / 1000 - 60, createdTokenCount: 0 }]))])) };
}
