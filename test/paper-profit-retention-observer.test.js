import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { ESTIMATED_COST_VERSION } from '../src/paper-estimated-cost.js';
import { createProfitRetentionObserver } from '../src/paper-profit-retention-observer.js';

const NOW = Date.parse('2026-10-17T15:00:00Z'), sessionId = 'confirmed-pvp-v2-observer-fixture';
const sourceLedgerName = `yesp-atm-${sessionId}.json`;
const account = () => ({ ...createPaperStrategyAccount({nowMs:NOW}), estimatedCostModel:ESTIMATED_COST_VERSION });
async function directory(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profit-observer-'));
  t.after(() => fs.rm(dataDir, {recursive:true,force:true})); return dataDir;
}
const factory = (dataDir, extra={}) => createProfitRetentionObserver({dataDir,sessionId,sourceLedgerName,now:()=>NOW,...extra});

test('observer establishes one isolated baseline, resumes exact checkpoint, never changes its source', async t => {
  const dataDir = await directory(t), a = account(), original = structuredClone(a);
  const source = path.join(dataDir,sourceLedgerName); await fs.writeFile(source,JSON.stringify(a));
  const observer = factory(dataDir); assert.equal(observer.snapshot().status,'not_loaded');
  await observer.initialize({account:a}); assert.equal(observer.snapshot().status,'observing');
  await observer.initialize({account:a}); await observer.flush();
  const raw = await fs.readFile(observer.stateFile,'utf8');
  const saved = JSON.parse(raw); assert.equal(saved.checkpoint.tradeCount,0); assert.equal(saved.sessionId,sessionId);
  assert.deepEqual(saved.shadow.arms.map(arm=>arm.multiple),[2,3,5]);
  assert.equal(observer.snapshot().pairedCohort,true);assert.equal(observer.snapshot().performance,undefined);
  const restored = factory(dataDir); await restored.initialize({account:a});
  assert.equal(restored.snapshot().status,'observing'); assert.equal(await fs.readFile(observer.stateFile,'utf8'),raw);
  assert.deepEqual(a,original); assert.equal(await fs.readFile(source,'utf8'),JSON.stringify(original));
});

test('corrupt state and source commit gaps freeze without reset, backfill, or file replacement', async t => {
  for (const kind of ['json','trades','rewrite','identity','missing_arm','duplicate_arm','arm_cursor','envelope_hash']) await t.test(kind,async t => {
    const dataDir = await directory(t), a = account(), observer = factory(dataDir);
    if(kind==='rewrite') a.trades.push({id:'old-source-fill',atMs:NOW-1,side:'buy',price:1});
    await observer.initialize({account:a}); let raw = await fs.readFile(observer.stateFile,'utf8');
    if(kind==='json') { raw='{not json'; await fs.writeFile(observer.stateFile,raw); }
    if(kind==='identity') { const saved=JSON.parse(raw);saved.sessionId='confirmed-pvp-v2-other';raw=JSON.stringify(saved);await fs.writeFile(observer.stateFile,raw); }
    if(['missing_arm','duplicate_arm','arm_cursor','envelope_hash'].includes(kind)) {
      const saved=JSON.parse(raw);
      if(kind==='missing_arm')saved.shadow.arms.pop();
      if(kind==='duplicate_arm')saved.shadow.arms[2]=structuredClone(saved.shadow.arms[1]);
      if(kind==='arm_cursor')saved.shadow.arms[1].study.cursor.tradeCount++;
      if(kind==='envelope_hash')saved.checkpoint.tradePrefixHash='0'.repeat(64);
      raw=JSON.stringify(saved);await fs.writeFile(observer.stateFile,raw);
    }
    if(kind==='trades') a.trades.push({id:'missed-main-fill'});
    if(kind==='rewrite') a.trades[0].price=2;
    const restored=factory(dataDir,{now:()=>NOW+1000}); await restored.initialize({account:a});
    assert.equal(restored.snapshot().status,'error');
    assert.doesNotThrow(()=>restored.observeCommitted({beforeAccount:a,afterAccount:a,marks:[],nowMs:NOW+2000,path:'exit'}));
    await restored.flush(); assert.equal(await fs.readFile(observer.stateFile,'utf8'),raw);
  });
});

test('an invalid snapshot clock does not freeze observation or discard pending writes', async t => {
  const dataDir=await directory(t), a=account(); let clock=NOW, release;
  const writes=[];
  const observer=factory(dataDir,{now:()=>clock,writeSnapshot:async(file,value)=>{
    writes.push(structuredClone(value));
    if(writes.length===2)await new Promise(resolve=>{release=resolve;});
    await fs.writeFile(file,JSON.stringify(value));
  }});
  await observer.initialize({account:a});
  const next={...a,updatedAt:new Date(++clock).toISOString()};
  observer.observeCommitted({beforeAccount:a,afterAccount:next,marks:[],nowMs:clock,path:'exit'});
  await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
  const latest={...next,updatedAt:new Date(++clock).toISOString()};
  observer.observeCommitted({beforeAccount:next,afterAccount:latest,marks:[],nowMs:clock,path:'exit'});
  for(const invalid of [NOW-1,undefined,NaN,Infinity]){
    clock=invalid;
    const result=observer.snapshot();assert.equal(result.status,'error');
    assert.equal(result.error,'PROFIT_RETENTION_SUMMARY_CLOCK_INVALID');
    assert.equal(result.summaryError.reason,Number.isFinite(invalid)?'clock_before_last_commit':'clock_not_finite');
    assert.equal(result.arms,undefined,'never invent fresh valuations by clamping a bad clock');
    assert.equal(result.pendingWrite,true);
  }
  clock=NOW+1000;
  assert.equal(observer.snapshot().status,'observing');assert.equal(observer.snapshot().error,null);
  release();await observer.flush();assert.equal(writes.length,3);
  assert.equal(JSON.parse(await fs.readFile(observer.stateFile,'utf8')).checkpoint.accountUpdatedAt,latest.updatedAt);
  const final={...latest,updatedAt:new Date(++clock).toISOString()};
  observer.observeCommitted({beforeAccount:latest,afterAccount:final,marks:[],nowMs:clock,path:'exit'});
  await observer.flush();assert.equal(observer.snapshot().checkpoint.accountUpdatedAt,final.updatedAt);
  assert.equal(observer.snapshot().summaryError,null);
});

async function committedStudy(t,{close=true}={}) {
  const dataDir=await directory(t),a=account(),address=`0x${'a'.repeat(40)}`;let clock=NOW;
  const observer=factory(dataDir,{now:()=>clock});await observer.initialize({account:a});
  const costs={version:ESTIMATED_COST_VERSION,feeRate:.01,slippageRate:.01,gasUsd:.04,buyTax:0,sellTax:0};
  const entry={id:'new-entry',side:'buy',chain:'bsc',address,quantity:10,price:1,grossUsd:10,costsUsd:.24,netUsd:-10.24,
    costBasisUsd:10.24,realizedPnl:0,atMs:++clock,entryEvidence:{costAssumptions:costs}};
  let current={...a,trades:[entry],updatedAt:new Date(clock).toISOString()};
  observer.observeCommitted({beforeAccount:a,afterAccount:current,marks:[],nowMs:clock,path:'targeted_entry'});
  if(close){
    const exit={id:'actual-full-exit',side:'sell',chain:'bsc',address,quantity:10,price:1.5,grossUsd:15,costsUsd:.34,
      netUsd:14.66,costBasisUsd:10.24,realizedPnl:4.42,atMs:++clock};
    const closed={...current,trades:[entry,exit],updatedAt:new Date(clock).toISOString()};
    observer.observeCommitted({beforeAccount:current,afterAccount:closed,marks:[],nowMs:clock,path:'exit'});current=closed;
  }
  await observer.flush();return{dataDir,current,file:observer.stateFile,raw:await fs.readFile(observer.stateFile,'utf8')};
}

test('exact trade prefix and no active pairs recover a mark-only interruption without replay or rebasing',async t=>{
  const f=await committedStudy(t),before=JSON.parse(f.raw),nowMs=NOW+86400000;
  const current={...f.current,updatedAt:new Date(nowMs).toISOString()},source=structuredClone(current);
  const observer=factory(f.dataDir,{now:()=>nowMs});await observer.initialize({account:current});
  const summary=observer.snapshot(),saved=JSON.parse(await fs.readFile(f.file,'utf8'));
  assert.equal(summary.status,'observing');assert.equal(summary.closedPairs,1);assert.equal(summary.openPairs,0);
  assert.deepEqual(saved.shadow,before.shadow,'no quote replay, new baseline, altered arm or cleared gap');
  assert.deepEqual(current,source);assert.equal(saved.checkpoint.accountUpdatedAt,current.updatedAt);
  assert.equal(saved.checkpoint.tradePrefixHash,before.checkpoint.tradePrefixHash);
  assert.equal(summary.observerCoverage.interruptionCount,1);
  assert.deepEqual(summary.observerCoverage.interruptions,[{reason:'no_active_pairs_mark_only_gap',
    fromAccountUpdatedAt:before.checkpoint.accountUpdatedAt,toAccountUpdatedAt:current.updatedAt,
    detectedAtMs:nowMs,tradeCount:2,tradePrefixHash:before.checkpoint.tradePrefixHash}]);
  let clock=nowMs+1;
  const restored=factory(f.dataDir,{now:()=>clock});await restored.initialize({account:current});
  assert.equal(restored.snapshot().observerCoverage.interruptionCount,1,'restart does not double-count the gap');
  clock++;
  const later={...current,updatedAt:new Date(clock).toISOString()};
  restored.observeCommitted({beforeAccount:current,afterAccount:later,marks:[],nowMs:clock,path:'exit'});
  await restored.flush();assert.equal(restored.snapshot().status,'observing');
  assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')).shadow.baseline,before.shadow.baseline);
  assert.deepEqual(restored.snapshot().sharedCoverage,before.shadow.sharedCoverage);
});

test('mark-only recovery refuses missed trades, active arms, rewritten prefixes, missing arms and rewound dates',async t=>{
  for(const kind of ['new_trade','active','rewrite','persisted_rewrite','missing_arm','rewound_date','invalid_date','bad_coverage'])await t.test(kind,async t=>{
    const f=await committedStudy(t,{close:kind!=='active'}),nowMs=NOW+1000;
    const current=structuredClone(f.current);current.updatedAt=new Date(nowMs).toISOString();let raw=f.raw;
    if(kind==='new_trade')current.trades.push({id:'missed-fill',atMs:nowMs});
    if(kind==='rewrite')current.trades[0].price=2;
    if(kind==='rewound_date')current.updatedAt=new Date(NOW-1).toISOString();
    if(kind==='invalid_date')current.updatedAt='invalid';
    if(kind==='missing_arm'||kind==='bad_coverage'){
      const saved=JSON.parse(raw);
      if(kind==='missing_arm')saved.shadow.arms.pop();else saved.observerCoverage={version:'untrusted'};
      raw=JSON.stringify(saved);await fs.writeFile(f.file,raw);
    }
    const persistedAccount=structuredClone(current);
    if(kind==='persisted_rewrite')persistedAccount.trades[0].price=2;
    const observer=factory(f.dataDir,{now:()=>nowMs});await observer.initialize({account:current,persistedAccount});
    assert.equal(observer.snapshot().status,'error');assert.equal(await fs.readFile(f.file,'utf8'),raw);
  });
});

test('slow storage uses one writer and one latest snapshot without blocking commits', async t => {
  const dataDir=await directory(t), calls=[]; let release, a=account(), clock=NOW;
  const observer=factory(dataDir,{now:()=>clock,writeSnapshot:async(file,value)=>{
    calls.push(structuredClone(value));
    if(calls.length===2) await new Promise(resolve=>{release=resolve;});
    await fs.writeFile(file,JSON.stringify(value));
  }});
  await observer.initialize({account:a});
  for(let i=1;i<=20;i++) {
    clock=NOW+i;
    const next={...a,updatedAt:new Date(NOW+i).toISOString()};
    const result=observer.observeCommitted({beforeAccount:a,afterAccount:next,marks:[],nowMs:NOW+i,path:'scan'});
    assert.equal(result,undefined); a=next;
  }
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(calls.length,2); assert.ok(release);
  assert.equal(observer.snapshot().pendingWrite,true); release(); await observer.flush();
  assert.equal(calls.length,3); assert.equal(calls.at(-1).checkpoint.accountUpdatedAt,a.updatedAt);
  assert.equal(observer.snapshot().pendingWrite,false); assert.equal(observer.snapshot().status,'observing');
});

test('storage failure is sanitized, freezes research only, and preserves durable evidence', async t => {
  const dataDir=await directory(t), a=account(); let count=0,clock=NOW;
  const observer=factory(dataDir,{now:()=>clock,writeSnapshot:async(file,value)=>{
    if(count++) throw Error('sensitive storage detail'); await fs.writeFile(file,JSON.stringify(value));
  }});
  await observer.initialize({account:a}); const raw=await fs.readFile(observer.stateFile,'utf8');
  clock=NOW+1;
  const next={...a,updatedAt:new Date(NOW+1).toISOString()};
  assert.doesNotThrow(()=>observer.observeCommitted({beforeAccount:a,afterAccount:next,marks:[],nowMs:NOW+1,path:'exit'}));
  await observer.flush(); assert.equal(observer.snapshot().error,'PROFIT_RETENTION_PERSIST_FAILED');
  assert.ok(!JSON.stringify(observer.snapshot()).includes('sensitive'));
  assert.equal(await fs.readFile(observer.stateFile,'utf8'),raw); assert.deepEqual(a,account());
});

test('observer refuses unsafe filename identities',()=>{
  assert.throws(()=>factory('/tmp',{sessionId:'../elsewhere'}));
  assert.throws(()=>factory('/tmp',{sourceLedgerName:'different.json'}));
  for(const value of [undefined,0,1,1.5,2,3,4,5,NaN,Infinity,'2',null])assert.throws(()=>factory('/tmp',{triggerPriceMultiple:value}),/multiple/);
  assert.throws(()=>factory('/tmp',{triggerPriceMultiples:[2,3]}),/multiple/);
  assert.throws(()=>factory('/tmp',{profitRetentionPriceMultiples:[2,3,5]}),/multiple/);
});

test('v3 uses a separate baseline without reading or migrating prior v1/v2 evidence',async t=>{
  const dataDir=await directory(t),legacy=[`paper-profit-retention-${sessionId}.json`,`paper-profit-retention-principal-v2-${sessionId}.json`].map(name=>path.join(dataDir,name));
  const original='old evidence preserved';for(const file of legacy)await fs.writeFile(file,original);
  const observer=factory(dataDir);await observer.initialize({account:account()});
  assert.equal(observer.snapshot().status,'observing');assert.deepEqual(observer.snapshot().policy.triggerPriceMultiples,[2,3,5]);
  assert.match(observer.stateFile,/paper-profit-retention-multiarm-v3-/);
  for(const file of legacy)assert.equal(await fs.readFile(file,'utf8'),original);
});

test('all three arms restore together and retain the same source entry and full exit',async t=>{
  const dataDir=await directory(t),a=account(),address=`0x${'a'.repeat(40)}`;let clock=NOW,observer=factory(dataDir,{now:()=>clock});
  await observer.initialize({account:a});
  const costs={version:ESTIMATED_COST_VERSION,feeRate:.01,slippageRate:.01,gasUsd:.04,buyTax:0,sellTax:0};
  const entry={id:'new-entry',side:'buy',chain:'bsc',address,quantity:10,price:1,grossUsd:10,costsUsd:.24,netUsd:-10.24,
    costBasisUsd:10.24,realizedPnl:0,atMs:++clock,entryEvidence:{costAssumptions:costs}};
  let current={...a,trades:[entry],updatedAt:new Date(clock).toISOString()};
  observer.observeCommitted({beforeAccount:a,afterAccount:current,marks:[],nowMs:clock,path:'targeted_entry'});
  for(const price of [2.2,2.3]){
    clock+=1000;const next={...current,updatedAt:new Date(clock).toISOString()};
    observer.observeCommitted({beforeAccount:current,afterAccount:next,marks:[{chain:'bsc',address,price,status:'ok',observedAt:next.updatedAt}],nowMs:clock,path:'exit'});
    current=next;
  }
  await observer.flush();const before=observer.snapshot();assert.equal(before.openPairs,1);assert.equal(before.performance,undefined);
  assert.deepEqual(before.arms.map(arm=>arm.active[0].id),[entry.id,entry.id,entry.id]);
  assert.deepEqual(before.arms.map(arm=>arm.active[0].partialTaken),[true,false,false]);
  observer=factory(dataDir,{now:()=>clock});await observer.initialize({account:current});
  assert.deepEqual(observer.snapshot().arms,before.arms);
  clock+=1000;
  const exit={id:'actual-full-exit',side:'sell',chain:'bsc',address,quantity:10,price:1.5,grossUsd:15,costsUsd:.34,
    netUsd:14.66,costBasisUsd:10.24,realizedPnl:4.42,atMs:clock};
  const closed={...current,trades:[entry,exit],updatedAt:new Date(clock).toISOString()};
  observer.observeCommitted({beforeAccount:current,afterAccount:closed,marks:[],nowMs:clock,path:'exit'});await observer.flush();
  const result=observer.snapshot();assert.equal(result.closedPairs,1);assert.equal(result.openPairs,0);
  assert.deepEqual(result.arms.map(arm=>arm.performance.controlNetUsd),[exit.realizedPnl,exit.realizedPnl,exit.realizedPnl]);
  assert.ok(result.arms[0].performance.deltaNetUsd>0);assert.equal(result.arms[1].performance.deltaNetUsd,0);assert.equal(result.arms[2].performance.deltaNetUsd,0);
  const saved=JSON.parse(await fs.readFile(observer.stateFile,'utf8'));
  assert.deepEqual(saved.shadow.arms.map(arm=>arm.study.pairs[0].control.sourceId),[exit.id,exit.id,exit.id]);
});
