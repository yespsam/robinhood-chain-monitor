import {validateSlippageBps} from '../extension/slippage-policy.js';
import {Interface,formatUnits} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {ZERO,tokenAddress} from './four-reader.mjs';
import {createPanelChain,rawAmount,minBig} from './panel-chain.mjs';
import {solveAllocation} from './fast-allocation.mjs';
// docs.flap.sh: BNB Portal v5.23.1; getTokenV8Safe preserves new enum values.
export const FLAP_PORTAL='0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
export const flapStandardAbi=new Interface([
 'error TokenNotFound(address token)',
 'function getTokenV8Safe(address) view returns((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId))',
 'function maxBuyPerOrigin(address) view returns(uint16 bps,uint256 maxBuyAmount)',
 'function buyQuotaOf(address,address) view returns(uint256 bought,uint256 remaining)',
 'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount)) returns(uint256)',
 'function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData)) payable returns(uint256)',
 'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
 'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)']);
export function createStandardFlapReader({rpc=createFlapRpc({timeoutMs:10000}),clock=Date.now}={}){
 const c=createPanelChain(rpc,clock),call=(n,args,b,w=ZERO)=>c.call(FLAP_PORTAL,flapStandardAbi,n,args,b,w);
 async function inspect(input){
  const token=tokenAddress(input),{block,at}=await c.head();let s;
  try{s=(await call('getTokenV8Safe',[token],block))[0];}catch(e){
   if(e.code==='RPC_CALL_FAILED'&&same(e.rpcError?.data,flapStandardAbi.encodeErrorResult('TokenNotFound',[token])))throw fault('NOT_FLAP_TOKEN');throw e;}
  if(s.status===0n)throw fault('NOT_FLAP_TOKEN');
  // Staged addresses do not yet implement ERC20.
  if(s.status===5n)throw fault('FLAP_STAGED_TOKEN');
  const [base,quote,quota]=await Promise.all([c.asset(token,block),c.asset(s.quoteTokenAddress,block),call('maxBuyPerOrigin',[token],block)]);
  const phase=Number(s.status),blockers=[];if(phase!==1)blockers.push(phase===4?'FLAP_DEX_ROUTE_REQUIRED':'FLAP_NOT_TRADABLE');
  if(s.buyTaxRate>=10000n||s.sellTaxRate>=10000n)blockers.push('FLAP_TAX_UNSUPPORTED');
  const remaining=s.dexSupplyThresh>s.circulatingSupply?s.dexSupplyThresh-s.circulatingSupply:0n;
  return {platform:'Flap',protocol:'flap-standard',chainId:'56',tokenAddress:token,manager:FLAP_PORTAL,base,quote,phase,block,snapshotAtMs:at,
   phaseLabel:phase===1?'Flap 普通内盘':phase===4?'已迁移到 DEX':'当前不可交易',positionKind:'代币余额',limitType:quota.maxBuyAmount>0n?'累计买入限额（卖出不恢复）':'内盘剩余供应量',
   maxBuyRaw:quota.maxBuyAmount.toString(),remainingRaw:remaining.toString(),reserveRaw:s.reserve.toString(),curveRRaw:s.r.toString(),priceRaw:s.price.toString(),pool:s.pool,
   buyTaxBps:s.buyTaxRate.toString(),sellTaxBps:s.sellTaxRate.toString(),extensionID:s.extensionID,progressRaw:s.progress.toString(),supported:!blockers.length,blockers};
 }
 async function holdings(m,w){const [base,quote,native,quota]=await Promise.all([c.balance(m.tokenAddress,w,m.block),c.balance(m.quote.address,w,m.block),c.balance(ZERO,w,m.block),call('buyQuotaOf',[m.tokenAddress,w],m.block,w)]);
  const remaining=minBig(quota.remaining,BigInt(m.remainingRaw));return {base:formatUnits(base,m.base.decimals),baseRaw:base.toString(),quote:formatUnits(quote,m.quote.decimals),native:formatUnits(native,18),
   buyableRaw:remaining.toString(),buyableTokenAmount:formatUnits(remaining,m.base.decimals),cumulativeBought:formatUnits(quota.bought,m.base.decimals),limitType:m.limitType};}
 async function quote(m,w,buy,raw){return (await call('quoteExactInput',[[buy?m.quote.address:m.tokenAddress,buy?m.tokenAddress:m.quote.address,raw]],m.block,w))[0];}
 async function build(p,w){const m=await inspect(p.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);
  if(!['buy','sell'].includes(p.action))throw fault('INVALID_REQUEST');const buy=p.action==='buy',target=rawAmount(p.amount,m.base.decimals),h=await holdings(m,w),bps=validateSlippageBps(p.slippageBps);
  let input=target,expected;
  if(buy){if(target>BigInt(h.buyableRaw))throw fault('BUY_LIMIT_EXCEEDED');
   const maxGross=(BigInt(m.reserveRaw)+BigInt(m.curveRRaw)+10n**BigInt(m.quote.decimals))*1000n;
   let hint=target*BigInt(m.priceRaw)/10n**BigInt(m.base.decimals);hint=hint>0n?hint:1n;
   const solved=await solveAllocation({quoteBuy:async(n)=>({acceptedGrossRaw:n,refundRaw:0n,feeRaw:0n,sharesRaw:await quote(m,w,true,n),blockTag:m.block}),blockTag:m.block,snapshotAtMs:m.snapshotAtMs,
    targetSharesRaw:target,initialGrossRaw:minBig(hint,maxGross),maxGrossRaw:maxGross,availableBalanceRaw:await c.balance(m.quote.address,w,m.block),maxCalls:8,maxAgeMs:30000,
    maxShortfallRaw:minBig(target/1000000000n,10n**BigInt(Math.max(0,m.base.decimals-9))),now:clock});input=solved.grossRaw;expected=solved.sharesRaw;
  }else{if(target>BigInt(h.baseRaw))throw fault('INSUFFICIENT_BALANCE');expected=await quote(m,w,false,target);}
  const minimum=expected*(10000n-bps)/10000n;if(minimum<=0n)throw fault('QUOTE_UNAVAILABLE');
  const spendAsset=buy?m.quote.address:m.tokenAddress,inputData=flapStandardAbi.encodeFunctionData('swapExactInput',[[spendAsset,buy?m.tokenAddress:m.quote.address,input,minimum,'0x']]);
  return c.finalize(m,p,w,{to:FLAP_PORTAL,inputData,value:same(spendAsset,ZERO)?input:0n,spendAsset,spendRaw:input,amountRaw:target.toString(),
   expectedRaw:expected,minimumRaw:minimum,actualTokenAmount:formatUnits(buy?expected:target,m.base.decimals)},[FLAP_PORTAL,m.tokenAddress,m.quote.address]);
 }
 async function recheck(p){const m=await inspect(p.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);
  if(p.buyTaxBps!==m.buyTaxBps||p.sellTaxBps!==m.sellTaxBps||p.extensionID!==m.extensionID)throw fault('PREVIEW_EXPIRED');
  if(p.action==='buy'){const h=await holdings(m,p.wallet);if(BigInt(p.amountRaw)>BigInt(h.buyableRaw))throw fault('BUY_LIMIT_EXCEEDED');}
  await c.recheckCommon(p,m);
 }
 return {rpc,inspect,holdings,build,recheck};
}
