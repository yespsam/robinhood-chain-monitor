import { createNarrativeBscJsonRpcReader } from "./narrative-bsc-json-rpc-reader.js";
import { createNarrativeBscV2QuoteProvider } from "./narrative-bsc-v2-quote-provider.js";

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new TypeError(`${label} must be a non-negative integer no greater than ${maximum}`);
  }
  return parsed;
}

function quoteRpcUrls(config) {
  const configured = config.narrativeShadowQuoteRpcUrls
    ?? config.bscCausalClassificationRpcUrls
    ?? config.bscRpcUrls;
  if (!Array.isArray(configured) || configured.length < 2 || configured.length > 20) {
    throw new TypeError("shadow quote simulation requires at least two BSC RPC URLs");
  }
  return configured;
}

/**
 * Closed production wiring for the paper-trading quote lane. Callers can
 * choose RPC URLs and inject fetch for tests, but cannot inject a replacement
 * quote provider or add execution capabilities.
 */
export function createProductionNarrativeShadowQuoteProvider(config = {}, dependencies = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("config must be an object");
  if (config.narrativeShadowSimulatorEnabled !== true) return null;
  if (config.narrativeSniperEnabled !== true) {
    throw new TypeError("shadow simulator requires the narrative sniper runtime");
  }
  const providerTimeoutMs = positiveInteger(
    config.narrativeShadowProviderTimeoutMs,
    30_000,
    "narrativeShadowProviderTimeoutMs",
    30_000,
  );
  const rpcBudgetMs = positiveInteger(
    config.narrativeShadowQuoteRpcBudgetMs,
    25_000,
    "narrativeShadowQuoteRpcBudgetMs",
    29_000,
  );
  if (rpcBudgetMs >= providerTimeoutMs) {
    throw new TypeError("shadow quote RPC budget must be shorter than the simulator provider timeout");
  }
  const rpcRequestTimeoutMs = positiveInteger(
    config.narrativeShadowQuoteRpcRequestTimeoutMs,
    5_000,
    "narrativeShadowQuoteRpcRequestTimeoutMs",
    30_000,
  );
  if (rpcRequestTimeoutMs >= rpcBudgetMs) {
    throw new TypeError("each shadow quote RPC timeout must be shorter than the aggregate RPC budget");
  }
  const readers = [];
  const trustDomains = new Set();
  for (const [index, url] of quoteRpcUrls(config).entries()) {
    const reader = createNarrativeBscJsonRpcReader({
      rpcId: `bsc.shadow.rpc.${index + 1}`,
      url,
      requestTimeoutMs: rpcRequestTimeoutMs,
    }, {
      fetchImpl: dependencies.fetchImpl,
      timers: dependencies.timers,
    });
    if (trustDomains.has(reader.trustDomain)) continue;
    trustDomains.add(reader.trustDomain);
    readers.push(reader);
    if (readers.length === 2) break;
  }
  if (readers.length !== 2) {
    throw new TypeError("shadow quote simulation requires two independent RPC provider domains");
  }
  return createNarrativeBscV2QuoteProvider({
    confirmations: nonNegativeInteger(
      config.narrativeShadowQuoteConfirmations,
      config.bscConfirmations ?? 2,
      "narrativeShadowQuoteConfirmations",
      20,
    ),
    quoteValidityMs: Math.min(5_000, positiveInteger(
      config.narrativeShadowQuoteMaxValidityMs,
      30_000,
      "narrativeShadowQuoteMaxValidityMs",
      30_000,
    )),
    maximumBlockAgeMs: positiveInteger(
      config.narrativeShadowQuoteBlockMaxAgeMs,
      30_000,
      "narrativeShadowQuoteBlockMaxAgeMs",
      120_000,
    ),
    maximumRequestAgeMs: positiveInteger(
      config.narrativeShadowQuoteMaxAgeMs,
      15_000,
      "narrativeShadowQuoteMaxAgeMs",
      60_000,
    ),
    maximumFutureSkewMs: nonNegativeInteger(
      config.narrativeShadowQuoteFutureSkewMs,
      1_000,
      "narrativeShadowQuoteFutureSkewMs",
      10_000,
    ),
    maximumHeadLagBlocks: nonNegativeInteger(
      config.narrativeShadowQuoteMaxHeadLagBlocks,
      3,
      "narrativeShadowQuoteMaxHeadLagBlocks",
      100,
    ),
    maximumOracleAgeMs: positiveInteger(
      config.narrativeShadowOracleMaxAgeMs,
      5_400_000,
      "narrativeShadowOracleMaxAgeMs",
      7_200_000,
    ),
    rpcBudgetMs,
  }, {
    primaryRpc: readers[0],
    secondaryRpc: readers[1],
    now: dependencies.now,
  });
}
