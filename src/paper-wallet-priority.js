import { gmgnFlowAddress } from './gmgn-flow-signal.js';

export const WALLET_BUY_PRIORITY_VERSION = 'wallet_buy_research_priority_v1';
const stamp = value => typeof value === 'number' ? value : Date.parse(value || '');

// Scheduling only. Providers have already normalized/deduplicated trade legs;
// transfers, sells, stale pages and disconnected coverage cannot become buys.
// Neither a public platform tag nor this hint authorizes a paper fill.
export function walletBuyResearchHint(input, nowMs) {
  const token=input?.token, flow=input?.flow, pulse=flow?.pulse;
  const address=gmgnFlowAddress(token?.chain,token?.address);
  if(input?.memeExitMode!==true || !address || flow?.chain!==token.chain || flow.address!==address
    || !['gmgn','binance_smartmoney','binance_kol'].includes(flow.provider)
    || flow.fresh!==true || flow.complete!==true || flow.coverageGap
    || !Number.isFinite(flow.netBuyUsd) || flow.netBuyUsd<=0) return null;
  const observedAt=stamp(flow.observedAt), at=pulse?.lastBuyAt;
  if(!Number.isFinite(observedAt) || observedAt>nowMs || nowMs-observedAt>120000
    || !Number.isFinite(at) || at>observedAt || at>nowMs || nowMs-at>90000
    || !(pulse.recentBuyerCount>=1) || !(pulse.recentNetBuyUsd>0)) return null;
  const buyers=(flow.wallets||[]).filter(w=>gmgnFlowAddress(token.chain,w.wallet)
    && Number.isFinite(w.netBuyUsd) && w.netBuyUsd>=100 && stamp(w.lastBuyAt)===at);
  if(!buyers.length)return null;
  return {version:WALLET_BUY_PRIORITY_VERSION,researchOnly:true,chain:token.chain,address,
    provider:flow.provider,signalId:`${token.chain}:${address}:${flow.provider}:${at}`,
    buyAt:new Date(at).toISOString(),observedAt:flow.observedAt,ageMs:nowMs-at,
    recentBuyerCount:pulse.recentBuyerCount,recentNetBuyUsd:pulse.recentNetBuyUsd,
    note:'已采集的新买盘优先补证；不等于已验证盈利钱包或批准买入'};
}
