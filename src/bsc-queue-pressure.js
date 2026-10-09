// Admission budgets, not proof shortcuts. Rejected ranges retain their cursor
// and are read again later; already-durable records are never evicted.
export function bscQueueLimits({ pendingMax = 25_000, liveReserve = 1_000,
  historyHigh = 20_000, historyLow = 15_000, totalHigh = 30_000,
  totalLow = 25_000, totalMax = 40_000 } = {}) {
  const integer = (value, min) => Math.max(min, Math.floor(Number(value) || min));
  pendingMax = integer(pendingMax, 1);
  liveReserve = integer(liveReserve, 0);
  historyHigh = Math.min(pendingMax, integer(historyHigh, 1));
  historyLow = Math.min(historyHigh - 1, integer(historyLow, 0));
  totalMax = Math.max(pendingMax + liveReserve, integer(totalMax, 1));
  totalHigh = Math.min(totalMax, integer(totalHigh, 1));
  totalLow = Math.min(totalHigh - 1, integer(totalLow, 0));
  return { pendingMax, liveReserve, historyHigh, historyLow, totalHigh, totalLow, totalMax };
}

export function bscQueuePressure({ pending, deferred, livePending = null,
  liveReservedPending = null, liveReservedDeferred = null, previous = {}, now, limits }) {
  const total = pending + deferred;
  const isolated = Number.isSafeInteger(livePending) && livePending >= 0 && livePending <= total;
  // This is an active-record reservation count across BOTH pending and deferred.
  // Unlike the block-age index, a reservation is held until final completion.
  const durable = Number.isSafeInteger(liveReservedPending)
    && liveReservedPending >= 0 && liveReservedPending <= total;
  const historyRetained = durable ? total - liveReservedPending : null;
  const exactDeferred = durable && Number.isSafeInteger(liveReservedDeferred)
    && liveReservedDeferred >= 0 && liveReservedDeferred <= deferred
    && liveReservedDeferred <= liveReservedPending
    && liveReservedPending - liveReservedDeferred <= pending;
  // Without an exact split, pending is a conservative historical high-water
  // estimate. The historical total and live quota remain exact either way.
  const historyQueuedPending = durable && exactDeferred
    ? pending - liveReservedPending + liveReservedDeferred : pending;
  const historyTotal = durable ? historyRetained : total;
  const high = historyQueuedPending >= limits.historyHigh || historyTotal >= limits.totalHigh;
  const recovered = historyQueuedPending <= limits.historyLow && historyTotal <= limits.totalLow;
  const historyPaused = high || (previous.historyPaused === true && !recovered);
  const liveCapacityFull = durable && limits.liveReserve > 0 && liveReservedPending >= limits.liveReserve;
  const backpressured = historyPaused || liveCapacityFull;
  const activeSince = total > 0 ? previous.activeSince || new Date(now).toISOString() : null;
  const lastProgress = Date.parse(previous.lastCompletedAt || activeSince || '');
  const stalled = backpressured && total > 0 && Number.isFinite(lastProgress) && now - lastProgress >= 300_000;
  const admitted = Number(previous.liveAdmitted || 0) + Number(previous.historyAdmitted || 0);
  const completed = Number(previous.completed || 0);
  let throughput = previous.throughput || {
    windowStartedAt: new Date(now).toISOString(), admittedBase: admitted, completedBase: completed,
    arrivalPerSecond: null, completionPerSecond: null,
  };
  const elapsed = now - Date.parse(throughput.windowStartedAt);
  if (elapsed >= 60_000) throughput = {
    windowStartedAt: new Date(now).toISOString(), admittedBase: admitted, completedBase: completed,
    measuredAt: new Date(now).toISOString(), windowMs: elapsed,
    arrivalPerSecond: Math.max(0, admitted - throughput.admittedBase) * 1000 / elapsed,
    completionPerSecond: Math.max(0, completed - throughput.completedBase) * 1000 / elapsed,
  };
  const physicalHardLimit = limits.totalMax + (durable ? limits.liveReserve : 0);
  const liveSlotsAvailable = Math.max(0, Math.min(durable
    ? limits.liveReserve - liveReservedPending : isolated
      ? limits.liveReserve - livePending : limits.pendingMax + limits.liveReserve - pending,
    physicalHardLimit - total));
  // Admitted arrivals are censored at capacity; zero admissions there do NOT
  // prove the source slowed down or that the queue is recovering.
  const overloaded = backpressured && (liveSlotsAvailable === 0
    || throughput.arrivalPerSecond > throughput.completionPerSecond);
  return {
    ...previous, version: 1, checkedAt: new Date(now).toISOString(), activeSince,
    status: stalled ? 'stalled' : overloaded ? 'overloaded' : historyPaused ? 'backpressure' : 'healthy',
    historyPaused, pending, deferred, total, limits,
    isolation: durable ? 'durable_live_reserve_v2' : isolated ? 'block_age_lanes_v1' : 'shared_pending_legacy',
    livePending: isolated ? livePending : null,
    historyPending: durable ? historyRetained : isolated ? total - livePending : null,
    liveReservedPending: durable ? liveReservedPending : null,
    liveReservedDeferred: exactDeferred ? liveReservedDeferred : null,
    liveCapacityFull,
    historyRetained,
    historyQueuedPending: durable ? historyQueuedPending : null,
    physicalHardLimit,
    storageFull: total >= physicalHardLimit,
    liveSlotsAvailable,
    // Transfers to deferred and receipt classification are deliberately not
    // completions. Only the final proof/seen commit may advance this counter.
    completed, throughput,
  };
}

export function bscQueueAdmission({ entries, lane, head, freshWindowBlocks, pressure }) {
  const { limits, pending, total } = pressure;
  if (!entries.length) return { allowed: true, live: false };
  const live = lane === 'live' && Number.isSafeInteger(head) && head > 0
    && entries.every(entry => Number.isSafeInteger(entry.blockNumber)
      && entry.blockNumber <= head
      && entry.blockNumber >= Math.max(0, head - freshWindowBlocks + 1));
  const pendingCapacity = limits.pendingMax + (live ? limits.liveReserve : 0);
  if (pressure.isolation === 'durable_live_reserve_v2') return {
    live, pendingCapacity: live ? limits.liveReserve : limits.pendingMax,
    admittedCount: live ? pressure.liveReservedPending : pressure.historyRetained,
    allowed: total + entries.length <= limits.totalMax + limits.liveReserve
      && (live
        ? entries.length <= pressure.liveSlotsAvailable
        : !pressure.historyPaused && pressure.historyRetained + entries.length <= limits.pendingMax
          && pressure.historyRetained + entries.length <= limits.totalMax - limits.liveReserve),
  };
  if (pressure.isolation === 'block_age_lanes_v1') return {
    live, pendingCapacity: live ? limits.liveReserve : limits.pendingMax,
    admittedCount: live ? pressure.livePending : pressure.historyPending,
    allowed: live
      ? entries.length <= pressure.liveSlotsAvailable
      : !pressure.historyPaused && pressure.historyPending + entries.length <= limits.pendingMax
        && total + entries.length <= limits.totalMax - limits.liveReserve,
  };
  return {
    live, pendingCapacity,
    allowed: (live || !pressure.historyPaused)
      && pending + entries.length <= pendingCapacity
      && total + entries.length <= limits.totalMax,
  };
}

// Derived index, never an authoritative queue. Aging changes capacity only;
// no record is evicted, marked complete, or stripped of causal dependencies.
// Looking up a bounded live window avoids walking 25k+ records each head tick.
export function createBscQueueAgeIndex() {
  const counts = new Map();
  const adjust = (record, delta) => {
    if (!record) return;
    const block = record.blockNumber;
    if (!Number.isSafeInteger(block) || block < 0) throw new Error('BSC_QUEUE_AGE_INVALID');
    const count = (counts.get(block) || 0) + delta;
    if (count < 0) throw new Error('BSC_QUEUE_AGE_UNDERFLOW');
    if (count) counts.set(block, count); else counts.delete(block);
  };
  return {
    reset(...collections) { counts.clear(); for (const collection of collections)
      for (const record of Object.values(collection || {})) adjust(record, 1); },
    replace(previous, next) { adjust(previous, -1); adjust(next, 1); },
    live(head, window) {
      if (!Number.isSafeInteger(head) || head <= 0 || !Number.isSafeInteger(window) || window < 1 || window > 10000) return null;
      let total = 0;
      for (let block = Math.max(0, head - window + 1); block <= head; block++) total += counts.get(block) || 0;
      return total;
    },
  };
}

export function bscClassificationMustYield({ completedBatches, hasOld, oldDue, hasSla }) {
  return !hasSla && hasOld && oldDue && completedBatches >= 2;
}

// Preparation keeps reservations; final processing can release them. Under
// continuous arrivals, a preparation stream must not own every pressure slot
// ahead of already-proven independent work. Preserve the existing lease quota.
export function bscPressureReliefWorkClass({ leasesSinceRelief, hasDrain, hasPrepareDrain, hasPrepareQuote, hasSla }) {
  if (leasesSinceRelief < 2) return null;
  if (hasDrain) return "drain";
  if (hasPrepareDrain) return "prepareDrain";
  if (!hasSla && hasPrepareQuote) return "prepareQuote";
  return null;
}
