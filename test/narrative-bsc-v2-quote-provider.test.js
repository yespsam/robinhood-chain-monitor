import test from "node:test";
import assert from "node:assert/strict";

import { Interface } from "ethers";

import {
  BSC_CHAINLINK_BNB_USD,
  BSC_CHAINLINK_USDC_USD,
  BSC_CHAINLINK_USDT_USD,
  BSC_PANCAKESWAP_V2_FACTORY,
  BSC_USDC,
  BSC_USDT,
  BSC_WBNB,
  NARRATIVE_BSC_V2_QUOTE_COVERAGE,
  NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID,
  NARRATIVE_BSC_V2_ROUTE_ADMISSION_MODE,
  createNarrativeBscV2QuoteProvider,
} from "../src/narrative-bsc-v2-quote-provider.js";
import { createNarrativeShadowSimulator } from "../src/narrative-shadow-simulator.js";

const NOW_MS = Date.parse("2026-09-06T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const BLOCK = 50_000_000;
const HEAD = BLOCK + 2;
const BLOCK_TIMESTAMP = Math.floor(NOW_MS / 1_000) - 4;
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"cd".repeat(32)}`;
const POOL = "0x1111111111111111111111111111111111111111";
const CA = "0x2222222222222222222222222222222222222222";
const CUSTOM_QUOTE = "0x3333333333333333333333333333333333333333";
const ORDER_ID = `shadow:${"7".repeat(64)}`;
const TARGET_DECIMALS = 18;
const TARGET_RESERVE = 1_000_000_000n * 10n ** 18n;
const WBNB_RESERVE = 1_000n * 10n ** 18n;
const STABLE_RESERVE = 1_000_000n * 10n ** 18n;
const FEE_BPS = 25n;
const BPS = 10_000n;
const USD_MICROS = 1_000_000n;
const MAX_UINT112 = (1n << 112n) - 1n;

const PAIR_INTERFACE = new Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const FACTORY_INTERFACE = new Interface([
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
]);
const TOKEN_INTERFACE = new Interface(["function decimals() view returns (uint8)"]);
const ORACLE_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const SELECTORS = Object.freeze({
  factory: PAIR_INTERFACE.encodeFunctionData("factory"),
  token0: PAIR_INTERFACE.encodeFunctionData("token0"),
  token1: PAIR_INTERFACE.encodeFunctionData("token1"),
  reserves: PAIR_INTERFACE.encodeFunctionData("getReserves"),
  decimals: TOKEN_INTERFACE.encodeFunctionData("decimals"),
  oracleDescription: ORACLE_INTERFACE.encodeFunctionData("description"),
  oracleRound: ORACLE_INTERFACE.encodeFunctionData("latestRoundData"),
});

const ASSETS = new Map([
  [BSC_WBNB, {
    oracle: BSC_CHAINLINK_BNB_USD,
    description: "BNB / USD",
    answer: 600_00000000n,
    reserve: WBNB_RESERVE,
  }],
  [BSC_USDT, {
    oracle: BSC_CHAINLINK_USDT_USD,
    description: "USDT / USD",
    answer: 99_000000n,
    reserve: STABLE_RESERVE,
  }],
  [BSC_USDC, {
    oracle: BSC_CHAINLINK_USDC_USD,
    description: "USDC / USD",
    answer: 101_000000n,
    reserve: STABLE_RESERVE,
  }],
]);

function exactIn(amountIn, reserveIn, reserveOut) {
  const withFee = amountIn * (BPS - FEE_BPS);
  return (withFee * reserveOut) / (reserveIn * BPS + withFee);
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function entryRequest(overrides = {}) {
  return {
    schema: "narrative_shadow_quote_request_v1",
    providerId: NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID,
    mode: "shadow",
    executable: false,
    orderId: ORDER_ID,
    kind: "entry",
    side: "buy",
    chainId: 56,
    ca: CA,
    poolAddress: POOL,
    valueUsdMicros: "25000000",
    quantityRaw: null,
    maximumSlippageBps: 300,
    requestedAt: NOW_ISO,
    ...overrides,
  };
}

function markRequest(overrides = {}) {
  return {
    ...entryRequest(),
    kind: "mark",
    side: "sell",
    valueUsdMicros: null,
    quantityRaw: (1_000_000n * 10n ** 18n).toString(),
    ...overrides,
  };
}

function canonicalRequest(overrides = {}) {
  return {
    schema: "narrative_shadow_canonical_request_v1",
    providerId: NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID,
    mode: "shadow",
    executable: false,
    chainId: 56,
    blockNumber: BLOCK,
    expectedBlockHash: BLOCK_HASH,
    requestedAt: NOW_ISO,
    ...overrides,
  };
}

function defaultState(overrides = {}) {
  const quoteToken = overrides.quoteToken ?? BSC_WBNB;
  const metadata = ASSETS.get(quoteToken) ?? {
    oracle: BSC_CHAINLINK_BNB_USD,
    description: "BNB / USD",
    answer: 600_00000000n,
    reserve: WBNB_RESERVE,
  };
  const reversed = overrides.reversed === true;
  const targetReserve = overrides.targetReserve ?? TARGET_RESERVE;
  const quoteReserve = overrides.quoteReserve ?? metadata.reserve;
  return {
    chainId: 56,
    head: HEAD,
    blockHash: BLOCK_HASH,
    blockTimestamp: BLOCK_TIMESTAMP,
    pool: POOL,
    ca: CA,
    factory: BSC_PANCAKESWAP_V2_FACTORY,
    canonicalPair: POOL,
    quoteToken,
    token0: reversed ? quoteToken : CA,
    token1: reversed ? CA : quoteToken,
    reserve0: reversed ? quoteReserve : targetReserve,
    reserve1: reversed ? targetReserve : quoteReserve,
    targetDecimals: TARGET_DECIMALS,
    quoteDecimals: 18,
    oracle: metadata.oracle,
    oracleDecimals: 8,
    oracleDescription: metadata.description,
    oracleRoundId: 42n,
    oracleAnswer: metadata.answer,
    oracleStartedAt: BigInt(BLOCK_TIMESTAMP - 20),
    oracleUpdatedAt: BigInt(BLOCK_TIMESTAMP - 10),
    oracleAnsweredInRound: 42n,
    ...overrides,
  };
}

function callResponse(state, request) {
  const { to, data } = request;
  if (to === state.pool && data === SELECTORS.factory) {
    return PAIR_INTERFACE.encodeFunctionResult("factory", [state.factory]);
  }
  if (to === state.pool && data === SELECTORS.token0) {
    return PAIR_INTERFACE.encodeFunctionResult("token0", [state.token0]);
  }
  if (to === state.pool && data === SELECTORS.token1) {
    return PAIR_INTERFACE.encodeFunctionResult("token1", [state.token1]);
  }
  if (to === state.pool && data === SELECTORS.reserves) {
    return PAIR_INTERFACE.encodeFunctionResult("getReserves", [
      state.reserve0,
      state.reserve1,
      BLOCK_TIMESTAMP,
    ]);
  }
  if (to === state.factory && data.startsWith(FACTORY_INTERFACE.getFunction("getPair").selector)) {
    const [tokenA, tokenB] = FACTORY_INTERFACE.decodeFunctionData("getPair", data);
    assert.equal(String(tokenA).toLowerCase(), state.ca);
    assert.equal(String(tokenB).toLowerCase(), state.quoteToken);
    return FACTORY_INTERFACE.encodeFunctionResult("getPair", [state.canonicalPair]);
  }
  if (to === state.ca && data === SELECTORS.decimals) {
    return TOKEN_INTERFACE.encodeFunctionResult("decimals", [state.targetDecimals]);
  }
  if (to === state.quoteToken && data === SELECTORS.decimals) {
    return TOKEN_INTERFACE.encodeFunctionResult("decimals", [state.quoteDecimals]);
  }
  if (to === state.oracle && data === SELECTORS.decimals) {
    return ORACLE_INTERFACE.encodeFunctionResult("decimals", [state.oracleDecimals]);
  }
  if (to === state.oracle && data === SELECTORS.oracleDescription) {
    return ORACLE_INTERFACE.encodeFunctionResult("description", [state.oracleDescription]);
  }
  if (to === state.oracle && data === SELECTORS.oracleRound) {
    return ORACLE_INTERFACE.encodeFunctionResult("latestRoundData", [
      state.oracleRoundId,
      state.oracleAnswer,
      state.oracleStartedAt,
      state.oracleUpdatedAt,
      state.oracleAnsweredInRound,
    ]);
  }
  throw new Error(`unexpected eth_call ${to} ${data}`);
}

function makeRpc(identity, stateOverrides = {}, behavior = {}) {
  const state = defaultState(stateOverrides);
  const calls = [];
  const counts = new Map();
  let announceHang;
  const hangStarted = new Promise((resolve) => { announceHang = resolve; });
  const controls = {
    abortCount: 0,
    resolveHang: null,
    hangStarted,
  };

  function record(method, payload, context) {
    const count = (counts.get(method) ?? 0) + 1;
    counts.set(method, count);
    calls.push({ method, payload, signal: context?.signal, count });
    return count;
  }

  async function result(method, payload, context, defaultValue) {
    const count = record(method, payload, context);
    if (behavior.hangAt === method && count === (behavior.hangAtCount ?? 1)) {
      announceHang();
      return new Promise((resolve, reject) => {
        controls.resolveHang = resolve;
        if (!behavior.ignoreAbort) {
          const onAbort = () => {
            controls.abortCount += 1;
            reject(context.signal.reason ?? new Error("aborted"));
          };
          if (context.signal.aborted) onAbort();
          else context.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    if (typeof behavior[method] === "function") {
      return behavior[method]({ payload, context, defaultValue, count, state, calls });
    }
    return defaultValue;
  }

  const rpc = Object.freeze({
    rpcId: identity.rpcId,
    trustDomain: identity.trustDomain,
    getNetwork(context) {
      return result("getNetwork", null, context, Object.freeze({ chainId: state.chainId }));
    },
    getBlockNumber(context) {
      return result("getBlockNumber", null, context, state.head);
    },
    getBlock(blockNumber, context) {
      return result("getBlock", blockNumber, context, Object.freeze({
        number: blockNumber,
        hash: state.blockHash,
        timestamp: state.blockTimestamp,
      }));
    },
    call(request, context) {
      return result("call", request, context, callResponse(state, request));
    },
  });
  return { rpc, calls, controls, state };
}

function fixture(options = {}) {
  const primary = makeRpc(
    { rpcId: "bsc.primary", trustDomain: "primary.example" },
    options.primaryState,
    options.primaryBehavior,
  );
  const secondary = makeRpc(
    { rpcId: "bsc.secondary", trustDomain: "secondary.example" },
    options.secondaryState ?? options.primaryState,
    options.secondaryBehavior,
  );
  const provider = createNarrativeBscV2QuoteProvider({
    confirmations: 2,
    quoteValidityMs: 5_000,
    maximumBlockAgeMs: 30_000,
    maximumRequestAgeMs: 15_000,
    maximumFutureSkewMs: 1_000,
    maximumHeadLagBlocks: 3,
    maximumOracleAgeMs: 60_000,
    rpcBudgetMs: 1_000,
    ...(options.config || {}),
  }, {
    now: options.now ?? (() => NOW_MS),
    primaryRpc: primary.rpc,
    secondaryRpc: secondary.rpc,
  });
  return { provider, primary, secondary };
}

function stubLedger() {
  return {
    getState() {},
    getOrder() {},
    open() {},
    mark() {},
    close() {},
    expire() {},
    invalidate() {},
    getMetrics() { return {}; },
  };
}

test("exports the simulator's exact frozen read-only provider surface and explicit coverage boundary", () => {
  const { provider } = fixture();
  assert.deepEqual(Object.keys(provider).sort(), [
    "checkCanonicalBlock", "getEntryQuote", "getPositionMark", "providerId", "readOnly", "trusted",
  ]);
  assert.equal(Object.isFrozen(provider), true);
  assert.equal(provider.providerId, NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID);
  assert.equal(provider.trusted, true);
  assert.equal(provider.readOnly, true);
  assert.equal(NARRATIVE_BSC_V2_ROUTE_ADMISSION_MODE, "dynamic_factory_verified_reviewed_quote_only");
  assert.equal(NARRATIVE_BSC_V2_QUOTE_COVERAGE.routing, "dynamic_getPair_verified");
  assert.equal(NARRATIVE_BSC_V2_QUOTE_COVERAGE.unsupportedQuotePolicy, "unknown");
  assert.equal(
    NARRATIVE_BSC_V2_QUOTE_COVERAGE.marketExecutableSemantics,
    "constant_product_route_math_only_requires_external_risk_gate",
  );
  assert.equal(NARRATIVE_BSC_V2_QUOTE_COVERAGE.execution, false);
  assert.deepEqual(NARRATIVE_BSC_V2_QUOTE_COVERAGE.reviewedQuoteTokens, [BSC_WBNB, BSC_USDT, BSC_USDC]);
  assert.doesNotThrow(() => createNarrativeShadowSimulator({
    narrativeShadowSimulatorEnabled: true,
    narrativeShadowSimulatorAutoStart: false,
  }, { ledger: stubLedger(), quoteProvider: provider }));
  for (const forbidden of ["send", "swap", "getSigner", "signTransaction", "sendTransaction", "wallet"]) {
    assert.equal(forbidden in provider, false);
  }
});

test("requires two strict independent read adapters and rejects capability/identity aliases", () => {
  const a = makeRpc({ rpcId: "a", trustDomain: "a.example" });
  const b = makeRpc({ rpcId: "b", trustDomain: "b.example" });
  const deps = { now: () => NOW_MS, primaryRpc: a.rpc, secondaryRpc: b.rpc };
  assert.doesNotThrow(() => createNarrativeBscV2QuoteProvider({}, deps));
  assert.throws(() => createNarrativeBscV2QuoteProvider({}, {
    ...deps,
    secondaryRpc: Object.freeze({ ...b.rpc, rpcId: "a" }),
  }), /ids must be independent/u);
  assert.throws(() => createNarrativeBscV2QuoteProvider({}, {
    ...deps,
    secondaryRpc: Object.freeze({ ...b.rpc, trustDomain: "a.example" }),
  }), /trust domains must be independent/u);
  assert.throws(() => createNarrativeBscV2QuoteProvider({}, {
    ...deps,
    primaryRpc: { ...a.rpc, sendTransaction() {} },
  }), /only rpcId\/trustDomain/u);
  assert.throws(() => createNarrativeBscV2QuoteProvider({ allowedPairs: [POOL] }, deps), /not an admitted option/u);
});

test("dynamically verifies a WBNB pool through canonical factory.getPair on both RPCs", async () => {
  const { provider, primary, secondary } = fixture();
  const quote = await provider.getEntryQuote(entryRequest());
  assert.equal(quote.status, "ok");
  assert.equal(quote.providerId, NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID);
  assert.equal(quote.kind, "entry");
  assert.equal(quote.side, "buy");
  assert.equal(quote.marketExecutable, true);
  assert.equal(quote.chainId, 56);
  assert.equal(quote.ca, CA);
  assert.equal(quote.poolAddress, POOL);
  assert.equal(quote.blockNumber, BLOCK);
  assert.equal(quote.blockHash, BLOCK_HASH);
  assert.equal(quote.blockTimestamp, new Date(BLOCK_TIMESTAMP * 1_000).toISOString());
  assert.equal(quote.observedAt, NOW_ISO);
  assert.equal(quote.validUntil, new Date(NOW_MS + 5_000).toISOString());
  assert.match(quote.routeDigest, /^[0-9a-f]{64}$/u);

  const answer = ASSETS.get(BSC_WBNB).answer;
  const quoteInput = (25_000_000n * 10n ** 18n * 10n ** 8n) / (answer * USD_MICROS);
  const targetOutput = exactIn(quoteInput, WBNB_RESERVE, TARGET_RESERVE);
  assert.equal(quote.valueUsdMicros, "25000000");
  assert.equal(quote.quantityRaw, targetOutput.toString());
  assert.equal(quote.priceUsdMicros, ceilDiv(25_000_000n * 10n ** 18n, targetOutput).toString());
  assert.ok(quote.estimatedSlippageBps > 0 && quote.estimatedSlippageBps <= 300);

  for (const source of [primary, secondary]) {
    const factoryReads = source.calls.filter(({ method, payload }) => method === "call"
      && payload.to === BSC_PANCAKESWAP_V2_FACTORY
      && payload.data.startsWith(FACTORY_INTERFACE.getFunction("getPair").selector));
    assert.equal(factoryReads.length, 1);
    assert.equal(factoryReads[0].payload.blockTag, BLOCK);
    assert.ok(source.calls.every(({ signal }) => signal instanceof AbortSignal));
    assert.ok(source.calls.filter(({ method }) => method === "call").every(({ payload }) => payload.blockTag === BLOCK));
    assert.equal(source.calls.filter(({ method }) => method === "getBlock").length, 2);
  }
});

test("marks a position using conservative constant-product output and the pinned BNB/USD round", async () => {
  const { provider } = fixture();
  const request = markRequest();
  const quote = await provider.getPositionMark(request);
  assert.equal(quote.status, "ok");
  const quantity = BigInt(request.quantityRaw);
  const quoteOutput = exactIn(quantity, TARGET_RESERVE, WBNB_RESERVE);
  const expectedValue = (quoteOutput * ASSETS.get(BSC_WBNB).answer * USD_MICROS)
    / (10n ** 18n * 10n ** 8n);
  assert.equal(quote.quantityRaw, request.quantityRaw);
  assert.equal(quote.valueUsdMicros, expectedValue.toString());
  assert.equal(quote.priceUsdMicros, ((expectedValue * 10n ** 18n) / quantity).toString());
  assert.equal(quote.kind, "mark");
  assert.equal(quote.side, "sell");
});

test("rejects V2 post-input uint112 overflow in both entry and mark directions", async (t) => {
  const answer = ASSETS.get(BSC_WBNB).answer;
  const entryAmountIn = (25_000_000n * 10n ** 18n * 10n ** 8n) / (answer * USD_MICROS);
  await t.test("entry exact boundary", async () => {
    const state = { quoteReserve: MAX_UINT112 - entryAmountIn };
    const { provider } = fixture({ primaryState: state, secondaryState: state });
    assert.equal((await provider.getEntryQuote(entryRequest())).status, "ok");
  });
  await t.test("entry overflow", async () => {
    const state = { quoteReserve: MAX_UINT112 - entryAmountIn + 1n };
    const { provider } = fixture({ primaryState: state, secondaryState: state });
    assert.deepEqual(await provider.getEntryQuote(entryRequest()), {
      status: "unknown",
      reason: "reserve_input_uint112_overflow",
    });
  });

  const markAmountIn = BigInt(markRequest().quantityRaw);
  await t.test("mark exact boundary", async () => {
    const state = { targetReserve: MAX_UINT112 - markAmountIn, quoteReserve: MAX_UINT112 };
    const { provider } = fixture({ primaryState: state, secondaryState: state });
    assert.equal((await provider.getPositionMark(markRequest())).status, "ok");
  });
  await t.test("mark overflow", async () => {
    const state = { targetReserve: MAX_UINT112 - markAmountIn + 1n, quoteReserve: MAX_UINT112 };
    const { provider } = fixture({ primaryState: state, secondaryState: state });
    assert.deepEqual(await provider.getPositionMark(markRequest()), {
      status: "unknown",
      reason: "reserve_input_uint112_overflow",
    });
  });
});

test("uses reviewed Chainlink rounds for WBNB, USDT, and USDC rather than assuming any quote is one dollar", async (t) => {
  for (const quoteToken of [BSC_WBNB, BSC_USDT, BSC_USDC]) {
    await t.test(quoteToken, async () => {
      const metadata = ASSETS.get(quoteToken);
      const { provider, primary, secondary } = fixture({
        primaryState: { quoteToken },
      });
      const quote = await provider.getEntryQuote(entryRequest());
      assert.equal(quote.status, "ok");
      const quoteInput = (25_000_000n * 10n ** 18n * 10n ** 8n) / (metadata.answer * USD_MICROS);
      const expected = exactIn(quoteInput, metadata.reserve, TARGET_RESERVE);
      assert.equal(quote.quantityRaw, expected.toString());
      if (quoteToken !== BSC_WBNB) assert.notEqual(quoteInput, 25n * 10n ** 18n);
      for (const source of [primary, secondary]) {
        assert.equal(source.calls.filter(({ method, payload }) => method === "call" && payload.to === metadata.oracle).length, 3);
      }
    });
  }
});

test("supports either canonical pair token order", async () => {
  const { provider } = fixture({ primaryState: { reversed: true } });
  const quote = await provider.getEntryQuote(entryRequest());
  assert.equal(quote.status, "ok");
  const answer = ASSETS.get(BSC_WBNB).answer;
  const quoteInput = (25_000_000n * 10n ** 18n * 10n ** 8n) / (answer * USD_MICROS);
  assert.equal(quote.quantityRaw, exactIn(quoteInput, WBNB_RESERVE, TARGET_RESERVE).toString());
});

test("fails closed when factory.getPair does not exactly return the observed pool", async () => {
  const { provider, primary } = fixture({
    primaryState: { canonicalPair: "0x4444444444444444444444444444444444444444" },
    secondaryState: { canonicalPair: "0x4444444444444444444444444444444444444444" },
  });
  const result = await provider.getEntryQuote(entryRequest());
  assert.deepEqual(result, { status: "unknown", reason: "factory_pair_identity_mismatch" });
  assert.equal(primary.calls.some(({ method, payload }) => method === "call"
    && payload.to === BSC_PANCAKESWAP_V2_FACTORY), true);
});

test("fails closed on any dual-RPC reserve, oracle, or canonical-block split", async (t) => {
  const cases = [
    ["reserve", { reserve0: TARGET_RESERVE + 1n }],
    ["oracle", { oracleAnswer: ASSETS.get(BSC_WBNB).answer + 1n }],
    ["block", { blockHash: OTHER_BLOCK_HASH }],
  ];
  for (const [name, secondaryState] of cases) {
    await t.test(name, async () => {
      const { provider } = fixture({ secondaryState });
      const result = await provider.getEntryQuote(entryRequest());
      assert.deepEqual(result, { status: "unknown", reason: "rpc_route_consensus_failed" });
    });
  }
});

test("rejects invalid, stale, future, and round-regressed Chainlink evidence", async (t) => {
  const cases = [
    ["description", { oracleDescription: "BNB/USD" }, "oracle_description_mismatch"],
    ["decimals", { oracleDecimals: 18 }, "oracle_decimals_mismatch"],
    ["zero answer", { oracleAnswer: 0n }, "invalid_or_stale_oracle_round"],
    ["stale", { oracleUpdatedAt: BigInt(BLOCK_TIMESTAMP - 61) }, "invalid_or_stale_oracle_round"],
    ["future", { oracleUpdatedAt: BigInt(BLOCK_TIMESTAMP + 1) }, "invalid_or_stale_oracle_round"],
    ["regressed", { oracleAnsweredInRound: 41n }, "invalid_or_stale_oracle_round"],
  ];
  for (const [name, state, reason] of cases) {
    await t.test(name, async () => {
      const { provider } = fixture({ primaryState: state, secondaryState: state });
      assert.deepEqual(await provider.getEntryQuote(entryRequest()), { status: "unknown", reason });
    });
  }
});

test("rejects non-reviewed quote assets, spoof factories, malformed adapter shapes, and chain/head conflicts", async (t) => {
  const cases = [
    ["custom quote", { primaryState: { quoteToken: CUSTOM_QUOTE }, secondaryState: { quoteToken: CUSTOM_QUOTE }, reason: "pair_token_or_quote_identity_mismatch" }],
    ["spoof factory", { primaryState: { factory: CUSTOM_QUOTE }, secondaryState: { factory: CUSTOM_QUOTE }, reason: "factory_identity_mismatch" }],
    ["wrong chain", { primaryState: { chainId: 1 }, reason: "rpc_chain_id_mismatch" }],
    ["head split", { secondaryState: { head: HEAD + 4 }, reason: "rpc_head_consensus_failed" }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const { reason, ...fixtureOptions } = options;
      const { provider } = fixture(fixtureOptions);
      assert.deepEqual(await provider.getEntryQuote(entryRequest()), { status: "unknown", reason });
    });
  }

  await t.test("return alias", async () => {
    const { provider } = fixture({
      primaryBehavior: {
        getNetwork: ({ defaultValue }) => ({ ...defaultValue, name: "bnb" }),
      },
    });
    assert.deepEqual(await provider.getEntryQuote(entryRequest()), {
      status: "unknown",
      reason: "invalid_network_shape",
    });
  });
});

test("external AbortSignal reaches a hanging physical RPC and returns unknown promptly", async () => {
  const { provider, primary } = fixture({
    primaryBehavior: { hangAt: "call" },
    config: { rpcBudgetMs: 500 },
  });
  const controller = new AbortController();
  const pending = provider.getEntryQuote(entryRequest(), { signal: controller.signal });
  await primary.controls.hangStarted;
  controller.abort();
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("provider did not abort")), 150)),
  ]);
  assert.deepEqual(result, { status: "unknown", reason: "request_aborted" });
  assert.equal(primary.controls.abortCount, 1);
  assert.equal(primary.calls.filter(({ method }) => method === "call").length, 1);
});

test("the total RPC budget bounds an adapter that ignores abort without starting late fan-out", async () => {
  const { provider, primary, secondary } = fixture({
    primaryBehavior: { hangAt: "call", ignoreAbort: true },
    config: { rpcBudgetMs: 25 },
  });
  const started = Date.now();
  const result = await provider.getEntryQuote(entryRequest());
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { status: "unknown", reason: "rpc_budget_exceeded" });
  assert.ok(elapsed < 250, `budgeted return took ${elapsed}ms`);
  assert.equal(primary.calls.filter(({ method }) => method === "call").length, 1);
  assert.equal(secondary.calls.filter(({ method }) => method === "call").length, 0);
  const totalCalls = primary.calls.length + secondary.calls.length;
  primary.controls.resolveHang?.("0x");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(primary.calls.length + secondary.calls.length, totalCalls);
});

test("detects a block hash change across the same-RPC pre/post snapshot", async () => {
  const { provider } = fixture({
    primaryBehavior: {
      getBlock: ({ payload, defaultValue, count }) => count === 2
        ? { ...defaultValue, number: payload, hash: OTHER_BLOCK_HASH }
        : defaultValue,
    },
  });
  assert.deepEqual(await provider.getEntryQuote(entryRequest()), {
    status: "unknown",
    reason: "canonical_block_changed_during_read",
  });
});

test("routeDigest is deterministic and binds reserves, oracle round, and consensus identities", async () => {
  const first = await fixture().provider.getEntryQuote(entryRequest());
  const repeated = await fixture().provider.getEntryQuote(entryRequest());
  assert.equal(first.status, "ok");
  assert.equal(repeated.status, "ok");
  assert.equal(first.routeDigest, repeated.routeDigest);

  const changedReserve = await fixture({
    primaryState: { targetReserve: TARGET_RESERVE + 1n },
  }).provider.getEntryQuote(entryRequest());
  const changedOracle = await fixture({
    primaryState: { oracleAnswer: ASSETS.get(BSC_WBNB).answer + 1n },
  }).provider.getEntryQuote(entryRequest());
  const changedBlockTimestamp = await fixture({
    primaryState: { blockTimestamp: BLOCK_TIMESTAMP + 1 },
  }).provider.getEntryQuote(entryRequest());
  assert.equal(changedReserve.status, "ok");
  assert.equal(changedOracle.status, "ok");
  assert.equal(changedBlockTimestamp.status, "ok");
  assert.notEqual(changedReserve.routeDigest, first.routeDigest);
  assert.notEqual(changedOracle.routeDigest, first.routeDigest);
  assert.notEqual(changedBlockTimestamp.routeDigest, first.routeDigest);
});

test("canonical block checks use two reads per RPC and return the actual consensus hash", async (t) => {
  await t.test("canonical", async () => {
    const { provider, primary, secondary } = fixture();
    const result = await provider.checkCanonicalBlock(canonicalRequest());
    assert.deepEqual(result, {
      status: "ok",
      providerId: NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID,
      chainId: 56,
      blockNumber: BLOCK,
      blockHash: BLOCK_HASH,
      observedAt: NOW_ISO,
    });
    assert.equal(primary.calls.filter(({ method }) => method === "getBlock").length, 2);
    assert.equal(secondary.calls.filter(({ method }) => method === "getBlock").length, 2);
  });

  await t.test("actual reorg hash", async () => {
    const { provider } = fixture();
    const result = await provider.checkCanonicalBlock(canonicalRequest({ expectedBlockHash: OTHER_BLOCK_HASH }));
    assert.equal(result.status, "ok");
    assert.equal(result.blockHash, BLOCK_HASH);
  });

  await t.test("source split", async () => {
    const { provider } = fixture({ secondaryState: { blockHash: OTHER_BLOCK_HASH } });
    assert.deepEqual(await provider.checkCanonicalBlock(canonicalRequest()), {
      status: "unknown",
      reason: "rpc_block_consensus_failed",
    });
  });

  await t.test("unconfirmed block", async () => {
    const { provider } = fixture();
    assert.deepEqual(await provider.checkCanonicalBlock(canonicalRequest({ blockNumber: HEAD - 1 })), {
      status: "unknown",
      reason: "canonical_block_not_confirmed",
    });
  });
});

test("canonical checks also honor external abort and the shared total budget", async (t) => {
  await t.test("external abort", async () => {
    const { provider, primary } = fixture({
      primaryBehavior: { hangAt: "getBlock" },
      config: { rpcBudgetMs: 500 },
    });
    const controller = new AbortController();
    const pending = provider.checkCanonicalBlock(canonicalRequest(), { signal: controller.signal });
    await primary.controls.hangStarted;
    controller.abort();
    assert.deepEqual(await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("canonical check did not abort")), 150)),
    ]), { status: "unknown", reason: "request_aborted" });
    assert.equal(primary.controls.abortCount, 1);
  });

  await t.test("budget", async () => {
    const { provider } = fixture({
      primaryBehavior: { hangAt: "getBlock", ignoreAbort: true },
      config: { rpcBudgetMs: 25 },
    });
    assert.deepEqual(await provider.checkCanonicalBlock(canonicalRequest()), {
      status: "unknown",
      reason: "rpc_budget_exceeded",
    });
  });
});

test("malformed, stale, over-slippage, and wrong-identity requests all fail closed", async (t) => {
  const cases = [
    ["extra key", { ...entryRequest(), quoteToken: BSC_WBNB }, "invalid_quote_request_shape"],
    ["uppercase CA", entryRequest({ ca: `0x${"AB".repeat(20)}` }), "invalid_ca"],
    ["stale", entryRequest({ requestedAt: new Date(NOW_MS - 16_000).toISOString() }), "stale_or_future_quote_request"],
    ["wrong provider", entryRequest({ providerId: "other.provider" }), "quote_request_identity_mismatch"],
    ["slippage", entryRequest({ maximumSlippageBps: 1 }), "slippage_exceeds_request_limit"],
  ];
  for (const [name, request, reason] of cases) {
    await t.test(name, async () => {
      const { provider } = fixture();
      assert.deepEqual(await provider.getEntryQuote(request), { status: "unknown", reason });
    });
  }
});
