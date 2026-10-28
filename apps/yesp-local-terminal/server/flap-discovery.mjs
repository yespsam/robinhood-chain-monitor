import {Interface} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {FLAP_MARKET,marketViewAbi} from './flap-market.mjs';
import {tokenAddress,ZERO} from './four-reader.mjs';
import {safeText} from './panel-chain.mjs';

// The official Agent Bonding Curve app uses this on-chain directory as its
// fallback for New Markets. A short getLogs window cannot reconstruct it.
export const discoveryAbi=new Interface([
 'function factory() view returns(address)',
 'function marketCount() view returns(uint256)',
 'function marketPage(uint256 cursor,uint256 limit) view returns(address[] marketAddresses,uint256 nextCursor,uint256 total)'
]);
export function createFlapDiscovery({rpc=createFlapRpc({url:process.env.YESP_RPC_URL||'https://bsc-dataseed.bnbchain.org',timeoutMs:10000}),clock=Date.now,limit=100}={}){
 if(!Number.isInteger(limit)||limit<1||limit>200)throw fault('INVALID_REQUEST');
 const call=async(to,name,args,block)=>discoveryAbi.decodeFunctionResult(name,await rpc('eth_call',[{to,data:discoveryAbi.encodeFunctionData(name,args)},block]));
 return {async read(){
  if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
  const block=await rpc('eth_blockNumber',[]),header=await rpc('eth_getBlockByNumber',[block,false]);
  const at=Number(BigInt(header?.timestamp||0))*1000;
  if(header?.number!==block||clock()-at>30000||at-clock()>5000)throw fault('STALE_BLOCK');
  const [[factory],[total]]=await Promise.all([call(FLAP_MARKET.reader,'factory',[],block),call(FLAP_MARKET.factory,'marketCount',[],block)]);
  if(!same(factory,FLAP_MARKET.factory)||total>BigInt(Number.MAX_SAFE_INTEGER))throw fault('DISCOVERY_BINDING_MISMATCH');
  const count=total<BigInt(limit)?total:BigInt(limit),start=total-count,rows=[];
  for(let offset=start;offset<total;offset+=16n){
   const size=total-offset<16n?total-offset:16n;
   const [addresses,next,pageTotal]=await call(FLAP_MARKET.reader,'marketPage',[offset,size],block);
   if(addresses.length!==Number(size)||next!==offset+size||pageTotal!==total)throw fault('DISCOVERY_PAGE_MISMATCH');
   const [cards]=marketViewAbi.decodeFunctionResult('marketCards',await rpc('eth_call',[{to:FLAP_MARKET.reader,data:marketViewAbi.encodeFunctionData('marketCards',[addresses])},block]));
   if(cards.length!==addresses.length)throw fault('DISCOVERY_PAGE_MISMATCH');
   for(let i=0;i<cards.length;i++){
    const c=cards[i],phase=Number(c.phase),marketAddress=tokenAddress(addresses[i]),predictedToken=tokenAddress(c.predictedToken);
    if(!same(c.market,marketAddress)||![1,2,3].includes(phase)||c.capRaw<=0n||phase===3&&same(c.token,ZERO))throw fault('DISCOVERY_BINDING_MISMATCH');
    rows.push({id:'flap:'+marketAddress.toLowerCase(),platform:'Flap',mode:phase===1?'Agent 虚拟份额':phase===2?'Agent 毕业处理中':'Agent 已毕业',
     source:'flap-agent-directory',marketAddress,predictedToken,tokenAddress:phase===3?tokenAddress(c.token):predictedToken,
     name:safeText(c.name),symbol:safeText(c.symbol),metadataRef:String(c.meta).slice(0,1600),phase,creationId:Number(offset)+i+1,quoteToken:c.quoteToken,
     progressBps:c.progressBps.toString(),buyCount:c.buyCount.toString(),sellCount:c.sellCount.toString(),
     // Sequence number is not a timestamp or a creation block.
     blockNumber:null,chainTimestamp:null,txHash:null,snapshotBlock:Number(BigInt(block)),confirmed:true});
   }
  }
  if(new Set(rows.map(r=>r.marketAddress.toLowerCase())).size!==rows.length||new Set(rows.map(r=>r.tokenAddress.toLowerCase())).size!==rows.length)throw fault('DISCOVERY_DUPLICATE');
  return {total:Number(total),updatedAt:clock(),rows:rows.reverse()};
 }};
}
