import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tradingScanChains, tradingFlowChains, TRADING_SCAN_SCOPE_FILE } from '../src/trading-scan-scope.js';
import { createGmgnFlowMonitor, validateGmgnFlowState } from '../src/gmgn-flow-monitor.js';
import { createBinanceFlowMonitor, selectBinanceFlowSlot } from '../src/binance-flow-monitor.js';
import { GMGN_FLOW_CHAINS } from '../src/gmgn-flow-signal.js';
import { createWalletLearningMonitor } from '../src/wallet-learning-monitor.js';
import { NOW, teacher, raw } from './fixtures/wallet-learning.js';
import { renderBrainTelemetry } from '../dashboard/brain-desk.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';

const ALL=Object.keys(GMGN_FLOW_CHAINS),CA=`0x${'a'.repeat(40)}`;
async function directory(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trading-scope-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;
}
async function scope(dir,chains=['bsc']) { await fs.writeFile(path.join(dir,TRADING_SCAN_SCOPE_FILE),JSON.stringify({version:1,chains})); }

test('scope is explicit, startup-only, subsetted and fails closed on malformed configuration',async t=>{
  const dir=await directory(t);
  assert.deepEqual(tradingScanChains(dir),ALL);
  await scope(dir);assert.deepEqual(tradingScanChains(dir),['bsc']);
  assert.deepEqual(tradingScanChains(dir,['sol']),[]);
  for(const value of [null,{}, {version:1,chains:[]},{version:1,chains:['bsc','bsc']},{version:1,chains:['fake']}]){
    await fs.writeFile(path.join(dir,TRADING_SCAN_SCOPE_FILE),JSON.stringify(value));
    assert.throws(()=>tradingScanChains(dir),/trading_scan_scope_invalid/);
  }
});

test('held paper chains retain flow evidence without rewriting ledger or widening discovery',async t=>{
  const dir=await directory(t);await scope(dir);
  assert.deepEqual(tradingFlowChains(dir,['bsc']),['bsc']);
  const saved={schema:'yesp_atm_runtime_v1',account:{positions:{a:{chain:'eth',address:CA}}},
    exitComparison:{dynamic:{positions:{b:{chain:'base',address:CA}}}}};
  const file=path.join(dir,'yesp-atm-strategy-paper.json'),before=JSON.stringify(saved);
  await fs.writeFile(file,before);
  assert.deepEqual(tradingFlowChains(dir,['bsc']),['bsc','eth','base']);
  assert.deepEqual(tradingScanChains(dir),['bsc']);assert.equal(await fs.readFile(file,'utf8'),before);
  await fs.writeFile(file,'null');assert.throws(()=>tradingFlowChains(dir,['bsc']),/exit_ledger_invalid/);
});

test('both GMGN scheduling modes really dispatch only BSC and preserve other chain history',async t=>{
  for(const adaptive of [true,false])await t.test(String(adaptive),async t=>{
    const dir=await directory(t);let clock=NOW;const calls=[];
    const make=()=>createGmgnFlowMonitor({dataDir:dir,gmgnFlowMonitorEnabled:true,
      gmgnFlowAdaptiveSchedulingEnabled:adaptive,gmgnFlowResearchDecoupled:true,gmgnFlowParallelFeedReads:true},
      {autoStart:false,now:()=>clock,logger:{error(){}},client:{trades:async(chain,kind)=>{
        calls.push([chain,kind]);return {code:0,data:{list:[]}};
      },hotSearches:async()=>{throw Error('out-of-scope hot request');},stop:async()=>{}}});
    const initial=make();await initial.check();await initial.stop();
    const before=JSON.parse(await fs.readFile(initial.stateFile,'utf8'));calls.length=0;
    await scope(dir);const monitor=make();
    try {
      for(let i=0;i<6;i++){clock+=15000;await monitor.check();}
      await monitor.stop();const after=JSON.parse(await fs.readFile(monitor.stateFile,'utf8'));
      validateGmgnFlowState(after);assert.equal(calls.length,12);assert.ok(calls.every(c=>c[0]==='bsc'));
      for(const chain of ALL.filter(c=>c!=='bsc')){
        assert.deepEqual(after.trades[chain],before.trades[chain]);assert.deepEqual(after.chains[chain],before.chains[chain]);
      }
      assert.deepEqual(after.scanScope.scanChains,['bsc']);
    }finally{await monitor.stop();}
  });
});

test('Binance both scheduling modes stay BSC-only and do not evade BSC cooldown via other chains',async t=>{
  for(const focus of [true,false]) {
    const dir=await directory(t);await scope(dir);let clock=NOW;const calls=[];
    const monitor=createBinanceFlowMonitor({dataDir:dir,binanceFlowFocusSchedulingEnabled:focus},{autoStart:false,now:()=>clock,
      client:{trades:async(chain,kind)=>{calls.push([chain,kind]);return {code:'000000',data:[]};},stop:async()=>{}},logger:{error(){}}});
    try{for(let i=0;i<9;i++){clock+=2500;await monitor.check();}
      assert.equal(calls.length,18);assert.ok(calls.every(c=>c[0]==='bsc'));
      assert.deepEqual(monitor.state().scanScope.scanChains,['bsc']);
    }finally{await monitor.stop();}
  }
  assert.equal(selectBinanceFlowSlot({chains:{bsc:{feeds:{smartmoney:{nextAttemptAt:NOW+1},kol:{nextAttemptAt:NOW+1}}}}},NOW,['bsc']),null);
});

test('expanded BSC, Solana and Robinhood scope rotates both flow providers without querying Base or ETH',async t=>{
  const selected=['bsc','sol','robinhood'];
  for(const provider of ['gmgn','binance'])for(const adaptive of [true,false])await t.test(`${provider}:${adaptive}`,async t=>{
    const dir=await directory(t);await scope(dir,selected);let clock=NOW;const calls=[];
    const client={trades:async(chain,kind)=>{calls.push([chain,kind]);return provider==='gmgn'?{code:0,data:{list:[]}}:{code:'000000',data:[]};},
      hotSearches:async()=>{throw Error('unrequested hot discovery');},stop:async()=>{}};
    const dependencies={autoStart:false,now:()=>clock,client,logger:{error(){}}};
    const monitor=provider==='gmgn'?createGmgnFlowMonitor({dataDir:dir,gmgnFlowMonitorEnabled:true,
      gmgnFlowAdaptiveSchedulingEnabled:adaptive,gmgnFlowResearchDecoupled:true,gmgnFlowParallelFeedReads:true},dependencies):
      createBinanceFlowMonitor({dataDir:dir,binanceFlowFocusSchedulingEnabled:adaptive},dependencies);
    try{
      for(let i=0;i<12;i++){clock+=15000;await monitor.check();}
      const state=monitor.state();assert.deepEqual(state.scanScope.scanChains,selected);
      assert.deepEqual([...new Set(calls.map(([chain])=>chain))].sort(),[...selected].sort());
      assert.ok(calls.every(([chain])=>selected.includes(chain)),'excluded chains receive no new flow requests');
      for(const chain of selected){
        const chainCalls=calls.filter(([c])=>c===chain);assert.ok(chainCalls.length>=4,`${chain} is revisited`);
        assert.deepEqual([...new Set(chainCalls.map(([,kind])=>kind))].sort(),['kol','smartmoney']);
      }
    }finally{await monitor.stop();}
  });
});

test('expanded focused market scope queries all three chains and rejects excluded-chain response rows',async t=>{
  const dir=await directory(t),selected=['bsc','sol','robinhood'],calls=[];await scope(dir,selected);
  const tokens=ALL.map(chain=>({chain,address:chain==='sol'?'So11111111111111111111111111111111111111112':CA,
    symbol:'SAME_SYMBOL',price:1,liquidity:60000,volume:5000,volumeWindow:'5m',marketCategory:'completed',marketStage:'external'}));
  const runtime=createPaperStrategyRuntime({dataDir:dir,chain:'robinhood',chains:ALL,discoveryMode:'gmgn_three_lists_v1',now:()=>NOW,
    evidenceLoader:()=>({}),market:{
      trending:async q=>{calls.push(['ranking',q.chain]);return {status:'ok',interval:q.interval,observedAt:new Date(NOW).toISOString(),tokens};},
      trenches:async q=>{calls.push(['trenches',q.chain]);return {status:'ok',observedAt:new Date(NOW).toISOString(),tokens};},
      details:async q=>{calls.push(['detail',q.chain]);return {status:'unavailable'};},
      quote:async q=>{calls.push(['quote',q.chain]);return {status:'unavailable'};},
      kline:async q=>{calls.push(['chart',q.chain]);return {status:'unavailable',candles:[]};}}});
  try{
    await runtime.setEnabled(false);await runtime.runOnce();await runtime.refreshDetails();
    const snapshot=runtime.snapshot();assert.deepEqual(snapshot.scanScope.scanChains,selected);
    assert.deepEqual(snapshot.chains,ALL,'management universe is not rewritten');
    for(const kind of ['ranking','trenches'])assert.deepEqual(calls.filter(([k])=>k===kind).map(([,chain])=>chain),selected);
    assert.ok(calls.every(([,chain])=>selected.includes(chain)));
    assert.deepEqual([...new Set(snapshot.evaluations.map(e=>e.token.chain))].sort(),[...selected].sort());
    assert.equal(snapshot.discoveryScope.uniqueCandidates,3,'same symbol and EVM address remain chain-separated');
    assert.ok(snapshot.evaluations.filter(e=>e.token.chain==='sol').every(e=>e.token.address===tokens.find(t=>t.chain==='sol').address));
    assert.equal(snapshot.account.trades.length,0,'unknown safety never becomes an order');
    assert.equal(snapshot.chainCoverage.eth.scanning,false);assert.equal(snapshot.chainCoverage.base.scanning,false);
    assert.equal(snapshot.execution,false);assert.equal(snapshot.signing,false);assert.equal(snapshot.broadcast,false);
  }finally{await runtime.stop();}
});

test('wallet learner stops out-of-scope activity, profile and chart requests without deleting checkpoints',async t=>{
  const dir=await directory(t),b=teacher(1,'bsc'),e=teacher(2,'eth');let clock=NOW;const calls=[];
  const options={dataDir:dir,now:()=>clock,sourceLoader:async()=>({flow:{profiles:{[b.key]:b.profile,[e.key]:e.profile}}}),
    client:{activity:async(chain,wallet)=>{calls.push(['activity',chain]);return {activities:[raw(1,'buy',{chain,wallet})],next:null};},
      stats:async chain=>{calls.push(['stats',chain]);return {data:[]};},stop:async()=>{}},
    researchContextLoader:()=>({readOnly:true,charts:[],documents:[]}),
    researchChartLoader:async query=>{calls.push(['chart',query.chain]);return {status:'unavailable'};}};
  const initial=createWalletLearningMonitor(options);await initial.runOnce();await initial.stop();
  const saved=JSON.parse(await fs.readFile(initial.stateFile,'utf8'));
  saved.statsJob={chain:'eth',wallets:[e.wallet],period:'30d',attempts:0,startedAt:NOW};
  await fs.writeFile(initial.stateFile,JSON.stringify(saved));await scope(dir);calls.length=0;
  const monitor=createWalletLearningMonitor(options);
  try{for(let i=0;i<7;i++){clock+=120000;await monitor.runOnce();}
    assert.ok(calls.length>0);assert.ok(calls.every(c=>c[1]==='bsc'));
    const after=JSON.parse(await fs.readFile(monitor.stateFile,'utf8'));
    assert.deepEqual(after.scopeDeferredStatsJobs.eth,saved.statsJob);
    assert.deepEqual(after.wallets[e.key].rows,saved.wallets[e.key].rows);
    assert.deepEqual(monitor.snapshot().scanChains,['bsc']);
  }finally{await monitor.stop();}
});

test('brain labels actual scan scope instead of displaying excluded chains as scanned',()=>{
  const html=renderBrainTelemetry({scanScope:{scanChains:['bsc']},cadence:{marketSourceAges:[
    {chain:'bsc',ageMs:1000,status:'ok'},{chain:'sol',ageMs:1000,status:'ok'}]}},true);
  assert.match(html,/交易扫描：币安链/);assert.doesNotMatch(html,/Solana/);assert.match(html,/其他链旧仓只做退出管理/);
});
