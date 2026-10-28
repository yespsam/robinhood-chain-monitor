import {keccak256} from 'ethers';
import {GANG_PADS,gangAbi} from './gang-reader.mjs';
import {createPanelChain} from './panel-chain.mjs';
import {fault,same} from './flap-reader.mjs';
import {tokenAddress} from './four-reader.mjs';
// Snapshot the append-only on-chain directories. The preceding snapshot gives
// a conservative creation-time bound; API timestamps never authorize a buy.
export function createGangLaunchSource({rpc,clock=Date.now,pads=GANG_PADS}){
 const c=createPanelChain(rpc,clock);
 async function snapshot(number){const h=number===undefined?await c.head():{block:'0x'+number.toString(16)},block=await rpc('eth_getBlockByNumber',[h.block,false]);
  if(!block||block.number!==h.block||!/^0x[\da-f]{64}$/i.test(block.hash))throw fault('GANG_SOURCE_INVALID');
  const time=Number(BigInt(block.timestamp))*1000;if(clock()-time>30000||time>clock()+5000)throw fault('STALE_BLOCK');
  const entries=await Promise.all(pads.map(async p=>{const [code,[count]]=await Promise.all([rpc('eth_getCode',[p.address,h.block]),c.call(p.address,gangAbi(p),'tokenCount',[],h.block)]);if(keccak256(code)!==p.hash||count>1000000n)throw fault('GANG_CONTRACT_CHANGED');return [p.address,count.toString()];}));
  return {number:Number(BigInt(h.block)),hash:block.hash,time,counts:Object.fromEntries(entries)};
 }
 async function verify(row,maxAge){
  if(clock()-row.createdAfter>maxAge*1000||row.createdAfter>clock()+5000)throw fault('GANG_NEW_TOO_OLD');
  const pad=pads.find(p=>same(p.address,row.manager));if(!pad)throw fault('GANG_SOURCE_INVALID');
  const [before,after,[token]]=await Promise.all([rpc('eth_getBlockByNumber',['0x'+row.beforeBlock.toString(16),false]),rpc('eth_getBlockByNumber',['0x'+row.observedBlock.toString(16),false]),c.call(pad.address,gangAbi(pad),'allTokens',[row.index],'latest')]);
  if(before?.hash!==row.beforeHash||after?.hash!==row.observedHash||!same(token,row.tokenAddress))throw fault('GANG_SOURCE_REORG');
  if(pad.variant==='v3'&&(await c.call(pad.address,gangAbi(pad),'kindOf',[row.tokenAddress],'latest'))[0]!==1n)throw fault('GANG_KIND_UNSUPPORTED');
 }
 async function poll(cursor){const h=await c.head(),number=Number(BigInt(h.block))-2;if(number<=cursor.number)return {cursor,rows:[]};
  if((await rpc('eth_getBlockByNumber',['0x'+cursor.number.toString(16),false]))?.hash!==cursor.hash)throw fault('GANG_SOURCE_REORG');
  const next=await snapshot(number),rows=[];for(const pad of pads){const start=Number(cursor.counts[pad.address]),end=Number(next.counts[pad.address]);if(!Number.isSafeInteger(start)||end<start)throw fault('GANG_SOURCE_REORG');if(end-start>50||rows.length+end-start>100)throw fault('GANG_SOURCE_GAP');
   for(let index=start;index<end;index++){const block='0x'+number.toString(16),abi=gangAbi(pad),[token]=await c.call(pad.address,abi,'allTokens',[index],block);
    if(pad.variant==='v3'&&(await c.call(pad.address,abi,'kindOf',[token],block))[0]!==1n)continue;
    rows.push({tokenAddress:tokenAddress(token),manager:pad.address,index,beforeBlock:cursor.number,beforeHash:cursor.hash,observedBlock:number,observedHash:next.hash,createdAfter:cursor.time});}
  }return {cursor:next,rows};
 }
 return {baseline:()=>snapshot(),poll,verify};
}
