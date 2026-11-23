// Flap bonding-curve (内盘) READ-ONLY chain reader + trade-tick aggregator for the swing paper runner.
// Only eth_getLogs / eth_call / multicall reads on the public BSC RPC. No signing, no keys, no trade paths, no imports from live modules.
import { Interface, formatUnits, ZeroAddress } from 'ethers';

export const PORTAL = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';            // Flap Portal (BSC), same pin as paper-internal-depth.js
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BNB_ORACLE = '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';             // Chainlink BNB/USD
const ABI = new Interface([
  'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'function getTokenV8Safe(address) view returns((uint8,uint256,uint256,uint256,uint8,uint256,uint256,uint256,uint256,address,bool,bytes32,uint256,uint256,address,uint256,uint8,uint8))',
]);
const MC3 = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)']);
const ERC = new Interface(['function symbol() view returns(string)']);
const ORACLE = new Interface(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const TOPICS = [ABI.getEvent('TokenBought').topicHash, ABI.getEvent('TokenSold').topicHash];
const RPCS = (process.env.SWING_BSC_RPC || 'https://bsc-rpc.publicnode.com,https://bsc-dataseed.bnbchain.org').split(',');
let rpcIdx = 0;
export const flapStats = { rpcCalls: 0, rpcErrors: 0 };

async function rpc(method, params) {
  let last;
  for (let i = 0; i < RPCS.length; i++) {
    const idx = (rpcIdx + i) % RPCS.length;
    try {
      flapStats.rpcCalls++;
      const res = await fetch(RPCS[idx], { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await res.json();
      if (j.error) throw Object.assign(new Error(j.error.message || 'rpc_error'), { rpcCode: j.error.code });
      rpcIdx = idx; return j.result;
    } catch (e) { flapStats.rpcErrors++; last = e; if (/max results|range/i.test(e.message)) throw e; }
  }
  throw last;
}
export const headBlock = async () => parseInt(await rpc('eth_blockNumber', []), 16);
const hex = n => '0x' + n.toString(16);

/** Parse raw Portal logs -> ascending trades. price = BNB per token (postPrice 1e18-scaled); quote/fee in BNB. */
export function parseTrades(logs) {
  const out = [];
  for (const l of logs) {
    let p; try { p = ABI.parseLog(l); } catch { continue; }
    if (!p) continue;
    const price = Number(formatUnits(p.args.postPrice, 18)); if (!(price > 0)) continue;
    out.push({ blk: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), t: Number(p.args.ts) * 1000, side: p.name === 'TokenBought' ? 'b' : 's',
      token: String(p.args.token).toLowerCase(), trader: String(p.args.buyer ?? p.args.seller).toLowerCase(),
      quote: Number(formatUnits(p.args.eth, 18)), fee: Number(formatUnits(p.args.fee, 18)), price });
  }
  return out.sort((a, b) => a.blk - b.blk || a.li - b.li);
}
/** Fetch Portal trades in [from,to], chunked; halves the chunk if the RPC says too many results. */
export async function getTrades(from, to, chunk = 4000) {
  const all = []; let a = from;
  while (a <= to) {
    const b = Math.min(to, a + chunk - 1);
    try { all.push(...parseTrades(await rpc('eth_getLogs', [{ address: PORTAL, fromBlock: hex(a), toBlock: hex(b), topics: [TOPICS] }]))); a = b + 1; }
    catch (e) { if (/max results|range/i.test(e.message) && chunk > 250) chunk = Math.floor(chunk / 2); else throw e; }
  }
  return all;
}
export async function bnbUsd() {
  const r = ORACLE.decodeFunctionResult('latestRoundData', await rpc('eth_call', [{ to: BNB_ORACLE, data: ORACLE.encodeFunctionData('latestRoundData') }, 'latest']));
  const u = Number(formatUnits(r[1], 8)), age = Date.now() / 1000 - Number(r[3]);
  if (!(u > 50 && u < 100_000) || age > 3600) throw new Error('chainlink_stale');
  return u;
}
async function multicall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 60) {
    const chunk = calls.slice(i, i + 60);
    const raw = await rpc('eth_call', [{ to: MULTICALL3, data: MC3.encodeFunctionData('aggregate3', [chunk.map(c => [c.target, true, c.data])]) }, 'latest']);
    out.push(...MC3.decodeFunctionResult('aggregate3', raw)[0]);
  }
  return out;
}
/** Curve state per token via Multicall3 (read-only). Map(token -> {status,reserveBnb,circ,thresh,priceBnb,quoteIsNative,taxBps,version,ext}). */
export async function curveStates(tokens) {
  const m = new Map(); if (!tokens.length) return m;
  const res = await multicall(tokens.map(t => ({ target: PORTAL, data: ABI.encodeFunctionData('getTokenV8Safe', [t]) })));
  res.forEach((r, i) => {
    if (!r.success) return;
    try {
      const s = ABI.decodeFunctionResult('getTokenV8Safe', r.returnData)[0];
      m.set(tokens[i], { status: Number(s[0]), reserveBnb: Number(formatUnits(s[1], 18)), circ: Number(formatUnits(s[2], 18)), priceBnb: Number(formatUnits(s[3], 18)),
        version: Number(s[4]), thresh: Number(formatUnits(s[8], 18)), quoteIsNative: String(s[9]) === ZeroAddress, ext: String(s[11]),
        buyFeeBps: Number(s[12]), sellFeeBps: Number(s[13]), taxBps: Math.max(Number(s[12]), Number(s[13])), at: Date.now() });
    } catch {}
  });
  return m;
}
export async function symbols(tokens) {
  const m = new Map(); if (!tokens.length) return m;
  const res = await multicall(tokens.map(t => ({ target: t, data: ERC.encodeFunctionData('symbol') })));
  res.forEach((r, i) => { if (r.success) { try { m.set(tokens[i], String(ERC.decodeFunctionResult('symbol', r.returnData)[0]).slice(0, 24)); } catch {} } });
  return m;
}

// ---------- trade-tick aggregator (pure) ----------
const BAR = 300e3, WIN1H = 3600e3, KEEP = 8 * 3600e3;
export class CurveBook {
  constructor() { this.tokens = new Map(); }
  /** trades ascending; usdPerBnb applied at ingest time (stored on each bar for later re-basing). */
  ingest(trades, usdPerBnb) {
    for (const x of trades) {
      let tk = this.tokens.get(x.token);
      if (!tk) { tk = { firstT: x.t, lastT: x.t, bars: new Map(), win: [], lastPrice: 0 }; this.tokens.set(x.token, tk); }
      tk.firstT = Math.min(tk.firstT, x.t); tk.lastT = Math.max(tk.lastT, x.t); tk.lastPrice = x.price * usdPerBnb;
      const bt = Math.floor(x.t / BAR) * BAR, px = x.price * usdPerBnb, vol = x.quote * usdPerBnb;
      const b = tk.bars.get(bt);
      if (!b) tk.bars.set(bt, { t: bt, o: px, h: px, l: px, c: px, v: vol, fx: usdPerBnb });
      else { b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.c = px; b.v += vol; }
      tk.win.push({ t: x.t, side: x.side, trader: x.trader, usd: vol });
    }
  }
  prune(now) {
    for (const [a, tk] of this.tokens) {
      if (now - tk.lastT > KEEP) { this.tokens.delete(a); continue; }
      while (tk.win.length && now - tk.win[0].t > WIN1H) tk.win.shift();
      for (const t of tk.bars.keys()) if (now - t > KEEP) tk.bars.delete(t);
    }
  }
  stats(addr, now) {
    const tk = this.tokens.get(addr); if (!tk) return null;
    const w = tk.win.filter(x => now - x.t <= WIN1H), buyers = new Set(w.filter(x => x.side === 'b').map(x => x.trader));
    return { vol1hUsd: w.reduce((a, x) => a + x.usd, 0), buys1h: w.filter(x => x.side === 'b').length, sells1h: w.filter(x => x.side === 's').length, buyers1h: buyers.size,
      ageMin: (now - tk.firstT) / 60e3, lastT: tk.lastT, lastPrice: tk.lastPrice };
  }
  bars(addr) { const tk = this.tokens.get(addr); return tk ? [...tk.bars.values()].sort((a, b) => a.t - b.t) : []; }
  activeCount(now) { let n = 0; for (const tk of this.tokens.values()) if (now - tk.lastT <= WIN1H) n++; return n; }
  size() { return this.tokens.size; }
}
