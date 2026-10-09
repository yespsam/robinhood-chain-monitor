import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBscLaunchpadMonitor,FOUR_MEME_TOKEN_CREATE_TOPIC} from '../src/bsc-launchpad-monitor.js';

const NOW=Date.parse('2026-08-10T09:30:00.000Z');
const PAID='bsc-mainnet.core.chainstack.com',PUBLIC='bsc-rpc.publicnode.com';
const FIXTURE_SECRET='fourmeme_fake_test_endpoint_123456',PAID_URL=`https://${PAID}/${FIXTURE_SECRET}`;
const emptyResponse=id=>({ok:true,status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id,result:[]})});

async function replayFixture(t,{paid=true,snapshot={leases:[],waiters:[],circuits:[]},run,response}={}) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'four-fast-rpc-'));
  const calls=[],fetches=[],cooldowns=[],events=[],messages=[];
  const coordinator={snapshot:()=>structuredClone(snapshot),
    run:async(host,method,lane,callback,options)=>{
      calls.push({host,method,lane,options});events.push('gate');
      try {return run?await run(callback):await callback();}finally{events.push('release');}
    },
    persistCooldown:async(...args)=>{cooldowns.push(args);events.push('cooldown');}};
  const monitor=createBscLaunchpadMonitor({dataDir,bscRpcUrls:[...(paid?[PAID_URL]:[]),`https://${PUBLIC}`]}, {
    autoStart:false,now:()=>NOW,fourMemeFastReplayCoordinator:coordinator,
    fourMemeFastReplayFetchImpl:async(url,options)=>{
      const payload=JSON.parse(options.body);fetches.push({url,options,payload});events.push('fetch');
      return response?response(payload,options):emptyResponse(payload.id);
    },
    provider:{destroy(){},async getBlockNumber(){return 100;},async getBlock(){return {timestamp:NOW/1000};},
      async send(){throw new Error('fixture complete replay unavailable');}},
    logger:{info:message=>messages.push(message),error:message=>messages.push(message)},
  });
  t.after(async()=>{await monitor.stop();await fs.rm(dataDir,{recursive:true,force:true});});
  assert.equal(await monitor.registerFourMemeFeatureActivations([{
    quoteConfig:{symbol:'FIXTURE',address:'0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',status:'PUBLISH'},
    observedAt:new Date(NOW).toISOString(),
  }]),1);
  const activation=Object.values((await monitor.getState()).officialSources.fourMeme.featureActivations)[0];
  return {calls,fetches,cooldowns,events,messages,activation};
}

test('fast Four.Meme replay keeps healthy busy paid RPC behind the original background gate',async t=>{
  const h=await replayFixture(t,{snapshot:{leases:[{host:PAID,lane:'background',operation:'eth_getLogs'}],
    waiters:[{host:PAID,lane:'realtime'}],circuits:[]}});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].host,PAID);assert.equal(h.calls[0].method,'eth_getLogs');
  assert.equal(h.calls[0].lane,'background');assert.ok(h.calls[0].options.waitMs>0&&h.calls[0].options.waitMs<=200);
  assert.equal(h.fetches.length,1);assert.equal(h.fetches[0].url,PAID_URL);
  assert.equal(h.fetches[0].options.redirect,'error');assert.ok(h.fetches[0].options.signal instanceof AbortSignal);
  const filter=h.fetches[0].payload.params[0];
  assert.ok(Array.isArray(filter.address)&&filter.address.every(address=>/^0x[0-9a-f]{40}$/.test(address)));
  assert.ok(filter.topics[0].includes(FOUR_MEME_TOKEN_CREATE_TOPIC));
  assert.equal(h.activation.replayScannedThroughBlock,null,'empty shortcut cannot claim completeness');
  assert.deepEqual(h.cooldowns,[]);
});

for(const operation of ['*','eth_getLogs'])test(`fast replay selects public only when paid ${operation} is cooling`,async t=>{
  const h=await replayFixture(t,{snapshot:{leases:[],waiters:[],circuits:[{host:PAID,operation,until_ms:NOW+30000}]}});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].host,PUBLIC);assert.equal(h.fetches[0].url,`https://${PUBLIC}`);
});

test('fast replay active paid half-open probe uses public, not a second recovery probe',async t=>{
  const h=await replayFixture(t,{snapshot:{leases:[{host:PAID,lane:'realtime',operation:'eth_getLogs'}],waiters:[],
    circuits:[{host:PAID,operation:'eth_getLogs',until_ms:NOW-1}]}});
  assert.equal(h.calls[0].host,PUBLIC);assert.equal(h.fetches.length,1);
});

test('fast replay has no ungated fallback when both endpoints are cooling',async t=>{
  const h=await replayFixture(t,{snapshot:{leases:[],waiters:[],circuits:[PAID,PUBLIC].map(host=>({host,operation:'*',until_ms:NOW+30000}))}});
  assert.deepEqual(h.calls,[]);assert.deepEqual(h.fetches,[]);assert.deepEqual(h.cooldowns,[]);
});

test('fast replay without paid configuration retains public transport but adds shared admission',async t=>{
  const h=await replayFixture(t,{paid:false});
  assert.equal(h.calls[0].host,PUBLIC);assert.equal(h.calls[0].lane,'background');assert.equal(h.fetches.length,1);
});

test('fast replay local paid queue refusal neither dispatches public nor opens provider cooldown',async t=>{
  const h=await replayFixture(t,{run:async()=>{throw Object.assign(new Error('busy'),{
    code:'RPC_COORDINATOR_UNAVAILABLE',rpcFailureScope:'capacity',rpcCircuitAlreadyOpen:true});}});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].host,PAID);
  assert.deepEqual(h.fetches,[]);assert.deepEqual(h.cooldowns,[]);
});

test('fast replay publishes full paid 429 cooldown before releasing the lease and never retries a second host',async t=>{
  const h=await replayFixture(t,{response:async()=>({ok:false,status:429,headers:{get:()=> '600'}})});
  assert.equal(h.fetches.length,1);assert.equal(h.calls.length,1);
  assert.deepEqual(h.cooldowns,[[PAID,'eth_getLogs',NOW+600000]]);
  assert.ok(h.events.indexOf('cooldown')<h.events.indexOf('release'));
});

test('fast replay JSON-RPC rate-limit diagnostics redact paid credentials and share cooldown',async t=>{
  const h=await replayFixture(t,{response:async payload=>({ok:true,status:200,headers:{get:()=>null},
    text:async()=>JSON.stringify({jsonrpc:'2.0',id:payload.id,error:{code:429,message:`rate limit ${PAID_URL} ${FIXTURE_SECRET}`}})})});
  assert.equal(h.fetches.length,1);assert.deepEqual(h.cooldowns,[[PAID,'eth_getLogs',NOW+30000]]);
  assert.doesNotMatch(JSON.stringify(h.messages),new RegExp(FIXTURE_SECRET));
});

test('fast replay recognizes a bare JSON-RPC -32005 limit error without a provider message',async t=>{
  const h=await replayFixture(t,{response:async payload=>({ok:true,status:200,text:async()=>JSON.stringify({
    jsonrpc:'2.0',id:payload.id,error:{code:-32005},
  })})});
  assert.deepEqual(h.cooldowns,[[PAID,'eth_getLogs',NOW+30000]]);assert.equal(h.fetches.length,1);
});

for(const patch of [{redirected:true},{url:'https://different.invalid/fixture'}])
  test(`fast replay rejects transport redirect/origin mismatch ${JSON.stringify(patch)}`,async t=>{
    const h=await replayFixture(t,{response:async payload=>({...emptyResponse(payload.id),...patch})});
    assert.equal(h.fetches.length,1);assert.deepEqual(h.cooldowns,[]);
    assert.match(h.messages.join(' '),/origin mismatch/);
    assert.equal(h.activation.replayScannedThroughBlock,null);
  });

test('fast replay cancellation before its own deadline does not mark the paid host failed',async t=>{
  const h=await replayFixture(t,{response:async()=>{throw Object.assign(new Error('fixture canceled'),{name:'AbortError'});}});
  assert.equal(h.fetches.length,1);assert.deepEqual(h.cooldowns,[]);
});

for(const kind of ['identity','address','removed'])test(`fast replay rejects ${kind} mismatch without accepting a candidate or advancing cursor`,async t=>{
  const h=await replayFixture(t,{response:async payload=>({ok:true,status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',
    id:kind==='identity'?payload.id+1:payload.id,result:kind==='identity'?[]:[{
      address:'0x'+'1'.repeat(40),topics:[FOUR_MEME_TOKEN_CREATE_TOPIC],data:'0x',removed:kind==='removed',
    }]})})});
  assert.equal(h.fetches.length,1);assert.equal(h.activation.firstTokenTransactionHash,null);
  assert.equal(h.activation.replayScannedThroughBlock,null);assert.deepEqual(h.cooldowns,[]);
  assert.match(h.messages.join(' '),/malformed|out-of-scope/);
});

test('fast replay 1.8s total deadline includes queue wait and rejects an expired callback before any dispatch',async t=>{
  const h=await replayFixture(t,{run:async callback=>{
    await new Promise(resolve=>setTimeout(resolve,1850));return callback();
  }});
  assert.equal(h.calls.length,1);assert.deepEqual(h.fetches,[]);assert.deepEqual(h.cooldowns,[]);
  assert.match(h.messages.join(' '),/deadline/);
});

test('fast replay rejects a response body arriving after its fixed deadline and shares physical timeout cooldown',async t=>{
  const h=await replayFixture(t,{response:async payload=>({ok:true,status:200,text:async()=>{
    await new Promise(resolve=>setTimeout(resolve,1850));
    return JSON.stringify({jsonrpc:'2.0',id:payload.id,result:[]});
  }})});
  assert.equal(h.fetches.length,1);assert.equal(h.fetches[0].options.signal.aborted,true);
  assert.deepEqual(h.cooldowns,[[PAID,'eth_getLogs',NOW+30000,'method']]);
  assert.ok(h.events.indexOf('cooldown')<h.events.indexOf('release'));
  assert.match(h.messages.join(' '),/deadline/);
  assert.equal(h.activation.replayScannedThroughBlock,null);
});
