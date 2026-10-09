import test from 'node:test';
import assert from 'node:assert/strict';
import { bscQueueLimits, bscQueuePressure, bscQueueAdmission, bscClassificationMustYield, createBscQueueAgeIndex } from '../src/bsc-queue-pressure.js';

const limits = bscQueueLimits();
const now = Date.parse('2026-09-30T15:00:00Z');
const pressure = (pending, deferred, previous = {}, time = now) => bscQueuePressure({ pending, deferred, previous, now: time, limits });
const admission = (p, entries, lane = 'live') => bscQueueAdmission({ pressure: p, entries, lane, head: 1000, freshWindowBlocks: 128 });
const reservedPressure = (pending, deferred, liveReservedPending, options = {}) => bscQueuePressure({
  pending, deferred, liveReservedPending, now, limits, ...options,
});
const freshEntries = count => Array.from({ length: count }, () => ({ blockNumber: 999 }));

test('BSC reserves live capacity even with the legacy 25k historical backlog', () => {
  const p = pressure(25_000, 5_297);
  assert.equal(p.historyPaused, true);
  assert.equal(p.liveSlotsAvailable, 1000);
  assert.equal(admission(p, [{ blockNumber: 999 }]).allowed, true);
  assert.equal(admission(p, [{ blockNumber: 999 }], 'history').allowed, false);
  assert.equal(admission(p, [{ blockNumber: 1 }]).allowed, false, 'old work cannot claim the live reserve');
  assert.equal(admission(p, [{ blockNumber: 1001 }]).allowed, false, 'future/unobserved blocks cannot claim it');
  assert.equal(admission(p, [{ blockNumber: 999 }, { blockNumber: 1 }]).allowed, false, 'mixed batch admission is atomic');
  assert.equal(admission(p, []).allowed, true, 'updates to existing evidence never require a new slot');
});

test('BSC pending and combined deferred budgets are bounded without eviction', () => {
  assert.equal(admission(pressure(25_999, 5_000), [{ blockNumber: 999 }]).allowed, true);
  assert.equal(admission(pressure(26_000, 5_000), [{ blockNumber: 999 }]).allowed, false);
  assert.equal(admission(pressure(20_000, 20_000), [{ blockNumber: 999 }]).allowed, false);
  const p = pressure(25_999, 5_000);
  assert.equal(admission(p, [{ blockNumber: 999 }, { blockNumber: 998 }]).allowed, false);
  assert.equal(p.pending, 25_999, 'a failed admission does not evict or mutate anything');
});

test('BSC historical backfill pauses at high water and resumes only below low water, including after restart', () => {
  const high = pressure(20_000, 0);
  assert.equal(high.historyPaused, true);
  const restarted = JSON.parse(JSON.stringify(high));
  const intermediate = pressure(18_000, 0, restarted);
  assert.equal(intermediate.historyPaused, true);
  assert.equal(pressure(15_000, 0, intermediate).historyPaused, false);
  assert.equal(pressure(10_000, 20_000).historyPaused, true, 'deferred work also consumes the budget');
});

test('BSC detects five-minute stalled final processing, not classification or retry activity', () => {
  const p = pressure(25_000, 5_297);
  assert.equal(p.status, 'backpressure');
  const later = pressure(24_999, 5_298, p, now + 300_000);
  assert.equal(later.status, 'stalled', 'moving to deferred is not progress');
  assert.equal(pressure(24_998, 5_298, { ...later, lastCompletedAt: new Date(now + 300_000).toISOString(), completed: 1 }, now + 300_001).status, 'backpressure');
});

test('BSC continuous classification yields a final-processing slot without overtaking active SLA or pacing', () => {
  const work = { completedBatches: 2, hasOld: true, oldDue: true, hasSla: false };
  assert.equal(bscClassificationMustYield(work), true);
  assert.equal(bscClassificationMustYield({ ...work, completedBatches: 1 }), false);
  assert.equal(bscClassificationMustYield({ ...work, hasSla: true }), false);
  assert.equal(bscClassificationMustYield({ ...work, oldDue: false }), false);
  assert.equal(bscClassificationMustYield({ ...work, hasOld: false }), false);
});

test('BSC reports overload even when slow final processing is not fully stalled', () => {
  const p = pressure(25_000, 5_000);
  const growing = pressure(25_050, 5_000, { ...p, liveAdmitted: 60, completed: 10, lastCompletedAt: new Date(now + 59_000).toISOString() }, now + 60_000);
  assert.equal(growing.status, 'overloaded');
  assert.equal(growing.throughput.arrivalPerSecond, 1);
  assert.equal(growing.throughput.completionPerSecond, 1 / 6);
  const recovering = pressure(24_980, 5_000, { ...growing, liveAdmitted: 70, completed: 90, lastCompletedAt: new Date(now + 119_000).toISOString() }, now + 120_000);
  assert.equal(recovering.status, 'backpressure');
});

test('BSC full capacity cannot look recovered merely because new admissions were blocked', () => {
  const p = pressure(26_000, 5_000);
  const censored = pressure(26_000, 5_000, { ...p, completed: 10, lastCompletedAt: new Date(now + 59_000).toISOString() }, now + 60_000);
  assert.equal(censored.throughput.arrivalPerSecond, 0);
  assert.equal(censored.status, 'overloaded');
});

test('isolated live admission is independent of a full legacy pending queue', () => {
 const p=bscQueuePressure({pending:25998,deferred:4908,livePending:12,now,limits});
 assert.equal(p.liveSlotsAvailable,988);
 assert.equal(p.historyPaused,true);
 assert.equal(p.historyPending,30894);
 assert.equal(admission(p,Array.from({length:8},()=>({blockNumber:999}))).allowed,true);
 assert.equal(admission(p,[{blockNumber:1}],'history').allowed,false);
 assert.equal(admission(p,[{blockNumber:999},{blockNumber:1}]).allowed,false);
 assert.equal(admission({...p,liveSlotsAvailable:0},[{blockNumber:999}]).allowed,false);
 const full=bscQueuePressure({pending:35000,deferred:5000,livePending:0,now,limits});
 assert.equal(full.storageFull,true);
 assert.equal(admission(full,[{blockNumber:999}]).allowed,false,'independent lanes must not remove total storage bounds');
});

test('block-age index ages without eviction and survives reconstruction and reorgs', () => {
 const pending={a:{blockNumber:999},b:{blockNumber:900}},deferred={c:{blockNumber:995}};
 const index=createBscQueueAgeIndex();index.reset(pending,deferred);
 assert.equal(index.live(1000,10),2);
 assert.equal(index.live(1010,10),0);
 assert.equal(index.live(999,10),2,'a changed head must recompute against block positions');
 assert.equal(Object.keys(pending).length+Object.keys(deferred).length,3);
 index.replace(pending.a,{blockNumber:1000});assert.equal(index.live(999,10),1);
 index.replace(deferred.c,null);assert.equal(index.live(1000,10),1);
 index.reset(JSON.parse(JSON.stringify(pending)),deferred);assert.equal(index.live(1000,10),2);
 assert.equal(index.live(0,10),null,'unknown head cannot create live quota');
});

test('durable live reserve admits exactly 1k above a retained 40k historical backlog', () => {
  const p = reservedPressure(35_000, 5_000, 0);
  assert.equal(p.isolation, 'durable_live_reserve_v2');
  assert.equal(p.liveReservedPending, 0);
  assert.equal(p.historyRetained, 40_000);
  assert.equal(p.historyPending, 40_000);
  assert.equal(p.total, 40_000);
  assert.equal(p.limits.totalMax, 40_000, 'the historical limit is not raised');
  assert.equal(p.physicalHardLimit, 41_000);
  assert.equal(p.storageFull, false);
  assert.equal(p.status, 'backpressure', 'historical fullness is not live fullness');
  assert.equal(p.historyPaused, true);
  assert.equal(p.liveSlotsAvailable, 1_000);
  assert.equal(admission(p, freshEntries(1_000)).allowed, true);
  assert.equal(admission(p, freshEntries(1_001)).allowed, false);
  assert.equal(admission(p, freshEntries(1), 'history').allowed, false);

  const full = reservedPressure(36_000, 5_000, 1_000);
  assert.equal(full.historyRetained, 40_000);
  assert.equal(full.storageFull, true);
  assert.equal(full.liveSlotsAvailable, 0);
  assert.equal(admission(full, freshEntries(1)).allowed, false);
  assert.equal(admission(full, []).allowed, true, 'duplicate updates need no new capacity');
});

test('durable live reservations survive aging, deferred transfers and health reconstruction', () => {
  const p = reservedPressure(1_000, 0, 1_000, { livePending: 1_000, liveReservedDeferred: 0 });
  const restored = JSON.parse(JSON.stringify(p));
  const aged = reservedPressure(0, 1_000, 1_000, {
    livePending: 0, liveReservedDeferred: 1_000, previous: restored, now: now + 60_000,
  });
  assert.equal(aged.livePending, 0, 'block-age observations may change independently');
  assert.equal(aged.historyRetained, 0, 'aging does not turn a reservation into history');
  assert.equal(aged.liveReservedPending, 1_000);
  assert.equal(aged.liveReservedDeferred, 1_000);
  assert.equal(aged.liveSlotsAvailable, 0);
  assert.equal(admission(aged, freshEntries(1)).allowed, false);
  const completed = reservedPressure(0, 999, 999, { livePending: 0, liveReservedDeferred: 999, previous: aged });
  assert.equal(completed.liveSlotsAvailable, 1, 'only removing a completed reservation returns its slot');
  assert.equal(admission(completed, freshEntries(1)).allowed, true);
});

test('a full durable live reserve reports overload and stall even without historical pressure', () => {
  const p = reservedPressure(1_000, 0, 1_000, { liveReservedDeferred: 0 });
  assert.equal(p.historyPaused, false);
  assert.equal(p.liveCapacityFull, true);
  assert.equal(p.storageFull, false);
  assert.equal(p.status, 'overloaded');
  const stalled = reservedPressure(1_000, 0, 1_000, { previous: p, now: now + 300_000 });
  assert.equal(stalled.status, 'stalled');
  const progressing = reservedPressure(1_000, 0, 1_000, {
    previous: { ...stalled, completed: 1, lastCompletedAt: new Date(now + 300_000).toISOString() },
    now: now + 300_001,
  });
  assert.equal(progressing.status, 'overloaded');
});

test('durable reserve is only available to atomic near-head live batches', () => {
  const p = reservedPressure(35_000, 5_000, 0);
  for (const entries of [[{ blockNumber: 1 }], [{ blockNumber: 1001 }],
    [{ blockNumber: 999 }, { blockNumber: 1 }], [{ blockNumber: 999 }, { blockNumber: 1001 }],
    [{ blockNumber: '999' }], [{ blockNumber: NaN }]]) {
    assert.equal(admission(p, entries).allowed, false);
    assert.equal(admission(p, entries).live, false);
  }
  for (const head of [undefined, null, 0, -1, NaN, '1000']) {
    const result = bscQueueAdmission({ pressure: p, entries: freshEntries(1), lane: 'live', head, freshWindowBlocks: 128 });
    assert.equal(result.live, false);
    assert.equal(result.allowed, false);
  }
  assert.equal(admission(p, [{ blockNumber: 873 }]).allowed, true, 'the inclusive near-head boundary is live');
  assert.equal(admission(p, [{ blockNumber: 872 }]).allowed, false);
  assert.equal(admission(p, freshEntries(1), 'history').live, false);
});

test('durable admission never exceeds physical hard bound, including pre-existing oversized state', () => {
  const p = reservedPressure(40_000, 999, 0);
  assert.equal(p.liveSlotsAvailable, 1, 'physical room also bounds an unused live reserve');
  assert.equal(admission(p, freshEntries(1)).allowed, true);
  assert.equal(admission(p, freshEntries(2)).allowed, false);
  for (const total of [41_000, 41_001, 50_000]) {
    const full = reservedPressure(total, 0, 0);
    assert.equal(full.storageFull, true);
    assert.equal(full.liveSlotsAvailable, 0);
    assert.equal(admission(full, freshEntries(1)).allowed, false);
    assert.equal(admission(full, []).allowed, true);
  }
});

test('durable historical hysteresis uses unreserved work when its pending split is known', () => {
  const high = reservedPressure(21_000, 0, 1_000, { liveReservedDeferred: 0 });
  assert.equal(high.historyQueuedPending, 20_000);
  assert.equal(high.historyRetained, 20_000);
  assert.equal(high.historyPaused, true);
  const middle = reservedPressure(19_000, 0, 1_000, { liveReservedDeferred: 0, previous: high });
  assert.equal(middle.historyPaused, true);
  const low = reservedPressure(16_000, 0, 1_000, { liveReservedDeferred: 0, previous: middle });
  assert.equal(low.historyQueuedPending, 15_000);
  assert.equal(low.historyPaused, false);
  assert.equal(admission(low, [{ blockNumber: 1 }], 'history').allowed, true);
  const belowTotalHigh = reservedPressure(10_000, 20_000, 1_000, { liveReservedDeferred: 1_000 });
  assert.equal(belowTotalHigh.historyRetained, 29_000);
  assert.equal(belowTotalHigh.historyPaused, false);
  assert.equal(reservedPressure(10_000, 21_000, 1_000, { liveReservedDeferred: 1_000 }).historyPaused, true);
  const conservative = reservedPressure(20_000, 0, 1_000);
  assert.equal(conservative.historyRetained, 19_000);
  assert.equal(conservative.historyPaused, true, 'without a pending split, high water stays conservative');
});

test('historical admission preserves the conservative reserved boundary', () => {
  const customLimits = bscQueueLimits({ pendingMax: 10, liveReserve: 2, historyHigh: 10,
    historyLow: 8, totalMax: 12, totalHigh: 12, totalLow: 10 });
  const p = reservedPressure(9, 0, 0, { limits: customLimits });
  assert.equal(p.historyPaused, false);
  assert.equal(admission(p, freshEntries(1), 'history').allowed, true);
  assert.equal(admission(p, freshEntries(2), 'history').allowed, false);
  assert.equal(admission(p, freshEntries(2)).allowed, true);
});

test('durable reserve activates only with an explicit valid active reservation count', () => {
  for (const count of [undefined, null, -1, 1.5, 40_001, '0', NaN, Infinity]) {
    const legacy = reservedPressure(35_000, 5_000, count);
    assert.equal(legacy.isolation, 'shared_pending_legacy');
    assert.equal(legacy.liveReservedPending, null);
    assert.equal(legacy.physicalHardLimit, 40_000);
    assert.equal(legacy.storageFull, true);
    assert.equal(admission(legacy, freshEntries(1)).allowed, false);
    const ageMode = reservedPressure(35_000, 5_000, count, { livePending: 0 });
    assert.equal(ageMode.isolation, 'block_age_lanes_v1');
    assert.equal(ageMode.liveSlotsAvailable, 0);
  }
  assert.equal(reservedPressure(0, 0, 0).isolation, 'durable_live_reserve_v2');
  const zeroReserve = reservedPressure(0, 0, 0, { limits: bscQueueLimits({ liveReserve: 0 }) });
  assert.equal(zeroReserve.liveCapacityFull, false);
  assert.equal(zeroReserve.status, 'healthy');
});

test('inconsistent deferred splits cannot undercount historical pending or release live reservations', () => {
  for (const split of [-1, 0.5, 2_001, '0', NaN, Infinity]) {
    const p = reservedPressure(20_000, 2_000, 1_000, { liveReservedDeferred: split });
    assert.equal(p.isolation, 'durable_live_reserve_v2');
    assert.equal(p.liveReservedDeferred, null);
    assert.equal(p.historyQueuedPending, 20_000);
    assert.equal(p.historyRetained, 21_000);
    assert.equal(p.historyPaused, true);
    assert.equal(p.liveSlotsAvailable, 0);
  }
  const impossiblePendingSplit = reservedPressure(0, 1_000, 1_000, { liveReservedDeferred: 0 });
  assert.equal(impossiblePendingSplit.liveReservedDeferred, null);
  assert.equal(impossiblePendingSplit.liveSlotsAvailable, 0);
  const overfullReserve = reservedPressure(1_001, 0, 1_001);
  assert.equal(overfullReserve.liveReservedPending, 1_001, 'existing reservations are reported, not clamped away');
  assert.equal(overfullReserve.liveSlotsAvailable, 0);
  assert.equal(overfullReserve.liveCapacityFull, true);
  assert.equal(admission(overfullReserve, freshEntries(1)).allowed, false);
});
