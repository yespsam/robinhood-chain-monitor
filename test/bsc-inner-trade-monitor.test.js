import test from 'node:test';
import assert from 'node:assert/strict';
import {ZeroAddress} from 'ethers';
import {createInnerTradeMonitor,createInnerTradeRpcReader} from '../src/bsc-inner-trade-monitor.js';
import {INNER_TRADE_EMITTERS,INNER_TRADE_ORACLE,INNER_TRADE_ORACLE_ABI,INNER_TRADE_ERC20_ABI,normalizeInnerTradeWindow} from '../src/bsc-inner-trade-events.js';
import {buildInnerTradeFixture,buildInnerTradeLog,innerTradeTestHash as hash,INNER_TRADE_TEST_NOW as BASE,INNER_TRADE_TEST_CA as CA} from './helpers/inner-trade-fixture.js';

const PRIVATE_RPC_HOST='bsc-mainnet.core.chainstack.com';
const PRIVATE_RPC_SECRET='0123456789abcdef0123456789abcdef';
const PRIVATE_RPC_URL=`https://${PRIVATE_RPC_HOST}/${PRIVATE_RPC_SECRET}`;
const privateEndpoints=()=>[
  {host:'bsc-rpc.publicnode.com',url:'https://bsc-rpc.publicnode.com'},
  {host:PRIVATE_RPC_HOST,url:PRIVATE_RPC_URL,preferred:true},
];

test('private read-only endpoint preserves its credential path in transport only',async()=>{
  const requests=[];
  const rpc=createInnerTradeRpcReader({host:PRIVATE_RPC_HOST,endpointUrl:PRIVATE_RPC_URL,fetchImpl:async(url,options)=>{
    requests.push({url,options});const request=JSON.parse(options.body);
    return {status:200,url,headers:{get:()=>null},text:async()=>JSON.stringify({jsonrpc:'2.0',id:request.id,result:'0x38'})};
  }});
  assert.deepEqual(await rpc.getNetwork(),{chainId:56});assert.equal(requests.length,1);
  assert.equal(requests[0].url,PRIVATE_RPC_URL);assert.equal(requests[0].options.redirect,'error');
  assert.equal(rpc.url,undefined);assert.equal(rpc.endpointUrl,undefined);
  assert.doesNotMatch(JSON.stringify(rpc),new RegExp(PRIVATE_RPC_SECRET));
  assert.equal(rpc.send,undefined);assert.equal(rpc.sendTransaction,undefined);
});

for(const responseUrl of ['https://other.example/secret',`https://${PRIVATE_RPC_HOST}.evil.example/${PRIVATE_RPC_SECRET}`])
test('private reader rejects a cross-origin response without disclosing its URL',async()=>{
  const rpc=createInnerTradeRpcReader({host:PRIVATE_RPC_HOST,endpointUrl:PRIVATE_RPC_URL,fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body);return {status:200,url:responseUrl,headers:{get:()=>null},
      text:async()=>JSON.stringify({jsonrpc:'2.0',id:request.id,result:'0x38'})};
  }});
  await assert.rejects(rpc.getNetwork(),error=>{
    assert.equal(error.code,'RPC_ORIGIN_MISMATCH');assert.equal(error.cause,undefined);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`,new RegExp(PRIVATE_RPC_SECRET));return true;
  });
});

test('private reader strips raw transport errors and retains only safe retry metadata',async()=>{
  const rpc=createInnerTradeRpcReader({host:PRIVATE_RPC_HOST,endpointUrl:PRIVATE_RPC_URL,fetchImpl:async()=>{
    throw Object.assign(new TypeError(`failed ${PRIVATE_RPC_URL}`),{status:429,retryAfter:'600',
      cause:{url:PRIVATE_RPC_URL},request:{url:PRIVATE_RPC_URL},body:PRIVATE_RPC_SECRET});
  }});
  await assert.rejects(rpc.getNetwork(),error=>{
    assert.equal(error.status,429);assert.equal(error.retryAfter,'600');assert.equal(error.cause,undefined);
    assert.equal(error.request,undefined);assert.equal(error.body,undefined);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`,new RegExp(PRIVATE_RPC_SECRET));return true;
  });
});

for(const condition of ['ready','cooling','busy','full','queued','half_open'])test(`private inner endpoint preference respects ${condition} shared capacity`,async()=>{
  const calls=[],circuits=condition==='cooling'?[{host:PRIVATE_RPC_HOST,operation:'eth_call',until_ms:BASE+30000}]
    :condition==='half_open'?[{host:PRIVATE_RPC_HOST,operation:'eth_call',until_ms:BASE-1}]:[];
  const leases=condition==='busy'?[{host:PRIVATE_RPC_HOST,lane:'background',operation:'eth_call'}]
    :condition==='full'?[{host:PRIVATE_RPC_HOST,lane:'realtime',operation:'eth_call'},{host:PRIVATE_RPC_HOST,lane:'realtime',operation:'eth_getLogs'}]
    :condition==='half_open'?[{host:PRIVATE_RPC_HOST,lane:'realtime',operation:'eth_call'}]:[];
  const waiters=condition==='queued'?[{host:PRIVATE_RPC_HOST,lane:'background'}]:[];
  const coordinator={snapshot:()=>({leases,waiters,circuits}),
    run:async(host,method,lane,_fn,options)=>{calls.push({host,method,lane,options});
      throw Object.assign(new Error(`busy ${PRIVATE_RPC_URL}`),{code:'RPC_COORDINATOR_UNAVAILABLE'});}};
  const m=createInnerTradeMonitor({dataDir:'unused-private-endpoint-test',now:()=>BASE,coordinator,rpcEndpoints:privateEndpoints()});
  await m.refresh({tokens:[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'}]});
  assert.equal(calls.length,1,'a capacity refusal cannot trigger same-round host hopping');
  assert.equal(calls[0].host,['cooling','half_open'].includes(condition)?'bsc-rpc.publicnode.com':PRIVATE_RPC_HOST);
  assert.equal(calls[0].lane,'background');assert.equal(calls[0].options.waitMs,1000);
  assert.equal(m.snapshot().lastRound.physicalRequests,0);
  assert.doesNotMatch(JSON.stringify(m.snapshot()),new RegExp(PRIVATE_RPC_SECRET));await m.stop();
});

test('configured monitor sends through the private reader but wrong-chain data cannot become evidence',async()=>{
  const urls=[],gateCalls=[],original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{urls.push(url);const request=JSON.parse(options.body);
    return {status:200,url,headers:{get:()=>null},text:async()=>JSON.stringify({jsonrpc:'2.0',id:request.id,result:'0x1'})};};
  let m;
  try {
    m=createInnerTradeMonitor({dataDir:'unused-private-endpoint-test',now:()=>BASE,rpcEndpoints:privateEndpoints(),
      coordinator:{snapshot:()=>({leases:[],waiters:[],circuits:[]}),
        run:async(host,method,lane,fn)=>{gateCalls.push({host,method,lane});return fn();}}});
  }finally{globalThis.fetch=original;}
  await m.refresh({tokens:[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'}]});
  assert.deepEqual(urls,[PRIVATE_RPC_URL]);assert.deepEqual(gateCalls,[{host:PRIVATE_RPC_HOST,method:'eth_chainId',lane:'background'}]);
  assert.equal(m.snapshot().status,'unavailable');assert.equal(m.snapshot().lastError.code,'CHAIN_MISMATCH');
  assert.deepEqual(m.snapshot().windows,[]);assert.equal(m.snapshot().lastRound.physicalRequests,1);
  assert.doesNotMatch(JSON.stringify(m.snapshot()),new RegExp(PRIVATE_RPC_SECRET));await m.stop();
});

function fixture({blockMs=250}={}) {
  let clock=BASE,failMethod=null,forkAt=Infinity,logsMode='normal',networkHook=null;
  const calls=[],blocked=new Set();
  const tokens=[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'},
    {chain:'bsc',address:'0x'+'b'.repeat(40),marketStage:'near_completion',platform:'flap'}];
  const block=n=>({number:n,hash:hash(n+(n>=forkAt?900000:0)),parentHash:hash(n-1+(n-1>=forkAt?900000:0)),timestamp:Math.floor(BASE/1000-1+(n-10000)*blockMs/1000)});
  const current=()=>10000+Math.floor((clock-BASE)/blockMs);
  const remember=(name,args)=>{calls.push({name,args});if(failMethod===name)throw Object.assign(Error('fixture upstream busy'),{status:429});};
  const reader={
    async getNetwork(o){remember('getNetwork',[]);if(networkHook)return networkHook(o);return {chainId:56};},
    async getBlockNumber(){remember('getBlockNumber',[]);return current()+8;},
    async getBlock(n){remember('getBlock',[n]);return block(n);},
    async getBlocks(ns){remember('getBlocks',[ns]);assert.ok(ns.length<=8);return ns.map(block);},
    async getLogs(filter){remember('getLogs',[filter]);const platform=filter.address===INNER_TRADE_EMITTERS.flap.address?'flap':'four_v2';
      const active=tokens.filter(t=>t.platform===platform);let logs=active.map((t,i)=>buildInnerTradeLog({platform},'buy',block(filter.toBlock),i,t.address,filter.toBlock*10+i));
      if(logsMode==='dense')logs=Array.from({length:30},(_,i)=>buildInnerTradeLog({platform},'buy',block(filter.fromBlock+i),i,active[0].address,(filter.fromBlock+i)*10));
      if(logsMode==='overbudget')logs=Array.from({length:60},(_,i)=>buildInnerTradeLog({platform},'buy',block(filter.fromBlock+i),i,active[0].address,(filter.fromBlock+i)*10));
      if(logsMode==='limit')logs=Array.from({length:2000},()=>logs[0]);
      if(logsMode==='wronghash')logs[0].blockHash=hash(999);
      if(logsMode==='removed')logs[0].removed=true;
      if(logsMode==='wrongabi')logs[0].data+='00'.repeat(32);
      return logs;
    },
    async call(q){remember('call',[q]);assert.equal(q.blockTag,current(),'all metadata is pinned to this observed confirmed head');
      if(q.data===INNER_TRADE_ERC20_ABI.encodeFunctionData('decimals'))return INNER_TRADE_ERC20_ABI.encodeFunctionResult('decimals',[q.to===INNER_TRADE_ORACLE?8:18]);
      if(q.to===INNER_TRADE_ORACLE)return INNER_TRADE_ORACLE_ABI.encodeFunctionResult('latestRoundData',[1,100000000000n,block(current()).timestamp-10,block(current()).timestamp-10,1]);
      const platform=q.to===INNER_TRADE_EMITTERS.flap.metadataSource?'flap':'four_v2',spec=INNER_TRADE_EMITTERS[platform],p=buildInnerTradeFixture(platform,BASE);
      const tx=spec.metadataAbi.parseTransaction({data:q.data});
      if(tx.name==='version')return p.metadata.raw.portalVersion;
      if(blocked.has(tx.args[0].toLowerCase())) {
        const info=[...spec.metadataAbi.decodeFunctionResult(spec.metadataMethod,p.metadata.raw.info)];
        if(platform==='four_v2')info[2]='0x'+'d'.repeat(40);else {info[0]=[...info[0]];info[0][9]='0x'+'d'.repeat(40);}
        return spec.metadataAbi.encodeFunctionResult(spec.metadataMethod,info);
      }
      return p.metadata.raw.info;
    },
  };
  return {tokens,reader,calls,blocked,now:()=>clock,advance:n=>clock+=n,block,current,
    fail:name=>failMethod=name,fork:n=>forkAt=n,logs:mode=>logsMode=mode,network:fn=>networkHook=fn};
}

test('incremental Four and Flap native windows warm up without old backfill, retain bounded continuous evidence',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});
  await m.refresh({tokens:f.tokens});
  assert.equal(m.snapshot().status,'warming_up');assert.equal(m.snapshot().windows.length,2);
  assert.ok(f.calls.filter(c=>c.name==='getLogs').every(c=>c.args[0].fromBlock===f.current()),'startup reads only its current confirmed block');
  for(let i=0;i<14;i++){f.advance(10000);await m.refresh({tokens:f.tokens});}
  const s=m.snapshot();assert.equal(s.status,'ready',JSON.stringify(s.lastError));assert.equal(s.windows.length,2);
  for(const p of s.windows){assert.equal(normalizeInnerTradeWindow(p,f.now()).ready,true);assert.ok(p.toBlock.timestamp-p.fromBlock.timestamp>=90);assert.ok(p.toBlock.timestamp-p.fromBlock.timestamp<=130);}
  assert.ok(s.lastRound.physicalRequests<=32);assert.ok(s.lastRound.rpcItems<=64);assert.ok(s.checks.every(c=>c.status==='covered'));
  assert.equal(s.limits.confirmationDepth,8);assert.equal(s.lastRound.confirmationDepth,8);assert.equal(s.lastRound.reportedHead-s.lastRound.headBlock,8);
  await m.stop();assert.equal(m.snapshot().status,'stopped');assert.deepEqual(m.snapshot().windows,[]);
});

test('ten-second admission, exit priority, target cap and no duplicate in-flight producer',async()=>{
  const f=fixture();let release;f.network(({signal})=>new Promise((resolve,reject)=>{release=()=>resolve({chainId:56});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});
  await m.refresh({tokens:f.tokens,exitPending:true});assert.equal(f.calls.length,0);
  const first=m.refresh({tokens:f.tokens});await m.refresh({tokens:f.tokens});assert.equal(f.calls.length,1);release();await first;
  const calls=f.calls.length;await m.refresh({tokens:f.tokens});assert.equal(f.calls.length,calls);
  await m.stop();
});

test('a failed range is not committed; a gap beyond 256 blocks rebuilds at current head',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});
  await m.refresh({tokens:[f.tokens[0]]});f.advance(10000);f.fail('getLogs');await m.refresh({tokens:[f.tokens[0]]});
  assert.equal(m.snapshot().status,'unavailable');assert.equal(m.snapshot().windows.length,0);
  f.fail(null);f.advance(10000);await m.refresh({tokens:[f.tokens[0]]});
  assert.equal(m.snapshot().windows[0].fromBlock.number,10000,'bounded retry covers failed range rather than skipping it');
  f.advance(70000);await m.refresh({tokens:[f.tokens[0]]});
  const s=m.snapshot();assert.equal(s.windows[0].fromBlock.number,f.current());assert.equal(s.status,'warming_up');assert.equal(s.totals.gaps,1);
});

test('historical covered counters survive gaps but never make a failed or rebuilt current window ready',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  for(let i=0;i<9;i++){f.advance(10000);await m.refresh({tokens:[f.tokens[0]]});}
  const covered=m.snapshot();assert.equal(covered.totals.coveredRounds,1);assert.equal(covered.totals.maxCoveredMs,90000);
  assert.equal(covered.lastCoveredAt,new Date(BASE+90000).toISOString());
  f.advance(10000);f.fail('getLogs');await m.refresh({tokens:[f.tokens[0]]});const failed=m.snapshot();
  assert.equal(failed.status,'unavailable');assert.equal(failed.totals.coveredRounds,1);assert.equal(failed.totals.maxCoveredMs,90000);assert.equal(failed.lastCoveredAt,covered.lastCoveredAt);
  f.fail(null);f.advance(70000);await m.refresh({tokens:[f.tokens[0]]});const rebuilding=m.snapshot();
  assert.equal(rebuilding.status,'warming_up');assert.equal(rebuilding.totals.coveredRounds,1);assert.equal(rebuilding.totals.maxCoveredMs,90000);
  assert.equal(rebuilding.lastCoveredAt,covered.lastCoveredAt);assert.equal(rebuilding.windows[0].fromBlock.number,rebuilding.windows[0].toBlock.number);
});

test('a late second-CA proof failure cannot count an earlier pending ninety-second proof as committed',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:f.tokens});
  for(let i=0;i<8;i++){f.advance(10000);await m.refresh({tokens:f.tokens});}
  const original=f.reader.getLogs;f.reader.getLogs=async filter=>{
    const rows=await original(filter);if(filter.address===INNER_TRADE_EMITTERS.flap.address)rows[0].blockHash=hash(999);return rows;
  };
  f.advance(10000);await m.refresh({tokens:f.tokens});const s=m.snapshot();
  assert.equal(s.status,'unavailable');assert.equal(s.windows.length,0);assert.equal(s.totals.coveredRounds,0);
  assert.equal(s.totals.maxCoveredMs,0);assert.equal(s.lastCoveredAt,null);
});

test('forty-second gap exposes no old trades, but a complete bounded re-read restores continuity',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  for(let i=0;i<9;i++){f.advance(10000);await m.refresh({tokens:[f.tokens[0]]});}
  const previous=m.snapshot().windows[0].toBlock;
  f.advance(40000);const stale=m.snapshot();assert.equal(stale.status,'stale');assert.equal(stale.windows.length,0);
  assert.equal(stale.totals.coveredRounds,1);assert.equal(stale.limits.gapMs,30000);assert.equal(stale.limits.cursorRetentionMs,120000);
  await m.refresh({tokens:[f.tokens[0]]});const fresh=m.snapshot();
  assert.equal(fresh.status,'ready');assert.equal(fresh.totals.gaps,0);assert.equal(fresh.totals.coveredRounds,2);
  assert.equal(f.calls.filter(c=>c.name==='getLogs').at(-1).args[0].fromBlock,previous.number+1);
  assert.equal(fresh.windows[0].observedAt,new Date(f.now()).toISOString());assert.equal(normalizeInnerTradeWindow(fresh.windows[0],f.now()).ready,true);
});

test('truncated gap re-read cannot recover coverage or advance its cursor; only later complete evidence can',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  for(let i=0;i<9;i++){f.advance(10000);await m.refresh({tokens:[f.tokens[0]]});}
  const prior=m.snapshot().windows[0].toBlock;
  f.advance(40000);f.logs('limit');await m.refresh({tokens:[f.tokens[0]]});const failed=m.snapshot();
  assert.equal(failed.status,'unavailable');assert.equal(failed.windows.length,0);assert.equal(failed.totals.coveredRounds,1);assert.equal(failed.lastError.code,'LOG_RESPONSE_LIMIT');
  f.advance(10000);f.logs('normal');await m.refresh({tokens:[f.tokens[0]]});const restored=m.snapshot();
  assert.equal(restored.status,'ready');assert.equal(restored.totals.gaps,0);assert.equal(restored.totals.coveredRounds,2);
  assert.equal(f.calls.filter(c=>c.name==='getLogs').at(-1).args[0].fromBlock,prior.number+1,'retry cannot skip a failed or truncated log range');
});

test('cursor older than 120 seconds rebuilds even when the block count remains within 256',async()=>{
  const f=fixture({blockMs:1000}),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  f.advance(130000);assert.equal(f.current()-10000,130);assert.equal(m.snapshot().windows.length,0);
  await m.refresh({tokens:[f.tokens[0]]});const s=m.snapshot();assert.equal(s.status,'warming_up');assert.equal(s.totals.gaps,1);
  assert.equal(s.windows[0].fromBlock.number,f.current());assert.equal(s.windows[0].toBlock.number,f.current());
});

test('a replaced committed block withdraws old evidence and starts a new canonical window',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  f.advance(10000);await m.refresh({tokens:[f.tokens[0]]});const oldEnd=f.current();
  f.fork(oldEnd);f.advance(10000);await m.refresh({tokens:[f.tokens[0]]});
  const s=m.snapshot();assert.equal(s.totals.reorgs,1);assert.equal(s.windows[0].fromBlock.number,f.current());assert.equal(s.status,'warming_up');
});

for(const mode of ['limit','wronghash','removed','wrongabi'])test(`malformed/truncated ${mode} logs fail closed`,async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});f.logs(mode);await m.refresh({tokens:[f.tokens[0]]});
  const s=m.snapshot();assert.equal(s.status,'unavailable');assert.equal(s.windows.length,0);assert.ok(s.lastError);
});

test('dense event blocks are verified using bounded sequential header batches and truthful item counts',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  f.advance(10000);f.logs('dense');await m.refresh({tokens:[f.tokens[0]]});const s=m.snapshot();
  assert.equal(s.lastError,null);assert.ok(f.calls.some(c=>c.name==='getBlocks'));assert.ok(s.lastRound.rpcItems>s.lastRound.physicalRequests);
  assert.equal(s.windows[0].logs.length,31);assert.equal(normalizeInnerTradeWindow(s.windows[0],f.now()).ready,true);
});

test('header demand over the semantic RPC item cap cannot advance a successful window',async()=>{
  const f=fixture(),m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  f.advance(20000);f.logs('overbudget');await m.refresh({tokens:[f.tokens[0]]});const s=m.snapshot();
  assert.equal(s.status,'unavailable');assert.equal(s.lastError.code,'ROUND_BUDGET');assert.equal(s.windows.length,0);
  assert.ok(s.lastRound.rpcItems<=64);assert.ok(s.lastRound.physicalRequests<=32);
});

test('one explicit metadata revert is isolated without stopping supported candidates',async()=>{
  const f=fixture(),baseCall=f.reader.call;
  f.reader.call=async q=>{
    if(q.to===INNER_TRADE_EMITTERS.four_v2.metadataSource)throw Object.assign(Error('fixture revert'),{code:'CALL_REVERTED'});
    return baseCall(q);
  };
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:f.tokens});const s=m.snapshot();
  assert.equal(s.lastError,null);assert.ok(s.checks.some(c=>c.address===CA&&c.status==='unsupported'));
  assert.equal(s.windows.length,1);assert.equal(s.windows[0].platform,'flap');
});

test('unsupported quote cooldown does not occupy a research seat or masquerade as BNB',async()=>{
  const f=fixture();for(let i=1;i<=4;i++)f.tokens.push({...f.tokens[0],address:'0x'+String(i).repeat(40)});
  f.blocked.add(CA);const m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:f.tokens});
  assert.ok(m.snapshot().checks.some(c=>c.address===CA&&c.status==='unsupported'));assert.ok(!m.snapshot().windows.some(p=>p.tokenAddress===CA));
  f.advance(10000);await m.refresh({tokens:f.tokens});const s=m.snapshot();assert.equal(s.lastRound.selected,4);
  assert.ok(s.windows.some(p=>p.tokenAddress==='0x'+'3'.repeat(40)),'next candidate is admitted instead of blocked native-quote address');
  assert.ok(!s.windows.some(p=>p.tokenAddress===CA));
});

test('active watch seats survive ranking rotation; held tokens preempt and stale/removed targets are withdrawn',async()=>{
  const f=fixture();for(let i=1;i<=4;i++)f.tokens.push({...f.tokens[0],address:'0x'+String(i).repeat(40)});
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:f.tokens});const first=m.snapshot().windows.map(p=>p.tokenAddress);
  f.advance(10000);await m.refresh({tokens:[...f.tokens].reverse()});assert.deepEqual(new Set(m.snapshot().windows.map(p=>p.tokenAddress)),new Set(first));
  f.advance(10000);await m.refresh({tokens:[{...f.tokens.at(-1),held:true},...f.tokens]});assert.ok(m.snapshot().windows.some(p=>p.tokenAddress===f.tokens.at(-1).address));
  f.advance(10000);await m.refresh({tokens:f.tokens.map(t=>({...t,sourceObservedAt:new Date(BASE-130000).toISOString()}))});assert.deepEqual(m.snapshot().windows,[]);
});

test('shared background slots and JSON-RPC rate limits use the original cooldown path',async()=>{
  const f=fixture(),seen=[],cooldowns=[];f.fail('getLogs');
  const gate={run:async(host,method,lane,fn,options)=>{seen.push({host,method,lane,options});return fn();},persistCooldown:async(...args)=>cooldowns.push(args)};
  const m=createInnerTradeMonitor({reader:f.reader,coordinator:gate,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  assert.ok(seen.length);assert.ok(seen.every(s=>s.lane==='background'&&s.options.waitMs===1000));assert.equal(cooldowns.length,1);
  assert.equal(m.snapshot().windows.length,0);
  const rpc=createInnerTradeRpcReader({fetchImpl:async(_url,options)=>{const p=JSON.parse(options.body);return {status:200,url:'https://bsc-rpc.publicnode.com',headers:{get:()=>null},text:async()=>JSON.stringify({jsonrpc:'2.0',id:p.id,error:{code:-32005,message:'rate limit exceeded'}})};}});
  await assert.rejects(rpc.getNetwork(),e=>e.status===429);
});

test('true endpoint timeout shares a bounded cooldown, but a local shutdown is not an upstream fault',async()=>{
  const f=fixture(),cooldowns=[];f.reader.getBlockNumber=async()=>{throw Object.assign(Error('fixture timeout'),{code:'RPC_TIMEOUT'});};
  const gate={run:async(_host,_method,_lane,fn)=>fn(),persistCooldown:async(...args)=>cooldowns.push(args)};
  const m=createInnerTradeMonitor({reader:f.reader,coordinator:gate,now:f.now});await m.refresh({tokens:[f.tokens[0]]});
  assert.equal(cooldowns.length,1);assert.equal(cooldowns[0][2],BASE+30000);assert.equal(m.snapshot().status,'unavailable');
  await m.stop();assert.equal(cooldowns.length,1);
});

for(const offset of [-31000,1000])test(`stale/future confirmed head (${offset} ms) reports timing and cools read methods without retry`,async()=>{
  const f=fixture(),cooldowns=[];f.reader.getBlock=async n=>({...f.block(n),timestamp:(BASE+offset)/1000});
  const gate={run:async(_host,_method,_lane,fn)=>fn(),persistCooldown:async(...args)=>cooldowns.push(args)};
  const m=createInnerTradeMonitor({reader:f.reader,coordinator:gate,now:f.now});await m.refresh({tokens:[f.tokens[0]]});const s=m.snapshot();
  assert.equal(s.lastError.code,'STALE_HEAD');assert.equal(s.lastRound.headBlock,10000);assert.equal(s.lastRound.reportedHead,10008);
  assert.equal(s.lastRound.headAt,new Date(BASE+offset).toISOString());assert.equal(s.lastRound.headAgeMs,-offset);
  assert.equal(s.lastRound.physicalRequests,3);assert.equal(s.windows.length,0);
  assert.deepEqual(cooldowns.map(c=>c.slice(1)),[['eth_blockNumber',BASE+30000,'method'],['eth_getBlockByNumber',BASE+30000,'method']]);
  assert.equal(f.now(),BASE,'collector must not adjust clock');
});

test('a stale production endpoint is excluded next scheduled round, without same-round fallback',async()=>{
  const calls=[],circuits=[];let clock=BASE;const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    const request=JSON.parse(options.body);calls.push({host:new URL(url).hostname,method:request.method});
    let result=request.method==='eth_chainId'?'0x38':request.method==='eth_blockNumber'?'0x6c':
      {number:'0x64',hash:hash(100),parentHash:hash(99),timestamp:`0x${Math.floor((BASE-60000)/1000).toString(16)}`};
    return {status:200,url,headers:{get:()=>null},text:async()=>JSON.stringify({jsonrpc:'2.0',id:request.id,result})};
  };
  let m;
  try {
    m=createInnerTradeMonitor({dataDir:'unused-test-do-not-open',now:()=>clock,coordinator:{snapshot:()=>({leases:[],waiters:[],circuits}),
      run:async(_host,_method,_lane,fn)=>fn(),persistCooldown:async(host,operation,until_ms,scope)=>{assert.equal(scope,'method');circuits.push({host,operation,until_ms});}}});
  }finally{globalThis.fetch=original;}
  const tokens=[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'}];
  await m.refresh({tokens});assert.deepEqual([...new Set(calls.map(c=>c.host))],['bsc-rpc.publicnode.com']);assert.equal(calls.length,3);
  clock+=10000;await m.refresh({tokens});assert.deepEqual([...new Set(calls.map(c=>c.host))],['bsc-rpc.publicnode.com','public-bsc.nownodes.io']);
  assert.equal(calls.length,6);assert.equal(m.snapshot().lastRound.physicalRequests,3);await m.stop();
});

test('host selection prefers an available background seat over an equal-load background lease',async()=>{
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'],calls=[];
  const m=createInnerTradeMonitor({dataDir:'unused-test-do-not-open',now:()=>BASE,coordinator:{
    snapshot:()=>({leases:[{host:hosts[0],lane:'background',operation:'eth_call'},{host:hosts[1],lane:'realtime',operation:'eth_getLogs'}],waiters:[],
      circuits:[{host:hosts[2],operation:'*',until_ms:BASE+30000}]}),
    run:async(host,method,lane,_fn,options)=>{calls.push({host,method,lane,waitMs:options.waitMs});
      throw Object.assign(Error('fixture capacity changed after selection'),{code:'RPC_COORDINATOR_UNAVAILABLE'});},
  }});
  await m.refresh({tokens:[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'}]});
  assert.deepEqual(calls,[{host:hosts[1],method:'eth_chainId',lane:'background',waitMs:1000}]);
  assert.equal(m.snapshot().lastRound.physicalRequests,0);assert.equal(m.snapshot().windows.length,0);
  assert.equal(m.snapshot().lastError.code,'RPC_COORDINATOR_UNAVAILABLE','a stale hint never bypasses admission or retries another host');
  await m.stop();
});

for(const operation of ['*','eth_getLogs'])test(`host selection respects an active ${operation} half-open probe`,async()=>{
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'],calls=[];
  const m=createInnerTradeMonitor({dataDir:'unused-test-do-not-open',now:()=>BASE,coordinator:{
    snapshot:()=>({leases:[{host:hosts[0],lane:'realtime',operation:'eth_getLogs'},{host:hosts[1],lane:'realtime',operation:'eth_getLogs'}],waiters:[],
      circuits:[{host:hosts[0],operation,until_ms:BASE-1},{host:hosts[2],operation:'*',until_ms:BASE+30000}]}),
    run:async(host,method,lane,_fn,options)=>{calls.push({host,method,lane,waitMs:options.waitMs});
      throw Object.assign(Error('fixture stops before transport'),{code:'RPC_COORDINATOR_UNAVAILABLE'});},
  }});
  await m.refresh({tokens:[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'}]});
  assert.deepEqual(calls,[{host:hosts[1],method:'eth_chainId',lane:'background',waitMs:1000}]);
  assert.equal(m.snapshot().lastRound.physicalRequests,0);await m.stop();
});

test('host selection ranks the total physical cap before queue load',async()=>{
  const hosts=['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz'],calls=[];
  const m=createInnerTradeMonitor({dataDir:'unused-test-do-not-open',now:()=>BASE,coordinator:{
    snapshot:()=>({leases:[{host:hosts[0],lane:'realtime',operation:'eth_getLogs'},{host:hosts[0],lane:'realtime',operation:'eth_blockNumber'},
      {host:hosts[1],lane:'realtime',operation:'eth_getLogs'}],waiters:[{host:hosts[1],lane:'realtime'}],
      circuits:[{host:hosts[2],operation:'*',until_ms:BASE+30000}]}),
    run:async(host,_method,lane,_fn,options)=>{calls.push({host,lane,waitMs:options.waitMs});
      throw Object.assign(Error('fixture stops before transport'),{code:'RPC_COORDINATOR_UNAVAILABLE'});},
  }});
  await m.refresh({tokens:[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'}]});
  assert.deepEqual(calls,[{host:hosts[1],lane:'background',waitMs:1000}]);
  assert.equal(m.snapshot().lastRound.physicalRequests,0);await m.stop();
});

for(const operation of ['*','eth_getLogs','eth_getStorageAt'])test(`host selection still permits an idle ${operation} half-open host`,async()=>{
  const calls=[];
  const m=createInnerTradeMonitor({dataDir:'unused-test-do-not-open',now:()=>BASE,coordinator:{
    snapshot:()=>({leases:[],waiters:[],circuits:[{host:'bsc-rpc.publicnode.com',operation,until_ms:BASE-1}]}),
    run:async(host,_method,lane,_fn,options)=>{calls.push({host,lane,waitMs:options.waitMs});
      throw Object.assign(Error('fixture stops before transport'),{code:'RPC_COORDINATOR_UNAVAILABLE'});},
  }});
  await m.refresh({tokens:[{chain:'bsc',address:CA,marketStage:'internal',platform:'four_v2'}]});
  assert.deepEqual(calls,[{host:'bsc-rpc.publicnode.com',lane:'background',waitMs:1000}]);
  assert.equal(m.snapshot().lastRound.physicalRequests,0);await m.stop();
});

test('strict header batches bind every requested response ID and header; no multi-method batch or signing API',async()=>{
  let omit=false,duplicate=false;
  const rpc=createInnerTradeRpcReader({fetchImpl:async(_url,options)=>{const req=JSON.parse(options.body);assert.ok(req.every(r=>r.method==='eth_getBlockByNumber'));
    let rows=req.map(r=>({jsonrpc:'2.0',id:r.id,result:{number:r.params[0],timestamp:'0x64',hash:hash(Number(r.params[0])),parentHash:hash(Number(r.params[0])-1)}})).reverse();
    if(omit)rows.pop();if(duplicate)rows[1]=rows[0];return {status:200,headers:{get:()=>null},text:async()=>JSON.stringify(rows)};}});
  assert.deepEqual((await rpc.getBlocks([100,101])).map(b=>b.number),[100,101]);
  omit=true;await assert.rejects(rpc.getBlocks([100,101]));omit=false;duplicate=true;await assert.rejects(rpc.getBlocks([100,101]));
  assert.equal(rpc.send,undefined);assert.equal(rpc.sendTransaction,undefined);assert.equal(rpc.sign,undefined);
});

test('four targets use two same-block call batches instead of eleven call HTTP leases, without increasing RPC items',async()=>{
  const plain=fixture(),batched=fixture();
  for(const f of [plain,batched])for(let i=1;i<=2;i++)f.tokens.push({...f.tokens[0],address:'0x'+String(i).repeat(40)});
  const batches=[],gateCalls=[];batched.reader.callBatch=async values=>{
    batches.push(values);assert.ok(values.length<=8);assert.equal(new Set(values.map(v=>v.blockTag)).size,1);
    const rows=[];for(const value of values)rows.push({status:'fulfilled',value:await batched.reader.call(value)});return rows;
  };
  const a=createInnerTradeMonitor({reader:plain.reader,now:plain.now});
  const b=createInnerTradeMonitor({reader:batched.reader,now:batched.now,coordinator:{run:async(host,method,lane,fn,options)=>{
    gateCalls.push({host,method,lane,options});return fn();},persistCooldown:async()=>assert.fail('healthy batch must not cool down')}});
  await a.refresh({tokens:plain.tokens});await b.refresh({tokens:batched.tokens});
  const before=a.snapshot(),after=b.snapshot();assert.equal(after.lastError,null);assert.equal(after.windows.length,4);
  assert.deepEqual(batches.map(v=>v.length),[8,3]);assert.equal(after.lastRound.rpcItems,before.lastRound.rpcItems);
  assert.equal(after.lastRound.callBatches,2);assert.equal(after.lastRound.callBatchItems,11);assert.equal(after.limits.callBatch,8);
  assert.equal(after.lastRound.physicalRequests,before.lastRound.physicalRequests-9);
  assert.equal(gateCalls.filter(c=>c.method==='eth_call').length,2);assert.ok(gateCalls.every(c=>c.lane==='background'&&c.options.waitMs===1000));
  assert.deepEqual(after.windows,before.windows);
});

test('fifty seconds of busy startup do not consume the first successful window warmup protection',async()=>{
  const f=fixture();for(let i=1;i<=4;i++)f.tokens.push({...f.tokens[0],address:'0x'+String(i).repeat(40)});
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});f.fail('getLogs');
  await m.refresh({tokens:f.tokens});const targets=m.snapshot().targets.map(t=>t.address);
  for(let i=0;i<4;i++){f.advance(10000);await m.refresh({tokens:f.tokens});}
  f.advance(10000);f.fail(null);await m.refresh({tokens:f.tokens});
  for(let i=0;i<9;i++){f.advance(10000);await m.refresh({tokens:[...f.tokens].reverse()});}
  const s=m.snapshot();assert.equal(f.now(),BASE+140000);assert.equal(s.status,'ready');
  assert.deepEqual(new Set(s.targets.map(t=>t.address)),new Set(targets));assert.ok(s.checks.every(c=>c.coveredMs>=90000));
  assert.ok(s.targets.every(t=>Object.keys(t).sort().join(',')==='address,chain,platform'),'runtime retention snapshot stays compact');
});

test('gap rebuild protects its new anchor but cannot extend the fixed absolute watch ceiling',async()=>{
  const f=fixture();for(let i=1;i<=4;i++)f.tokens.push({...f.tokens[0],address:'0x'+String(i).repeat(40)});
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:f.tokens});const first=m.snapshot().targets.map(t=>t.address);
  f.advance(70000);await m.refresh({tokens:f.tokens});assert.equal(m.snapshot().totals.gaps,2,'one beyond-bound gap recorded for each supported platform');
  for(let i=0;i<8;i++){f.advance(10000);await m.refresh({tokens:[...f.tokens].reverse()});}
  assert.equal(f.now(),BASE+150000);assert.deepEqual(new Set(m.snapshot().targets.map(t=>t.address)),new Set(first),'rebuilt t=40s anchor remains protected after original 120s');
  f.advance(70000);await m.refresh({tokens:f.tokens});
  f.advance(10000);await m.refresh({tokens:[...f.tokens].reverse()});
  assert.equal(f.now(),BASE+230000);assert.deepEqual(new Set(m.snapshot().targets.map(t=>t.address)),new Set(first));
  f.advance(10000);await m.refresh({tokens:[...f.tokens].reverse()});const last=m.snapshot();
  assert.equal(last.limits.watchAbsoluteMaxMs,240000);assert.ok(last.targets.some(t=>t.address===f.tokens.at(-1).address),'after absolute cap, current ordering can admit another candidate');
  assert.notDeepEqual(new Set(last.targets.map(t=>t.address)),new Set(first));
});

test('batch item revert only quarantines that CA; shared oracle revert cannot yield a window',async()=>{
  const f=fixture();let oracleRevert=false;
  f.reader.callBatch=async values=>{
    const rows=[];for(const value of values) {
      if(value.to===INNER_TRADE_EMITTERS.four_v2.metadataSource||oracleRevert&&value.to===INNER_TRADE_ORACLE)rows.push({status:'rejected',code:'CALL_REVERTED'});
      else rows.push({status:'fulfilled',value:await f.reader.call(value)});
    }return rows;
  };
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});await m.refresh({tokens:f.tokens});
  assert.equal(m.snapshot().windows.length,1);assert.equal(m.snapshot().windows[0].platform,'flap');
  assert.ok(m.snapshot().checks.some(c=>c.address===CA&&c.status==='unsupported'));
  f.advance(10000);oracleRevert=true;await m.refresh({tokens:f.tokens});
  assert.equal(m.snapshot().windows.length,0);assert.equal(m.snapshot().lastError.code,'ORACLE_UNAVAILABLE');
});

test('batch upstream failure keeps the same original cooldown and never falls back to split calls',async()=>{
  const f=fixture(),cooldowns=[];let batches=0;
  f.reader.callBatch=async()=>{batches++;throw Object.assign(Error('batch rate limit'),{status:429,retryAfter:'31'});};
  f.reader.call=async()=>assert.fail('failed batches must not be split into individual calls');
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now,coordinator:{run:async(_h,_m,_l,fn)=>fn(),persistCooldown:async(...args)=>cooldowns.push(args)}});
  await m.refresh({tokens:f.tokens});const s=m.snapshot();assert.equal(batches,1);assert.equal(s.lastRound.physicalRequests,4);
  assert.equal(s.windows.length,0);assert.equal(cooldowns.length,1);assert.equal(cooldowns[0][1],'eth_call');assert.equal(cooldowns[0][2],BASE+31000);
});

test('collector uses default-equivalent FIFO wait and clips late admission to its remaining task deadline',async()=>{
  const f=fixture(),waits=[];const network=f.reader.getNetwork;
  f.reader.getNetwork=async options=>{const result=await network(options);f.advance(9300);return result;};
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now,coordinator:{run:async(_host,_method,lane,fn,options)=>{
    assert.equal(lane,'background');waits.push(options.waitMs);return fn();},persistCooldown:async()=>assert.fail('no fault or cooldown expected')}});
  await m.refresh({tokens:[f.tokens[0]]});const s=m.snapshot();assert.equal(s.lastError,null);assert.equal(s.limits.queueWaitMs,1000);
  assert.equal(waits[0],1000);assert.ok(waits.length>1);assert.ok(waits.slice(1).every(ms=>ms===700));
  assert.equal(s.limits.taskMs,10000);assert.equal(s.lastRound.durationMs,9300);assert.equal(s.lastRound.physicalRequests,s.lastRound.rpcItems);
});

test('capacity expiration stays a failed round and never retries or borrows realtime priority',async()=>{
  const f=fixture(),waits=[];
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now,coordinator:{run:async(_host,_method,lane,_fn,options)=>{
    waits.push(options.waitMs);assert.equal(lane,'background');f.advance(options.waitMs);
    throw Object.assign(Error('shared capacity deadline'),{code:'RPC_COORDINATOR_UNAVAILABLE'});},persistCooldown:async()=>assert.fail('local capacity is not an upstream cooldown')}});
  await m.refresh({tokens:[f.tokens[0]]});const s=m.snapshot();assert.deepEqual(waits,[1000]);assert.equal(s.lastError.code,'RPC_COORDINATOR_UNAVAILABLE');
  assert.equal(s.lastRound.physicalRequests,0);assert.equal(s.lastRound.rpcItems,0);assert.equal(s.windows.length,0);
});

test('strict call batch uses exact same-block read-only identities, recognizes per-item revert, rejects missing/duplicate IDs',async()=>{
  let mode='ok',fetches=0;
  const rpc=createInnerTradeRpcReader({fetchImpl:async(_url,options)=>{
    fetches++;const request=JSON.parse(options.body);assert.ok(Array.isArray(request));assert.ok(request.every(r=>r.method==='eth_call'&&r.params[1]==='0x64'));
    let rows=request.map((r,i)=>({jsonrpc:'2.0',id:r.id,result:i?'0x0202':'0x0101'}));
    if(mode==='revert')rows[1]={jsonrpc:'2.0',id:request[1].id,error:{code:3,message:'execution reverted'}};
    if(mode==='rate')rows[1]={jsonrpc:'2.0',id:request[1].id,error:{code:-32005,message:'too many requests'}};
    if(mode==='missing')rows.pop();if(mode==='duplicate')rows[1]=rows[0];
    return {status:200,headers:{get:()=>null},text:async()=>JSON.stringify(rows.reverse())};
  }});
  const values=[{to:CA,blockTag:100,data:'0x313ce567'},{to:INNER_TRADE_ORACLE,blockTag:100,data:'0x313ce567'}];
  assert.deepEqual(await rpc.callBatch(values),[{status:'fulfilled',value:'0x0101'},{status:'fulfilled',value:'0x0202'}]);
  mode='revert';assert.deepEqual(await rpc.callBatch(values),[{status:'fulfilled',value:'0x0101'},{status:'rejected',code:'CALL_REVERTED'}]);
  for(const failure of ['missing','duplicate']){mode=failure;await assert.rejects(rpc.callBatch(values),e=>e.code==='RPC_RESPONSE_IDENTITY');}
  mode='rate';await assert.rejects(rpc.callBatch(values),e=>e.status===429);
  const before=fetches;
  await assert.rejects(rpc.callBatch([values[0],{...values[1],blockTag:101}]));
  await assert.rejects(rpc.callBatch(Array.from({length:9},()=>values[0])));
  await assert.rejects(rpc.callBatch([{...values[0],blockTag:'latest'},values[1]]));
  await assert.rejects(rpc.callBatch([{...values[0],method:'eth_sendRawTransaction'},values[1]]));
  assert.equal(fetches,before,'invalid call batches must never issue HTTP requests');
});

test('stop aborts a physical read, drains it, and never leaves a poller',async()=>{
  const f=fixture();f.network(({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});const first=m.refresh({tokens:f.tokens});await m.stop();await first;
  assert.equal(m.snapshot().status,'stopped');assert.equal(m.snapshot().running,false);const count=f.calls.length;
  f.advance(60000);await m.refresh({tokens:f.tokens});assert.equal(f.calls.length,count);
});

test('fixed-order candidates fairly rotate after the absolute lease even when every admission is busy',async()=>{
  let clock=BASE,admissions=0;
  const tokens=Array.from({length:12},(_,i)=>({chain:'bsc',address:'0x'+(i+1).toString(16).repeat(40),marketStage:'internal',platform:'four_v2'}));
  const m=createInnerTradeMonitor({reader:{},now:()=>clock,coordinator:{run:async(_host,_method,lane,_fn,options)=>{
    admissions++;assert.equal(lane,'background');assert.equal(options.waitMs,1000);
    throw Object.assign(Error('fixture local capacity busy'),{code:'RPC_COORDINATOR_UNAVAILABLE'});}}});
  const at=new Map(),seen=new Set();
  for(let round=0;round<=48;round++) {
    await m.refresh({tokens});const s=m.snapshot();
    assert.equal(s.targets.length,4);assert.equal(s.windows.length,0);assert.equal(s.totals.physicalRequests,0);
    for(const t of s.targets)seen.add(t.address);
    if([0,23,24,48].includes(round))at.set(round,s.targets.map(t=>t.address));
    clock+=10000;
  }
  assert.deepEqual(at.get(0),tokens.slice(0,4).map(t=>t.address));assert.deepEqual(at.get(23),at.get(0));
  assert.deepEqual(at.get(24),tokens.slice(4,8).map(t=>t.address));
  assert.deepEqual(at.get(48),tokens.slice(8,12).map(t=>t.address),'previously served top four must not starve never-selected candidates');
  assert.equal(seen.size,12);assert.equal(admissions,49);await m.stop();
});

test('fair target rotation never evicts a held token',async()=>{
  let clock=BASE;
  const tokens=Array.from({length:9},(_,i)=>({chain:'bsc',address:'0x'+(i+1).toString(16).repeat(40),marketStage:'internal',platform:'four_v2',held:i===0}));
  const m=createInnerTradeMonitor({reader:{},now:()=>clock,coordinator:{run:async()=>{
    throw Object.assign(Error('fixture local capacity busy'),{code:'RPC_COORDINATOR_UNAVAILABLE'});}}});
  const seen=new Set();
  for(let round=0;round<=48;round++) {
    await m.refresh({tokens});const s=m.snapshot();
    assert.equal(s.targets[0].address,tokens[0].address);assert.equal(s.targets.length,4);
    for(const t of s.targets)seen.add(t.address);clock+=10000;
  }
  assert.equal(seen.size,9);await m.stop();
});

test('expired seats without replacements keep observing and yield as soon as a substitute arrives',async()=>{
  let clock=BASE;
  const tokens=Array.from({length:5},(_,i)=>({chain:'bsc',address:'0x'+(i+1).toString(16).repeat(40),marketStage:'internal',platform:'four_v2'}));
  const m=createInnerTradeMonitor({reader:{},now:()=>clock,coordinator:{run:async()=>{
    throw Object.assign(Error('fixture local capacity busy'),{code:'RPC_COORDINATOR_UNAVAILABLE'});}}});
  for(let round=0;round<=30;round++) {
    await m.refresh({tokens:tokens.slice(0,4)});
    assert.deepEqual(m.snapshot().targets.map(t=>t.address),tokens.slice(0,4).map(t=>t.address));clock+=10000;
  }
  await m.refresh({tokens});
  assert.equal(m.snapshot().targets.length,4);assert.ok(m.snapshot().targets.some(t=>t.address===tokens[4].address));
  assert.equal(m.snapshot().totals.physicalRequests,0);await m.stop();
});

test('rotated targets cannot splice their old proof into a later observation window',async()=>{
  const f=fixture();for(let i=1;i<=6;i++)f.tokens.push({...f.tokens[0],address:'0x'+String(i).repeat(40)});
  const m=createInnerTradeMonitor({reader:f.reader,now:f.now});
  let firstProof;
  for(let round=0;round<=48;round++) {
    await m.refresh({tokens:f.tokens});const s=m.snapshot();assert.equal(s.lastError,null);
    if(round===9){firstProof=s.windows.find(p=>p.tokenAddress===f.tokens[0].address);assert.ok(firstProof.toBlock.timestamp-firstProof.fromBlock.timestamp>=90);}
    if(round===24)assert.ok(s.windows.every(p=>!f.tokens.slice(0,4).some(t=>t.address===p.tokenAddress)));
    if(round===48) {
      const returned=s.windows.find(p=>p.tokenAddress===f.tokens[0].address);
      assert.ok(returned);assert.ok(returned.fromBlock.number>firstProof.toBlock.number);
      assert.ok(returned.toBlock.timestamp-returned.fromBlock.timestamp<30,'a reselected CA must warm up again');
      const flap=s.windows.find(p=>p.platform==='flap');
      assert.equal(flap.fromBlock.number,flap.toBlock.number,'a platform with no remaining targets drops its private cursor');
    }
    f.advance(10000);
  }
  await m.stop();
});

for(const [retryAfter,delayMs] of [['600',600000],[new Date(BASE+600000).toUTCString(),600000],['2',2000],['0',0],['invalid',30000]])
  test(`inner monitor shares the full Retry-After deadline: ${retryAfter}`,async()=>{
    const f=fixture(),cooldowns=[];
    f.reader.getNetwork=async()=>{throw Object.assign(Error('fixture rate limit'),{status:429,retryAfter});};
    const m=createInnerTradeMonitor({reader:f.reader,now:f.now,coordinator:{
      run:async(_host,_method,lane,fn,options)=>{assert.equal(lane,'background');assert.equal(options.waitMs,1000);return fn();},
      persistCooldown:async(...args)=>cooldowns.push(args),
    }});
    await m.refresh({tokens:[f.tokens[0]]});
    assert.equal(cooldowns.length,1);assert.equal(cooldowns[0][1],'eth_chainId');assert.equal(cooldowns[0][2],BASE+delayMs);
    assert.equal(m.snapshot().lastRound.physicalRequests,1);assert.equal(m.snapshot().windows.length,0);
    await m.stop();
  });
