import {Interface,keccak256,formatUnits,parseUnits} from 'ethers';
import {fault,same,BEACON_SLOT} from './flap-reader.mjs';
import {erc20Abi,ZERO,hex,tokenAddress} from './four-reader.mjs';
const IMPL='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const beaconAbi=new Interface(['function implementation() view returns(address)']);
export const rawAmount=(value,decimals)=>{try{const n=parseUnits(value,decimals);if(n<=0n||n>=1n<<256n)throw Error();return n;}catch{throw fault('AMOUNT_PRECISION');}};
export const minBig=(a,b)=>a<b?a:b;
export const safeText=s=>String(s).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,80);
export function createPanelChain(rpc,clock=Date.now){
 const call=async(to,abi,name,args=[],block='latest',from=ZERO)=>abi.decodeFunctionResult(name,await rpc('eth_call',[{to,from,data:abi.encodeFunctionData(name,args)},block]));
 async function head(){const [chain,block]=await Promise.all([rpc('eth_chainId',[]),rpc('eth_blockNumber',[])]);if(BigInt(chain)!==56n)throw fault('WRONG_NETWORK');const h=await rpc('eth_getBlockByNumber',[block,false]);
  const at=Number(BigInt(h?.timestamp||0))*1000;if(h?.number!==block||clock()-at>30000||at-clock()>5000)throw fault('STALE_BLOCK');return {block,at};}
 async function asset(address,block){if(same(address,ZERO))return {address:ZERO,decimals:18,symbol:'BNB'};
  const [d,s]=await Promise.all([call(address,erc20Abi,'decimals',[],block),call(address,erc20Abi,'symbol',[],block)]);
  if(d[0]>36n)throw fault('TOKEN_DECIMALS_UNSUPPORTED');return {address:tokenAddress(address),decimals:Number(d[0]),symbol:safeText(s[0])};}
 const balance=async(a,w,b)=>same(a,ZERO)?BigInt(await rpc('eth_getBalance',[w,b])):(await call(a,erc20Abi,'balanceOf',[w],b))[0];
 async function account(w,b){const [native,nonce,pending]=await Promise.all([balance(ZERO,w,b),rpc('eth_getTransactionCount',[w,b]),rpc('eth_getTransactionCount',[w,'pending'])]);
  if(BigInt(nonce)!==BigInt(pending))throw fault('PENDING_TRANSACTION');return {native,nonce};}
 async function fingerprints(addresses,block){const out={};
  async function visit(address,depth=0){if(same(address,ZERO)||out[address.toLowerCase()])return;if(depth>5)throw fault('CONTRACT_GRAPH_UNSUPPORTED');
   address=tokenAddress(address);const [code,...slots]=await Promise.all([rpc('eth_getCode',[address,block]),... [IMPL,BEACON_SLOT].map(s=>rpc('eth_getStorageAt',[address,s,block]))]);
   if(!/^0x(?:[\da-f]{2})+$/i.test(code)||slots.some(s=>!/^0x[\da-f]{64}$/i.test(s)))throw fault('TOKEN_NOT_CONTRACT');
   out[address.toLowerCase()]={hash:keccak256(code),slots};
   if(BigInt(slots[0]))await visit('0x'+slots[0].slice(-40),depth+1);
   if(BigInt(slots[1])){const beacon=tokenAddress('0x'+slots[1].slice(-40)),impl=(await call(beacon,beaconAbi,'implementation',[],block))[0];out[address.toLowerCase()].beaconImpl=impl;await visit(beacon,depth+1);await visit(impl,depth+1);}
   const clone=code.match(/^0x363d3d373d3d3d363d73([\da-f]{40})5af43d82803e903d91602b57fd5bf3$/i);if(clone)await visit('0x'+clone[1],depth+1);
  }
  for(const a of addresses)await visit(a);return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));}
 async function finalize(m,p,w,trade,addresses){
  const needsAllowance=trade.spendAsset!==null&&!same(trade.spendAsset,ZERO);
  const [a,available,allowanceRow]=await Promise.all([account(w,m.block),trade.spendAsset===null?0n:balance(trade.spendAsset,w,m.block),needsAllowance?call(trade.spendAsset,erc20Abi,'allowance',[w,m.manager],m.block):null]);
  if(trade.spendAsset!==null&&available<trade.spendRaw)throw fault('INSUFFICIENT_BALANCE',p.action==='buy'?{funding:{assetAddress:m.quote.address,symbol:m.quote.symbol,required:formatUnits(trade.spendRaw,m.quote.decimals),available:formatUnits(available,m.quote.decimals),shortfall:formatUnits(trade.spendRaw-available,m.quote.decimals)}}:{});
  let kind=p.action,to=trade.to,inputData=trade.inputData,value=trade.value||0n,approvalRaw=null,approvalToken=null;
  if(trade.spendAsset!==null&&!same(trade.spendAsset,ZERO)){
   const allowance=allowanceRow[0];
   if(allowance<trade.spendRaw){kind='approve';approvalRaw=allowance>0n?'0':trade.spendRaw.toString();approvalToken=trade.spendAsset;to=approvalToken;inputData=erc20Abi.encodeFunctionData('approve',[m.manager,approvalRaw]);value=0n;}}
  const tx={from:w,to,value:hex(value),inputData};
  const [gas,price,identity]=await Promise.all([rpc('eth_estimateGas',[{from:w,to,value:tx.value,data:inputData}]),rpc('eth_gasPrice',[]),fingerprints(addresses,m.block)]);
  const fee=BigInt(gas)*BigInt(price),reserve=fee*2n>100000000000000n?fee*2n:100000000000000n;
  if(a.native<value+reserve)throw fault('INSUFFICIENT_GAS');
  const buy=p.action==='buy',outDecimals=buy||p.action==='claim'?m.base.decimals:m.quote.decimals,inDecimals=buy?m.quote.decimals:m.base.decimals;
  return JSON.parse(JSON.stringify({...m,...trade,action:p.action,kind,wallet:w,amount:p.amount,slippageBps:p.slippageBps,buyMode:buy?'tokenAmount':undefined,nonce:a.nonce,
   tx,identity,identityAddresses:addresses,approvalRaw,approvalToken,approvalAmount:approvalRaw===null?null:formatUnits(approvalRaw,inDecimals),
   expected:formatUnits(trade.expectedRaw,outDecimals),minimum:formatUnits(trade.minimumRaw,outDecimals),spend:formatUnits(trade.spendRaw,inDecimals),available:formatUnits(available,inDecimals),
   estimatedSpend:buy?formatUnits(trade.spendRaw,m.quote.decimals):undefined,estimatedGas:formatUnits(fee,18),nativeValue:formatUnits(value,18)},(_,v)=>typeof v==='bigint'?v.toString():v));
 }
 async function recheckCommon(p,m){
  const a=await account(p.wallet,m.block);
  if(a.nonce!==p.nonce||p.protocol!==m.protocol||p.phase!==m.phase||!same(m.manager,p.manager)||!same(m.quote.address,p.quote.address)||p.base.decimals!==m.base.decimals||p.quote.decimals!==m.quote.decimals
   ||JSON.stringify(await fingerprints(p.identityAddresses,m.block))!==JSON.stringify(p.identity))throw fault('PREVIEW_EXPIRED');
  const gas=await rpc('eth_estimateGas',[{from:p.wallet,to:p.tx.to,value:p.tx.value,data:p.tx.inputData}]),fee=BigInt(gas)*BigInt(await rpc('eth_gasPrice',[]));
  if(a.native<BigInt(p.tx.value)+(fee*2n>100000000000000n?fee*2n:100000000000000n))throw fault('INSUFFICIENT_GAS');
 }
 return {rpc,call,head,asset,balance,account,fingerprints,finalize,recheckCommon};
}
