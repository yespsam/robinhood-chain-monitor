import { fork } from 'node:child_process';
import {GMGN_READ_ERROR_CODES} from './gmgn-read-error.js';

const fail = code => Object.assign(new Error(code), {code});
const SAFE_CODES = new Set(['GMGN_STOPPED','GMGN_REQUEST_BUSY','GMGN_QUEUE_EXPIRED','GMGN_STATE_INVALID',
  'GMGN_RATE_LIMITED','GMGN_CLI_TIMEOUT','GMGN_UNAVAILABLE',...GMGN_READ_ERROR_CODES]);

// One lazy, supervised transport process per client. Parent keeps caches,
// identity checks and the sole paper-ledger writer. Never replay failed reads.
export function createReadonlyProcessRunner({cliPath,timeoutMs,dataDir}) {
  let child, stopped=false, closing, restartAfter=0, snapshot=null, snapshotAt=null;
  let sequence=0, deliveries=[];
  const pending=new Map();
  const reference=()=>{child?.ref();child?.channel?.ref();};
  const unreference=()=>{if(!stopped&&!pending.size){child?.unref();child?.channel?.unref();}};
  function settleFailure() {
    snapshot=null;snapshotAt=null;
    for(const item of pending.values())item.reject(fail('GMGN_STOPPED'));
    pending.clear();
  }
  function start() {
    if(child)return child;
    if(stopped||Date.now()<restartAfter)throw fail('GMGN_STOPPED');
    const worker=fork(new URL('./gmgn-readonly-worker.js',import.meta.url),[],{
      stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=192'],serialization:'json',
      detached:process.platform!=='win32'});
    child=worker;
    worker.on('message',message=>{
      if(child!==worker||!message||typeof message!=='object')return;
      if(message.type==='snapshot'){snapshot=message.snapshot;snapshotAt=message.at;return;}
      if(message.type!=='result')return;
      const item=pending.get(message.id);if(!item)return;
      pending.delete(message.id);
      if(message.snapshot){snapshot=message.snapshot;snapshotAt=message.completedAt;}
      deliveries.push(Math.max(0,Date.now()-message.completedAt));deliveries=deliveries.slice(-64);
      try {
        // This is the CHILD dispatch clock, not the delayed IPC receipt clock.
        if(Number.isFinite(message.requestedAt))item.onRequestStart?.(message.requestedAt);
        if(message.ok&&typeof message.stdout==='string')item.resolve(message.stdout);
        else item.reject(fail(SAFE_CODES.has(message.code)?message.code:'GMGN_UNAVAILABLE'));
      }catch(error){item.reject(error);}
      unreference();
    });
    worker.on('error',()=>{if(child===worker)settleFailure();});
    worker.once('close',(code,signal)=>{
      // The worker owns its process group. If it crashes, its CLI child must
      // not survive after the account gate recovers the dead worker's lease.
      if((signal||code!==0)&&process.platform!=='win32'&&worker.pid){
        try{process.kill(-worker.pid,'SIGKILL');}catch{}
      }
      if(child===worker){settleFailure();child=null;restartAfter=Date.now()+5000;}
    });
    worker.send({type:'init',cliPath,timeoutMs,dataDir},error=>{if(error&&child===worker)settleFailure();});
    unreference();return worker;
  }
  const run=(args,{priority=0,onRequestStart,latestClosedDuration}={})=>{
    if(stopped)return Promise.reject(fail('GMGN_STOPPED'));
    // Includes IPC work not yet admitted by the child's bounded priority queue.
    if([...pending.values()].filter(x=>(x.priority===2)===(priority===2)).length>=(priority===2?8:30))
      return Promise.reject(fail('GMGN_REQUEST_BUSY'));
    return new Promise((resolve,reject)=>{
      let worker;try{worker=start();}catch(error){reject(error);return;}
      const id=++sequence;pending.set(id,{resolve,reject,priority,onRequestStart});reference();
      worker.send({type:'read',id,args,priority,latestClosedDuration},error=>{
        if(!error)return;const item=pending.get(id);if(!item)return;
        pending.delete(id);item.reject(fail('GMGN_STOPPED'));unreference();
      });
    });
  };
  run.diagnostics=()=>({...(snapshot||{version:'bounded_readonly_queue_v2',pending:{count:0,oldestWaitMs:0,byKind:{}},
    active:{count:0,oldestWaitMs:0,byKind:{}},limits:null,recent:[]}),transport:{mode:'isolated_readonly_process',pid:child?.pid||null,
    state:stopped?'stopped':child?'running':'idle',snapshotAt:snapshotAt?new Date(snapshotAt).toISOString():null,
    inFlight:pending.size,parentDeliveryMs:deliveries.slice(-16)}});
  run.close=()=>{
    if(closing)return closing;
    stopped=true;
    if(!child)return Promise.resolve();
    const worker=child;reference();
    closing=new Promise(resolve=>{worker.once('close',resolve);worker.send({type:'close'},error=>{if(error&&worker.connected)worker.disconnect();});});
    return closing;
  };
  return run;
}
