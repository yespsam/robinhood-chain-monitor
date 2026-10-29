import { CORE_CHAINS, NATIVE, estimateAssets, decimal, decimalExceedsInteger } from './model.mjs';
import { Denied } from './auth.mjs';
export const mockWallets = Object.fromEntries(CORE_CHAINS.map(c => [c.id, 'DEMO-' + c.id + '-WALLET-NOT-AN-ADDRESS']));
const assets = [
  { chainId: '56', symbol: 'BNB', contract: NATIVE, native: true, balance: '1.2', priceUsd: '600' },
  { chainId: '56', symbol: 'USDT', contract: '0x55d398326f99059fF775485246999027B3197955', balance: '320', priceUsd: '1' },
  { chainId: '56', symbol: 'DEMO', contract: 'DEMO-BSC-TOKEN-NOT-A-CONTRACT', balance: '2500', priceUsd: null },
  { chainId: '1', symbol: 'ETH', contract: NATIVE, native: true, balance: '0.05', priceUsd: '2500' },
  { chainId: '8453', symbol: 'ETH', contract: NATIVE, native: true, balance: '0.08', priceUsd: '2500' },
  { chainId: 'CT_501', symbol: 'SOL', contract: 'DEMO-SOL-NATIVE-MARKER', native: true, balance: '2.5', priceUsd: '150' }
].map(x => ({ ...x, priceSource: x.priceUsd === null ? null : '内置模拟价格，非实时行情', priceAt: '2026-10-22T08:00:00+08:00' }));
export function demoSnapshot() {
  return { mode: 'mock', connected: false, warning: '模拟数据，未连接钱包', chains: CORE_CHAINS, wallets: mockWallets,
    ...estimateAssets(assets), transactions: [
      { chainId: '56', id: 'DEMO-TX-01', type: '兑换样例', status: 'confirmed', hash: null, time: '2026-10-21 16:00 UTC+8' },
      { chainId: '8453', id: 'DEMO-TX-02', type: '待处理样例', status: 'pending', hash: null, time: '2026-10-21 16:10 UTC+8' }
    ], orders: [{ chainId: '56', id: 'DEMO-ORDER-01', type: '限价样例', status: 'WORKING', fromToken: assets[1].contract, toToken: NATIVE, amount: '20', hash: null }],
    approvals: [], approvalsNote: '未读取真实授权；没有记录不代表没有授权' };
}
export function demoQuote(input) {
  if (!input || Object.keys(input).some(k => !['chainId', 'fromToken', 'toToken', 'amount', 'slippage', 'kind'].includes(k)))
    throw new Denied('INVALID_QUOTE_FIELDS', 400);
  const { chainId, fromToken, toToken, amount, slippage, kind } = input;
  if (kind === 'limit' && !['56', 'CT_501'].includes(chainId)) throw new Denied('LIMIT_CHAIN_UNSUPPORTED', 400);
  if (!['market', 'limit'].includes(kind)) throw new Denied('INVALID_KIND', 400);
  decimal(amount); decimal(slippage, { zero: true });
  if (decimalExceedsInteger(slippage, '100')) throw new Denied('INVALID_SLIPPAGE', 400);
  const from = assets.find(x => x.chainId === chainId && x.contract === fromToken);
  const to = assets.find(x => x.chainId === chainId && x.contract === toToken);
  if (!from || !to || fromToken === toToken) throw new Denied('TOKEN_PAIR_NOT_IN_DEMO', 400);
  return { mode: 'mock', chainId, wallet: mockWallets[chainId], fromToken, toToken, amount, kind,
    fromSymbol: from.symbol, toSymbol: to.symbol,
    estimatedOut: kind === 'market' && from.priceUsd && to.priceUsd ? String(Number(amount) * Number(from.priceUsd) / Number(to.priceUsd)) : null,
    slippagePercent: slippage, priceImpactPercent: null, gasTotal: null, knownFees: null, approvalPlan: null,
    immutableQuoteId: null, expiresAt: null, warning: '模拟审阅，不是可执行报价；没有提交交易' };
}
