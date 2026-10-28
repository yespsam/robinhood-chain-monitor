import {validateSlippageBps} from '../extension/slippage-policy.js';
import {Interface,formatUnits,parseUnits,keccak256} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {ZERO,erc20Abi,hex,tokenAddress} from './four-reader.mjs';
import {coreAbi,registryAbi,toolsAbi,feeAbi} from './openfour-abi.mjs';
import {sameAgentPreset} from './reviewed-modes.mjs';
export const OPENFOUR={registry:'0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94',core:'0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3',
  wrappedNative:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',presetId:'1778027615735'};
export const moduleAbi=new Interface(['function descriptor() view returns(bytes8 tagId,string tag,string version)',
  ...['fourCore','quoteAsset','quote','founder','implementation'].map(n=>`function ${n}() view returns(address)`),
  ...['phase','remainingForSale','totalRaised','buyFeeRate','sellFeeRate','rateFounder','rateHolder','rateBurn','rateLiquidity'].map(n=>`function ${n}() view returns(uint256)`),
  'function evaluate((address token,address trader,uint256 amount,bool isBuy,uint256 timestamp,uint256 blockNumber,uint256 remainingForSale,uint256 totalRaised,uint256 curveQuote,bytes proof) ctx) view returns((bool allowed,uint256 minAmount,uint256 maxAmount,(address recipient,uint16 bps)[] fees,string reason) result)']);
const TAGS={token:'token.tax.binance_agent',tokenModule:'module.token.binance_agent',vault:'module.vault.tax_bonding',
  curveModule:'module.curve.bonding_binance_agent',tradeModule:'module.trade.tax_bonding_binance_agent',migrateModule:'module.migrate.pcs_v2'};
const TAX_FIELDS=['buyFeeRate','sellFeeRate','rateFounder','rateHolder','rateBurn','rateLiquidity'];
const MODULE_KEYS=['tokenModuleId','vaultModuleId','curveModuleId','tradeModuleId','migrateModuleId'];
// EIP-1967 implementation and beacon slots; also track registry beacons and EIP-1167 clones.
const SLOTS=['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc','0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'];
export function openFourError(error){
  const raw=JSON.stringify(error?.rpcError||{}).toLowerCase();
  for(const [selector,code] of Object.entries({'0x96ea0b74':'OPENFOUR_AGENT_ID_REQUIRED','0xe8c402c1':'OPENFOUR_HOLD_CAP','0x687d0d11':'OPENFOUR_HOLD_CAP',
    '0x63d7653c':'OPENFOUR_PRESALE_UNSUPPORTED','0xa6708f30':'OPENFOUR_TRANSFER_LOCKED'}))if(raw.includes(selector))return fault(code);
  return error;
}
function quantity(value,decimals){try{const n=parseUnits(value,decimals);if(n<=0n||n>=1n<<256n)throw Error();return n;}catch{throw fault('AMOUNT_PRECISION');}}
function binding(m){return JSON.stringify([m.manager,m.tools,m.feeRouter,m.quoteAsset,m.base.decimals,m.quote.decimals,m.runtime,m.preset,m.tags,m.tax,m.feeConfig]);}
export function createOpenFourReader({rpc=createFlapRpc({timeoutMs:10000}),clock=Date.now}={}){
  async function call(to,abi,name,args=[],block='latest',from=ZERO){
    try{return abi.decodeFunctionResult(name,await rpc('eth_call',[{to,from,data:abi.encodeFunctionData(name,args)},block]));}catch(e){throw openFourError(e);}
  }
  const one=async(to,abi,name,args=[],block='latest',from=ZERO)=>(await call(to,abi,name,args,block,from))[0];
  async function head(){
    if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
    const block=await rpc('eth_blockNumber',[]),h=await rpc('eth_getBlockByNumber',[block,false]),time=Number(BigInt(h?.timestamp||0))*1000;
    if(h?.number!==block||clock()-time>30000||time-clock()>5000)throw fault('STALE_BLOCK');return {block,timestamp:String(BigInt(h.timestamp))};
  }
  async function asset(address,block){
    if(same(address,ZERO))return {address:ZERO,decimals:18,symbol:'BNB'};
    const [decimals,symbol]=await Promise.all(['decimals','symbol'].map(n=>one(address,erc20Abi,n,[],block)));
    if(decimals>36n)throw fault('TOKEN_DECIMALS_UNSUPPORTED');
    return {address,decimals:Number(decimals),symbol:String(symbol).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,64)};
  }
  async function inspect(address){
    const token=tokenAddress(address),{block,timestamp}=await head();
    const [manager,tools]=await Promise.all(['openFourCore','openFourTool'].map(n=>one(OPENFOUR.registry,registryAbi,n,[],block)));
    // A registry upgrade to a different Core requires review before it can receive user funds.
    if(!same(manager,OPENFOUR.core))throw fault('OPENFOUR_CORE_CHANGED');tokenAddress(tools);
    const cfg=await call(manager,coreAbi,'tokens',[token],block);
    if(!cfg.exists||!same(cfg.token,token))throw fault('NOT_FOUR_TOKEN');
    const quoteAsset=tokenAddress(cfg.quoteAsset),native=same(quoteAsset,OPENFOUR.wrappedNative);
    const [base,quote,preset]=await Promise.all([asset(token,block),asset(native?ZERO:quoteAsset,block),one(OPENFOUR.registry,registryAbi,'getPreset',[cfg.presetId],block)]);
    const runtime=JSON.parse(JSON.stringify(cfg.toObject(),(_,v)=>typeof v==='bigint'?v.toString():v));
    const basic={protocol:'openfour-agent',chainId:'56',tokenAddress:token,manager,tools,quoteAsset,base,quote,block,timestamp,runtime,
      preset:JSON.parse(JSON.stringify(preset.toObject(),(_,v)=>typeof v==='bigint'?v.toString():v)),presetId:cfg.presetId.toString(),version:Number(cfg.version),
      funds:'—',maxFunds:formatUnits(cfg.raiseAmount,quote.decimals),liquidityAdded:false};
    if(cfg.presetId.toString()!==OPENFOUR.presetId){
      const reference=await one(OPENFOUR.registry,registryAbi,'getPreset',[OPENFOUR.presetId],block);
      if(!sameAgentPreset(preset,reference))return {...basic,supported:false,blockers:['OPENFOUR_PRESET_UNSUPPORTED']};
      const [actualImpl,approvedImpl]=await Promise.all([cfg.presetId,OPENFOUR.presetId].map(id=>one(OPENFOUR.registry,registryAbi,'getPresetTokenImpl',[id],block)));
      if(!same(actualImpl,approvedImpl))return {...basic,supported:false,blockers:['OPENFOUR_PRESET_UNSUPPORTED']};
    }
    const [registry,wrappedNative,feeRouter,paused,toolsCore,vaultCore,vaultQuote,phase,remaining,raised,tokenQuote,founder,taxes,tags]=await Promise.all([
      ...['registry','wrappedNative','feeRouter','paused'].map(n=>one(manager,coreAbi,n,[],block)),one(tools,toolsAbi,'core',[],block),
      ...['fourCore','quoteAsset','phase','remainingForSale','totalRaised'].map(n=>one(cfg.vault,moduleAbi,n,[],block)),
      one(token,moduleAbi,'quote',[],block),one(token,moduleAbi,'founder',[],block),
      Promise.all(TAX_FIELDS.map(n=>one(token,moduleAbi,n,[],block))),
      Promise.all(Object.keys(TAGS).map(async k=>[k,(await call(cfg[k],moduleAbi,'descriptor',[],block)).toObject()])).then(Object.fromEntries)]);
    if(!same(registry,OPENFOUR.registry)||!same(wrappedNative,OPENFOUR.wrappedNative)||!same(toolsCore,manager)||!same(vaultCore,manager)
      ||!same(vaultQuote,quoteAsset)||!same(tokenQuote,quoteAsset)||preset.id!==cfg.presetId)throw fault('MARKET_BINDING_CHANGED');
    tokenAddress(feeRouter);
    const feeConfig=(await call(feeRouter,feeAbi,'feeConfig',[],block)).map(String),blockers=[];
    if(cfg.version!==1n||preset.version!=='1.0.0'||Object.keys(TAGS).some(k=>tags[k].tag!==TAGS[k]||tags[k].version!==(k==='token'?'1':'1.0.0'))||!same(cfg.customData,ZERO))blockers.push('OPENFOUR_MODULE_UNSUPPORTED');
    if(paused||cfg.paused||!preset.active)blockers.push('OPENFOUR_PAUSED');
    if(phase!==1n)blockers.push(phase===2n||phase===3n?'FOUR_MIGRATED':'OPENFOUR_NOT_TRADING');
    if(taxes[0]>1000n||taxes[1]>1000n||(taxes[0]+taxes[1]>0n&&taxes.slice(2).reduce((a,b)=>a+b,0n)!==100n))blockers.push('OPENFOUR_TAX_UNSUPPORTED');
    const tax=Object.fromEntries(TAX_FIELDS.map((n,i)=>[n,taxes[i].toString()]));tax.founder=founder;
    return {...basic,adapter:blockers.includes('OPENFOUR_MODULE_UNSUPPORTED')?null:'openfour-agent-v1',feeRouter,feeConfig,tags,tax,phase:phase.toString(),status:phase.toString(),liquidityAdded:phase===3n,
      remainingRaw:remaining.toString(),fundsRaw:raised.toString(),funds:formatUnits(raised,quote.decimals),offers:formatUnits(remaining,base.decimals),
      holdCapRaw:(cfg.maxSupply/100n).toString(),holdCap:formatUnits(cfg.maxSupply/100n,base.decimals),transferLocked:phase!==2n&&phase!==3n,
      supported:!blockers.length,blockers};
  }
  async function fingerprints(m){
    const beacons=await Promise.all(MODULE_KEYS.map(k=>one(OPENFOUR.registry,registryAbi,'getModuleBeacon',[m.preset[k]],m.block)));
    const tokenImpl=await one(OPENFOUR.registry,registryAbi,'getPresetTokenImpl',[m.presetId],m.block);
    const beaconImpls=await Promise.all(beacons.map(b=>one(tokenAddress(b),moduleAbi,'implementation',[],m.block)));
    const addresses=[OPENFOUR.registry,m.manager,m.tools,m.feeRouter,m.quoteAsset,...Object.keys(TAGS).map(k=>m.runtime[k]),tokenImpl,...beacons,...beaconImpls];
    const seen=new Set(),rows={};
    async function inspectCode(value,depth=0){
      const address=tokenAddress(value);if(seen.has(address))return;if(depth>4)throw fault('OPENFOUR_MODULE_UNSUPPORTED');seen.add(address);
      const [code,...slots]=await Promise.all([rpc('eth_getCode',[address,m.block]),...SLOTS.map(s=>rpc('eth_getStorageAt',[address,s,m.block]))]);
      if(!/^0x(?:[\da-f]{2})+$/i.test(code)||slots.some(s=>!/^0x[\da-f]{64}$/i.test(s)))throw fault('TOKEN_NOT_CONTRACT');
      rows[address]={codeHash:keccak256(code),slots};
      for(let i=0;i<slots.length;i++)if(BigInt(slots[i])){
        const target=tokenAddress('0x'+slots[i].slice(-40));await inspectCode(target,depth+1);
        if(i===1)await inspectCode(await one(target,moduleAbi,'implementation',[],m.block),depth+1);
      }
      const clone=code.match(/^0x363d3d373d3d3d363d73([\da-f]{40})5af43d82803e903d91602b57fd5bf3/i);if(clone)await inspectCode('0x'+clone[1],depth+1);
    }
    await Promise.all(addresses.map(a=>inspectCode(a)));
    return Object.fromEntries(Object.entries(rows).sort(([a],[b])=>a.localeCompare(b)));
  }
  const balance=async(a,w,b)=>same(a,ZERO)?BigInt(await rpc('eth_getBalance',[w,b])):await one(a,erc20Abi,'balanceOf',[w],b);
  async function account(w,b){
    const [native,nonce,pending]=await Promise.all([rpc('eth_getBalance',[w,b]),rpc('eth_getTransactionCount',[w,b]),rpc('eth_getTransactionCount',[w,'pending'])]);
    if(BigInt(nonce)!==BigInt(pending))throw fault('PENDING_TRANSACTION');return {native:BigInt(native),nonce};
  }
  async function holdings(m,w){
    const [base,quote,native]=await Promise.all([balance(m.tokenAddress,w,m.block),balance(m.quote.address,w,m.block),balance(ZERO,w,m.block)]);
    const room=m.holdCapRaw===undefined?null:(BigInt(m.holdCapRaw)>base?BigInt(m.holdCapRaw)-base:0n);
    const buyable=room===null||m.remainingRaw===undefined?null:(room<BigInt(m.remainingRaw)?room:BigInt(m.remainingRaw));
    return {base:formatUnits(base,m.base.decimals),quote:formatUnits(quote,m.quote.decimals),native:formatUnits(native,18),holdRoom:room===null?null:formatUnits(room,m.base.decimals),
      buyable:buyable===null?null:formatUnits(buyable,m.base.decimals)};
  }
  async function gate(m,w,action,amount,curveQuote=0n){
    const ctx=[m.tokenAddress,w,amount,action==='buy',m.timestamp,m.block,m.remainingRaw,m.fundsRaw,curveQuote,'0x'];
    const result=await one(m.runtime.tradeModule,moduleAbi,'evaluate',[ctx],m.block,w);
    if(!result.allowed)throw fault(/agent|wallet/i.test(result.reason)?'OPENFOUR_AGENT_ID_REQUIRED':'OPENFOUR_TRADE_DENIED');
  }
  async function quote(m,w,action,raw,quantityBuy=false){
    const held=await balance(m.tokenAddress,w,m.block),room=BigInt(m.holdCapRaw)>held?BigInt(m.holdCapRaw)-held:0n;
    // This panel is for ordinary trading, never creator presale in the creation block.
    if(BigInt(m.block)===BigInt(m.runtime.createBlock))throw fault('OPENFOUR_PRESALE_UNSUPPORTED');
    if(action==='buy'&&room===0n)throw fault('OPENFOUR_HOLD_CAP');
    if(quantityBuy&&raw>room)throw fault('OPENFOUR_BUY_LIMIT');
    if(quantityBuy&&raw>BigInt(m.remainingRaw))throw fault('FOUR_QUANTITY_UNAVAILABLE');
    await gate(m,w,action,action==='buy'&&!quantityBuy?1n:raw);
    // The non-view Tools methods are deliberately invoked only through eth_call.
    const est=await one(m.tools,toolsAbi,action==='buy'?(quantityBuy?'estimateBuy':'estimateBuyByBudget'):'estimateSell',[m.tokenAddress,w,raw,0,'0x'],m.block,w);
    if(est.tokenAmount<=0n||est.curveQuote<=0n)throw fault('FOUR_QUOTE_UNAVAILABLE');
    if(action==='buy'&&(est.userPays!==est.curveQuote+est.totalFee||!quantityBuy&&est.userPays>raw||est.tokenAmount>room)
      ||action==='sell'&&(est.userReceives<=0n||est.userReceives+est.totalFee!==est.curveQuote||est.tokenAmount>raw))throw fault('FOUR_BUDGET_EXCEEDED');
    if(quantityBuy&&est.tokenAmount!==raw)throw fault('FOUR_QUANTITY_UNAVAILABLE');
    await gate(m,w,action,est.tokenAmount,est.curveQuote);return {est,room};
  }
  async function simulate(tx){try{return BigInt(await rpc('eth_estimateGas',[{from:tx.from,to:tx.to,value:tx.value,data:tx.inputData}]));}catch(e){throw openFourError(e);}}
  async function build(p,wallet){
    wallet=tokenAddress(wallet);const m=await inspect(p.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);
    const quantityBuy=p.action==='buy'&&p.buyMode==='tokenAmount';
    const raw=quantity(p.amount,p.action==='buy'&&!quantityBuy?m.quote.decimals:m.base.decimals),bps=validateSlippageBps(p.slippageBps);
    if(!['buy','sell'].includes(p.action))throw fault('INVALID_REQUEST');
    const [{est,room},a]=await Promise.all([quote(m,wallet,p.action,raw,quantityBuy),account(wallet,m.block)]);
    const buy=p.action==='buy',expected=buy?est.tokenAmount:est.userReceives,min=quantityBuy?raw:expected*(10000n-bps)/10000n;
    if(min<=0n)throw fault('FOUR_QUOTE_UNAVAILABLE');
    const spendAsset=buy?m.quote.address:m.tokenAddress,required=quantityBuy?(est.userPays*(10000n+bps)+9999n)/10000n:raw,available=await balance(spendAsset,wallet,m.block);
    if(required>=1n<<256n)throw fault('AMOUNT_PRECISION');
    if(available<required)throw fault('INSUFFICIENT_BALANCE',buy?{funding:{assetAddress:m.quote.address,symbol:m.quote.symbol,required:formatUnits(required,m.quote.decimals),available:formatUnits(available,m.quote.decimals),shortfall:formatUnits(required-available,m.quote.decimals)}}:{});
    let kind=p.action,to=m.manager,value=buy&&same(spendAsset,ZERO)?required:0n,approvalRaw=null,approvalToken=null;
    let inputData=coreAbi.encodeFunctionData(buy?(quantityBuy?'buy':'buyByBudget'):'sell',[m.tokenAddress,raw,quantityBuy?required:min,0,'0x']);
    if(!same(spendAsset,ZERO)){
      const allowance=await one(spendAsset,erc20Abi,'allowance',[wallet,m.manager],m.block);
      if(allowance<required){kind='approve';approvalRaw=allowance>0n?'0':required.toString();approvalToken=spendAsset;to=spendAsset;value=0n;
        inputData=erc20Abi.encodeFunctionData('approve',[m.manager,approvalRaw]);}
    }
    const tx={from:wallet,to,value:hex(value),inputData};
    const [gas,price,identity]=await Promise.all([simulate(tx),rpc('eth_gasPrice',[]),fingerprints(m)]),fee=gas*BigInt(price);
    if(a.native<value+(fee*2n>100000000000000n?fee*2n:100000000000000n))throw fault('INSUFFICIENT_GAS');
    return {...m,action:p.action,kind,wallet,amount:p.amount,amountRaw:raw.toString(),...(quantityBuy?{buyMode:'tokenAmount'}:{}),slippageBps:p.slippageBps,nonce:a.nonce,
      expectedRaw:expected.toString(),minimumRaw:min.toString(),spendRaw:required.toString(),spendAsset,approvalRaw,approvalToken,
      approvalAmount:approvalRaw===null?null:formatUnits(approvalRaw,buy?m.quote.decimals:m.base.decimals),
      expected:formatUnits(expected,buy?m.base.decimals:m.quote.decimals),minimum:formatUnits(min,buy?m.base.decimals:m.quote.decimals),minimumKind:'net',
      spend:formatUnits(required,buy?m.quote.decimals:m.base.decimals),estimatedSpend:formatUnits(buy?est.userPays:est.tokenAmount,buy?m.quote.decimals:m.base.decimals),
      available:formatUnits(available,buy?m.quote.decimals:m.base.decimals),holdRoom:formatUnits(room,m.base.decimals),
      totalFeeRaw:est.totalFee.toString(),totalFee:formatUnits(est.totalFee,m.quote.decimals),curveQuoteRaw:est.curveQuote.toString(),
      estimatedGas:formatUnits(fee,18),nativeValue:formatUnits(value,18),identity,tx};
  }
  async function recheck(plan){
    const m=await inspect(plan.tokenAddress);if(!m.supported)throw fault(m.blockers[0]);
    const quantityBuy=plan.action==='buy'&&plan.buyMode==='tokenAmount';
    const [a,identity,{est}]=await Promise.all([account(plan.wallet,m.block),fingerprints(m),quote(m,plan.wallet,plan.action,BigInt(plan.amountRaw),quantityBuy)]);
    const expected=plan.action==='buy'?est.tokenAmount:est.userReceives;
    if(a.nonce!==plan.nonce||binding(m)!==binding(plan)||JSON.stringify(identity)!==JSON.stringify(plan.identity)||expected<BigInt(plan.minimumRaw)
      ||quantityBuy&&est.userPays>BigInt(plan.spendRaw))throw fault('PREVIEW_EXPIRED');
    // Do not permit a higher effective fee rate after review, including preset fee overrides.
    // Four fee components are integer-rounded; allow only their rounding error on each quote.
    if(est.totalFee*BigInt(plan.curveQuoteRaw)>BigInt(plan.totalFeeRaw)*est.curveQuote+4n*(est.curveQuote+BigInt(plan.curveQuoteRaw)))throw fault('PREVIEW_EXPIRED');
    if(await balance(plan.spendAsset,plan.wallet,m.block)<BigInt(plan.spendRaw))throw fault('INSUFFICIENT_BALANCE');
    const gas=await simulate(plan.tx),fee=gas*BigInt(await rpc('eth_gasPrice',[]));
    if(a.native<BigInt(plan.tx.value)+(fee*2n>100000000000000n?fee*2n:100000000000000n))throw fault('INSUFFICIENT_GAS');
  }
  return {rpc,inspect,holdings,build,recheck,fingerprints};
}
