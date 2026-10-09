import test from 'node:test';
import assert from 'node:assert/strict';
import {internalDepthCheck,createInternalDepthProbe,selectInternalDepthRpcHost,FOUR_HELPER,BNB_ORACLE,
  DEPTH_RETRY_POLICY,admitInternalDepthRetryCandidate} from '../src/paper-internal-depth.js';
import {depthFixture,depthAbi} from './helpers/internal-depth-fixture.js';
import {flapDepthFixture,flapQuoteDepthFixture} from './helpers/internal-depth-fixture.js';
import {FLAP_DEPTH_ABI,FLAP_DEPTH_PORTAL} from '../src/paper-internal-depth.js';
const NOW=Date.parse('2026-10-05T07:00:00Z'),token={chain:'bsc',address:'0x'+'a'.repeat(40),marketStage:'internal',price:1};

const PRIVATE_RPC_HOST='bsc-mainnet.core.chainstack.com',PRIVATE_RPC_SECRET='0123456789abcdef0123456789abcdef';
const privateEndpoints=[{host:'bsc-rpc.publicnode.com',url:'https://bsc-rpc.publicnode.com'},
  {host:PRIVATE_RPC_HOST,url:`https://${PRIVATE_RPC_HOST}/${PRIVATE_RPC_SECRET}`,preferred:true}];

for(const [kind,record,reclaimOffset] of [
  ['pending capacity retry',{capacityRetry:true,nextAttemptAt:NOW+1000},60000],
  ['ordinary failure',{capacityRetry:false,nextAttemptAt:NOW+60000},60000],
  ['host/method cooldown',{capacityRetry:false,nextAttemptAt:NOW+90000},90000],
  ['successful probe inside its generation',{capacityRetry:false,nextAttemptAt:NOW+5000},10000],
])test(`depth retry candidate bound retains ${kind} until full cooldown and generation expire`,()=>{
  const attempts=new Map(Array.from({length:64},(_,i)=>[`bsc:${i}`,
    {at:NOW,generationStartedAt:NOW,attempts:2,...record}]));
  const first=attempts.get('bsc:0');
  assert.equal(DEPTH_RETRY_POLICY.maxCandidates,64);
  assert.equal(admitInternalDepthRetryCandidate(attempts,'bsc:new',NOW+reclaimOffset-1),false);
  assert.equal(attempts.size,64);assert.equal(attempts.get('bsc:0'),first);
  assert.equal(admitInternalDepthRetryCandidate(attempts,'bsc:0',NOW+reclaimOffset-1),true);
  assert.equal(attempts.get('bsc:0').attempts,2,'existing candidates keep their attempt budget');
  assert.equal(admitInternalDepthRetryCandidate(attempts,'bsc:new',NOW+reclaimOffset),true);
  assert.equal(attempts.size,0,'only fully elapsed records are reclaimed');
  attempts.set('bsc:new',{at:NOW+reclaimOffset,generationStartedAt:NOW+reclaimOffset});
  assert.equal(attempts.size,1);
});

test('depth configured paid preference queues on a busy host but backs off cooling or active recovery',()=>{
  const snapshot={leases:[],waiters:[],circuits:[]};
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),PRIVATE_RPC_HOST);
  snapshot.circuits=[{host:PRIVATE_RPC_HOST,operation:'eth_call',until_ms:NOW+30000}];
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),'bsc-rpc.publicnode.com');
  snapshot.circuits=[];snapshot.leases=[{host:PRIVATE_RPC_HOST,operation:'eth_call',lane:'background'}];
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),PRIVATE_RPC_HOST);
  snapshot.leases=[{host:PRIVATE_RPC_HOST,operation:'eth_call',lane:'realtime'}];
  snapshot.circuits=[{host:PRIVATE_RPC_HOST,operation:'eth_call',until_ms:NOW-1}];
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),'bsc-rpc.publicnode.com');
  snapshot.leases=[];
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),PRIVATE_RPC_HOST);
  snapshot.circuits=privateEndpoints.map(({host})=>({host,operation:'eth_chainId',until_ms:NOW+30000}));
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),undefined);
});

for(const leases of [
  [{host:PRIVATE_RPC_HOST,operation:'eth_call',lane:'background'}],
  [{host:PRIVATE_RPC_HOST,operation:'eth_blockNumber',lane:'realtime'},
    {host:PRIVATE_RPC_HOST,operation:'eth_getLogs',lane:'realtime'}],
])test(`healthy paid depth endpoint remains preferred over idle public despite ${leases.length} active leases`,()=>{
  const snapshot={leases,waiters:Array.from({length:5},()=>({host:PRIVATE_RPC_HOST,lane:'realtime'})),circuits:[]};
  const before=structuredClone(snapshot);
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),PRIVATE_RPC_HOST);
  assert.deepEqual(snapshot,before,'host preference cannot reserve a slot or mutate the gate');
});

for(const operation of ['*','eth_call','eth_chainId'])test(`paid depth ${operation} cooldown uses public backup, without ignoring other cooldowns`,()=>{
  const snapshot={leases:[],waiters:[],circuits:[{host:PRIVATE_RPC_HOST,operation,until_ms:NOW+30000}]};
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),'bsc-rpc.publicnode.com');
  snapshot.circuits.push({host:'bsc-rpc.publicnode.com',operation:'eth_call',until_ms:NOW+30000});
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),undefined);
});

for(const operation of ['*','eth_call'])test(`paid depth active ${operation} recovery yields to healthy backup until its probe is idle`,()=>{
  const snapshot={leases:[{host:PRIVATE_RPC_HOST,operation:'eth_call',lane:'realtime'},
    {host:'bsc-rpc.publicnode.com',operation:'eth_call',lane:'background'}],waiters:[],
    circuits:[{host:PRIVATE_RPC_HOST,operation,until_ms:NOW-1}]};
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),'bsc-rpc.publicnode.com');
  snapshot.leases.shift();
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,privateEndpoints),PRIVATE_RPC_HOST);
});

test('depth without a configured preferred endpoint preserves availability-first public selection',()=>{
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'];
  const snapshot={leases:[{host:hosts[0],operation:'eth_call',lane:'background'}],waiters:[],circuits:[]};
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW),hosts[1]);
  assert.equal(selectInternalDepthRpcHost(snapshot,NOW,hosts.map(host=>({host,url:`https://${host}`}))),hosts[1]);
});

test('busy configured depth reader queues only paid host within original background limits and keeps secrets out',async()=>{
  const calls=[],proof=depthFixture(token,10,9.7,NOW);
  const coordinator={snapshot:()=>({leases:[{host:PRIVATE_RPC_HOST,operation:'eth_call',lane:'background'}],waiters:[],circuits:[]}),
    run:async(host,method,lane,_fn,options)=>{calls.push({host,method,lane,options});
      throw Object.assign(Error(`busy https://${PRIVATE_RPC_HOST}/${PRIVATE_RPC_SECRET}`),{
        code:'RPC_COORDINATOR_UNAVAILABLE',rpcFailureScope:'capacity',retryAfterMs:100});}};
  const probe=createInternalDepthProbe({dataDir:'unused-private-depth-test',now:()=>NOW,coordinator,rpcEndpoints:privateEndpoints});
  const result=await probe.probe({token,budgetUsd:10,notionalUsd:9.7,referenceAt:proof.referenceAt});
  assert.equal(result.status,'unavailable');assert.equal(result.proof,undefined);assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{host:PRIVATE_RPC_HOST,method:'eth_chainId',lane:'background',options:{waitMs:200}});
  assert.equal(result.diagnostics.host,PRIVATE_RPC_HOST);assert.equal(result.diagnostics.physicalRequests,0);
  assert.equal(result.rpcFailureScope,'capacity');assert.equal(result.retryAfterMs,100);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(PRIVATE_RPC_SECRET));
});
for(const fixture of [depthFixture,flapDepthFixture,flapQuoteDepthFixture])test(`${fixture.name}: budget and full post-cost notional must be numeric and bound`,()=>{
  const good=fixture(token,10,9.7,NOW);
  assert.equal(internalDepthCheck(good,token,10,NOW,null,9.7).ready,true);
  for(const notional of [1,9.6,null,NaN,Infinity,'9.7'])
    assert.equal(internalDepthCheck(good,token,10,NOW,null,notional).ready,false,String(notional));
  for(const budgetUsd of [undefined,null,NaN,Infinity,'10',9])
    assert.equal(internalDepthCheck({...good,budgetUsd},token,10,NOW,null,9.7).ready,false,String(budgetUsd));
});
test('real raw curve proof binds budget, chain, CA, block, USD feed, direction and freshness',()=>{
  const good=depthFixture(token,10,9.7,NOW);
  assert.ok(internalDepthCheck(good,token,10,NOW).ready);
  assert.ok(Math.abs(internalDepthCheck(good,token,10,NOW).sellUsd-9.603)<1e-9,'trySell funds already net, fee must not be subtracted again');
  for(const mutate of [p=>p.chainId=1,p=>p.address='0x'+'b'.repeat(40),p=>p.budgetUsd=11,p=>p.endBlockHash='0x'+'d'.repeat(64),
    p=>p.block.timestamp+=1,p=>p.observedAt=new Date(NOW-16000).toISOString(),p=>p.referencePrice=2,
    p=>p.raw.sell='0x',p=>p.amount='1',p=>p.raw.oracle=depthAbi.encodeFunctionResult('latestRoundData',[2,100000000000n,NOW/1000-4000,NOW/1000-4000,1]),
    p=>p.raw.info=depthAbi.encodeFunctionResult('getTokenInfo',[2,'0x'+'a'.repeat(40),'0x'+'0'.repeat(40),1,100,1,NOW/1000-60,1,2,1,2,true])]) {
    const p=structuredClone(good);mutate(p);assert.equal(internalDepthCheck(p,token,10,NOW).ready,false,mutate.toString());
  }
  assert.equal(internalDepthCheck(good,token,9,NOW).ready,false,'serialized resized budget must be requoted');
  assert.equal(internalDepthCheck(good,token,10,NOW+21000).ready,false);
  assert.equal(internalDepthCheck(good,token,10,NOW,{sourceAt:new Date(NOW+1).toISOString()}).ready,false);
});
test('provider only issues bounded pinned-block read methods; unsupported and failures stay unavailable',async()=>{
  const good=depthFixture(token,10,9.7,NOW),calls=[];
  const reader={getNetwork:async()=>({chainId:56}),getBlockNumber:async()=>12345,getBlock:async n=>({...good.block,number:n}),
    call:async q=>{calls.push(q);assert.equal(q.blockTag,12345);const parsed=depthAbi.parseTransaction({data:q.data});
      if(parsed.name==='decimals')return good.raw[q.to===BNB_ORACLE?'oracleDecimals':'decimals'];
      if(parsed.name==='latestRoundData')return good.raw.oracle;
      assert.equal(q.to,FOUR_HELPER);assert.equal(parsed.args[0].toLowerCase(),token.address);
      return good.raw[parsed.name==='getTokenInfo'?'info':parsed.name==='trySell'?'sell':parsed.args[1].toString()===good.amount?'buy':'smallBuy'];}};
  const probe=createInternalDepthProbe({reader,now:()=>NOW});
  const r=await probe.probe({token,budgetUsd:10,notionalUsd:9.7,referenceAt:good.referenceAt});
  assert.equal(r.status,'ok',r.reason);assert.equal(calls.length,7);assert.ok(internalDepthCheck(r.proof,token,10,NOW).ready);
  reader.call=async()=>{throw Error('provider unavailable');};
  assert.equal((await probe.probe({token,budgetUsd:10,notionalUsd:9.7,referenceAt:good.referenceAt})).status,'unavailable');
});
test('Flap native curve admits raw eth_call quotes, not an address suffix or migrated/custom/hooked pool',()=>{
  const p=flapDepthFixture(token,10,9.7,NOW);assert.ok(internalDepthCheck(p,token,10,NOW).ready);
  for(const [index,value] of [[0,4],[4,8],[9,'0x'+'b'.repeat(40)],[11,'0x'+'d'.repeat(64)],[12,601],[13,601],[14,'0x'+'b'.repeat(40)]]) {
    const x=structuredClone(p),state=[...FLAP_DEPTH_ABI.decodeFunctionResult('getTokenV8Safe',x.raw.info)[0]];state[index]=value;
    x.raw.info=FLAP_DEPTH_ABI.encodeFunctionResult('getTokenV8Safe',[state]);assert.equal(internalDepthCheck(x,token,10,NOW).ready,false,String(index));
  }
  const x=structuredClone(p);x.raw.portalVersion=FLAP_DEPTH_ABI.encodeFunctionResult('version',['future-unknown']);assert.equal(internalDepthCheck(x,token,10,NOW).ready,false);
});
test('Flap quote method is non-view but only eth_call is made, with correct buy/sell legs at same block',async()=>{
  const t={...token,launchpad:'flap'},p=flapDepthFixture(t,10,9.7,NOW),legs=[];
  const reader={getNetwork:async()=>({chainId:56}),getBlockNumber:async()=>12345,getBlock:async()=>p.block,
    call:async q=>{
      assert.equal(q.blockTag,12345);
      if(q.to!==FLAP_DEPTH_PORTAL){const tx=depthAbi.parseTransaction({data:q.data});return p.raw[tx.name==='latestRoundData'?'oracle':q.to===BNB_ORACLE?'oracleDecimals':'decimals'];}
      const tx=FLAP_DEPTH_ABI.parseTransaction({data:q.data});
      if(tx.name==='getTokenV8Safe'){assert.equal(tx.args[0].toLowerCase(),t.address);return p.raw.info;}
      if(tx.name==='version')return p.raw.portalVersion;
      const leg=tx.args[0];legs.push(leg);
      return p.raw[leg[0].toLowerCase()===t.address?'sell':leg[2].toString()===p.amount?'buy':'smallBuy'];
    }};
  const result=await createInternalDepthProbe({reader,now:()=>NOW}).probe({token:t,budgetUsd:10,notionalUsd:9.7,referenceAt:p.referenceAt});
  assert.equal(result.status,'ok',result.reason);assert.equal(legs.length,3);
  assert.equal(legs[0][1].toLowerCase(),t.address);assert.equal(legs[2][0].toLowerCase(),t.address);
  assert.equal(legs[2][2],FLAP_DEPTH_ABI.decodeFunctionResult('quoteExactInput',p.raw.buy)[0]);
});

test('Flap ERC20 quote reserve uses quote units and requires an explicit bidirectional BNB path',()=>{
  const p=flapQuoteDepthFixture(token,10,9.7,NOW),r=internalDepthCheck(p,token,10,NOW);
  assert.equal(r.ready,true,r.reason);assert.equal(r.quoteDecimals,6);assert.equal(r.quoteExitAmount,'9.5');
  assert.ok(Math.abs(r.sellUsd-9.506)<1e-8);
  for(const mutate of [p=>p.quoteAddress=token.address,p=>p.raw.quoteDecimals='0x',p=>p.raw.sell='0x',
    p=>p.raw.quoteSell=FLAP_DEPTH_ABI.encodeFunctionResult('quoteExactInput',[100000001n]),
    p=>p.raw.quoteConfig=FLAP_DEPTH_ABI.encodeFunctionResult('getQuoteTokenConfiguration',[[1,7,7,8,0]]),
    p=>{const s=[...FLAP_DEPTH_ABI.decodeFunctionResult('getTokenV8Safe',p.raw.info)[0]];s[10]=false;p.raw.info=FLAP_DEPTH_ABI.encodeFunctionResult('getTokenV8Safe',[s]);}]) {
    const x=structuredClone(p);mutate(x);assert.equal(internalDepthCheck(x,token,10,NOW).ready,false,mutate.toString());
  }
});

for(const swapType of [6,7])test(`Flap quote type ${swapType} still requires both directions, exact identity and a known DEX`,()=>{
  const p=flapQuoteDepthFixture(token,10,9.7,NOW);
  p.raw.quoteConfig=FLAP_DEPTH_ABI.encodeFunctionResult('getQuoteTokenConfiguration',[[1,7,7,swapType,0]]);
  assert.equal(internalDepthCheck(p,token,10,NOW).ready,true);
  for(const mutate of [p=>p.raw.sell='0x',p=>p.raw.quoteSell='0x',p=>p.endBlockHash='0x'+'f'.repeat(64),
    p=>p.raw.quoteConfig=FLAP_DEPTH_ABI.encodeFunctionResult('getQuoteTokenConfiguration',[[1,7,7,6,1]]),
    p=>p.raw.quoteConfig=FLAP_DEPTH_ABI.encodeFunctionResult('getQuoteTokenConfiguration',[[0,7,7,6,0]])]) {
    const x=structuredClone(p);mutate(x);assert.equal(internalDepthCheck(x,token,10,NOW).ready,false);
  }
});

for(const swapType of [2,6,7])test(`Flap quote-asset probe type ${swapType} pins its block and fails closed without reverse native route`,async()=>{
  const t={...token,launchpad:'flap'},p=flapQuoteDepthFixture(t,10,9.7,NOW),legs=[];
  p.raw.quoteConfig=FLAP_DEPTH_ABI.encodeFunctionResult('getQuoteTokenConfiguration',[[1,7,7,swapType,0]]);
  let failReverse=false;
  const reader={getNetwork:async()=>({chainId:56}),getBlockNumber:async()=>12345,getBlock:async()=>p.block,
    call:async q=>{
      assert.equal(q.blockTag,12345);
      if(q.to!==FLAP_DEPTH_PORTAL){const tx=depthAbi.parseTransaction({data:q.data});return p.raw[tx.name==='latestRoundData'?'oracle'
        :q.to===BNB_ORACLE?'oracleDecimals':q.to===p.quoteAddress?'quoteDecimals':'decimals'];}
      const tx=FLAP_DEPTH_ABI.parseTransaction({data:q.data});
      if(tx.name==='getTokenV8Safe')return p.raw.info;
      if(tx.name==='version')return p.raw.portalVersion;
      if(tx.name==='getQuoteTokenConfiguration'){assert.equal(tx.args[0].toLowerCase(),p.quoteAddress);return p.raw.quoteConfig;}
      const leg=tx.args[0];legs.push(leg);
      if(leg[0].toLowerCase()===t.address){
        if(leg[1].toLowerCase()===p.quoteAddress)return p.raw.quoteSell;
        if(failReverse)throw Error('unsupported reverse conversion');
        return p.raw.sell;
      }
      return p.raw[leg[2].toString()===p.amount?'buy':'smallBuy'];
    }};
  const probe=createInternalDepthProbe({reader,now:()=>NOW});
  const args={token:t,budgetUsd:10,notionalUsd:9.7,referenceAt:p.referenceAt};
  const result=await probe.probe(args);
  assert.equal(result.status,'ok',result.reason);assert.equal(legs.length,4);
  assert.equal(legs[2][1].toLowerCase(),p.quoteAddress);assert.equal(legs[3][1],'0x'+'0'.repeat(40));
  failReverse=true;const unavailable=await probe.probe(args);
  assert.equal(unavailable.status,'unavailable');assert.match(unavailable.reason,/反向 BNB/);assert.equal(unavailable.proof,undefined);
});

test('depth host selection prefers an available background seat over equal background load',async()=>{
  const {selectInternalDepthRpcHost}=await import('../src/paper-internal-depth.js');
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'];
  const state={leases:[{host:hosts[0],lane:'background',operation:'eth_call'},{host:hosts[1],lane:'realtime',operation:'eth_getLogs'}],
    waiters:[],circuits:[{host:hosts[2],operation:'*',until_ms:NOW+30000}]};
  const before=structuredClone(state);
  assert.equal(selectInternalDepthRpcHost(state,NOW),hosts[1]);
  assert.deepEqual(state,before,'selection must not mutate shared capacity or circuit state');
});

test('depth host selection ranks the total physical cap before queue load',async()=>{
  const {selectInternalDepthRpcHost}=await import('../src/paper-internal-depth.js');
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'];
  const state={leases:[{host:hosts[0],lane:'realtime',operation:'eth_getLogs'},{host:hosts[0],lane:'realtime',operation:'eth_blockNumber'},
    {host:hosts[1],lane:'realtime',operation:'eth_getLogs'}],waiters:[{host:hosts[1],lane:'realtime'}],
    circuits:[{host:hosts[2],operation:'*',until_ms:NOW+30000}]};
  assert.equal(selectInternalDepthRpcHost(state,NOW),hosts[1]);
});

for(const operation of ['*','eth_call'])test(`depth host selection respects active ${operation} half-open probes and idle recovery`,async()=>{
  const {selectInternalDepthRpcHost}=await import('../src/paper-internal-depth.js');
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'];
  const state={leases:[{host:hosts[0],lane:'realtime',operation:'eth_call'},{host:hosts[1],lane:'realtime',operation:'eth_call'}],
    waiters:[],circuits:[{host:hosts[0],operation,until_ms:NOW-1},{host:hosts[2],operation:'*',until_ms:NOW+30000}]};
  assert.equal(selectInternalDepthRpcHost(state,NOW),hosts[1]);
  state.leases.shift();
  assert.equal(selectInternalDepthRpcHost(state,NOW),hosts[0],'an idle half-open host remains eligible for its one probe');
});

test('depth host selection excludes only relevant cooling methods and retains no-host failure',async()=>{
  const {selectInternalDepthRpcHost}=await import('../src/paper-internal-depth.js');
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'];
  const state={leases:[],waiters:[],circuits:hosts.map(host=>({host,operation:'eth_call',until_ms:NOW+30000}))};
  assert.equal(selectInternalDepthRpcHost(state,NOW),undefined);
  state.circuits[0].operation='eth_getLogs';
  assert.equal(selectInternalDepthRpcHost(state,NOW),hosts[0],'an unrelated log cooldown does not disable depth reads');
});

function batchFixture(kind) {
  const t={...token,...(kind==='four'?{}:{launchpad:'flap'})};
  const proof=(kind==='four'?depthFixture:kind==='flap'?flapDepthFixture:flapQuoteDepthFixture)(t,10,9.7,NOW);
  const batches=[],gateCalls=[],cooldowns=[];
  const single=async q=>{
    assert.equal(q.blockTag,proof.block.number,'all quotes/metadata use the same numeric block');
    if(q.to===FLAP_DEPTH_PORTAL){const tx=FLAP_DEPTH_ABI.parseTransaction({data:q.data});
      if(tx.name==='getTokenV8Safe')return proof.raw.info;
      if(tx.name==='version')return proof.raw.portalVersion;
      if(tx.name==='getQuoteTokenConfiguration')return proof.raw.quoteConfig;
      const leg=tx.args[0];return proof.raw[leg[0].toLowerCase()===t.address
        ?leg[1].toLowerCase()===proof.quoteAddress?'quoteSell':'sell':leg[2].toString()===proof.amount?'buy':'smallBuy'];
    }
    const tx=depthAbi.parseTransaction({data:q.data});
    if(tx.name==='decimals')return proof.raw[q.to===BNB_ORACLE?'oracleDecimals':q.to===proof.quoteAddress?'quoteDecimals':'decimals'];
    if(tx.name==='latestRoundData')return proof.raw.oracle;
    assert.equal(q.to,FOUR_HELPER);
    return proof.raw[tx.name==='getTokenInfo'?'info':tx.name==='trySell'?'sell':tx.args[1].toString()===proof.amount?'buy':'smallBuy'];
  };
  const reader={getNetwork:async()=>({chainId:56}),getBlockNumber:async()=>proof.block.number,getBlock:async()=>proof.block,call:single,
    callBatch:async values=>{batches.push(values);assert.ok(values.length<=8);const out=[];
      for(const q of values)out.push({status:'fulfilled',value:await single(q)});return out;}};
  const coordinator={run:async(host,method,lane,fn,options)=>{gateCalls.push({host,method,lane,options});return fn();},persistCooldown:async(...args)=>cooldowns.push(args)};
  return {reader,coordinator,batches,gateCalls,cooldowns,args:{token:t,budgetUsd:10,notionalUsd:9.7,referenceAt:proof.referenceAt}};
}

for(const [kind,physical,items] of [['four',7,11],['flap',8,12],['quote',8,15]])test(`${kind}: same-block batches reduce HTTP leases without reducing proof checks or RPC accounting`,async()=>{
  const f=batchFixture(kind),r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
  assert.equal(r.status,'ok',r.reason);assert.equal(r.diagnostics.physicalRequests,physical);assert.equal(r.diagnostics.rpcItems,items);
  assert.equal(f.gateCalls.length,physical);assert.ok(f.gateCalls.every(x=>x.lane==='background'&&x.options.waitMs===200));
  assert.ok(f.gateCalls.every(x=>/^eth_/.test(x.method)),'canonical method scopes share cooldowns across clients');
  assert.equal(internalDepthCheck(r.proof,f.args.token,10,NOW,null,9.7).ready,true);
});

for(const malformed of ['missing','revert','bytes'])test(`malformed ${malformed} batch stays unavailable with no sequential retry`,async()=>{
  const f=batchFixture('flap');let batches=0,singleCalls=0;const one=f.reader.call;
  f.reader.call=async q=>{singleCalls++;return one(q);};
  f.reader.callBatch=async values=>{batches++;const rows=await Promise.all(values.map(async q=>({status:'fulfilled',value:await one(q)})));
    if(malformed==='missing')rows.pop();if(malformed==='revert')rows[0]={status:'rejected',code:'CALL_REVERTED'};
    if(malformed==='bytes')rows[0].value='invalid';return rows;};
  const r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
  assert.equal(r.status,'unavailable');assert.equal(r.proof,undefined);assert.equal(batches,1);assert.equal(singleCalls,1);
  assert.equal(r.diagnostics.failedMethod,'eth_call');
});

for(const error of [{code:'RPC_TIMEOUT'},{code:'TIMEOUT'},{status:429,retryAfter:'45'},{status:503},{code:'ECONNRESET'}])test(`depth ${JSON.stringify(error)} shares endpoint cooldown and reports failure method`,async()=>{
  const f=batchFixture('four');f.reader.getNetwork=async()=>{throw Object.assign(Error('fixture'),error);};
  const r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
  assert.equal(r.status,'unavailable');assert.equal(r.proof,undefined);assert.equal(r.diagnostics.failedMethod,'eth_chainId');
  assert.equal(r.diagnostics.physicalRequests,1);assert.equal(f.cooldowns.length,1);
  assert.equal(f.cooldowns[0][1],'eth_chainId');assert.equal(f.cooldowns[0][2],NOW+(error.retryAfter?45000:30000));
});

test('depth local queue contention never becomes provider cooldown or retries another host',async()=>{
  const f=batchFixture('four');f.coordinator.run=async()=>{throw Object.assign(Error('busy'),{
    code:'RPC_COORDINATOR_UNAVAILABLE',rpcFailureScope:'capacity',retryAfterMs:100});};
  const r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
  assert.equal(r.status,'unavailable');assert.equal(r.code,'RPC_COORDINATOR_UNAVAILABLE');assert.equal(r.diagnostics.physicalRequests,0);
  assert.equal(r.rpcFailureScope,'capacity');assert.equal(r.retryAfterMs,100);
  assert.deepEqual(f.cooldowns,[]);
});

for(const scope of ['host','method'])test(`depth preserves ${scope} cooldown scheduling without granting a capacity retry`,async()=>{
  const f=batchFixture('four');f.coordinator.run=async()=>{throw Object.assign(Error('private provider detail'),{
    code:'RPC_COORDINATOR_UNAVAILABLE',rpcFailureScope:scope,retryAfterMs:600000,providerUrl:'https://private.invalid/secret'});};
  const r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
  assert.equal(r.rpcFailureScope,scope);assert.equal(r.retryAfterMs,600000);
  assert.equal(r.diagnostics.physicalRequests,0);assert.equal(r.proof,undefined);
  assert.doesNotMatch(JSON.stringify(r),/private provider detail|private\.invalid|secret/);
  assert.deepEqual(f.cooldowns,[]);
});

for(const retryAfterMs of [undefined,null,0,-1,1.5,'100',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
  test(`depth never coerces malformed coordinator retry metadata ${String(retryAfterMs)}`,async()=>{
    const f=batchFixture('four');f.coordinator.run=async()=>{throw Object.assign(Error('busy'),{
      code:'RPC_COORDINATOR_UNAVAILABLE',rpcFailureScope:'capacity',retryAfterMs});};
    const r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
    assert.equal(r.rpcFailureScope,'capacity');assert.equal(Object.hasOwn(r,'retryAfterMs'),false);
    assert.equal(r.diagnostics.physicalRequests,0);
  });

for(const metadata of [{code:'RPC_READ_FAILED',rpcFailureScope:'capacity',retryAfterMs:100},
  {code:'RPC_COORDINATOR_UNAVAILABLE',rpcFailureScope:'unknown',retryAfterMs:100}])
  test(`depth only forwards recognized coordinator metadata ${JSON.stringify(metadata)}`,async()=>{
    const f=batchFixture('four');f.coordinator.run=async()=>{throw Object.assign(Error('fixture'),metadata);};
    const r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
    assert.equal(Object.hasOwn(r,'rpcFailureScope'),false);assert.equal(Object.hasOwn(r,'retryAfterMs'),false);
  });

for(const retryAfter of ['600',new Date(NOW+600000).toUTCString()])test(`depth respects the full server Retry-After ${retryAfter}`,async()=>{
  const f=batchFixture('four');f.reader.getNetwork=async()=>{throw Object.assign(Error('fixture'),{status:429,retryAfter});};
  const r=await createInternalDepthProbe({...f,now:()=>NOW}).probe(f.args);
  assert.equal(r.status,'unavailable');assert.equal(r.proof,undefined);assert.equal(r.diagnostics.physicalRequests,1);
  assert.deepEqual(f.cooldowns, [['bsc-rpc.publicnode.com','eth_chainId',NOW+600000]]);
});

test('depth expired queued callback cannot dispatch or grant a proof',async()=>{
  const f=batchFixture('four');let time=NOW;f.coordinator.run=async(_h,_m,_l,fn)=>{time+=10001;return fn();};
  const r=await createInternalDepthProbe({...f,now:()=>time}).probe(f.args);
  assert.equal(r.status,'unavailable');assert.equal(r.code,'ROUND_TIMEOUT');assert.equal(r.diagnostics.physicalRequests,0);
  assert.deepEqual(f.cooldowns,[]);assert.equal(r.proof,undefined);
});

test('depth last RPC response crossing the round deadline cannot grant an otherwise valid proof',async()=>{
  const f=batchFixture('four');let time=NOW,headers=0;const block=f.reader.getBlock;
  f.reader.getBlock=async()=>{const r=await block();if(++headers===2)time+=10001;return r;};
  const r=await createInternalDepthProbe({...f,now:()=>time}).probe(f.args);
  assert.equal(r.status,'unavailable');assert.equal(r.code,'ROUND_TIMEOUT');assert.equal(r.proof,undefined);
  assert.equal(r.diagnostics.failedMethod,'eth_getBlockByNumber');assert.deepEqual(f.cooldowns,[]);
});

test('depth last lease release crossing the deadline cannot grant a proof',async()=>{
  const f=batchFixture('four');let time=NOW,headers=0;
  f.coordinator.run=async(_host,method,_lane,fn)=>{
    const result=await fn();if(method==='eth_getBlockByNumber'&&++headers===2)time+=10001;return result;
  };
  const r=await createInternalDepthProbe({...f,now:()=>time}).probe(f.args);
  assert.equal(r.status,'unavailable');assert.equal(r.code,'ROUND_TIMEOUT');assert.equal(r.proof,undefined);
  assert.equal(r.diagnostics.failedMethod,'eth_getBlockByNumber');assert.deepEqual(f.cooldowns,[]);
});
