import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { Interface } from 'ethers';
import { fetchKolMark, fetchFlapCurveMark } from '../src/kol-news-data.js';
import { FLAP_DEPTH_ABI, FLAP_DEPTH_PORTAL, BNB_ORACLE } from '../src/paper-internal-depth.js';

const A = '0xdd806e436dda5588bf54061c11590c77ddc87777';
const oracle = new Interface(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
function fakeCall({ status = 1n, quote = ZeroAddress, price = 10n ** 12n, reserve = 10n * 10n ** 18n } = {}) {
  return async (to) => {
    if (to === FLAP_DEPTH_PORTAL) return FLAP_DEPTH_ABI.encodeFunctionResult('getTokenV8Safe', [[status, reserve, 1n, price, 1n, 0n, 0n, 0n, 10n ** 27n, quote, false, '0x' + '0'.repeat(64), 0n, 0n, ZeroAddress, 0n, 0, 0]]);
    if (to === BNB_ORACLE) return oracle.encodeFunctionResult('latestRoundData', [1n, 700n * 10n ** 8n, 1n, BigInt(Math.floor(Date.now() / 1000)), 1n]);
    throw new Error('unexpected');
  };
}

test('flap curve mark: price × BNB/USD, reserve as liquidity', async () => {
  const m = await fetchFlapCurveMark(A, { call: fakeCall() });
  assert.equal(m.source, 'flap_curve');
  assert.ok(Math.abs(m.priceUsd - 1e-6 * 700) < 1e-12);
  assert.equal(m.liquidityUsd, 7000);
});
test('flap curve mark null when graduated or unknown quote', async () => {
  assert.equal(await fetchFlapCurveMark(A, { call: fakeCall({ status: 4n }) }), null);
  assert.equal(await fetchFlapCurveMark(A, { call: fakeCall({ quote: '0x1111111111111111111111111111111111111111' }) }), null);
});
test('flap curve mark: USDT quote ≈ $1, reserve as liquidity', async () => {
  const USDT = '0x55d398326f99059ff775485246999027b3197955';
  const base = fakeCall({ quote: USDT });
  const dec = new Interface(['function decimals() view returns(uint8)']);
  const call = async (to, data) => (to.toLowerCase() === USDT ? dec.encodeFunctionResult('decimals', [18]) : base(to, data));
  const m = await fetchFlapCurveMark(A, { call });
  assert.equal(m.source, 'flap_curve_usdt');
  assert.ok(Math.abs(m.priceUsd - 1e-6) < 1e-12);
  assert.equal(m.liquidityUsd, 10);
});
test('fallback order dex → flap → gmgn → last trade', async () => {
  const no = async () => null;
  assert.equal((await fetchKolMark({ address: A }, { dex: async () => ({ priceUsd: 2, liquidityUsd: 9000 }), flap: no, gmgn: no })).source, 'dexscreener');
  assert.equal((await fetchKolMark({ address: A }, { dex: no, flap: async () => ({ priceUsd: 1, liquidityUsd: 4000, source: 'flap_curve' }), gmgn: no })).source, 'flap_curve');
  const g = await fetchKolMark({ address: A }, { dex: no, flap: no, gmgn: async () => 3 });
  assert.equal(g.source, 'gmgn'); assert.equal(g.liquidityUsd, undefined);
  assert.equal((await fetchKolMark({ address: A, trades: [{ priceUsd: 4, at: 1 }] }, { dex: no, flap: no, gmgn: no })).source, 'last_trade_implied');
  assert.equal(await fetchKolMark({ address: A }, { dex: no, flap: no, gmgn: no }), null);
});

test('resolveFlapQuoteUsd: unknown quote routed via PCS V2 WBNB', async () => {
  const { resolveFlapQuoteUsd } = await import('../src/kol-news-data.js');
  const { Interface } = await import('ethers');
  const R = new Interface(['function getAmountsOut(uint256,address[]) view returns(uint256[])']);
  const O = new Interface(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
  const D = new Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
  const call = async (to, data) => {
    to = to.toLowerCase();
    if (to === '0x10ed43c718714eb63d5aa57b78b54704e256024e') { const amt = R.decodeFunctionData('getAmountsOut', data)[0]; return R.encodeFunctionResult('getAmountsOut', [[amt, amt * 2n / 1000n]]); }
    if (data.startsWith(D.getFunction('decimals').selector)) return D.encodeFunctionResult('decimals', [18]);
    if (data.startsWith(D.getFunction('symbol').selector)) return D.encodeFunctionResult('symbol', ['XYZ']);
    return O.encodeFunctionResult('latestRoundData', [1, 500n * 10n ** 8n, 0, Math.floor(Date.now() / 1000), 1]);
  };
  const q = await resolveFlapQuoteUsd('0x00000000000000000000000000000000000000aa', { call, now: Date.now() });
  assert.equal(q.route, 'pcs_v2_wbnb'); assert.ok(Math.abs(q.quoteUsd - 1) < 1e-9); assert.equal(q.quoteSymbol, 'XYZ');
});

// ---- Medium 8: quote trust gates ----
test('resolveFlapQuoteUsd: stale oracle, shallow pool, unknown decimals => null', async () => {
  const { resolveFlapQuoteUsd } = await import('../src/kol-news-data.js');
  const R = new Interface(['function getAmountsOut(uint256,address[]) view returns(uint256[])']);
  const D = new Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
  const mk = ({ updatedAt = Math.floor(Date.now() / 1000), shallow = false, dec = true } = {}) => async (to, data) => {
    to = to.toLowerCase();
    if (to === '0x10ed43c718714eb63d5aa57b78b54704e256024e') { const amt = R.decodeFunctionData('getAmountsOut', data)[0]; return R.encodeFunctionResult('getAmountsOut', [[amt, shallow ? 2n * 10n ** 15n : amt * 2n / 1000n]]); }
    if (data.startsWith(D.getFunction('decimals').selector)) { if (!dec) throw new Error('no'); return D.encodeFunctionResult('decimals', [18]); }
    if (data.startsWith(D.getFunction('symbol').selector)) return D.encodeFunctionResult('symbol', ['XYZ']);
    return oracle.encodeFunctionResult('latestRoundData', [1, 500n * 10n ** 8n, 0, updatedAt, 1]);
  };
  const noDex = async () => null;
  assert.equal(await resolveFlapQuoteUsd(ZeroAddress, { call: mk({ updatedAt: 1 }) }), null);
  assert.notEqual((await resolveFlapQuoteUsd('0x00000000000000000000000000000000000000b1', { call: mk({ updatedAt: 1 }), dexQuote: noDex }))?.route, 'pcs_v2_wbnb'); // stale BNB oracle never used
  assert.equal(await resolveFlapQuoteUsd('0x00000000000000000000000000000000000000b2', { call: mk({ shallow: true }), dexQuote: noDex }), null);
  assert.equal(await resolveFlapQuoteUsd('0x00000000000000000000000000000000000000b3', { call: mk({ dec: false }), dexQuote: noDex }), null);
});
test('fetchDexMark binds chain and base token', async () => {
  const { fetchDexMark } = await import('../src/kol-news-data.js');
  const pairs = [{ chainId: 'ethereum', baseToken: { address: A }, priceUsd: '9', liquidity: { usd: 1e6 } }, { chainId: 'bsc', baseToken: { address: '0x' + '9'.repeat(40) }, priceUsd: '8', liquidity: { usd: 1e6 } }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ pairs }) });
  assert.equal(await fetchDexMark(A, { fetchImpl, chain: 'bsc' }), null);
  pairs.push({ chainId: 'bsc', baseToken: { address: A.toUpperCase().replace('0X', '0x') }, priceUsd: '2', liquidity: { usd: 5000 } });
  assert.equal((await fetchDexMark(A, { fetchImpl, chain: 'bsc' })).priceUsd, 2);
  assert.equal(await fetchDexMark(A, { fetchImpl, chain: 'bsc', minLiquidityUsd: 10000 }), null);
});
