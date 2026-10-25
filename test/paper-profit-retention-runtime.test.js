import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { ESTIMATED_COST_VERSION } from '../src/paper-estimated-cost.js';
import { CONFIRMED_PAPER_VERSION } from '../src/paper-confirmed-policy.js';

const NOW=Date.parse('2026-10-17T15:00:00Z');
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,
  continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true};
async function fixture(t, enabled) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'profit-runtime-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const session={schema:'yesp_atm_paper_session_v1',id:'confirmed-pvp-v2-profit-fixture',label:'估算费用独立模拟盘',
    mode:'paper',initialCash:100,strategyVersion:CONFIRMED_PAPER_VERSION,createdAt:new Date(NOW).toISOString(),
    chain:'bsc',chains:['bsc'],costModel:ESTIMATED_COST_VERSION,
    legacy:{file:'yesp-atm-confirmed-pvp-v2-old-fixture.json',sha256:'a'.repeat(64),cash:100,realizedPnl:0,tradeCount:0}};
  const source=path.join(dataDir,`yesp-atm-${session.id}.json`),account={...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION};
  await fs.writeFile(source,JSON.stringify({schema:'yesp_atm_runtime_v1',session,chain:'bsc',chains:['bsc'],enabled:true,account}));
  const calls=[]; let clock=NOW;
  const market={trending:async q=>{calls.push(['trending',q]);return{status:'ok',observedAt:new Date(clock).toISOString(),tokens:[]};},
    trenches:async q=>{calls.push(['trenches',q]);return{status:'ok',observedAt:new Date(clock).toISOString(),tokens:[]};},
    quote:async q=>{calls.push(['quote',q]);return{status:'unavailable'};},
    kline:async q=>{calls.push(['kline',q]);return{status:'unavailable',candles:[]};}};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,evidenceLoader:()=>({}),now:()=>clock,
    ...(enabled===undefined?{}:{profitRetentionShadow:enabled})};
  return {dataDir,session,source,calls,options,tick:()=>clock+=1000};
}

test('profit retention runtime is default off, explicit opt-in only, and rejects invalid modes',async t=>{
  const f=await fixture(t),runtime=createPaperStrategyRuntime(f.options);
  try{
    assert.equal(runtime.snapshot().profitRetentionShadow.status,'disabled');
    assert.equal(runtime.snapshot().profitRetentionShadow.version,'profit_retention_multiarm_v3');
    assert.deepEqual(runtime.snapshot().profitRetentionShadow.configuredPriceMultiples,[2,3,5]);
    await runtime.runOnce();
    assert.ok(!(await fs.readdir(f.dataDir)).some(name=>name.startsWith('paper-profit-retention-')));
    assert.throws(()=>createPaperStrategyRuntime({...f.options,profitRetentionShadow:'1'}),/profit retention/);
    assert.throws(()=>createPaperStrategyRuntime({...f.options,session:null,profitRetentionShadow:true}),/profit retention/);
    for(const value of [undefined,null,NaN,Infinity,'2',1,2,3,4,5])assert.throws(()=>createPaperStrategyRuntime({...f.options,profitRetentionPriceMultiple:value}),/multiple/);
    for(const key of ['profitRetentionPriceMultiples','triggerPriceMultiple','triggerPriceMultiples'])
      assert.throws(()=>createPaperStrategyRuntime({...f.options,[key]:[2,3,5]}),/multiple/);
  }finally{await runtime.stop();}
});

test('enabled passive study leaves main payload and market request sequence identical',async t=>{
  const outcomes=[];
  for(const enabled of [false,true]){
    const f=await fixture(t,enabled),runtime=createPaperStrategyRuntime(f.options);
    try{
      if(enabled)assert.equal(runtime.snapshot().profitRetentionShadow.status,'not_loaded');
      await runtime.runOnce();f.tick();await runtime.fastOnce();await runtime.exitOnce();
      const snapshot=runtime.snapshot(),payload=JSON.parse(await fs.readFile(f.source,'utf8'));
      assert.ok(!Object.hasOwn(payload,'profitRetentionShadow'),'never embeds study into main ledger');
      assert.ok(!Object.hasOwn(payload,'profitRetentionObserver'));
      assert.equal(snapshot.profitRetentionShadow.status,enabled?'observing':'disabled');
      outcomes.push({account:snapshot.account,calls:f.calls,payload});
    }finally{await runtime.stop();}
  }
  assert.deepEqual(outcomes[0],outcomes[1]);
});

test('corrupt study file freezes only study while main run and controls continue',async t=>{
  const f=await fixture(t,true),file=path.join(f.dataDir,`paper-profit-retention-multiarm-v3-${f.session.id}.json`);
  await fs.writeFile(file,'invalid study retained');
  const runtime=createPaperStrategyRuntime(f.options);
  try{
    await runtime.runOnce();await runtime.setEnabled(false);f.tick();await runtime.fastOnce();await runtime.exitOnce();
    const snapshot=runtime.snapshot();assert.equal(snapshot.profitRetentionShadow.status,'error');
    assert.equal(snapshot.status,'ok');assert.equal(snapshot.enabled,false);assert.equal(snapshot.account.cash,100);
    assert.equal(await fs.readFile(file,'utf8'),'invalid study retained');
  }finally{await runtime.stop();}
});

async function tradingFixture(t, enabled) {
  const f=await fixture(t,enabled),calls=[],address=`0x${'a'.repeat(40)}`;let clock=NOW,price=1.028;
  const token={chain:'bsc',address,symbol:'OFFLINE',marketStage:'external',liquidity:60000,volume:5000,
    isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
  const candles=Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:i===29?1:i<8?.8+i*.025:1,
    high:i===29?1.035:i<8?.81+i*.025:1.01,low:i===29?.999:i<8?.795+i*.025:.995,
    close:i===29?1.03:i<8?.8+i*.025:1,volume:i===29?180:100}));
  const market={trending:async q=>{calls.push(['ranking',q]);return{status:'ok',observedAt:new Date(clock).toISOString(),tokens:[{...token,price}]};},
    trenches:async q=>{calls.push(['trenches',q]);return{status:'ok',observedAt:new Date(clock).toISOString(),tokens:[]};},
    kline:async q=>{calls.push(['chart',q]);return{...token,resolution:'1m',status:'ok',candles};},
    quote:async q=>{calls.push(['quote',q]);return{...token,price,status:'ok',observedAt:new Date(clock).toISOString()};}};
  const runtimeOptions={...f.options,market,now:()=>clock};
  const runtime=createPaperStrategyRuntime(runtimeOptions);
  const enter=async()=>{
    await runtime.runOnce();
    for(let n=0;n<6&&runtime.snapshot().account.trades.length===0;n++){
      await runtime.fastOnce();await runtime.refreshQuote();await runtime.fastOnce();clock+=4000;price=1.03;
    }
    assert.equal(runtime.snapshot().account.trades.length,1,JSON.stringify(runtime.snapshot().evaluations.map(e=>({m:e.missing,r:e.reasons}))));
  };
  const quote=async(delta=60000)=>{clock+=delta;price=2.3;await runtime.refreshQuote();};
  return {...f,calls,runtime,runtimeOptions,enter,quote};
}

test('same actual new main buy and full exit yield one paired round without changing fills or requests',async t=>{
  const outcomes=[];
  for(const enabled of [false,true]){
    const f=await tradingFixture(t,enabled),r=f.runtime;
    try{
      await f.enter();
      if(enabled){
        const study=r.snapshot().profitRetentionShadow;
        assert.equal(study.openPairs,1);assert.equal(study.status,'observing');
        assert.deepEqual(study.policy.triggerPriceMultiples,[2,3,5]);assert.equal(study.pairedCohort,true);
        assert.deepEqual(study.arms.map(a=>a.active[0].id),Array(3).fill(r.snapshot().account.trades[0].id));
      }
      // Do not fabricate an exit: real-shaped fresh quotes continue while the
      // fixture's entry chart ages out. The existing main evidence-gap policy
      // eventually produces the actual full exit shared by all three arms.
      let recoveredPrincipal=false;
      for(let n=0;n<12&&r.snapshot().account.trades.length===1;n++){
        await f.quote();await r.exitOnce();
        recoveredPrincipal ||= r.snapshot().profitRetentionShadow.arms?.find(a=>a.multiple===2)?.active.some(p=>p.partialTaken
          &&p.recoveredPrincipalUsd>=p.principalTargetUsd-1e-8&&p.remainingFraction>0)===true;
      }
      const s=r.snapshot();assert.equal(s.account.trades.length,2);assert.equal(s.account.trades[1].side,'sell');
      if(enabled){
        assert.equal(s.profitRetentionShadow.status,'observing');assert.equal(s.profitRetentionShadow.closedPairs,1);
        assert.equal(s.profitRetentionShadow.performance,undefined,'never aggregate profits across repeated control cohorts');
        assert.deepEqual(s.profitRetentionShadow.arms.map(a=>a.performance.controlNetUsd),Array(3).fill(s.account.trades[1].realizedPnl));
        assert.deepEqual(s.profitRetentionShadow.arms.map(a=>a.closedPairs),[1,1,1]);
        assert.deepEqual(s.profitRetentionShadow.arms.slice(1).map(a=>a.performance.deltaNetUsd),[0,0]);
        assert.equal(s.profitRetentionShadow.lastCommitPath,'exit');
        assert.ok(recoveredPrincipal,'two fresh >=2x observations recover all-in principal after exit costs before the main exit');
      }
      outcomes.push({account:s.account,calls:f.calls,payload:JSON.parse(await fs.readFile(f.source,'utf8'))});
    }finally{await r.stop();}
  }
  assert.deepEqual(outcomes[0],outcomes[1]);
});

test('runtime restores all three arms together without joining preexisting positions again',async t=>{
  const f=await tradingFixture(t,true),r=f.runtime;
  await f.enter();await f.quote();await r.exitOnce();await f.quote();await r.exitOnce();await r.stop();
  const before=r.snapshot().profitRetentionShadow;
  assert.deepEqual(before.arms.map(a=>a.active[0].partialTaken),[true,false,false]);
  const restored=createPaperStrategyRuntime(f.runtimeOptions);
  try{
    // load() executes through the normal runtime entry point; runOnce may also
    // append a mark-only commit but must preserve the same admission cohort.
    await restored.runOnce();const after=restored.snapshot().profitRetentionShadow;
    assert.equal(after.status,'observing');assert.equal(after.openPairs,1);
    assert.deepEqual(after.arms.map(a=>a.active[0].id),before.arms.map(a=>a.active[0].id));
    assert.deepEqual(after.arms.map(a=>a.active[0].partialTaken),[true,false,false]);
    assert.deepEqual(after.arms.map(a=>a.baseline),before.arms.map(a=>a.baseline));
    assert.ok(!Object.hasOwn(JSON.parse(await fs.readFile(f.source,'utf8')),'profitRetentionShadow'));
  }finally{await restored.stop();}
});

test('dashboard server only exposes the explicit v3 opt-in and ignores retired activation flags',async()=>{
  const source=await fs.readFile(new URL('../scripts/dashboard-server.js',import.meta.url),'utf8');
  assert.match(source,/profitRetentionShadow:\s*process\.env\.PAPER_PROFIT_RETENTION_MULTIARM_SHADOW\s*===\s*'1'/);
  assert.doesNotMatch(source,/process\.env\.PAPER_PROFIT_RETENTION_(?:SHADOW|MULTIPLE)\b/);
});

test('failed main atomic commit never advances the passive study',async t=>{
  const f=await tradingFixture(t,true),r=f.runtime;
  try{
    await f.enter();const before=r.snapshot();await f.quote();
    const rename=fs.rename.bind(fs);
    const mocked=t.mock.method(fs,'rename',async(from,to)=>{
      if(to===f.source)throw Object.assign(Error('offline main-write failure'),{code:'EIO'});
      return rename(from,to);
    });
    await assert.rejects(r.exitOnce());mocked.mock.restore();
    const after=r.snapshot();
    assert.deepEqual(after.account,before.account);
    assert.deepEqual(after.profitRetentionShadow.checkpoint,before.profitRetentionShadow.checkpoint);
    assert.equal(after.profitRetentionShadow.updatedAtMs,before.profitRetentionShadow.updatedAtMs);
    assert.equal(after.profitRetentionShadow.status,'observing');
  }finally{await r.stop();}
});
