// Local pending work only: never preempts an active CLI or bypasses the shared
// account gate/rate cooldown. Priority 2 is for exits / admitted confirmation;
// bounded aging shares normal capacity without overtaking critical work.
import { compareReadonlyWork, canAdmitReadonly } from './readonly-admission-policy.js';
export function readonlyQueueSnapshot(scheduler,nowMs=Date.now()) {
  const summarize=items=>({count:items.length,oldestWaitMs:items.length?Math.max(...items.map(x=>Math.max(0,nowMs-x.queuedAt))):0,
    byKind:items.reduce((result,item)=>({...result,[item.kind||'other']:(result[item.kind||'other']||0)+1}),{})});
  return {version:'bounded_readonly_queue_v2',pending:summarize(scheduler.pending||[]),
    active:summarize([...(scheduler.active||[])]),limits:scheduler.readonlyLimits||null};
}
export function enqueueReadonly(scheduler, work, { priority = 0, now = Date.now, concurrency = 1, normalConcurrency = concurrency,
  maxPending=Infinity,maxWaitMs=Infinity,kind='other',onStart,admissionOnly=false } = {}) {
  if (![priority, concurrency, normalConcurrency].every(Number.isInteger) || priority<0 || priority>2
      ||typeof admissionOnly!=='boolean'||concurrency<1 || concurrency>(admissionOnly?6:3) || normalConcurrency<1 || normalConcurrency>concurrency
      ||!(maxPending===Infinity||Number.isInteger(maxPending)&&maxPending>0)
      ||!(maxWaitMs===Infinity||Number.isFinite(maxWaitMs)&&maxWaitMs>0)) return Promise.reject(new Error('invalid readonly scheduling policy'));
  scheduler.pending ||= [];
  scheduler.active ||= new Set();
  // A plan change applies to ALREADY queued work too. Otherwise a Free job
  // waiting for zero active tasks can starve forever behind new Plus jobs.
  scheduler.readonlyLimits={concurrency,normalConcurrency,admissionOnly};
  // Critical reads have their own pending allowance: research cannot fill it.
  if(scheduler.pending.filter(item=>(item.priority===2)===(priority===2)).length>=maxPending)
    return Promise.reject(Object.assign(new Error('GMGN_REQUEST_BUSY'),{code:'GMGN_REQUEST_BUSY'}));
  const promise = new Promise((resolve, reject) => {
    const item={ work, resolve, reject, priority, queuedAt: now(),maxWaitMs,kind,onStart };
    scheduler.pending.push(item);
    if(Number.isFinite(maxWaitMs))item.timer=setTimeout(()=>{
      const index=scheduler.pending.indexOf(item);
      if(index<0)return;
      scheduler.pending.splice(index,1);
      reject(Object.assign(new Error('GMGN_QUEUE_EXPIRED'),{code:'GMGN_QUEUE_EXPIRED'}));
      scheduler.pump();
    },maxWaitMs);
  });
  if (!scheduler.pump) {
    scheduler.pump = () => {
      while (scheduler.pending.length) {
          const at=now();
          // Also check at dispatch: a busy event loop can delay timeout timers.
          for(const item of [...scheduler.pending])if(at-item.queuedAt>=item.maxWaitMs){
            scheduler.pending.splice(scheduler.pending.indexOf(item),1);clearTimeout(item.timer);
            item.reject(Object.assign(new Error('GMGN_QUEUE_EXPIRED'),{code:'GMGN_QUEUE_EXPIRED'}));
          }
          scheduler.pending.sort((a, b) => compareReadonlyWork(a,b,at,30_000));
          const limits=scheduler.readonlyLimits;
          const index=scheduler.pending.findIndex(item=>canAdmitReadonly(item,[...scheduler.active],limits));
          if(index<0)break;
          const [item]=scheduler.pending.splice(index,1);clearTimeout(item.timer);scheduler.active.add(item);
          Promise.resolve().then(()=>{item.onStart?.();return item.work();}).then(item.resolve,item.reject).finally(()=>{
            scheduler.active.delete(item);scheduler.pump();
          });
      }
      scheduler.draining=scheduler.active.size>0;
    };
  }
  queueMicrotask(scheduler.pump);
  return promise;
}
