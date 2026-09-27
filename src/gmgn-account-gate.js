import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { gmgnReadonlyPolicy } from './gmgn-readonly-pacing.js';

const failure = code => Object.assign(new Error(code), {code});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch(e) { return e.code !== 'ESRCH'; } };

// Shared admission across monitor/dashboard processes. Free serializes entire
// requests; explicit Plus permits bounded leases with one critical slot for
// main exits and already-admitted entry confirmations, not broad discovery.
// The separate cooldown-write gate uses this same mutex protocol, always serial.
// No credentials are stored here; existing request priorities are preserved.
export function createGmgnAccountGate(dataDir, {intervalMs=null, waitMs=30_000, agingMs=5000}={}) {
  if (![...(intervalMs === null ? [] : [intervalMs]), waitMs, agingMs].every(n => Number.isFinite(n) && n > 0)) throw failure('GMGN_INVALID_ARGUMENT');
  const lock=path.join(dataDir,'gmgn-account.lock'), slot=path.join(dataDir,'gmgn-account-slot.json');
  const queue=path.join(dataDir,'gmgn-account-queue');
  async function recoverDeadOwner() {
    const recovery=`${lock}.recovery`;
    try { await fs.mkdir(recovery,{mode:0o700}); } catch(e) { if(e.code==='EEXIST')return; throw e; }
    try {
      let raw,stat;
      try { [raw,stat]=await Promise.all([fs.readFile(lock,'utf8'),fs.stat(lock)]); } catch(e) {if(e.code==='ENOENT')return;throw e;}
      let owner; try {owner=JSON.parse(raw);} catch {}
      const dead=Number.isSafeInteger(owner?.pid)&&owner.pid>0&&!alive(owner.pid);
      if(dead||(!raw&&Date.now()-stat.mtimeMs>60_000))await fs.unlink(lock);
    } finally {await fs.rmdir(recovery);}
  }
  return async function gate(work, signal, {priority=0}={}) {
    if (![0,1,2].includes(priority)) throw failure('GMGN_INVALID_ARGUMENT');
    const token=randomUUID(),started=Date.now();let handle,owned=false,temp,leased=false;
    const ticket=path.join(queue,`${token}.json`);
    const active=()=>{if(signal?.aborted)throw failure('GMGN_STOPPED');};
    async function unlock() {
      await handle?.close();handle=null;
      if(!owned)return;
      const owner=await fs.readFile(lock,'utf8').then(JSON.parse).catch(()=>null);
      if(owner?.token===token)await fs.unlink(lock);
      owned=false;
    }
    async function readSlot() {
      try {
        const stat=await fs.stat(slot);if(!stat.isFile()||stat.size>16384)throw failure('GMGN_STATE_INVALID');
        const state=JSON.parse(await fs.readFile(slot,'utf8'));
        if(state?.version!==1||!Number.isFinite(state.startedAt)||state.startedAt>Date.now()+60_000
          || (state.active !== undefined && (!Array.isArray(state.active) || state.active.length>16)))throw failure('GMGN_STATE_INVALID');
        const entries=state.active || [];
        for(const item of entries)if(!/^[0-9a-f-]{36}$/.test(item?.token)||!Number.isSafeInteger(item.pid)||item.pid<=0||![0,1,2].includes(item.priority))throw failure('GMGN_STATE_INVALID');
        return {...state,active:entries.filter(item=>alive(item.pid))};
      } catch(e) {if(e.code==='ENOENT')return {version:1,startedAt:0,active:[]};throw e;}
    }
    async function writeSlot(state) {
      temp=`${slot}.${token}.tmp`;
      await fs.writeFile(temp,JSON.stringify(state),{mode:0o600});await fs.rename(temp,slot);temp=null;
    }
    try {
      active();
      await fs.mkdir(queue,{recursive:true,mode:0o700});
      temp=`${ticket}.tmp`;
      await fs.writeFile(temp,JSON.stringify({version:1,token,pid:process.pid,queuedAt:started,expiresAt:started+waitMs,priority}),{mode:0o600});
      await fs.rename(temp,ticket);temp=null;
      while(true) {
        active();
        if(Date.now()-started>=waitMs)throw failure('GMGN_REQUEST_BUSY');
        try {handle=await fs.open(lock,'wx',0o600);owned=true;} catch(e) {
          if(e.code!=='EEXIST')throw e;
          await recoverDeadOwner();await delay(50);continue;
        }
        await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.close();handle=null;
        if(JSON.parse(await fs.readFile(lock,'utf8')).token!==token)throw failure('GMGN_REQUEST_LOCK_LOST');
        const state=await readSlot(),last=state.startedAt;
        const policy=intervalMs===null ? gmgnReadonlyPolicy(dataDir) : {intervalMs,concurrency:1,normalConcurrency:1};
        const at=Date.now(),waiting=[];
        const names=(await fs.readdir(queue)).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name));
        if(names.length>1000)throw failure('GMGN_STATE_INVALID');
        for(const name of names) {
          const file=path.join(queue,name);let item;
          try {
            const stat=await fs.stat(file);if(!stat.isFile()||stat.size>4096)throw failure('GMGN_STATE_INVALID');
            item=JSON.parse(await fs.readFile(file,'utf8'));
          } catch(e) {if(e.code==='ENOENT')continue;throw failure('GMGN_STATE_INVALID');}
          if(item?.version!==1||`${item.token}.json`!==name||!Number.isSafeInteger(item.pid)||item.pid<=0
            ||!Number.isFinite(item.queuedAt)||!Number.isFinite(item.expiresAt)||item.expiresAt<=item.queuedAt
            ||item.queuedAt>at+1000||![0,1,2].includes(item.priority))throw failure('GMGN_STATE_INVALID');
          if(item.expiresAt<=at||!alive(item.pid)) {await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});continue;}
          if(state.active.length<policy.concurrency && (item.priority===2
            || state.active.filter(entry=>entry.priority!==2).length<policy.normalConcurrency))waiting.push(item);
        }
        const score=item=>item.priority+Math.floor(Math.max(0,at-item.queuedAt)/agingMs);
        waiting.sort((a,b)=>score(b)-score(a)||a.queuedAt-b.queuedAt||a.token.localeCompare(b.token));
        if(at>=last+policy.intervalMs&&waiting[0]?.token===token) {
          active();
          await writeSlot({version:1,startedAt:Date.now(),active:[...state.active,{token,pid:process.pid,priority}]});leased=true;
          await fs.unlink(ticket);
          // The lock protects admission/state only under Plus. The lease keeps
          // network requests bounded while an exit may use the reserved slot.
          // Free keeps the old lock-through-work protocol for rolling upgrades.
          if(policy.concurrency>1)await unlock();
          return await work();
        }
        // Do not reserve the entire pacing interval: a later exit request must
        // still be able to take the next slot. The active request is never cut.
        await unlock();await delay(50);
      }
    } finally {
      try {
        if(leased) {
          const cleanupAt=Date.now();
          while(!owned) {
            if(Date.now()-cleanupAt>waitMs)throw failure('GMGN_REQUEST_LOCK_LOST');
            try {handle=await fs.open(lock,'wx',0o600);owned=true;await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.close();handle=null;}
            catch(e){if(e.code!=='EEXIST')throw e;await recoverDeadOwner();await delay(50);}
          }
          const state=await readSlot();await writeSlot({...state,active:state.active.filter(item=>item.token!==token)});
        }
      } finally {
        await unlock();
        if(temp)await fs.unlink(temp).catch(()=>{});
        await fs.unlink(ticket).catch(e=>{if(e.code!=='ENOENT')throw e;});
      }
    }
  };
}
