import {Interface,formatUnits,keccak256} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {ZERO,erc20Abi,tokenAddress} from './four-reader.mjs';
import {createPanelChain,rawAmount,minBig,safeText} from './panel-chain.mjs';
import {validateSlippageBps} from '../extension/slippage-policy.js';
// Official gangfun/cli 8479a24 + gang-launchpad d564700. BSC code observed 2026-10-26.
// New addresses/code are review candidates, never automatically trusted trading targets.
export const GANG_PADS=[
 ['v2','0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e','0x62293eb8930fd95758c2bbd335f4b90499002edb46f382623e09402c8ad25df6'],
 ['soft','0x315ba2e8952d06094cc636b2b84229fa32fb23a7','0x5abf90fecc70e78818e73a1cc8142dc9366bf8fa3ecfca5227f5f3688be8e052'],
 ['u','0xf81c4e51c48466c6025b0165b1ea0f6978c712cb','0xb12437780fec6b00eb5dbd8254f9ec4e05c12af1d27e91a34a32cd8e1f6359ac'],
 ['s','0x60aee38576035e757deD30ff8db8a8da476430c1'.toLowerCase(),'0xa2e10ec796fbdd4640d473b5f6b674a635f5398c3069c9ef70b891d1e60022b3'],
 ['soft','0x4e6f13c8a453c1b8b4e20b590082bb233a5b80d7','0xdda9ff5f94f8c6e8ffffcc4debe385556502bfa2ab695b86842eeda93e9fbc4b'],
 ['u','0x245a42ce8337dece0f1c04f8430c90c8d98b88e4','0x1de7066f0c41c3fa27c990c3f164a0ae8f3ffdae51bf772113341400a189e9d4'],
 ['s','0x80c5e29417f8037a9e4cc5320878386826732e89','0xc6b59c2f1e62d579c65a662e676cac95c78db6eabfea15c931a7235f2f2bb49b'],
 // Official MAINNET-GANG-2026-10-27; bytecode pinned from BSC on 2026-10-28.
 ['v3','0x15cfd2dc8278fb87a1783ef42111618e20874365','0xe052484fe5a9b1da61131388848051aa84d33b971dc2db689a56be08c1d594f0'],
].map(([variant,address,hash])=>({variant,address,hash}));
export const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const common=['function tokenCount() view returns(uint256)','function allTokens(uint256) view returns(address)',
 'function isAgent(address) view returns(bool)','function walletRoom(address,address) view returns(uint256)',
 'function MAX_PER_WALLET() view returns(uint256)','function VIRTUAL_TOKEN() view returns(uint256)',
 'function sell(address token,uint256 tokensIn,uint256 minQuoteOut) returns(uint256)'];
export const gangV2Abi=new Interface([...common,
 'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,bool taxed,address pair,address refPair)',
 'function buy(address token,uint256 quoteIn,uint256 minTokensOut) returns(uint256)',
 'function logoURIOf(address) view returns(string)','function agentGateEnabled() view returns(bool)','function walletCapEnabled() view returns(bool)',
 'function dividendVault() view returns(address)','function TAXED_MIN_SHARE() view returns(uint256)',
 'event Created(address indexed token,address indexed creator,string name,string symbol,string logoURI,bool taxed,address indexed quote,address refPair,uint256 gradAmt)',
 'event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)',
 'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 taxDividend,uint256 taxPlatform,uint256 quoteOut,uint256 realQuote)']);
export const gangSAbi=new Interface([...common,...gangV2Abi.fragments.filter(f=>!['curves',...common.map(s=>s.match(/function (\w+)/)?.[1])].includes(f.name)),
 'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,address pair,address refPair)']);
export const gangSoftAbi=new Interface([...common,
 'function curves(address) view returns(address creator,uint128 realBnb,uint128 sold,bool graduated,address pair)',
 'function buy(address token,uint256 minTokensOut) payable returns(uint256)',
 'function quoteBuy(address token,address buyer,uint256 gross) view returns(uint256 tokensOut,uint256 net,uint256 fee,uint256 refund)',
 'function quoteSell(address token,uint256 tokensIn) view returns(uint256 net,uint256 fee)',
 'function VIRTUAL_BNB() view returns(uint256)','function GRADUATION_BNB() view returns(uint256)',
 'event Buy(address indexed token,address indexed buyer,uint256 bnbIn,uint256 fee,uint256 tokensOut,uint256 realBnb)',
 'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 fee,uint256 bnbOut,uint256 realBnb)',
 'event PaymentDeferred(address indexed to,uint256 amount)']);
export const gangV3Abi=new Interface([...common,
 'function kindOf(address) view returns(uint8)',
 'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address pair,address refPair)',
 'function taxConfigOf(address) view returns(uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address recipient)',
 'function PROTOCOL_FEE_BPS() view returns(uint256)','function PLATFORM_TAX_BPS() view returns(uint256)',
 'function buy(address token,uint256 quoteIn,uint256 minTokensOut) returns(uint256)',
 'function logoURIOf(address) view returns(string)','function agentGateEnabled() view returns(bool)','function walletCapEnabled() view returns(bool)',
 'function dividendVault() view returns(address)','function TAXED_MIN_SHARE() view returns(uint256)',
 'event Created(address indexed token,address indexed creator,string name,string symbol,string logoURI,address indexed quote,address refPair,uint256 gradAmt)',
 'event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 protocolFee,uint256 tax,uint256 tokensOut,uint256 realQuote)',
 'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 protocolFee,uint256 tax,uint256 quoteOut,uint256 realQuote)']);
const tokenAbi=new Interface(['function name() view returns(string)','function locked() view returns(bool)']);
export const wrapAbi=new Interface(['function deposit() payable','event Deposit(address indexed dst,uint256 wad)']);
export const gangAbi=m=>m.variant==='v3'?gangV3Abi:m.variant==='soft'?gangSoftAbi:m.variant==='s'?gangSAbi:gangV2Abi;
export const VT=1066666666666666666666666667n;
const ceil=(a,b)=>(a+b-1n)/b;
export function gangMath(m){
 const real=BigInt(m.reserveRaw),sold=BigInt(m.soldRaw),vq=BigInt(m.virtualQuoteRaw),grad=BigInt(m.gradRaw),t=VT-sold,k=vq*VT;
 if(real<0n||sold<0n||t<=0n||vq<=0n||grad<=real)throw fault('GANG_CURVE_INVALID');
 const fee=n=>m.variant==='s'||m.variant==='u'&&m.taxed?2n*(n*50n/10000n):n/100n;
 const buyOut=net=>t-ceil(k,vq+real+net);
 const netFor=amount=>{if(amount<=0n||amount>=t)throw fault('BUY_LIMIT_EXCEEDED');return ceil(k,t-amount)-vq-real;};
 const grossFor=net=>{if(net<=0n)throw fault('QUOTE_UNAVAILABLE');let lo=net,hi=ceil(net*10000n,9900n);while(lo<hi){const mid=(lo+hi)/2n;if(mid-fee(mid)>=net)hi=mid;else lo=mid+1n;}return lo;};
 return {fee,buyOut,netFor,grossFor,remaining:buyOut(grad-real),sell:amount=>{if(amount<=0n||amount>sold)throw fault('INSUFFICIENT_BALANCE');const gross=vq+real-ceil(k,t+amount);if(gross<=0n||gross>real)throw fault('QUOTE_UNAVAILABLE');return gross-fee(gross);}};
}
export function createGangReader({rpc=createFlapRpc({url:'https://bsc-rpc.publicnode.com',timeoutMs:10000}),clock=Date.now,deployments=GANG_PADS}={}){
 const c=createPanelChain(rpc,clock),bindings=new Map();
 async function locate(token,block){const known=bindings.get(token.toLowerCase()),pads=known?[known]:deployments;
  const results=await Promise.allSettled(pads.map(async pad=>({pad,s:await c.call(pad.address,gangAbi(pad),'curves',[token],block)})));
  const found=results.filter(r=>r.status==='fulfilled'&&!same(r.value.s.creator,ZERO));if(found.length>1)throw fault('GANG_BINDING_AMBIGUOUS');
  if(!found.length){const error=results.find(r=>r.status==='rejected');if(error)throw error.reason;
   const merged=pads.find(p=>p.variant==='v3');if(merged&&(await c.call(merged.address,gangV3Abi,'kindOf',[token],block))[0]===2n)throw fault('GANG_KIND_UNSUPPORTED');throw fault('NOT_GANG_TOKEN');}
  const {pad,s}=found[0].value;if(keccak256(await rpc('eth_getCode',[pad.address,block]))!==pad.hash)throw fault('GANG_CONTRACT_CHANGED');
  if(pad.variant==='v3'&&(await c.call(pad.address,gangV3Abi,'kindOf',[token],block))[0]!==1n)throw fault('GANG_KIND_UNSUPPORTED');
  bindings.set(token.toLowerCase(),pad);while(bindings.size>400)bindings.delete(bindings.keys().next().value);return {pad,s};
 }
 async function inspectAt(input,head){const token=tokenAddress(input),{block,at}=head,{pad,s}=await locate(token,block),abi=gangAbi(pad),soft=pad.variant==='soft';
  const [base,quote,[name],[locked],[limit],[vt],grad,vq,logo,gate,cap]=await Promise.all([
   c.asset(token,block),c.asset(soft?ZERO:s.quote,block),c.call(token,tokenAbi,'name',[],block),c.call(token,tokenAbi,'locked',[],block),
   c.call(pad.address,abi,'MAX_PER_WALLET',[],block),c.call(pad.address,abi,'VIRTUAL_TOKEN',[],block),
   soft?c.call(pad.address,abi,'GRADUATION_BNB',[],block).then(r=>r[0]):s.gradAmt,
   soft?c.call(pad.address,abi,'VIRTUAL_BNB',[],block).then(r=>r[0]):s.virtualQuote,
   ['v2','v3'].includes(pad.variant)?c.call(pad.address,abi,'logoURIOf',[token],block).then(r=>r[0]):'',
   soft?true:c.call(pad.address,abi,'agentGateEnabled',[],block).then(r=>r[0]),soft?true:c.call(pad.address,abi,'walletCapEnabled',[],block).then(r=>r[0])]);
  if(base.decimals!==18||vt!==VT||grad<=0n||vq<=0n)throw fault('GANG_CURVE_INVALID');
  let taxConfig;
  if(pad.variant==='v3'){
   const [tax,[fee],[platformFee]]=await Promise.all([c.call(pad.address,abi,'taxConfigOf',[token],block),c.call(pad.address,abi,'PROTOCOL_FEE_BPS',[],block),c.call(pad.address,abi,'PLATFORM_TAX_BPS',[],block)]);
   if(fee!==100n||platformFee!==50n||quote.decimals!==18||limit!==10000000n*10n**18n||['buyTaxBps','sellTaxBps','dividendBps'].some(k=>tax[k]!==s[k]))throw fault('GANG_CURVE_INVALID');
   taxConfig={buyTaxBps:Number(tax.buyTaxBps),sellTaxBps:Number(tax.sellTaxBps),dividendBps:Number(tax.dividendBps),recipient:tax.recipient,platformTaxBps:Number(platformFee)};
  }
  const phase=s.graduated?3:1,blockers=s.graduated?['GANG_DEX_ROUTE_REQUIRED']:[],reserve=soft?s.realBnb:s.realQuote;
  const m={platform:'Gang',protocol:'gang-curve',variant:pad.variant,chainId:'56',tokenAddress:token,manager:pad.address,base,quote,name:safeText(name),creator:s.creator,
   phase,phaseLabel:s.graduated?'已毕业 · PancakeSwap':`Gang ${soft?'Soft':pad.variant.toUpperCase()} 内盘`,positionKind:'代币余额',block,snapshotAtMs:at,
   soldRaw:s.sold.toString(),reserveRaw:reserve.toString(),gradRaw:grad.toString(),virtualQuoteRaw:vq.toString(),maxBuyRaw:limit.toString(),
   taxed:pad.variant==='v3'?Boolean(s.buyTaxBps||s.sellTaxBps):!soft&&(pad.variant==='s'||s.taxed),...(taxConfig?{taxConfig}:{}),transferLocked:locked,pool:s.pair,logoURI:typeof logo==='string'?logo.slice(0,1600):'',agentGate:gate,walletCap:cap,
   progressBps:String(s.graduated?10000n:minBig(reserve*10000n/grad,10000n)),limitType:cap?'当前持仓上限（卖出后恢复额度）':'内盘剩余供应量',supported:!blockers.length,blockers};
  m.remainingRaw=s.graduated?'0':gangMath(m).remaining.toString();return m;
 }
 const inspect=async input=>inspectAt(input,await c.head());
 async function holdings(m,w){const abi=gangAbi(m),[base,quote,native,[room],[eligible]]=await Promise.all([c.balance(m.tokenAddress,w,m.block),c.balance(m.quote.address,w,m.block),c.balance(ZERO,w,m.block),
  c.call(m.manager,abi,'walletRoom',[m.tokenAddress,w],m.block),c.call(m.manager,abi,'isAgent',[w],m.block)]);
  const buyable=minBig(room,BigInt(m.remainingRaw));return {base:formatUnits(base,m.base.decimals),baseRaw:base.toString(),quote:formatUnits(quote,m.quote.decimals),quoteRaw:quote.toString(),native:formatUnits(native,18),
   eligible,buyableRaw:buyable.toString(),buyableTokenAmount:formatUnits(buyable,m.base.decimals),limitType:m.limitType};}
 async function build(p,w){const m=await inspect(p.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);if(!['buy','sell'].includes(p.action))throw fault('INVALID_REQUEST');
  const h=await holdings(m,w);if(m.agentGate&&!h.eligible)throw fault('GANG_AGENT_ID_REQUIRED');
  const target=rawAmount(p.amount,m.base.decimals),buy=p.action==='buy',math=gangMath(m),abi=gangAbi(m),bps=validateSlippageBps(p.slippageBps);let input=target,expected;
  const fixed=p.fixedSpendRaw!==undefined;
  if(fixed&&(!buy||typeof p.fixedSpendRaw!=='string'||! /^[1-9]\d{0,77}$/.test(p.fixedSpendRaw)||BigInt(p.fixedSpendRaw)>=1n<<256n))throw fault('INVALID_REQUEST');
  if(buy){if(target>BigInt(h.buyableRaw))throw fault('BUY_LIMIT_EXCEEDED');input=fixed?BigInt(p.fixedSpendRaw):math.grossFor(math.netFor(target));expected=minBig(math.buyOut(input-math.fee(input)),BigInt(h.buyableRaw));
   if(m.variant==='soft'){const q=await c.call(m.manager,abi,'quoteBuy',[m.tokenAddress,w,input],m.block);expected=q.tokensOut;}
   if(!fixed&&expected<target)throw fault('QUOTE_UNAVAILABLE');
  }else{if(target>BigInt(h.baseRaw))throw fault('INSUFFICIENT_BALANCE');expected=m.variant==='soft'?(await c.call(m.manager,abi,'quoteSell',[m.tokenAddress,target],m.block)).net:math.sell(target);}
  const minimum=(fixed?target:expected)*(10000n-bps)/10000n;if(minimum<=0n)throw fault('QUOTE_UNAVAILABLE');
  if(fixed&&expected<minimum)throw fault('AUTO_PRICE_CHANGED');
  // A separate, explicitly confirmed deposit. Never auto-wrap or auto-submit the later buy.
  if(buy&&same(m.quote.address,WBNB)&&BigInt(h.quoteRaw)<input){const wrap=input-BigInt(h.quoteRaw),plan=await c.finalize(m,{...p,action:'wrap'},w,{to:WBNB,inputData:wrapAbi.encodeFunctionData('deposit'),value:wrap,
    spendAsset:ZERO,spendRaw:wrap,amountRaw:target,expectedRaw:wrap,minimumRaw:wrap,wrapRaw:wrap,fundingQuoteRequiredRaw:input.toString()},[m.manager,m.tokenAddress,WBNB]);return {...plan,action:'buy',kind:'wrap'};}
  const data=abi.encodeFunctionData(buy?'buy':'sell',buy?(m.variant==='soft'?[m.tokenAddress,minimum]:[m.tokenAddress,input,minimum]):[m.tokenAddress,target,minimum]);
  return c.finalize(m,p,w,{to:m.manager,inputData:data,value:buy&&m.variant==='soft'?input:0n,spendAsset:buy?m.quote.address:m.tokenAddress,spendRaw:input,
   expectedRaw:expected,minimumRaw:minimum,amountRaw:target,actualTokenAmount:formatUnits(buy?expected:target,m.base.decimals)},[m.manager,m.tokenAddress,m.quote.address]);
 }
 async function recheck(p){const m=await inspect(p.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);if(m.taxed!==p.taxed||m.agentGate!==p.agentGate||m.walletCap!==p.walletCap||JSON.stringify(m.taxConfig)!==JSON.stringify(p.taxConfig))throw fault('PREVIEW_EXPIRED');
  const h=await holdings(m,p.wallet);if(m.agentGate&&!h.eligible)throw fault('GANG_AGENT_ID_REQUIRED');if(p.action==='buy'&&BigInt(p.amountRaw)>BigInt(h.buyableRaw))throw fault('BUY_LIMIT_EXCEEDED');await c.recheckCommon(p,m);}
 return {rpc,inspect,inspectAt,locate,holdings,build,recheck};
}
function events(rec,address,abi,name){return (rec.logs||[]).filter(l=>same(l.address,address)).flatMap(l=>{try{const e=abi.parseLog(l);return e?.name===name?[e.args]:[];}catch{return [];}});}
const net=(rec,token,w)=>events(rec,token,erc20Abi,'Transfer').reduce((n,e)=>n+(same(e.to,w)?e.value:0n)-(same(e.from,w)?e.value:0n),0n);
export function gangReceipt(p,rec){
 if(p.kind==='wrap'){const e=events(rec,WBNB,wrapAbi,'Deposit').filter(e=>same(e.dst,p.wallet));if(e.length!==1||e[0].wad!==BigInt(p.wrapRaw)||BigInt(p.tx.value)!==e[0].wad)throw fault('TRADE_SETTLEMENT_MISMATCH');return {receivedAmount:formatUnits(e[0].wad,18),message:'BNB 已兑换为 WBNB。请重新核对买入报价；本次没有买入代币。'};}
 const buy=p.kind==='buy',soft=p.variant==='soft',list=events(rec,p.manager,gangAbi(p),buy?'Buy':'Sell').filter(e=>same(e.token,p.tokenAddress)&&same(buy?e.buyer:e.seller,p.wallet));
 if(list.length!==1)throw fault('TRADE_EVENT_MISSING');const e=list[0],base=net(rec,p.tokenAddress,p.wallet),fee=soft?e.fee:p.variant==='v3'?e.protocolFee+e.tax:e.taxDividend+e.taxPlatform;
 if(p.variant==='v3'&&e.tax!==0n)throw fault('TRADE_SETTLEMENT_MISMATCH');
 const received=buy?e.tokensOut:soft?e.bnbOut:e.quoteOut,spent=buy?(soft?e.bnbIn:e.quoteIn)+fee:e.tokensIn;
 if(received<=0n||received<BigInt(p.minimumRaw)||buy&&(base!==received||spent>BigInt(p.spendRaw))||!buy&&(spent!==BigInt(p.amountRaw)||base!==-spent))throw fault('TRADE_SETTLEMENT_MISMATCH');
 if(!soft&&net(rec,p.quote.address,p.wallet)!==(buy?-spent:received))throw fault('TRADE_SETTLEMENT_MISMATCH');
 const deferred=soft&&events(rec,p.manager,gangSoftAbi,'PaymentDeferred').some(e=>same(e.to,p.wallet));
 return {receivedAmount:formatUnits(received,buy?p.base.decimals:p.quote.decimals),spentRaw:spent.toString(),executedTokenAmount:formatUnits(buy?received:spent,p.base.decimals),
  message:deferred?'内盘交易已确认，但 BNB 支付被合约暂存，需要在 Gang 提取。':`${buy?'买入':'卖出'}已确认，收到 ${formatUnits(received,buy?p.base.decimals:p.quote.decimals)} ${buy?p.base.symbol:p.quote.symbol}。`};
}
