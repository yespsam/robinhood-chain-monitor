import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGmgnAccountGate} from '../src/gmgn-account-gate.js';

async function tempDataDir(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gmgn-lease-recovery-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  return dir;
}

function leases(count,{pid=process.pid,priority=0,admittedAt}={}) {
  return Array.from({length:count},()=>({token:randomUUID(),pid,priority,...(admittedAt===undefined?{}:{admittedAt})}));
}

test('reclaims legacy live-PID leases only after their shared admission timestamp expires',async t=>{
  const dir=await tempDataDir(t),startedAt=Date.now()-2*60_000;
  await fs.writeFile(path.join(dir,'gmgn-account-slot.json'),JSON.stringify({version:1,startedAt,active:leases(3)}));
  let calls=0;
  const result=await createGmgnAccountGate(dir)(async()=>++calls,undefined,{priority:2});
  assert.equal(result,1);
  assert.equal(calls,1);
  const state=JSON.parse(await fs.readFile(path.join(dir,'gmgn-account-slot.json'),'utf8'));
  assert.deepEqual(state.active,[]);
  assert.deepEqual(await fs.readdir(path.join(dir,'gmgn-account-queue')),[]);
  await assert.rejects(fs.stat(path.join(dir,'gmgn-account.lock')),{code:'ENOENT'});
});

test('does not reclaim fresh live-PID leases, including the reserved critical slot',async t=>{
  const dir=await tempDataDir(t),startedAt=Date.now();
  await fs.writeFile(path.join(dir,'gmgn-account-slot.json'),JSON.stringify({version:1,startedAt,active:leases(3,{admittedAt:startedAt})}));
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),180);
  let called=false;
  try {
    await assert.rejects(createGmgnAccountGate(dir)(async()=>{called=true;},controller.signal,{priority:2}),{code:'GMGN_STOPPED'});
  } finally {clearTimeout(timeout);}
  assert.equal(called,false);
  const state=JSON.parse(await fs.readFile(path.join(dir,'gmgn-account-slot.json'),'utf8'));
  assert.equal(state.active.length,3);
  assert.deepEqual(await fs.readdir(path.join(dir,'gmgn-account-queue')),[]);
});

test('new active leases persist an individual admission timestamp',async t=>{
  const dir=await tempDataDir(t);
  await createGmgnAccountGate(dir)(async()=>{
    const state=JSON.parse(await fs.readFile(path.join(dir,'gmgn-account-slot.json'),'utf8'));
    assert.equal(state.active.length,1);
    assert.ok(Number.isFinite(state.active[0].admittedAt));
    assert.ok(Math.abs(Date.now()-state.active[0].admittedAt)<1000);
  });
});
