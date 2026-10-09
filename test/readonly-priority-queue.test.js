import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueReadonly,readonlyQueueSnapshot } from '../src/readonly-priority-queue.js';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('pending exit quotes overtake research but never interrupt an active request', async () => {
  const scheduler = {}, calls = []; let release;
  const first = enqueueReadonly(scheduler, () => new Promise(resolve => { calls.push('active'); release = resolve; }));
  await flush();
  const research = enqueueReadonly(scheduler, () => calls.push('research'));
  const candidate = enqueueReadonly(scheduler, () => calls.push('candidate'), { priority: 1 });
  const exit = enqueueReadonly(scheduler, () => calls.push('exit'), { priority: 2 });
  assert.deepEqual(calls, ['active']); release(); await Promise.all([first, research, candidate, exit]);
  assert.deepEqual(calls, ['active', 'exit', 'candidate', 'research']);
});

test('aging shares normal capacity but never overtakes an exit; failures do not block future work', async () => {
  const scheduler = {}, calls = []; let clock = 0, release;
  const first = enqueueReadonly(scheduler, () => new Promise(resolve => { release = resolve; }), { now: () => clock });
  await flush();
  const old = enqueueReadonly(scheduler, () => calls.push('old'), { now: () => clock });
  clock = 90000;
  const exit = enqueueReadonly(scheduler, () => calls.push('exit'), { priority: 2, now: () => clock });
  const candidate = enqueueReadonly(scheduler, () => calls.push('candidate'), { priority: 1, now: () => clock });
  release(); await Promise.all([first, old, exit, candidate]); assert.deepEqual(calls, ['exit', 'old', 'candidate']);
  await assert.rejects(enqueueReadonly(scheduler, () => { throw new Error('fixture'); }), /fixture/);
  await enqueueReadonly(scheduler, () => calls.push('recovered'));
  assert.equal(calls.at(-1), 'recovered');
});

test('waiting work expires even behind a stalled active request and never starts later',async()=>{
  const scheduler={},calls=[];let release;
  const active=enqueueReadonly(scheduler,()=>new Promise(resolve=>{release=resolve;}));await flush();
  const pending=enqueueReadonly(scheduler,()=>calls.push('expired'),{priority:1,maxWaitMs:20,kind:'market:kline'});
  assert.equal(readonlyQueueSnapshot(scheduler).pending.byKind['market:kline'],1);
  await assert.rejects(pending,{code:'GMGN_QUEUE_EXPIRED'});
  assert.equal(scheduler.active.size,1);assert.equal(scheduler.pending.length,0);
  release();await active;await enqueueReadonly(scheduler,()=>calls.push('new'));
  assert.deepEqual(calls,['new']);
});

test('pending cap reserves independent urgent capacity and dispatch rechecks delayed expiry timers',async()=>{
  const scheduler={},calls=[];let release,clock=0;const options={now:()=>clock,maxPending:2,maxWaitMs:1000};
  const active=enqueueReadonly(scheduler,()=>new Promise(resolve=>{release=resolve;}),options);await flush();
  const a=enqueueReadonly(scheduler,()=>calls.push('a'),{...options,priority:1});
  const b=enqueueReadonly(scheduler,()=>calls.push('b'),options);
  const expired=Promise.all([assert.rejects(a,{code:'GMGN_QUEUE_EXPIRED'}),assert.rejects(b,{code:'GMGN_QUEUE_EXPIRED'})]);
  await assert.rejects(enqueueReadonly(scheduler,()=>assert.fail(),options),{code:'GMGN_REQUEST_BUSY'});
  clock=1001;
  const urgent=enqueueReadonly(scheduler,()=>calls.push('exit'),{...options,priority:2});
  release();await Promise.all([active,expired,urgent]);assert.deepEqual(calls,['exit']);
});
