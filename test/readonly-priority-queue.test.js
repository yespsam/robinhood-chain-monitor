import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueReadonly } from '../src/readonly-priority-queue.js';
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

test('aging preserves background progress and failed work does not block future work', async () => {
  const scheduler = {}, calls = []; let clock = 0, release;
  const first = enqueueReadonly(scheduler, () => new Promise(resolve => { release = resolve; }), { now: () => clock });
  await flush();
  const old = enqueueReadonly(scheduler, () => calls.push('old'), { now: () => clock });
  clock = 90000;
  const exit = enqueueReadonly(scheduler, () => calls.push('exit'), { priority: 2, now: () => clock });
  release(); await Promise.all([first, old, exit]); assert.deepEqual(calls, ['old', 'exit']);
  await assert.rejects(enqueueReadonly(scheduler, () => { throw new Error('fixture'); }), /fixture/);
  await enqueueReadonly(scheduler, () => calls.push('recovered'));
  assert.equal(calls.at(-1), 'recovered');
});
