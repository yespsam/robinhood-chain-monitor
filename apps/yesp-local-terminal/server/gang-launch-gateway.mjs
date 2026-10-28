import {Interface,parseUnits,formatUnits} from 'ethers';
import {fault,same} from './flap-reader.mjs';
import {ZERO} from './four-reader.mjs';
import {NATIVE} from './model.mjs';
import {createPanelChain} from './panel-chain.mjs';
import {gangMath,gangAbi,WBNB} from './gang-reader.mjs';
const supplyAbi=new Interface(['function totalSupply() view returns(uint256)']);
const native=a=>same(a,ZERO)||same(a,WBNB);
const terminal=new Set(['COMPLETE','FAILED','REJECTED','CANCELLED']);
export function createGangLaunchGateway({trader,reader,cli}){
 const chain=createPanelChain(reader.rpc);
 async function wallet(){const s=await trader.handle('panelStatus',{profile:'unified'});if(s.operation&&!terminal.has(s.operation.status))throw fault('UNRESOLVED_TRADE_EXISTS');return s.wallet;}
 async function toBnb(quote,n,slippage){if(n<=0n)throw fault('QUOTE_UNAVAILABLE');if(native(quote.address))return n;
  const amount=formatUnits(n,quote.decimals),q=await cli.quoteSwap({chainId:'56',fromToken:quote.address,toToken:NATIVE,amount,slippage:String(Number(slippage)/100)});try{if(parseUnits(q.fromCoinAmount,quote.decimals)!==n)throw Error();const value=parseUnits(q.toCoinAmount,18);if(value<=0n||value>=1n<<256n)throw Error();return value;}catch{throw fault('SWAP_QUOTE_INVALID');}
 }
 async function entry(row,config,w,targetAmount){const s=await wallet();if(!s.connected||!same(s.address,w))throw fault('WALLET_CHANGED');const m=await reader.inspect(row.tokenAddress);
  if(m.protocol!=='gang-curve'||m.phase!==1||!m.supported||!same(m.manager,row.manager))throw fault('GANG_NEW_ROUTE_CHANGED');
  const [[supply],h]=await Promise.all([chain.call(m.tokenAddress,supplyAbi,'totalSupply',[],m.block),reader.holdings(m,w)]),amount=targetAmount===undefined?supply/100n:parseUnits(targetAmount,m.base.decimals);
  if(supply<=0n||amount<=1n||m.agentGate&&!h.eligible)throw fault('GANG_AGENT_ID_REQUIRED');if(amount>BigInt(h.buyableRaw))throw fault('BUY_LIMIT_EXCEEDED');
  const math=gangMath(m),input=math.grossFor(math.netFor(amount)),quoted=m.variant==='soft'?(await chain.call(m.manager,gangAbi(m),'quoteBuy',[m.tokenAddress,w,input],m.block)).tokensOut:math.buyOut(input-math.fee(input)),room=BigInt(h.buyableRaw),expected=quoted<room?quoted:room;
  if(expected<amount)throw fault('QUOTE_UNAVAILABLE');const cost=await toBnb(m.quote,input,config.swapSlippageBps);
  return {symbol:m.base.symbol,decimals:m.base.decimals,supplyRaw:supply.toString(),amountRaw:amount.toString(),expectedRaw:expected.toString(),quoteSpendRaw:input.toString(),quote:m.quote,costRaw:cost.toString(),baselineRaw:h.baseRaw,simNetQuoteRaw:(input-math.fee(input)).toString()};
 }
 async function inventory(p,m){const h=await reader.holdings(m,p.wallet);if(p.mode==='live'&&BigInt(h.baseRaw)<BigInt(p.baselineRaw)+BigInt(p.acquiredRaw))throw fault('GANG_POSITION_CHANGED');return h;}
 async function exitQuote(p){let m=await reader.inspect(p.tokenAddress);if(m.platform!=='Gang'||m.protocol!=='dex-swap'&&!same(m.manager,p.manager))throw fault('GANG_NEW_ROUTE_CHANGED');await inventory(p,m);
  const amount=BigInt(p.halfRaw);let net;
  if(m.protocol==='dex-swap'){const q=await cli.quoteSwap({chainId:'56',fromToken:p.tokenAddress,toToken:NATIVE,amount:formatUnits(amount,p.decimals),slippage:String(Number(p.config.slippageBps)/100)});try{if(parseUnits(q.fromCoinAmount,p.decimals)!==amount)throw Error();net=parseUnits(q.toCoinAmount,18);}catch{throw fault('SWAP_QUOTE_INVALID');}}
  else{if(!m.supported)throw fault('GANG_NEW_ROUTE_CHANGED');
   // A simulated buy never changed the real pool. Apply its virtual inventory
   // to the current curve invariant, rather than adding its historical input
   // to an unrelated later reserve (which can produce an impossible curve).
   if(p.mode==='simulate'){const virtual=BigInt(p.acquiredRaw),added=gangMath(m).netFor(virtual);m={...m,soldRaw:(BigInt(m.soldRaw)+virtual).toString(),reserveRaw:(BigInt(m.reserveRaw)+added).toString()};}
   const out=m.variant==='soft'&&p.mode==='live'?(await chain.call(m.manager,gangAbi(m),'quoteSell',[m.tokenAddress,amount],m.block)).net:gangMath(m).sell(amount);net=await toBnb(m.quote,out,p.config.swapSlippageBps);
  }if(net<=0n)throw fault('QUOTE_UNAVAILABLE');return {netBnbRaw:net.toString()};
 }
 async function buyResult(p,op){const step=op?.steps?.find(s=>s.action==='panelBuy'&&s.status==='CONFIRMED');if(step){if(!same(op.wallet,p.wallet)||!same(op.market,p.tokenAddress)||step.plan.amountRaw!==p.amountRaw||!same(step.plan.manager,p.manager)||!step.strategyCostRaw)throw fault('GANG_RESULT_MISMATCH');
   const acquired=parseUnits(op.receivedAmount||op.lastReceivedAmount, p.decimals),planned=BigInt(step.plan.spendRaw),spent=BigInt(op.spentRaw||planned);if(acquired<=0n||spent<=0n||spent>planned)throw fault('GANG_RESULT_MISMATCH');
   let cost=(BigInt(step.strategyCostRaw)*spent+planned-1n)/planned;
   const fund=op.steps.find(s=>s.action==='panelFund'&&s.status==='CONFIRMED');
   if(fund){const held=parseUnits(fund.plan.funding.available,fund.plan.quote.decimals),oldUsed=held<spent?held:spent,fundedUsed=spent-oldUsed,received=BigInt(fund.actualQuoteRaw||0),paid=BigInt(fund.actualNativeInputRaw||0);
    if(received<=0n||paid<=0n||fundedUsed>received||!same(fund.plan.quote.address,step.plan.quote.address))throw fault('GANG_RESULT_MISMATCH');
    // Newly swapped funds use their verified actual BNB/quote fill ratio.
    // Only pre-existing quote holdings require a current BNB valuation.
    cost=(BigInt(step.strategyCostRaw)*oldUsed+planned-1n)/planned+(paid*fundedUsed+received-1n)/received;
   }
   return {status:'COMPLETE',acquiredRaw:acquired.toString(),costRaw:cost.toString(),txHash:step.txHash};}
  return {status:op?.status||'UNKNOWN',pending:!op||!terminal.has(op.status),code:op?.error?.code};
 }
 function sellResult(p,op){const step=op?.steps?.find(s=>s.action==='panelSell'&&s.status==='CONFIRMED');if(step&&(!same(op.wallet,p.wallet)||!same(op.market,p.tokenAddress)||step.plan.amountRaw!==p.halfRaw))throw fault('GANG_RESULT_MISMATCH');const partialSale=step?.plan.protocol==='dex-swap'&&op?.partial;return {status:op?.partial&&!partialSale?'PARTIAL_CONVERSION':op?.status||'UNKNOWN',halfSold:Boolean(step)&&!partialSale,txHash:step?.txHash,code:op?.error?.code};}
 async function buy(p,guard){const config=p.config,cap=parseUnits(config.perTokenMaxBnb,18),request={profile:'unified',tokenAddress:p.tokenAddress,wallet:p.wallet,intentId:p.buyIntentId,action:'buy',amount:formatUnits(p.amountRaw,p.decimals),slippageBps:config.slippageBps,swapSlippageBps:config.swapSlippageBps,maxBnb:config.perTokenMaxBnb};
  const policy={active:guard.active,check:async plan=>{guard.active();await guard.verify();if(plan.protocol!=='gang-curve'||!same(plan.manager,p.manager)||!same(plan.tokenAddress,p.tokenAddress)||plan.amountRaw!==p.amountRaw||plan.quote.address.toLowerCase()!==p.quote.address.toLowerCase())throw fault('GANG_NEW_ROUTE_CHANGED');
   if(guard.checkPlan)await guard.checkPlan(plan);
   const needed=plan.kind==='fund'?parseUnits(plan.funding.required,plan.quote.decimals):plan.kind==='wrap'?BigInt(plan.fundingQuoteRequiredRaw):BigInt(plan.spendRaw),cost=await toBnb(plan.quote,needed,config.swapSlippageBps);
   if(cost>cap)throw fault('GANG_TOKEN_BUDGET');if(plan.kind==='fund'){const held=parseUnits(plan.funding.available,plan.quote.decimals),used=held<needed?held:needed,total=parseUnits(plan.trade.amount,18)+(used?await toBnb(plan.quote,used,config.swapSlippageBps):0n);if(total>cap)throw fault('GANG_TOKEN_BUDGET');}return {costRaw:cost.toString()};}};
  await trader.startStrategy(request,policy);await trader.drain();return buyResult(p,await trader.strategyOperation(p.buyIntentId));
 }
 async function sell(p,guard){const request={profile:'unified',tokenAddress:p.tokenAddress,wallet:p.wallet,intentId:p.sellIntentId,action:'sell',amount:formatUnits(p.halfRaw,p.decimals),slippageBps:p.config.slippageBps,swapSlippageBps:p.config.swapSlippageBps};
  await trader.startStrategy(request,{active:guard.active,check:async plan=>{guard.active();if(!same(plan.tokenAddress,p.tokenAddress)||!same(plan.wallet,p.wallet))throw fault('GANG_RESULT_MISMATCH');if(plan.kind==='convert')return;
   if(plan.amountRaw!==p.halfRaw)throw fault('GANG_RESULT_MISMATCH');await inventory(p,await reader.inspect(p.tokenAddress));if(await toBnb(plan.quote,BigInt(plan.expectedRaw),p.config.swapSlippageBps)<BigInt(p.costRaw))throw fault('GANG_PROFIT_CHANGED');}});await trader.drain();return sellResult(p,await trader.strategyOperation(p.sellIntentId));
 }
 async function recover(p){const op=await trader.strategyOperation(p.sellIntentId||p.buyIntentId);return p.sellIntentId?sellResult(p,op):buyResult(p,op);}
 return {wallet,entry,exitQuote,buy,sell,recover,toBnb};
}
