import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder } from "ethers";

import {
  NARRATIVE_LIVE_EVIDENCE_SCHEMA,
  createNarrativeLiveEvidenceProvider,
  deriveNarrativeEvidenceFromEvent,
} from "../src/narrative-live-evidence.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const OTHER_POOL = "0x3333333333333333333333333333333333333333";
const NOW = Date.parse("2026-09-06T08:10:00.000Z");

function safeGoPlusRow(overrides = {}) {
  return {
    is_open_source: "1",
    is_in_dex: "1",
    owner_address: "0x0000000000000000000000000000000000000000",
    buy_tax: "0.01",
    sell_tax: "0.02",
    is_proxy: "0",
    is_mintable: "0",
    is_honeypot: "0",
    cannot_sell_all: "0",
    cannot_buy: "0",
    is_blacklisted: "0",
    is_whitelisted: "0",
    transfer_pausable: "0",
    trading_cooldown: "0",
    can_take_back_ownership: "0",
    owner_change_balance: "0",
    hidden_owner: "0",
    selfdestruct: "0",
    external_call: "0",
    personal_slippage_modifiable: "0",
    slippage_modifiable: "0",
    anti_whale_modifiable: "0",
    ...overrides,
  };
}

function goPlusPayload(row = safeGoPlusRow()) {
  return { code: 1, result: { [TOKEN]: row } };
}

function dexPayload(pairAddress = POOL, overrides = {}) {
  return { pairs: [{
    chainId: "bsc",
    pairAddress,
    dexId: "pancakeswap",
    labels: ["v2"],
    baseToken: { address: TOKEN, symbol: "NEWS" },
    quoteToken: { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", symbol: "WBNB" },
    liquidity: { usd: 100_000 },
    priceUsd: "0.001",
    volume: { m5: 25_000 },
    txns: { m5: { buys: 20, sells: 3 } },
    pairCreatedAt: NOW - 60_000,
    ...overrides,
  }] };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(payload),
  };
}

function localProvider(counters = {}) {
  const reserves = AbiCoder.defaultAbiCoder().encode(
    ["uint112", "uint112", "uint32"],
    [1_000_000n, 1_000_000n, 1],
  );
  return {
    getNetwork: async () => ({ chainId: 56n }),
    getCode: async () => {
      counters.getCode = (counters.getCode || 0) + 1;
      return "0x60006000";
    },
    getStorage: async () => "0x",
    call: async ({ to }) => {
      if (String(to).toLowerCase() === POOL) return reserves;
      throw new Error("owner() is not exposed");
    },
  };
}

function exactRequest(event = {}) {
  return {
    event,
    targetEvidence: {
      chainId: 56,
      ca: TOKEN,
      poolAddress: POOL,
      assetKey: `eip155:56/erc20:${TOKEN}`,
    },
  };
}

function safeFetch(counters = {}, overrides = {}) {
  return async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (String(url).includes("dexscreener.com")) {
      counters.dex = (counters.dex || 0) + 1;
      return response(overrides.dex ?? dexPayload());
    }
    if (String(url).includes("gopluslabs.io")) {
      counters.goPlus = (counters.goPlus || 0) + 1;
      return response(overrides.goPlus ?? goPlusPayload());
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test("pure news adapter requires explicit, internally consistent source evidence", () => {
  const event = {
    title: { zh: "官方发布新产品", en: "Official product launch" },
    mechanism: {
      summary: { zh: "注意力可能流向主题币", en: "Attention may flow to the themed token" },
      capitalFlow: { zh: "新闻 → 注意力 → 新池", en: "news -> attention -> new pool" },
      confidence: 85,
    },
    occurredAt: "2026-09-06T08:00:00.000Z",
    source: { kind: "official_release", url: "https://example.test/release", verified: true },
    subjectMatch: true,
    catalystStrength: 90,
    novelty: 80,
  };
  const original = structuredClone(event);
  const evidence = deriveNarrativeEvidenceFromEvent(event);

  assert.equal(evidence.verified, true);
  assert.equal(evidence.coverageComplete, true);
  assert.equal(evidence.subjectMatch, true);
  assert.equal(evidence.sourceKind, "official_release");
  assert.equal(evidence.strength, 90);
  assert.equal(evidence.mechanismConfidence, 85);
  assert.deepEqual(event, original);

  const conflicted = deriveNarrativeEvidenceFromEvent({
    ...event,
    verified: false,
    publishedAt: "not-a-date",
  });
  assert.equal(conflicted.verified, false);
  assert.equal(conflicted.coverageComplete, false);
  assert.ok(conflicted.errors.includes("verification_not_explicit"));
  assert.ok(conflicted.errors.includes("publication_time_invalid_or_conflicting"));

  const existingOfficialShape = deriveNarrativeEvidenceFromEvent({
    type: "ai_official_update",
    kind: "xai_news",
    title: "A new model is available",
    url: "https://x.ai/news/new-model",
    publishedAt: "2026-09-06T08:00:00.000Z",
    source: {
      id: "xai_news",
      url: "https://x.ai/news",
      official: true,
      trust: "official_verified",
    },
  });
  assert.equal(existingOfficialShape.verified, true);
  assert.equal(existingOfficialShape.sourceKind, "xai_news");
  assert.equal(existingOfficialShape.sourceUrl, "https://x.ai/news/new-model");

  const joinedPoolCandidate = deriveNarrativeEvidenceFromEvent({
    ...event,
    occurredAt: "2026-09-06T08:05:00.000Z",
    publishedAt: "2026-09-06T08:00:00.000Z",
    poolOccurredAt: "2026-09-06T08:05:00.000Z",
  });
  assert.equal(joinedPoolCandidate.verified, true);
  assert.equal(joinedPoolCandidate.publishedAt, "2026-09-06T08:00:00.000Z");
  assert.equal(joinedPoolCandidate.errors.includes("publication_time_invalid_or_conflicting"), false);
});

test("complete exact BSC V2 evidence is healthy but never invents wallet confirmation or executable slippage", async () => {
  const counters = {};
  const live = createNarrativeLiveEvidenceProvider({
    fetchImpl: safeFetch(counters),
    provider: localProvider(counters),
    now: () => NOW,
  });
  const result = await live.assess(exactRequest());

  assert.equal(result.schema, NARRATIVE_LIVE_EVIDENCE_SCHEMA);
  assert.equal(result.status, "complete");
  assert.equal(result.complete, true);
  assert.equal(result.identity.ca, TOKEN);
  assert.equal(result.identity.poolAddress, POOL);
  assert.equal(result.marketEvidence.dataHealthy, true);
  assert.equal(result.marketEvidence.coverageComplete, true);
  assert.equal(result.marketEvidence.marketConfirmed, true);
  assert.equal(result.marketEvidence.walletClusterConfirmed, false);
  assert.equal(result.marketEvidence.liquidityUsd, 100_000);
  assert.ok(result.marketEvidence.estimatedSlippageBps > 0);
  assert.equal(result.marketEvidence.slippageEstimate.executableQuote, false);
  assert.equal(result.marketEvidence.slippageEstimate.method, "liquidity_only_constant_product_v2_conservative_v1");
  assert.equal(result.riskEvidence.coverageComplete, true);
  assert.equal(result.riskEvidence.sellability, "verified_sellable");
  assert.equal(result.riskEvidence.sellable, true);
  assert.equal(result.riskEvidence.honeypot, false);
  assert.equal(result.riskEvidence.riskScore, null);
  assert.deepEqual(counters, { dex: 1, goPlus: 1, getCode: 1 });
});

test("identity and DEX selection fail closed on another chain, zero addresses, and a different pair", async () => {
  const counters = {};
  const live = createNarrativeLiveEvidenceProvider({
    fetchImpl: safeFetch(counters, { dex: dexPayload(OTHER_POOL) }),
    provider: localProvider(counters),
    now: () => NOW,
  });

  const wrongChain = await live.assess({ chainId: 8453, ca: TOKEN, poolAddress: POOL });
  assert.equal(wrongChain.status, "partial");
  assert.ok(wrongChain.identity.errors.includes("chain_id_mismatch"));
  assert.deepEqual(counters, {});

  const zeroPool = await live.assess({ chainId: 56, ca: TOKEN, poolAddress: "0x0000000000000000000000000000000000000000" });
  assert.equal(zeroPool.status, "partial");
  assert.ok(zeroPool.identity.errors.includes("pool_invalid_or_zero"));
  assert.deepEqual(counters, {});

  const wrongPair = await live.assess(exactRequest());
  assert.equal(wrongPair.status, "partial");
  assert.equal(wrongPair.marketEvidence.dataHealthy, false);
  assert.equal(wrongPair.marketEvidence.estimatedSlippageBps, null);
  assert.equal(wrongPair.riskEvidence.sellability, "unverified");
  assert.equal(counters.getCode, undefined, "local checks must not run against a DEX-unmatched pool");
});

test("missing explicit GoPlus sellability stays partial even when DEX and local checks pass", async () => {
  const row = safeGoPlusRow();
  delete row.cannot_sell_all;
  const live = createNarrativeLiveEvidenceProvider({
    fetchImpl: safeFetch({}, { goPlus: goPlusPayload(row) }),
    provider: localProvider(),
    now: () => NOW,
  });
  const result = await live.assess(exactRequest());

  assert.equal(result.status, "partial");
  assert.equal(result.marketEvidence.dataHealthy, true);
  assert.equal(result.riskEvidence.coverageComplete, false);
  assert.equal(result.riskEvidence.sellability, "unverified");
  assert.equal(result.riskEvidence.sellable, null);
  assert.equal(result.riskEvidence.cannotSell, null);
  assert.equal(result.evidence.sources.goPlus.decision, "pending");
});

test("a provider that is not independently bound to chain 56 cannot complete evidence", async () => {
  let codeReads = 0;
  const wrongChainProvider = {
    ...localProvider(),
    getNetwork: async () => ({ chainId: 8453n }),
    getCode: async () => {
      codeReads += 1;
      return "0x60006000";
    },
  };
  const live = createNarrativeLiveEvidenceProvider({
    fetchImpl: safeFetch(),
    provider: wrongChainProvider,
    now: () => NOW,
  });
  const result = await live.assess(exactRequest());

  assert.equal(result.status, "partial");
  assert.equal(result.marketEvidence.dataHealthy, false);
  assert.equal(result.riskEvidence.sellability, "unverified");
  assert.equal(result.evidence.sources.localSecurity.error.code, "bsc_provider_chain_mismatch");
  assert.equal(codeReads, 0);
});

test("an explicit GoPlus honeypot blocks without pretending an unrelated risk score", async () => {
  const live = createNarrativeLiveEvidenceProvider({
    fetchImpl: safeFetch({}, { goPlus: goPlusPayload(safeGoPlusRow({ is_honeypot: "1" })) }),
    provider: localProvider(),
    now: () => NOW,
  });
  const result = await live.assess(exactRequest());

  assert.equal(result.status, "blocked");
  assert.equal(result.riskEvidence.coverageComplete, true);
  assert.equal(result.riskEvidence.sellability, "cannot_sell");
  assert.equal(result.riskEvidence.cannotSell, true);
  assert.equal(result.riskEvidence.honeypot, true);
  assert.equal(result.riskEvidence.highRisk, true);
  assert.equal(result.riskEvidence.riskScore, null);
});

test("singleflight and source TTL caches use exact identity keys", async () => {
  let current = NOW;
  const counters = {};
  const live = createNarrativeLiveEvidenceProvider({
    fetchImpl: safeFetch(counters),
    provider: localProvider(counters),
    now: () => current,
  });

  const first = await Promise.all([live.assess(exactRequest()), live.assess(exactRequest())]);
  assert.equal(first[0], first[1], "same-key concurrent callers receive the same frozen assessment");
  assert.deepEqual(counters, { dex: 1, goPlus: 1, getCode: 1 });

  current += 14_999;
  await live.assess(exactRequest());
  assert.deepEqual(counters, { dex: 1, goPlus: 1, getCode: 1 });

  current += 1;
  await live.assess(exactRequest());
  assert.deepEqual(counters, { dex: 2, goPlus: 1, getCode: 2 }, "15s market TTL refreshes DEX/local but retains 30s GoPlus");

  current += 15_000;
  await live.assess(exactRequest());
  assert.deepEqual(counters, { dex: 3, goPlus: 2, getCode: 3 });
});

test("the total budget aborts hanging HTTP work and returns partial evidence", async () => {
  const signals = [];
  const fetchImpl = async (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const live = createNarrativeLiveEvidenceProvider({
    fetchImpl,
    provider: localProvider(),
    now: () => NOW,
    totalBudgetMs: 20,
  });
  const started = Date.now();
  const result = await live.assess(exactRequest());

  assert.equal(result.status, "partial");
  assert.equal(result.marketEvidence.dataHealthy, false);
  assert.equal(result.marketEvidence.walletClusterConfirmed, false);
  assert.equal(result.marketEvidence.estimatedSlippageBps, null);
  assert.equal(result.riskEvidence.sellability, "unverified");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.ok(result.evidence.errors.some((error) => error.code === "NARRATIVE_LIVE_EVIDENCE_BUDGET_EXHAUSTED"));
});
