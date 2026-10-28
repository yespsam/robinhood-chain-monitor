import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {batchedRpc} from './batched-rpc.mjs';
import {createPanelChain,safeText} from './panel-chain.mjs';
import {OPENFOUR,moduleAbi} from './openfour-reader.mjs';
import {coreAbi,registryAbi} from './openfour-abi.mjs';
import {tokenAddress} from './four-reader.mjs';

// The official contract page requests this public index with templateId and
// status=TRADE for external markets. Index membership alone is not chain proof.
export const FOUR_DIRECTORY_URL='https://four.meme/meme-api/v1/public/token/search';
const labels=['Agent 待开盘','Agent 专属内盘','Agent 毕业处理中','Agent 已毕业','Agent 已终止','Agent 已售罄'];
export function createFourDiscovery({fetcher=fetch,rpc=batchedRpc(createFlapRpc({url:process.env.YESP_FOUR_SCAN_RPC_URL||process.env.YESP_SCAN_RPC_URL||'https://bsc-rpc.publicnode.com',timeoutMs:10000}),{maxBatch:10}),clock=Date.now,pageSize=50}={}){
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw fault('INVALID_REQUEST');
 const chain=createPanelChain(rpc,clock);let previous=new Map();
 async function page(status,type){
  const response=await fetcher(FOUR_DIRECTORY_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json'},
   body:JSON.stringify({pageIndex:1,pageSize,templateId:Number(OPENFOUR.presetId),status,type,sort:'DESC'})});
  if(!response.ok)throw fault('FOUR_DIRECTORY_UNAVAILABLE');
  let size=0;const chunks=[];for await(const part of response.body){size+=part.length;if(size>2000000){await response.body.cancel().catch(()=>{});throw fault('FOUR_DIRECTORY_INVALID');}chunks.push(part);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('FOUR_DIRECTORY_INVALID');}
  if(data?.code!==0||!Array.isArray(data.data)||data.data.length>pageSize)throw fault('FOUR_DIRECTORY_INVALID');
  const rows=data.data.map(r=>{
   if(String(r.templateId)!==OPENFOUR.presetId||r.networkCode!==0||!['PUBLISH','TRADE'].includes(r.status))throw fault('FOUR_DIRECTORY_BINDING');
   return {tokenAddress:tokenAddress(r.tokenAddress)};
  });
  if(new Set(rows.map(r=>r.tokenAddress.toLowerCase())).size!==rows.length)throw fault('FOUR_DIRECTORY_DUPLICATE');
  return {rows,limited:rows.length===pageSize};
 }
 async function verify(candidate,block){
  const ca=candidate.tokenAddress,cfg=await chain.call(OPENFOUR.core,coreAbi,'tokens',[ca],block);
  if(!cfg.exists||!same(cfg.token,ca)||String(cfg.presetId)!==OPENFOUR.presetId||cfg.createBlock>BigInt(block))throw fault('FOUR_DIRECTORY_BINDING');
  const [tag,[phase],[owner]]=await Promise.all([chain.call(ca,moduleAbi,'descriptor',[],block),chain.call(cfg.vault,moduleAbi,'phase',[],block),chain.call(cfg.vault,moduleAbi,'fourCore',[],block)]);
  if(tag.tag!=='token.tax.binance_agent'||tag.version!=='1'||!same(owner,OPENFOUR.core)||phase>5n)throw fault('FOUR_DIRECTORY_BINDING');
  // Never present a terminated token as a tradable launch.
  if(phase===4n)return null;
  return {id:'four:'+ca.toLowerCase(),platform:'Four.meme',source:'four-agent-directory',tokenAddress:ca,
   name:safeText(cfg.name),symbol:safeText(cfg.symbol),creator:cfg.creator,presetId:String(cfg.presetId),phase:Number(phase),mode:labels[Number(phase)],
   blockNumber:Number(cfg.createBlock),snapshotBlock:Number(BigInt(block)),chainTimestamp:null,txHash:null,marketAddress:null,
   confirmed:BigInt(block)-cfg.createBlock>=2n,stale:false};
 }
 return {async read(){
  // External, newest and closest-to-graduation lists have independent budgets;
  // new creations cannot push all older external markets out of discovery.
  const [external,newest,near]=await Promise.all([page('TRADE','NEW'),page('PUBLISH','NEW'),page('PUBLISH','PROGRESS')]);
  const candidates=[...new Map([...external.rows,...newest.rows,...near.rows].map(r=>[r.tokenAddress.toLowerCase(),r])).values()];
  const {block}=await chain.head();const [core]=await chain.call(OPENFOUR.registry,registryAbi,'openFourCore',[],block);
  if(!same(core,OPENFOUR.core))throw fault('OPENFOUR_CORE_CHANGED');
  const rows=[];let unverified=0,rejected=0;
  for(let i=0;i<candidates.length;i+=8){
   const group=candidates.slice(i,i+8),results=await Promise.allSettled(group.map(r=>verify(r,block)));
   for(let j=0;j<results.length;j++){const result=results[j],key=group[j].tokenAddress.toLowerCase();
    if(result.status==='fulfilled'){if(result.value)rows.push(result.value);}
    else if(result.reason?.code==='FOUR_DIRECTORY_BINDING')rejected++;
    else{unverified++;const old=previous.get(key);if(old)rows.push({...old,stale:true});}
   }
  }
  previous=new Map(rows.map(r=>[r.tokenAddress.toLowerCase(),r]));
  return {rows:rows.sort((a,b)=>b.blockNumber-a.blockNumber),updatedAt:clock(),candidates:candidates.length,unverified,rejected,
   externalShown:rows.filter(r=>r.phase===3).length,pageSize,limited:external.limited||newest.limited||near.limited};
 }};
}
