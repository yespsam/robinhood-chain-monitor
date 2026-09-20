import test from "node:test";
import assert from "node:assert/strict";

import { createProductionNarrativeShadowQuoteProvider } from "../src/narrative-shadow-quote-runtime.js";

function enabledConfig(overrides = {}) {
  return {
    narrativeSniperEnabled: true,
    narrativeShadowSimulatorEnabled: true,
    narrativeShadowProviderTimeoutMs: 30_000,
    narrativeShadowQuoteRpcBudgetMs: 25_000,
    narrativeShadowQuoteRpcRequestTimeoutMs: 5_000,
    narrativeShadowQuoteConfirmations: 2,
    narrativeShadowQuoteMaxValidityMs: 30_000,
    narrativeShadowQuoteBlockMaxAgeMs: 30_000,
    narrativeShadowQuoteMaxAgeMs: 15_000,
    narrativeShadowQuoteFutureSkewMs: 1_000,
    narrativeShadowQuoteMaxHeadLagBlocks: 3,
    narrativeShadowOracleMaxAgeMs: 5_400_000,
    bscCausalClassificationRpcUrls: [
      "https://rpc-a.alpha.example/rpc",
      "https://rpc-b.beta.example/rpc",
    ],
    ...overrides,
  };
}

test("production quote wiring stays absent unless the separate simulator switch is enabled", () => {
  let fetchCalls = 0;
  const result = createProductionNarrativeShadowQuoteProvider({
    narrativeSniperEnabled: true,
    narrativeShadowSimulatorEnabled: false,
  }, { fetchImpl: async () => { fetchCalls += 1; } });
  assert.equal(result, null);
  assert.equal(fetchCalls, 0);
});

test("the simulator cannot be enabled without its narrative runtime", () => {
  assert.throws(
    () => createProductionNarrativeShadowQuoteProvider(enabledConfig({ narrativeSniperEnabled: false })),
    /requires the narrative sniper/u,
  );
});

test("constructs only the official six-key read-only provider from two independent RPC domains", () => {
  const provider = createProductionNarrativeShadowQuoteProvider(enabledConfig(), {
    fetchImpl: async () => { throw new Error("network must not be used during construction"); },
  });
  assert.deepEqual(Object.keys(provider).sort(), [
    "checkCanonicalBlock", "getEntryQuote", "getPositionMark", "providerId", "readOnly", "trusted",
  ]);
  assert.equal(provider.trusted, true);
  assert.equal(provider.readOnly, true);
  assert.equal(Object.isFrozen(provider), true);
  for (const forbidden of ["wallet", "signer", "send", "sendTransaction", "broadcastTransaction", "swap"]) {
    assert.equal(forbidden in provider, false);
  }
});

test("rejects sibling hosts from one provider family and invalid timeout nesting", () => {
  assert.throws(() => createProductionNarrativeShadowQuoteProvider(enabledConfig({
    bscCausalClassificationRpcUrls: [
      "https://a.vendor.example/rpc",
      "https://b.vendor.example/rpc",
    ],
  })), /two independent RPC provider domains/u);
  assert.throws(() => createProductionNarrativeShadowQuoteProvider(enabledConfig({
    narrativeShadowProviderTimeoutMs: 25_000,
    narrativeShadowQuoteRpcBudgetMs: 25_000,
  })), /shorter than the simulator/u);
  assert.throws(() => createProductionNarrativeShadowQuoteProvider(enabledConfig({
    narrativeShadowQuoteRpcRequestTimeoutMs: 25_000,
  })), /shorter than the aggregate/u);
});
