import {Interface,toBeHex,zeroPadValue} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {FOUR,hex,tokenAddress} from './four-reader.mjs';
import {OPENFOUR} from './openfour-reader.mjs';
import {FLAP_MARKET,marketViewAbi} from './flap-market.mjs';
import {FLAP_PORTAL} from './flap-standard-reader.mjs';
import {safeText} from './panel-chain.mjs';
import {GANG_PADS,gangV2Abi,gangV3Abi} from './gang-reader.mjs';
import {createFlapDiscovery} from './flap-discovery.mjs';
export const launchAbi=new Interface([
 gangV2Abi.getEvent('Created'),
 gangV3Abi.getEvent('Created'),
 'event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)',
 'event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)',
 'event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)',
 'event MarketCreated(address indexed creator,address indexed market,address indexed predictedToken,address pair,bytes32 configHash)']);
export const SCAN_SOURCES=[
 {address:OPENFOUR.core,platform:'Four.meme',mode:'Binance Agent ID 专属内盘',presetId:OPENFOUR.presetId,event:'TokenCreated(uint256,uint256,address,address,string,string,uint256,uint256,uint256,uint256,address,address,address,address,address,address,address,string,uint256,bytes)'},
 {address:FLAP_MARKET.factory,platform:'Flap',mode:'Agent 虚拟份额',event:'MarketCreated'},
 {address:GANG_PADS[0].address,platform:'Gang',variant:'v2',mode:'Gang V2 内盘',event:'Created(address,address,string,string,string,bool,address,address,uint256)'},
 {address:GANG_PADS.find(p=>p.variant==='v3').address,platform:'Gang',variant:'v3',mode:'Gang V3 内盘',event:'Created(address,address,string,string,string,address,address,uint256)'}];
const HASH=/^0x[\da-f]{64}$/i;
export function decodeLaunch(log){
 const source=SCAN_SOURCES.find(s=>same(s.address,log.address)&&same(log.topics?.[0],launchAbi.getEvent(s.event).topicHash));if(!source)return null;
 if(log.removed||!HASH.test(log.blockHash||'')||!HASH.test(log.transactionHash||'')||!/^0x[\da-f]+$/i.test(log.blockNumber||'')||!/^0x[\da-f]+$/i.test(log.logIndex||''))throw fault('SCAN_LOG_INVALID');
 const a=launchAbi.decodeEventLog(source.event,log.data,log.topics);if(source.presetId&&a.presetId?.toString()!==source.presetId)return null;const token=tokenAddress(a.token??a.predictedToken);
 return {id:`${log.blockHash}:${log.transactionHash}:${log.logIndex}`,tokenAddress:token,platform:source.platform,mode:source.mode,...(source.variant?{variant:source.variant}:{}),
  name:safeText(a.name||'Agent 新市场'),symbol:safeText(a.symbol||'待查询'),creator:a.creator,marketAddress:a.market||null,metadataRef:typeof (a.tokenMetaUri??a.logoURI)==='string'?(a.tokenMetaUri??a.logoURI).slice(0,1600):null,
  presetId:a.presetId?.toString()||null,blockNumber:Number(BigInt(log.blockNumber)),blockHash:log.blockHash,txHash:log.transactionHash,logIndex:Number(BigInt(log.logIndex)),
  chainTimestamp:a.ts?Number(a.ts)*1000:null,launchTime:a.launchTime?Number(a.launchTime)*1000:null,confirmed:false};
}
export function createChainScanner({rpc=createFlapRpc({url:process.env.YESP_SCAN_RPC_URL||'https://bsc-rpc.publicnode.com',timeoutMs:10000}),clock=Date.now,intervalMs=2000,lookback=6000,chunk=6005,discovery=createFlapDiscovery(),directoryIntervalMs=15000,fourDiscovery=null,fourDirectoryIntervalMs=30000,gangDiscovery=null,gangDirectoryIntervalMs=30000,details=null}={}){
 let rows=[],timer=null,busy=false,cursor=null,head=null,error=null,updatedAt=0,ms=0,catchingUp=false;const listeners=new Set();
 let directory=null,directoryError=null,directoryAttempt=null,directoryBusy=false;
 let gangDirectory=null,gangDirectoryError=null,gangDirectoryAttempt=null,gangDirectoryBusy=false;
 let fourDirectory=null,fourDirectoryError=null,fourDirectoryAttempt=null,fourDirectoryBusy=false;
 function mergedRows(){
  const events=rows.map(r=>({...r,confirmed:head!==null&&head-r.blockNumber>=2}));
  const byMarket=new Map(events.filter(r=>r.marketAddress).map(r=>[r.marketAddress.toLowerCase(),r]));
  const catalog=(directory?.rows||[]).map(r=>{const candidate=byMarket.get(r.marketAddress.toLowerCase()),event=candidate&&same(candidate.tokenAddress,r.predictedToken||r.tokenAddress)?candidate:null;byMarket.delete(r.marketAddress.toLowerCase());return {...event,...r,...(event?{blockNumber:event.blockNumber,txHash:event.txHash,chainTimestamp:event.chainTimestamp,confirmed:event.confirmed}:{}),stale:Boolean(directoryError)};});
  const four=new Map(events.filter(r=>r.platform==='Four.meme').slice(0,100).map(r=>[r.tokenAddress.toLowerCase(),r]));
  for(const row of fourDirectory?.rows||[]){const event=four.get(row.tokenAddress.toLowerCase());four.set(row.tokenAddress.toLowerCase(),{...event,...row,
   ...(event?{id:event.id,blockHash:event.blockHash,txHash:event.txHash,chainTimestamp:event.chainTimestamp,seenAt:event.seenAt,confirmed:event.confirmed}:{}),stale:row.stale||Boolean(fourDirectoryError)});}
  const gang=new Map(events.filter(r=>r.platform==='Gang').map(r=>[r.tokenAddress.toLowerCase(),r]));
  for(const row of gangDirectory?.rows||[]){const event=gang.get(row.tokenAddress.toLowerCase());gang.set(row.tokenAddress.toLowerCase(),{...event,...row,...(event?{id:event.id,blockHash:event.blockHash,txHash:event.txHash,blockNumber:event.blockNumber,confirmed:event.confirmed}:{}),stale:Boolean(gangDirectoryError)});}
  return [...four.values(),...byMarket.values(),...catalog,...gang.values()];
 }
 const state=()=>({scope:'agentic-wallet',running:Boolean(timer),head,cursor,updatedAt,latencyMs:ms,error,catchingUp,intervalMs,
  gangDirectory:{shown:gangDirectory?.rows.length??0,total:gangDirectory?.total??0,externalShown:gangDirectory?.externalShown??0,updatedAt:gangDirectory?.updatedAt??0,error:gangDirectoryError},
  flapDirectory:{total:directory?.total??null,shown:directory?.rows.length??0,updatedAt:directory?.updatedAt??0,error:directoryError},
  fourDirectory:{shown:fourDirectory?.rows.length??0,externalShown:fourDirectory?.externalShown??0,unverified:fourDirectory?.unverified??0,rejected:fourDirectory?.rejected??0,limited:fourDirectory?.limited??false,pageSize:fourDirectory?.pageSize??null,updatedAt:fourDirectory?.updatedAt??0,error:fourDirectoryError},
  rows:mergedRows().map(r=>details?{...r,info:details.state(r)}:r)});
 const emit=()=>{for(const fn of listeners)try{fn(state());}catch{}};
 let detailTimer=null;details?.subscribe(()=>{if(!detailTimer)detailTimer=setTimeout(()=>{detailTimer=null;emit();},200);});
 async function refreshDirectory(){if(!discovery||directoryBusy||directoryAttempt!==null&&clock()-directoryAttempt<directoryIntervalMs)return;
  directoryBusy=true;directoryAttempt=clock();try{directory=await discovery.read();directoryError=null;}catch(e){directoryError=/^[A-Z][A-Z0-9_]{0,80}$/.test(e.code||'')?e.code:'FLAP_DIRECTORY_UNAVAILABLE';}finally{directoryBusy=false;details?.update(mergedRows());emit();}}
 async function refreshFourDirectory(){if(!fourDiscovery||fourDirectoryBusy||fourDirectoryAttempt!==null&&clock()-fourDirectoryAttempt<fourDirectoryIntervalMs)return;
  fourDirectoryBusy=true;fourDirectoryAttempt=clock();try{fourDirectory=await fourDiscovery.read();fourDirectoryError=null;}catch(e){fourDirectoryError=/^[A-Z][A-Z0-9_]{0,80}$/.test(e.code||'')?e.code:'FOUR_DIRECTORY_UNAVAILABLE';}finally{fourDirectoryBusy=false;details?.update(mergedRows());emit();}}
 async function refreshGangDirectory(){if(!gangDiscovery||gangDirectoryBusy||gangDirectoryAttempt!==null&&clock()-gangDirectoryAttempt<gangDirectoryIntervalMs)return;
  gangDirectoryBusy=true;gangDirectoryAttempt=clock();try{gangDirectory=await gangDiscovery.read();gangDirectoryError=null;}catch(e){gangDirectoryError=/^[A-Z][A-Z0-9_]{0,80}$/.test(e.code||'')?e.code:'GANG_DIRECTORY_UNAVAILABLE';}finally{gangDirectoryBusy=false;details?.update(mergedRows());emit();}}
 async function tick(){if(busy)return;busy=true;const start=clock();try{
  // Refresh the directory even if the event RPC cannot serve a historical range.
  void refreshDirectory();
  void refreshFourDirectory();
  void refreshGangDirectory();
  if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');const next=Number(BigInt(await rpc('eth_blockNumber',[])));
  if(!Number.isSafeInteger(next)||next<0)throw fault('SCAN_HEAD_INVALID');head=next;
  if(cursor===null)cursor=Math.max(0,head-lookback);
  // Overlap the last few blocks and replace their rows to handle reorgs.
  const from=Math.max(0,Math.min(cursor,head)-3),to=Math.min(head,from+chunk-1);
  const parts=await Promise.all(SCAN_SOURCES.map(s=>rpc('eth_getLogs',[{address:s.address,topics:[launchAbi.getEvent(s.event).topicHash,...(s.presetId?[zeroPadValue(toBeHex(BigInt(s.presetId)),32)]:[])],fromBlock:hex(from),toBlock:hex(to)}])));
  if(parts.some(p=>!Array.isArray(p)))throw fault('SCAN_LOG_INVALID');const logs=parts.flat();
  if(!Array.isArray(logs)||logs.length>10000)throw fault('SCAN_LOG_INVALID');const nextRows=[];
  const previous=new Map(rows.map(r=>[r.id,r]));
  for(const log of logs){const row=decodeLaunch(log);if(row){if(row.blockNumber<from||row.blockNumber>to)throw fault('SCAN_LOG_INVALID');const old=previous.get(row.id);row.seenAt=old?.seenAt??clock();if(old){row.name=old.name;row.symbol=old.symbol;}nextRows.push(row);}}
  const unnamed=nextRows.filter(r=>r.marketAddress&&r.symbol==='待查询');
  for(let i=0;i<unnamed.length;i+=30){const group=unnamed.slice(i,i+30);try{
   const result=await rpc('eth_call',[{to:FLAP_MARKET.reader,data:marketViewAbi.encodeFunctionData('marketCards',[group.map(r=>r.marketAddress)])},hex(to)]);
   const cards=marketViewAbi.decodeFunctionResult('marketCards',result)[0];
   for(const row of group){const card=cards.find(c=>same(c.market,row.marketAddress)&&same(c.predictedToken,row.tokenAddress));if(card){row.name=safeText(card.name);row.symbol=safeText(card.symbol);}}
  }catch{/* Creation evidence remains valid even when optional names cannot be read. */}}
  const byId=new Map([...rows.filter(r=>r.blockNumber<from||r.blockNumber>to),...nextRows].map(r=>[r.id,r]));
  rows=[...byId.values()].filter(r=>r.blockNumber<=head).sort((a,b)=>b.blockNumber-a.blockNumber||b.logIndex-a.logIndex).slice(0,200);
  cursor=to+1;catchingUp=to<head;error=null;updatedAt=clock();
 }catch(e){error=/^[A-Z][A-Z0-9_]{0,80}$/.test(e.code||'')?e.code:'SCAN_UNAVAILABLE';}finally{ms=clock()-start;busy=false;details?.update(mergedRows());emit();}}
 function start(){if(timer)return;timer=setInterval(tick,intervalMs);timer.unref?.();void tick();}
 function stop(){if(timer)clearInterval(timer);timer=null;clearTimeout(detailTimer);details?.stop();emit();}
 return {state,tick,start,stop,refreshDirectory,refreshFourDirectory,refreshGangDirectory,image:id=>details?.image(id),subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
}
