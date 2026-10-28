import {validateSlippageBps} from '../extension/slippage-policy.js';
import {Interface,getAddress,formatUnits,parseUnits,keccak256} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
export const ZERO='0x0000000000000000000000000000000000000000';
export const FOUR={chainId:'56',helper:'0xF251F83e40a78868FcfA3FA4599Dad6494E46034',v1:'0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC',v2:'0x5c952063c7fc8610FFDB798152D69F0B9550762b'};
export const helperAbi=new Interface([
  'function getTokenInfo(address) view returns(uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)',
  'function tryBuy(address,uint256,uint256) view returns(address tokenManager,address quote,uint256 estimatedAmount,uint256 estimatedCost,uint256 estimatedFee,uint256 amountMsgValue,uint256 amountApproval,uint256 amountFunds)',
  'function trySell(address,uint256) view returns(address tokenManager,address quote,uint256 funds,uint256 fee)']);
export const managerAbi=new Interface([
  'function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)',
  'function _tokenInfoEx1s(address) view returns(uint256 launchFee,uint256 pcFee,uint256 feeSetting,uint256 blockNumber,uint256 extraFee)',
  'function buyTokenAMAP(address,uint256,uint256) payable',
  'function buyToken(address,uint256,uint256) payable',
  'function sellToken(uint256,address,uint256,uint256,uint256,address)',
  'event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
  'event TokenSale(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)']);
export const erc20Abi=new Interface(['function decimals() view returns(uint8)','function symbol() view returns(string)','function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const SLOTS=['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc','0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'];
const beaconAbi=new Interface(['function implementation() view returns(address)']);
export const hex=n=>'0x'+BigInt(n).toString(16);
export function tokenAddress(value){try{const v=getAddress(value);if(v===ZERO)throw Error();return v;}catch{throw fault('INVALID_ADDRESS');}}
function quantity(value,decimals){try{const n=parseUnits(value,decimals);if(n<=0n||n>=1n<<256n)throw Error();return n;}catch{throw fault('AMOUNT_PRECISION');}}
export function createFourReader({rpc=createFlapRpc({timeoutMs:10000}),clock=Date.now}={}) {
  async function call(to,abi,name,args=[],block='latest',from=ZERO){return abi.decodeFunctionResult(name,await rpc('eth_call',[{to,from,data:abi.encodeFunctionData(name,args)},block]));}
  async function head(){
    if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
    const block=await rpc('eth_blockNumber',[]),h=await rpc('eth_getBlockByNumber',[block,false]);
    const time=Number(BigInt(h?.timestamp||'0x0'))*1000;
    if(h?.number!==block||clock()-time>30000||time-clock()>5000)throw fault('STALE_BLOCK');return block;
  }
  async function asset(address,block){
    if(same(address,ZERO))return {address:ZERO,decimals:18,symbol:'BNB'};
    const decimals=Number((await call(address,erc20Abi,'decimals',[],block))[0]);
    if(!Number.isInteger(decimals)||decimals<0||decimals>36)throw fault('TOKEN_DECIMALS_UNSUPPORTED');
    const symbol=String((await call(address,erc20Abi,'symbol',[],block))[0]).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,64);
    return {address,decimals,symbol};
  }
  async function inspect(address){
    const token=tokenAddress(address),block=await head(),info=await call(FOUR.helper,helperAbi,'getTokenInfo',[token],block);
    if(![1n,2n].includes(info.version)||!same(info.tokenManager,info.version===1n?FOUR.v1:FOUR.v2))throw fault('NOT_FOUR_TOKEN');
    const [base,quote]=await Promise.all([asset(token,block),asset(info.quote,block)]);
    let template=0n,feeSetting=0n,status=info.liquidityAdded?3n:0n;
    if(info.version===2n){
      const [ti,ex]=await Promise.all([call(FOUR.v2,managerAbi,'_tokenInfos',[token],block),call(FOUR.v2,managerAbi,'_tokenInfoEx1s',[token],block)]);
      if(!same(ti.base,token)||!same(ti.quote,info.quote))throw fault('MARKET_BINDING_CHANGED');
      template=ti.template;feeSetting=ex.feeSetting;status=ti.status;
    }
    const creatorType=Number((template>>10n)&63n),blockers=[];
    if(info.version!==2n)blockers.push('FOUR_V1_READ_ONLY');
    if(info.liquidityAdded||status===3n)blockers.push('FOUR_MIGRATED');
    if(template&0x10000n)blockers.push('FOUR_X_MODE');
    if([5,8,9].includes(creatorType))blockers.push('FOUR_TAX_MODE');
    if(feeSetting>0n)blockers.push('FOUR_ANTI_SNIPER');
    if(Number(info.launchTime)*1000>clock())blockers.push('FOUR_NOT_LAUNCHED');
    return {chainId:'56',tokenAddress:token,manager:getAddress(info.tokenManager),version:Number(info.version),base,quote,block,
      template:template.toString(),feeSetting:feeSetting.toString(),creatorType,liquidityAdded:info.liquidityAdded,status:status.toString(),
      tradingFeeRate:info.tradingFeeRate.toString(),minTradingFee:info.minTradingFee.toString(),
      remainingRaw:info.offers.toString(),offers:formatUnits(info.offers,base.decimals),funds:formatUnits(info.funds,quote.decimals),maxFunds:formatUnits(info.maxFunds,quote.decimals),
      supported:blockers.length===0,blockers};
  }
  async function fingerprints(m){
    const result={};
    for(const address of [...new Set([FOUR.helper,m.manager,m.tokenAddress,...(m.quote.address===ZERO?[]:[m.quote.address])])]){
      const code=await rpc('eth_getCode',[address,m.block]);if(!/^0x(?:[\da-f]{2})+$/i.test(code))throw fault('TOKEN_NOT_CONTRACT');
      const slots=await Promise.all(SLOTS.map(s=>rpc('eth_getStorageAt',[address,s,m.block])));
      if(slots.some(v=>!/^0x[\da-f]{64}$/i.test(v)))throw fault('INVALID_CHAIN_AMOUNT');
      const row={codeHash:keccak256(code),slots,implementations:{}};
      for(let i=0;i<slots.length;i++)if(BigInt(slots[i])!==0n){
        const target=tokenAddress('0x'+slots[i].slice(-40));
        const implementation=i===1?tokenAddress((await call(target,beaconAbi,'implementation',[],m.block))[0]):target;
        const implCode=await rpc('eth_getCode',[implementation,m.block]);if(!/^0x(?:[\da-f]{2})+$/i.test(implCode))throw fault('TOKEN_NOT_CONTRACT');
        row.implementations[target]={implementation,codeHash:keccak256(implCode)};
      }
      result[address]=row;
    }return result;
  }
  async function account(address,block){
    const [native,nonce,pending]=await Promise.all([rpc('eth_getBalance',[address,block]),rpc('eth_getTransactionCount',[address,block]),rpc('eth_getTransactionCount',[address,'pending'])]);
    if(BigInt(nonce)!==BigInt(pending))throw fault('PENDING_TRANSACTION');return {native:BigInt(native),nonce};
  }
  async function balance(a,w,block){return a===ZERO?BigInt(await rpc('eth_getBalance',[w,block])):(await call(a,erc20Abi,'balanceOf',[w],block))[0];}
  async function build(p,wallet){
    const m=await inspect(p.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);
    const quantityBuy=p.action==='buy'&&p.buyMode==='tokenAmount';
    const a=await account(wallet,m.block),bps=validateSlippageBps(p.slippageBps),raw=quantity(p.amount,p.action==='buy'&&!quantityBuy?m.quote.decimals:m.base.decimals);
    if(!['buy','sell'].includes(p.action))throw fault('INVALID_REQUEST');
    let estimate,expected,min,required=0n,value=0n,inputData,spendAsset,spendRaw,estimatedSpend,maximumCost,kind=p.action;
    if(p.action==='buy'){
      if(quantityBuy&&raw%1000000000n!==0n)throw fault('FOUR_GWEI_PRECISION');
      if(quantityBuy&&raw>BigInt(m.remainingRaw))throw fault('FOUR_QUANTITY_UNAVAILABLE');
      estimate=await call(FOUR.helper,helperAbi,'tryBuy',[m.tokenAddress,quantityBuy?raw:0n,quantityBuy?0n:raw],m.block,wallet);
      if(!same(estimate.tokenManager,m.manager)||!same(estimate.quote,m.quote.address))throw fault('MARKET_BINDING_CHANGED');
      expected=estimate.estimatedAmount;min=expected*(10000n-bps)/10000n;value=estimate.amountMsgValue;required=estimate.amountApproval;
      spendAsset=m.quote.address;spendRaw=spendAsset===ZERO?value:required;
      if(expected<=0n||spendRaw<=0n)throw fault('FOUR_QUOTE_UNAVAILABLE');
      if(quantityBuy){
        if(expected!==raw)throw fault('FOUR_QUANTITY_UNAVAILABLE');
        if(spendRaw<estimate.estimatedCost+estimate.estimatedFee)throw fault('FOUR_BUDGET_EXCEEDED');
        estimatedSpend=spendRaw;min=raw;
        maximumCost=(estimate.estimatedCost*(10000n+bps)+9999n)/10000n;
        const feeAtCap=(maximumCost*BigInt(m.tradingFeeRate)+9999n)/10000n;
        const feeCap=feeAtCap>BigInt(m.minTradingFee)?feeAtCap:BigInt(m.minTradingFee);
        const fixedExtra=spendRaw-estimate.estimatedCost-estimate.estimatedFee;
        spendRaw=maximumCost+feeCap+fixedExtra;
        if(spendRaw>=1n<<256n)throw fault('AMOUNT_PRECISION');
        value=spendAsset===ZERO?spendRaw:0n;required=spendAsset===ZERO?0n:spendRaw;
        inputData=managerAbi.encodeFunctionData('buyToken',[m.tokenAddress,raw,maximumCost]);
      }else{
        if(spendRaw>raw||estimate.amountFunds>raw||min<=0n)throw fault('FOUR_BUDGET_EXCEEDED');
        inputData=managerAbi.encodeFunctionData('buyTokenAMAP',[m.tokenAddress,estimate.amountFunds,min]);
      }
    }else{
      if(raw%1000000000n!==0n)throw fault('FOUR_GWEI_PRECISION');
      estimate=await call(FOUR.helper,helperAbi,'trySell',[m.tokenAddress,raw],m.block,wallet);
      if(!same(estimate.tokenManager,m.manager)||!same(estimate.quote,m.quote.address))throw fault('MARKET_BINDING_CHANGED');
      expected=estimate.funds;min=((estimate.funds+estimate.fee)*(10000n-bps)+9999n)/10000n;
      if(expected<=0n||min<=0n)throw fault('FOUR_QUOTE_UNAVAILABLE');
      required=raw;spendAsset=m.tokenAddress;spendRaw=raw;
      inputData=managerAbi.encodeFunctionData('sellToken',[0,m.tokenAddress,raw,min,0,ZERO]);
    }
    const available=await balance(spendAsset,wallet,m.block);if(available<spendRaw)throw fault('INSUFFICIENT_BALANCE',p.action==='buy'?{funding:{assetAddress:m.quote.address,symbol:m.quote.symbol,required:formatUnits(spendRaw,m.quote.decimals),available:formatUnits(available,m.quote.decimals),shortfall:formatUnits(spendRaw-available,m.quote.decimals)}}:{});
    let approvalRaw=null,approvalToken=null,to=m.manager;
    if(spendAsset!==ZERO){
      const allowance=(await call(spendAsset,erc20Abi,'allowance',[wallet,m.manager],m.block))[0];
      if(allowance<required){kind='approve';approvalRaw=allowance>0n?'0':required.toString();approvalToken=spendAsset;
        to=spendAsset;inputData=erc20Abi.encodeFunctionData('approve',[m.manager,approvalRaw]);value=0n;}
    }
    const tx={from:wallet,to,value:hex(value),inputData};
    const [gas,price,identity]=await Promise.all([rpc('eth_estimateGas',[{from:wallet,to,value:tx.value,data:inputData}]),rpc('eth_gasPrice',[]),fingerprints(m)]);
    const fee=BigInt(gas)*BigInt(price),reserve=fee*2n>100000000000000n?fee*2n:100000000000000n;
    if(a.native<value+reserve)throw fault('INSUFFICIENT_GAS');
    return {...m,action:p.action,kind,wallet,amount:p.amount,amountRaw:raw.toString(),slippageBps:p.slippageBps,nonce:a.nonce,
      ...(quantityBuy?{buyMode:'tokenAmount',estimatedSpend:formatUnits(estimatedSpend,m.quote.decimals),maximumCostRaw:maximumCost.toString()}:{}),
      expectedRaw:expected.toString(),minimumRaw:min.toString(),spendRaw:spendRaw.toString(),spendAsset,approvalRaw,approvalToken,
      approvalAmount:approvalRaw===null?null:formatUnits(approvalRaw,p.action==='buy'?m.quote.decimals:m.base.decimals),
      expected:formatUnits(expected,p.action==='buy'?m.base.decimals:m.quote.decimals),minimum:formatUnits(min,p.action==='buy'?m.base.decimals:m.quote.decimals),
      spend:formatUnits(spendRaw,p.action==='buy'?m.quote.decimals:m.base.decimals),available:formatUnits(available,p.action==='buy'?m.quote.decimals:m.base.decimals),
      protocolFee:formatUnits(p.action==='buy'?estimate.estimatedFee:estimate.fee,m.quote.decimals),estimatedGas:formatUnits(fee,18),
      nativeValue:formatUnits(value,18),identity,tx};
  }
  async function recheck(plan){
    const m=await inspect(plan.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);
    const a=await account(plan.wallet,m.block);
    if(a.nonce!==plan.nonce||m.template!==plan.template||m.feeSetting!==plan.feeSetting||m.tradingFeeRate!==plan.tradingFeeRate||m.minTradingFee!==plan.minTradingFee
      ||!same(m.manager,plan.manager)||!same(m.quote.address,plan.quote.address)||m.base.decimals!==plan.base.decimals||m.quote.decimals!==plan.quote.decimals
      ||JSON.stringify(await fingerprints(m))!==JSON.stringify(plan.identity))throw fault('PREVIEW_EXPIRED');
    // Re-simulate the exact reviewed calldata. Never silently replace it with a new quote.
    const gas=BigInt(await rpc('eth_estimateGas',[{from:plan.wallet,to:plan.tx.to,value:plan.tx.value,data:plan.tx.inputData}]));
    const fee=gas*BigInt(await rpc('eth_gasPrice',[]));if(a.native<BigInt(plan.tx.value)+(fee*2n>100000000000000n?fee*2n:100000000000000n))throw fault('INSUFFICIENT_GAS');
  }
  async function holdings(m,w){const [base,quote,native]=await Promise.all([balance(m.tokenAddress,w,m.block),balance(m.quote.address,w,m.block),rpc('eth_getBalance',[w,m.block])]);return {base:formatUnits(base,m.base.decimals),quote:formatUnits(quote,m.quote.decimals),native:formatUnits(BigInt(native),18)};}
  return {rpc,inspect,holdings,build,recheck};
}
