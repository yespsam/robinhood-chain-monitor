import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaperStrategyAccount, validatePaperStrategyAccount, resetPaperCash } from '../src/paper-strategy-engine.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { createReviewComparison, reviewComparisonSummary } from '../src/paper-review-comparison.js';
import { createDashboardServer } from '../scripts/dashboard-server.js';

const NOW=Date.parse('2026-09-26T08:00:00Z'), operationId='test_reset_20260926';
function lostAccount() {
  const account=createPaperStrategyAccount({nowMs:NOW});
  account.cash=24.25; account.realizedPnl=-75.75;
  account.stats.equity=24.25; account.stats.realizedPnl=-75.75;
  return account;
}
test('manual paper reset preserves history, losses and capital identity; retries do not refund twice',()=>{
  const before=lostAccount(), frozen=structuredClone(before), comparison=createReviewComparison(before,NOW);
  const next=resetPaperCash(before,{operationId,nowMs:NOW+1});
  assert.equal(next.cash,100);assert.equal(next.initialCash,100);assert.equal(next.realizedPnl,-75.75);
  assert.equal(next.cashAdjustments[0].amountUsd,75.75);assert.deepEqual(next.trades,before.trades);
  assert.deepEqual(before,frozen);assert.equal(validatePaperStrategyAccount(next),true);
  assert.deepEqual(resetPaperCash(next,{operationId,nowMs:NOW+2}),next);
  const report=reviewComparisonSummary(comparison,next);
  assert.equal(report.main.equityChange,0);assert.equal(report.main.periodRealizedPnl,0);
  assert.equal(report.control.netLiquidationValue,24.25);
});
test('funding evidence cannot silently repair a corrupt or real account',()=>{
  for(const change of [a=>a.mode='live',a=>a.execution=true,a=>a.cash++,a=>a.variant='learning_control',a=>a.positions.fake={}]) {
    const a=lostAccount();change(a);assert.throws(()=>resetPaperCash(a,{operationId,nowMs:NOW}));
  }
  for(const id of ['', '../overwrite', 'a', null])assert.throws(()=>resetPaperCash(lostAccount(),{operationId:id,nowMs:NOW}));
  const reset=()=>resetPaperCash(lostAccount(),{operationId,nowMs:NOW});
  for(const change of [a=>a.cashAdjustments[0].amountUsd++,a=>a.cashAdjustments.push(a.cashAdjustments[0]),
    a=>a.cashAdjustments[0].tradeCount++,a=>a.cashAdjustments[0].cashBefore=NaN]) {
    const a=reset();change(a);assert.throws(()=>validatePaperStrategyAccount(a));
  }
});
test('serialized runtime reset creates a backup, persists once and survives restart without changing reviews',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'paper-reset-test-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const market={trending:async()=>({status:'unavailable',tokens:[]}),trenches:async()=>({status:'unavailable',tokens:[]})};
  const options={dataDir,market,now:()=>NOW,evidenceLoader:()=>({})};
  let runtime=createPaperStrategyRuntime(options);
  await runtime.setEnabled(false);const file=runtime.stateFile;await runtime.stop();
  const stored=JSON.parse(await fs.readFile(file,'utf8'));stored.account=lostAccount();
  await fs.writeFile(file,JSON.stringify(stored));
  runtime=createPaperStrategyRuntime(options);
  try {
    await Promise.all([runtime.resetCash(operationId),runtime.resetCash(operationId)]);
    const after=JSON.parse(await fs.readFile(file,'utf8'));
    const backup=JSON.parse(await fs.readFile(`${file}.before-reset-${operationId}.json`,'utf8'));
    assert.equal(after.account.cash,100);assert.equal(after.account.cashAdjustments.length,1);
    assert.equal(backup.account.cash,24.25);assert.equal(after.enabled,false);
    for(const key of ['reviewComparison','exitComparison','tradeCountReview','narrativeMemory','narrativeLearningMemory'])assert.deepEqual(after[key],backup[key]);
  } finally {await runtime.stop();}
  runtime=createPaperStrategyRuntime(options);
  try {await runtime.setEnabled(false);assert.equal(runtime.snapshot().account.cash,100);
    assert.equal(runtime.snapshot().account.realizedPnl,-75.75);
  }finally{await runtime.stop();}
});
test('reset HTTP route requires explicit local JSON confirmation and never controls real funds',async t=>{
  let calls=0;const app=createDashboardServer({host:'127.0.0.1',port:0,
    strategyRuntime:{snapshot:()=>({}),resetCash:async id=>{calls++;return{mode:'paper',id};}}});
  const address=await app.listen();t.after(()=>app.close());
  const base=`http://${address.address}:${address.port}`,url=`${base}/api/paper-cash-reset`;
  const payload={confirm:'reset_main_paper_cash_to_100_preserve_history',operationId};
  const post=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(url)).status,405);
  assert.equal((await post(payload,{Origin:'https://evil.example'})).status,403);
  assert.equal((await post({...payload,confirm:'yes'})).status,400);
  assert.equal((await post({...payload,amount:100})).status,400);
  assert.equal(calls,0);assert.equal((await post(payload,{Origin:base})).status,200);assert.equal(calls,1);
});
