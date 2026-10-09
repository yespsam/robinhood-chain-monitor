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
test('slow ticket filesystem work cannot consume the serial request pacing interval',async t=>{
 const dir=await directory(t),module=new URL('../src/gmgn-account-gate.js',import.meta.url).href;
 const script=`import fs from 'node:fs/promises';import {createGmgnAccountGate} from ${JSON.stringify(module)};
 const original=fs.unlink;let slow=true;fs.unlink=async(...args)=>{if(slow&&String(args[0]).includes('gmgn-account-queue')){slow=false;await new Promise(r=>setTimeout(r,180));}return original(...args);};
 const gate=createGmgnAccountGate(${JSON.stringify(dir)},{intervalMs:100});
 const first=await gate(async()=>Date.now()),second=await gate(async()=>Date.now());console.log(second-first);`;
 const result=await exec(process.execPath,['--input-type=module','-e',script]);
 assert.ok(Number(result.stdout.trim())>=95,result.stdout);
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
test('bounded aging never overtakes exits; old normal work and cancellation cleanup still progress',async t=>{
 const dir=await directory(t); let release, entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const gate=createGmgnAccountGate(dir,{intervalMs:1,agingMs:50});
 const active=gate(async()=>{entered();await new Promise(resolve=>{release=resolve;});}); await ready;
 const order=[], old=gate(async()=>order.push('old-research')); await waitTickets(dir,1);
 await new Promise(resolve=>setTimeout(resolve,180));
 const fresh=gate(async()=>order.push('new-exit'),undefined,{priority:2}); await waitTickets(dir,2);
 const candidate=gate(async()=>order.push('candidate'),undefined,{priority:1}); await waitTickets(dir,3);
 const token=randomUUID();await fs.writeFile(path.join(dir,'gmgn-account-queue',`${token}.json`),JSON.stringify({version:1,token,pid:2147483647,queuedAt:Date.now()-500,expiresAt:Date.now()+10000,priority:2}));
 release();await Promise.all([active,old,fresh,candidate]);assert.deepEqual(order,['new-exit','old-research','candidate']);
 const controller=new AbortController();
 const waiting=createGmgnAccountGate(dir,{intervalMs:1000})(async()=>assert.fail('cancelled work'),controller.signal);
 const rejected=assert.rejects(waiting,{code:'GMGN_STOPPED'});await waitTickets(dir,1);controller.abort();await rejected;
 assert.deepEqual(await fs.readdir(path.join(dir,'gmgn-account-queue')),[]);
 await assert.rejects(fs.stat(path.join(dir,'gmgn-account.lock')),{code:'ENOENT'});
});

test('ticket reads are bounded-parallel while identity validation and expired-ticket cleanup remain strict',async t=>{
 const dir=await directory(t),module=new URL('../src/gmgn-account-gate.js',import.meta.url).href;
 const script=`import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {createGmgnAccountGate} from ${JSON.stringify(module)};
 const dir=${JSON.stringify(dir)},q=dir+'/gmgn-account-queue';await fs.mkdir(q);
 for(let i=0;i<20;i++){const token=randomUUID();await fs.writeFile(q+'/'+token+'.json',JSON.stringify({version:1,token,pid:2147483647,queuedAt:Date.now()-500,expiresAt:Date.now()+10000,priority:0}));}
 const original=fs.readFile;let active=0,maximum=0;fs.readFile=async(...args)=>{
 if(!String(args[0]).includes('gmgn-account-queue'))return original(...args);
 active++;maximum=Math.max(maximum,active);try{await new Promise(r=>setTimeout(r,10));return await original(...args);}finally{active--;}};
 let metrics;const result=await createGmgnAccountGate(dir,{intervalMs:1})(async()=>42,undefined,{onAdmitted:value=>metrics=value});
 console.log(JSON.stringify({result,maximum,remaining:await fs.readdir(q),metrics}));`;
 const result=JSON.parse((await exec(process.execPath,['--input-type=module','-e',script])).stdout);
 assert.equal(result.result,42);assert.ok(result.maximum>1&&result.maximum<=16);
 assert.deepEqual(result.remaining,[]);assert.equal(result.metrics.queueHighWater,21);
});

test('Plus waiters do not enumerate ticket files when all normal seats are occupied',async t=>{
 const dir=await directory(t),module=new URL('../src/gmgn-account-gate.js',import.meta.url).href;
 const script=`import fs from 'node:fs/promises';import {createGmgnAccountGate} from ${JSON.stringify(module)};
 const dir=${JSON.stringify(dir)};await fs.writeFile(dir+'/gmgn-readonly-plan.json',JSON.stringify({version:1,plan:'plus'}));
 const gate=createGmgnAccountGate(dir),releases=[];const hold=()=>new Promise(resolve=>releases.push(resolve));
 const first=gate(hold,undefined,{priority:1}),second=gate(hold,undefined,{priority:1});
 while(releases.length<2)await new Promise(r=>setTimeout(r,10));
 const original=fs.readdir;let scans=0;fs.readdir=async(...args)=>{if(String(args[0]).endsWith('gmgn-account-queue'))scans++;return original(...args);};
 const third=gate(async()=>3,undefined,{priority:1});await new Promise(r=>setTimeout(r,220));const blockedScans=scans;
 releases.forEach(resolve=>resolve());await Promise.all([first,second,third]);console.log(blockedScans);`;
 assert.equal(Number((await exec(process.execPath,['--input-type=module','-e',script])).stdout),0);
});
