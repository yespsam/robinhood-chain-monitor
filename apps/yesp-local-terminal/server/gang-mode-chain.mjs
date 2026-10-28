import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Interface,keccak256} from 'ethers';
import {fault,same} from './flap-reader.mjs';
import {ZERO,tokenAddress,hex} from './four-reader.mjs';
import {createPanelChain} from './panel-chain.mjs';
import {GANG_PADS,gangV3Abi} from './gang-reader.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const HASH=/^0x[\da-f]{64}$/i,IMPL='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const gangModeAbi=new Interface([
 'function pads() view returns(address[])','function factories() view returns(address[])','function isFactory(address) view returns(bool)',
 'function moduleOf(address) view returns(address)','function handler() view returns(address)','function owner() view returns(address)',
 'function pad() view returns(address)','function admin() view returns(address)','function implementation() view returns(address)',
 'function factory() view returns(address)','function moduleType() view returns(bytes32)','function dev() view returns(address)',
 'function token() view returns(address)','function quote() view returns(address)','function buybackBps() view returns(uint16)',
 'function taxHandler() view returns(address)',
 gangV3Abi.getEvent('Created'),
 'event TaxConfigured(address indexed token,uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address indexed recipient)']);
const CREATED=gangModeAbi.getEvent('Created').topicHash,TAX=gangModeAbi.getEvent('TaxConfigured').topicHash;
const sourceUrl='https://github.com/gangfun/gang-launchpad/blob/main/docs/MAINNET-PAD-REGISTRY-2026-10-28.md';
export function reviewedGangModes(){return JSON.parse(readFileSync(new URL('../config/gang-modes.json',import.meta.url),'utf8'));}

export function createGangModeChain({rpc,logsRpc=rpc,clock=Date.now,config=reviewedGangModes(),deployments=GANG_PADS,chunk=6000}){
 const c=createPanelChain(rpc,clock),call=(to,name,args=[],block='latest')=>c.call(to,gangModeAbi,name,args,block);
 const factoryNodes=new Set(config.factories.flatMap(d=>[d.address.toLowerCase(),d.implementation.toLowerCase()]));
 const identities=d=>Object.fromEntries(Object.entries(config.fingerprints).filter(([a])=>!factoryNodes.has(a)||same(a,d?.address)||same(a,d?.implementation)));
 async function head(){const h=await c.head(),b=await rpc('eth_getBlockByNumber',[h.block,false]);if(!HASH.test(b?.hash||''))throw fault('MODE_BLOCK_INVALID');return {number:Number(BigInt(h.block)),tag:h.block,hash:b.hash,time:h.at};}
 async function canonical(number,hash){const b=await rpc('eth_getBlockByNumber',[hex(number),false]);if(!same(b?.hash,hash))throw fault('MODE_REORG');return b;}
 async function codeMatches(address,hash,block){if(keccak256(await rpc('eth_getCode',[address,block]))!==hash)throw fault('MODE_CODE_CHANGED');}
 async function infrastructure(block){
  await Promise.all(Object.entries(identities()).map(async([a,f])=>{await codeMatches(a,f.hash,block);if(same(a,config.registry)&&(await rpc('eth_getStorageAt',[a,IMPL,block])).toLowerCase()!==f.slots[0].toLowerCase())throw fault('MODE_CODE_CHANGED');}));
  const [[handler],[owner]]=await Promise.all([call(config.admin,'handler',[],block),call(config.handler,'owner',[],block)]);
  if(!same(handler,config.handler)||!same(owner,config.admin))throw fault('MODE_BINDING_MISMATCH');
 }
 async function definition(d,block){
  const pad=deployments.find(p=>same(p.address,d.pad||d.address)&&p.variant==='v3');if(!pad)throw fault('MODE_ADAPTER_REQUIRED');await codeMatches(pad.address,pad.hash,block);
  if(d.implementation){const [[p],[admin],[impl],[handler]]=await Promise.all([call(d.address,'pad',[],block),call(d.address,'admin',[],block),call(d.address,'implementation',[],block),call(pad.address,'taxHandler',[],block)]);
   if(!config.fingerprints[d.address.toLowerCase()]||!config.fingerprints[d.implementation.toLowerCase()])throw fault('MODE_ADAPTER_REQUIRED');
   await Promise.all([d.address,d.implementation].map(a=>codeMatches(a,config.fingerprints[a.toLowerCase()].hash,block)));
   if(!same(p,pad.address)||!same(admin,config.admin)||!same(impl,d.implementation)||!same(handler,config.handler))throw fault('MODE_BINDING_MISMATCH');}
 }
 async function catalog(){const h=await head();await infrastructure(h.tag);
  const [[pads],[factories]]=await Promise.all([call(config.registry,'pads',[],h.tag),call(config.admin,'factories',[],h.tag)]);
  if(pads.length>50||factories.length>50||new Set(pads.map(x=>x.toLowerCase())).size!==pads.length||new Set(factories.map(x=>x.toLowerCase())).size!==factories.length)throw fault('MODE_CATALOG_LIMIT');
  const rows=await Promise.all([...pads.map(address=>({address,family:'curve'})),...factories.map(address=>({address,family:'buyback'}))].map(async item=>{
   const {address,family}=item,d=(family==='curve'?config.pads:config.factories).find(x=>same(x.address,address));let allowed=true;
   if(family==='buyback')allowed=(await call(config.admin,'isFactory',[address],h.tag))[0];
   const hash=keccak256(await rpc('eth_getCode',[address,h.tag]));if(d)await definition(d,h.tag);
   const ready=Boolean(d&&allowed&&(family==='curve'||pads.some(p=>same(p,d.pad))));
   return {id:`gang:${family}:${address.toLowerCase()}`,platform:'gang',family,name:d?.name||'Gang 新登记合约 · 待核验',factory:family==='buyback'?address:null,
    manager:d?.pad||address,emitter:d?.pad||address,adapter:d?.adapter||null,fromBlock:d?.fromBlock,implementation:d?.implementation,sourceUrl,
    reviewedReports:d?.reviewedReports||{},ready,reason:!d?'MODE_ADAPTER_REQUIRED':!ready?'MODE_NOT_OPEN':null,
    fingerprint:digest([family,address.toLowerCase(),hash,d||null,identities(d)])};
  }));await canonical(h.number,h.hash);return {block:h,rows,revision:digest(rows.map(r=>[r.id,r.fingerprint,r.ready]).sort())};
 }
 function reviewed(mode){const d=(mode.family==='curve'?config.pads:config.factories).find(x=>same(x.address,mode.factory||mode.manager));if(!d||d.adapter!==mode.adapter||d.fromBlock!==mode.fromBlock)throw fault('MODE_ADAPTER_REQUIRED');return d;}
 function event(log){if(log.removed||!HASH.test(log.blockHash||'')||!HASH.test(log.transactionHash||'')||!/^0x[\da-f]+$/i.test(log.blockNumber||'')||!/^0x[\da-f]+$/i.test(log.logIndex||''))throw fault('MODE_EVENT_INVALID');return gangModeAbi.parseLog(log);}
 async function qualifies(mode,created,tax,block){
  if(mode.family==='curve')return {recipient:null};
  if(!tax||!same(tax.token,created.token))throw fault('MODE_EVENT_INVALID');
  const [factory]=await call(config.admin,'moduleOf',[tax.recipient],block);if(!same(factory,mode.factory))return null;
  const bytecode=await rpc('eth_getCode',[tax.recipient,block]);
  if(bytecode.toLowerCase()!==('0x363d3d373d3d3d363d73'+mode.implementation.slice(2)+'5af43d82803e903d91602b57fd5bf3').toLowerCase())throw fault('MODE_CODE_CHANGED');
  const [[dev],[pad],[boundFactory]]=await Promise.all([call(tax.recipient,'dev',[],block),call(tax.recipient,'pad',[],block),call(tax.recipient,'factory',[],block)]);
  if(!same(boundFactory,mode.factory)||!same(pad,mode.manager))throw fault('MODE_BINDING_MISMATCH');
  // Another creator may name a listed recipient; it cannot become that module's token.
  if(!same(dev,created.creator))return null;return {recipient:tax.recipient};
 }
 async function range(mode,from,to,block){
  if(BigInt(await logsRpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
  const logs=await logsRpc('eth_getLogs',[{address:mode.manager,topics:[[CREATED,TAX]],fromBlock:hex(from),toBlock:hex(to)}]);
  if(!Array.isArray(logs)||logs.length>10000)throw fault('MODE_HISTORY_INCOMPLETE');
  const entries=logs.map(l=>{if(!same(l.address,mode.manager)||Number(BigInt(l.blockNumber))<from||Number(BigInt(l.blockNumber))>to||![CREATED,TAX].some(t=>same(t,l.topics?.[0])))throw fault('MODE_EVENT_INVALID');return {l,e:event(l)};});
  const creations=entries.filter(x=>x.e.name==='Created').sort((a,b)=>Number(BigInt(a.l.blockNumber)-BigInt(b.l.blockNumber))||Number(BigInt(a.l.logIndex)-BigInt(b.l.logIndex)));
  for(const {l,e}of creations){const taxes=entries.filter(x=>x.e.name==='TaxConfigured'&&same(x.l.transactionHash,l.transactionHash)&&same(x.e.args.token,e.args.token));
   if(taxes.length!==1||!same(taxes[0].l.blockHash,l.blockHash))throw fault('MODE_EVENT_INVALID');
   const q=await qualifies(mode,e.args,taxes[0].e.args,block);if(!q)continue;
   const b=await canonical(Number(BigInt(l.blockNumber)),l.blockHash);
   return {tokenAddress:tokenAddress(e.args.token),quoteAddress:e.args.quote,creator:e.args.creator,recipient:q.recipient,blockNumber:Number(BigInt(l.blockNumber)),blockHash:l.blockHash,txHash:l.transactionHash,logIndex:Number(BigInt(l.logIndex)),createdAt:Number(BigInt(b.timestamp))*1000,proof:mode.family==='buyback'?'gang-official-module-contiguous-creations':'gang-v3-contiguous-creations',historyFrom:mode.fromBlock};
  }return null;
 }
 async function earliest(mode){reviewed(mode);const h=await head(),confirmed=h.number-2;if(confirmed<mode.fromBlock){if(mode.coveredThrough!==undefined)throw fault('MODE_REORG');return {first:null,complete:false};}
  await infrastructure(h.tag);await definition(reviewed(mode),h.tag);
  if(mode.coveredThrough!==undefined&&(!Number.isSafeInteger(mode.coveredThrough)||mode.coveredThrough<mode.fromBlock||mode.coveredThrough>confirmed||!mode.coveredHash))throw fault('MODE_HISTORY_UNVERIFIED');
  if(mode.coveredHash)await canonical(mode.coveredThrough,mode.coveredHash);
  const from=mode.coveredThrough===undefined?mode.fromBlock:Math.max(mode.fromBlock,mode.coveredThrough-3),to=Math.min(confirmed,from+chunk-1);
  const first=await range(mode,from,to,hex(confirmed)),b=await rpc('eth_getBlockByNumber',[hex(to),false]);if(!HASH.test(b?.hash||''))throw fault('MODE_BLOCK_INVALID');
  return {first,complete:to===confirmed,through:to,throughHash:b.hash};
 }
 async function verifyFirst(mode,first,{requireBound=true}={}){
  const d=reviewed(mode),h=await head();await infrastructure(h.tag);await definition(d,h.tag);
  const [registered]=await call(config.registry,'pads',[],h.tag);if(!registered.some(p=>same(p,mode.manager)))throw fault('MODE_REMOVED');
  if(!Number.isSafeInteger(mode.coveredThrough)||mode.coveredThrough<first.blockNumber||first.blockNumber<mode.fromBlock||first.blockNumber>h.number-2||!mode.coveredHash||first.historyFrom!==mode.fromBlock)throw fault('MODE_HISTORY_UNVERIFIED');
  await canonical(mode.coveredThrough,mode.coveredHash);await canonical(first.blockNumber,first.blockHash);
  const found=await range(mode,first.blockNumber,first.blockNumber,h.tag);
  if(!found||!same(found.tokenAddress,first.tokenAddress)||found.logIndex!==first.logIndex||!same(found.txHash,first.txHash)||first.recipient&&!same(first.recipient,found.recipient))throw fault('MODE_FIRST_CHANGED');
  if(mode.family==='buyback'){
   const [[allowed],[token],[quote],[bps],[kind],tax]=await Promise.all([call(config.admin,'isFactory',[mode.factory],h.tag),call(first.recipient,'token',[],h.tag),call(first.recipient,'quote',[],h.tag),call(first.recipient,'buybackBps',[],h.tag),c.call(mode.manager,gangV3Abi,'kindOf',[first.tokenAddress],h.tag),c.call(mode.manager,gangV3Abi,'taxConfigOf',[first.tokenAddress],h.tag)]);
   if(!allowed||kind!==1n||!same(tax.recipient,first.recipient))throw fault('MODE_BINDING_MISMATCH');
   if(requireBound){if(same(token,ZERO))throw fault('MODE_MODULE_BINDING_PENDING');if(!same(token,first.tokenAddress)||same(quote,ZERO)||!same(quote,found.quoteAddress)||bps===0n)throw fault('MODE_BINDING_MISMATCH');}
  }
 }
 return {catalog,earliest,verifyFirst,sourceUrl};
}
