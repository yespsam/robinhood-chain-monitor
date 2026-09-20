import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadonlyMarketClient } from '../src/gmgn-readonly-market.js';

const rankItem = {
  chain: 'bsc', address: '0xabc12345', name: 'Example', symbol: 'EX', price: 0.12,
  price_change_percent: 4.5, market_cap: 1200000, liquidity: 80000, volume: 25000,
  swaps: 42, buys: 25, sells: 17, holder_count: 900, smart_degen_count: 5,
  renowned_count: 2, rug_ratio: 0, is_honeypot: 0, is_wash_trading: false,
  is_open_source: 1, is_renounced: 1, creator_token_status: 'creator_close', creator_close: true,
  launchpad_platform: 'geniusfun', creation_timestamp: 1700000000,
};

test('readonly market parses GMGN trending envelope and applies transparent risk gate', async () => {
  const calls = [];
  const client = createReadonlyMarketClient({ runner: async args => {
    calls.push(args);
    return JSON.stringify({ code: 0, data: { rank: [rankItem] }, message: 'success' });
  } });
  const result = await client.trending({ chain: 'bsc', interval: '1m', limit: 10 });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'gmgn-cli');
  assert.equal(result.tokens[0].address, rankItem.address);
  assert.equal(result.tokens[0].volume, rankItem.volume);
  assert.equal(result.tokens[0].risk, 'STRONG');
  assert.deepEqual(calls[0], ['market', 'trending', '--chain', 'bsc', '--interval', '1m', '--order-by', 'volume', '--limit', '10', '--raw']);
  await client.trending({ chain: 'bsc', interval: '1m', limit: 10 });
  assert.equal(calls.length, 1, 'identical snapshots are cached briefly');
});

test('readonly market parses K-line list with USD volume and token amount', async () => {
  const calls = [];
  const client = createReadonlyMarketClient({ runner: async args => {
    calls.push(args);
    return JSON.stringify({ list: [{ time: 1700000000000, open: '1', close: '2', high: '3', low: '0.5', volume: '1200', amount: '600' }] });
  } });
  const result = await client.kline({ chain: 'bsc', address: '0xabc12345', resolution: '1m', from: 1700000000, to: 1700003600 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.candles[0], { time: 1700000000000, open: 1, close: 2, high: 3, low: 0.5, volume: 1200, amount: 600, source: null });
  assert.deepEqual(calls[0], ['market', 'kline', '--chain', 'bsc', '--address', '0xabc12345', '--resolution', '1m', '--from', '1700000000', '--to', '1700003600', '--raw']);
});

test('readonly market fails closed on malformed or unavailable upstream data', async () => {
  const client = createReadonlyMarketClient({ runner: async () => '{"code":1,"data":{}}' });
  const result = await client.trending({ chain: 'base', interval: '5m', limit: 5 });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.tokens, undefined);
  await assert.rejects(() => client.kline({ chain: 'sol', address: 'not valid!', resolution: '1m' }), /invalid address/);
});

test('readonly market accepts only supported read-only chains and resolutions', async () => {
  const client = createReadonlyMarketClient({ runner: async () => JSON.stringify({ data: { rank: [rankItem] } }) });
  await assert.rejects(() => client.trending({ chain: 'polygon', interval: '1m' }), /invalid chain/);
  await assert.rejects(() => client.trending({ chain: 'bsc', interval: '10m' }), /invalid interval/);
  await assert.rejects(() => client.kline({ chain: 'bsc', address: '0xabc12345', resolution: '10m' }), /invalid resolution/);
});
