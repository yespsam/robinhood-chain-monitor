import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadonlyMarketClient } from '../src/gmgn-readonly-market.js';
import { createReadonlyProcessRunner } from '../src/gmgn-readonly-process.js';
import { createGmgnAccountGate } from '../src/gmgn-account-gate.js';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ca=n=>'0x'+String(n).repeat(40);
async function until(check){for(let i=0;i<500;i++){if(await check())return;await delay(10);}assert.fail('fixture timeout');}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'readonly-process-test-'));
  const cli=path.join(dir,'cli');
  const source=await fs.readFile(new URL('./fixtures/readonly-transport-cli.mjs',import.meta.url),'utf8');
  await fs.writeFile(cli,'#!/usr/bin/env node\n'+source,{mode:0o700});
  await fs.writeFile(path.join(dir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  const client=createReadonlyMarketClient({dataDir:dir,cliPath:cli,isolated:true,quoteTtlMs:0,ttlMs:0});
  t.after(async()=>{await client.close();await fs.rm(dir,{recursive:true,force:true});});
  const calls=async()=> (await fs.readFile(path.join(dir,'calls.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
  const slot=async()=>JSON.parse(await fs.readFile(path.join(dir,'gmgn-account-slot.json'),'utf8').catch(()=>'{"active":[]}'));
  return {dir,cli,client,calls,slot};
}

test('isolated transport dispatches and releases its lease while the parent event loop is blocked',async t=>{
  const {client,calls,slot}=await fixture(t);
  const job=client.quote({chain:'bsc',address:ca(1)});
  await until(async()=>(await calls()).some(x=>x.type==='start'));
  const blockedAt=Date.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1400);
  // The old same-event-loop adapter could not release its lease in this interval.
  assert.deepEqual((await slot()).active,[]);
  const result=await job,rows=await calls();
  assert.equal(result.status,'ok');assert.equal(result.price,1.2);
  assert.ok(Date.parse(result.observedAt)<=blockedAt);
  assert.ok(rows.find(x=>x.type==='end').at<Date.parse(result.receivedAt)-500);
  const d=client.diagnostics();assert.notEqual(d.transport.pid,process.pid);
  assert.ok(d.recent.at(-1).requestMs<1300);assert.ok(d.transport.parentDeliveryMs.at(-1)>500);
  assert.equal(rows.filter(x=>x.type==='config').length,1);
});

test('child binds latest-closed candles at actual dispatch and parent retains the exact window',async t=>{
  const {client,calls}=await fixture(t),to=Math.floor(Date.now()/60000)*60-600;
  const result=await client.kline({chain:'bsc',address:ca(2),from:to-1800,to,latestClosed:true,purpose:'candidate'});
  assert.equal(result.status,'ok');
  const args=(await calls()).find(x=>x.type==='start').args;
  assert.equal(result.to,Math.floor(Date.parse(result.requestedAt)/60000)*60);
  assert.equal(Number(args[args.indexOf('--to')+1]),result.to);
  assert.equal(Number(args[args.indexOf('--from')+1]),result.from);
  assert.equal(result.to-result.from,1800);assert.ok(result.to>to);
});

test('isolated request uses the same global capacity and leaves a seat for exits',async t=>{
  const {dir,client,slot}=await fixture(t),gate=createGmgnAccountGate(dir),releases=[];
  const hold=()=>new Promise(resolve=>releases.push(resolve));
  const held=[gate(hold,undefined,{priority:0}),gate(hold,undefined,{priority:1})];
  await until(()=>releases.length===2);
  const ordinary=client.quote({chain:'bsc',address:ca(1)});
  try {
    await until(async()=>(await fs.readdir(path.join(dir,'gmgn-account-queue'))).some(x=>x.endsWith('.json')));
    const exit=await client.quote({chain:'bsc',address:ca(2),purpose:'exit'});
    assert.equal(exit.status,'ok');assert.equal((await slot()).active.length,2);
  }finally{releases.forEach(resolve=>resolve());await Promise.allSettled([...held,ordinary]);}
  assert.equal((await ordinary).status,'ok');assert.deepEqual((await slot()).active,[]);
});

test('429 persists shared cooldown, no replay or renewed identity after IPC',async t=>{
  const {client,calls,slot}=await fixture(t);
  const prior=await client.quote({chain:'bsc',address:ca(1)});assert.equal(prior.status,'ok');
  const mismatch=await client.quote({chain:'bsc',address:ca(8)});
  assert.equal(mismatch.status,'unavailable');assert.equal(mismatch.reasonCode,'GMGN_IDENTITY_MISMATCH');
  const limited=await client.quote({chain:'bsc',address:ca(9)});
  assert.equal(limited.reasonCode,'GMGN_RATE_LIMITED');
  const blocked=await client.quote({chain:'bsc',address:ca(1)});
  assert.equal(blocked.status,'stale');assert.equal(blocked.reasonCode,'GMGN_RATE_LIMITED');
  assert.equal(blocked.observedAt,prior.observedAt);
  assert.equal((await calls()).filter(x=>x.type==='start').length,3);assert.deepEqual((await slot()).active,[]);
});

test('close cancels owned waiters and leaves no leases, does not stop another owner',async t=>{
  const {dir,client,slot,calls}=await fixture(t),gate=createGmgnAccountGate(dir),releases=[];
  const hold=()=>new Promise(resolve=>releases.push(resolve));
  const held=[gate(hold,undefined,{priority:0}),gate(hold,undefined,{priority:1})];
  await until(()=>releases.length===2);
  const jobs=[1,2,3,4,5,6].map(n=>client.quote({chain:'bsc',address:ca(n)}));
  try{
    await until(async()=>(await fs.readdir(path.join(dir,'gmgn-account-queue'))).some(x=>x.endsWith('.json')));
    await client.close();assert.ok((await Promise.all(jobs)).every(x=>x.status==='unavailable'));
    assert.equal((await slot()).active.length,2);
    assert.equal((await calls()).filter(x=>x.type==='start').length,0,'local config checks cannot dispatch a business request without a lease');
    assert.deepEqual(await fs.readdir(path.join(dir,'gmgn-account-queue')),[]);
  }finally{releases.forEach(resolve=>resolve());await Promise.allSettled(held);}
});

test('worker failure fails outstanding reads without silent retry; next work uses crash backoff',async t=>{
  const {client,calls}=await fixture(t);
  const job=client.quote({chain:'bsc',address:ca(1)});
  await until(async()=>(await calls()).some(x=>x.type==='start'));
  process.kill(client.diagnostics().transport.pid,'SIGKILL');
  assert.equal((await job).reasonCode,'GMGN_STOPPED');
  assert.equal((await client.quote({chain:'bsc',address:ca(2)})).reasonCode,'GMGN_STOPPED');
  await delay(500);assert.equal((await calls()).filter(x=>x.type==='start').length,1);
  assert.equal((await calls()).filter(x=>x.type==='end').length,0,'crashed worker does not leave an orphan CLI running');
});

test('IPC rejects unsupported execution routes and exposes no raw CLI diagnostics',async t=>{
  const {dir,cli,calls}=await fixture(t);
  const run=createReadonlyProcessRunner({dataDir:dir,cliPath:cli,timeoutMs:1000});t.after(()=>run.close());
  await assert.rejects(run(['swap','buy','--chain','bsc','--raw']),{code:'GMGN_STATE_INVALID'});
  assert.equal((await calls()).length,0);assert.ok(!JSON.stringify(run.diagnostics()).includes(cli));
});

test('slow local preflight holds no business seat, still runs once and binds the quote at dispatch',async t=>{
  const {dir,client,calls,slot}=await fixture(t);
  await fs.writeFile(path.join(dir,'config-behavior.json'),JSON.stringify({delayMs:800}));
  const job=client.quote({chain:'bsc',address:ca(1)});
  await until(async()=>(await calls()).some(x=>x.type==='config'));
  assert.deepEqual((await slot()).active,[],'local CLI startup must not take an upstream lease');
  const result=await job,rows=await calls(),record=client.diagnostics().recent.at(-1);
  assert.equal(result.status,'ok');assert.equal(rows.filter(x=>x.type==='config').length,1);
  assert.ok(Date.parse(result.observedAt)-rows.find(x=>x.type==='config').at>=750);
  assert.equal(record.preflightPlacement,'before_account_gate_v1');assert.ok(record.preflightMs>=750);
  assert.ok(Number.isFinite(record.accountWaitMs));assert.deepEqual((await slot()).active,[]);
});

test('config failure cannot acquire a lease or issue a business command, and does not expose stderr',async t=>{
  const {dir,client,calls,slot}=await fixture(t);
  await fs.writeFile(path.join(dir,'config-behavior.json'),JSON.stringify({fail:true}));
  const result=await client.quote({chain:'bsc',address:ca(1)});
  assert.equal(result.status,'unavailable');assert.deepEqual((await slot()).active,[]);
  assert.equal(result.reasonCode,'GMGN_CONFIG_FAILED');
  assert.equal((await calls()).filter(x=>x.type==='config').length,1);
  assert.equal((await calls()).filter(x=>x.type==='start').length,0);
  assert.equal(client.diagnostics().recent.at(-1).accountWaitMs,null);
  assert.doesNotMatch(JSON.stringify({result,diagnostics:client.diagnostics()}),/PRIVATE_CONFIG_DIAGNOSTIC/);
});

test('network failure crosses IPC as a safe category without diagnostics or automatic replay',async t=>{
  const {client,calls,slot}=await fixture(t);
  const result=await client.quote({chain:'bsc',address:ca(6)});
  assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,'GMGN_NETWORK_FAILED');
  assert.equal((await calls()).filter(x=>x.type==='start').length,1);assert.deepEqual((await slot()).active,[]);
  assert.doesNotMatch(JSON.stringify({result,diagnostics:client.diagnostics()}),/PRIVATE_NETWORK_DIAGNOSTIC/);
});

test('shared cooldown appearing after preflight but before lease admission still prevents dispatch',async t=>{
  const {dir,client,calls,slot}=await fixture(t),gate=createGmgnAccountGate(dir),releases=[];
  const hold=()=>new Promise(resolve=>releases.push(resolve));
  const held=[gate(hold,undefined,{priority:0}),gate(hold,undefined,{priority:1})];
  await until(()=>releases.length===2);
  const job=client.quote({chain:'bsc',address:ca(1)});
  try {
    await until(async()=>(await fs.readdir(path.join(dir,'gmgn-account-queue'))).some(x=>x.endsWith('.json')));
    assert.equal((await calls()).filter(x=>x.type==='config').length,1);
    await fs.writeFile(path.join(dir,'gmgn-flow-rate-limit.json'),JSON.stringify({version:1,rateLimitedUntil:new Date(Date.now()+300000).toISOString()}));
  }finally{releases.forEach(resolve=>resolve());await Promise.allSettled(held);}
  assert.equal((await job).reasonCode,'GMGN_RATE_LIMITED');
  assert.equal((await calls()).filter(x=>x.type==='start').length,0);
  assert.deepEqual((await slot()).active,[]);
});

test('429 from local preflight is persisted without occupying an upstream seat or retrying',async t=>{
  const {dir,client,calls,slot}=await fixture(t);
  await fs.writeFile(path.join(dir,'config-behavior.json'),JSON.stringify({rateLimit:true}));
  assert.equal((await client.quote({chain:'bsc',address:ca(1)})).reasonCode,'GMGN_RATE_LIMITED');
  assert.equal((await client.quote({chain:'bsc',address:ca(2)})).reasonCode,'GMGN_RATE_LIMITED');
  assert.equal((await calls()).filter(x=>x.type==='config').length,1);
  assert.equal((await calls()).filter(x=>x.type==='start').length,0);
  assert.deepEqual((await slot()).active,[]);
  assert.ok(Date.parse(JSON.parse(await fs.readFile(path.join(dir,'gmgn-flow-rate-limit.json'),'utf8')).rateLimitedUntil)>Date.now());
});
