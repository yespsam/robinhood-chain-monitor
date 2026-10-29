import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,keccak256,parseUnits} from 'ethers';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GANG_PADS,createGangReader,gangMath,gangV2Abi,gangSoftAbi,gangReceipt,wrapAbi,WBNB,VT} from '../server/gang-reader.mjs';
import {ZERO,erc20Abi} from '../server/four-reader.mjs';
import {createPanelRouter} from '../server/panel-router.mjs';
import {decodeChartTrade,tradeFilter} from '../server/market-chart.mjs';
import {decodeLaunch,SCAN_SOURCES,launchAbi,createChainScanner} from '../server/chain-scanner.mjs';
import {assetUrls,createScanMetadata} from '../server/scan-metadata.mjs';
import {parseCA,transferBlocked} from '../extension/trade-model.js';
import {FlapJournal} from '../server/flap-journal.mjs';
import {gangDirectoryRpc} from '../server/gang-discovery.mjs';
import {validatePanelParams} from '../extension/trade-policy.js';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),ca=addr(1),wallet=addr(2),quote=addr(3),U=10n**18n,now=1793024440000;
const extra=new Interface(['function name() view returns(string)','function locked() view returns(bool)']);
function fixture({asset=quote,decimals=18}={}){
 const state={eligible:true,balance:1000n*U,quote:100n*10n**BigInt(decimals),allowance:0n,reserve:0n,sold:0n,code:'0x60006000',graduated:false,cap:true,nonce:'0x1'};
 const pad={...GANG_PADS[0],hash:keccak256(state.code)},calls=[];
 const rpc=async(method,p)=>{calls.push([method,p]);if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x100';if(method==='eth_getBlockByNumber')return {number:'0x100',timestamp:'0x'+(now/1000).toString(16)};
  if(method==='eth_getCode')return state.code;if(method==='eth_getStorageAt')return '0x'+'0'.repeat(64);if(method==='eth_getBalance')return '0x'+(10n*U).toString(16);
  if(method==='eth_getTransactionCount')return state.nonce;if(method==='eth_estimateGas')return '0x186a0';if(method==='eth_gasPrice')return '0x3b9aca00';assert.equal(method,'eth_call');
  const tx=p[0];let i,e;for(const candidate of [gangV2Abi,erc20Abi,extra])try{const parsed=candidate.parseTransaction({data:tx.data});if(parsed){i=candidate;e=parsed;break;}}catch{}assert.ok(e,tx.data);
  let r;switch(e.name){case 'curves':r=[wallet,asset,state.reserve,state.sold,15n*10n**BigInt(decimals),5n*10n**BigInt(decimals),state.graduated,false,ZERO,ZERO];break;
   case 'decimals':r=[tx.to.toLowerCase()===ca?18:decimals];break;case 'symbol':r=[tx.to.toLowerCase()===ca?'BASE':asset===WBNB?'WBNB':'QUOTE'];break;case 'name':r=['Test'];break;case 'locked':r=[!state.graduated];break;
   case 'MAX_PER_WALLET':r=[10000000n*U];break;case 'VIRTUAL_TOKEN':r=[VT];break;case 'logoURIOf':r=[''];break;case 'agentGateEnabled':r=[true];break;case 'walletCapEnabled':r=[state.cap];break;
   case 'isAgent':r=[state.eligible];break;case 'walletRoom':r=[10000000n*U-state.balance];break;
   case 'balanceOf':r=[tx.to.toLowerCase()===ca?state.balance:state.quote];break;case 'allowance':r=[state.allowance];break;default:throw Error(e.name);}
  return i.encodeFunctionResult(e.name,r);
 };
 return {state,calls,rpc,reader:createGangReader({rpc,clock:()=>now,deployments:[pad]})};
}
const params={tokenAddress:ca,action:'buy',amount:'100',slippageBps:'100',buyMode:'tokenAmount'};
test('Gang directory RPC bounds and serializes batches, and recovers after a failed batch',async()=>{
 let active=0,maxActive=0,attempt=0;const sizes=[];
 const rpc=gangDirectoryRpc({async batch(calls){sizes.push(calls.length);active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,2));active--;if(++attempt===1)throw Error('rate limited');return calls.map(([,p])=>({result:p[0]}));}},{spacingMs:1,maxBatch:5});
 const results=await Promise.allSettled(Array.from({length:16},(_,i)=>rpc('eth_call',[i])));assert.equal(maxActive,1);assert.deepEqual(sizes,[5,5,5,1]);assert.equal(results.filter(x=>x.status==='rejected').length,5);assert.equal(results[15].value,15);
});
test('Gang integer inverse respects target, 6/18-decimal quotes, fee rounding and wallet limits',async()=>{
 for(const decimals of [6,18]){const f=fixture({decimals}),m=await f.reader.inspect(ca),math=gangMath(m);for(const target of [U,100n*U,9999999n*U]){const gross=math.grossFor(math.netFor(target));assert.ok(math.buyOut(gross-math.fee(gross))>=target);assert.ok(gross===1n||math.buyOut(gross-1n-math.fee(gross-1n))<target);}
  const plan=await f.reader.build(params,wallet);assert.equal(plan.kind,'approve');assert.equal(plan.manager,GANG_PADS[0].address);assert.equal(plan.approvalToken.toLowerCase(),quote);assert.equal(plan.approvalRaw,plan.spendRaw);assert.equal(plan.tx.value,'0x0');
  await assert.rejects(f.reader.build({...params,amount:'10000001'},wallet),{code:'BUY_LIMIT_EXCEEDED'});f.state.eligible=false;await assert.rejects(f.reader.build(params,wallet),{code:'GANG_AGENT_ID_REQUIRED'});
 }
});
test('Gang approval clears existing allowance, then exact ERC20 buy never sends native value',async()=>{
 const f=fixture();f.state.allowance=1n;assert.equal((await f.reader.build(params,wallet)).approvalRaw,'0');f.state.allowance=100n*U;
 const plan=await f.reader.build(params,wallet),tx=gangV2Abi.parseTransaction({data:plan.tx.inputData});assert.equal(plan.kind,'buy');assert.equal(tx.name,'buy');assert.equal(tx.args[1],BigInt(plan.spendRaw));assert.equal(tx.args[2],BigInt(plan.minimumRaw));assert.equal(plan.tx.value,'0x0');
 await f.reader.recheck(plan);f.state.code='0x6001';await assert.rejects(f.reader.recheck(plan),{code:'GANG_CONTRACT_CHANGED'});
});

test('Gang automatic fixed input survives a price rise within original slippage without refunding or reapproving',async()=>{
 const f=fixture(),p={...params,amount:'1000000',slippageBps:'1000'},first=await f.reader.build(p,wallet),fixed={...p,fixedSpendRaw:first.spendRaw};
 f.state.quote=BigInt(first.spendRaw);f.state.allowance=BigInt(first.spendRaw);
 const move=n=>{f.state.sold=VT/BigInt(n);const remaining=VT-f.state.sold,k=5n*U*VT;f.state.reserve=(k+remaining-1n)/remaining-5n*U;};
 move(40);await assert.rejects(f.reader.build(p,wallet),{code:'INSUFFICIENT_BALANCE'});
 const next=await f.reader.build(fixed,wallet);assert.equal(next.kind,'buy');assert.equal(next.spendRaw,first.spendRaw);assert.equal(next.minimumRaw,(900000n*U).toString());assert(BigInt(next.expectedRaw)<1000000n*U);assert(BigInt(next.expectedRaw)>=900000n*U);
 const tx=gangV2Abi.parseTransaction({data:next.tx.inputData});assert.equal(tx.args[1],BigInt(first.spendRaw));assert.equal(tx.args[2],900000n*U);
 move(10);await assert.rejects(f.reader.build(fixed,wallet),e=>{assert.equal(e.code,'AUTO_PRICE_CHANGED');assert.equal(e.details.price.minimum,'900000.0');assert.equal(e.details.price.slippageBps,'1000');assert.equal(e.details.price.spend,first.spend);assert(Number(e.details.price.expected)<900000);return true;});
 assert.throws(()=>validatePanelParams('panelPrepare',{profile:'unified',...fixed}),{code:'INVALID_REQUEST'});
 for(const value of ['0','-1','1e18',((1n<<256n)).toString()])await assert.rejects(f.reader.build({...p,fixedSpendRaw:value},wallet),{code:'INVALID_REQUEST'});
});
test('WBNB shortage produces separately confirmed wrap and persists through journal; no buy calldata',async t=>{
 const f=fixture({asset:WBNB});f.state.quote=1n;const p=await f.reader.build(params,wallet);assert.equal(p.kind,'wrap');assert.equal(p.tx.to,WBNB);assert.equal(p.tx.inputData,'0xd0e30db0');assert.equal(BigInt(p.tx.value),BigInt(p.wrapRaw));
 const root=await mkdtemp(join(tmpdir(),'gang-wrap-'));t.after(()=>rm(root,{recursive:true,force:true}));const journal=new FlapJournal(join(root,'journal'));
 const op={intentId:'wrap-00000001',action:'panelWrap',market:ca,wallet,status:'SUBMITTING',createdAt:now,deadlineAt:now+10000,steps:[{action:'panelWrap',status:'SUBMITTING',startedAt:now,plan:p,tx:p.tx}]};await journal.save(op,{create:true});assert.equal((await journal.read(op.intentId)).steps[0].plan.kind,'wrap');
 const log={address:WBNB,...wrapAbi.encodeEventLog(wrapAbi.getEvent('Deposit'),[wallet,BigInt(p.wrapRaw)])};assert.match(gangReceipt(p,{logs:[log]}).message,/没有买入/);assert.throws(()=>gangReceipt(p,{logs:[{...log,address:quote}]}),{code:'TRADE_SETTLEMENT_MISMATCH'});
});
test('graduation blocks old curve trading, transfer lock and canonical Gang URLs are explicit',async()=>{
 const f=fixture();assert.match(transferBlocked(await f.reader.inspect(ca)),/毕业/);f.state.graduated=true;await assert.rejects(f.reader.build(params,wallet),{code:'GANG_DEX_ROUTE_REQUIRED'});assert.equal(transferBlocked(await f.reader.inspect(ca)),null);
 assert.equal(parseCA('https://gang.fun/token/'+ca),ca);assert.equal(parseCA('https://gang.fun.evil.test/token/'+ca),null);
});
test('Gang receipts and chart use net sell proceeds, exact token debit and authenticated emitter',()=>{
 const manager=GANG_PADS[0].address,p={variant:'v2',protocol:'gang-curve',kind:'sell',manager,wallet,tokenAddress:ca,quote:{address:quote,decimals:6,symbol:'USDT'},base:{decimals:18,symbol:'T'},amountRaw:String(U),minimumRaw:'980000'};
 const trade={address:manager,...gangV2Abi.encodeEventLog(gangV2Abi.getEvent('Sell'),[ca,wallet,U,0n,10000n,990000n,1000000000n]),blockNumber:'0x10',logIndex:'0x0',blockHash:'0x'+'1'.repeat(64),transactionHash:'0x'+'2'.repeat(64)};
 const transfer=(token,from,to,n)=>({address:token,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Transfer'),[from,to,n])});
 const logs=[trade,transfer(ca,wallet,manager,U),transfer(quote,manager,wallet,990000n)];assert.equal(gangReceipt(p,{logs}).receivedAmount,'0.99');assert.throws(()=>gangReceipt(p,{logs:logs.slice(0,2)}),{code:'TRADE_SETTLEMENT_MISMATCH'});
 const decoded=decodeChartTrade(trade,p);assert.equal(decoded.price,.99);assert.equal(decoded.quoteVolume,.99);assert.equal(tradeFilter(p).address,manager);assert.equal(decodeChartTrade({...trade,address:quote},p),null);
});
test('Gang only advances discovery after Four not-found; failure never becomes a false token match',async()=>{
 const err=code=>Object.assign(Error(code),{code}),readers={agent:{inspect:async()=>{throw err('NOT_FLAP_AGENT');}},standard:{inspect:async()=>{throw err('NOT_FLAP_TOKEN');}},four:{inspect:async()=>{throw err('NOT_FOUR_TOKEN');}},gang:{inspect:async()=>({protocol:'gang-curve',platform:'Gang'})}};
 const r=createPanelRouter({rpc:()=>{},readers});assert.equal((await r.inspect(ca)).platform,'Gang');readers.four.inspect=async()=>{throw err('RPC_UNAVAILABLE');};await assert.rejects(createPanelRouter({rpc:()=>{},readers}).inspect(ca),{code:'RPC_UNAVAILABLE'});
});
test('Gang creation logs and directory survive scanner merge, without enabling a sniper',async()=>{
 const source=SCAN_SOURCES.find(s=>s.platform==='Gang'),encoded=launchAbi.encodeEventLog(launchAbi.getEvent(source.event),[ca,wallet,'Name','T','',false,quote,ZERO,15n*U]);
 const log={...encoded,address:source.address,blockNumber:'0x64',logIndex:'0x0',blockHash:'0x'+'1'.repeat(64),transactionHash:'0x'+'2'.repeat(64)};
 assert.equal(decodeLaunch(log).platform,'Gang');assert.equal(decodeLaunch({...log,address:quote}),null);
 const scanner=createChainScanner({discovery:null,gangDiscovery:{read:async()=>({rows:[{platform:'Gang',tokenAddress:ca,phase:3,source:'gang-agent-directory'}],total:1,updatedAt:now})},rpc:async(method,p)=>method==='eth_chainId'?'0x38':method==='eth_blockNumber'?'0x66':p[0].address===source.address?[log]:[]});
 await scanner.refreshGangDirectory();await scanner.tick();const row=scanner.state().rows.find(r=>r.platform==='Gang');assert.equal(row.phase,3);assert.equal(row.txHash,log.transactionHash);scanner.stop();
});
test('Gang direct avatars stay on explicit public media routes, with lazy bounded image fetching',async()=>{
 assert.equal(assetUrls('https://gang.fun/api/logos/0123456789abcdef.png','image').length,1);for(const url of ['http://127.0.0.1/x','https://gang.fun/api/session','https://evil.test/image.png','https://gang.fun:123/api/logos/0123456789abcdef.png'])assert.deepEqual(assetUrls(url,'image'),[]);
 const metadata=createScanMetadata({fetcher:()=>{throw Error('must stay lazy');}}),m=await metadata.read('https://gang.fun/api/logos/0123456789abcdef.png',{kind:'image'});assert.match(m.imageUrl,/^\/api\/token-image\/[a-f\d]{64}$/);
});
