import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256,encodeBytes32String} from 'ethers';
import {GANG_PADS,gangV3Abi,createGangReader,VT,gangReceipt} from '../server/gang-reader.mjs';
import {ZERO,erc20Abi} from '../server/four-reader.mjs';
import {createGangDiscovery} from '../server/gang-discovery.mjs';
import {createGangLaunchSource} from '../server/gang-launch-source.mjs';
import {decodeLaunch} from '../server/chain-scanner.mjs';
import {decodeChartTrade} from '../server/market-chart.mjs';
import {readGangBuyback} from '../server/gang-buyback.mjs';
import {createRoundtripLedger,addr,hash,U,token,wallet} from './helpers/roundtrip-ledger.mjs';

for(const wrapped of [false,true])test(`V3 full isolated roundtrip: ${wrapped?'wrap WBNB':'swap GANG'} -> approve -> buy -> approve -> sell -> BNB`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'yesp-v3-roundtrip-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=createRoundtripLedger(dir,{variant:'v3',wrapped,oldAllowance:true,phone:true});
 const m=await f.reader.inspect(token);assert.equal(m.variant,'v3');assert.equal(m.taxConfig.dividendBps,0);assert.equal(m.taxConfig.buyTaxBps,100);
 const buy=await f.trade('buy');assert.equal(buy.status,'COMPLETE',JSON.stringify(buy.error));const owned=f.state.base,leftover=f.state.quote;
 const sale=await f.trade('sell');assert.equal(sale.status,'COMPLETE',JSON.stringify(sale.error));assert(owned>0n);assert.equal(f.state.base,0n);assert.equal(f.state.quote,leftover);assert(f.state.submissions.some(s=>s.kind==='buy'));assert(f.state.submissions.some(s=>s.kind==='sell'));
});

function directoryFixture(){const code='0x60006000',pad={...GANG_PADS.find(p=>p.variant==='v3'),hash:keccak256(code)},ca=addr(1234);let head=100,count=1,kind=1;
 const rpc=async(method,args)=>{
  if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x'+head.toString(16);if(method==='eth_getCode')return code;
  if(method==='eth_getBlockByNumber')return {number:args[0],hash:hash(Number(BigInt(args[0]))),timestamp:'0x3e8'};
  assert.equal(method,'eth_call');const f=gangV3Abi.parseTransaction({data:args[0].data});let values;
  if(f.name==='tokenCount')values=[count];else if(f.name==='allTokens')values=[ca];else if(f.name==='kindOf')values=[kind];else if(f.name==='curves')values=kind===1?[addr(1),addr(2),U,10n*U,3n*U,U,false,100,200,0,ZERO,ZERO]:[ZERO,ZERO,0,0,0,0,false,0,0,0,ZERO,ZERO];else throw Error(f.name);
  return gangV3Abi.encodeFunctionResult(f.name,values);
 };
 return {rpc,pad,ca,clock:()=>1000000,setKind:n=>kind=n,advance(){head+=4;count++;}};
}
test('merged directory skips fair-mint entries without failing valid V3 token discovery',async()=>{
 const f=directoryFixture(),discovery=createGangDiscovery({...f,pads:[f.pad],fetcher:async()=>Response.json({items:[]})});assert.equal((await discovery.read()).rows[0].variant,'v3');
 f.setKind(2);assert.equal((await discovery.read()).rows.length,0);await assert.rejects(createGangReader({...f,deployments:[f.pad]}).inspect(f.ca),{code:'GANG_KIND_UNSUPPORTED'});
});
test('new-coin source excludes fair-mint and rechecks kind before approving a V3 candidate',async()=>{
 const f=directoryFixture(),source=createGangLaunchSource({...f,pads:[f.pad]}),b=await source.baseline();f.advance();const next=await source.poll(b);assert.equal(next.rows.length,1);await source.verify(next.rows[0],30);
 f.setKind(2);await assert.rejects(source.verify(next.rows[0],30),{code:'GANG_KIND_UNSUPPORTED'});f.advance();assert.equal((await source.poll(next.cursor)).rows.length,0);
});
test('V3 creation event has no old taxed boolean; scanner decodes its own signature',()=>{
 const pad=GANG_PADS.find(p=>p.variant==='v3'),log={address:pad.address,blockHash:hash(1),transactionHash:hash(2),blockNumber:'0x3',logIndex:'0x0',...gangV3Abi.encodeEventLog(gangV3Abi.getEvent('Created'),[token,wallet,'GANGBALL','BALL','',addr(5),ZERO,U])};
 const r=decodeLaunch(log);assert.equal(r.symbol,'BALL');assert.equal(r.mode,'Gang V3 内盘');assert.equal(r.variant,'v3');assert.equal(decodeLaunch({...log,address:addr(4)}),null);
});
test('V3 receipt and chart count protocol fee once, require zero curve tax and actual quote settlement',()=>{
 const manager=GANG_PADS.find(p=>p.variant==='v3').address,quote=addr(7),p={variant:'v3',protocol:'gang-curve',kind:'buy',manager,wallet,tokenAddress:token,quote:{address:quote,decimals:18},base:{decimals:18},spendRaw:String(100n*U),minimumRaw:String(U)};
 const event=tax=>({address:manager,blockHash:hash(1),transactionHash:hash(2),blockNumber:'0x3',logIndex:'0x0',...gangV3Abi.encodeEventLog(gangV3Abi.getEvent('Buy'),[token,wallet,99n*U,U,tax,2n*U,1000n*U])});
 const transfer=(a,from,to,n)=>({address:a,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Transfer'),[from,to,n])}),rest=[transfer(token,manager,wallet,2n*U),transfer(quote,wallet,manager,100n*U)];
 assert.equal(gangReceipt(p,{logs:[event(0n),...rest]}).receivedAmount,'2.0');assert.equal(decodeChartTrade(event(0n),p).quoteVolume,100);
 assert.throws(()=>gangReceipt(p,{logs:[event(1n),...rest]}),{code:'TRADE_SETTLEMENT_MISMATCH'});assert.throws(()=>gangReceipt(p,{logs:[event(0n),rest[0]]}),{code:'TRADE_SETTLEMENT_MISMATCH'});
});
test('buyback metadata checks module type, token binding, quote and percentage without authorizing a trade',async()=>{
 const m={variant:'v3',tokenAddress:token,quote:{address:addr(4)},taxConfig:{recipient:addr(8)},block:'0x1'},values={moduleType:[encodeBytes32String('buyback-burn-v1')],token:[token],quote:[addr(4)],buybackBps:[10000n],pendingCut:{live:false,bps:0n,at:0n}},c={call:async(a,b,name)=>values[name]};
 assert.equal((await readGangBuyback(c,m)).buybackPercent,100);values.token=[addr(99)];assert.equal((await readGangBuyback(c,m)).status,'unverified');values.moduleType=[encodeBytes32String('other')];assert.equal(await readGangBuyback(c,m),null);
});
test('buyback v2 reports its mutable payee separately from the buyback percentage',async()=>{
 const m={variant:'v3',tokenAddress:token,quote:{address:addr(4)},taxConfig:{recipient:addr(8)},block:'0x1'},values={moduleType:[encodeBytes32String('buyback-burn-v2')],token:[token],quote:[addr(4)],buybackBps:[4000n],pendingCut:{live:false,bps:0n,at:0n},payee:[addr(55)]},c={call:async(a,b,name)=>values[name]};
 const r=await readGangBuyback(c,m);assert.equal(r.moduleType,'buyback-burn-v2');assert.equal(r.payee,addr(55));assert.equal(r.buybackPercent,40);assert.equal(r.status,'configured');
});
