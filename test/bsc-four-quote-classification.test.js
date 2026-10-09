import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Interface } from "ethers";
import { createBscLaunchpadMonitor, readBscLaunchpadDurableState, compareBscPressureDrainEntries } from "../src/bsc-launchpad-monitor.js";
import { bscPressureReliefWorkClass } from "../src/bsc-queue-pressure.js";

const manager = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const token = `0x${"1".repeat(40)}`, creator = `0x${"2".repeat(40)}`;
const quote = `0x${"3".repeat(40)}`, otherQuote = `0x${"4".repeat(40)}`;
const hash = `0x${"a1".repeat(32)}`, blockHash = `0x${"a2".repeat(32)}`;
const iface = new Interface([
  "event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 raisedAmount,uint256 reservedAmount)",
  "function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)",
]);
const clock = Date.parse("2026-09-30T15:00:00Z");
const timestamp = Math.floor(clock / 1000) - 3600;
const activation = (key, address = otherQuote) => ({ key, type: "quote_config", quoteAddress: address,
  quoteFingerprint: `fingerprint-${key}`, active: true, allowReplay: true,
  firstObservedAt: new Date(clock - 7_200_000).toISOString(), confirmedAt: new Date(clock - 7_200_000).toISOString() });

test("continuous quote preparation cannot starve the existing final pressure-drain slot", () => {
  const work = { leasesSinceRelief: 2, hasDrain: true, hasPrepareDrain: true, hasPrepareQuote: true, hasSla: false };
  for (let batch = 0; batch < 10; batch++) assert.equal(bscPressureReliefWorkClass(work), "drain");
  assert.equal(bscPressureReliefWorkClass({ ...work, hasDrain: false }), "prepareDrain");
  assert.equal(bscPressureReliefWorkClass({ ...work, hasDrain: false, hasPrepareDrain: false }), "prepareQuote");
  assert.equal(bscPressureReliefWorkClass({ ...work, hasDrain: false, hasPrepareDrain: false, hasSla: true }), null);
  assert.equal(bscPressureReliefWorkClass({ ...work, leasesSinceRelief: 1 }), null);
});

test("independent pressure drain frees durable live reservations before older base-pool work", () => {
  const base = { transactionHash: hash, blockNumber: 99, transactionIndex: 0, logIndex: 0,
    fourMemeCreationHotCandidates: new Map([["base", {}]]) };
  const live = { transactionHash: `0x${"b1".repeat(32)}`, blockNumber: 100, transactionIndex: 0, logIndex: 0,
    queueCapacityLane: "live", fourMemeCreationHotCandidates: new Map() };
  assert.deepEqual([base, live].sort(compareBscPressureDrainEntries), [live, base]);
  assert.ok(compareBscPressureDrainEntries({ ...base, queueCapacityLane: "live" }, live) < 0,
    "same-pool cost and canonical-age ordering remain intact");
});

async function harness(t, options = {}) {
  let currentClock = clock + (options.timeOffsetMs || 0);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-exact-four-quote-"));
  if (options.scanFloor) await fs.writeFile(path.join(dataDir, "bsc-scan-policy.json"), JSON.stringify({
    version: 1, mode: "live_only", fromBlock: options.scanFloor,
    activatedAt: new Date(clock - 86_400_000).toISOString(),
  }));
  const features = Object.fromEntries(Array.from({ length: options.count || 1 }, (_, n) => [`q${n}`, activation(`q${n}`, options.match ? quote : otherQuote)]));
  if (options.template) features.template = { ...activation("template"), type: "template", verificationLane: "official_token_api", templateId: "unindexed" };
  const keys = Object.keys(features).map(key => `feature:${key}`).sort();
  const record = { transactionHash: hash, blockHash, blockNumber: 100, transactionIndex: 0, logIndex: 0,
    reasons: ["http_tail"], candidateTokens: [token], hasProtocolTrigger: true, causalBarrierKeys: keys,
    ...(options.verified ? { verifiedNewContracts: [token] } : {}),
    ...(options.explicit ? { featureActivationReplayKey: "q0" } : {}),
    ...(options.live ? { queueCapacityLane: "live" } : {}),
  };
  record.causalReceiptClassificationDigest = createHash("sha256").update(JSON.stringify([
    hash, blockHash, 100, 0, 0, record.featureActivationReplayKey || null, null, keys,
  ])).digest("hex");
  if (options.unclassified) delete record.causalReceiptClassificationDigest;
  const seed = options.seed || { version: 6, initializedAt: new Date(clock - 60_000).toISOString(), lastFinalizedBlock: 99,
    realtimeTailNextBlock: 5000, realtimePendingEntries: { [hash]: record }, launchers: {}, hooks: {}, seenTransactions: {}, coverageGaps: [],
    officialSources: { fourMeme: { featureActivations: features } } };
  if (options.blockedHead) {
    const earlierHash = `0x${"cc".repeat(32)}`, earlierBlockHash = `0x${"dd".repeat(32)}`;
    seed.deferredCreationEvidence = { [earlierHash]: {
      transactionHash: earlierHash, blockHash: earlierBlockHash, blockNumber: 99, transactionIndex: 0, logIndex: 0,
      reasons: ["known_launch", "http_tail"], causalBarrierKeys: keys,
      attempts: 10, nextAttemptAt: new Date(currentClock + 3_600_000).toISOString(),
      causalReceiptClassificationDigest: createHash("sha256").update(JSON.stringify([
        earlierHash, earlierBlockHash, 99, 0, 0, null, null, keys,
      ])).digest("hex"),
    } };
  }
  await fs.writeFile(path.join(dataDir, "bsc-launchpad-state.json"), JSON.stringify(seed));
  const counts = { call: 0, code: 0, block: 0, external: 0, transaction: 0, maxConcurrentObjects: 0 };
  let activeObjects = 0;
  const objectRead = async value => {
    activeObjects++;
    counts.maxConcurrentObjects = Math.max(counts.maxConcurrentObjects, activeObjects);
    try {
      if (options.singleObjectSlot) {
        assert.equal(activeObjects, 1, "one background host slot must not race its own object reads");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return value;
    } finally { activeObjects--; }
  };
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreate"), [creator, token, 1n, "Ordinary", "OLD", 100n, 0n, 0n]);
  const log = { address: options.emitter || manager, ...encoded, transactionHash: hash, blockHash, blockNumber: 100, transactionIndex: 0, logIndex: 0 };
  const provider = {
    async getNetwork() { return { chainId: 56n }; }, async getBlockNumber() { return 5002; }, async send() { return []; },
    async getTransaction(requestedHash) { counts.transaction++; assert.equal(requestedHash, hash); return objectRead({ hash, blockNumber: 100, blockHash, index: 0, to: manager, from: creator, data: "0x12345678" }); },
    async getTransactionReceipt() { return objectRead({ hash, transactionHash: hash, blockNumber: 100, blockHash, index: 0, status: 1, logs: [log] }); },
    async getBlock() { counts.block++; return { number: 100,
      hash: options.reorg && counts.block >= options.reorg ? `0x${"b2".repeat(32)}` : blockHash,
      timestamp, transactions: [hash] }; },
    async getCode() { counts.code++; throw new Error("full runtime inspection deliberately unavailable"); },
    async call(request) {
      counts.call++;
      assert.equal(request.to.toLowerCase(), manager);
      assert.equal(request.blockTag, 100, "never classify with latest-state fallback");
      assert.equal(request.data, iface.encodeFunctionData("_tokenInfos", [token]));
      if (options.onCall) await options.onCall(monitor);
      if (options.callError) throw options.callError;
      return iface.encodeFunctionResult("_tokenInfos", [options.wrongBase ? creator : token,
        options.zeroQuote ? `0x${"0".repeat(40)}` : quote, 1n, 100n, 0n, 0n, 1n, 0n, 0n, 0n, 0n, 0n, 1n]);
    }, destroy() {},
  };
  class IdleWebSocket { addEventListener() {} close() {} }
  const config = { dataDir, monitorScope: "focus3", bscMonitorEnabled: Boolean(options.scheduler),
    bscQueueIsolationEnabled: Boolean(options.live),
    bscSharedRpcEnabled: Boolean(options.singleObjectSlot),
    bscWsUrl: "wss://example.invalid", bscRpcUrl: "https://example.invalid" };
  const monitor = createBscLaunchpadMonitor(config, {
    autoStart: false, externalAttribution: false, provider, initialHeadForTesting: 5002, now: () => currentClock,
    WebSocketImpl: IdleWebSocket, backgroundSetTimeoutImpl: () => ({ unref() {} }), backgroundClearTimeoutImpl() {},
    journalSetTimeoutImpl: () => ({ unref() {} }), journalClearTimeoutImpl() {},
    fetchImpl: async () => { counts.external++; throw new Error("external API unavailable"); },
    sendAlertsImpl: async () => assert.fail("classification must never emit a trade/alert"), logger: { error() {}, info() {} },
    ...(options.dependencies || {}),
  });
  t.after(async () => { await monitor.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await monitor.getState();
  return { monitor, counts, dataDir, advance(ms) { currentClock += ms; },
    async run() { await monitor.awaitIdle(); await monitor.processRealtimeQueue(); await monitor.awaitIdle(); return monitor.getState(); } };
}

test("already-classified Classic Four with 82 unrelated quote barriers finishes without getCode", async t => {
  const h = await harness(t, { count: 82, live: true, scanFloor: 90 });
  const s = await h.run();
  assert.equal(s.seenTransactions[hash], 100, JSON.stringify(s.transactionFailures));
  assert.equal(s.realtimePendingEntries[hash], undefined);
  assert.equal(s._health.queuePressure.ordinaryDiscoveryCompleted, 1);
  assert.equal(h.counts.call, 1); assert.equal(h.counts.code, 0); assert.equal(h.counts.external, 0);
  assert.equal(h.counts.block, 2, "canonical block is checked on both sides of the historical call");
  assert.ok(s.officialSources.fourMeme.creationEventHotIndex.some(item => item.transactionHash === hash));
  assert.equal(s._health.queuePressure.liveReservedPending, 0);
  for (const feature of Object.values(s.officialSources.fourMeme.featureActivations)) {
    assert.equal(feature.active, true, "a proven candidate non-match does not retire the activation");
    assert.ok(!feature.replayCompletedAt && !feature.firstToken);
    assert.equal(feature.replayAttemptedCandidateKeys.length, 1, "store the exact candidate exclusion once");
  }
});

test("matching quote contracts only nonmatching old keys and retains full runtime gate", async t => {
  const h = await harness(t, { match: true });
  const s = await h.run();
  assert.equal(s.seenTransactions[hash], undefined);
  assert.deepEqual(s.realtimePendingEntries[hash].causalBarrierKeys, ["feature:q0"]);
  assert.equal(s.realtimePendingEntries[hash].fourMemeManagerQuoteProof.version, 1);
  assert.equal(h.counts.call, 1); assert.equal(h.counts.code, 1);
});

test("exact quote proof serializes its transaction and receipt on a shared single background slot", async t => {
  const h = await harness(t, { singleObjectSlot: true, live: true, scanFloor: 90 });
  const s = await h.run();
  assert.equal(s.seenTransactions[hash], 100, JSON.stringify(s.transactionFailures));
  assert.equal(h.counts.maxConcurrentObjects, 1);
  assert.equal(h.counts.call, 1);
  assert.equal(h.counts.code, 0);
});

for (const scenario of [
  { name: "historical RPC failure", callError: Object.assign(new Error("missing trie node"), { code: "UNKNOWN_ERROR" }) },
  { name: "wrong manager token identity", wrongBase: true },
  { name: "canonical fork changes during manager read", reorg: 2 },
  { name: "canonical fork changes before manager read", reorg: 1 },
]) test(`${scenario.name} cannot release quote barriers or mark completion`, async t => {
  const h = await harness(t, scenario);
  const s = await h.run();
  assert.equal(s.seenTransactions[hash], undefined);
  const record = s.realtimePendingEntries[hash] || s.deferredCreationEvidence[hash];
  assert.deepEqual(record.causalBarrierKeys, ["feature:q0"]);
  assert.equal(record.fourMemeManagerQuoteProof, undefined);
  assert.ok(h.counts.call <= 1, "no latest-state fallback or looping retry");
});

test("native zero-address quote is a valid exact nonmatching manager result", async t => {
  const h = await harness(t, { zeroQuote: true });
  const s = await h.run(); assert.equal(s.seenTransactions[hash], 100); assert.equal(h.counts.code, 0);
});

test("matching proof survives restart and reuses manager read only after a fresh canonical block", async t => {
  const first = await harness(t, { match: true });
  await first.run();
  const durable = await readBscLaunchpadDurableState(path.join(first.dataDir, "bsc-launchpad-state.json"));
  assert.ok(durable.realtimePendingEntries[hash].fourMemeManagerQuoteProof);
  const second = await harness(t, { seed: durable, timeOffsetMs: 60_000 });
  const s = await second.run();
  assert.equal(s.seenTransactions[hash], undefined); assert.equal(second.counts.call, 0);
  assert.equal(second.counts.block, 1); assert.equal(second.counts.code, 1);
});

test("explicit quote replay and unrelated template retain original full inspection", async t => {
  for (const options of [{ explicit: true }, { template: true }]) {
    const h = await harness(t, options); const s = await h.run();
    assert.equal(s.seenTransactions[hash], undefined);
    assert.ok(h.counts.code > 0 || h.counts.external > 0);
    if (options.explicit) { assert.equal(h.counts.call, 0); assert.deepEqual(s.realtimePendingEntries[hash].causalBarrierKeys, ["feature:q0"]); }
    if (options.template) assert.ok(s.realtimePendingEntries[hash].causalBarrierKeys.includes("feature:template"));
  }
});

test("a concurrently registered quote activation is not covered by the earlier manager proof", async t => {
  const h = await harness(t, { onCall: async monitor => {
    await monitor.registerFourMemeFeatureActivations([{
      quoteConfig: { symbol: "NEW", address: quote, fingerprint: "new-quote-generation" },
      observedAt: new Date(clock - 7_200_000).toISOString(),
    }], { awaitReplay: false });
  } });
  const s = await h.run();
  assert.equal(s.seenTransactions[hash], undefined);
  const record = s.realtimePendingEntries[hash] || s.deferredCreationEvidence[hash];
  assert.ok(record.causalBarrierKeys.some(key => key !== "feature:q0"));
  assert.equal(record.causalBarrierKeys.includes("feature:q0"), false);
  assert.deepEqual(record.fourMemeManagerQuoteProof.coveredActivations.map(item => item.key), ["q0"]);
  assert.ok(h.counts.code > 0, "a new unresolved feature retains full inspection");
});

test("failed quote proof WAL append rolls back keys and cannot release the live reservation", async t => {
  let failProof = true;
  const h = await harness(t, { live: true, dependencies: {
    async journalAppendImpl(file, frame) {
      if (failProof && frame.includes('"fourMemeManagerQuoteProof"')) throw new Error("fixture quote proof fsync failed");
      const handle = await fs.open(file, "a", 0o600);
      try { await handle.writeFile(frame); await handle.sync(); } finally { await handle.close(); }
    },
  } });
  try {
    const s = await h.run();
    const durable = await readBscLaunchpadDurableState(path.join(h.dataDir, "bsc-launchpad-state.json"));
    for (const snapshot of [s, durable]) {
      const record = snapshot.realtimePendingEntries[hash] || snapshot.deferredCreationEvidence[hash];
      assert.deepEqual(record.causalBarrierKeys, ["feature:q0"]);
      assert.equal(record.fourMemeManagerQuoteProof, undefined);
      assert.equal(record.queueCapacityLane, "live");
      assert.equal(snapshot.seenTransactions[hash], undefined);
    }
  } finally { failProof = false; }
});

test("paused pre-cutover records remain byte-equivalent and receive no manager or runtime reads", async t => {
  const h = await harness(t, { live: true, scanFloor: 101 });
  const before = await h.monitor.getState();
  const after = await h.run();
  assert.deepEqual(after.realtimePendingEntries, before.realtimePendingEntries);
  assert.equal(after.lastFinalizedBlock, before.lastFinalizedBlock);
  assert.equal(after.seenTransactions[hash], undefined);
  assert.equal(h.counts.call + h.counts.code + h.counts.transaction, 0);
});

test("restarted manager proof cannot finish on a different canonical block", async t => {
  const first = await harness(t, { match: true });
  await first.run();
  const seed = await readBscLaunchpadDurableState(path.join(first.dataDir, "bsc-launchpad-state.json"));
  const second = await harness(t, { seed, timeOffsetMs: 60_000, reorg: 1 });
  const after = await second.run();
  assert.equal(after.seenTransactions[hash], undefined);
  assert.deepEqual(after.realtimePendingEntries[hash].causalBarrierKeys, ["feature:q0"]);
  assert.equal(second.counts.call, 0);
  assert.equal(second.counts.code, 0);
});

test("receipt-only lane stays object-only and an aged classified live head reaches the exact quote deep lane", async t => {
  const h = await harness(t, { scheduler: true, live: true, scanFloor: 90, unclassified: true,
    dependencies: { causalClassificationEnabled: true, causalClassificationAutoSchedule: false,
      realtimePendingMaxEntries: 1,
      queueLimits: { pendingMax: 1, liveReserve: 1, historyHigh: 2, historyLow: 1, totalHigh: 3, totalLow: 1, totalMax: 4 },
    } });
  await h.monitor.start();
  await h.monitor.awaitIdle();
  const classification = await h.monitor.classifyCausalBacklog();
  assert.ok(classification.attempted > 0, JSON.stringify(classification));
  let snapshot = await h.monitor.getState();
  assert.ok(snapshot.realtimePendingEntries[hash].causalReceiptClassificationDigest);
  assert.equal(snapshot.realtimePendingEntries[hash].fourMemeManagerQuoteProof, undefined);
  assert.equal(snapshot.seenTransactions[hash], undefined);
  assert.equal(h.counts.call + h.counts.code, 0, "receipt classification never enters the EVM state-read lane");
  h.advance(31_000);
  snapshot = await h.run();
  assert.equal(snapshot.seenTransactions[hash], 100, JSON.stringify(snapshot._health.backgroundDeepWork));
  assert.equal(snapshot._health.queuePressure.liveReservedPending, 0);
  assert.equal(h.counts.call, 1);
  assert.equal(h.counts.code, 0);
});

for (const match of [false, true]) test(`bounded quote preparation behind a cooling predecessor ${match ? "retains a matching barrier" : "proves independence before separate completion"}`, async t => {
  const h = await harness(t, { scheduler: true, live: true, scanFloor: 90, unclassified: true,
    blockedHead: true, match, dependencies: {
      causalClassificationEnabled: true, causalClassificationAutoSchedule: false, realtimePendingMaxEntries: 1,
      queueLimits: { pendingMax: 1, liveReserve: 1, historyHigh: 2, historyLow: 1, totalHigh: 3, totalLow: 1, totalMax: 4 },
    } });
  await h.monitor.start(); await h.monitor.awaitIdle();
  await h.monitor.classifyCausalBacklog();
  const before = await h.monitor.getState();
  const predecessor = structuredClone(before.deferredCreationEvidence);
  let s = await h.run();
  assert.equal(s._health.backgroundDeepWork.workClass, "prepareQuote");
  assert.equal(s.seenTransactions[hash], undefined, "preparation never completes or spends an ordinal");
  assert.equal(s._health.queuePressure.liveReservedPending, 1);
  assert.ok(s.realtimePendingEntries[hash].fourMemeManagerQuoteProof);
  assert.deepEqual(s.realtimePendingEntries[hash].causalBarrierKeys, match ? ["feature:q0"] : []);
  assert.equal(h.counts.call, 1); assert.equal(h.counts.code, 0);
  h.advance(1_000);
  s = await h.run();
  assert.deepEqual(s.deferredCreationEvidence, predecessor, "a predecessor's retry deadline is not bypassed");
  assert.equal(h.counts.call, 1, "a successful quote proof is not polled repeatedly");
  if (match) {
    assert.equal(s.seenTransactions[hash], undefined);
    assert.equal(s._health.queuePressure.liveReservedPending, 1);
  } else {
    assert.equal(s.seenTransactions[hash], 100);
    assert.equal(s._health.queuePressure.liveReservedPending, 0);
    assert.equal(h.counts.code, 0);
  }
});
