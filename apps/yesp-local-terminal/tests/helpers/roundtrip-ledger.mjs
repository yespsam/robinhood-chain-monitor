// Deterministic in-memory BSC and wallet adapter. No HTTP, real wallet CLI,
// credentials, signing or broadcasting is reachable from this fixture.
import assert from 'node:assert/strict';
import {Interface,formatUnits,parseUnits,keccak256} from 'ethers';
import {randomUUID} from 'node:crypto';
import {createGangReader,GANG_PADS,gangAbi,gangReceipt,VT,WBNB,wrapAbi} from '../../server/gang-reader.mjs';
import {createFourTrader} from '../../server/four-trader.mjs';
import {createReadScopeRpc} from '../../server/read-scope.mjs';
import {FlapJournal} from '../../server/flap-journal.mjs';
import {ZERO,erc20Abi} from '../../server/four-reader.mjs';
import {NATIVE} from '../../server/model.mjs';
export const U=10n**18n,addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
export const token=addr(101),wallet=addr(102),settlement=addr(103),swapRouter=addr(104);
const tokenAbi=new Interface(['function name() view returns(string)','function locked() view returns(bool)','function totalSupply() view returns(uint256)']);
const unwrapAbi=new Interface(['function withdraw(uint256)','event Withdrawal(address indexed src,uint256 wad)']);
const ceil=(a,b)=>(a+b-1n)/b,hex=n=>'0x'+BigInt(n).toString(16),gas=50000n*1000000000n;
export function createRoundtripLedger(directory,options={}){
 const quote=options.wrapped?WBNB:settlement,vq=(options.wrapped?5n:475292n)*U,pad={...GANG_PADS.find(p=>p.variant===(options.variant||'v2')),hash:keccak256('0x60006000')},padAbi=gangAbi(pad),v3=pad.variant==='v3';
 const state={base:0n,quote:options.heldQuote??0n,native:options.native??5n*U,sold:0n,reserve:0n,nonce:1n,head:100n,quoteAllowance:options.oldAllowance?1n:0n,baseAllowance:options.oldAllowance?1n:0n,submissions:[],quotes:[],requests:[],orders:new Map(),transactions:new Map(),receipts:new Map(),previews:new Map(),conversionFailed:false};
 const blockHash=n=>hash(1000000n+BigInt(n));
 const event=(address,abi,name,args)=>({address,...abi.encodeEventLog(abi.getEvent(name),args)});
 const transfer=(asset,from,to,n)=>event(asset,erc20Abi,'Transfer',[from,to,n]);
 function mine(kind,tx,logs){const id=hash(100n+BigInt(state.submissions.length)),block=state.head+1n;
  state.submissions.push({kind,tx:structuredClone(tx),hash:id});state.transactions.set(id,{hash:id,from:wallet,...tx,input:tx.inputData||'0x1234',nonce:hex(state.nonce++),blockHash:blockHash(block)});
  state.receipts.set(id,{transactionHash:id,from:wallet,to:tx.to,blockHash:blockHash(block),blockNumber:hex(block),status:'0x1',gasUsed:hex(50000n),effectiveGasPrice:hex(1000000000n),logs});state.native-=gas;state.head=block+3n;return id;
 }
 function marketMove(){if(!options.moveAfterFunding)return;state.sold=VT/BigInt(options.moveAfterFunding);state.reserve=ceil(vq*VT,VT-state.sold)-vq;}
 function outputBuy(input){const fee=input/100n,net=input-fee,out=VT-state.sold-ceil(vq*VT,vq+state.reserve+net);return {fee,net,out:out<10000000n*U-state.base?out:10000000n*U-state.base};}
 function outputSell(input){const gross=vq+state.reserve-ceil(vq*VT,VT-state.sold+input),fee=gross/100n;return {gross,fee,out:gross-fee};}
 const rawRpc=async(method,args)=>{
  assert(!/send|sign/i.test(method),'RPC must never broadcast');
  if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return hex(state.head);
  if(method==='eth_getBlockByNumber'){const n=args[0]==='latest'?state.head:BigInt(args[0]);return {number:hex(n),hash:blockHash(n),timestamp:hex(Math.floor(Date.now()/1000))};}
  if(method==='eth_getBalance')return hex(state.native);if(method==='eth_getTransactionCount')return hex(state.nonce);
  if(method==='eth_getCode')return '0x60006000';if(method==='eth_getStorageAt')return hash(0);if(method==='eth_estimateGas')return hex(50000n);if(method==='eth_gasPrice')return hex(1000000000n);
  if(method==='eth_getTransactionByHash')return state.transactions.get(args[0])||null;
  if(method==='eth_getTransactionReceipt')return state.receipts.get(args[0])||null;
  assert.equal(method,'eth_call');const tx=args[0];let abi,call;
  for(const a of [padAbi,erc20Abi,tokenAbi]){try{const q=a.parseTransaction({data:tx.data});if(q){abi=a;call=q;break;}}catch{}}
  assert(call,'Unknown calldata');let value;
  switch(call.name){
   case 'curves':value=[addr(105),quote,state.reserve,state.sold,3n*vq,vq,false,...(v3?[100n,100n,0n]:[true]),ZERO,ZERO];break;
   case 'kindOf':value=[1n];break;case 'taxConfigOf':value=[100n,100n,0n,addr(106)];break;case 'PROTOCOL_FEE_BPS':value=[100n];break;case 'PLATFORM_TAX_BPS':value=[50n];break;
   case 'name':value=['SIMULATION ONLY — GPU'];break;case 'locked':value=[true];break;case 'decimals':value=[18];break;case 'totalSupply':value=[1000000000n*U];break;
   case 'symbol':value=[tx.to.toLowerCase()===token?'SIMGPU':options.wrapped?'WBNB':'SIMGANG'];break;
   case 'MAX_PER_WALLET':value=[10000000n*U];break;case 'VIRTUAL_TOKEN':value=[VT];break;case 'logoURIOf':value=[''];break;
   case 'agentGateEnabled':case 'walletCapEnabled':case 'isAgent':value=[true];break;
   case 'walletRoom':value=[10000000n*U-state.base];break;
   case 'balanceOf':value=[tx.to.toLowerCase()===token?state.base:state.quote];break;
   case 'allowance':value=[tx.to.toLowerCase()===token?state.baseAllowance:state.quoteAllowance];break;
   default:throw Error('Unimplemented read '+call.name);
  }return abi.encodeFunctionResult(call.name,value);
 };
 const rpc=createReadScopeRpc(rawRpc),gang=createGangReader({rpc,deployments:[pad]}),reader={...gang,receipt:gangReceipt};
 const cli={status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:wallet}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'}),
  quoteSwap:async trade=>{state.quotes.push(structuredClone(trade));const n=parseUnits(trade.amount,18),buy=trade.fromToken===NATIVE;assert.equal(buy?trade.toToken:trade.fromToken,quote);return {fromCoinAmount:trade.amount,toCoinAmount:formatUnits(buy?n*10000n:n/10000n,18)};},
  executeSwap:async trade=>{const n=parseUnits(trade.amount,18),buy=trade.fromToken===NATIVE,id='mock-order-'+randomUUID();
   if(!buy&&options.conversionFails){state.conversionFailed=true;state.submissions.push({kind:'convert-rejected'});state.orders.set(id,{orderId:id,chain:'56',fromToken:quote,toToken:NATIVE,fromTokenQty:trade.amount,status:'FAILED'});return {outcome:'SUBMITTED',data:{orderId:id}};}
   const out=buy?n*10000n:n/10000n;assert(n>0n&&out>0n);
   if(buy){assert(state.native>=n+gas);state.native-=n-(options.roundFunding?1n:0n);state.quote+=out;}else{assert(state.quote>=n);state.quote-=n;state.native+=out;}
   const txHash=mine(buy?'fund':'convert',{to:swapRouter,value:hex(buy?n-(options.roundFunding?1n:0n):0n)},[transfer(quote,buy?swapRouter:wallet,buy?wallet:swapRouter,buy?out:n)]);
   state.orders.set(id,{orderId:id,chain:'56',fromToken:trade.fromToken,toToken:trade.toToken,fromTokenQty:trade.amount,toTokenActualQty:formatUnits(out,18),status:'FINISHED',txHash});if(buy)marketMove();return {outcome:options.phone?'PENDING_CONFIRMATION':'SUBMITTED',data:{orderId:id}};
  },
  readOrder:async({orderId})=>({list:state.orders.has(orderId)?[state.orders.get(orderId)]:[]}),
  recentTransactions:async()=>[...state.transactions.keys()].reverse(),
  previewContract:async tx=>{const id=randomUUID();state.previews.set(id,structuredClone(tx));const isApprove=tx.inputData.startsWith('0x095ea7b3'),decoded=isApprove?erc20Abi.decodeFunctionData('approve',tx.inputData):null;
   const parsedTx={contractAddress:tx.to,...(isApprove?{spender:decoded[0],...(decoded[1]===0n?{transactionType:'Revoke'}:{transactionType:'Approve',amount:decoded[1].toString()})}:{transactionType:'ContractInteraction'})};
   return {outcome:'PREVIEWED',data:{requestId:id,expiresAt:Date.now()+60000,parsedTx,simulationResult:{simulationCode:'000000000',balanceChanges:[],authorityChanges:[],allowanceChanges:isApprove?[{owner:wallet,tokenAddress:tx.to,spender:decoded[0],postAmount:decoded[1]===0n?0:decoded[1].toString()}]:[]},risks:{riskDetails:options.risk?['mock risk']:[],riskBehaviors:[],addresses:{}}}};
  },
  executePreview:async id=>{const tx=state.previews.get(id);assert(tx,'Unknown preview');state.previews.delete(id);let logs,kind;
   if(tx.inputData.startsWith('0x095ea7b3')){const [spender,n]=erc20Abi.decodeFunctionData('approve',tx.inputData);assert.equal(spender.toLowerCase(),pad.address.toLowerCase());if(tx.to.toLowerCase()===token)state.baseAllowance=n;else state.quoteAllowance=n;kind=n===0n?'revoke':'approve';logs=[event(tx.to,erc20Abi,'Approval',[wallet,pad.address,n])];}
   else if(tx.inputData==='0xd0e30db0'){const n=BigInt(tx.value);assert.equal(tx.to.toLowerCase(),WBNB);assert(state.native>=n+gas);state.native-=n;state.quote+=n;kind='wrap';logs=[event(WBNB,wrapAbi,'Deposit',[wallet,n])];}
   else if(tx.inputData.startsWith('0x2e1a7d4d')){const [n]=unwrapAbi.decodeFunctionData('withdraw',tx.inputData);assert(state.quote>=n);state.quote-=n;state.native+=n;kind='unwrap';logs=[event(WBNB,unwrapAbi,'Withdrawal',[wallet,n])];}
   else{const c=padAbi.parseTransaction({data:tx.inputData}),n=c.args[1],min=c.args[2];assert.equal(c.args[0].toLowerCase(),token);assert.equal(tx.to.toLowerCase(),pad.address.toLowerCase());
    if(c.name==='buy'){const q=outputBuy(n);assert(q.out>=min&&q.out>0n);assert(state.quote>=n&&state.quoteAllowance>=n);state.quote-=n;state.quoteAllowance-=n;state.base+=q.out;state.sold+=q.out;state.reserve+=q.net;kind='buy';logs=[event(pad.address,padAbi,'Buy',[token,wallet,q.net,v3?q.fee:0n,v3?0n:q.fee,q.out,state.reserve]),transfer(quote,wallet,pad.address,n),transfer(token,pad.address,wallet,q.out)];}
    else{assert.equal(c.name,'sell');const q=outputSell(n);assert(state.base>=n&&state.baseAllowance>=n&&q.out>=min);state.base-=n;state.baseAllowance-=n;state.quote+=q.out;state.sold-=n;state.reserve-=q.gross;kind='sell';logs=[event(pad.address,padAbi,'Sell',[token,wallet,n,v3?q.fee:0n,v3?0n:q.fee,q.out,state.reserve]),transfer(token,wallet,pad.address,n),transfer(quote,pad.address,wallet,q.out)];}
   }
   const txHash=mine(kind,tx,logs);return options.phone?{outcome:'PENDING_CONFIRMATION'}:{outcome:'SUBMITTED',data:{txHash}};
  }
 };
 const journal=new FlapJournal(directory),trader=createFourTrader({cli,reader,journal,panel:true,allowWrites:true,sleep:async()=>{}});
 return {state,reader,cli,journal,trader,quote,async trade(action,extra={}){const params={profile:'unified',tokenAddress:token,wallet,action,slippageBps:'1000',swapSlippageBps:'100',...(action==='buy'?{amount:'10000000',fundingMode:'quantity'}:{sellPercent:'100'}),intentId:randomUUID(),...extra};state.requests.push(params);await trader.handle('panelTrade',params);await trader.drain();return journal.read(params.intentId);}};
}
