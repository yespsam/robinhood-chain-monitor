import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_TOKENS, createBscTradePair } from '../public/trade-pair.js';

const CA = '0x1111111111111111111111111111111111111111';

test('single-CA helper composes buy and sell pairs without changing the quoted asset', () => {
  assert.deepEqual(createBscTradePair({ direction: 'buy', tokenAddress: CA, quoteAsset: 'BNB' }),
    { fromToken: COMMON_TOKENS.BNB, toToken: CA });
  assert.deepEqual(createBscTradePair({ direction: 'sell', tokenAddress: CA, quoteAsset: 'USDT' }),
    { fromToken: CA, toToken: COMMON_TOKENS.USDT });
});

test('single-CA helper rejects malformed CA, unknown quote, direction, and self-pairs', () => {
  for (const input of [
    { direction: 'buy', tokenAddress: 'not-a-ca', quoteAsset: 'BNB' },
    { direction: 'buy', tokenAddress: CA, quoteAsset: 'UNKNOWN' },
    { direction: 'swap', tokenAddress: CA, quoteAsset: 'BNB' },
    { direction: 'buy', tokenAddress: COMMON_TOKENS.BNB, quoteAsset: 'BNB' }
  ]) assert.throws(() => createBscTradePair(input));
});
