import {Interface,decodeBytes32String} from 'ethers';
import {same} from './flap-reader.mjs';
import {ZERO} from './four-reader.mjs';
const abi=new Interface(['function moduleType() view returns(bytes32)','function token() view returns(address)','function quote() view returns(address)','function buybackBps() view returns(uint16)','function pendingCut() view returns(bool live,uint16 bps,uint64 at)','function dev() view returns(address)','function payee() view returns(address)']);
// Optional read-only metadata. No result here is used to allow a trade.
export async function readGangBuyback(c,m){
 if(m.variant!=='v3'||!m.taxConfig||same(m.taxConfig.recipient,ZERO))return null;
 try{
  const recipient=m.taxConfig.recipient,[type]=await c.call(recipient,abi,'moduleType',[],m.block);
  const moduleType=decodeBytes32String(type);if(!['buyback-burn-v1','buyback-burn-v2'].includes(moduleType))return null;
  const [[token],[quote],[bps],pending]=await Promise.all(['token','quote','buybackBps','pendingCut'].map(n=>c.call(recipient,abi,n,[],m.block)));
  if(!same(token,m.tokenAddress)||!same(quote,m.quote.address)||bps>10000n||pending.bps>10000n)return {status:'unverified'};
  const [payee]=moduleType==='buyback-burn-v2'?await c.call(recipient,abi,'payee',[],m.block):[null];
  return {status:'configured',recipient,moduleType,payee,buybackPercent:Number(bps)/100,pendingCut:pending.live?{percent:Number(pending.bps)/100,at:Number(pending.at)*1000}:null};
 }catch{return {status:'unavailable'};}
}
