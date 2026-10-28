import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,parseUnits} from 'ethers';
import {createAgentReader,agentAbi} from '../server/flap-agent-reader.mjs';
import {FLAP_MARKET} from '../server/flap-market.mjs';
import {createStandardFlapReader,flapStandardAbi,FLAP_PORTAL} from '../server/flap-standard-reader.mjs';
import {createPanelRouter,flapReceipt} from '../server/panel-router.mjs';
import {erc20Abi,ZERO,hex} from '../server/four-reader.mjs';
const address=n=>'0x'+n.toString(16).padStart(40,'0'),U=10n**18n,token=address(11),wallet=address(12),market=address(13),probe=address(14),quote=address(15),now=1792760000000;
const tuple=(abi,name,values)=>abi.getFunction(name).outputs[0].components.map(c=>values[c.name]??(c.baseType==='bool'?false:c.baseType==='address'?ZERO:c.baseType==='string'?'':c.baseType==='bytes32'?'0x'+'0'.repeat(64):c.baseType==='tuple'?c.components.map(()=>0n):0n));
function fixture({agent=true,native=true,allowance=0n}={}){
 const state={held:1000n*U,room:9000n*U,phase:1n,eligible:true,quota:500n*U,bought:500n*U,code:'0x60016000',nonce:'0x3',balance:100000n*U,allowance};const calls=[];
 const errorAbi=new Interface(['error Error(string)']);
 function values(name,args){
  const q=native?ZERO:quote;
  if(name==='factory')return [FLAP_MARKET.factory];if(name==='marketOfToken')return [agent?market:ZERO];if(name==='probeOfMarket')return [probe];if(name==='isMarket')return [true];if(name==='portal')return [FLAP_MARKET.portal];if(name==='market')return [market];
  if(name==='predictedToken')return [token];if(name==='token')return [state.phase===3n?token:ZERO];
  if(name==='marketCards')return [[[market,q,'Example','TEST','',token,state.phase===3n?token:ZERO,address(17),state.phase,U,10n*U,1000n,0n,0n,U,U]]];
  if(name==='marketDetail')return [tuple(agentAbi,name,{market,quoteToken:q,quoteDecimals:18n,phase:state.phase,predictedToken:token,token:state.phase===3n?token:ZERO,capRaw:10n*U,poolRaw:U,remainingRaw:9n*U,maxWalletShares:10000n*U,quoteBalanceKnown:true,quoteBackingEnough:true,agentFeeBps:100n})];
  if(name==='userPosition')return [tuple(agentAbi,name,{shares:state.held,remainingWalletShares:state.room,eligibilityKnown:true,eligible:state.eligible,claimableRaw:state.phase===3n?state.held:0n,inventoryKnown:state.phase===3n,inventoryEnough:state.phase===3n})];
  if(name==='quoteBuy'){const n=args[2];return [n,n/100n,0n,n*1000n];}
  if(name==='getTokenV8Safe')return [tuple(flapStandardAbi,name,{status:state.phase,reserve:U,circulatingSupply:100n*U,price:U/1000n,r:U,h:1000000n*U,k:U,dexSupplyThresh:10000n*U,quoteTokenAddress:q})];
  if(name==='maxBuyPerOrigin')return [100n,1000n*U];if(name==='buyQuotaOf')return [state.bought,state.quota];
  if(name==='quoteExactInput'){assert.equal(calls.at(-1).args[0].from,wallet);const p=args[0];return [p.outputToken.toLowerCase()===token.toLowerCase()?p.inputAmount*1000n:p.inputAmount/1000n];}
  if(name==='decimals')return [18];if(name==='symbol')return ['TEST'];if(name==='balanceOf')return [state.balance];if(name==='allowance')return [state.allowance];throw Error(name);
 }
 const rpc=async(method,args)=>{calls.push({method,args});
  if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x100';if(method==='eth_getBlockByNumber')return {number:args[0],timestamp:hex(now/1000),hash:'0x'+'1'.repeat(64)};
  if(method==='eth_getBalance')return hex(state.balance);if(method==='eth_getTransactionCount')return state.nonce;if(method==='eth_getCode')return state.code;if(method==='eth_getStorageAt')return '0x'+'0'.repeat(64);
  if(method==='eth_estimateGas')return '0x186a0';if(method==='eth_gasPrice')return '0x3b9aca00';
  if(method==='eth_call'){const request=args[0];for(const abi of [agentAbi,flapStandardAbi,erc20Abi]){let p;try{p=abi.parseTransaction({data:request.data});}catch{}if(p)return abi.encodeFunctionResult(p.name,values(p.name,p.args));}}
  throw Error('unexpected '+method);
 };
 rpc.batch=async requests=>Promise.all(requests.map(async([method,args])=>{const p=agentAbi.parseTransaction({data:args[0].data});let fields;
  if(p.name==='buyPlanProbe')fields=`MIN_SHARES=${p.args[0]*1000n*(10000n-p.args[1])/10000n};BUY_SHARES=${p.args[0]*1000n};RULES_OK=1;BLOCK=256`;
  else if(p.name==='sellPlanCustomProbe'){const shares=state.held*p.args[0]/10000n,out=shares/1000n;fields=`SHARES=${shares};OUT_${native?'WEI':'RAW'}=${out};MIN_${native?'WEI':'RAW'}=${out*(10000n-p.args[1])/10000n};BLOCK=256`;}
  else if(p.name==='claimableProbe')fields=`STATE=READY;CLAIM_RAW=${state.held};PHASE=3`;
  else throw Error(p.name);return {error:{data:errorAbi.encodeErrorResult('Error',[fields+';END'])}};}));
 return {state,calls,rpc,reader:agent?createAgentReader({rpc,clock:()=>now}):createStandardFlapReader({rpc,clock:()=>now})};
}
const p={tokenAddress:token,action:'buy',amount:'100',slippageBps:'100',buyMode:'tokenAmount'};
test('both Flap routes encode the chosen 99/99.99 percent minimum for buy and sell, without broadcasting',async()=>{
 for(const agent of [true,false])for(const action of ['buy','sell'])for(const bps of ['9900','9999']){
  const f=fixture({agent,allowance:100000n*U}),plan=await f.reader.build({...p,action,slippageBps:bps},wallet);
  const minimum=BigInt(plan.expectedRaw)*(10000n-BigInt(bps))/10000n;assert.ok(minimum>0n);assert.equal(BigInt(plan.minimumRaw),minimum);
  const c=(agent?agentAbi:flapStandardAbi).parseTransaction({data:plan.tx.inputData});assert.equal(agent?c.args[action==='buy'?1:2]:c.args[0].minOutputAmount,minimum);
  assert.equal(f.calls.some(c=>/send|sign/i.test(c.method)),false);
 }
});
test('dynamic Flap Agent CA resolves market, virtual holdings and wallet cap without ERC20 on the predicted CA',async()=>{
 const f=fixture(),m=await f.reader.inspect(token),h=await f.reader.holdings(m,wallet);assert.equal(m.marketAddress,market);assert.equal(h.base,'1000.0');assert.equal(h.buyableTokenAmount,'9000.0');
 assert.equal(f.calls.some(x=>x.method==='eth_call'&&x.args[0].to===token),false);
 const plan=await f.reader.build(p,wallet);assert.equal(plan.kind,'buy');assert.equal(agentAbi.parseTransaction({data:plan.tx.inputData}).name,'buy');assert.equal(BigInt(plan.tx.value),U/10n);
 await f.reader.recheck(plan);f.state.held++;f.state.room--;await assert.rejects(()=>f.reader.recheck(plan),{code:'PREVIEW_EXPIRED'});
});
test('Flap Agent checks eligibility and cap, and ERC20 quote approves the market, not the portal',async()=>{
 const f=fixture({native:false});let plan=await f.reader.build(p,wallet);assert.equal(plan.kind,'approve');assert.equal(plan.manager,market);assert.equal(plan.approvalToken.toLowerCase(),quote);assert.equal(plan.approvalRaw,(U/10n).toString());
 f.state.allowance=U;plan=await f.reader.build(p,wallet);assert.equal(plan.kind,'buy');assert.equal(agentAbi.parseTransaction({data:plan.tx.inputData}).name,'buyWithQuote');assert.equal(plan.tx.value,'0x0');
 f.state.room=10n*U;await assert.rejects(()=>f.reader.build(p,wallet),{code:'BUY_LIMIT_EXCEEDED'});f.state.room=9000n*U;f.state.eligible=false;await assert.rejects(()=>f.reader.build(p,wallet),{code:'AGENT_ID_REQUIRED'});
});
test('Agent sell supports native and ERC20 quotes, rounds shares down to bps and performs no token approval',async()=>{
 for(const native of [true,false]){const f=fixture({native}),plan=await f.reader.build({...p,action:'sell',amount:'250.009'},wallet);assert.equal(plan.kind,'sell');assert.equal(plan.sellBps,'2500');assert.equal(plan.amountRaw,(250n*U).toString());assert.equal(plan.approvalRaw,null);assert.equal(plan.tx.to,FLAP_MARKET.portal);
  await f.reader.recheck(plan);await assert.rejects(()=>f.reader.build({...p,action:'sell',amount:'0.00001'},wallet),{code:'FLAP_SELL_MIN_PERCENT'});}
});
test('Agent graduation only enables explicitly previewed claims; cannot keep selling virtual shares',async()=>{
 const f=fixture();f.state.phase=3n;await assert.rejects(()=>f.reader.build({...p,action:'sell'},wallet),{code:'FLAP_AGENT_GRADUATED'});
 const claim=await f.reader.build({...p,action:'claim'},wallet);assert.equal(claim.kind,'claim');assert.equal(claim.expectedRaw,(1000n*U).toString());assert.equal(agentAbi.parseTransaction({data:claim.tx.inputData}).name,'claim');
});
test('standard Flap uses origin quota, fixed input, bounded output and exact approvals for native/ERC20 quote',async()=>{
 for(const native of [true,false]){const f=fixture({agent:false,native});const m=await f.reader.inspect(token),h=await f.reader.holdings(m,wallet);assert.equal(h.buyableTokenAmount,'500.0');assert.match(h.limitType,/累计/);
  const plan=await f.reader.build(p,wallet);assert.equal(plan.kind,native?'buy':'approve');assert.equal(plan.expectedRaw,(100n*U).toString());assert.equal(plan.minimumRaw,(99n*U).toString());
  f.state.allowance=100000n*U;const sell=await f.reader.build({...p,action:'sell'},wallet);assert.equal(sell.kind,'sell');const decoded=flapStandardAbi.parseTransaction({data:sell.tx.inputData});assert.equal(decoded.args[0].inputToken,token);assert.equal(decoded.args[0].permitData,'0x');
  await f.reader.recheck(sell);f.state.quota=50n*U;await assert.rejects(()=>f.reader.build(p,wallet),{code:'BUY_LIMIT_EXCEEDED'});f.state.phase=4n;await assert.rejects(()=>f.reader.build(p,wallet),{code:'FLAP_DEX_ROUTE_REQUIRED'});}
});
test('Flap proxy/code or nonce change expires the exact reviewed transaction',async()=>{
 for(const key of ['code','nonce']){const f=fixture({agent:false});const plan=await f.reader.build(p,wallet);f.state[key]=key==='code'?'0x60026000':'0x4';await assert.rejects(()=>f.reader.recheck(plan),{code:'PREVIEW_EXPIRED'});}
});
test('platform discovery advances only on authenticated not-found errors and graduation uses actual tokens',async()=>{
 const err=code=>Object.assign(Error(code),{code}),calls=[];
 const readers={agent:{inspect:async()=>{calls.push('agent');throw err('NOT_FLAP_AGENT');}},standard:{inspect:async()=>{calls.push('standard');throw err('NOT_FLAP_TOKEN');}},four:{inspect:async()=>{calls.push('four');return {base:{symbol:'T'}};}}};
 const router=createPanelRouter({rpc:()=>{},readers});assert.equal((await router.inspect(token)).platform,'Four.meme');assert.deepEqual(calls,['agent','standard','four']);
 readers.standard.inspect=async()=>{throw err('RPC_UNAVAILABLE');};await assert.rejects(()=>createPanelRouter({rpc:()=>{},readers}).inspect(token),{code:'RPC_UNAVAILABLE'});
 readers.agent.inspect=async()=>({phase:3,protocol:'flap-agent'});readers.standard.inspect=async()=>({protocol:'flap-standard'});assert.equal((await createPanelRouter({rpc:()=>{},readers}).inspect(token)).agentMarket.protocol,'flap-agent');
});
test('unrecognized-token revert is specific to the selected CA; generic RPC failure never changes platform',async()=>{
 const err=Object.assign(Error('rpc'),{code:'RPC_CALL_FAILED',rpcError:{data:flapStandardAbi.encodeErrorResult('TokenNotFound',[token])}}),f=fixture({agent:false});
 const rpc=async(method,args)=>method==='eth_call'?Promise.reject(err):f.rpc(method,args);
 const r=createStandardFlapReader({rpc,clock:()=>now});await assert.rejects(()=>r.inspect(token),{code:'NOT_FLAP_TOKEN'});
 await assert.rejects(()=>r.inspect(address(16)),{code:'RPC_CALL_FAILED'});
});
test('Agent receipt validates market, wallet, sold shares and net ERC20 settlement',async()=>{
 const f=fixture({native:false}),plan=await f.reader.build({...p,action:'sell',amount:'250'},wallet),out=U/4n;
 const trade={address:market,...agentAbi.encodeEventLog(agentAbi.getEvent('VirtualTrade'),[1n,wallet,1n,250n*U,0n,out,0n,0n,0n,0n,0n,0n,0n,0n,0n,0n])};
 const transfer={address:quote,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Transfer'),[market,wallet,out])};
 assert.equal(flapReceipt(plan,{logs:[trade,transfer]}).receivedAmount,'0.25');assert.throws(()=>flapReceipt(plan,{logs:[trade]}),{code:'TRADE_SETTLEMENT_MISMATCH'});
 assert.throws(()=>flapReceipt(plan,{logs:[{...trade,address:address(99)},transfer]}),{code:'TRADE_EVENT_MISSING'});
});
test('standard Flap sell receipt uses the documented net quote amount without deducting the fee twice',async()=>{
 const f=fixture({agent:false}),plan=await f.reader.build({...p,action:'sell',amount:'100'},wallet),out=BigInt(plan.minimumRaw),fee=out/100n;
 const trade={address:plan.manager,...flapStandardAbi.encodeEventLog(flapStandardAbi.getEvent('TokenSold'),[1n,token,wallet,100n*U,out,fee,1n])};
 const transfer={address:token,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Transfer'),[wallet,plan.manager,100n*U])};
 assert.ok(flapReceipt(plan,{logs:[trade,transfer]}).receivedAmount);
 const low={address:plan.manager,...flapStandardAbi.encodeEventLog(flapStandardAbi.getEvent('TokenSold'),[1n,token,wallet,100n*U,out-1n,fee,1n])};
 assert.throws(()=>flapReceipt(plan,{logs:[low,transfer]}),{code:'TRADE_SETTLEMENT_MISMATCH'});
});

