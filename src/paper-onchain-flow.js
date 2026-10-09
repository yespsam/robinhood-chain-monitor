import {normalizeInnerTradeWindow} from './bsc-inner-trade-events.js';

// Source-specific adapter. Never fill a portal coverage gap with tagged GMGN
// wallets, and never label ordinary recipients as profitable/smart wallets.
export function buildOnchainTradeFlow({state,token,nowMs}) {
  const base={chain:token?.chain,address:token?.address,provider:'bsc_portal_logs',
    providerLabel:'指定 CA 内盘链上逐笔',scope:'固定 Four V2/Flap、已查询区间、原生 BNB 底池；非全链、非独立控制人证明',
    evidenceScope:'selected_ca_portal_logs',wallets:[],netBuyUsd:null,complete:false,fresh:false,status:'unavailable',coverageGap:true};
  const proof=state?.windows?.find(w=>w.chain===token?.chain&&w.tokenAddress===token?.address);
  const checked=normalizeInnerTradeWindow(proof,nowMs);
  if(!checked.ready)return {...base,sourceIssue:checked.reason||'等待链上逐笔覆盖'};
  const {startAt,endAt}=checked.coverage;
  if(endAt-startAt<90000)return {...base,observedAt:new Date(endAt).toISOString(),sourceIssue:'等待完整 90 秒链上覆盖'};
  const rows=checked.trades.filter(t=>t.at>endAt-90000),wallets=new Map();
  for(const t of rows) {
    const w=wallets.get(t.wallet)||{wallet:t.wallet,buyUsd:0,sellUsd:0,netBuyUsd:0,lastBuyAt:null,lastSellAt:null,tags:[],highProfit:false};
    w[t.side==='buy'?'buyUsd':'sellUsd']+=t.amountUsd;
    w.netBuyUsd=w.buyUsd-w.sellUsd;
    const timeKey=t.side==='buy'?'lastBuyAt':'lastSellAt';
    w[timeKey]=new Date(Math.max(Date.parse(w[timeKey]||'')||0,t.at)).toISOString();
    wallets.set(t.wallet,w);
  }
  return {...base,status:'ok',complete:true,fresh:true,coverageGap:false,sourceIssue:null,
    observedAt:new Date(endAt).toISOString(),windowStartAt:new Date(endAt-90000).toISOString(),windowEndAt:new Date(endAt).toISOString(),
    wallets:[...wallets.values()],netBuyUsd:[...wallets.values()].reduce((n,w)=>n+w.netBuyUsd,0),tradeCount:rows.length,
    amountBasis:'窗口末 BNB/USD 估值的事件成交量，不是钱包实际净支出或完整库存'};
}
