import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Interface } from "ethers";
import { createBscLaunchpadMonitor } from "../src/bsc-launchpad-monitor.js";

async function harness(t, { count = 1, classified = false, ordinaryUnclassified = false, pendingMax = 1, preclassifiedPrefix = 0, cache = true, fallback = false, wrongChain = false, budgetFailure = false, scanPolicy = null, queueIsolation = false, recoveryGaps = [], deferredPrefix = 0,
  recordOverrides = {}, emptyReceiptIndexes = [], deferredNextAttemptMs = {}, hostCooldownMs = 0, queueLimits = null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-proof-throughput-"));
  if (scanPolicy) await fs.writeFile(path.join(dataDir, "bsc-scan-policy.json"), JSON.stringify(scanPolicy));
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const manager = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
  const creator = `0x${"2".repeat(40)}`;
  const hex = n => `0x${n.toString(16).padStart(64, "0")}`;
  const iface = new Interface(["event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 raisedAmount,uint256 reservedAmount)"]);
  const records = Array.from({ length: count }, (_, i) => {
    const hash = hex(i + 1), blockHash = hex(100 + i), blockNumber = 100 + i;
    const token = `0x${(1000 + i).toString(16).padStart(40,"0")}`;
    const encoded = iface.encodeEventLog(iface.getEvent("TokenCreate"), [creator, token, 1n, "Old", "OLD", 100n, 0n, 0n]);
    const alreadyClassified = classified || i < preclassifiedPrefix;
    const record = { transactionHash: hash, blockHash, blockNumber, transactionIndex: 0, logIndex: 0,
      reasons: ["http_tail"], candidateTokens: [token], verifiedNewContracts: [token], hasProtocolTrigger: true,
      causalBarrierKeys: alreadyClassified || ordinaryUnclassified ? [] : ["feature:unrelated"], ...recordOverrides[i] };
    if (alreadyClassified) record.causalReceiptClassificationDigest = createHash("sha256").update(JSON.stringify([
      hash, blockHash, blockNumber, 0, 0, record.featureActivationReplayKey || null,
      record.flapQuoteFirstThreeReplayGenerationKey || null, record.causalBarrierKeys,
    ])).digest("hex");
    const emptyReceipt = emptyReceiptIndexes.includes(i);
    return { record,
      transaction: { hash, blockNumber, blockHash, index: 0, to: emptyReceipt ? null : manager, from: creator, data: "0x12345678" },
      receipt: { hash, blockNumber, blockHash, index: 0, status: 1, logs: emptyReceipt ? [] : [{ address: manager, ...encoded, transactionHash: hash, blockHash, blockNumber, transactionIndex: 0, logIndex: 0 }] },
      block: { number: blockNumber, hash: blockHash, timestamp: Math.floor(clock / 1000) - 86400, transactions: [hash] },
    };
  });
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify({
    version: 6, initializedAt: new Date(clock - 60_000).toISOString(), lastFinalizedBlock: 99, realtimeTailNextBlock: 5000,
    realtimePendingEntries: Object.fromEntries(records.slice(deferredPrefix).map(v => [v.record.transactionHash, v.record])),
    deferredCreationEvidence: Object.fromEntries(records.slice(0, deferredPrefix).map((v, index) => [v.record.transactionHash, {
      ...v.record, attempts: 2, firstDeferredAt: new Date(clock - 60_000).toISOString(), nextAttemptAt: new Date(clock + (deferredNextAttemptMs[index] ?? -1)).toISOString(),
    }])),
    launchers: {}, hooks: {}, seenTransactions: {}, coverageGaps: [], nearHeadRecoveryGaps: recoveryGaps, officialSources: {},
    ...(hostCooldownMs > 0 ? { _health: { backgroundDeepRpc: {
      status: "backoff", rpcFailureScope: "host", nextRetryAt: new Date(clock + hostCooldownMs).toISOString(),
    } } } : {}),
  }));
  const calls = { tx: 0, receipt: 0, block: 0, legacy: 0, active: 0, maxActive: 0, head: 0, ranges: [], proofOrder: [] };
  const budgetError = () => Object.assign(new Error("getCode state-read retry budget exhausted; evidence retained for retry"), {
    code: "SERVER_ERROR", rpcBudgetExhausted: true, rpcCircuitAlreadyOpen: true, rpcOperation: "getCode", rpcFailureScope: "method", retryAfterMs: 1000,
  });
  let forked = false;
  const byHash = hash => records.find(v => v.record.transactionHash === hash);
  const byBlock = number => records.find(v => v.record.blockNumber === number);
  const primary = {
    getNetwork: async () => ({ chainId: 56n }), getBlockNumber: async () => { calls.head++; return 5002; },
    send: async (method, [filter]) => { if (method === "eth_getLogs") calls.ranges.push(filter); return []; }, destroy() {},
    getTransaction: async hash => { calls.legacy++; calls.proofOrder.push(hash); if (budgetFailure) throw budgetError(); return byHash(hash).transaction; },
    getTransactionReceipt: async hash => { calls.legacy++; return byHash(hash).receipt; },
    getBlock: async n => { calls.legacy++; return byBlock(n).block; },
    getCode: async () => assert.fail("ordinary Four discovery must not gain a new runtime read"),
    call: async () => assert.fail("ordinary Four discovery must not gain a new token-info read"),
  };
  const objects = {
    getNetwork: async () => ({ chainId: wrongChain ? 1n : 56n }), destroy() {},
    getTransaction: async hash => {
      calls.tx++; calls.proofOrder.push(hash); if (budgetFailure) throw budgetError(); if (fallback) throw new Error("object source offline");
      calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
      try { await delay(5); return byHash(hash).transaction; } finally { calls.active--; }
    },
    getTransactionReceipt: async hash => { calls.receipt++; if (fallback) throw new Error("object source offline"); return byHash(hash).receipt; },
    getBlock: async n => { calls.block++; if (fallback) throw new Error("object source offline"); return { ...byBlock(n).block, ...(forked ? { hash: hex(9999) } : {}) }; },
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  const monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscMonitorEnabled: true,
    bscHttpHeadPollIntervalMs: 60_000,
    bscDeferredRetryIntervalMs: 60_000,
    bscWsUrl: "wss://example.invalid", bscRpcUrl: "https://example.invalid",
    bscObjectProofIsolationEnabled: true, bscReceiptProofCacheEnabled: cache, bscIndependentDrainBatchSize: 4,
    bscQueueIsolationEnabled: queueIsolation,
  }, {
    autoStart: false, provider: primary, causalClassificationProvider: objects,
    causalClassificationEnabled: true, causalClassificationAutoSchedule: false, externalAttribution: false,
    initialHeadForTesting: 5002, now: () => clock, realtimePendingMaxEntries: pendingMax,
    ...(queueLimits ? { queueLimits } : {}),
    WebSocketImpl: IdleWebSocket, backgroundSetTimeoutImpl: () => ({ unref() {} }), backgroundClearTimeoutImpl() {},
    journalSetTimeoutImpl: () => ({ unref() {} }), journalClearTimeoutImpl() {},
    fetchImpl: async () => { throw new Error("external sources disabled in fixture"); },
    sendAlertsImpl: async () => assert.fail("ordinary discovery cannot send an alert"), logger: { error() {}, info() {} },
  });
  t.after(async () => { await monitor.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await monitor.start();
  // start() deliberately hands bootstrap polls off to the background. These
  // tests control proof order, so finish that bootstrap before mutating forks.
  await monitor.awaitIdle();
  return { monitor, calls, records, dataDir, reorg: () => { forked = true; }, advance: ms => { clock += ms; } };
}

test("live cutover retains old pending evidence, drains new entries and never advances historical coverage", async t => {
  const { monitor, calls, records, advance } = await harness(t, { count: 5, classified: true, queueIsolation: true,
    scanPolicy: { version: 1, mode: "live_only", fromBlock: 102, activatedAt: "2026-10-01T12:00:00Z" } });
  const before = await monitor.getState();
  advance(86_400_000); // The fixed epoch must not expire new retry work.
  await monitor.processRealtimeQueue();
  const after = await monitor.getState();
  assert.equal(after.lastFinalizedBlock, 99);
  assert.equal(after._health.queuePressure.completed, 3);
  assert.equal(after._health.queuePressure.pausedPending, 2);
  assert.equal(after._health.queuePressure.pending, 0);
  assert.equal(after._health.queuePressure.retainedTotal, 2);
  assert.equal(calls.tx, 3);
  for (const { record } of records.slice(0, 2)) {
    assert.deepEqual(after.realtimePendingEntries[record.transactionHash], before.realtimePendingEntries[record.transactionHash]);
    assert.equal(after.seenTransactions[record.transactionHash], undefined);
  }
});

test("all-paused queue performs no old classification, deep reads, or historical replay", async t => {
  const { monitor, calls } = await harness(t, { count: 5, deferredPrefix: 2,
    scanPolicy: { version: 1, mode: "live_only", fromBlock: 5001, activatedAt: "2026-10-01T12:00:00Z" } });
  const before = await monitor.getState();
  await monitor.classifyCausalBacklog();
  await monitor.processRealtimeQueue();
  await monitor.retryDeferredCreationEvidence();
  assert.equal((await monitor.advanceCoverage()).reason, "historical_backlog_paused");
  const after = await monitor.getState();
  assert.equal(calls.tx + calls.receipt + calls.block + calls.legacy, 0);
  assert.deepEqual(after.realtimePendingEntries, before.realtimePendingEntries);
  assert.deepEqual(after.deferredCreationEvidence, before.deferredCreationEvidence);
  assert.equal(after._health.queuePressure.pending, 0);
  assert.equal(after._health.queuePressure.pausedPending, 3);
  assert.equal(after._health.queuePressure.pausedDeferred, 2);
  assert.equal(after._health.queuePressure.completed || 0, 0);
  assert.equal(after.lastFinalizedBlock, 99);
  assert.ok(after.realtimeTailNextBlock >= 5001);
});

test("new-epoch backlog prepares canonical receipts and drains below capacity without touching paused history", async t => {
  const {monitor,calls,records,advance}=await harness(t,{count:40,ordinaryUnclassified:true,pendingMax:10000,queueIsolation:true,
    scanPolicy:{version:1,mode:'live_only',fromBlock:102,activatedAt:'2026-10-01T12:00:00Z'}});
  const before=await monitor.getState();
  for(let i=0;i<2;i++){advance(10000);await monitor.scanRealtimeTail();await monitor.awaitIdle();}
  advance(1000);await monitor.processRealtimeQueue();
  const prepared=await monitor.getState();
  assert.equal(prepared._health.queuePressure.completed||0,0,'receipt preparation is not completion');
  assert.ok(Object.values(prepared.realtimePendingEntries).some(x=>x.causalReceiptClassificationDigest));
  assert.equal(prepared._health.queuePressure.historyPaused,false,'not capacity-driven');
  for(let i=0;i<5;i++){advance(1000);await monitor.processRealtimeQueue();}
  const after=await monitor.getState();
  assert.ok(after._health.receiptProof.drainBatches>0,JSON.stringify(after._health));
  assert.ok(after._health.queuePressure.completed>=4);
  assert.equal(after.lastFinalizedBlock,99);
  assert.equal(after._health.queuePressure.pausedPending,2);
  for(const {record} of records.slice(0,2))assert.deepEqual(after.realtimePendingEntries[record.transactionHash],before.realtimePendingEntries[record.transactionHash]);
  assert.ok(calls.maxActive<=4,'proof preparation and full drain stay bounded');
});

test("proactive preparation with wrong-chain proof keeps every new task pending and never records completion", async t => {
  const {monitor,records,advance}=await harness(t,{count:36,ordinaryUnclassified:true,pendingMax:10000,wrongChain:true,
    scanPolicy:{version:1,mode:'live_only',fromBlock:100,activatedAt:'2026-10-01T12:00:00Z'}});
  for(let i=0;i<2;i++){advance(10000);await monitor.scanRealtimeTail();await monitor.awaitIdle();}
  advance(1000);await monitor.processRealtimeQueue();
  const after=await monitor.getState();
  assert.equal(after._health.queuePressure.completed||0,0);
  for(const {record} of records){
    assert.equal(after.seenTransactions[record.transactionHash],undefined);
    const retained=after.realtimePendingEntries[record.transactionHash]||after.deferredCreationEvidence[record.transactionHash];
    assert.ok(retained);assert.equal(retained.causalReceiptClassificationDigest,undefined);
  }
});

test("post-cutover recovery gaps still scan while old gaps remain pending", async t => {
  const { monitor, calls, advance } = await harness(t, { count: 0,
    scanPolicy: { version: 1, mode: "live_only", fromBlock: 4990, activatedAt: "2026-10-01T12:00:00Z" },
    recoveryGaps: [
      { id: "old-paused", fromBlock: 100, toBlock: 101, nextBlock: 100, attempts: 0 },
      { id: "new-retry", fromBlock: 4990, toBlock: 4991, nextBlock: 4990, attempts: 0 },
    ],
  });
  const before = await monitor.getState();
  // Bootstrap schedules its first tail pass asynchronously; explicitly prove
  // both health passes instead of depending on real timer timing in CI.
  for (let i = 0; i < 2; i++) {
    advance(10_000);
    await monitor.scanRealtimeTail();
    await monitor.awaitIdle();
  }
  advance(10_000);
  const recovered = await monitor.scanNearHeadRecovery();
  await monitor.awaitIdle();
  const after = await monitor.getState();
  assert.deepEqual(after.nearHeadRecoveryGaps.find(g => g.id === "old-paused"), before.nearHeadRecoveryGaps.find(g => g.id === "old-paused"));
  assert.equal(after.nearHeadRecoveryGaps.some(g => g.id === "new-retry"), false, JSON.stringify({ recovered, health: after._health.nearHeadRecovery, tail: after._health.realtimeTail, calls }));
  assert.equal(after._health.nearHeadRecovery.status, "paused");
  assert.equal(after._health.nearHeadRecovery.liveScopeFromBlock, 4990);
  assert.equal(after._health.nearHeadRecovery.fromBlock, null, "no stale active range when only paused gaps remain");
  assert.ok(calls.ranges.some(f => Number.parseInt(f.fromBlock, 16) === 4990));
  assert.ok(calls.ranges.every(f => Number.parseInt(f.fromBlock, 16) >= 4990));
  assert.equal(after.lastFinalizedBlock, 99);
});
test("classification proof reuses transaction/receipt but verifies a fresh canonical block before completion", async t => {
  const { monitor, calls, records } = await harness(t);
  const result = await monitor.classifyCausalBacklog();
  assert.equal(result.classified, 1, JSON.stringify(result));
  assert.equal((await monitor.getState()).seenTransactions[records[0].record.transactionHash], undefined);
  await monitor.awaitIdle();
  await monitor.processRealtimeQueue();
  const s = await monitor.getState();
  assert.equal(s.seenTransactions[records[0].record.transactionHash], 100);
  assert.equal(calls.tx, 1); assert.equal(calls.receipt, 1); assert.equal(calls.block, 2);
  assert.equal(calls.legacy, 0);
  assert.equal(s._health.receiptProof.reusedObjectReads, 2);
});
test("reorg after classification invalidates cached objects and does not count completion", async t => {
  const { monitor, calls, records, reorg } = await harness(t);
  const classified = await monitor.classifyCausalBacklog();
  assert.equal(classified.classified, 1, JSON.stringify(classified));
  // A real tail timer may fire during the asynchronous classification. The
  // queue correctly yields to it; this test needs to exercise reorg proof,
  // not accidentally assert on a skipped deep-processing invocation.
  await monitor.awaitIdle();
  reorg();
  const processed = await monitor.processRealtimeQueue();
  const s = await monitor.getState(), hash = records[0].record.transactionHash;
  assert.equal(s.seenTransactions[hash], undefined);
  assert.ok(s.realtimePendingEntries[hash] || s.deferredCreationEvidence[hash]);
  assert.equal(s._health.queuePressure.completed || 0, 0);
  assert.equal(s._health.receiptProof.cache.invalidations, 1, JSON.stringify({ classified, processed, calls, proof: s._health.receiptProof, pending: s.realtimePendingEntries[hash], failures: s.transactionFailures }));
});
test("independent pressure drain is bounded to four entries and two readers, with unchanged historical cursor", async t => {
  const { monitor, calls } = await harness(t, { count: 5, classified: true });
  await monitor.processRealtimeQueue();
  const s = await monitor.getState();
  assert.equal(s._health.queuePressure.completed, 4);
  assert.equal(Object.keys(s.realtimePendingEntries).length, 1);
  assert.equal(s.lastFinalizedBlock, 99);
  assert.equal(calls.maxActive, 2);
  assert.equal(s._health.receiptProof.drainEntries, 4);
});
test("object lane keeps the legacy archive fallback without weakening proof", async t => {
  const { monitor, calls } = await harness(t, { classified: true, fallback: true });
  await monitor.processRealtimeQueue();
  const s = await monitor.getState();
  assert.equal(s._health.queuePressure.completed, 1);
  assert.equal(calls.legacy, 3);
  assert.equal(s._health.receiptProof.archiveFallbacks, 3);
});
test("wrong chain on the object reader cannot finalize a queued candidate", async t => {
  const { monitor, calls } = await harness(t, { classified: true, wrongChain: true });
  await monitor.processRealtimeQueue();
  const s = await monitor.getState();
  assert.equal(s._health.queuePressure.completed || 0, 0);
  assert.equal(calls.tx + calls.receipt + calls.legacy, 0);
});
test("independent Four evidence receives the batch slot while older unknown-cost work retains its old slot", async t => {
  const { monitor, records, advance } = await harness(t, { count: 6, preclassifiedPrefix: 2 });
  assert.equal((await monitor.classifyCausalBacklog()).classified, 4);
  await monitor.awaitIdle();
  await monitor.processRealtimeQueue();
  let s = await monitor.getState();
  assert.equal(s._health.queuePressure.completed, 4);
  assert.deepEqual(Object.keys(s.realtimePendingEntries).sort(), records.slice(0, 2).map(v => v.record.transactionHash).sort());
  assert.equal(s._health.receiptProof.reusedObjectReads, 8);
  advance(1000);
  await monitor.processRealtimeQueue();
  s = await monitor.getState();
  assert.equal(s._health.queuePressure.completed, 5);
  assert.equal(s.seenTransactions[records[0].record.transactionHash], 100);
  assert.equal(s._health.backgroundDeepWork.workClass, "old");
  assert.equal(s.lastFinalizedBlock, 99);
});
test("local state budget exhaustion retains evidence without probing head or gating the whole chain", async t => {
  const { monitor, calls, records } = await harness(t, { classified: true, budgetFailure: true });
  const headsBefore = calls.head;
  // Fault injection at the provider boundary exercises the common result /
  // durable-defer path without relying on a live historical state outage.
  await monitor.processRealtimeQueue();
  const s = await monitor.getState(), hash = records[0].record.transactionHash;
  assert.equal(calls.head, headsBefore, "local budget is not an upstream outage requiring another head RPC");
  assert.equal(s._health.queuePressure.completed || 0, 0);
  assert.equal(s.seenTransactions[hash], undefined);
  assert.ok(s.deferredCreationEvidence[hash]);
  assert.equal(calls.legacy, 0, "an exhausted object budget must not restart in the unbounded archive fallback");
  assert.notEqual(s._health.backgroundDeepRpc?.status, "backoff");
  assert.equal(s.lastFinalizedBlock, 99);
});

const smallIsolatedQueueLimits = {
  pendingMax: 6, liveReserve: 2, historyHigh: 2, historyLow: 1,
  totalHigh: 2, totalLow: 1, totalMax: 6,
};

test("aged durable live work is proved before an unrelated historical backlog", async t => {
  const { monitor, calls, records, advance } = await harness(t, {
    count: 7, ordinaryUnclassified: true, queueIsolation: true, hostCooldownMs: 1_000,
    queueLimits: smallIsolatedQueueLimits, recordOverrides: { 6: { queueCapacityLane: "live" } },
  });
  const before = await monitor.getState();
  const liveHash = records[6].record.transactionHash;
  assert.equal(before._health.queuePressure.historyPaused, true);
  assert.equal(before.realtimePendingEntries[liveHash].queueCapacityLane, "live");
  advance(86_400_000); // Neither the receipt timestamp nor the old block becomes fresh.
  await monitor.processRealtimeQueue();
  const after = await monitor.getState();
  assert.deepEqual(calls.proofOrder, [liveHash], "the reserved task must not join the old FIFO after aging");
  assert.equal(after._health.backgroundDeepWork.workClass, "fresh");
  assert.equal(after.seenTransactions[liveHash], records[6].record.blockNumber);
  assert.equal(after._health.queuePressure.completed, 1);
  assert.equal(calls.tx, 1);
  assert.equal(calls.receipt, 1);
  assert.equal(calls.block, 1, "priority does not replace canonical receipt/block proof");
  for (const { record } of records.slice(0, 6)) {
    assert.deepEqual(after.realtimePendingEntries[record.transactionHash], before.realtimePendingEntries[record.transactionHash]);
    assert.equal(after.seenTransactions[record.transactionHash], undefined);
  }
  assert.equal(after.lastFinalizedBlock, before.lastFinalizedBlock);
});

test("aged live priority inherits its historical causal head without overtaking it", async t => {
  const feature = "live-reserve-causal-head";
  const causal = { featureActivationReplayKey: feature, causalBarrierKeys: [`feature:${feature}`] };
  const { monitor, calls, records, advance } = await harness(t, {
    count: 5, ordinaryUnclassified: true, queueIsolation: true, hostCooldownMs: 1_000,
    queueLimits: smallIsolatedQueueLimits, emptyReceiptIndexes: [1, 4],
    recordOverrides: { 1: causal, 4: { ...causal, queueCapacityLane: "live" } },
  });
  const headHash = records[1].record.transactionHash;
  const liveHash = records[4].record.transactionHash;
  advance(86_400_000);
  await monitor.processRealtimeQueue();
  const first = await monitor.getState();
  assert.deepEqual(calls.proofOrder, [headHash], "the older causal head inherits the live task's priority");
  assert.equal(first._health.backgroundDeepWork.workClass, "dependency");
  assert.equal(first.seenTransactions[headHash], records[1].record.blockNumber);
  assert.ok(first.realtimePendingEntries[liveHash], "the live descendant stays durable until its own proof");
  assert.equal(first.seenTransactions[liveHash], undefined);
  for (let slot = 0; slot < 5 && !(await monitor.getState()).seenTransactions[liveHash]; slot++) {
    advance(1_000);
    await monitor.processRealtimeQueue();
  }
  const after = await monitor.getState();
  assert.equal(after.seenTransactions[liveHash], records[4].record.blockNumber);
  assert.ok(calls.proofOrder.indexOf(headHash) < calls.proofOrder.indexOf(liveHash));
  assert.ok(Object.keys(after.realtimePendingEntries).length > 0,
    "bounded old-work fairness must not require clearing the unrelated backlog first");
  assert.equal(after.lastFinalizedBlock, 99);
});

test("ordinary live deferred work survives base pressure while respecting host and record retry deadlines", async t => {
  const { monitor, calls, records, advance } = await harness(t, {
    count: 4, deferredPrefix: 4, ordinaryUnclassified: true, queueIsolation: true,
    hostCooldownMs: 5_000, deferredNextAttemptMs: { 3: 10_000 },
    queueLimits: smallIsolatedQueueLimits, recordOverrides: { 3: { queueCapacityLane: "live" } },
  });
  const liveHash = records[3].record.transactionHash;
  const before = await monitor.getState();
  assert.equal(before._health.queuePressure.historyPaused, true);
  assert.equal(Object.keys(before.realtimePendingEntries).length, 0);
  await monitor.retryDeferredCreationEvidence();
  assert.deepEqual(calls.proofOrder, [], "persisted host backoff is not bypassed by a live reservation");
  assert.deepEqual((await monitor.getState()).deferredCreationEvidence, before.deferredCreationEvidence);
  advance(6_000);
  await monitor.retryDeferredCreationEvidence();
  assert.deepEqual(calls.proofOrder, [], "host recovery does not bypass the deferred candidate's nextAttemptAt");
  assert.deepEqual((await monitor.getState()).deferredCreationEvidence, before.deferredCreationEvidence);
  advance(5_000);
  await monitor.retryDeferredCreationEvidence();
  const after = await monitor.getState();
  assert.deepEqual(calls.proofOrder, [liveHash], "an independent live deferred task needs no queued causal descendant");
  assert.equal(after.seenTransactions[liveHash], records[3].record.blockNumber);
  assert.equal(after.deferredCreationEvidence[liveHash], undefined);
  assert.equal(after._health.queuePressure.historyPaused, true, "base backlog remains paused after the live slot is released");
  assert.equal(after._health.queuePressure.completed, 1);
  assert.equal(calls.tx, 1);
  assert.equal(calls.receipt, 1);
  assert.equal(calls.block, 1);
  for (const { record } of records.slice(0, 3)) {
    assert.deepEqual(after.deferredCreationEvidence[record.transactionHash], before.deferredCreationEvidence[record.transactionHash]);
    assert.equal(after.seenTransactions[record.transactionHash], undefined);
  }
  assert.equal(after.lastFinalizedBlock, 99);
});

test("live deferred urgency closes a multi-key predecessor chain without opening unrelated deferred backlog", async t => {
  const feature = "live-reserve-cross-key";
  const generation = "live-reserve-predecessor";
  const { monitor, calls, records, advance } = await harness(t, {
    count: 6, deferredPrefix: 6, ordinaryUnclassified: true, queueIsolation: true,
    hostCooldownMs: 1_000, queueLimits: smallIsolatedQueueLimits, emptyReceiptIndexes: [2, 3, 4],
    recordOverrides: {
      2: { flapQuoteFirstThreeReplayGenerationKey: generation, causalBarrierKeys: [`first3:${generation}`] },
      3: { featureActivationReplayKey: feature, flapQuoteFirstThreeReplayGenerationKey: generation,
        causalBarrierKeys: [`feature:${feature}`, `first3:${generation}`] },
      4: { featureActivationReplayKey: feature, causalBarrierKeys: [`feature:${feature}`], queueCapacityLane: "live" },
    },
  });
  const before = await monitor.getState();
  assert.equal(Object.keys(before.realtimePendingEntries).length, 0);
  assert.equal(before._health.queuePressure.historyPaused, true);
  const orderedHashes = [2, 3, 4].map(index => records[index].record.transactionHash);
  for (let index = 0; index < orderedHashes.length; index++) {
    advance(2_000);
    await monitor.awaitIdle();
    const attempted = await monitor.retryDeferredCreationEvidence();
    const step = await monitor.getState();
    assert.deepEqual(calls.proofOrder, orderedHashes.slice(0, index + 1),
      `the all-keys causal head must be proved first even when every participant is deferred: ${JSON.stringify({ attempted, health: step._health })}`);
    assert.equal(step.seenTransactions[orderedHashes[index]], records[index + 2].record.blockNumber);
    assert.equal(step._health.backgroundDeepWork.workClass, index < 2 ? "dependency" : "fresh");
    assert.equal(step._health.queuePressure.historyPaused, true);
    for (const hash of orderedHashes.slice(index + 1)) {
      assert.ok(step.deferredCreationEvidence[hash]);
      assert.equal(step.seenTransactions[hash], undefined);
    }
  }
  const after = await monitor.getState();
  for (const index of [0, 1, 5]) {
    const hash = records[index].record.transactionHash;
    assert.deepEqual(after.deferredCreationEvidence[hash], before.deferredCreationEvidence[hash]);
    assert.equal(after.seenTransactions[hash], undefined);
  }
  assert.equal(after._health.queuePressure.completed, 3);
  assert.equal(after.lastFinalizedBlock, 99);
});
