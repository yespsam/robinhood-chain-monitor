import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createPaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { createConfirmedPaperSession, loadPaperSession, paperSessionLedgerFile, validatePaperSession, LEGACY_PAPER_FILE, PAPER_SESSION_FILE } from '../src/paper-account-session.js';
const NOW = Date.parse('2026-09-23T06:00:00Z'), ID = 'confirmed-pvp-v2-offline-test';
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-session-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const account = createPaperStrategyAccount({ nowMs: NOW });
  // Test-only reconciled loss, never written to the production data directory.
  account.cash=6.26;account.realizedPnl=-93.74;
  const legacy={schema:'yesp_atm_runtime_v1',chain:'robinhood',chains:['robinhood','base'],enabled:false,account};
  const old=JSON.stringify(legacy);await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),old);
  return {dataDir,old,legacy};
}
function runtime(dataDir,session,extra={}) {
  const unavailable=async()=>({status:'unavailable',tokens:[],reason:'offline_test'});
  return createPaperStrategyRuntime({dataDir,session,chain:session.chain,chains:session.chains,
    market:{trending:unavailable,trenches:unavailable,quote:unavailable},evidenceLoader:()=>({}),now:()=>NOW,
    pvpMode:true,allowExploratory:true,compoundEntries:true,confirmedMode:true,...extra});
}
test('independent $100 paper session preserves legacy bytes, selects separate writer and resumes without refill',async t=>{
  const {dataDir,old}=await fixture(t);
  assert.equal(await loadPaperSession(dataDir),null);
  const session=await createConfirmedPaperSession({dataDir,id:ID,nowMs:NOW});
  assert.equal(session.legacy.cash,6.26);assert.equal(session.legacy.realizedPnl,-93.74);
  assert.equal(session.legacy.sha256,createHash('sha256').update(old).digest('hex'));
  const file=path.join(dataDir,paperSessionLedgerFile(session));
  let r=runtime(dataDir,session);
  try {
    await r.runOnce();let s=r.snapshot();assert.equal(s.account.cash,100);assert.equal(s.account.trades.length,0);
    assert.equal(s.enabled,false);assert.equal(s.entryGuard.allowed,true);assert.deepEqual(s.session,session);
    assert.equal(r.stateFile,file);await assert.rejects(fs.stat(path.join(dataDir,`${LEGACY_PAPER_FILE}.lock`)),{code:'ENOENT'});
    const competing=runtime(dataDir,session);try{await assert.rejects(competing.runOnce(),/已有进程运行/);}finally{await competing.stop();}
    await r.setEnabled(true);await r.stop();
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    saved.account.cash=99;saved.account.realizedPnl=-1;await fs.writeFile(file,JSON.stringify(saved));
    assert.deepEqual(await createConfirmedPaperSession({dataDir,id:ID,nowMs:NOW+1000}),session);
    r=runtime(dataDir,await loadPaperSession(dataDir));await r.runOnce();s=r.snapshot();
    assert.equal(s.enabled,true);assert.equal(s.account.cash,99);assert.equal(s.account.realizedPnl,-1);
    for(const flag of ['execution','signing','broadcast'])assert.equal(s[flag],false);
    await r.setEnabled(false);
    assert.equal(await fs.readFile(path.join(dataDir,LEGACY_PAPER_FILE),'utf8'),old);
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')).session,session);
    await assert.rejects(createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-another',nowMs:NOW}),/已有独立模拟实验/);
  }finally{await r.stop();}
});
test('missing, malformed, foreign or misfunded experiment fails closed, not a new $100 account',async t=>{
  const {dataDir,old}=await fixture(t);const session=await createConfirmedPaperSession({dataDir,id:ID,nowMs:NOW});
  const file=path.join(dataDir,paperSessionLedgerFile(session)), saved=JSON.parse(await fs.readFile(file,'utf8'));
  for(const mutate of [s=>delete s.session,s=>s.session.id='confirmed-pvp-v2-foreign',s=>{s.account.initialCash=200;s.account.cash=200;}]){
    const s=structuredClone(saved);mutate(s);const raw=JSON.stringify(s);await fs.writeFile(file,raw);
    const r=runtime(dataDir,session);try{await assert.rejects(r.runOnce(),/不匹配/);}finally{await r.stop();}
    assert.equal(await fs.readFile(file,'utf8'),raw);
  }
  await fs.unlink(file);
  const r=runtime(dataDir,session);try{await assert.rejects(r.runOnce(),/禁止自动补款/);}finally{await r.stop();}
  await assert.rejects(createConfirmedPaperSession({dataDir,id:ID}),{code:'ENOENT'});
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(dataDir,LEGACY_PAPER_FILE),'utf8'),old);
  await fs.writeFile(path.join(dataDir,PAPER_SESSION_FILE),'{broken');await assert.rejects(loadPaperSession(dataDir));
});
test('setup requires paused flat unlocked legacy account and never overwrites an existing experiment',async t=>{
  const {dataDir,legacy}=await fixture(t),lock=path.join(dataDir,`${LEGACY_PAPER_FILE}.lock`);
  await fs.writeFile(lock,'existing-lock');await assert.rejects(createConfirmedPaperSession({dataDir,id:ID}),{code:'EEXIST'});
  assert.equal(await fs.readFile(lock,'utf8'),'existing-lock');await fs.unlink(lock);
  legacy.enabled=true;await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify(legacy));
  await assert.rejects(createConfirmedPaperSession({dataDir,id:ID}),/已暂停且无持仓/);
  legacy.enabled=false;await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify(legacy));
  const file=path.join(dataDir,`yesp-atm-${ID}.json`);await fs.writeFile(file,'existing-ledger');
  await assert.rejects(createConfirmedPaperSession({dataDir,id:ID}),{code:'EEXIST'});
  assert.equal(await fs.readFile(file,'utf8'),'existing-ledger');assert.equal(await loadPaperSession(dataDir),null);
  await assert.rejects(fs.stat(lock),{code:'ENOENT'});
});
test('session identity prohibits path traversal, live mode or strategy downgrade',async t=>{
  const {dataDir}=await fixture(t),session=await createConfirmedPaperSession({dataDir,id:ID,nowMs:NOW});
  for(const changes of [{id:'../../escape'},{mode:'live'},{initialCash:1000},{strategyVersion:'paper_diagnostic_entry_v1'}])assert.throws(()=>validatePaperSession({...session,...changes}));
  assert.throws(()=>runtime(dataDir,session,{confirmedMode:false}),/V2 策略/);
  assert.throws(()=>runtime(dataDir,session,{chains:['robinhood']}),/链配置/);
});
