import { Denied } from './auth.mjs';

export const CORE_CHAINS = Object.freeze([
  { id: '56', name: 'BNB Smart Chain', native: 'BNB' },
  { id: '1', name: 'Ethereum', native: 'ETH' },
  { id: '8453', name: 'Base', native: 'ETH' },
  { id: 'CT_501', name: 'Solana', native: 'SOL' }
]);
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export function addressKey(chain, address) {
  if (typeof address !== 'string') throw new Denied('INVALID_ADDRESS', 400);
  return chain + ':' + (chain === 'CT_501' ? address : address.toLowerCase());
}
export function validChain(chain) {
  if (typeof chain !== 'string' || !/^(CT_501|[1-9][0-9]{0,9})$/.test(chain)) throw new Denied('INVALID_CHAIN', 400);
  return chain;
}
export function validContract(chain, address) {
  validChain(chain);
  if (typeof address !== 'string' || !(chain === 'CT_501' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(address))
    throw new Denied('INVALID_CONTRACT', 400);
  return address;
}
export function decimal(value, { zero = false } = {}) {
  if (typeof value !== 'string' || !/^\d{1,24}(\.\d{1,18})?$/.test(value) || (!zero && /^0+(\.0+)?$/.test(value)))
    throw new Denied('INVALID_AMOUNT', 400);
  return value;
}
// Chain quantities remain decimal strings, including values above Number.MAX_SAFE_INTEGER.
export function formatUnits(raw, decimals) {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(raw) || BigInt(raw) >= 2n ** 256n ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Denied('INVALID_CHAIN_QUANTITY', 503);
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0'), fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
function units(text) {
  const [a, b = ''] = decimal(text, { zero: true }).split('.');
  return BigInt(a) * 10n ** 18n + BigInt(b.padEnd(18, '0'));
}
function fromUnits(n) { return (n / 10n ** 18n).toString() + '.' + (n % 10n ** 18n).toString().padStart(18, '0'); }
export function estimateAssets(assets) {
  let sum = 0n, unpriced = 0;
  const rows = assets.map(asset => {
    let valueUsd = null;
    try {
      if (asset.priceUsd === null || asset.priceUsd === undefined || asset.priceUsd === '') throw new Error();
      const value = units(asset.balance) * units(asset.priceUsd) / 10n ** 18n;
      sum += value; valueUsd = fromUnits(value);
    } catch { unpriced++; }
    return { ...asset, valueUsd, pnl: null };
  });
  return { assets: rows, knownValueUsd: fromUnits(sum), unpricedCount: unpriced, totalComplete: unpriced === 0,
    pnl: null, pnlReason: '成本与完整资金流数据不足，未计算盈亏' };
}
export function orderState(status) {
  const labels = { SUBMITTED: '已提交，尚未确认成交', WORKING: '等待触发', TRIGGERED: '已触发，执行中',
    PENDING: '链上处理中', FINISHED: '官方报告已执行', FAILED: '失败', EXPIRED: '已过期', CANCELED: '已取消',
    BROADCASTED: '已广播，待链上确认', confirmed: '链上已确认', pending: '待处理', UNKNOWN: '结果未知，先查状态' };
  return labels[status] || labels.UNKNOWN;
}
// Completeness checks are stricter than the documented quote example. Missing is never treated as zero.
export function reviewBlockers(quote) {
  const blockers = [];
  if (!quote || quote.mode === 'mock') blockers.push('模拟报价不能用于真实交易');
  for (const [field, name] of [['priceImpactPercent', '价格影响'], ['gasTotal', '交易总 Gas'], ['knownFees', '已知费用'], ['approvalPlan', '代币授权方案']])
    if (quote?.[field] === null || quote?.[field] === undefined) blockers.push(name + '未确认');
  if (!quote?.immutableQuoteId || !quote?.expiresAt) blockers.push('可核对的报价标识与有效期未确认');
  if (quote?.approvalPlan?.unlimited === true) blockers.push('本看板不默认允许无限授权');
  return blockers;
}
