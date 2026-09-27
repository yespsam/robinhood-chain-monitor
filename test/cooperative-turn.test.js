import test from 'node:test';
import assert from 'node:assert/strict';
import { createCooperativeTurn } from '../src/cooperative-turn.js';

test('turn yields on elapsed budget and resets only after the callback', async () => {
  let clock = 0;
  let yields = 0;
  let release;
  const turn = createCooperativeTurn({ now: () => clock, yieldImpl: () => {
    yields += 1;
    return new Promise(resolve => { release = resolve; });
  } });
  assert.equal(turn(), undefined);
  clock = 7;
  assert.equal(turn(), undefined);
  clock = 8;
  const pending = turn();
  assert.equal(yields, 1);
  let finished = false;
  void pending.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  clock = 100;
  release();
  await pending;
  assert.equal(turn(), undefined, 'new budget begins after the scheduler yielded');
});

test('operation cap permits I/O even if a monotonic clock has not advanced', async () => {
  let yields = 0;
  const turn = createCooperativeTurn({ now: () => 0, maxOperations: 3,
    yieldImpl: async () => { yields += 1; } });
  for (let i = 0; i < 3; i++) assert.equal(turn(), undefined);
  await turn();
  assert.equal(yields, 1);
  assert.equal(turn(), undefined);
});

test('serialized operations retain FIFO, rejection recovery, and async exclusivity', async () => {
  const turn = createCooperativeTurn({ maxOperations: 1 });
  const events = [];
  let active = 0;
  let tail = Promise.resolve();
  const enqueue = id => {
    const task = tail.catch(() => {}).then(async () => {
      await turn();
      assert.equal(active, 0);
      active += 1;
      events.push(`start:${id}`);
      try {
        await new Promise(resolve => setImmediate(resolve));
        if (id === 2) throw new Error('fixture failure');
        return id;
      } finally {
        events.push(`end:${id}`);
        active -= 1;
      }
    });
    tail = task.catch(() => {});
    return task;
  };
  const outcomes = await Promise.allSettled([1, 2, 3].map(enqueue));
  assert.deepEqual(outcomes.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  assert.equal(active, 0);
});
