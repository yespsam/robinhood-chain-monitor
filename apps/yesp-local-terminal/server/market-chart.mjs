import {formatUnits,toBeHex,zeroPadValue} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {createPanelRouter} from './panel-router.mjs';
import {agentAbi} from './flap-agent-reader.mjs';
import {FLAP_PORTAL,flapStandardAbi} from './flap-standard-reader.mjs';
import {coreAbi} from './openfour-abi.mjs';
import {OPENFOUR} from './openfour-reader.mjs';
import {tokenAddress,hex} from './four-reader.mjs';
import {gangAbi} from './gang-reader.mjs';

const HASH=/^0x[\da-f]{64}$/i,QUANTITY=/^0x[\da-f]+$/i;
export const CHART_INTERVALS=new Set([60,300,900,3600]);
export function validateChartRequest(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['tokenAddress','interval','older'].includes(k))||!CHART_INTERVALS.has(p.interval)||p.older!==undefined&&typeof p.older!=='boolean')throw fault('INVALID_REQUEST');
 return {...p,tokenAddress:tokenAddress(p.tokenAddress)};
}
export function chartMarket(m){
 const market=m.agentMarket||(m.protocol==='dex-swap'?{...m,protocol:m.originProtocol,quote:m.originQuote}:m);
 if(market.protocol==='flap-standard'&&same(market.manager,FLAP_PORTAL))return market;
 if(market.protocol!=='gang-curve'&&market.protocol!=='flap-agent'&&!(market.protocol==='openfour-agent'&&(market.presetId===OPENFOUR.presetId||market.adapter==='openfour-agent-v1'&&same(market.manager,OPENFOUR.core)&&/^\d+$/.test(market.presetId))))throw fault('CHART_UNSUPPORTED_MODE');
 return market;
}
export function tradeFilter(m){
 if(m.protocol==='flap-standard')return {address:FLAP_PORTAL,topics:[[flapStandardAbi.getEvent('TokenBought').topicHash,flapStandardAbi.getEvent('TokenSold').topicHash]]};
 if(m.protocol==='gang-curve'){const abi=gangAbi(m);return {address:m.manager,topics:[[abi.getEvent('Buy').topicHash,abi.getEvent('Sell').topicHash],zeroPadValue(m.tokenAddress,32)]};}
 return m.protocol==='flap-agent'?{address:m.marketAddress,topics:[agentAbi.getEvent('VirtualTrade').topicHash]}:
 {address:OPENFOUR.core,topics:[coreAbi.getEvent('TradeExecuted').topicHash,zeroPadValue(m.tokenAddress,32),null,zeroPadValue(toBeHex(BigInt(m.presetId)),32)]};
}
export function decodeChartTrade(log,m){
 const filter=tradeFilter(m);
 if(log.removed||!same(log.address,filter.address)||!(Array.isArray(filter.topics[0])?filter.topics[0].some(t=>same(log.topics?.[0],t)):same(log.topics?.[0],filter.topics[0])))return null;
 if(!HASH.test(log.blockHash||'')||!HASH.test(log.transactionHash||'')||!QUANTITY.test(log.blockNumber||'')||!QUANTITY.test(log.logIndex||''))throw fault('CHART_LOG_INVALID');
 let baseRaw,quoteRaw,buy;
 if(m.protocol==='flap-standard'){
  // Portal events have no indexed CA. Filter the decoded token explicitly so
  // trades from other Flap markets never enter this chart.
  const e=flapStandardAbi.parseLog(log);if(!same(e.args.token,m.tokenAddress))return null;
  buy=e.name==='TokenBought';baseRaw=e.args.amount;
  quoteRaw=buy?e.args.eth+e.args.fee:e.args.eth;
 }else if(m.protocol==='gang-curve'){
  const e=gangAbi(m).parseLog(log);if(!same(e.args.token,m.tokenAddress))return null;buy=e.name==='Buy';const a=e.args,soft=m.variant==='soft';
  baseRaw=buy?a.tokensOut:a.tokensIn;quoteRaw=buy?(soft?a.bnbIn+a.fee:m.variant==='v3'?a.quoteIn+a.protocolFee+a.tax:a.quoteIn+a.taxDividend+a.taxPlatform):(soft?a.bnbOut:a.quoteOut);
 }else if(m.protocol==='flap-agent'){
  const e=agentAbi.decodeEventLog('VirtualTrade',log.data,log.topics);if(e.side!==0n&&e.side!==1n)throw fault('CHART_LOG_INVALID');baseRaw=e.shares;quoteRaw=e.quoteUser;buy=e.side===0n;
 }else{
  const e=coreAbi.decodeEventLog('TradeExecuted',log.data,log.topics);
  if(!same(e.token,m.tokenAddress)||e.presetId.toString()!==m.presetId)return null;
  if(!same(e.quoteAsset,m.quoteAsset)||!same(e.vault,m.runtime.vault))throw fault('CHART_MARKET_CHANGED');
  baseRaw=e.tokenAmount;quoteRaw=e.traderQuoteAmount;buy=e.isBuy;
 }
 if(baseRaw<=0n||quoteRaw<=0n)throw fault('CHART_LOG_INVALID');
 // Floating point is confined to display data. It never enters a trade quote.
 const volume=Number(formatUnits(baseRaw,m.base.decimals)),quoteVolume=Number(formatUnits(quoteRaw,m.quote.decimals)),price=quoteVolume/volume;
 if(![price,volume,quoteVolume].every(n=>Number.isFinite(n)&&n>0))throw fault('CHART_PRICE_INVALID');
 return {id:`${log.blockHash}:${log.transactionHash}:${log.logIndex}`,blockHash:log.blockHash,block:Number(BigInt(log.blockNumber)),index:Number(BigInt(log.logIndex)),txHash:log.transactionHash,price,volume,quoteVolume,buy};
}
export function aggregateCandles(trades,interval){
 if(!CHART_INTERVALS.has(interval))throw fault('INVALID_REQUEST');
 const buckets=new Map(),ordered=[...new Map(trades.map(t=>[t.id,t])).values()].sort((a,b)=>a.block-b.block||a.index-b.index);
 for(const t of ordered){
  if(!Number.isSafeInteger(t.time)||t.time<=0||![t.price,t.volume,t.quoteVolume].every(n=>Number.isFinite(n)&&n>0))throw fault('CHART_PRICE_INVALID');
  const time=Math.floor(t.time/interval)*interval,c=buckets.get(time);
  if(c){c.high=Math.max(c.high,t.price);c.low=Math.min(c.low,t.price);c.close=t.price;c.volume+=t.volume;c.quoteVolume+=t.quoteVolume;c.trades++;}
  else buckets.set(time,{time,open:t.price,high:t.price,low:t.price,close:t.price,volume:t.volume,quoteVolume:t.quoteVolume,trades:1});
 }
 return [...buckets.values()].sort((a,b)=>a.time-b.time);
}
export function createMarketCharts({rpc=createFlapRpc({url:process.env.YESP_SCAN_RPC_URL||'https://bsc-rpc.publicnode.com',timeoutMs:15000}),
 resolveMarket,clock=Date.now,windowBlocks=6000,maxHistoryBlocks=96000}={}){
 resolveMarket??=createPanelRouter().inspect;
 const entries=new Map(),headers=new Map();
 async function getHeader(block,hash){
  if(hash&&headers.has(hash))return headers.get(hash);
  const h=await rpc('eth_getBlockByNumber',[hex(block),false]);
  if(!h||!QUANTITY.test(h.number||'')||BigInt(h.number)!==BigInt(block)||!HASH.test(h.hash||'')||hash&&!same(hash,h.hash)||!QUANTITY.test(h.timestamp||''))throw fault('CHART_REORG');
  const value={block,time:Number(BigInt(h.timestamp)),hash:h.hash};headers.set(h.hash,value);
  while(headers.size>12000)headers.delete(headers.keys().next().value);return value;
 }
 async function readRange(m,from,to){
  const logs=await rpc('eth_getLogs',[{...tradeFilter(m),fromBlock:hex(from),toBlock:hex(to)}]);
  if(!Array.isArray(logs)||logs.length>5000)throw fault('CHART_LOG_LIMIT');
  const trades=logs.map(log=>decodeChartTrade(log,m)).filter(Boolean);
  if(trades.some(t=>t.block<from||t.block>to))throw fault('CHART_LOG_INVALID');
  const unique=[...new Map(trades.map(t=>[t.blockHash,{block:t.block,hash:t.blockHash}])).values()].filter(h=>!headers.has(h.hash));
  for(let i=0;i<unique.length;i+=40){
   const group=unique.slice(i,i+40),calls=group.map(h=>['eth_getBlockByNumber',[hex(h.block),false]]);
   const rows=rpc.batch?await rpc.batch(calls):await Promise.all(calls.map(async([method,params])=>({result:await rpc(method,params)})));
   for(let j=0;j<group.length;j++){const h=rows[j]?.result,ref=group[j];
    if(!h||!same(h.hash,ref.hash)||!QUANTITY.test(h.number||'')||BigInt(h.number)!==BigInt(ref.block)||!QUANTITY.test(h.timestamp||''))throw fault('CHART_REORG');
    headers.set(ref.hash,{block:ref.block,time:Number(BigInt(h.timestamp)),hash:h.hash});
   }
  }
  while(headers.size>12000)headers.delete(headers.keys().next().value);
  return trades.map(t=>({...t,time:headers.get(t.blockHash).time}));
 }
 async function update(e,older){
  if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
  const head=Number(BigInt(await rpc('eth_blockNumber',[])));if(!Number.isSafeInteger(head)||head<0)throw fault('CHART_HEAD_INVALID');
  const latest=await getHeader(head);if(clock()-latest.time*1000>30000||latest.time*1000-clock()>5000)throw fault('STALE_BLOCK');
  if(!e.market||clock()-e.marketAt>60000){const m=chartMarket(await resolveMarket(e.ca));
   const identity=JSON.stringify([m.protocol,m.presetId,m.marketAddress,m.tokenAddress,m.base.decimals,m.quote.address,m.quote.decimals,m.runtime?.vault]);
   if(e.identity&&e.identity!==identity)throw fault('CHART_MARKET_CHANGED');e.market=m;e.identity=identity;e.marketAt=clock();}
  const creation=Number(e.market.runtime?.createBlock||0),floor=Math.max(0,head-maxHistoryBlocks,creation);
  if(!Number.isSafeInteger(creation)||creation>head)throw fault('CHART_MARKET_NOT_READY');
  const window=e.market.protocol==='flap-standard'?Math.min(windowBlocks,1200):windowBlocks;
  let from=e.from===null?Math.max(floor,head-window+1):Math.max(floor,Math.min(e.from,head));
  if(older)from=Math.max(floor,from-window);
  const tailStart=e.to===null?from:Math.max(from,Math.min(e.to,head)-12);
  const ranges=[[tailStart,head]];if(e.from!==null&&from<e.from)ranges.push([from,Math.min(e.from-1,tailStart-1)]);
  let incoming=[];
  // Standard Portal events cover every token. Keep each response bounded;
  // only the selected CA's trades and block headers enter the cache.
  const chunk=e.market.protocol==='flap-standard'?Math.min(200,windowBlocks):windowBlocks;
  for(const [start,end]of ranges){for(let b=start;b<=end;b+=chunk)incoming.push(...await readRange(e.market,b,Math.min(end,b+chunk-1)));}
  const retained=e.trades.filter(t=>t.block>=from&&t.block<=head&&!ranges.some(([a,b])=>t.block>=a&&t.block<=b));
  const merged=[...new Map([...retained,...incoming].map(t=>[t.id,t])).values()];if(merged.length>15000)throw fault('CHART_LOG_LIMIT');
  const first=await getHeader(from);
  e.trades=merged;e.from=from;e.to=head;e.fromTime=first.time;e.toTime=latest.time;e.hasOlder=from>floor;e.updatedAt=clock();
 }
 async function query(params){
  const p=validateChartRequest(params),key=p.tokenAddress.toLowerCase();let e=entries.get(key);
  if(!e){if(entries.size>=8){const old=[...entries].find(([,v])=>!v.pending);if(!old)throw fault('CHART_BUSY');entries.delete(old[0]);}
   e={ca:p.tokenAddress,market:null,marketAt:0,updatedAt:0,from:null,to:null,trades:[],pending:null};entries.set(key,e);}
  if(e.pending)await e.pending;
  if(p.older||!e.updatedAt||clock()-e.updatedAt>=4000){e.pending=update(e,p.older).finally(()=>{e.pending=null;});await e.pending;}
  const m=e.market,candles=aggregateCandles(e.trades,p.interval).map(c=>({...c,partial:c.time<e.fromTime||c.time+p.interval>e.toTime}));
  return {chart:{tokenAddress:e.ca,protocol:m.protocol,baseSymbol:m.base.symbol,quoteSymbol:m.quote.symbol,interval:p.interval,
   priceBasis:'user-execution',fromBlock:e.from,toBlock:e.to,fromTime:e.fromTime,toTime:e.toTime,updatedAt:e.updatedAt,hasOlder:e.hasOlder,
   tradeCount:e.trades.length,candles:candles.slice(-1600),truncated:candles.length>1600}};
 }
 return {query};
}
