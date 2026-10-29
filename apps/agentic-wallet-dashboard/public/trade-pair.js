export const COMMON_TOKENS = Object.freeze({
  BNB: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
});

export function createBscTradePair({ direction, tokenAddress, quoteAsset }) {
  if (!['buy', 'sell'].includes(direction)) throw new Error('INVALID_TRADE_DIRECTION');
  if (typeof tokenAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) throw new Error('INVALID_TOKEN_CA');
  if (tokenAddress.toLowerCase() === COMMON_TOKENS.BNB.toLowerCase()) throw new Error('INVALID_TOKEN_CA');
  if (!Object.hasOwn(COMMON_TOKENS, quoteAsset)) throw new Error('INVALID_QUOTE_ASSET');
  const quote = COMMON_TOKENS[quoteAsset];
  if (tokenAddress.toLowerCase() === quote.toLowerCase()) throw new Error('IDENTICAL_TOKEN_PAIR');
  return direction === 'buy' ? { fromToken: quote, toToken: tokenAddress }
    : { fromToken: tokenAddress, toToken: quote };
}
