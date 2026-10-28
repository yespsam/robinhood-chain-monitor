import {Interface,formatUnits,parseUnits} from 'ethers';
import {createPanelChain} from './panel-chain.mjs';
import {fault,same} from './flap-reader.mjs';
import {ZERO,erc20Abi} from './four-reader.mjs';
import {NATIVE} from './model.mjs';
import {pendingContractHash} from './pending-contract.mjs';
const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',abi=new Interface(['function withdraw(uint256)','event Withdrawal(address indexed src,uint256 wad)']);
export function createPanelConversion({reader,cli,clock=Date.now}){
 const c=createPanelChain(reader.rpc,clock);
 async function prepare(sale,slippageBps){const p=sale.steps[0].plan,amount=sale.receivedAmount,raw=parseUnits(amount,p.quote.decimals),head=await c.head(),a=await c.account(p.wallet,head.block);
  if(raw<=0n||same(p.quote.address,ZERO))throw fault('CONVERSION_UNAVAILABLE');
  if(await c.balance(p.quote.address,p.wallet,head.block)<raw)throw fault('INSUFFICIENT_BALANCE');
  const plan={...p,kind:'convert',action:'sell',amount,amountRaw:raw.toString(),nonce:a.nonce,block:head.block,slippageBps,expiresAt:clock()+60000,nativeBeforeRaw:a.native.toString(),identityAddresses:[p.quote.address],identity:await c.fingerprints([p.quote.address],head.block)};
  delete plan.tx;delete plan.trade;delete plan.official;delete plan.previewId;
  if(same(p.quote.address,WBNB)){plan.conversionMode='unwrap';plan.tx={from:p.wallet,to:WBNB,value:'0x0',inputData:abi.encodeFunctionData('withdraw',[raw])};plan.expected=plan.minimum=amount;plan.minimumRaw=raw.toString();
   const gas=await reader.rpc('eth_estimateGas',[{from:p.wallet,to:WBNB,value:'0x0',data:plan.tx.inputData}]),fee=BigInt(gas)*BigInt(await reader.rpc('eth_gasPrice',[]));if(a.native<fee*2n)throw fault('INSUFFICIENT_GAS');plan.estimatedGas=formatUnits(fee,18);
  }else{plan.conversionMode='swap';plan.trade={chainId:'56',fromToken:p.quote.address,toToken:NATIVE,amount,slippage:String(Number(slippageBps)/100)};
   const q=await cli.quoteSwap(plan.trade);if(parseUnits(q.fromCoinAmount,p.quote.decimals)!==raw)throw fault('SWAP_QUOTE_INVALID');const out=parseUnits(q.toCoinAmount,18),min=out*(10000n-BigInt(slippageBps))/10000n;
   if(min<=0n)throw fault('SWAP_QUOTE_INVALID');if(a.native<100000000000000n)throw fault('INSUFFICIENT_GAS');plan.expected=formatUnits(out,18);plan.minimum=formatUnits(min,18);plan.minimumRaw=min.toString();
  }return plan;
 }
 async function recheck(p){const h=await c.head(),a=await c.account(p.wallet,h.block);if(a.nonce!==p.nonce||JSON.stringify(await c.fingerprints(p.identityAddresses,h.block))!==JSON.stringify(p.identity))throw fault('PREVIEW_EXPIRED');if(await c.balance(p.quote.address,p.wallet,h.block)<BigInt(p.amountRaw))throw fault('INSUFFICIENT_BALANCE');}
 async function reconcile(op,persist){const s=op.steps[0],p=s.plan,rpc=reader.rpc;let row;
  if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
  if(p.conversionMode==='swap'){
   if(!s.orderId)return op;row=(await cli.readOrder({chainId:'56',orderId:s.orderId})).list[0];if(!row)return op;
   if(row.orderId!==s.orderId||row.chain!=='56'||!same(row.fromToken,p.quote.address)||!same(row.toToken,NATIVE)||parseUnits(row.fromTokenQty,p.quote.decimals)!==BigInt(p.amountRaw))throw fault('SWAP_ORDER_MISMATCH');
   if(['PENDING','PENDING_CONFIRMATION'].includes(row.status))return op;if(row.status==='FAILED'){s.status=op.status='FAILED';op.message='卖出已完成，换回 BNB 失败；结算币保留在钱包。';return persist(op);}
   if(row.status!=='FINISHED'||!/^0x[\da-f]{64}$/i.test(row.txHash||''))throw fault('SWAP_ORDER_MISMATCH');if(s.txHash&&!same(s.txHash,row.txHash))throw fault('SWAP_ORDER_MISMATCH');s.txHash=op.txHash=row.txHash;
  }
  if(!s.txHash&&p.conversionMode==='unwrap'){const hash=await pendingContractHash({cli,rpc,op});if(hash){s.txHash=op.txHash=hash;s.status=op.status='SUBMITTED';await persist(op);}}
  if(!s.txHash)return op;const [tx,rec]=await Promise.all([rpc('eth_getTransactionByHash',[s.txHash]),rpc('eth_getTransactionReceipt',[s.txHash])]);if(!tx||!rec)return op;
  if(!same(tx.hash,s.txHash)||!same(rec.transactionHash,s.txHash)||!same(tx.from,p.wallet)||!same(rec.from,p.wallet)||!same(tx.to,rec.to)||tx.blockHash!==rec.blockHash||!/^0x[\da-f]{64}$/i.test(rec.blockHash||'')||!/^0x[\da-f]+$/i.test(rec.blockNumber||'')||BigInt(tx.value)!==0n||BigInt(tx.nonce)<BigInt(p.nonce))throw fault('CONVERSION_IDENTITY_MISMATCH');
  if(p.conversionMode==='unwrap'&&(!same(tx.to,WBNB)||!same(tx.input,p.tx.inputData)||BigInt(tx.nonce)!==BigInt(p.nonce)))throw fault('CONVERSION_IDENTITY_MISMATCH');
  if(BigInt(await rpc('eth_blockNumber',[]))-BigInt(rec.blockNumber)<2n)return op;if((await rpc('eth_getBlockByNumber',[rec.blockNumber,false]))?.hash!==rec.blockHash)throw fault('RECEIPT_IDENTITY_MISMATCH');
  const gas=BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice);if(BigInt(rec.status)===0n){s.status=op.status='FAILED';s.failedReceipt={txHash:s.txHash,blockHash:rec.blockHash,blockNumber:rec.blockNumber,status:'0x0',gasRaw:gas.toString()};return persist(op);}if(BigInt(rec.status)!==1n)throw fault('INVALID_RECEIPT_STATUS');
  let out;if(p.conversionMode==='unwrap'){const logs=(rec.logs||[]).filter(l=>same(l.address,WBNB)).flatMap(l=>{try{const e=abi.parseLog(l);return e?.name==='Withdrawal'&&same(e.args.src,p.wallet)?[e.args]:[];}catch{return [];}});if(logs.length!==1||logs[0].wad!==BigInt(p.amountRaw))throw fault('CONVERSION_SETTLEMENT_MISMATCH');out=BigInt(p.amountRaw);}
  else{const net=(rec.logs||[]).filter(l=>same(l.address,p.quote.address)).reduce((sum,l)=>{try{const e=erc20Abi.parseLog(l);if(e?.name==='Transfer')return sum+(same(e.args.from,p.wallet)?e.args.value:0n)-(same(e.args.to,p.wallet)?e.args.value:0n);}catch{}return sum;},0n);if(net<=0n||net>BigInt(p.amountRaw))throw fault('CONVERSION_SETTLEMENT_MISMATCH');
   out=parseUnits(row.toTokenActualQty,18);if(out<=0n)throw fault('CONVERSION_SETTLEMENT_MISMATCH');s.convertedQuoteRaw=net.toString();op.partial=net<BigInt(p.amountRaw);
  }
  const native=BigInt(await rpc('eth_getBalance',[p.wallet,rec.blockNumber]));if(p.conversionMode==='unwrap'&&native+gas-BigInt(p.nativeBeforeRaw)<out)throw fault('CONVERSION_SETTLEMENT_MISMATCH');
  // An ERC20 swap may include a separate approval fee. Do not misreport the
  // wallet balance delta as the swap's native output; use the matched order.
  s.observedNativeDeltaRaw=(native+gas-BigInt(p.nativeBeforeRaw)).toString();s.status='CONFIRMED';s.blockNumber=rec.blockNumber;s.gasRaw=gas.toString();op.status='COMPLETE';op.receivedAmount=formatUnits(out,18);op.receivedAmountSource=p.conversionMode==='unwrap'?'withdrawal-event':'binance-order';op.message=`换回 BNB 已确认${p.conversionMode==='swap'?'，币安订单记录到账':''}：${op.receivedAmount} BNB。`+(op.partial?'兑换部分成交，剩余结算币保留在钱包。':'');return persist(op);
 }
 return {prepare,recheck,reconcile};
}
