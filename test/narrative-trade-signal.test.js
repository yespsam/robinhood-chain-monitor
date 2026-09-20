import test from "node:test";
import assert from "node:assert/strict";

import {
  NARRATIVE_TRADE_SIGNAL_SCHEMA,
  NARRATIVE_TRADE_SIGNAL_VERSION,
  deriveNarrativeTradeSignal,
  evaluateNarrativeTradeSignal,
  isNarrativeTradeSignal,
  verifyNarrativeTradeSignalIntegrity,
} from "../src/narrative-trade-signal.js";

const CONTEXT_CA = "0x1111111111111111111111111111111111111111";
const CA = "0x3333333333333333333333333333333333333333";
const POOL = "0x2222222222222222222222222222222222222222";

function eligibleInput(overrides = {}) {
  const base = {
    event: {
      eventKey: "new-pool:flap:nvda:1",
      type: "new_pool",
      platform: { id: "flap", name: "Flap" },
      targetSymbol: "NVDAMEME",
      title: { zh: "NVDAB 新底池上线", en: "NVDAB new pool is live" },
      mechanism: {
        summary: {
          zh: "美股映射梗吸引注意力，买盘经新报价池流入",
          en: "The equity-reference meme attracts attention that can flow through the new quote pool",
        },
        capitalFlow: { zh: "新闻 → 注意力 → 新池成交", en: "news → attention → new-pool flow" },
        confidence: 90,
      },
      occurredAt: "2026-09-06T08:00:00.000Z",
    },
    poolContext: {
      chainId: 56,
      ca: CONTEXT_CA,
      resolution: "verified_complete",
      identityStatus: "matched",
      assetClass: "public_equity_reference",
      canonicalTicker: "NVDA",
      subject: { zh: "美股映射｜NVDA · NVIDIA", en: "U.S. equity reference | NVDA · NVIDIA" },
      business: { zh: "AI 加速计算芯片、系统和软件", en: "AI accelerated-computing chips, systems, and software" },
      meme: { zh: "AI 淘金潮卖铲人", en: "The AI gold-rush shovel seller" },
      sourceHash: "context-source-hash",
    },
    targetEvidence: {
      chainId: 56,
      ca: CA,
      poolAddress: POOL,
      caVerified: true,
      poolVerified: true,
      symbol: "NVDAMEME",
    },
    narrativeEvidence: {
      verified: true,
      sourceKind: "official_release",
      publishedAt: "2026-09-06T08:00:00.000Z",
      headline: { zh: "官方确认 NVDAB 新池", en: "Official source confirms the NVDAB pool" },
      novelty: 90,
      strength: 90,
      subjectMatch: true,
      sourceUrl: "https://example.test/official-release",
    },
    marketEvidence: {
      asOf: "2026-09-06T08:10:00.000Z",
      dataHealth: "healthy",
      coverageComplete: true,
      liquidityUsd: 100_000,
      minimumLiquidityUsd: 25_000,
      estimatedSlippageBps: 80,
      maximumSlippageBps: 300,
      marketConfirmed: true,
      momentumConfirmed: true,
      walletClusterConfirmed: true,
      entryWindow: "open",
      shadowNotionalUsd: 25,
    },
    riskEvidence: {
      asOf: "2026-09-06T08:10:00.000Z",
      coverageComplete: true,
      sellability: "verified_sellable",
      riskLevel: "low",
      honeypot: false,
      ownerCanMint: false,
      ownerCanBlacklist: false,
      ownerCanFreeze: false,
      ownerCanPause: false,
      dynamicTax: false,
    },
    asOf: "2026-09-06T08:10:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    event: { ...base.event, ...overrides.event },
    poolContext: { ...base.poolContext, ...overrides.poolContext },
    targetEvidence: { ...base.targetEvidence, ...overrides.targetEvidence },
    narrativeEvidence: { ...base.narrativeEvidence, ...overrides.narrativeEvidence },
    marketEvidence: { ...base.marketEvidence, ...overrides.marketEvidence },
    riskEvidence: { ...base.riskEvidence, ...overrides.riskEvidence },
  };
}

function blockCodes(signal) {
  return signal.hardBlocks.map((item) => item.code);
}

test("an eligible narrative creates only a non-executable shadow order", () => {
  const input = eligibleInput();
  const original = structuredClone(input);
  const signal = deriveNarrativeTradeSignal(input);

  assert.equal(signal.version, NARRATIVE_TRADE_SIGNAL_VERSION);
  assert.equal(signal.schema, NARRATIVE_TRADE_SIGNAL_SCHEMA);
  assert.equal(signal.deterministic, true);
  assert.equal(signal.decision, "do");
  assert.ok(signal.score >= signal.scoreDetails.threshold);
  assert.deepEqual(signal.hardBlocks, []);
  assert.equal(signal.shadowOrder.mode, "shadow");
  assert.equal(signal.shadowOrder.executable, false);
  assert.equal(signal.shadowOrder.ca, CA);
  assert.notEqual(signal.shadowOrder.ca, CONTEXT_CA);
  assert.equal(signal.shadowOrder.poolAddress, POOL);
  assert.equal(signal.target.context.ca, CONTEXT_CA);
  assert.equal(signal.target.context.resolution, "verified_complete");
  assert.equal(signal.target.context.identityStatus, "matched");
  assert.equal(signal.target.context.verifiedComplete, true);
  assert.equal(signal.event.platform, "flap");
  assert.equal(signal.event.targetSymbol, "NVDAMEME");
  assert.equal(signal.execution.automaticExecution, false);
  assert.equal(signal.execution.networkAccess, false);
  assert.equal(signal.execution.signing, false);
  assert.equal(signal.execution.broadcast, false);
  assert.equal(isNarrativeTradeSignal(signal), true);
  assert.deepEqual(verifyNarrativeTradeSignalIntegrity(signal), { valid: true, reasons: [] });
  assert.deepEqual(input, original, "the normalized inputs must remain immutable");

  for (const section of ["event", "mechanism", "target", "confirmation", "execution", "risk"]) {
    assert.equal(typeof signal[section].zh, "string", section);
    assert.equal(typeof signal[section].en, "string", section);
    assert.ok(signal[section].zh, section);
    assert.ok(signal[section].en, section);
  }
});

test("identical input is byte-stable, JSON-persistable, and produces stable hashes", () => {
  const input = eligibleInput();
  const first = deriveNarrativeTradeSignal(input);
  const second = evaluateNarrativeTradeSignal(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(second.inputHash, first.inputHash);
  assert.equal(second.decisionHash, first.decisionHash);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.match(first.inputHash, /^[a-f0-9]{64}$/u);
  assert.match(first.decisionHash, /^[a-f0-9]{64}$/u);
});

test("an unverified or malformed CA rejects before a high score can matter", () => {
  for (const targetEvidence of [
    { caVerified: false },
    { ca: "NVDA", caVerified: true },
  ]) {
    const signal = deriveNarrativeTradeSignal(eligibleInput({ targetEvidence }));
    assert.equal(signal.decision, "reject");
    assert.ok(blockCodes(signal).includes("ca_unverified"));
    assert.equal(signal.shadowOrder, null);
    assert.equal(signal.execution.mode, "none");
  }
});

test("pon stockToken context can never replace the separately verified coin target", () => {
  const stockToken = "0x4444444444444444444444444444444444444444";
  const coin = "0x5555555555555555555555555555555555555555";
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    event: { platform: "pon.fun", targetSymbol: "AMCAPE" },
    poolContext: {
      chainId: 4663,
      ca: stockToken,
      canonicalTicker: "AMC",
      subject: { zh: "AMC 美股映射", en: "AMC equity reference" },
    },
    targetEvidence: {
      chainId: 4663,
      ca: coin,
      poolAddress: POOL,
      caVerified: true,
      poolVerified: true,
      symbol: "AMCAPE",
    },
  }));
  assert.equal(signal.decision, "do");
  assert.equal(signal.target.ca, coin);
  assert.equal(signal.target.context.ca, stockToken);
  assert.equal(signal.shadowOrder.ca, coin);
  assert.notEqual(signal.shadowOrder.ca, stockToken);
});

test("legacy pool-context fallback is display-only and cannot create a shadow order", () => {
  const input = eligibleInput();
  delete input.targetEvidence;
  input.poolContext.caVerified = true;
  input.poolContext.poolVerified = true;
  input.poolContext.poolAddress = POOL;
  const signal = deriveNarrativeTradeSignal(input);
  assert.equal(signal.target.fallbackFromPoolContext, true);
  assert.equal(signal.target.ca, CONTEXT_CA);
  assert.equal(signal.decision, "watch");
  assert.ok(signal.confirmation.missing.includes("explicit_target_evidence"));
  assert.equal(signal.shadowOrder, null);
});

test("pool context that is not verified_complete is watch-only", () => {
  for (const resolution of [undefined, "unresolved"]) {
    const signal = deriveNarrativeTradeSignal(eligibleInput({
      poolContext: { resolution, identityStatus: "unverified" },
    }));
    assert.equal(signal.hardBlocks.length, 0);
    assert.equal(signal.decision, "watch");
    assert.equal(signal.target.context.verifiedComplete, false);
    assert.ok(signal.confirmation.missing.includes("pool_context_verified_complete"));
    assert.equal(signal.shadowOrder, null);
  }
});

test("a context identity mismatch is a hard reject even with an exact reviewed profile", () => {
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    poolContext: { resolution: "verified_complete", identityStatus: "mismatch" },
  }));
  assert.equal(signal.target.context.verifiedComplete, true);
  assert.equal(signal.target.context.identityStatus, "mismatch");
  assert.equal(signal.decision, "reject");
  assert.ok(blockCodes(signal).includes("context_identity_mismatch"));
  assert.equal(signal.shadowOrder, null);
});

test("unhealthy data and either market or security coverage gap reject", () => {
  const unhealthy = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { dataHealth: "degraded", coverageComplete: false },
  }));
  assert.equal(unhealthy.decision, "reject");
  assert.ok(blockCodes(unhealthy).includes("data_unhealthy"));
  assert.ok(blockCodes(unhealthy).includes("coverage_gap"));

  const securityGap = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: { coverageComplete: false },
  }));
  assert.equal(securityGap.decision, "reject");
  assert.ok(blockCodes(securityGap).includes("coverage_gap"));
});

test("cannot-sell and high contract-risk evidence always reject", () => {
  const cannotSell = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: { sellability: "cannot_sell", riskLevel: "critical" },
  }));
  assert.equal(cannotSell.decision, "reject");
  assert.ok(blockCodes(cannotSell).includes("cannot_sell"));
  assert.equal(cannotSell.shadowOrder, null);

  const adminRisk = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: { ownerCanMint: true },
  }));
  assert.equal(adminRisk.decision, "reject");
  assert.ok(blockCodes(adminRisk).includes("contract_high_risk"));
});

test("insufficient liquidity and excessive slippage are independent hard rejects", () => {
  const shallow = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { liquidityUsd: 24_999 },
  }));
  assert.equal(shallow.decision, "reject");
  assert.ok(blockCodes(shallow).includes("liquidity_insufficient"));

  const costly = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { estimatedSlippageBps: 301 },
  }));
  assert.equal(costly.decision, "reject");
  assert.ok(blockCodes(costly).includes("slippage_excessive"));
});

test("missing market confirmation remains watch even when every hard gate passes", () => {
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { marketConfirmed: false },
  }));
  assert.equal(signal.hardBlocks.length, 0);
  assert.equal(signal.decision, "watch");
  assert.ok(signal.confirmation.missing.includes("market_confirmation"));
  assert.equal(signal.shadowOrder, null);
});

test("unverified news earns no event score and cannot become do", () => {
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    narrativeEvidence: { verified: false, novelty: 100, strength: 100 },
  }));
  assert.equal(signal.decision, "watch");
  assert.equal(signal.scoreDetails.eventComponentsBeforeDecay.catalyst, 0);
  assert.equal(signal.scoreDetails.eventComponentsBeforeDecay.mechanism, 0);
  assert.equal(signal.scoreDetails.eventComponentsBeforeDecay.subjectMatch, 0);
  assert.ok(signal.confirmation.missing.includes("narrative_verified"));
  assert.equal(signal.shadowOrder, null);
});

test("a bare verified claim without source metadata is still treated as unverified", () => {
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    narrativeEvidence: { verified: true, sourceKind: null, sourceUrl: null },
  }));
  assert.equal(signal.event.verificationClaimed, true);
  assert.equal(signal.event.verified, false);
  assert.equal(signal.decision, "watch");
  assert.equal(signal.scoreDetails.eventComponentsBeforeDecay.catalyst, 0);
  assert.ok(signal.confirmation.missing.includes("narrative_verified"));
});

test("a verified claim still requires a safe evidence URL", () => {
  for (const sourceUrl of ["definitely-not-a-url", "javascript:alert(1)"]) {
    const signal = deriveNarrativeTradeSignal(eligibleInput({ narrativeEvidence: { sourceUrl } }));
    assert.equal(signal.event.verificationClaimed, true);
    assert.equal(signal.event.sourceUrlValid, false);
    assert.equal(signal.event.verified, false);
    assert.equal(signal.decision, "watch");
    assert.equal(signal.shadowOrder, null);
  }
});

test("unknown risk classification cannot pass a claimed-complete safety check", () => {
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: { riskLevel: null, coverageComplete: true },
  }));
  assert.equal(signal.decision, "reject");
  assert.ok(blockCodes(signal).includes("coverage_gap"));
  assert.equal(signal.risk.securityCoverageComplete, false);
});

test("time decay is deterministic and stale news cannot remain do", () => {
  const fresh = deriveNarrativeTradeSignal(eligibleInput());
  const stale = deriveNarrativeTradeSignal(eligibleInput({
    asOf: "2026-09-07T08:00:00.000Z",
    marketEvidence: { asOf: "2026-09-07T08:00:00.000Z" },
    riskEvidence: { asOf: "2026-09-07T08:00:00.000Z" },
  }));
  assert.equal(fresh.decision, "do");
  assert.equal(stale.decision, "watch");
  assert.ok(stale.score < fresh.score);
  assert.ok(stale.confirmation.missing.includes("narrative_freshness"));
  assert.equal(stale.shadowOrder, null);
});

test("evidence-provided thresholds can tighten but never relax the safety policy", () => {
  const shallow = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { liquidityUsd: 100, minimumLiquidityUsd: 1 },
  }));
  assert.equal(shallow.risk.minimumLiquidityUsd, 25_000);
  assert.equal(shallow.decision, "reject");
  assert.ok(blockCodes(shallow).includes("liquidity_insufficient"));

  const costly = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { estimatedSlippageBps: 301, maximumSlippageBps: 10_000 },
  }));
  assert.equal(costly.risk.maximumSlippageBps, 300);
  assert.equal(costly.decision, "reject");
  assert.ok(blockCodes(costly).includes("slippage_excessive"));

  const stale = deriveNarrativeTradeSignal(eligibleInput({
    asOf: "2026-09-07T08:00:00.000Z",
    narrativeEvidence: { halfLifeMs: 365 * 24 * 60 * 60 * 1_000 },
    marketEvidence: { asOf: "2026-09-07T08:00:00.000Z" },
    riskEvidence: { asOf: "2026-09-07T08:00:00.000Z" },
  }));
  assert.equal(stale.scoreDetails.freshness.halfLifeMs, 2 * 60 * 60 * 1_000);
  assert.equal(stale.decision, "watch");
  assert.equal(stale.shadowOrder, null);
});

test("missing evaluation time and materially future-dated news cannot produce an order", () => {
  const missingClock = deriveNarrativeTradeSignal(eligibleInput({ asOf: null }));
  assert.equal(missingClock.decision, "watch");
  assert.ok(missingClock.confirmation.missing.includes("evaluation_time_explicit"));
  assert.equal(missingClock.shadowOrder, null);

  const future = deriveNarrativeTradeSignal(eligibleInput({
    asOf: "2026-09-06T08:00:00.000Z",
    event: { occurredAt: undefined },
    narrativeEvidence: { publishedAt: "2026-09-06T08:02:00.000Z" },
    marketEvidence: { asOf: "2026-09-06T08:00:00.000Z" },
    riskEvidence: { asOf: "2026-09-06T08:00:00.000Z" },
  }));
  assert.equal(future.event.futureSkewMs, 120_000);
  assert.equal(future.event.timingValid, false);
  assert.equal(future.decision, "watch");
  assert.ok(future.confirmation.missing.includes("narrative_timestamp_valid"));
  assert.equal(future.shadowOrder, null);
});

test("context, target, and cross-chain evidence conflicts are hard rejects", () => {
  const other = "0x6666666666666666666666666666666666666666";
  const contextConflict = deriveNarrativeTradeSignal(eligibleInput({
    poolContext: { assetKey: `eip155:56/erc20:${other}` },
  }));
  assert.equal(contextConflict.decision, "reject");
  assert.ok(blockCodes(contextConflict).includes("context_evidence_conflict"));

  const targetConflict = deriveNarrativeTradeSignal(eligibleInput({
    targetEvidence: { assetKey: `eip155:56/erc20:${other}` },
  }));
  assert.equal(targetConflict.decision, "reject");
  assert.ok(blockCodes(targetConflict).includes("target_evidence_conflict"));

  const crossChain = deriveNarrativeTradeSignal(eligibleInput({
    targetEvidence: { chainId: 4663 },
  }));
  assert.equal(crossChain.decision, "reject");
  assert.ok(blockCodes(crossChain).includes("context_target_chain_mismatch"));
  assert.equal(crossChain.shadowOrder, null);

  const verificationConflict = deriveNarrativeTradeSignal(eligibleInput({
    targetEvidence: { caVerified: true, verification: { ca: "unverified" } },
  }));
  assert.equal(verificationConflict.decision, "reject");
  assert.ok(blockCodes(verificationConflict).includes("target_evidence_conflict"));
  assert.equal(verificationConflict.shadowOrder, null);

  const poolVerificationConflict = deriveNarrativeTradeSignal(eligibleInput({
    targetEvidence: { poolVerified: true, verification: { poolVerified: false } },
  }));
  assert.equal(poolVerificationConflict.decision, "reject");
  assert.ok(blockCodes(poolVerificationConflict).includes("target_evidence_conflict"));
  assert.equal(poolVerificationConflict.shadowOrder, null);

  const unknownVerification = deriveNarrativeTradeSignal(eligibleInput({
    targetEvidence: { caVerified: true, verification: { ca: "mystery" } },
  }));
  assert.equal(unknownVerification.decision, "reject");
  assert.ok(blockCodes(unknownVerification).includes("target_evidence_conflict"));
  assert.equal(unknownVerification.shadowOrder, null);

  const collision = deriveNarrativeTradeSignal(eligibleInput({
    targetEvidence: { ca: CONTEXT_CA },
  }));
  assert.equal(collision.decision, "reject");
  assert.ok(blockCodes(collision).includes("target_context_collision"));
  assert.equal(collision.shadowOrder, null);
});

test("zero addresses and an addressless mapped context are never tradeable", () => {
  const zero = `0x${"0".repeat(40)}`;
  for (const targetEvidence of [{ ca: zero }, { poolAddress: zero }]) {
    const signal = deriveNarrativeTradeSignal(eligibleInput({ targetEvidence }));
    assert.equal(signal.decision, "reject");
    assert.equal(signal.shadowOrder, null);
  }
  const missingContext = deriveNarrativeTradeSignal(eligibleInput({
    poolContext: { chainId: undefined, ca: undefined },
  }));
  assert.equal(missingContext.decision, "reject");
  assert.ok(blockCodes(missingContext).includes("context_unverified"));
  assert.equal(missingContext.shadowOrder, null);
});

test("contradictory market-health claims fail closed", () => {
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { dataHealthy: true, dataHealth: "degraded" },
  }));
  assert.equal(signal.decision, "reject");
  assert.ok(blockCodes(signal).includes("market_evidence_conflict"));
  assert.ok(blockCodes(signal).includes("data_unhealthy"));
  assert.equal(signal.shadowOrder, null);

  const labelConflict = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { dataHealth: "healthy", health: "degraded" },
  }));
  assert.equal(labelConflict.decision, "reject");
  assert.ok(blockCodes(labelConflict).includes("market_evidence_conflict"));
  assert.equal(labelConflict.shadowOrder, null);

  const slippageConflict = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { estimatedSlippageBps: 80, slippageBps: 1_000 },
  }));
  assert.equal(slippageConflict.decision, "reject");
  assert.ok(blockCodes(slippageConflict).includes("market_evidence_conflict"));
  assert.ok(blockCodes(slippageConflict).includes("slippage_unverified"));
  assert.equal(slippageConflict.shadowOrder, null);

  const confirmationConflict = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { marketConfirmed: true, confirmation: { market: "unverified" } },
  }));
  assert.equal(confirmationConflict.decision, "reject");
  assert.ok(blockCodes(confirmationConflict).includes("market_evidence_conflict"));
  assert.equal(confirmationConflict.shadowOrder, null);

  for (const marketEvidence of [
    { dataHealthy: "false" },
    { coverageGap: "true" },
  ]) {
    const invalidBoolean = deriveNarrativeTradeSignal(eligibleInput({ marketEvidence }));
    assert.equal(invalidBoolean.decision, "reject");
    assert.ok(blockCodes(invalidBoolean).includes("market_evidence_conflict"));
    assert.equal(invalidBoolean.shadowOrder, null);
  }
});

test("contradictory risk aliases and publication clocks fail closed", () => {
  const riskConflict = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: {
      coverageComplete: true,
      safetyComplete: false,
      sellable: true,
      sellability: "unverified",
      riskLevel: "low",
      level: "critical",
    },
  }));
  assert.equal(riskConflict.decision, "reject");
  assert.ok(blockCodes(riskConflict).includes("risk_evidence_conflict"));
  assert.equal(riskConflict.shadowOrder, null);

  const unknownSellabilityAlias = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: {
      sellability: "verified_sellable",
      sellabilityStatus: "mystery",
    },
  }));
  assert.equal(unknownSellabilityAlias.decision, "reject");
  assert.ok(blockCodes(unknownSellabilityAlias).includes("risk_evidence_conflict"));
  assert.equal(unknownSellabilityAlias.shadowOrder, null);

  const joinedPoolClock = deriveNarrativeTradeSignal(eligibleInput({
    event: {
      occurredAt: "2026-09-06T08:00:00.000Z",
      poolOccurredAt: "2026-09-05T08:00:00.000Z",
    },
    narrativeEvidence: { publishedAt: "2026-09-06T08:00:00.000Z" },
  }));
  assert.equal(joinedPoolClock.event.publicationEvidenceConsistent, true);
  assert.equal(joinedPoolClock.event.poolOccurredAt, "2026-09-05T08:00:00.000Z");
  assert.equal(joinedPoolClock.event.verified, true);
  assert.equal(joinedPoolClock.decision, "do");

  const negativeRisk = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: { riskScore: -1 },
  }));
  assert.equal(negativeRisk.decision, "reject");
  assert.ok(blockCodes(negativeRisk).includes("risk_evidence_conflict"));
  assert.equal(negativeRisk.shadowOrder, null);

  for (const riskEvidence of [
    { honeypot: "true" },
    { cannotSell: "true" },
    { highRisk: "true" },
    { sellable: "false" },
    { safetyComplete: "false" },
    { coverageGap: "true" },
  ]) {
    const invalidBoolean = deriveNarrativeTradeSignal(eligibleInput({ riskEvidence }));
    assert.equal(invalidBoolean.decision, "reject");
    assert.ok(blockCodes(invalidBoolean).includes("risk_evidence_conflict"));
    assert.equal(invalidBoolean.shadowOrder, null);
  }
});

test("non-finite explicit narrative scores cannot fall back into a trade", () => {
  for (const narrativeEvidence of [
    { strength: Number.NaN },
    { novelty: Number.POSITIVE_INFINITY },
    { mechanismConfidence: Number.NEGATIVE_INFINITY },
    { halfLifeMs: Number.POSITIVE_INFINITY },
  ]) {
    const signal = deriveNarrativeTradeSignal(eligibleInput({ narrativeEvidence }));
    assert.equal(signal.event.verified, false);
    assert.equal(signal.decision, "watch");
    assert.equal(signal.shadowOrder, null);
  }
});

test("a reviewed context still waits for an exact on-chain identity match", () => {
  for (const identityStatus of [null, "unverified"]) {
    const signal = deriveNarrativeTradeSignal(eligibleInput({ poolContext: { identityStatus } }));
    assert.equal(signal.decision, "watch");
    assert.ok(signal.confirmation.missing.includes("pool_context_identity_matched"));
    assert.equal(signal.shadowOrder, null);
  }
});

test("pool-context identity and resolution aliases cannot hide a mismatch", () => {
  for (const poolContext of [
    { identityStatus: "matched", profile: { identityStatus: "mismatch" } },
    { identityStatus: "matched", verification: { identityStatus: "mismatch" } },
    { resolution: "unresolved", profile: { resolution: "verified_complete" } },
  ]) {
    const signal = deriveNarrativeTradeSignal(eligibleInput({ poolContext }));
    assert.equal(signal.decision, "reject");
    assert.ok(blockCodes(signal).includes("context_evidence_conflict"));
    assert.equal(signal.shadowOrder, null);
  }
});

test("extra signer and RPC-shaped input fields never leak into persisted output", () => {
  const secret = "0xfeed-private-key";
  const rpc = "https://secret-rpc.invalid/key";
  const signal = deriveNarrativeTradeSignal(eligibleInput({
    event: { privateKey: secret },
    poolContext: { signer: { privateKey: secret } },
    targetEvidence: { signer: { privateKey: secret } },
    marketEvidence: { rpcUrl: rpc },
    riskEvidence: { providerUrl: rpc },
  }));
  const persisted = JSON.stringify(signal);
  assert.equal(signal.decision, "do");
  assert.doesNotMatch(persisted, /private-key|secret-rpc|rpcUrl|providerUrl/u);
  assert.equal(signal.shadowOrder.mode, "shadow");
});

test("market and risk evidence require independent fresh timestamps", () => {
  const marketStale = deriveNarrativeTradeSignal(eligibleInput({
    marketEvidence: { asOf: "2026-09-06T08:09:29.999Z" },
  }));
  assert.equal(marketStale.decision, "reject");
  assert.ok(blockCodes(marketStale).includes("market_evidence_stale"));

  const riskStale = deriveNarrativeTradeSignal(eligibleInput({
    riskEvidence: { asOf: "2026-09-06T08:04:59.999Z" },
  }));
  assert.equal(riskStale.decision, "reject");
  assert.ok(blockCodes(riskStale).includes("risk_evidence_stale"));

  const missingRiskClock = eligibleInput();
  delete missingRiskClock.riskEvidence.asOf;
  const missing = deriveNarrativeTradeSignal(missingRiskClock);
  assert.equal(missing.decision, "reject");
  assert.ok(blockCodes(missing).includes("risk_evidence_stale"));
});

test("strict integrity verification detects payload and policy tampering", () => {
  const original = deriveNarrativeTradeSignal(eligibleInput());
  assert.equal(verifyNarrativeTradeSignalIntegrity(original).valid, true);

  const forgedAmount = structuredClone(original);
  forgedAmount.shadowOrder.notionalUsd = 1_000_000;
  const amountCheck = verifyNarrativeTradeSignalIntegrity(forgedAmount);
  assert.equal(amountCheck.valid, false);
  assert.ok(amountCheck.reasons.includes("shadow_notional_out_of_policy"));
  assert.ok(amountCheck.reasons.includes("decision_hash_mismatch"));

  const forgedHash = structuredClone(original);
  forgedHash.shadowOrder.signalInputHash = "forged";
  const hashCheck = verifyNarrativeTradeSignalIntegrity(forgedHash);
  assert.equal(hashCheck.valid, false);
  assert.ok(hashCheck.reasons.includes("shadow_input_hash_mismatch"));
  assert.ok(hashCheck.reasons.includes("decision_hash_mismatch"));
});
