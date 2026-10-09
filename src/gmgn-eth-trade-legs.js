import { ETH_RPC } from './paper-eth-gas.js';
import { gmgnFlowAddress, gmgnFlowTags, mergeGmgnFlowTrade, parseGmgnFlowTrades } from './gmgn-flow-signal.js';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const conflict = () => { throw new Error('GMGN_TRADE_CONFLICT'); };
const close = (a,b) => Number.isFinite(a) && Number.isFinite(b) && a>0 && b>0 && Math.abs(a-b)<=Math.max(a,b)*1e-10;

// A router may split one wallet's swap into several legs. Only aggregate when
// a successful, matching receipt proves the wallet's total token movement.
// USD valuations remain provider-reported, never a fabricated on-chain price.
export function reconcileEthTradeLegs(trades, { receipt, decimals, block }, nowMs) {
  const first=trades[0];
  if (!first || trades.length<2 || trades.length>12 || !Number.isInteger(decimals) || decimals<0 || decimals>36
    || trades.some(t=>t.chain!=='eth'||t.key!==first.key||t.at!==first.at)
    || receipt?.status!=='0x1' || receipt.transactionHash?.toLowerCase()!==first.hash
    || gmgnFlowAddress('eth',receipt.from)!==first.wallet || !/^0x[\da-f]{64}$/i.test(receipt.blockHash||'')
    || block?.hash?.toLowerCase()!==receipt.blockHash.toLowerCase()
    || Number(BigInt(block.timestamp||'0x0'))*1000!==first.at || first.at>nowMs
    || nowMs-first.at>1200000 || !Array.isArray(receipt.logs)) return conflict();
  const legs=new Map();
  for (const t of trades) {
    if (!(t.baseAmount>0&&t.quoteAmount>0)) return conflict();
    const id=`${t.baseAmount}:${t.quoteAmount}`;
    legs.set(id,mergeGmgnFlowTrade(legs.get(id),t));
  }
  if (legs.size<2) return conflict();
  let walletAmount=0; const seen=new Set();
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase()!==first.tokenAddress || log.topics?.[0]!==TRANSFER) continue;
    if (log.removed || log.topics.length!==3 || !log.topics.slice(1).every(t=>/^0x[\da-f]{64}$/i.test(t))
      || !/^0x[\da-f]{64}$/i.test(log.data) || !/^0x[\da-f]+$/i.test(log.logIndex||'')) return conflict();
    if(seen.has(log.logIndex))return conflict();seen.add(log.logIndex);
    const from=`0x${log.topics[1].slice(-40)}`.toLowerCase(),to=`0x${log.topics[2].slice(-40)}`.toLowerCase();
    if(from!==first.wallet&&to!==first.wallet)continue;
    // Re-entrant round trips / refunds need a richer decoder. Do not guess.
    if(from===to || (first.side==='sell'?to===first.wallet:from===first.wallet))return conflict();
    walletAmount+=Number(BigInt(log.data))/10**decimals;
  }
  const parts=[...legs.values()],baseAmount=parts.reduce((n,t)=>n+t.baseAmount,0);
  if(!close(walletAmount,baseAmount))return conflict();
  return {...first,baseAmount,quoteAmount:parts.reduce((n,t)=>n+t.quoteAmount,0),amountUsd:parts.reduce((n,t)=>n+t.amountUsd,0),
    tags:gmgnFlowTags(parts.flatMap(t=>t.tags)),receiptLegs:{version:1,blockHash:receipt.blockHash.toLowerCase(),
      parts:parts.map(t=>({baseAmount:t.baseAmount,quoteAmount:t.quoteAmount,amountUsd:t.amountUsd}))}};
}

export function createEthTradeLegResolver({fetchImpl=fetch,now=Date.now}={}) {
  const cache=new Map(); let budget=0;
  async function rpc(method,params) {
    const r=await fetchImpl(ETH_RPC,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(3000)});
    if(!r.ok)throw new Error('eth_leg_http');const p=await r.json();
    if(p.id!==1||p.error||p.result==null)throw new Error('eth_leg_rpc');return p.result;
  }
  async function evidence(t) {
    const key=`${t.hash}:${t.tokenAddress}`,old=cache.get(key);
    if(old&&now()-old.at<1200000)return old.value;
    if(budget--<=0)return conflict();
    const receipt=await rpc('eth_getTransactionReceipt',[t.hash]);
    const [chain,rawDecimals,block]=await Promise.all([rpc('eth_chainId',[]),rpc('eth_call',[{to:t.tokenAddress,data:'0x313ce567'},receipt.blockNumber]),rpc('eth_getBlockByHash',[receipt.blockHash,false])]);
    if(BigInt(chain)!==1n)return conflict();
    const value={receipt,decimals:Number(BigInt(rawDecimals)),block};
    cache.set(key,{at:now(),value});while(cache.size>128)cache.delete(cache.keys().next().value);
    return value;
  }
  return {
    beginScan:()=>{budget=2;},
    async parse(rows,chain,nowMs,prior=new Map()) {
      if(chain!=='eth')return parseGmgnFlowTrades({list:rows},chain,nowMs);
      const groups=new Map();
      for(const row of rows)for(const t of parseGmgnFlowTrades({list:[row]},chain,nowMs)){
        if(!groups.has(t.key))groups.set(t.key,[]);groups.get(t.key).push(t);
      }
      const result=[];
      for(const [key,parts] of groups){
        try {const parsed=parts.reduce((a,t)=>mergeGmgnFlowTrade(a,t),prior.get(key));result.push(parsed);}
        catch(error){
          if(error.message!=='GMGN_TRADE_CONFLICT')throw error;
          // Include a stored single leg if this poll only contains the other.
          const old=prior.get(key);if(old&&!old.receiptLegs)parts.push(old);
          try{result.push(reconcileEthTradeLegs(parts,await evidence(parts[0]),nowMs));}catch{return conflict();}
        }
      }
      return result;
    },
  };
}
