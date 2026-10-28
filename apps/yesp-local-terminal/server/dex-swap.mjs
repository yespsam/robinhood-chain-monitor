import {formatUnits,parseUnits} from 'ethers';
import {createPanelChain,rawAmount} from './panel-chain.mjs';
import {fault,same} from './flap-reader.mjs';
import {ZERO,erc20Abi} from './four-reader.mjs';
import {NATIVE} from './model.mjs';
import {validateSlippageBps} from '../extension/slippage-policy.js';
const reserve=5000000000000000n,HASH=/^0x[\da-f]{64}$/i;
const migrationBlockers=new Set(['GANG_DEX_ROUTE_REQUIRED','FLAP_DEX_ROUTE_REQUIRED','FOUR_MIGRATED','OPENFOUR_MIGRATED']);
export function externalMarket(m){
 const graduated=m.protocol==='gang-curve'&&m.phase===3||m.protocol==='flap-standard'&&m.phase===4||m.protocol==='openfour-agent'&&m.phase==='3'||m.liquidityAdded===true;
 if(!graduated||!m.blockers?.length||m.blockers.some(b=>!migrationBlockers.has(b)))return m;
 return {...m,protocol:'dex-swap',originProtocol:m.protocol||'four-classic',originQuote:m.quote,quote:{address:ZERO,symbol:'BNB',decimals:18},
   phaseLabel:'已毕业 · DEX 市价交易',positionKind:'代币余额',supported:true,blockers:[],transferLocked:false,
  limitType:'DEX 无内盘持仓限额，数量受余额和流动性约束',remainingRaw:undefined,maxBuyRaw:undefined,holdCap:undefined};
}
export function createDexSwap({reader,cli,clock=Date.now}){
 const c=createPanelChain(reader.rpc,clock);
 async function price(trade,decimals){const q=await cli.quoteSwap(trade),input=rawAmount(q.fromCoinAmount,trade.fromToken===NATIVE?18:decimals),output=rawAmount(q.toCoinAmount,trade.toToken===NATIVE?18:decimals);
  if(input!==rawAmount(trade.amount,trade.fromToken===NATIVE?18:decimals))throw fault('SWAP_QUOTE_INVALID');return output;
 }
 async function prepare(m,p,w){if(m.protocol!=='dex-swap'||!m.supported||!['buy','sell'].includes(p.action))throw fault('DEX_ROUTE_UNAVAILABLE');
  const buy=p.action==='buy',bps=validateSlippageBps(p.slippageBps),target=rawAmount(p.amount,m.base.decimals),a=await c.account(w,m.block),held=await c.balance(m.tokenAddress,w,m.block);
  if(a.native<reserve)throw fault('INSUFFICIENT_GAS');if(!buy&&held<target)throw fault('INSUFFICIENT_BALANCE');
  let input=target,expected,trade;
  const budgeted=p.funding&&p.funding.mode!=='quantity',nativeCap=budgeted?rawAmount(p.funding.maxBnb,18):a.native-reserve,cap=nativeCap<a.native-reserve?nativeCap:a.native-reserve;
  if(buy){if(cap<=0n)throw fault('INSUFFICIENT_BALANCE');input=cap<1000000000000000n?cap:1000000000000000n;
   for(let i=0;i<5;i++){trade={chainId:'56',fromToken:NATIVE,toToken:m.tokenAddress,amount:formatUnits(input,18),slippage:String(Number(bps)/100)};expected=await price(trade,m.base.decimals);
    if(expected>=target){const sized=(input*target*1001n+expected*1000n-1n)/(expected*1000n);if(i===0&&sized<input){input=sized;continue;}break;}
    const next=(input*target*1001n+expected*1000n-1n)/(expected*1000n);if(next>cap&&input===cap)throw fault(budgeted&&nativeCap<=a.native-reserve?'FUNDING_BUDGET_EXCEEDED':'INSUFFICIENT_BALANCE',{budget:{kind:'dex',maxBnb:formatUnits(nativeCap,18),amount:p.amount,tokenSymbol:m.base.symbol,symbol:m.base.symbol,needed:p.amount,expected:formatUnits(expected,m.base.decimals),minimum:formatUnits(expected*(10000n-bps)/10000n,m.base.decimals)}});input=next>cap?cap:next;
   }if(expected<target)throw fault('DEX_QUOTE_UNAVAILABLE');
  }else{trade={chainId:'56',fromToken:m.tokenAddress,toToken:NATIVE,amount:p.amount,slippage:String(Number(bps)/100)};expected=await price(trade,m.base.decimals);}
  const minimum=expected*(10000n-bps)/10000n;if(minimum<=0n)throw fault('SWAP_QUOTE_INVALID');
  const identityAddresses=[m.tokenAddress,m.manager,...(/^0x[\da-f]{40}$/i.test(m.pool||'')&&!same(m.pool,ZERO)?[m.pool]:[])];
  return {...m,wallet:w,kind:p.action,action:p.action,amount:p.amount,amountRaw:target.toString(),buyMode:buy?'tokenAmount':undefined,
   trade,nonce:a.nonce,slippageBps:p.slippageBps,spendRaw:input.toString(),spend:formatUnits(input,buy?18:m.base.decimals),
   expectedRaw:expected.toString(),minimumRaw:minimum.toString(),expected:formatUnits(expected,buy?m.base.decimals:18),minimum:formatUnits(minimum,buy?m.base.decimals:18),
   nativeBeforeRaw:a.native.toString(),identityAddresses,identity:await c.fingerprints(identityAddresses,m.block),gasReserve:formatUnits(reserve,18),expiresAt:clock()+60000};
 }
 async function recheck(p){const m=await reader.inspect(p.tokenAddress);if(m.protocol!=='dex-swap'||!m.supported||m.originProtocol!==p.originProtocol||!same(m.manager,p.manager)||m.base.decimals!==p.base.decimals)throw fault('MODE_DEFINITION_CHANGED');
  const a=await c.account(p.wallet,m.block);if(a.nonce!==p.nonce||JSON.stringify(await c.fingerprints(p.identityAddresses,m.block))!==JSON.stringify(p.identity))throw fault('PREVIEW_EXPIRED');
  if(p.action==='buy'?a.native<BigInt(p.spendRaw)+reserve:a.native<reserve||await c.balance(p.tokenAddress,p.wallet,m.block)<BigInt(p.amountRaw))throw fault('INSUFFICIENT_BALANCE');
  const output=await price(p.trade,p.base.decimals);if(output<BigInt(p.minimumRaw))throw fault('PREVIEW_EXPIRED');
 }
 async function reconcile(op,persist){const s=op.steps[0],p=s.plan,rpc=reader.rpc;if(!s.orderId)return op;
  if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');const row=(await cli.readOrder({chainId:'56',orderId:s.orderId})).list[0];if(!row)return op;
  const buy=p.action==='buy',inputDecimals=buy?18:p.base.decimals;
  if(row.orderId!==s.orderId||row.chain!=='56'||!same(row.fromToken,p.trade.fromToken)||!same(row.toToken,p.trade.toToken)||rawAmount(row.fromTokenQty,inputDecimals)!==rawAmount(p.trade.amount,inputDecimals))throw fault('SWAP_ORDER_MISMATCH');
  if(['PENDING','PENDING_CONFIRMATION'].includes(row.status))return op;
  if(row.status==='FAILED'){s.status=op.status='FAILED';s.orderFailureConfirmed=true;op.message='DEX 订单失败；流程已停止，未自动重试。';return persist(op);}
  if(row.status!=='FINISHED'||!HASH.test(row.txHash||'')||s.txHash&&!same(s.txHash,row.txHash))throw fault('SWAP_ORDER_MISMATCH');
  if(!s.txHash){s.txHash=op.txHash=row.txHash;await persist(op);}
  const [tx,rec]=await Promise.all([rpc('eth_getTransactionByHash',[s.txHash]),rpc('eth_getTransactionReceipt',[s.txHash])]);if(!tx||!rec)return op;
  const nonce=BigInt(tx.nonce),preparedNonce=BigInt(p.nonce),nativeValue=BigInt(tx.value),inputRaw=rawAmount(p.trade.amount,inputDecimals);
  if(!same(tx.hash,s.txHash)||!same(rec.transactionHash,s.txHash)||!same(tx.from,p.wallet)||!same(rec.from,p.wallet)||!same(tx.to,rec.to)||tx.blockHash!==rec.blockHash||!HASH.test(rec.blockHash||'')||!/^0x[\da-f]+$/i.test(rec.blockNumber||'')
    ||(buy?(nonce!==preparedNonce||nativeValue<=0n||inputRaw-nativeValue<0n||inputRaw-nativeValue>1n):(nonce<preparedNonce||nonce>preparedNonce+2n||nativeValue!==0n)))throw fault('DEX_SETTLEMENT_MISMATCH');
  if(BigInt(await rpc('eth_blockNumber',[]))-BigInt(rec.blockNumber)<2n)return op;
  if((await rpc('eth_getBlockByNumber',[rec.blockNumber,false]))?.hash!==rec.blockHash)throw fault('RECEIPT_IDENTITY_MISMATCH');
  const gas=(BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice)).toString();
  if(BigInt(rec.status)===0n){s.status=op.status='FAILED';s.failedReceipt={txHash:s.txHash,blockHash:rec.blockHash,blockNumber:rec.blockNumber,status:'0x0',gasRaw:gas};op.message='DEX 交易在链上失败，未自动重试。';return persist(op);}if(BigInt(rec.status)!==1n)throw fault('INVALID_RECEIPT_STATUS');
  const net=(rec.logs||[]).filter(l=>same(l.address,p.tokenAddress)).reduce((sum,l)=>{try{const e=erc20Abi.parseLog(l);if(e?.name==='Transfer')return sum+(same(e.args.to,p.wallet)?e.args.value:0n)-(same(e.args.from,p.wallet)?e.args.value:0n);}catch{}return sum;},0n);
  const refunds=Array.isArray(row.refund)?row.refund.filter(r=>/^0x[\da-f]{40}$/i.test(r?.tokenAddress||'')&&typeof r.amount==='string'&&/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(r.amount)&&/[1-9]/.test(r.amount)).map(r=>({tokenAddress:r.tokenAddress,amount:r.amount,symbol:String(r.symbol||'').replace(/[\u0000-\u001f]/g,'').slice(0,40)})):[];
  if(buy?net<0n:net>0n||-net>inputRaw)throw fault('DEX_SETTLEMENT_MISMATCH');
  if(net===0n&&!refunds.some(r=>same(r.tokenAddress,p.trade.fromToken)))throw fault('DEX_SETTLEMENT_MISMATCH');
  let received=net;if(!buy){if(typeof row.toTokenActualQty!=='string'||!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(row.toTokenActualQty))throw fault('SWAP_ORDER_MISMATCH');received=parseUnits(row.toTokenActualQty,18);if(received===0n&&!refunds.length)throw fault('DEX_SETTLEMENT_MISMATCH');}
  s.actualBaseChangeRaw=net.toString();s.actualNativeInputRaw=nativeValue.toString();s.status='CONFIRMED';s.blockNumber=rec.blockNumber;s.gasRaw=gas;
  op.status='COMPLETE';op.receivedAmount=formatUnits(received,buy?p.base.decimals:18);op.receivedAmountSource=buy?'token-transfer':'binance-order';op.refunds=refunds;op.partial=refunds.length>0||(!buy&&-net<inputRaw)||(buy&&net<BigInt(p.amountRaw));
  op.message=`DEX ${buy?'买入':'卖出'}已确认，${buy?'链上实际收到':'币安订单记录到账'} ${op.receivedAmount} ${buy?p.base.symbol:'BNB'}。`+(op.partial?'部分成交或实际数量未达到目标，剩余资产保留，未自动重试。':'');return persist(op);
 }
 return {prepare,recheck,reconcile};
}
