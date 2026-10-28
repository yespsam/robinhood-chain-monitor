import {keccak256} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {batchedRpc} from './batched-rpc.mjs';
import {GANG_PADS,gangAbi} from './gang-reader.mjs';
import {createPanelChain,safeText} from './panel-chain.mjs';
import {ZERO,tokenAddress} from './four-reader.mjs';
import {boundedText} from './mode-sources.mjs';
// A bounded on-chain directory. API supplies display metadata only; never a spender or transaction.
export function gangDirectoryRpc(base=createFlapRpc({url:process.env.YESP_GANG_RPC_URL||process.env.YESP_RPC_URL||'https://bsc-dataseed.bnbchain.org',timeoutMs:12000}),{spacingMs=200,maxBatch=5}={}){
 let tail=Promise.resolve();return batchedRpc({batch:calls=>{const pending=tail.then(()=>base.batch(calls));tail=pending.catch(()=>{}).then(()=>new Promise(resolve=>setTimeout(resolve,spacingMs)));return pending;}},{maxBatch});
}
export function createGangDiscovery({rpc=gangDirectoryRpc(),fetcher=fetch,clock=Date.now,pads=GANG_PADS}={}){
 const c=createPanelChain(rpc,clock),addresses=new Map();
 async function read(){const head=await c.head(),meta=new Map();let apiError=false;
  const lists=await Promise.allSettled(['/tokens?sort=new&limit=100','/stocks/tokens?sort=new&limit=200','/v3/tokens?status=all&limit=100'].map(p=>boundedText('https://gang.fun/api'+p,{fetcher}).then(JSON.parse)));
  for(const r of lists){if(r.status==='rejected'||!Array.isArray(r.value.items)){apiError=true;continue;}for(const row of r.value.items.slice(0,200)){try{meta.set(tokenAddress(row.address).toLowerCase(),row);}catch{}}}
  const rows=[];let total=0;
  // Calls are batched and bounded, retaining latest 100 per pad; no unlimited history scan.
  for(const pad of pads){const abi=gangAbi(pad),[code,[count]]=await Promise.all([rpc('eth_getCode',[pad.address,head.block]),c.call(pad.address,abi,'tokenCount',[],head.block)]);
   if(keccak256(code)!==pad.hash)throw fault('GANG_CONTRACT_CHANGED');if(count>1000000n)throw fault('GANG_DIRECTORY_INVALID');total+=Number(count);
   const start=Math.max(0,Number(count)-100),candidates=[];
   for(let i=start;i<Number(count);i+=20){const chunk=await Promise.all(Array.from({length:Math.min(20,Number(count)-i)},async(_,j)=>{
    const index=i+j,key=pad.address+':'+index;let ca=addresses.get(key);
    // Recheck newest entries to avoid trusting a transient/reorged last token.
    if(!ca||index>=Number(count)-3){ca=tokenAddress((await c.call(pad.address,abi,'allTokens',[index],head.block))[0]);addresses.set(key,ca);}
    return {ca,index};}));candidates.push(...chunk);}
   for(let i=0;i<candidates.length;i+=20)rows.push(...await Promise.all(candidates.slice(i,i+20).map(async({ca,index})=>{
    if(pad.variant==='v3'&&(await c.call(pad.address,abi,'kindOf',[ca],head.block))[0]!==1n)return null;
    const s=await c.call(pad.address,abi,'curves',[ca],head.block);if(same(s.creator,ZERO))throw fault('GANG_DIRECTORY_INVALID');const api=meta.get(ca.toLowerCase()),graduated=s.graduated;
    const grad=pad.variant==='soft'?20000000000000000000n:s.gradAmt,reserve=pad.variant==='soft'?s.realBnb:s.realQuote;
    return {id:'gang:'+ca.toLowerCase(),platform:'Gang',tokenAddress:ca,manager:pad.address,variant:pad.variant,creator:s.creator,
     name:safeText(api?.name||'Gang 代币'),symbol:safeText(api?.symbol||ca.slice(0,8)),mode:graduated?'已毕业 · PancakeSwap':`Gang ${pad.variant.toUpperCase()} 内盘`,
     phase:graduated?3:1,progressBps:graduated?'10000':String(grad>0n?reserve*10000n/grad:0n),source:'gang-agent-directory',creationId:index+1,
     chainTimestamp:Number.isSafeInteger(api?.createdAt)?api.createdAt*1000:null,metadataRef:typeof api?.logoUrl==='string'?api.logoUrl.slice(0,1600):null,
     confirmed:true,directoryBlock:Number(BigInt(head.block)),stale:false};
   })));
  }
  while(addresses.size>800)addresses.delete(addresses.keys().next().value);
  const curves=rows.filter(Boolean);curves.sort((a,b)=>(b.chainTimestamp||0)-(a.chainTimestamp||0)||b.creationId-a.creationId);
  return {rows:curves,total,externalShown:curves.filter(r=>r.phase===3).length,updatedAt:clock(),apiError,limited:curves.length<total};
 }
 return {read};
}
