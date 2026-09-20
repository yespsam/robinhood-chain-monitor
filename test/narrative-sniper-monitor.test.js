import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNarrativeSniperMonitor } from "../src/narrative-sniper-monitor.js";

const QUOTE = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TARGET = "0xa11ce00000000000000000000000000000000001";
const POOL = "0xb001000000000000000000000000000000000001";
const TX = `0x${"ab".repeat(32)}`;
const BLOCK = `0x${"cd".repeat(32)}`;
const NEWS_AT = "2026-09-06T08:00:00.000Z";
const POOL_AT = "2026-09-06T08:01:00.000Z";
const NOW = Date.parse("2026-09-06T08:02:00.000Z");
const CONTEXT_ASSET_KEY = `eip155:56/erc20:${QUOTE}`;
const DECISION_HASH = "1".repeat(64);

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-sniper-monitor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function newsEvent({ key = "news:nvda:1", type = "test_news" } = {}) {
  return { type, eventKey: key, observedAt: NEWS_AT, title: "NVIDIA launches a new AI platform" };
}

function flapContextEvent() {
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
    changes: {
      newFlapPools: [{
        kind: "quote_asset",
        quoteAddress: QUOTE,
        quoteSymbol: "NVDAB",
        quoteName: "NVIDIA Corp",
        chainId: 56,
        sourceUrl: "https://flap.sh/board",
      }],
    },
    signal: { quotePairChange: { stage: "live" } },
  };
}

function flapTargetEvent() {
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

function narrativeAdapter(raw) {
  if (!["test_news", "telegram_news_update"].includes(raw.type)) return null;
  return {
    evidenceKey: raw.eventKey,
    contextAssetKeys: [CONTEXT_ASSET_KEY],
    narrativeEvidence: {
      verified: true,
      sourceKind: "official_release",
      sourceUrl: "https://investor.nvidia.com/news/example",
      publishedAt: NEWS_AT,
      headline: { zh: "NVIDIA 发布新 AI 平台", en: "NVIDIA launches a new AI platform" },
      subjectMatch: true,
      strength: 90,
      novelty: 90,
      mechanismConfidence: 85,
    },
  };
}

function doSignal(input, hash = DECISION_HASH) {
  return {
    version: 1,
    decision: "do",
    decisionHash: hash,
    inputEventKey: input.event.eventKey,
    shadowOrder: {
      mode: "shadow",
      executable: false,
      side: "buy",
      chainId: input.targetEvidence.chainId,
      ca: input.targetEvidence.ca,
      poolAddress: input.targetEvidence.poolAddress,
    },
  };
}

function liveAssessment() {
  return {
    targetEvidence: { chainId: 56, ca: TARGET, poolAddress: POOL, poolVerified: true },
    marketEvidence: { marketConfirmed: true },
    riskEvidence: { sellability: "verified_sellable" },
  };
}

function monitorFixture(dataDir, overrides = {}) {
  const calls = { adapt: 0, assess: 0, derive: 0, send: 0, ledger: 0 };
  let monitor;
  const dependencies = {
    now: () => NOW,
    narrativeAdapter: async (raw) => {
      calls.adapt += 1;
      return narrativeAdapter(raw);
    },
    liveEvidenceProvider: {
      assess: async (candidate) => {
        calls.assess += 1;
        assert.equal(candidate.context.contextAssetKey, CONTEXT_ASSET_KEY);
        assert.equal(candidate.target.ca, TARGET);
        return liveAssessment();
      },
    },
    deriveSignal: async (input) => {
      calls.derive += 1;
      assert.equal(input.event.occurredAt, NEWS_AT, "pool time must not masquerade as news publication time");
      assert.equal(input.event.poolOccurredAt, POOL_AT);
      return doSignal(input);
    },
    sendSignal: async (signal) => {
      calls.send += 1;
      const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "narrative-sniper-state.json"), "utf8"));
      assert.equal(persisted.signals[signal.decisionHash].signal.decision, "do", "signal must be durable before send");
      return { status: "sent" };
    },
    ledger: {
      admit: async (signal, metadata) => {
        calls.ledger += 1;
        assert.equal(signal.decision, "do");
        assert.equal(metadata.mode, "shadow");
        assert.deepEqual(metadata.sourceProof, {
          eventKey: signal.event?.eventKey || signal.inputEventKey,
          stableEventKey: flapTargetEvent().eventKey,
          chainId: 56,
          blockNumber: 101,
          blockHash: BLOCK,
          transactionHash: TX,
          logIndex: 8,
          observedAt: POOL_AT,
        });
        return { status: "admitted" };
      },
    },
    ...overrides,
  };
  monitor = createNarrativeSniperMonitor({ dataDir, narrativeSniperAutoCheckOnObserve: false }, dependencies);
  return { monitor, calls };
}

for (const order of ["news-first", "pool-first"]) {
  test(`${order} admission joins only after exact context and target, then persists before shadow side effects`, async (t) => {
    const dataDir = await temporaryDirectory(t);
    const { monitor, calls } = monitorFixture(dataDir);
    const events = order === "news-first"
      ? [newsEvent(), flapContextEvent(), flapTargetEvent()]
      : [flapContextEvent(), flapTargetEvent(), newsEvent()];
    for (const event of events) {
      const admission = await monitor.observe(event);
      assert.equal(admission.status, "admitted");
    }
    assert.deepEqual(calls, { adapt: 0, assess: 0, derive: 0, send: 0, ledger: 0 }, "observe must have no external side effects");

    const result = await monitor.check();
    assert.equal(result.status, "healthy");
    assert.equal(calls.adapt, 1);
    assert.equal(calls.assess, 1);
    assert.equal(calls.derive, 1);
    assert.equal(calls.send, 1);
    assert.equal(calls.ledger, 1);
    const state = await monitor.getState();
    assert.equal(Object.keys(state.candidates).length, 1);
    assert.equal(state.signals[DECISION_HASH].signal.shadowOrder.executable, false);
    assert.equal(state.signals[DECISION_HASH].delivery.status, "sent");
    assert.equal(state.signals[DECISION_HASH].ledger.status, "admitted");
    await monitor.stop();
  });
}

test("pon.fun keeps stockToken as context and coin as the only target", async (t) => {
  const dataDir = await temporaryDirectory(t);
  const stockToken = "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b";
  const coin = "0x1ebaab225157ff0eaecfc69edabbe978d8b610d9";
  const ponTx = `0x${"12".repeat(32)}`;
  const ponBlock = `0x${"34".repeat(32)}`;
  const eventKey = `pon-fun:market_created:4663:${ponTx}:7`;
  const pon = {
    type: "pon_fun_update",
    kind: "market_created",
    eventKey,
    chainId: 4663,
    platform: { id: "ponfun", chainId: 4663 },
    source: {
      trust: "official_site_bound_onchain_fingerprinted",
      url: "https://robinhoodchain.blockscout.com/tx/example",
    },
    transactionHash: ponTx,
    blockHash: ponBlock,
    blockNumber: 200,
    blockTimestamp: POOL_AT,
    observedAt: POOL_AT,
    token: coin,
    contractAddress: coin,
    market: { ticker: "AMC", symbol: "AMCAPE", name: "Apes Together Strong", coin, stockToken },
    currentSnapshot: { ticker: "AMC", symbol: "AMCAPE", name: "Apes Together Strong", coin, stockToken },
    evidence: {
      receiptVerified: true,
      logIndex: 7,
      api: { marketsUrl: "https://www.pon.fun/api/markets", tokenListUrl: "https://www.pon.fun/tokenlist.json" },
    },
  };
  let assessed;
  let derivedInput;
  const monitor = createNarrativeSniperMonitor({ dataDir, narrativeSniperAutoCheckOnObserve: false }, {
    now: () => NOW,
    narrativeAdapter: () => ({
      evidenceKey: "news:amc",
      contextAssetKeys: [`eip155:4663/erc20:${stockToken}`],
      narrativeEvidence: {
        verified: true,
        sourceKind: "official_release",
        sourceUrl: "https://investor.amctheatres.com/news/example",
        publishedAt: NEWS_AT,
        headline: "AMC update",
        subjectMatch: true,
        strength: 90,
        novelty: 90,
      },
    }),
    liveEvidenceProvider: { assess: async (value) => {
      assessed = value;
      return {
        targetEvidence: { chainId: 4663, ca: coin, poolAddress: POOL, poolVerified: true },
        marketEvidence: {},
        riskEvidence: {},
      };
    } },
    deriveSignal: (input) => {
      derivedInput = input;
      return doSignal(input, "2".repeat(64));
    },
    sendSignal: async () => ({ status: "sent" }),
    ledger: { admit: async () => ({ status: "admitted" }) },
  });
  await monitor.observe(newsEvent({ key: "news:amc" }));
  await monitor.observe(pon);
  await monitor.check();
  assert.equal(assessed.context.contextAddress, stockToken);
  assert.equal(assessed.target.ca, coin);
  assert.notEqual(assessed.context.contextAddress, assessed.target.ca);
  assert.equal(derivedInput.poolContext.ca, stockToken);
  assert.equal(derivedInput.targetEvidence.ca, coin);
  assert.equal(derivedInput.shadowOrder, undefined);
  await monitor.stop();
});

test("Telegram observations stay unverified and never reach live assessment or side effects", async (t) => {
  const dataDir = await temporaryDirectory(t);
  let assessed = 0;
  let sent = 0;
  let admitted = 0;
  const monitor = createNarrativeSniperMonitor({ dataDir, narrativeSniperAutoCheckOnObserve: false }, {
    now: () => NOW,
    narrativeAdapter,
    liveEvidenceProvider: { assess: async () => { assessed += 1; return liveAssessment(); } },
    deriveSignal: doSignal,
    sendSignal: async () => { sent += 1; },
    ledger: { admit: async () => { admitted += 1; } },
  });
  await monitor.observe({
    ...newsEvent({ type: "telegram_news_update", key: "telegram-news:-1:1:abcd" }),
    messageUrl: "https://t.me/maxguruai/1",
    sourceOccurredAt: NEWS_AT,
  });
  await monitor.observe(flapContextEvent());
  await monitor.observe(flapTargetEvent());
  await monitor.check();
  const state = await monitor.getState();
  const [news] = Object.values(state.news);
  const [candidate] = Object.values(state.candidates);
  assert.equal(news.narrativeEvidence.verified, false);
  assert.equal(news.narrativeEvidence.sourceKind, "public_telegram_observed");
  assert.equal(candidate.status, "watch");
  assert.ok(candidate.reasons.includes("narrative_unverified"));
  assert.equal(assessed, 0);
  assert.equal(sent, 0);
  assert.equal(admitted, 0);
  await monitor.stop();
});

test("restart and duplicate admissions preserve decisionHash idempotence", async (t) => {
  const dataDir = await temporaryDirectory(t);
  const first = monitorFixture(dataDir);
  for (const event of [newsEvent(), flapContextEvent(), flapTargetEvent()]) await first.monitor.observe(event);
  await first.monitor.check();
  await first.monitor.stop();
  assert.equal(first.calls.send, 1);
  assert.equal(first.calls.ledger, 1);
  const mode = (await fs.stat(path.join(dataDir, "narrative-sniper-state.json"))).mode & 0o777;
  assert.equal(mode, 0o600);

  const second = monitorFixture(dataDir);
  for (const event of [newsEvent(), flapContextEvent(), flapTargetEvent()]) {
    assert.equal((await second.monitor.observe(event)).status, "duplicate");
  }
  await second.monitor.check();
  assert.equal(second.calls.assess, 0);
  assert.equal(second.calls.send, 0);
  assert.equal(second.calls.ledger, 0);
  assert.equal(Object.keys((await second.monitor.getState()).signals).length, 1);
  await second.monitor.stop();
});

test("an atomic write failure is returned locally and never invokes adapters or live dependencies", async (t) => {
  const dataDir = await temporaryDirectory(t);
  let externalCalls = 0;
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === "open") return async (_file, flags, mode) => {
        if (flags === "wx") throw Object.assign(new Error("injected durable write failure"), { code: "EIO" });
        return target.open(_file, flags, mode);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const monitor = createNarrativeSniperMonitor({ dataDir, narrativeSniperAutoCheckOnObserve: false }, {
    fs: failingFs,
    now: () => NOW,
    narrativeAdapter: () => { externalCalls += 1; return narrativeAdapter(newsEvent()); },
    liveEvidenceProvider: { assess: async () => { externalCalls += 1; return liveAssessment(); } },
  });
  const result = await monitor.observe(newsEvent());
  assert.equal(result.status, "error");
  assert.match(result.reason, /injected durable write failure/u);
  assert.equal(externalCalls, 0);
  assert.equal(Object.keys((await monitor.getState()).inbox).length, 0);
  await monitor.stop();
});

test("a do result with an executable order fails closed without ledger or send", async (t) => {
  const dataDir = await temporaryDirectory(t);
  let sent = 0;
  let ledger = 0;
  const fixture = monitorFixture(dataDir, {
    deriveSignal: (input) => ({
      ...doSignal(input, "3".repeat(64)),
      shadowOrder: { ...doSignal(input).shadowOrder, executable: true },
    }),
    sendSignal: async () => { sent += 1; },
    ledger: { admit: async () => { ledger += 1; } },
  });
  for (const event of [newsEvent(), flapContextEvent(), flapTargetEvent()]) await fixture.monitor.observe(event);
  const result = await fixture.monitor.check();
  assert.equal(result.status, "degraded");
  const state = await fixture.monitor.getState();
  const [candidate] = Object.values(state.candidates);
  assert.equal(candidate.status, "watch");
  assert.match(candidate.error.message, /non-executable shadow/u);
  assert.equal(sent, 0);
  assert.equal(ledger, 0);
  assert.equal(Object.keys(state.signals).length, 0);
  await fixture.monitor.stop();
});

test("a transient shadow-ledger failure retries only after its persisted backoff", async (t) => {
  const dataDir = await temporaryDirectory(t);
  let current = NOW;
  let ledgerCalls = 0;
  let deliveries = 0;
  const { monitor } = monitorFixture(dataDir, {
    now: () => current,
    ledger: {
      admit: async () => {
        ledgerCalls += 1;
        if (ledgerCalls === 1) throw new Error("temporary WAL failure");
        return { status: "admitted" };
      },
    },
    sendSignal: async () => {
      deliveries += 1;
      return { status: "sent" };
    },
  });
  for (const event of [newsEvent(), flapContextEvent(), flapTargetEvent()]) await monitor.observe(event);
  await monitor.check();
  let state = await monitor.getState();
  assert.equal(ledgerCalls, 1);
  assert.equal(deliveries, 1);
  assert.equal(state.signals[DECISION_HASH].ledger.status, "failed");
  assert.equal(state.signals[DECISION_HASH].ledger.nextAttemptAt, new Date(NOW + 1_000).toISOString());

  await monitor.check();
  assert.equal(ledgerCalls, 1, "the failed effect must not spin before retryAt");
  current += 1_000;
  await monitor.check();
  state = await monitor.getState();
  assert.equal(ledgerCalls, 2);
  assert.equal(deliveries, 1, "the already accepted alert must not be resent");
  assert.equal(state.signals[DECISION_HASH].ledger.status, "admitted");
  assert.equal(state.signals[DECISION_HASH].ledger.attempts, 2);
  await monitor.stop();
});
