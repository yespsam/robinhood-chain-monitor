import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createGmgnAccountGate } from '../src/gmgn-account-gate.js';
import { gmgnReadonlyPolicy } from '../src/gmgn-readonly-pacing.js';
import { enqueueReadonly } from '../src/readonly-priority-queue.js';
import { createReadonlyMarketClient } from '../src/gmgn-readonly-market.js';
const exec=promisify(execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gmgn-plus-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;
}
async function enable(dir,plan='plus') { await fs.writeFile(path.join(dir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan})); }
async function until(check) {for(let i=0;i<300;i++){if(await check())return;await delay(10);}assert.fail('fixture timed out');}
const slot=async dir=>JSON.parse(await fs.readFile(path.join(dir,'gmgn-account-slot.json'),'utf8').catch(()=>'{"active":[]}'));

test('Plus is explicit, bounded below quota; absent profile stays Free and malformed profiles fail closed',async t=>{
  const dir=await fixture(t);assert.equal(gmgnReadonlyPolicy(dir).intervalMs,1200);
  await enable(dir);const policy=gmgnReadonlyPolicy(dir);
  assert.equal(policy.concurrency,3);assert.equal(policy.normalConcurrency,2);
  assert.ok(policy.chargedWeight*1000/policy.intervalMs<20);
  for(const value of ['null','{"version":1,"plan":"pro"}','{"version":1,"plan":"plus","concurrency":999}']) {
    await fs.writeFile(path.join(dir,'gmgn-readonly-plan.json'),value);
    assert.throws(()=>gmgnReadonlyPolicy(dir),{code:'GMGN_STATE_INVALID'});
  }
});

test('Plus cross-process admission overlaps slow work, preserves spacing, and reserves an exit slot',async t=>{
  const dir=await fixture(t);await enable(dir);
  const module=new URL('../src/gmgn-account-gate.js',import.meta.url).href;
  const child=priority=>exec(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs/promises';import {createGmgnAccountGate} from ${JSON.stringify(module)};
    await createGmgnAccountGate(${JSON.stringify(dir)})(async()=>{
      const start=Date.now();await new Promise(resolve=>setTimeout(resolve,1300));
      console.log(JSON.stringify({start,end:Date.now(),priority:${priority}}));
    },undefined,{priority:${priority}});`]);
  const a=child(0),b=child(1);
  await until(async()=>(await slot(dir)).active.length===2);
  const c=child(0),exit=child(2);
  const rows=(await Promise.all([a,b,c,exit])).map(result=>JSON.parse(result.stdout));
  assert.ok(rows[3].start<Math.min(rows[0].end,rows[1].end),'exit overlaps the two slow normal requests');
  assert.ok(rows[2].start>=Math.min(rows[0].end,rows[1].end),'third normal waits');
  const sorted=rows.toSorted((a,b)=>a.start-b.start);
  for(let i=1;i<sorted.length;i++)assert.ok(sorted[i].start-sorted[i-1].start>=340);
  for(const row of rows) {
    const active=rows.filter(item=>item.start<=row.start&&item.end>row.start);
    assert.ok(active.length<=3);assert.ok(active.filter(item=>item.priority!==2).length<=2);
  }
  assert.deepEqual((await slot(dir)).active,[]);
  assert.deepEqual(await fs.readdir(path.join(dir,'gmgn-account-queue')),[]);
});

test('Plus cancellation, callback failures and dead owners do not leak admission slots',async t=>{
  const dir=await fixture(t);await enable(dir);const gate=createGmgnAccountGate(dir);
  await assert.rejects(gate(async()=>{throw new Error('fixture');}),/fixture/);
  assert.deepEqual((await slot(dir)).active,[]);
  const old=await slot(dir);old.active=[{pid:2147483647,token:'11111111-1111-1111-1111-111111111111',priority:0}];
  await fs.writeFile(path.join(dir,'gmgn-account-slot.json'),JSON.stringify(old));
  const controller=new AbortController();const pending=gate(async()=>assert.fail('cancelled request'),controller.signal);
  const rejected=assert.rejects(pending,{code:'GMGN_STOPPED'});controller.abort();await rejected;
  assert.equal(await gate(async()=>42),42);assert.deepEqual((await slot(dir)).active,[]);
});

test('hot rollback to Free waits for all Plus leases and resumes serial work',async t=>{
  const dir=await fixture(t);await enable(dir);const gate=createGmgnAccountGate(dir);let release;
  const active=gate(()=>new Promise(resolve=>{release=resolve;}));
  await until(()=>!!release);await enable(dir,'free');
  let entered=false;const next=gate(async()=>{entered=true;});await delay(100);assert.equal(entered,false);
  release();await Promise.all([active,next]);assert.equal(entered,true);assert.deepEqual((await slot(dir)).active,[]);
});

test('local Plus queue also reserves an exit lane, so queued research cannot occupy all admissions',async()=>{
  const scheduler={},releases=[],calls=[];
  const enqueue=(id,priority)=>enqueueReadonly(scheduler,()=>new Promise(resolve=>{calls.push(id);releases.push(resolve);}),{priority,concurrency:3,normalConcurrency:2});
  const a=enqueue('a',0),b=enqueue('b',0);await until(()=>calls.length===2);
  const c=enqueue('c',1),exit=enqueue('exit',2);await until(()=>calls.length===3);
  assert.deepEqual(calls,['a','b','exit']);releases[0]();await until(()=>calls.length===4);
  releases.slice(1).forEach(resolve=>resolve());await Promise.all([a,b,c,exit]);
});

test('hot Plus activation upgrades pending Free jobs instead of starving old market scans',async()=>{
  const scheduler={},calls=[],releases=[];
  const work=id=>()=>new Promise(resolve=>{calls.push(id);releases.push(resolve);});
  const active=enqueueReadonly(scheduler,work('active-free'));await until(()=>calls.length===1);
  const old=enqueueReadonly(scheduler,work('old-free-scan'),{priority:1});
  const exit=enqueueReadonly(scheduler,work('new-plus-exit'),{priority:2,concurrency:3,normalConcurrency:2});
  await until(()=>calls.length===3);assert.deepEqual(calls,['active-free','new-plus-exit','old-free-scan']);
  releases.forEach(resolve=>resolve());await Promise.all([active,old,exit]);
});

test('native CLI adapter uses Plus concurrency without changing quote identity or requesting 1s candles',async t=>{
  const dir=await fixture(t);await enable(dir);
  const cli=path.join(dir,'fixture-cli');
  await fs.writeFile(cli,`#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='config')process.exit(0);
if(args[0]!=='token'||args[1]!=='info')process.exit(2);
setTimeout(()=>console.log(JSON.stringify({data:{chain:'bsc',address:args[args.indexOf('--address')+1],price:{price:'1.2'}}})),900);
`,{mode:0o700});
  const client=createReadonlyMarketClient({dataDir:dir,cliPath:cli,scheduler:{},quoteTtlMs:0});
  const first=client.quote({chain:'bsc',address:'0x1111111111111111111111111111111111111111',purpose:'learning'});
  const second=client.quote({chain:'bsc',address:'0x2222222222222222222222222222222222222222',purpose:'learning'});
  await until(async()=>(await slot(dir)).active.length===2);
  const exit=client.quote({chain:'bsc',address:'0x3333333333333333333333333333333333333333',purpose:'exit'});
  const rows=await Promise.all([first,second,exit]);assert.ok(rows.every(row=>row.status==='ok'&&row.price===1.2));
  assert.ok(Date.parse(rows[2].observedAt)<Date.parse(rows[0].receivedAt));
  assert.deepEqual((await slot(dir)).active,[]);
});

test('concurrent native 429 responses keep the longest reset and block a queued CLI',async t=>{
  const dir=await fixture(t);await enable(dir);const cli=path.join(dir,'limited-cli');
  const log=path.join(dir,'requests'),longReset=Math.floor(Date.now()/1000)+600,shortReset=longReset-400;
  await fs.writeFile(cli,`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]==='config')process.exit(0);
const address=args[args.indexOf('--address')+1];fs.appendFileSync(${JSON.stringify(log)},address+'\\n');
setTimeout(()=>console.log(JSON.stringify({code:429,error:'RATE_LIMIT_BANNED',reset_at:address.endsWith('1')?${longReset}:${shortReset}})),900);
`,{mode:0o700});
  const one=createReadonlyMarketClient({dataDir:dir,cliPath:cli,scheduler:{}});
  const two=createReadonlyMarketClient({dataDir:dir,cliPath:cli,scheduler:{}});
  const first=one.quote({chain:'bsc',address:'0x1111111111111111111111111111111111111111'});
  const second=two.quote({chain:'bsc',address:'0x2222222222222222222222222222222222222222'});
  await until(async()=>(await slot(dir)).active.length===2);
  const third=one.quote({chain:'bsc',address:'0x3333333333333333333333333333333333333333'});
  assert.ok((await Promise.all([first,second,third])).every(row=>row.status==='unavailable'));
  const state=JSON.parse(await fs.readFile(path.join(dir,'gmgn-flow-rate-limit.json'),'utf8'));
  assert.ok(Date.parse(state.rateLimitedUntil)>=longReset*1000);
  assert.equal((await fs.readFile(log,'utf8')).trim().split('\n').length,2);
  assert.deepEqual((await slot(dir)).active,[]);
});
