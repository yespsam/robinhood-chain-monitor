import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNarrativeSniperRuntime } from "../src/narrative-sniper-runtime.js";

const QUOTE = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TARGET = "0xa11ce00000000000000000000000000000000001";
const POOL = "0xb001000000000000000000000000000000000001";
const TX = `0x${"ab".repeat(32)}`;
const BLOCK = `0x${"cd".repeat(32)}`;
const NEWS_AT = "2026-09-06T08:00:00.000Z";
const POOL_AT = "2026-09-06T08:01:00.000Z";
const NOW = Date.parse("2026-09-06T08:02:00.000Z");

function contextEvent() {
  return {
    type: "platform_capability_update",
    kind: "flap_quote_asset_enabled",
    changeType: "added",
    eventKey: `flap-quote:56:${TX}:7`,
    platform: { id: "flap", name: "Flap" },
    chainId: 56,
    chain: { id: 56, chainId: 56 },
    source: {
      id: "flap_portal_quote_configuration",
      url: "https://flap.sh/board",
      trust: "official_docs_bound_fingerprinted_portal_receipt",
      official: true,
    },
    sourceUrl: "https://flap.sh/board",
    transactionHash: TX,
    blockHash: BLOCK,
    blockNumber: 100,
    logIndex: 7,
    blockTimestamp: POOL_AT,
    occurredAt: POOL_AT,
    observedAt: POOL_AT,
    onchainProof: { receiptVerified: true, canonicalBlockVerified: true, transactionVerified: true },
    changes: { newFlapPools: [{
      kind: "quote_asset",
      quoteAddress: QUOTE,
      quoteSymbol: "NVDAB",
      quoteName: "NVIDIA Corp",
      chainId: 56,
      sourceUrl: "https://flap.sh/board",
    }] },
    signal: { quotePairChange: { stage: "live" } },
  };
}

function targetEvent() {
  const generation = `quote:${QUOTE}:generation:${BLOCK}:${TX}:7`;
  return {
    type: "bsc_launchpad_update",
    kind: "flap_pool_token",
    eventKey: `bsc-flap-pool-token:${generation}:1:${TARGET}`,
    chainId: 56,
    featurePlatform: "flap",
    featureActivationKey: generation,
    featureGenerationKey: generation,
    featureTrackedToken: true,
    featureTokenOrdinal: 1,
    featureFirstToken: true,
    transactionHash: TX,
    blockHash: BLOCK,
    blockNumber: 101,
    logIndex: 8,
    blockTimestamp: POOL_AT,
    observedAt: POOL_AT,
    tokens: [{ token: TARGET }],
    pools: [{ token0: TARGET, token1: QUOTE, pool: POOL, verifiedDex: true }],
    mode: { quoteAsset: QUOTE },
    structural: { eligible: true, causalTokenEvent: true },
    featureTokenProof: {
      activationId: generation,
      activationEventKey: `flap-quote:56:${TX}:7`,
      quoteAddress: QUOTE,
      tokenAddress: TARGET,
      pairAddress: POOL,
      canonical: true,
    },
  };
}

function liveAssessment() {
  const asOf = new Date(NOW).toISOString();
  return {
    targetEvidence: { chainId: 56, ca: TARGET, poolAddress: POOL, poolVerified: true, caVerified: true, symbol: "JENSEN" },
    marketEvidence: {
      asOf,
      dataHealth: "healthy",
      dataHealthy: true,
      coverageComplete: true,
      coverageGap: false,
      liquidityUsd: 100_000,
      minimumLiquidityUsd: 25_000,
      estimatedSlippageBps: 80,
      maximumSlippageBps: 300,
      marketConfirmed: true,
      momentumConfirmed: true,
      walletClusterConfirmed: false,
      entryWindow: "open",
      shadowNotionalUsd: 25,
    },
    riskEvidence: {
      asOf,
      coverageComplete: true,
      coverageGap: false,
      sellability: "verified_sellable",
      sellable: true,
      cannotSell: false,
      riskLevel: "low",
      highRisk: false,
      honeypot: false,
      ownerCanMint: false,
      ownerCanBlacklist: false,
      ownerCanFreeze: false,
      ownerCanPause: false,
      dynamicTax: false,
    },
  };
}

test("the production runtime joins evidence, persists an on-chain shadow intent, and emits one verified signal", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-sniper-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sent = [];
  const runtime = createNarrativeSniperRuntime({
    dataDir,
    narrativeSniperEnabled: true,
    narrativeSniperEvaluationIntervalMs: 60_000,
    narrativeSniperAutoStart: false,
    narrativeSniperAutoCheckOnObserve: false,
  }, {
    now: () => NOW,
    narrativeAdapter: (event) => event?.type === "verified_news" ? {
      evidenceKey: event.eventKey,
      contextAssetKeys: [`eip155:56/erc20:${QUOTE}`],
      narrativeEvidence: {
        verified: true,
        sourceKind: "official_release",
        sourceUrl: "https://investor.nvidia.com/news/example",
        publishedAt: NEWS_AT,
        headline: { zh: "NVIDIA 发布 AI 平台", en: "NVIDIA launches an AI platform" },
        subjectMatch: true,
        strength: 90,
        novelty: 90,
        mechanismConfidence: 85,
      },
    } : null,
    liveEvidenceProvider: { assess: async () => liveAssessment(), stop: async () => {} },
    sendAlertsImpl: async (_config, event) => {
      sent.push(structuredClone(event));
      return { status: "persisted", eventKey: event.eventKey };
    },
  });
  await runtime.ready;
  const news = { type: "verified_news", eventKey: "news:nvda:1", title: "NVIDIA launches AI", observedAt: NEWS_AT };
  for (const event of [news, contextEvent(), targetEvent()]) await runtime.sendAlert({}, event);
  const result = await runtime.check();
  assert.equal(result.status, "healthy");
  const signalEvent = sent.find((event) => event.type === "narrative_trade_signal");
  assert.equal(signalEvent?.signal?.decision, "do");
  assert.equal(signalEvent.signal.event.publishedAt, NEWS_AT);
  assert.equal(signalEvent.signal.event.poolOccurredAt, POOL_AT);
  assert.equal(signalEvent.signal.shadowOrder.executable, false);
  const ledger = await runtime.getLedgerState();
  const [order] = Object.values(ledger.orders);
  assert.equal(order.status, "created");
  assert.equal(order.target.ca, TARGET);
  assert.equal(order.sourceProof.kind, "onchain");
  assert.equal(order.sourceProof.blockNumber, 101);
  assert.equal(order.sourceProof.blockHash, BLOCK);
  assert.equal(order.sourceProof.transactionHash, TX);
  assert.equal(order.sourceProof.logIndex, 8);
  assert.equal(order.sourceProof.stableEventKey, targetEvent().eventKey);
  assert.equal(sent.filter((event) => event.type === "narrative_trade_signal").length, 1);
  await runtime.stop();
});

test("an alert delivery failure remains authoritative even when local narrative admission succeeds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-sniper-runtime-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const runtime = createNarrativeSniperRuntime({ dataDir, narrativeSniperEnabled: true }, {
    now: () => NOW,
    narrativeAdapter: () => null,
    liveEvidenceProvider: { assess: async () => ({}), stop: async () => {} },
    ledger: { ready: Promise.resolve(), stop: async () => {}, getState: async () => ({ orders: {} }) },
    sendAlertsImpl: async () => { throw new Error("durable outbox unavailable"); },
    logger: { error: () => {} },
  });
  await assert.rejects(runtime.sendAlert({}, { type: "test_news", eventKey: "news:1" }), /outbox unavailable/u);
  const state = await runtime.getState();
  assert.equal(Object.keys(state.inbox).length, 1, "local admission remains durable for audit/retry");
  await runtime.stop();
});

test("optional narrative admission never delays the primary alert and shutdown still drains it", async () => {
  let releaseAdmission;
  const admissionGate = new Promise((resolve) => { releaseAdmission = resolve; });
  let admissionStarted = false;
  let admissionFinished = false;
  let monitorStopped = false;
  const runtime = createNarrativeSniperRuntime({ narrativeSniperEnabled: true }, {
    narrativeAdapter: () => null,
    liveEvidenceProvider: { stop: async () => {} },
    ledger: { ready: Promise.resolve(), stop: async () => {} },
    monitor: {
      observe: async () => {
        admissionStarted = true;
        await admissionGate;
        admissionFinished = true;
        return { status: "admitted" };
      },
      check: async () => ({ status: "healthy" }),
      getState: async () => ({}),
      stop: async () => { monitorStopped = true; },
    },
    sendAlertsImpl: async () => ({ status: "persisted" }),
  });

  const delivery = await runtime.sendAlert({}, { type: "test_news", eventKey: "news:fast" });
  assert.equal(delivery.status, "persisted");
  assert.equal(admissionStarted, true);
  assert.equal(admissionFinished, false, "the primary alert must not await optional local fsync work");

  let stopFinished = false;
  const stopping = runtime.stop().then(() => { stopFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopFinished, false);
  assert.equal(monitorStopped, false, "the monitor remains available until its accepted flight drains");
  releaseAdmission();
  await stopping;
  assert.equal(admissionFinished, true);
  assert.equal(monitorStopped, true);
});

test("concurrent runtime stops share one drain and cannot resolve ahead of durable shutdown", async () => {
  let releaseMonitorStop;
  const monitorStopGate = new Promise((resolve) => { releaseMonitorStop = resolve; });
  const stopCalls = { monitor: 0, evidence: 0, ledger: 0 };
  const runtime = createNarrativeSniperRuntime({ narrativeSniperEnabled: true }, {
    narrativeAdapter: () => null,
    liveEvidenceProvider: {
      stop: async () => { stopCalls.evidence += 1; },
    },
    ledger: {
      ready: Promise.resolve(),
      stop: async () => { stopCalls.ledger += 1; },
    },
    monitor: {
      observe: async () => ({ status: "ignored" }),
      check: async () => ({ status: "healthy" }),
      getState: async () => ({}),
      stop: async () => {
        stopCalls.monitor += 1;
        await monitorStopGate;
      },
    },
    sendAlertsImpl: async () => ({ status: "persisted" }),
  });

  const first = runtime.stop();
  const second = runtime.stop();
  assert.equal(first, second);
  let secondFinished = false;
  void second.then(() => { secondFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondFinished, false);
  assert.deepEqual(stopCalls, { monitor: 1, evidence: 0, ledger: 0 });
  releaseMonitorStop();
  await Promise.all([first, second]);
  assert.deepEqual(stopCalls, { monitor: 1, evidence: 1, ledger: 1 });
  assert.equal(runtime.stop(), first, "a completed stop remains the canonical shutdown result");
});

test("the runtime exposes and drains an explicitly enabled shadow lifecycle without changing primary delivery", async () => {
  const stopped = [];
  const shadowSimulator = {
    ready: Promise.resolve(true),
    check: async () => ({ status: "healthy", actions: [{ type: "marked", mode: "shadow", executable: false }] }),
    getState: async () => ({ schema: "narrative_shadow_simulator_v1", executable: false }),
    getMetrics: async () => ({ schema: "narrative_shadow_simulator_metrics_v1", executable: false }),
    stop: async () => { stopped.push("simulator"); },
  };
  const runtime = createNarrativeSniperRuntime({
    narrativeSniperEnabled: true,
    narrativeShadowSimulatorEnabled: true,
  }, {
    narrativeAdapter: () => null,
    liveEvidenceProvider: { stop: async () => { stopped.push("evidence"); } },
    ledger: {
      ready: Promise.resolve(true),
      getState: async () => ({ orders: {} }),
      getMetrics: async () => ({ totalOrders: 0 }),
      stop: async () => { stopped.push("ledger"); },
    },
    monitor: {
      observe: async () => ({ status: "ignored" }),
      check: async () => ({ status: "healthy" }),
      getState: async () => ({}),
      stop: async () => { stopped.push("monitor"); },
    },
    shadowSimulator,
    sendAlertsImpl: async () => ({ status: "persisted" }),
  });

  await runtime.ready;
  assert.equal(runtime.shadowSimulator, shadowSimulator);
  assert.equal((await runtime.checkShadowSimulation()).actions[0].executable, false);
  assert.equal((await runtime.getShadowSimulationState()).executable, false);
  assert.equal((await runtime.getShadowSimulationMetrics()).executable, false);
  const delivery = await runtime.sendAlert({}, { type: "test_news", eventKey: "news:shadow-runtime" });
  assert.equal(delivery.status, "persisted");
  await runtime.stop();
  assert.deepEqual(stopped, ["monitor", "simulator", "evidence", "ledger"]);
});
