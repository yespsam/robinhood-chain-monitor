import {validateSlippageBps} from '../extension/slippage-policy.js';
import {isDeepStrictEqual} from 'node:util';
import {readFileSync} from 'node:fs';
import {Interface,formatUnits} from 'ethers';
import {createFlapRpc,decodeProbe,fault,same} from './flap-reader.mjs';
import {FLAP_MARKET,createFlapMarketReader} from './flap-market.mjs';
import {ZERO,tokenAddress} from './four-reader.mjs';
import {createPanelChain,rawAmount,minBig,safeText} from './panel-chain.mjs';
import {createPortalQuoteReader,solveAllocation} from './fast-allocation.mjs';
export const agentAbi=new Interface([...JSON.parse(readFileSync(new URL('./flap-agent-abi.json',import.meta.url),'utf8')),
 'function buyWithQuote(address,uint256,uint256) returns(uint256)','function market() view returns(address)']);
export function createAgentReader({rpc=createFlapRpc({timeoutMs:10000}),clock=Date.now,deployment=FLAP_MARKET}={}){
 const c=createPanelChain(rpc,clock),views=createFlapMarketReader({rpc,clock,deployment});
 const call=(to,n,args=[],b='latest',w=ZERO)=>c.call(to,agentAbi,n,args,b,w);
 async function inspect(input){
  const token=tokenAddress(input),{block,at}=await c.head(),market=(await call(deployment.factory,'marketOfToken',[token],block))[0];
  if(deployment.reviewedFingerprints&&!isDeepStrictEqual(await c.fingerprints([deployment.factory,deployment.portal,deployment.reader],block),deployment.reviewedFingerprints))throw fault('MODE_CODE_CHANGED');
  if(same(market,ZERO))throw fault('NOT_FLAP_AGENT');
  const validated=(await views.inspect({profile:'heyi',marketAddress:market,tokenAddress:token})).market;
  const [detail,probeRow,quote]=await Promise.all([call(deployment.reader,'marketDetail',[market],block),call(deployment.factory,'probeOfMarket',[market],block),c.asset(validated.quote,block)]);
  const d=detail[0],probe=tokenAddress(probeRow[0]);
  if(!same((await call(probe,'market',[],block))[0],market)||!same(d.market,market)||!same(d.predictedToken,token)&&!same(d.token,token)||!same(d.quoteToken,quote.address)||Number(d.quoteDecimals)!==quote.decimals)throw fault('MARKET_BINDING_CHANGED');
  const phase=Number(d.phase),blockers=[];if(phase!==1)blockers.push(phase===3?'FLAP_AGENT_GRADUATED':'FLAP_LAUNCHING');
  if(phase===1&&(!d.quoteBalanceKnown||!d.quoteBackingEnough))blockers.push('FLAP_BACKING_UNVERIFIED');
  return {protocol:'flap-agent',agentFactory:deployment.factory,platform:'Flap',chainId:'56',tokenAddress:token,marketAddress:market,manager:market,portal:deployment.portal,probe,phase,
   name:safeText(validated.name),base:{address:token,decimals:18,symbol:safeText(validated.symbol)},quote,block,snapshotAtMs:at,
   deployedToken:d.token,maxWalletSharesRaw:d.maxWalletShares.toString(),poolRaw:d.poolRaw.toString(),capRaw:d.capRaw.toString(),remainingQuoteRaw:d.remainingRaw.toString(),
   progressBps:d.progressBps.toString(),configHash:d.configHash,agentFeeBps:d.agentFeeBps.toString(),phaseLabel:phase===1?'Agent 虚拟份额内盘':phase===3?'已毕业 · 可领取代币':'毕业处理中',
   positionKind:phase===1?'虚拟份额':'待领取份额',limitType:'持仓上限',supported:!blockers.length,claimSupported:phase===3,blockers};
 }
 async function probe(m,w,n,args=[]){return decodeProbe((await rpc.batch([['eth_call',[{from:w,to:m.probe,data:agentAbi.encodeFunctionData(n,args)},m.block]]]))[0]);}
 async function position(m,w){const v=(await call(deployment.reader,'userPosition',[m.marketAddress,w],m.block,w))[0];
  if(v.shares+v.remainingWalletShares>BigInt(m.maxWalletSharesRaw))throw fault('CHAIN_STATE_INCONSISTENT');return v;}
 async function holdings(m,w){const [v,quote,native]=await Promise.all([position(m,w),c.balance(m.quote.address,w,m.block),c.balance(ZERO,w,m.block)]);
  return {base:formatUnits(v.shares,18),baseRaw:v.shares.toString(),quote:formatUnits(quote,m.quote.decimals),native:formatUnits(native,18),
   buyableTokenAmount:formatUnits(v.remainingWalletShares,18),buyableRaw:v.remainingWalletShares.toString(),claimable:formatUnits(v.claimableRaw,18),claimableRaw:v.claimableRaw.toString(),eligible:v.eligibilityKnown?v.eligible:null,limitType:m.limitType};}
 async function build(p,w){
  const m=await inspect(p.tokenAddress),v=await position(m,w),target=rawAmount(p.amount,18),bps=validateSlippageBps(p.slippageBps),addresses=[deployment.factory,deployment.portal,deployment.reader,m.marketAddress,m.probe,m.quote.address];
  if(p.action!=='claim'&&!m.supported)throw fault(m.blockers[0]);
  let expectedRaw,minimumRaw,inputData,spendRaw=0n,spendAsset=null,value=0n,sellBps=null,amountRaw=target;
  if(p.action==='buy'){
   if(!v.eligibilityKnown||!v.eligible)throw fault('AGENT_ID_REQUIRED');if(target>v.remainingWalletShares)throw fault('BUY_LIMIT_EXCEEDED');
   const q=createPortalQuoteReader({rpc,portal:deployment.portal,market:m.marketAddress,wallet:w});
   const ceiling=BigInt(m.remainingQuoteRaw)*10000n/(10000n-BigInt(m.agentFeeBps))+1n;
   if(ceiling<=1n)throw fault('BUY_LIMIT_EXCEEDED');
   const result=await solveAllocation({quoteBuy:q,blockTag:m.block,snapshotAtMs:m.snapshotAtMs,targetSharesRaw:target,
    initialGrossRaw:minBig(10n**BigInt(m.quote.decimals)/1000n||1n,ceiling),maxGrossRaw:ceiling,availableBalanceRaw:await c.balance(m.quote.address,w,m.block),
    maxCalls:8,maxAgeMs:30000,maxShortfallRaw:minBig(target/1000000000n,1000000000n),now:clock});
   const plan=await probe(m,w,'buyPlanProbe',[result.grossRaw,bps]);
   expectedRaw=result.sharesRaw;minimumRaw=expectedRaw*(10000n-bps)/10000n;
   if(plan.RULES_OK!=='1'||BigInt(plan.BLOCK)!==BigInt(m.block)||BigInt(plan.BUY_SHARES)!==expectedRaw||BigInt(plan.MIN_SHARES)!==minimumRaw||minimumRaw===0n)throw fault('BUY_PLAN_MISMATCH');
   spendRaw=result.grossRaw;spendAsset=m.quote.address;
   inputData=same(m.quote.address,ZERO)?agentAbi.encodeFunctionData('buy',[m.marketAddress,minimumRaw]):agentAbi.encodeFunctionData('buyWithQuote',[m.marketAddress,spendRaw,minimumRaw]);
   value=same(m.quote.address,ZERO)?spendRaw:0n;
  }else if(p.action==='sell'){
   if(target>v.shares||v.shares===0n)throw fault('INSUFFICIENT_BALANCE');
   // The official portal sells basis points of virtual holdings. Round down,
   // display the actual amount, and bind the holdings again before submission.
   sellBps=target===v.shares?10000n:target*10000n/v.shares;if(sellBps===0n)throw fault('FLAP_SELL_MIN_PERCENT');
   amountRaw=v.shares*sellBps/10000n;
   const plan=await probe(m,w,'sellPlanCustomProbe',[sellBps,bps]);expectedRaw=BigInt(plan.OUT_RAW??plan.OUT_WEI);minimumRaw=BigInt(plan.MIN_RAW??plan.MIN_WEI);
   if(BigInt(plan.SHARES)!==amountRaw||BigInt(plan.BLOCK)!==BigInt(m.block)||minimumRaw!==expectedRaw*(10000n-bps)/10000n||minimumRaw<=0n)throw fault('SELL_PLAN_MISMATCH');
   inputData=agentAbi.encodeFunctionData('sellBps',[m.marketAddress,sellBps,minimumRaw]);spendRaw=amountRaw;
  }else if(p.action==='claim'){
   if(!m.claimSupported||same(m.deployedToken,ZERO)||!v.inventoryKnown||!v.inventoryEnough||v.claimableRaw<=0n)throw fault('CLAIM_UNAVAILABLE');
   const plan=await probe(m,w,'claimableProbe');if(plan.STATE!=='READY'||BigInt(plan.CLAIM_RAW)!==v.claimableRaw)throw fault('CLAIM_STATE_REVIEW_REQUIRED');
   expectedRaw=minimumRaw=amountRaw=v.claimableRaw;inputData=agentAbi.encodeFunctionData('claim',[m.marketAddress]);addresses.push(m.deployedToken);
  }else throw fault('INVALID_REQUEST');
  return c.finalize(m,p,w,{to:deployment.portal,inputData,value,amountRaw:amountRaw.toString(),requestedAmountRaw:target.toString(),expectedRaw,minimumRaw,spendRaw,spendAsset,sellBps,
   heldSharesRaw:v.shares.toString(),actualTokenAmount:formatUnits(amountRaw,18)},addresses);
 }
 async function recheck(p){const m=await inspect(p.tokenAddress),v=await position(m,p.wallet);
  if(p.configHash!==m.configHash||!same(p.probe,m.probe)||p.heldSharesRaw!==v.shares.toString())throw fault('PREVIEW_EXPIRED');
  if(p.action==='buy'&&(!v.eligibilityKnown||!v.eligible||BigInt(p.requestedAmountRaw)>v.remainingWalletShares))throw fault('BUY_LIMIT_EXCEEDED');
  if(p.action==='claim'&&(!v.inventoryKnown||!v.inventoryEnough||v.claimableRaw!==BigInt(p.amountRaw)))throw fault('CLAIM_UNAVAILABLE');
  await c.recheckCommon(p,m);
 }
 return {rpc,inspect,holdings,build,recheck};
}
