import {Interface,zeroPadValue,toBeHex} from 'ethers';
import {createHash} from 'node:crypto';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {OPENFOUR} from './openfour-reader.mjs';
import {registryAbi,coreAbi} from './openfour-abi.mjs';
import {FLAP_MARKET,marketViewAbi} from './flap-market.mjs';
import {createPanelChain,safeText} from './panel-chain.mjs';
import {reviewedFlapDeployments,sameAgentPreset,agentPresetKeys} from './reviewed-modes.mjs';
import {ZERO,tokenAddress,hex} from './four-reader.mjs';
import {launchAbi,SCAN_SOURCES} from './chain-scanner.mjs';
import {createGangModeChain} from './gang-mode-chain.mjs';
export const modeAbi=new Interface([
 'function getPresetIdsCount() view returns(uint256)',
 'function getPresetIdsByBatch(uint256 index,uint256 count) view returns(uint256[] ids)',
 'function marketCount() view returns(uint256)','function markets(uint256) view returns(address)',
 'function factory() view returns(address)','function marketOfToken(address) view returns(address)',
 'event PresetUpserted(uint256 indexed presetId,bool active,bool createEnabled)'
]);
export const modeDigest=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex');
const HASH=/^0x[\da-f]{64}$/i;
export function firstCreation(logs,{platform,emitter,presetId,marketAddress}){
 const event=platform==='four'?SCAN_SOURCES[0].event:'MarketCreated',topic=launchAbi.getEvent(event).topicHash;
 if(!Array.isArray(logs)||logs.length>10000)throw fault('MODE_HISTORY_INCOMPLETE');
 const rows=logs.map(l=>{
  if(l.removed||!same(l.address,emitter)||!same(l.topics?.[0],topic)||!HASH.test(l.blockHash||'')||!HASH.test(l.transactionHash||'')||!/^0x[\da-f]+$/i.test(l.blockNumber||'')||!/^0x[\da-f]+$/i.test(l.logIndex||''))throw fault('MODE_EVENT_INVALID');
  const a=launchAbi.decodeEventLog(event,l.data,l.topics);
  if(platform==='four'&&a.presetId!==BigInt(presetId)||marketAddress&&!same(a.market,marketAddress))throw fault('MODE_EVENT_INVALID');
  return {tokenAddress:tokenAddress(a.token??a.predictedToken),marketAddress:a.market||null,blockNumber:Number(BigInt(l.blockNumber)),blockHash:l.blockHash,txHash:l.transactionHash,logIndex:Number(BigInt(l.logIndex))};
 });
 return rows.sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex)[0]||null;
}
export function createModeChain({rpc=createFlapRpc({url:process.env.YESP_RPC_URL||'https://bsc-dataseed.bnbchain.org',timeoutMs:10000}),
 logsRpc=createFlapRpc({url:process.env.YESP_SCAN_RPC_URL||'https://bsc-rpc.publicnode.com',timeoutMs:10000}),clock=Date.now,deployments=reviewedFlapDeployments}={}){
 const chain=createPanelChain(rpc,clock),call=async(to,abi,name,args=[],block='latest')=>abi.decodeFunctionResult(name,await rpc('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block]));
 const gang=createGangModeChain({rpc,logsRpc,clock});
 async function head(){const {block,at}=await chain.head(),header=await rpc('eth_getBlockByNumber',[block,false]);if(!HASH.test(header?.hash||''))throw fault('MODE_BLOCK_INVALID');return {number:Number(BigInt(block)),hash:header.hash,time:at,tag:block};}
 async function canonical(block){const h=await rpc('eth_getBlockByNumber',[hex(block.number),false]);if(!same(h?.hash,block.hash))throw fault('MODE_REORG');}
 async function four(){
  const h=await head(),[core]=await call(OPENFOUR.registry,registryAbi,'openFourCore',[],h.tag);if(!same(core,OPENFOUR.core))throw fault('OPENFOUR_CORE_CHANGED');
  const [count]=await call(OPENFOUR.registry,modeAbi,'getPresetIdsCount',[],h.tag);if(count>2000n)throw fault('MODE_CATALOG_LIMIT');const ids=[];
  for(let i=0n;i<count;i+=100n){const size=count-i<100n?count-i:100n,[part]=await call(OPENFOUR.registry,modeAbi,'getPresetIdsByBatch',[i,size],h.tag);if(part.length!==Number(size))throw fault('MODE_CATALOG_INCOMPLETE');ids.push(...part.map(String));}
  if(new Set(ids).size!==ids.length)throw fault('MODE_CATALOG_INCOMPLETE');
  const [reference]=await call(OPENFOUR.registry,registryAbi,'getPreset',[OPENFOUR.presetId],h.tag),[referenceImpl]=await call(OPENFOUR.registry,registryAbi,'getPresetTokenImpl',[OPENFOUR.presetId],h.tag);
  const rows=[];for(let i=0;i<ids.length;i+=8)rows.push(...await Promise.all(ids.slice(i,i+8).map(async id=>{
   const [p]=await call(OPENFOUR.registry,registryAbi,'getPreset',[id],h.tag);if(String(p.id)!==id)throw fault('MODE_BINDING_MISMATCH');
   let compatible=sameAgentPreset(p,reference);if(compatible){const [impl]=await call(OPENFOUR.registry,registryAbi,'getPresetTokenImpl',[id],h.tag);compatible=same(impl,referenceImpl);}
   return {id:`four:${core.toLowerCase()}:${id}`,platform:'four',name:safeText(p.name)||'Four preset '+id,presetId:id,emitter:core,registry:OPENFOUR.registry,
    adapter:compatible?'openfour-agent-v1':null,ready:compatible&&p.active&&p.createEnabled,reason:!compatible?'MODE_ADAPTER_REQUIRED':!p.active||!p.createEnabled?'MODE_NOT_OPEN':null,
    fingerprint:modeDigest([core,id,...agentPresetKeys.map(k=>p[k]),compatible?referenceImpl:null]),sourceUrl:'https://github.com/four-meme-community/openfour-docs'};
  })));
  await canonical(h);return {block:h,rows};
 }
 async function flap(discovered){
  const h=await head(),approved=deployments(),all=[...approved];
  if(discovered&&!all.some(d=>same(d.factory,discovered.factory)))all.push({...discovered,name:'Flap 新部署 · 待适配',adapter:null,sourceUrl:'https://flap.sh/apps/agent-bonding-curve?lang=zh'});
  const rows=[];for(const d of all){
   for(const k of ['factory','portal','reader'])tokenAddress(d[k]);
   let count=null;
   try{const [[factory],[portalFactory],[value]]=await Promise.all([call(d.reader,modeAbi,'factory',[],h.tag),call(d.portal,modeAbi,'factory',[],h.tag),call(d.factory,modeAbi,'marketCount',[],h.tag)]);
    if(!same(factory,d.factory)||!same(portalFactory,d.factory)||value>BigInt(Number.MAX_SAFE_INTEGER))throw fault('MODE_BINDING_MISMATCH');count=value;
   }catch(e){if(d.adapter)throw e;}
   if(d.reviewedFingerprints&&modeDigest(await chain.fingerprints([d.factory,d.portal,d.reader],h.tag))!==modeDigest(d.reviewedFingerprints))throw fault('MODE_CODE_CHANGED');
   rows.push({id:'flap:'+d.factory.toLowerCase(),platform:'flap',name:safeText(d.name),factory:d.factory,portal:d.portal,reader:d.reader,emitter:d.factory,sourceUrl:d.sourceUrl,
    adapter:d.adapter||null,ready:Boolean(d.adapter),reason:d.adapter?null:'MODE_ADAPTER_REQUIRED',tokenCount:count===null?null:Number(count),fingerprint:modeDigest([d.factory,d.portal,d.reader,d.adapter,d.reviewedFingerprints||null])});
  }
  await canonical(h);return {block:h,rows};
 }
 async function earliest(mode){
  if(mode.platform==='gang')return gang.earliest(mode);
  const h=await head(),confirmed=h.number-2;if(confirmed<0)return {first:null,complete:false};
  if(mode.absence)await canonical(mode.absence);
  if(mode.coveredHash)await canonical({number:mode.coveredThrough,hash:mode.coveredHash});
  if(mode.platform==='flap'){
   const [count]=await call(mode.factory,modeAbi,'marketCount',[],hex(confirmed));if(count===0n)return {first:null,complete:true,through:confirmed};
   const [market]=await call(mode.factory,modeAbi,'markets',[0],hex(confirmed));tokenAddress(market);
   const [cards]=await call(mode.reader,marketViewAbi,'marketCards',[[market]],hex(confirmed));if(cards.length!==1||!same(cards[0].market,market))throw fault('MODE_BINDING_MISMATCH');
   const token=tokenAddress(cards[0].predictedToken),[bound]=await call(mode.factory,modeAbi,'marketOfToken',[token],hex(confirmed));if(!same(bound,market))throw fault('MODE_BINDING_MISMATCH');
   // markets(0) is global sequence one, independent of any short log window.
   return {first:{tokenAddress:token,marketAddress:market,sequence:1,proof:'factory-index-zero',observedBlock:confirmed,observedAt:clock()},complete:true,through:confirmed};
  }
  if(!mode.absence)throw fault('MODE_HISTORY_UNVERIFIED');
  if(BigInt(await logsRpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
  const start=mode.absence.number+1;if(start>confirmed)return {first:null,complete:true,through:confirmed};
  const from=mode.coveredThrough===undefined?start:Math.max(start,mode.coveredThrough-3);
  // Never jump over a failed range. Backfill in bounded chunks before choosing.
  const to=Math.min(confirmed,from+5999);const logs=await logsRpc('eth_getLogs',[{address:mode.emitter,topics:[launchAbi.getEvent(SCAN_SOURCES[0].event).topicHash,zeroPadValue(toBeHex(BigInt(mode.presetId)),32)],fromBlock:hex(from),toBlock:hex(to)}]);
  if(logs.some(l=>Number(BigInt(l.blockNumber))<from||Number(BigInt(l.blockNumber))>to))throw fault('MODE_EVENT_INVALID');
  const first=firstCreation(logs,{platform:'four',emitter:mode.emitter,presetId:mode.presetId});
  if(first){const b=await rpc('eth_getBlockByNumber',[hex(first.blockNumber),false]);if(!same(b?.hash,first.blockHash))throw fault('MODE_REORG');first.createdAt=Number(BigInt(b.timestamp))*1000;
   const [cfg]=[await call(mode.emitter,coreAbi,'tokens',[first.tokenAddress],hex(confirmed))];if(!cfg.exists||String(cfg.presetId)!==mode.presetId||!same(cfg.token,first.tokenAddress))throw fault('MODE_BINDING_MISMATCH');
   first.proof='preset-absence-and-contiguous-events';}
  const throughHeader=await rpc('eth_getBlockByNumber',[hex(to),false]);if(!HASH.test(throughHeader?.hash||''))throw fault('MODE_BLOCK_INVALID');
  return {first,complete:to===confirmed,through:to,throughHash:throughHeader.hash};
 }
 async function verifyFirst(mode,first){
  if(mode.platform==='gang')return gang.verifyFirst(mode,first);
  if(mode.platform==='flap'){const result=await earliest({...mode,coveredThrough:undefined});if(!result.first||!same(result.first.tokenAddress,first.tokenAddress)||!same(result.first.marketAddress,first.marketAddress))throw fault('MODE_FIRST_CHANGED');return;}
  await canonical(mode.absence);await canonical({number:first.blockNumber,hash:first.blockHash});
  const logs=await logsRpc('eth_getLogs',[{address:mode.emitter,topics:[launchAbi.getEvent(SCAN_SOURCES[0].event).topicHash,zeroPadValue(toBeHex(BigInt(mode.presetId)),32)],fromBlock:hex(first.blockNumber),toBlock:hex(first.blockNumber)}]);
  const found=firstCreation(logs,{platform:'four',emitter:mode.emitter,presetId:mode.presetId});if(!found||!same(found.tokenAddress,first.tokenAddress)||found.logIndex!==first.logIndex||!same(found.txHash,first.txHash))throw fault('MODE_FIRST_CHANGED');
 }
 return {four,flap,gang:gang.catalog,earliest,verifyFirst,canonical};
}
