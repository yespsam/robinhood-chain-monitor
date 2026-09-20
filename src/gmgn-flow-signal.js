// Source-reported observations, not trade execution or independently verified transactions.
export const GMGN_FLOW_CHAINS = Object.freeze({
  sol: { slug: 'sol', gmgn: 'sol', name: 'Solana', id: 'solana' },
  bsc: { slug: 'bsc', gmgn: 'bsc', name: 'BNB Chain', id: 56 },
  base: { slug: 'base', gmgn: 'base', name: 'Base', id: 8453 },
  eth: { slug: 'eth', gmgn: 'eth', name: 'Ethereum', id: 1 },
  robinhood: { slug: 'robinhood', gmgn: 'robinhood', name: 'Robinhood Chain', id: 4663 },
});
export const GMGN_HOT_ONLY_CHAINS = Object.freeze(['monad', 'megaeth', 'hyperevm', 'tron']);
export const GMGN_FLOW_DEFAULTS = Object.freeze({ volumeUsd: 30000, volumeMultiple: 3,
  highProfitCount: 5, fomoCount: 3, uniqueBuyerCount: 6, netBuyUsd: 10000,
  minimumWalletBuyUsd: 100, minimumProfit7dUsd: 3000, minimumProfit30dUsd: 10000,
  minimumWinRate: 0.6, minimumRoi: 0.015, minimumTokens7d: 50, minimumTokens30d: 100 });
const MINUTE = 60000;
const blocked = /(?:^|[_-])(?:wash(?:[_-]?trader)?|arbitrager|arbitrage|mev(?:[_-]?bot)?|sandwich|router|cex|exchange|contract)(?:$|[_-])/i;
const numeric = v => ['number','string'].includes(typeof v) && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const iso = n => new Date(n).toISOString();
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const validHash = (chain, hash) => typeof hash==='string' && (chain==='sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(hash) : /^0x[\da-fA-F]{64}$/.test(hash));
export function gmgnFlowAddress(chain, value) {
  const text = String(value || '');
  if (!GMGN_FLOW_CHAINS[chain]) return null;
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) ? text : null;
  return /^0x[\da-fA-F]{40}$/.test(text) && !/^0x0{40}$/i.test(text) ? text.toLowerCase() : null;
}
export function gmgnFlowData(payload) {
  if (payload && Object.hasOwn(payload,'code') && ![0,200].includes(payload.code)) throw new Error('GMGN_UPSTREAM_ERROR');
  return payload?.data ?? payload;
}
export function gmgnFlowTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter(t=>typeof t === 'string').map(t=>t.trim().toLowerCase()))].sort();
}
export function parseGmgnFlowTrades(payload, chain, nowMs = Date.now()) {
  const data = gmgnFlowData(payload);
  if (!Array.isArray(data?.list)) throw new Error('GMGN_TRADE_SCHEMA');
  const trades = new Map();
  for (const row of data.list) {
    const wallet = gmgnFlowAddress(chain,row.maker), tokenAddress = gmgnFlowAddress(chain,row.base_address);
    const amountUsd = numeric(row.amount_usd), at = numeric(row.timestamp);
    const tags = gmgnFlowTags(row.maker_info?.tags);
    const tx = String(row.transaction_hash || '');
    const hashValid = chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(tx) : /^0x[\da-fA-F]{64}$/.test(tx);
    if (!wallet || !tokenAddress || !hashValid || !['buy','sell'].includes(row.side)
      || amountUsd === null || amountUsd <= 0 || !Number.isSafeInteger(at)
      || at*1000 > nowMs + 30000 || at*1000 < nowMs-20*MINUTE
      || (row.chain && row.chain !== chain) || tags.some(t=>blocked.test(t))) continue;
    const hash = chain === 'sol' ? tx : tx.toLowerCase();
    // A duplicated feed record must never multiply wallet count or USD volume.
    const key = `${chain}:${hash}:${wallet}:${tokenAddress}:${row.side}`;
    const prior = trades.get(key);
    if (prior && (prior.amountUsd !== amountUsd || prior.at !== at*1000)) throw new Error('GMGN_TRADE_CONFLICT');
    trades.set(key,{key,chain,wallet,tokenAddress,hash,side:row.side,amountUsd,at:at*1000,
      tags:gmgnFlowTags([...(prior?.tags || []),...tags]),symbol:String(row.base_token?.symbol || '').slice(0,40)});
  }
  return [...trades.values()];
}
export function parseGmgnFlowProfile(payload, chain, wallet, period, checkedAtMs=Date.now()) {
  const address = gmgnFlowAddress(chain,wallet), data = gmgnFlowData(payload);
  const rows = Array.isArray(data) ? data : [data];
  const row = rows.find(r=>gmgnFlowAddress(chain,r?.wallet_address) === address);
  if (!address || !row || !['7d','30d'].includes(period) || (row.chain && row.chain !== chain)) return null;
  const profile = { chain,wallet:address,period,checkedAt:iso(checkedAtMs),
    realizedProfitUsd:numeric(row.realized_profit), realizedRoi:numeric(row.realized_profit_pnl),
    winRate:numeric(row.pnl_stat?.winrate ?? row.winrate),tokenCount:numeric(row.pnl_stat?.token_num),
    buyCount:numeric(row.buy ?? row.buy_count),sellCount:numeric(row.sell ?? row.sell_count),
    tags:gmgnFlowTags(row.common?.tags),createdAt:numeric(row.common?.created_at),
    lastTradeAt:numeric(row.last_timestamp),createdTokenCount:numeric(row.common?.created_token_count) };
  if (Object.values(profile).some(v=>v===null) || profile.winRate<0 || profile.winRate>1
    || ['tokenCount','buyCount','sellCount','createdAt','lastTradeAt','createdTokenCount'].some(k=>!Number.isSafeInteger(profile[k]) || profile[k]<0)) return null;
  return profile;
}
export function qualifiesGmgnFlowWallet(profiles, chain, wallet, nowMs=Date.now()) {
  const d=GMGN_FLOW_DEFAULTS;
  for (const period of ['7d','30d']) {
    const p=profiles?.[period], checked=Date.parse(p?.checkedAt || '');
    if (!p || p.chain!==chain || p.wallet!==wallet || p.period!==period
      || !Number.isFinite(checked) || checked>nowMs+30000 || checked<nowMs-2*3600000
      || !Array.isArray(p.tags) || p.tags.some(t=>blocked.test(t))
      || !Number.isFinite(p.realizedProfitUsd) || p.realizedProfitUsd<(period==='7d'?d.minimumProfit7dUsd:d.minimumProfit30dUsd)
      || !Number.isFinite(p.realizedRoi) || p.realizedRoi<d.minimumRoi
      || !Number.isFinite(p.winRate) || p.winRate<d.minimumWinRate || p.winRate>1
      || !Number.isSafeInteger(p.tokenCount) || p.tokenCount<(period==='7d'?d.minimumTokens7d:d.minimumTokens30d)
      || !Number.isSafeInteger(p.createdAt) || p.createdAt<=0 || p.createdAt*1000>nowMs-30*86400000
      || !Number.isSafeInteger(p.lastTradeAt) || p.lastTradeAt*1000>nowMs+30000 || p.lastTradeAt*1000<nowMs-7*86400000
      || !Number.isSafeInteger(p.createdTokenCount) || p.createdTokenCount>10 || p.createdTokenCount<0) return false;
  }
  return true;
}
export function parseGmgnFlowCandles(payload) {
  const data=gmgnFlowData(payload);
  if (!Array.isArray(data?.list)) throw new Error('GMGN_CANDLE_SCHEMA');
  const candles=new Map();
  for(const row of data.list) {
    const time=numeric(row.time),volumeUsd=numeric(row.volume);
    if (!Number.isSafeInteger(time) || time%MINUTE!==0 || volumeUsd===null || volumeUsd<0) throw new Error('GMGN_CANDLE_INVALID');
    if (candles.has(time) && candles.get(time).volumeUsd!==volumeUsd) throw new Error('GMGN_CANDLE_CONFLICT');
    candles.set(time,{time,volumeUsd});
  }
  return [...candles.values()].sort((a,b)=>a.time-b.time);
}
export function gmgnFlowVolume(candles, nowMs=Date.now()) {
  const end=Math.floor(nowMs/MINUTE)*MINUTE;
  const rows=candles.filter(c=>c.time>=end-20*MINUTE && c.time<end);
  if (rows.length!==20 || rows.some((r,i)=>r.time!==end-(20-i)*MINUTE || !Number.isFinite(r.volumeUsd) || r.volumeUsd<0)) return null;
  const volumeUsd=rows.slice(15).reduce((n,r)=>n+r.volumeUsd,0);
  const baselineVolumeUsd=rows.slice(0,15).reduce((n,r)=>n+r.volumeUsd,0)/3;
  // A zero/missing baseline is not an infinite surge.
  if (!(baselineVolumeUsd>0)) return null;
  return {windowMinutes:5,windowStartAt:iso(end-5*MINUTE),windowEndAt:iso(end),volumeUsd,baselineVolumeUsd,volumeMultiple:volumeUsd/baselineVolumeUsd};
}
export function evaluateGmgnFlowSignal({chain,tokenAddress,candles,trades,profiles,windowEndMs,nowMs=Date.now()}) {
  if(windowEndMs!==undefined && (!Number.isSafeInteger(windowEndMs) || windowEndMs%MINUTE!==0
    || windowEndMs>Math.floor(nowMs/MINUTE)*MINUTE || nowMs-windowEndMs>120000)) return null;
  const ca=gmgnFlowAddress(chain,tokenAddress), volume=gmgnFlowVolume(candles || [],windowEndMs ?? nowMs),d=GMGN_FLOW_DEFAULTS;
  if (!ca || !volume) return null;
  const start=Date.parse(volume.windowStartAt),end=Date.parse(volume.windowEndAt),byWallet=new Map(),seen=new Map();
  for(const t of trades || []) {
    if (t.chain!==chain || t.tokenAddress!==ca || gmgnFlowAddress(chain,t.wallet)!==t.wallet || !validHash(chain,t.hash)
      || !['buy','sell'].includes(t.side) || !Number.isFinite(t.amountUsd) || t.amountUsd<=0
      || !Number.isSafeInteger(t.at) || t.at<start || t.at>=end || !Array.isArray(t.tags) || t.tags.some(x=>blocked.test(x))) continue;
    const key=`${t.hash}:${t.wallet}:${t.side}`;
    if (seen.has(key)) { if (seen.get(key).amountUsd!==t.amountUsd || seen.get(key).at!==t.at) return null; continue; }
    seen.set(key,t);
    const w=byWallet.get(t.wallet)||{wallet:t.wallet,buyUsd:0,sellUsd:0,tags:[],transactions:[]};
    w[t.side==='buy'?'buyUsd':'sellUsd']+=t.amountUsd;
    w.tags=gmgnFlowTags([...w.tags,...t.tags]);w.transactions.push({hash:t.hash,at:iso(t.at),side:t.side,amountUsd:t.amountUsd});byWallet.set(t.wallet,w);
  }
  const buyers=[...byWallet.values()].filter(w=>w.buyUsd-w.sellUsd>=d.minimumWalletBuyUsd
    && !['7d','30d'].some(period=>profiles?.[w.wallet]?.[period]?.tags?.some(t=>blocked.test(t)))).map(w=>({
    ...w,netBuyUsd:w.buyUsd-w.sellUsd,highProfit:qualifiesGmgnFlowWallet(profiles?.[w.wallet],chain,w.wallet,nowMs),
    fomo:w.tags.includes('fomo'),performance:profiles?.[w.wallet] || null,
  })).filter(w=>w.highProfit || w.fomo).sort((a,b)=>b.netBuyUsd-a.netBuyUsd || a.wallet.localeCompare(b.wallet));
  const highProfitCount=buyers.filter(w=>w.highProfit).length,fomoCount=buyers.filter(w=>w.fomo).length;
  const signal={...volume,highProfitCount,fomoCount,uniqueBuyerCount:buyers.length,
    overlapCount:buyers.filter(w=>w.highProfit&&w.fomo).length,netBuyUsd:buyers.reduce((s,w)=>s+w.netBuyUsd,0),thresholds:{...d}};
  if (volume.volumeUsd<d.volumeUsd || volume.volumeMultiple<d.volumeMultiple || highProfitCount<d.highProfitCount
    || fomoCount<d.fomoCount || buyers.length<d.uniqueBuyerCount || signal.netBuyUsd<d.netBuyUsd) return null;
  return {signal,buyers};
}
export function isGmgnFlowEvent(event,{nowMs}={}) {
  try {
    const chain=event?.chain?.slug,ca=gmgnFlowAddress(chain,event?.token?.address),at=Date.parse(event?.observedAt);
    if(event?.type!=='gmgn_flow_surge'||event.platform!=='gmgn'||!ca||!equal(event.chain,GMGN_FLOW_CHAINS[chain])
      ||event.source?.id!=='gmgn_flow_observed'||event.source?.trust!=='provider_reported'
      ||event.source.url!==`https://gmgn.ai/${chain}/token/${ca}`||!Number.isFinite(at)
      ||event.evidence?.version!==1||event.evidence?.provider!=='gmgn-cli'||event.evidence.chain!==chain
      ||event.evidence.tokenAddress!==ca||!Array.isArray(event.evidence.trades)||event.evidence.trades.length>800
      ||!Array.isArray(event.evidence.candles)||event.evidence.candles.length>30) return false;
    if(nowMs!==undefined&&(at>nowMs+30000||nowMs-at>900000))return false;
    const n=event.narrative;
    if(!n || !['sourced','project_claim','unverified'].includes(n.status) || typeof n.text!=='string'
      || !n.text.trim() || n.text.length>220 || n.chain!==chain || n.tokenAddress!==ca) return false;
    if(n.status==='unverified') { if(n.sourceUrl) return false; }
    else {
      const url=new URL(n.sourceUrl),sourceAt=Date.parse(n.sourceAt);
      if(url.protocol!=='https:' || url.username || url.password || url.hash || !Number.isFinite(sourceAt)
        || sourceAt>at+30000 || sourceAt<at-86400000) return false;
      if(n.status==='project_claim' && n.sourceUrl!==event.source.url) return false;
      if(n.status==='sourced' && !(/^https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(n.sourceUrl)
        || ['fomo.family','api.fomoscan.sh','prod-api.fomo.family'].includes(url.hostname))) return false;
    }
    const result=evaluateGmgnFlowSignal({...event.evidence,chain,tokenAddress:ca,nowMs:at});
    return Boolean(result && equal(result.signal,event.signal) && equal(result.buyers,event.buyers)
      && event.eventKey===`gmgn-flow:${chain}:${ca}:${Date.parse(result.signal.windowEndAt)}`
      && event.sourceOccurredAt===result.signal.windowEndAt);
  }catch{return false;}
}
