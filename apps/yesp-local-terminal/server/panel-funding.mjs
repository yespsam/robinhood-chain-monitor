import {formatUnits,parseUnits} from 'ethers';
import {fault,same} from './flap-reader.mjs';
import {ZERO,erc20Abi} from './four-reader.mjs';
import {createPanelChain} from './panel-chain.mjs';
import {NATIVE} from './model.mjs';
import {safeFunding} from '../extension/funding-model.js';
const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',reserve=5000000000000000n;
export function createPanelFunding({reader,cli,clock=Date.now}){
 const chain=createPanelChain(reader.rpc,clock);
 async function shortage(request,w){
  try{await reader.build(request,w);}catch(e){const f=safeFunding(e.details?.funding);if(e.code==='INSUFFICIENT_BALANCE'&&f)return f;throw e;}
  throw fault('FUNDING_NOT_REQUIRED');
 }
 async function quote(trade,decimals,bps){const q=await cli.quoteSwap(trade);let output;
  try{if(parseUnits(q.fromCoinAmount,18)!==parseUnits(trade.amount,18))throw Error();output=parseUnits(q.toCoinAmount,decimals);if(output<=0n)throw Error();}catch{throw fault('SWAP_QUOTE_INVALID');}
  return {expectedRaw:output,minimumRaw:output*(10000n-BigInt(bps))/10000n};
 }
 async function prepare(request,w,settings,initial){
  const m=await reader.inspect(request.tokenAddress),f=safeFunding(initial);if(!f||!same(f.assetAddress,m.quote.address)||same(m.quote.address,ZERO)||same(m.quote.address,WBNB))throw fault('FUNDING_ROUTE_UNAVAILABLE');
  const quantity=settings.mode==='quantity',need=parseUnits(f.shortfall,m.quote.decimals),a=await chain.account(w,m.block);
  if(need<=0n)throw fault('FUNDING_NOT_REQUIRED');if(a.native<=reserve)throw fault('INSUFFICIENT_GAS');
  const cap=quantity?a.native-reserve:parseUnits(settings.maxBnb,18);
  const limit=cap<a.native-reserve?cap:a.native-reserve;
  let amount=limit<1000000000000000n?limit:1000000000000000n,pricing,trade;
  for(let i=0;i<5;i++){
   trade={chainId:'56',fromToken:NATIVE,toToken:m.quote.address,amount:formatUnits(amount,18),slippage:String(Number(settings.slippageBps)/100)};
   pricing=await quote(trade,m.quote.decimals,settings.slippageBps);
   // The first amount is a price probe, not a minimum purchase. Scale it down
   // for a small deficit; otherwise a tiny target could cause excess funding.
   if(i===0&&pricing.minimumRaw>=need){const sized=(amount*need*101n+pricing.minimumRaw*100n-1n)/(pricing.minimumRaw*100n);if(sized<amount){amount=sized;continue;}}
   if(pricing.minimumRaw>=need)break;
   if(pricing.minimumRaw<=0n)throw fault('SWAP_QUOTE_INVALID');
   const next=(amount*need*101n+pricing.minimumRaw*100n-1n)/(pricing.minimumRaw*100n);
   if(next>limit&&amount===limit){if(quantity)throw fault('FUNDING_BALANCE_INSUFFICIENT');throw fault(cap<=a.native-reserve?'FUNDING_BUDGET_EXCEEDED':'INSUFFICIENT_GAS',{budget:{kind:'fund',maxBnb:settings.maxBnb,amount:request.amount,tokenSymbol:m.base.symbol,symbol:m.quote.symbol,needed:f.shortfall,expected:formatUnits(pricing.expectedRaw,m.quote.decimals),minimum:formatUnits(pricing.minimumRaw,m.quote.decimals)}});}amount=next>limit?limit:next;
  }
  if(pricing.minimumRaw<need)throw fault('FUNDING_QUOTE_UNAVAILABLE');
  const identityAddresses=m.protocol==='flap-agent'?[m.agentFactory,m.manager,m.portal,m.probe,m.quote.address]:[m.manager,m.tokenAddress,m.quote.address],identity=await chain.fingerprints(identityAddresses,m.block);
  return {...m,kind:'fund',action:'buy',wallet:w,nonce:a.nonce,amount:request.amount,amountRaw:parseUnits(request.amount,m.base.decimals).toString(),slippageBps:request.slippageBps,
   trade,spend:trade.amount,expected:formatUnits(pricing.expectedRaw,m.quote.decimals),minimum:formatUnits(pricing.minimumRaw,m.quote.decimals),minimumRaw:pricing.minimumRaw.toString(),
   funding:f,fundingSettings:settings,resumeRequest:request,identityAddresses,identity,gasReserve:formatUnits(reserve,18),expiresAt:clock()+60000};
 }
 async function recheck(p){
  const f=await shortage(p.resumeRequest,p.wallet),m=await reader.inspect(p.tokenAddress),a=await chain.account(p.wallet,m.block);
  if(!same(f.assetAddress,p.quote.address)||!same(m.manager,p.manager)||p.protocol!==m.protocol||p.nonce!==a.nonce||m.quote.decimals!==p.quote.decimals||m.base.decimals!==p.base.decimals||JSON.stringify(await chain.fingerprints(p.identityAddresses,m.block))!==JSON.stringify(p.identity))throw fault('PREVIEW_EXPIRED');
  if(p.fundingSettings.mode!=='quantity'&&parseUnits(p.trade.amount,18)>parseUnits(p.fundingSettings.maxBnb,18)||a.native<parseUnits(p.trade.amount,18)+reserve)throw fault('INSUFFICIENT_GAS');
  const q=await quote(p.trade,p.quote.decimals,p.fundingSettings.slippageBps);
  if(q.minimumRaw<BigInt(p.minimumRaw)||q.minimumRaw<parseUnits(f.shortfall,p.quote.decimals))throw fault('PREVIEW_EXPIRED');
 }
 function verifyOrder(row,p,orderId){if(row.orderId!==orderId||row.chain!=='56'||!same(row.fromToken,NATIVE)||!same(row.toToken,p.quote.address)||parseUnits(row.fromTokenQty,18)!==parseUnits(p.trade.amount,18))throw fault('SWAP_ORDER_MISMATCH');}
 function received(p,receipt){const net=(receipt.logs||[]).filter(l=>same(l.address,p.quote.address)).reduce((sum,l)=>{try{const e=erc20Abi.parseLog(l);if(e?.name==='Transfer')return sum+(same(e.args.to,p.wallet)?e.args.value:0n)-(same(e.args.from,p.wallet)?e.args.value:0n);}catch{}return sum;},0n);if(net<=0n)throw fault('FUNDING_SETTLEMENT_MISMATCH');return net;}
 return {prepare,recheck,verifyOrder,received};
}
