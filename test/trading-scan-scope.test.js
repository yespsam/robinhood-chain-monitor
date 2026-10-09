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
