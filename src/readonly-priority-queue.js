// Local pending work only: never preempts an active CLI or bypasses the shared
// account gate/rate cooldown. Priority 2 is for exits / admitted confirmation;
// aging prevents monitoring from starving forever.
export function enqueueReadonly(scheduler, work, { priority = 0, now = Date.now, concurrency = 1, normalConcurrency = concurrency } = {}) {
  if (![priority, concurrency, normalConcurrency].every(Number.isInteger) || priority<0 || priority>2
      || concurrency<1 || concurrency>3 || normalConcurrency<1 || normalConcurrency>concurrency) return Promise.reject(new Error('invalid readonly scheduling policy'));
  scheduler.pending ||= [];
  scheduler.active ||= new Set();
  // A plan change applies to ALREADY queued work too. Otherwise a Free job
  // waiting for zero active tasks can starve forever behind new Plus jobs.
  scheduler.readonlyLimits={concurrency,normalConcurrency};
  const promise = new Promise((resolve, reject) => {
    scheduler.pending.push({ work, resolve, reject, priority, queuedAt: now() });
  });
  if (!scheduler.pump) {
    scheduler.pump = () => {
      while (scheduler.pending.length) {
          const score = item => item.priority + Math.floor(Math.max(0, now() - item.queuedAt) / 30_000);
          scheduler.pending.sort((a, b) => score(b) - score(a));
          const limits=scheduler.readonlyLimits;
          const index=scheduler.pending.findIndex(item=>scheduler.active.size<limits.concurrency
            && (item.priority===2 || [...scheduler.active].filter(job=>job.priority!==2).length<limits.normalConcurrency));
          if(index<0)break;
          const [item]=scheduler.pending.splice(index,1);scheduler.active.add(item);
          Promise.resolve().then(item.work).then(item.resolve,item.reject).finally(()=>{
            scheduler.active.delete(item);scheduler.pump();
          });
      }
      scheduler.draining=scheduler.active.size>0;
    };
  }
  queueMicrotask(scheduler.pump);
  return promise;
}
