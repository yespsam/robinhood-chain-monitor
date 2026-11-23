// Read-only loaders for the paper KOL news lane: local state files only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { FLAP_DEPTH_ABI, FLAP_DEPTH_PORTAL, BNB_ORACLE } from './paper-internal-depth.js';
import { Interface, formatUnits, ZeroAddress } from 'ethers';
import { tweetToKolRecord, nameTermsIn, canonAddr, assetKey, normKolChain } from './kol-news-sniper.js';

async function json(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

export async function loadKolTweets(dataDir) {
  const s = await json(path.join(dataDir, 'twitter-narrative-state.json'));
  return (s?.posts || []).map(tweetToKolRecord).filter(Boolean).sort((a, b) => a.at - b.at);
}

export async function loadKolLaneTokens(dataDir, favorites = []) {
  const tokens = new Map();
  const get = (addr, chain, symbol) => {
    const k = assetKey(chain, addr);
    if (!tokens.has(k)) tokens.set(k, { address: canonAddr(addr), chain: normKolChain(chain) === 'sol' ? 'sol' : chain, symbol, trades: [], createdAt: undefined, liquidityUsd: undefined });
    const t = tokens.get(k); if (!t.symbol && symbol) t.symbol = symbol; return t;
  };
  const fomo = await json(path.join(dataDir, 'fomo-call-state.json'));
  const seen = new Set();
  const push = (t, tr) => { const key = `${tr.hash}:${tr.wallet}:${tr.side}`; if (seen.has(key)) return; seen.add(key); t.trades.push(tr); };
  for (const c of Object.values(fomo?.publicOnchain?.smartMoney?.candidates || {})) {
    const tr = c.latestTrade; if (!tr?.token || !nameTermsIn(tr.tokenSymbol || '').length) continue;
    push(get(tr.token, 'bsc', tr.tokenSymbol), { wallet: tr.wallet, side: tr.side, amountUsd: tr.amountUsd, at: tr.timestampMs, hash: tr.transactionHash });
  }
  const gmgn = await json(path.join(dataDir, 'gmgn-flow-state.json'));
  const symByToken = new Map([...tokens.values()].map((t) => [assetKey(t.chain, t.address), t.symbol]));
  for (const f of favorites) symByToken.set(assetKey(f.chain, f.address), f.symbol);
  for (const tr of Object.values(gmgn?.trades || {}).flat()) {
    const a = canonAddr(tr?.tokenAddress), sym = tr?.tokenSymbol || tr?.symbol || symByToken.get(assetKey(tr?.chain || 'bsc', a));
    if (!a || !sym || !nameTermsIn(sym).length) continue;
    push(get(a, tr.chain || 'bsc', sym), { wallet: tr.wallet, side: tr.side, amountUsd: tr.amountUsd, at: tr.at, hash: tr.hash });
  }
  for (const f of favorites) get(f.address, f.chain, f.symbol);
  const launch = await json(path.join(dataDir, 'bsc-launchpad-state.json'));
  for (const e of launch?.officialSources?.flap?.creationEventHotIndex || []) {
    const t = tokens.get(assetKey('bsc', e.token)); if (t) t.createdAt = Date.parse(e.observedAt);
  }
  for (const t of tokens.values()) t.trades.sort((a, b) => a.at - b.at);
  return [...tokens.values()];
}

/** Public DexScreener read for price/liquidity marks (paper only). Returns null on any failure. */
export async function fetchDexMark(address, { fetchImpl = fetch, chain = null, minLiquidityUsd = 0 } = {}) {
  try {
    const r = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null; const d = await r.json();
    // Bind the pair to the requested chain AND base token (no cross-chain / wrong-pair marks).
    const want = chain ? [normKolChain(chain) === 'sol' ? 'solana' : normKolChain(chain)] : ['bsc', 'solana'];
    const p = (d.pairs || []).filter((x) => want.includes(x.chainId) && canonAddr(x.baseToken?.address) === canonAddr(address))
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!p || !(Number(p.priceUsd) > 0)) return null; const liq = Number(p.liquidity?.usd);
    if (minLiquidityUsd > 0 && !(liq >= minLiquidityUsd)) return null;
    return { priceUsd: Number(p.priceUsd), liquidityUsd: liq > 0 ? liq : undefined, source: 'dexscreener', at: Date.now() };
  } catch { return null; }
}

// ---- Paper mark chain (paper only, read-only; never an executable quote) ----
// Order: 1) DexScreener (graduated pools)  2) Flap Portal on-chain curve state
// (getTokenV8Safe price/reserve × Chainlink BNB/USD, reuses paper-internal-depth ABI)
// 3) GMGN readonly token-info quote (existing gmgn-readonly-market client, price only)
// 4) last smart-money trade implied price (only if the trade carries priceUsd).
// Liquidity: Dex pool USD, else curve reserve USD; unknown stays undefined so the
// KOL_NEWS_PAPER_ALLOW_UNKNOWN_LIQ gate still decides.
const ORACLE_ABI = new Interface(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const BSC_RPCS = (process.env.KOL_NEWS_BSC_RPC || 'https://bsc-rpc.publicnode.com,https://bsc-dataseed.bnbchain.org').split(',');
let rpcIdx = 0;
const providers = new Map();
const providerFor = (url) => { if (!providers.has(url)) providers.set(url, new JsonRpcProvider(url, 56, { staticNetwork: true })); return providers.get(url); };
function defaultCall() {
  return async (to, data) => {
    let lastErr;
    const start = rpcIdx; // fixed starting point for this call: each endpoint tried exactly once
    for (let i = 0; i < BSC_RPCS.length; i++) {
      const idx = (start + i) % BSC_RPCS.length, url = BSC_RPCS[idx];
      let timer;
      try {
        const out = await Promise.race([providerFor(url).call({ to, data }), new Promise((_, r) => { timer = setTimeout(() => r(new Error('rpc_timeout')), 6000); })]);
        rpcIdx = idx; // stick to the endpoint that worked
        return out;
      } catch (e) {
        lastErr = e;
        if (e?.message === 'rpc_timeout') { try { providerFor(url).destroy(); } catch {} providers.delete(url); }
      } finally { clearTimeout(timer); }
    }
    rpcIdx = (start + 1) % BSC_RPCS.length;
    throw lastErr;
  };
}

// Stablecoin quotes treated as $1 (BSC): USDT, USDC, USD1, FDUSD.
export const FLAP_STABLE_QUOTES = new Map([
  ['0x55d398326f99059ff775485246999027b3197955', 'USDT'],
  ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC'],
  ['0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', 'USD1'],
  ['0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', 'FDUSD'],
]);
const ERC_DEC = new Interface(['function decimals() view returns(uint8)']);


// Any flap quote asset -> USD. Order: native BNB (Chainlink) -> known stable ($1)
// -> PancakeSwap V2 router quote->WBNB x Chainlink -> quote->USDT -> DexScreener quote-token price.
const PCS_V2_ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
const BSC_WBNB_ADDR = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const BSC_USDT_ADDR = '0x55d398326f99059ff775485246999027b3197955';
const ROUTER_ABI = new Interface(['function getAmountsOut(uint256,address[]) view returns(uint256[])']);
const ERC_SYM = new Interface(['function symbol() view returns(string)']);
const quoteUsdCache = new Map(); const QUOTE_TTL_MS = 60_000;
const ORACLE_MAX_AGE_S = 3600;
async function bnbUsd(call, nowMs = Date.now()) {
  const r = ORACLE_ABI.decodeFunctionResult('latestRoundData', await call(BNB_ORACLE, ORACLE_ABI.encodeFunctionData('latestRoundData')));
  // [roundId, answer, startedAt, updatedAt, answeredInRound]: reject stale/incomplete rounds.
  const updatedAt = Number(r[3]);
  if (!(r[1] > 0n) || !(updatedAt > 0) || nowMs / 1000 - updatedAt > ORACLE_MAX_AGE_S || r[4] < r[0]) throw new Error('chainlink_stale');
  const u = Number(formatUnits(r[1], 8));
  if (!(u > 50 && u < 100_000)) throw new Error('chainlink_out_of_range');
  return u;
}
export async function resolveFlapQuoteUsd(quoteAddr, { call = defaultCall(), dexQuote = fetchDexMark, now = Date.now() } = {}) {
  if (!quoteAddr || quoteAddr === ZeroAddress) { let u; try { u = await bnbUsd(call, now); } catch { return null; } return u > 0 ? { quoteUsd: u, quoteSymbol: 'BNB', quoteDecimals: 18, address: ZeroAddress, route: 'chainlink' } : null; }
  const a = String(quoteAddr).toLowerCase();
  const c = quoteUsdCache.get(a); if (c && now - c.at < QUOTE_TTL_MS) return c.v;
  let dec = null, sym = FLAP_STABLE_QUOTES.get(a);
  try { dec = Number(ERC_DEC.decodeFunctionResult('decimals', await call(a, ERC_DEC.encodeFunctionData('decimals')))[0]); } catch {}
  if (dec == null && FLAP_STABLE_QUOTES.has(a)) dec = 18; // BSC-pegged stables are 18 decimals
  // Unknown decimals => unknown price (never assume 18 for an arbitrary token).
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) { quoteUsdCache.set(a, { at: now, v: null }); return null; }
  if (!sym) { try { sym = ERC_SYM.decodeFunctionResult('symbol', await call(a, ERC_SYM.encodeFunctionData('symbol')))[0]; } catch { sym = a.slice(0, 8); } }
  let v = null;
  if (FLAP_STABLE_QUOTES.has(a)) v = { quoteUsd: 1, route: 'stable' };
  else if (a === BSC_WBNB_ADDR) { try { v = { quoteUsd: await bnbUsd(call, now), route: 'chainlink' }; } catch {} }
  else {
    const one = 10n ** BigInt(dec);
    const tryPath = async (path, amt = one) => { try { const out = ROUTER_ABI.decodeFunctionResult('getAmountsOut', await call(PCS_V2_ROUTER, ROUTER_ABI.encodeFunctionData('getAmountsOut', [amt, path])))[0]; return out[out.length - 1]; } catch { return 0n; } };
    // Depth check: 100 units must price within 10% of 1 unit, else the pool is too shallow to trust.
    const deep = async (path, out1) => { const out100 = await tryPath(path, one * 100n); return out100 > 0n && Number(out100) / 100 >= Number(out1) * 0.9; };
    const bscPath = [a, BSC_WBNB_ADDR], usdtPath = [a, BSC_USDT_ADDR];
    const viaBnb = await tryPath(bscPath);
    if (viaBnb > 0n && await deep(bscPath, viaBnb)) { try { v = { quoteUsd: Number(formatUnits(viaBnb, 18)) * await bnbUsd(call, now), route: 'pcs_v2_wbnb' }; } catch {} }
    if (!(v?.quoteUsd > 0)) { const viaUsdt = await tryPath(usdtPath); if (viaUsdt > 0n && await deep(usdtPath, viaUsdt)) v = { quoteUsd: Number(formatUnits(viaUsdt, 18)), route: 'pcs_v2_usdt' }; }
    if (!(v?.quoteUsd > 0)) { try { const d = await dexQuote(a, { chain: 'bsc', minLiquidityUsd: 10_000 }); if (d?.priceUsd > 0) v = { quoteUsd: d.priceUsd, route: 'dexscreener' }; } catch {} }
  }
  const res = v?.quoteUsd > 0 ? { ...v, quoteSymbol: sym, quoteDecimals: dec, address: a } : null;
  quoteUsdCache.set(a, { at: now, v: res });
  return res;
}

/** Flap bonding-curve mark from the pinned Portal. BNB quote via Chainlink; stablecoin quote ≈ $1. */
export async function fetchFlapCurveMark(address, { call = defaultCall() } = {}) {
  try {
    const raw = await call(FLAP_DEPTH_PORTAL, FLAP_DEPTH_ABI.encodeFunctionData('getTokenV8Safe', [address]));
    const st = FLAP_DEPTH_ABI.decodeFunctionResult('getTokenV8Safe', raw)[0];
    if (st[0] !== 1n || st[3] <= 0n) return null; // not a tradable curve
    const quote = String(st[9]).toLowerCase();
    const q = await resolveFlapQuoteUsd(st[9], { call });
    if (!q) return null; // quote asset with no USD route: let GMGN decide
    const { quoteUsd, quoteSymbol, quoteDecimals } = q;
    if (!(quoteUsd > 0)) return null;
    // price is 1e18-scaled quote per token; reserve is raw quote units
    const priceUsd = Number(formatUnits(st[3], 18)) * quoteUsd, liquidityUsd = Number(formatUnits(st[1], quoteDecimals)) * quoteUsd;
    if (!(priceUsd > 0)) return null;
    return { priceUsd, liquidityUsd, source: quoteSymbol === 'BNB' ? 'flap_curve' : `flap_curve_${String(quoteSymbol).toLowerCase()}`, quoteSymbol, quoteAddress: q.address, quoteUsd, quoteRoute: q.route, at: Date.now() };
  } catch { return null; }
}

let gmgnClient;
async function defaultGmgnQuote(chain, address) {
  try {
    gmgnClient ??= (await import('./gmgn-readonly-market.js')).readonlyMarket;
    const q = await gmgnClient.quote({ chain: chain === 'solana' ? 'sol' : chain, address, purpose: 'exit' });
    return q?.status === 'ok' && q.price > 0 ? q.price : null;
  } catch { return null; }
}

/** Unified paper mark: same path for entry and exits. */
export async function fetchKolMark(token, { dex = fetchDexMark, flap = fetchFlapCurveMark, gmgn = defaultGmgnQuote } = {}) {
  const address = token.address, chain = token.chain || 'bsc';
  const d = await dex(address, { chain });
  if (d?.priceUsd > 0) return { ...d, source: d.source || 'dexscreener' };
  if (chain === 'bsc') { const f = await flap(address); if (f) return f; }
  const g = await gmgn(chain, address);
  if (g > 0) return { priceUsd: g, liquidityUsd: undefined, source: 'gmgn', at: Date.now() };
  const last = [...(token.trades || [])].reverse().find((t) => Number(t.priceUsd) > 0);
  if (last) return { priceUsd: Number(last.priceUsd), liquidityUsd: undefined, source: 'last_trade_implied', at: last.at };
  return null;
}
