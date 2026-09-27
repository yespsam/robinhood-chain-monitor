import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createGmgnAccountGate} from '../src/gmgn-account-gate.js';
import { GMGN_READONLY_INTERVAL_MS } from '../src/gmgn-readonly-pacing.js';
const exec=promisify(execFile);
async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gmgn-account-gate-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('production default pacing keeps margin below the lowest documented public read-only rate', async t => {
 const dir = await directory(t), gate = createGmgnAccountGate(dir);
 assert.equal(GMGN_READONLY_INTERVAL_MS, 1200);
 assert.ok(5 / (GMGN_READONLY_INTERVAL_MS / 1000) < 5);
 const first = await gate(async () => Date.now()), second = await gate(async () => Date.now());
 assert.ok(second - first >= GMGN_READONLY_INTERVAL_MS - 5);
});
test('independent processes serialize requests and retain shared minimum spacing',async t=>{
 const dir=await directory(t),module=new URL('../src/gmgn-account-gate.js',import.meta.url).href;
 const script=`import {createGmgnAccountGate} from ${JSON.stringify(module)};const gate=createGmgnAccountGate(${JSON.stringify(dir)},{intervalMs:100});await gate(async()=>{console.log(Date.now());await new Promise(r=>setTimeout(r,20));});`;
 const results=await Promise.all([exec(process.execPath,['--input-type=module','-e',script]),exec(process.execPath,['--input-type=module','-e',script])]);
 const times=results.map(r=>Number(r.stdout.trim())).sort();assert.ok(times[1]-times[0]>=95);
 await assert.rejects(fs.stat(path.join(dir,'gmgn-account.lock')),{code:'ENOENT'});
});
test('task errors release lock, corrupt pacing blocks requests, and aborted work never runs',async t=>{
 const dir=await directory(t),gate=createGmgnAccountGate(dir,{intervalMs:1});
 await assert.rejects(gate(async()=>{throw new Error('fixture');}),/fixture/);
 assert.equal(await gate(async()=>42),42);
 await fs.writeFile(path.join(dir,'gmgn-account-slot.json'),'null');
 await assert.rejects(gate(async()=>assert.fail('must not request')));
 const controller=new AbortController();controller.abort();await assert.rejects(gate(async()=>assert.fail(),controller.signal),/STOPPED/);
});
test('dead process lock is recovered under a separate recovery mutex',async t=>{
 const dir=await directory(t);await fs.writeFile(path.join(dir,'gmgn-account.lock'),JSON.stringify({pid:2147483647,token:'dead'}));
 assert.equal(await createGmgnAccountGate(dir,{intervalMs:1})(async()=>7),7);
});

async function waitTickets(dir, count) {
 const end=Date.now()+3000;
 while(Date.now()<end) {
  const files=await fs.readdir(path.join(dir,'gmgn-account-queue')).catch(()=>[]);
  if(files.filter(name=>name.endsWith('.json')).length>=count)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('fixture tickets not registered');
}
test('a later exit in another process wins the next shared slot without interrupting active work',async t=>{
 const dir=await directory(t),module=new URL('../src/gmgn-account-gate.js',import.meta.url).href;
 let release, entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const active=createGmgnAccountGate(dir,{intervalMs:100})(async()=>{entered();await new Promise(resolve=>{release=resolve;});});
 await ready;
 const child=priority=>exec(process.execPath,['--input-type=module','-e',
  `import {createGmgnAccountGate} from ${JSON.stringify(module)};await createGmgnAccountGate(${JSON.stringify(dir)},{intervalMs:100,agingMs:10000})(async()=>console.log(Date.now()),undefined,{priority:${priority}});`]);
 const background=child(0); await waitTickets(dir,1);
 const exit=child(2); await waitTickets(dir,2);
 release(); await active;
 const [normal,urgent]=await Promise.all([background,exit]);
 assert.ok(Number(normal.stdout)-Number(urgent.stdout)>=95);
 assert.deepEqual(await fs.readdir(path.join(dir,'gmgn-account-queue')),[]);
});
test('aging prevents research starvation while obsolete tickets and cancelled tickets are removed',async t=>{
 const dir=await directory(t); let release, entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const gate=createGmgnAccountGate(dir,{intervalMs:1,agingMs:50});
 const active=gate(async()=>{entered();await new Promise(resolve=>{release=resolve;});}); await ready;
 const order=[], old=gate(async()=>order.push('old-research')); await waitTickets(dir,1);
 await new Promise(resolve=>setTimeout(resolve,180));
 const fresh=gate(async()=>order.push('new-exit'),undefined,{priority:2}); await waitTickets(dir,2);
 const token=randomUUID();await fs.writeFile(path.join(dir,'gmgn-account-queue',`${token}.json`),JSON.stringify({version:1,token,pid:2147483647,queuedAt:Date.now()-500,expiresAt:Date.now()+10000,priority:2}));
 release();await Promise.all([active,old,fresh]);assert.deepEqual(order,['old-research','new-exit']);
 const controller=new AbortController();
 const waiting=createGmgnAccountGate(dir,{intervalMs:1000})(async()=>assert.fail('cancelled work'),controller.signal);
 const rejected=assert.rejects(waiting,{code:'GMGN_STOPPED'});await waitTickets(dir,1);controller.abort();await rejected;
 assert.deepEqual(await fs.readdir(path.join(dir,'gmgn-account-queue')),[]);
 await assert.rejects(fs.stat(path.join(dir,'gmgn-account.lock')),{code:'ENOENT'});
});
