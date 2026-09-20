import { createHash } from "node:crypto";
import { Interface } from "ethers";

export const NARRATIVE_BSC_V2_QUOTE_PROVIDER_VERSION = 2;
export const NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID = "bsc.pancakeswap-v2.dual-rpc-shadow-quote.v2";
export const NARRATIVE_BSC_V2_ROUTE_ADMISSION_MODE = "dynamic_factory_verified_reviewed_quote_only";
export const BSC_PANCAKESWAP_V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
export const BSC_WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
export const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
export const BSC_USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
export const BSC_CHAINLINK_BNB_USD = "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee";
export const BSC_CHAINLINK_USDT_USD = "0xb97ad0e74fa7d920791e90258a6e2085088b4320";
export const BSC_CHAINLINK_USDC_USD = "0x51597f405303c4377e36123cbc172b13269ea163";

export const NARRATIVE_BSC_V2_QUOTE_COVERAGE = Object.freeze({
  chainId: 56,
  factory: BSC_PANCAKESWAP_V2_FACTORY,
  routing: "dynamic_getPair_verified",
  reviewedQuoteTokens: Object.freeze([BSC_WBNB, BSC_USDT, BSC_USDC]),
  unsupportedQuotePolicy: "unknown",
  marketExecutableSemantics: "constant_product_route_math_only_requires_external_risk_gate",
  execution: false,
});

const BSC_CHAIN_ID = 56;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/u;
const HEX_RE = /^0x(?:[0-9a-f]{2})*$/u;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/u;
const ORDER_ID_RE = /^shadow:[0-9a-f]{64}$/u;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const RPC_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const TRUST_DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const MAX_UINT112 = (1n << 112n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_SHADOW_NOTIONAL_USD_MICROS = 100_000_000n;
const BPS = 10_000n;
const USD_MICROS = 1_000_000n;
const PANCAKE_V2_FEE_BPS = 25;
const ALLOWED_FACTORY = BSC_PANCAKESWAP_V2_FACTORY;

const QUOTE_ASSETS = new Map([
  [BSC_WBNB, Object.freeze({
    tokenDecimals: 18,
    oracle: BSC_CHAINLINK_BNB_USD,
    oracleDecimals: 8,
    oracleDescription: "BNB / USD",
  })],
  [BSC_USDT, Object.freeze({
    tokenDecimals: 18,
    oracle: BSC_CHAINLINK_USDT_USD,
    oracleDecimals: 8,
    oracleDescription: "USDT / USD",
  })],
  [BSC_USDC, Object.freeze({
    tokenDecimals: 18,
    oracle: BSC_CHAINLINK_USDC_USD,
    oracleDecimals: 8,
    oracleDescription: "USDC / USD",
  })],
]);

const CONFIG_KEYS = new Set([
  "confirmations",
  "maximumBlockAgeMs",
  "maximumFutureSkewMs",
  "maximumHeadLagBlocks",
  "maximumOracleAgeMs",
  "maximumRequestAgeMs",
  "providerId",
  "quoteValidityMs",
  "rpcBudgetMs",
]);
const DEPENDENCY_KEYS = new Set(["now", "primaryRpc", "secondaryRpc"]);
const RPC_KEYS = ["call", "getBlock", "getBlockNumber", "getNetwork", "rpcId", "trustDomain"];
const FORBIDDEN_RPC_CAPABILITIES = [
  "broadcastTransaction", "getSigner", "send", "sendTransaction", "signMessage",
  "signTransaction", "swap",
];
const NETWORK_KEYS = ["chainId"];
const BLOCK_KEYS = ["hash", "number", "timestamp"];
const QUOTE_REQUEST_KEYS = [
  "ca", "chainId", "executable", "kind", "maximumSlippageBps", "mode", "orderId",
  "poolAddress", "providerId", "quantityRaw", "requestedAt", "schema", "side", "valueUsdMicros",
];
const CANONICAL_REQUEST_KEYS = [
  "blockNumber", "chainId", "executable", "expectedBlockHash", "mode", "providerId",
  "requestedAt", "schema",
];

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

class ClosedQuoteError extends Error {
  constructor(code) {
    super(code);
    this.name = "NarrativeBscV2ClosedQuoteError";
    this.code = code;
  }
}

function close(code) {
  throw new ClosedQuoteError(code);
}

function unknown(code) {
  return Object.freeze({ status: "unknown", reason: String(code || "quote_unavailable").slice(0, 128) });
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && wanted.every((key, index) => key === actual[index]);
}

function onlyAllowedKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not an admitted option`);
  }
}

function requestAddress(value, code) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value) || /^0x0{40}$/u.test(value)) close(code);
  return value;
}

function canonicalUint(value, code, { positive = false, maximum = null } = {}) {
  if (typeof value !== "string" || value.length > 78 || !UINT_RE.test(value)) close(code);
  const parsed = BigInt(value);
  if (positive && parsed === 0n) close(code);
  if (maximum !== null && parsed > maximum) close(code);
  return parsed;
}

function exactIsoMilliseconds(value, code) {
  if (typeof value !== "string") close(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) close(code);
  return milliseconds;
}

function safeInteger(value, code, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) close(code);
  return value;
}

function configInteger(value, fallback, label, minimum, maximum) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function clockMilliseconds(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) close("invalid_provider_clock");
  return value;
}

function abortCode(signal) {
  return signal?.reason instanceof ClosedQuoteError ? signal.reason.code : "request_aborted";
}

function abortIfRequested(signal) {
  if (signal?.aborted) close(abortCode(signal));
}

function createBudgetScope(externalSignal, budgetMs) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(new ClosedQuoteError("request_aborted"));
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new ClosedQuoteError("rpc_budget_exceeded"));
  }, budgetMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
    },
  };
}

async function awaitRpc(signal, invoke) {
  abortIfRequested(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new ClosedQuoteError(abortCode(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(Object.freeze({ signal }))),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function validateAdapter(adapter, label) {
  if (!exactKeys(adapter, RPC_KEYS)) {
    throw new TypeError(`${label} must expose only rpcId/trustDomain and four read methods`);
  }
  if (!RPC_ID_RE.test(String(adapter.rpcId || ""))) throw new TypeError(`${label}.rpcId is invalid`);
  if (!TRUST_DOMAIN_RE.test(String(adapter.trustDomain || ""))) throw new TypeError(`${label}.trustDomain is invalid`);
  for (const method of ["call", "getBlock", "getBlockNumber", "getNetwork"]) {
    if (typeof adapter[method] !== "function") throw new TypeError(`${label}.${method} must be a function`);
  }
  for (const method of FORBIDDEN_RPC_CAPABILITIES) {
    if (typeof adapter[method] === "function") throw new TypeError(`${label}.${method} is an execution capability`);
  }
  return adapter;
}

function normalizeNetwork(value) {
  if (!exactKeys(value, NETWORK_KEYS) || typeof value.chainId !== "number") close("invalid_network_shape");
  return { chainId: safeInteger(value.chainId, "invalid_network_chain_id", 1) };
}

function normalizeHead(value) {
  if (typeof value !== "number") close("invalid_head_shape");
  return safeInteger(value, "invalid_head_block");
}

function normalizeBlock(value, expectedNumber) {
  if (!exactKeys(value, BLOCK_KEYS)) close("invalid_block_shape");
  if (typeof value.number !== "number" || typeof value.timestamp !== "number" || typeof value.hash !== "string") {
    close("invalid_block_shape");
  }
  const number = safeInteger(value.number, "invalid_block_number");
  if (number !== expectedNumber) close("block_number_mismatch");
  if (!BLOCK_HASH_RE.test(value.hash)) close("invalid_block_hash");
  const timestampSeconds = safeInteger(value.timestamp, "invalid_block_timestamp", 1);
  const timestampMs = timestampSeconds * 1_000;
  if (!Number.isSafeInteger(timestampMs)) close("invalid_block_timestamp");
  return { number, hash: value.hash, timestampSeconds, timestampMs, timestamp: new Date(timestampMs).toISOString() };
}

async function readNetwork(adapter, signal) {
  return normalizeNetwork(await awaitRpc(signal, (context) => adapter.getNetwork(context)));
}

async function readHead(adapter, signal) {
  return normalizeHead(await awaitRpc(signal, (context) => adapter.getBlockNumber(context)));
}

async function readBlock(adapter, blockNumber, signal) {
  return normalizeBlock(await awaitRpc(signal, (context) => adapter.getBlock(blockNumber, context)), blockNumber);
}

async function readCall(adapter, to, iface, method, args, blockNumber, signal) {
  abortIfRequested(signal);
  const request = Object.freeze({
    to,
    data: iface.encodeFunctionData(method, args),
    blockTag: blockNumber,
  });
  const raw = await awaitRpc(signal, (context) => adapter.call(request, context));
  if (typeof raw !== "string" || !HEX_RE.test(raw)) close("invalid_rpc_call_shape");
  return raw;
}

function decodeAddress(iface, method, raw, code) {
  try {
    const value = String(iface.decodeFunctionResult(method, raw)?.[0] || "").toLowerCase();
    if (!ADDRESS_RE.test(value) || /^0x0{40}$/u.test(value)) close(code);
    return value;
  } catch (error) {
    if (error instanceof ClosedQuoteError) throw error;
    close(code);
  }
}

function decodeDecimals(iface, raw, code) {
  try {
    const value = Number(iface.decodeFunctionResult("decimals", raw)?.[0]);
    return safeInteger(value, code, 0, 36);
  } catch (error) {
    if (error instanceof ClosedQuoteError) throw error;
    close(code);
  }
}

function decodeDescription(raw) {
  try {
    const value = String(ORACLE_INTERFACE.decodeFunctionResult("description", raw)?.[0] || "");
    if (!value || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) close("invalid_oracle_description");
    return value;
  } catch (error) {
    if (error instanceof ClosedQuoteError) throw error;
    close("invalid_oracle_description");
  }
}

function decodeReserves(raw) {
  try {
    const result = PAIR_INTERFACE.decodeFunctionResult("getReserves", raw);
    const reserve0 = BigInt(result[0]);
    const reserve1 = BigInt(result[1]);
    if (reserve0 <= 0n || reserve1 <= 0n || reserve0 > MAX_UINT112 || reserve1 > MAX_UINT112) {
      close("invalid_or_empty_reserves");
    }
    return { reserve0, reserve1 };
  } catch (error) {
    if (error instanceof ClosedQuoteError) throw error;
    close("invalid_reserves_response");
  }
}

function decodeRound(raw, block, maximumOracleAgeMs) {
  try {
    const result = ORACLE_INTERFACE.decodeFunctionResult("latestRoundData", raw);
    const roundId = BigInt(result[0]);
    const answer = BigInt(result[1]);
    const startedAt = BigInt(result[2]);
    const updatedAt = BigInt(result[3]);
    const answeredInRound = BigInt(result[4]);
    if (roundId <= 0n || answer <= 0n || startedAt <= 0n || updatedAt <= 0n
      || startedAt > updatedAt || answeredInRound < roundId
      || updatedAt > BigInt(block.timestampSeconds)
      || BigInt(block.timestampSeconds) - updatedAt > BigInt(Math.floor(maximumOracleAgeMs / 1_000))) {
      close("invalid_or_stale_oracle_round");
    }
    return { roundId, answer, startedAt, updatedAt, answeredInRound };
  } catch (error) {
    if (error instanceof ClosedQuoteError) throw error;
    close("invalid_oracle_round_response");
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sameState(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) close("division_by_zero");
  return (numerator + denominator - 1n) / denominator;
}

function amountOutExactIn(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) close("invalid_swap_inputs");
  // Pancake V2 transfers exact-in before Pair._update; an input-side balance
  // above uint112 would revert even when the constant-product division itself
  // has a positive result. Transfer behavior/tax remains an upstream risk gate.
  if (reserveIn + amountIn > MAX_UINT112) close("reserve_input_uint112_overflow");
  const amountInWithFee = amountIn * BigInt(10_000 - PANCAKE_V2_FEE_BPS);
  const amountOut = (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
  if (amountOut <= 0n || amountOut >= reserveOut) close("insufficient_quote_output");
  return amountOut;
}

function slippageBps(amountIn, amountOut, reserveIn, reserveOut) {
  const idealNumerator = amountIn * reserveOut;
  const actualNumerator = amountOut * reserveIn;
  if (idealNumerator <= 0n || actualNumerator >= idealNumerator) return 0;
  const value = ceilDiv((idealNumerator - actualNumerator) * BPS, idealNumerator);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) close("invalid_slippage");
  return Number(value);
}

function validateQuoteRequest(raw, providerId, expectedKind, nowMs, policy) {
  if (!exactKeys(raw, QUOTE_REQUEST_KEYS)) close("invalid_quote_request_shape");
  if (raw.schema !== "narrative_shadow_quote_request_v1"
    || raw.providerId !== providerId
    || raw.mode !== "shadow"
    || raw.executable !== false
    || raw.chainId !== BSC_CHAIN_ID
    || raw.kind !== expectedKind
    || raw.side !== (expectedKind === "entry" ? "buy" : "sell")
    || !ORDER_ID_RE.test(String(raw.orderId || ""))) close("quote_request_identity_mismatch");
  const requestedAtMs = exactIsoMilliseconds(raw.requestedAt, "invalid_requested_at");
  if (requestedAtMs > nowMs + policy.maximumFutureSkewMs || nowMs - requestedAtMs > policy.maximumRequestAgeMs) {
    close("stale_or_future_quote_request");
  }
  const maximumSlippageBps = safeInteger(raw.maximumSlippageBps, "invalid_maximum_slippage", 0, 300);
  const ca = requestAddress(raw.ca, "invalid_ca");
  const poolAddress = requestAddress(raw.poolAddress, "invalid_pool_address");
  if (QUOTE_ASSETS.has(ca)) close("target_ca_is_reviewed_quote_asset");
  let valueUsdMicros = null;
  let quantityRaw = null;
  if (expectedKind === "entry") {
    if (raw.quantityRaw !== null) close("entry_quantity_must_be_null");
    valueUsdMicros = canonicalUint(raw.valueUsdMicros, "invalid_entry_notional", {
      positive: true,
      maximum: MAX_SHADOW_NOTIONAL_USD_MICROS,
    });
  } else {
    if (raw.valueUsdMicros !== null) close("mark_value_must_be_null");
    quantityRaw = canonicalUint(raw.quantityRaw, "invalid_mark_quantity", {
      positive: true,
      maximum: MAX_UINT256,
    });
  }
  return { ca, poolAddress, maximumSlippageBps, valueUsdMicros, quantityRaw };
}

function validateCanonicalRequest(raw, providerId, nowMs, policy) {
  if (!exactKeys(raw, CANONICAL_REQUEST_KEYS)) close("invalid_canonical_request_shape");
  if (raw.schema !== "narrative_shadow_canonical_request_v1"
    || raw.providerId !== providerId
    || raw.mode !== "shadow"
    || raw.executable !== false
    || raw.chainId !== BSC_CHAIN_ID) close("canonical_request_identity_mismatch");
  const blockNumber = safeInteger(raw.blockNumber, "invalid_canonical_block_number");
  if (typeof raw.expectedBlockHash !== "string" || !BLOCK_HASH_RE.test(raw.expectedBlockHash)) {
    close("invalid_expected_block_hash");
  }
  const requestedAtMs = exactIsoMilliseconds(raw.requestedAt, "invalid_requested_at");
  if (requestedAtMs > nowMs + policy.maximumFutureSkewMs || nowMs - requestedAtMs > policy.maximumRequestAgeMs) {
    close("stale_or_future_canonical_request");
  }
  return { blockNumber, expectedBlockHash: raw.expectedBlockHash };
}

async function consensusHead(primaryRpc, secondaryRpc, signal, policy) {
  const primaryNetwork = await readNetwork(primaryRpc, signal);
  const secondaryNetwork = await readNetwork(secondaryRpc, signal);
  if (primaryNetwork.chainId !== BSC_CHAIN_ID || secondaryNetwork.chainId !== BSC_CHAIN_ID) {
    close("rpc_chain_id_mismatch");
  }
  const primaryHead = await readHead(primaryRpc, signal);
  const secondaryHead = await readHead(secondaryRpc, signal);
  if (Math.abs(primaryHead - secondaryHead) > policy.maximumHeadLagBlocks) close("rpc_head_consensus_failed");
  const lowestHead = Math.min(primaryHead, secondaryHead);
  if (lowestHead < policy.confirmations) close("insufficient_confirmed_head");
  return { primaryHead, secondaryHead, blockNumber: lowestHead - policy.confirmations };
}

async function readRouteSnapshot(adapter, request, blockNumber, signal, policy) {
  const preBlock = await readBlock(adapter, blockNumber, signal);
  const factoryRaw = await readCall(adapter, request.poolAddress, PAIR_INTERFACE, "factory", [], blockNumber, signal);
  const token0Raw = await readCall(adapter, request.poolAddress, PAIR_INTERFACE, "token0", [], blockNumber, signal);
  const token1Raw = await readCall(adapter, request.poolAddress, PAIR_INTERFACE, "token1", [], blockNumber, signal);
  const factory = decodeAddress(PAIR_INTERFACE, "factory", factoryRaw, "invalid_factory_response");
  const token0 = decodeAddress(PAIR_INTERFACE, "token0", token0Raw, "invalid_token0_response");
  const token1 = decodeAddress(PAIR_INTERFACE, "token1", token1Raw, "invalid_token1_response");
  if (factory !== ALLOWED_FACTORY) close("factory_identity_mismatch");
  let quoteToken;
  if (token0 === request.ca && QUOTE_ASSETS.has(token1)) quoteToken = token1;
  else if (token1 === request.ca && QUOTE_ASSETS.has(token0)) quoteToken = token0;
  else close("pair_token_or_quote_identity_mismatch");
  const quote = QUOTE_ASSETS.get(quoteToken);

  const canonicalPairRaw = await readCall(
    adapter,
    factory,
    FACTORY_INTERFACE,
    "getPair",
    [request.ca, quoteToken],
    blockNumber,
    signal,
  );
  const canonicalPair = decodeAddress(FACTORY_INTERFACE, "getPair", canonicalPairRaw, "invalid_factory_pair_response");
  if (canonicalPair !== request.poolAddress) close("factory_pair_identity_mismatch");

  const reservesRaw = await readCall(adapter, request.poolAddress, PAIR_INTERFACE, "getReserves", [], blockNumber, signal);
  const targetDecimalsRaw = await readCall(adapter, request.ca, TOKEN_INTERFACE, "decimals", [], blockNumber, signal);
  const quoteDecimalsRaw = await readCall(adapter, quoteToken, TOKEN_INTERFACE, "decimals", [], blockNumber, signal);
  const oracleDecimalsRaw = await readCall(adapter, quote.oracle, ORACLE_INTERFACE, "decimals", [], blockNumber, signal);
  const oracleDescriptionRaw = await readCall(adapter, quote.oracle, ORACLE_INTERFACE, "description", [], blockNumber, signal);
  const oracleRoundRaw = await readCall(adapter, quote.oracle, ORACLE_INTERFACE, "latestRoundData", [], blockNumber, signal);
  const { reserve0, reserve1 } = decodeReserves(reservesRaw);
  const targetDecimals = decodeDecimals(TOKEN_INTERFACE, targetDecimalsRaw, "invalid_target_decimals");
  const quoteDecimals = decodeDecimals(TOKEN_INTERFACE, quoteDecimalsRaw, "invalid_quote_decimals");
  const oracleDecimals = decodeDecimals(ORACLE_INTERFACE, oracleDecimalsRaw, "invalid_oracle_decimals");
  const oracleDescription = decodeDescription(oracleDescriptionRaw);
  if (quoteDecimals !== quote.tokenDecimals) close("quote_decimals_mismatch");
  if (oracleDecimals !== quote.oracleDecimals) close("oracle_decimals_mismatch");
  if (oracleDescription !== quote.oracleDescription) close("oracle_description_mismatch");
  const oracleRound = decodeRound(oracleRoundRaw, preBlock, policy.maximumOracleAgeMs);
  const postBlock = await readBlock(adapter, blockNumber, signal);
  if (preBlock.hash !== postBlock.hash || preBlock.timestampSeconds !== postBlock.timestampSeconds) {
    close("canonical_block_changed_during_read");
  }
  return {
    block: preBlock,
    factory,
    canonicalPair,
    token0,
    token1,
    reserve0,
    reserve1,
    targetDecimals,
    quoteToken,
    quoteDecimals,
    oracle: quote.oracle,
    oracleDecimals,
    oracleDescription,
    oracleRound,
  };
}

async function consensusRoute(primaryRpc, secondaryRpc, request, blockNumber, signal, policy) {
  // Sequential pipelines ensure an abort cannot leave a fan-out of unresolved
  // contract reads. Both independent adapters still read the same pinned block.
  const primary = await readRouteSnapshot(primaryRpc, request, blockNumber, signal, policy);
  const secondary = await readRouteSnapshot(secondaryRpc, request, blockNumber, signal, policy);
  if (!sameState(primary, secondary)) close("rpc_route_consensus_failed");
  return primary;
}

function quoteResult(rawRequest, request, state, observedAt, validUntil, sources) {
  const targetIsToken0 = state.token0 === request.ca;
  const targetReserve = targetIsToken0 ? state.reserve0 : state.reserve1;
  const quoteReserve = targetIsToken0 ? state.reserve1 : state.reserve0;
  const quoteScale = 10n ** BigInt(state.quoteDecimals);
  const oracleScale = 10n ** BigInt(state.oracleDecimals);
  const oracleAnswer = state.oracleRound.answer;
  let amountIn;
  let reserveIn;
  let reserveOut;
  if (rawRequest.kind === "entry") {
    amountIn = (request.valueUsdMicros * quoteScale * oracleScale) / (oracleAnswer * USD_MICROS);
    reserveIn = quoteReserve;
    reserveOut = targetReserve;
  } else {
    amountIn = request.quantityRaw;
    reserveIn = targetReserve;
    reserveOut = quoteReserve;
  }
  if (amountIn <= 0n) close("quote_input_rounds_to_zero");
  const amountOut = amountOutExactIn(amountIn, reserveIn, reserveOut);
  const estimatedSlippageBps = slippageBps(amountIn, amountOut, reserveIn, reserveOut);
  if (estimatedSlippageBps > request.maximumSlippageBps) close("slippage_exceeds_request_limit");

  const targetScale = 10n ** BigInt(state.targetDecimals);
  let valueUsdMicros;
  let quantityRaw;
  let priceUsdMicros;
  let tokenIn;
  let tokenOut;
  if (rawRequest.kind === "entry") {
    valueUsdMicros = request.valueUsdMicros;
    quantityRaw = amountOut;
    priceUsdMicros = ceilDiv(valueUsdMicros * targetScale, quantityRaw);
    tokenIn = state.quoteToken;
    tokenOut = request.ca;
  } else {
    valueUsdMicros = (amountOut * oracleAnswer * USD_MICROS) / (quoteScale * oracleScale);
    quantityRaw = request.quantityRaw;
    if (valueUsdMicros <= 0n) close("mark_value_rounds_to_zero");
    priceUsdMicros = (valueUsdMicros * targetScale) / quantityRaw;
    if (priceUsdMicros <= 0n) close("mark_price_rounds_to_zero");
    tokenIn = request.ca;
    tokenOut = state.quoteToken;
  }

  const routeDigest = digest({
    version: NARRATIVE_BSC_V2_QUOTE_PROVIDER_VERSION,
    providerId: rawRequest.providerId,
    chainId: BSC_CHAIN_ID,
    kind: rawRequest.kind,
    side: rawRequest.side,
    factory: state.factory,
    canonicalPair: state.canonicalPair,
    poolAddress: request.poolAddress,
    ca: request.ca,
    quoteToken: state.quoteToken,
    tokenIn,
    tokenOut,
    targetDecimals: state.targetDecimals,
    quoteDecimals: state.quoteDecimals,
    feeBps: PANCAKE_V2_FEE_BPS,
    blockNumber: state.block.number,
    blockHash: state.block.hash,
    blockTimestampSeconds: state.block.timestampSeconds,
    reserveIn,
    reserveOut,
    amountIn,
    amountOut,
    requestedValueUsdMicros: request.valueUsdMicros,
    requestedQuantityRaw: request.quantityRaw,
    maximumSlippageBps: request.maximumSlippageBps,
    valueUsdMicros,
    quantityRaw,
    priceUsdMicros,
    estimatedSlippageBps,
    oracle: state.oracle,
    oracleDecimals: state.oracleDecimals,
    oracleDescription: state.oracleDescription,
    oracleRound: state.oracleRound,
    consensusSources: sources,
  });
  return Object.freeze({
    status: "ok",
    providerId: rawRequest.providerId,
    kind: rawRequest.kind,
    side: rawRequest.side,
    marketExecutable: true,
    chainId: BSC_CHAIN_ID,
    ca: request.ca,
    poolAddress: request.poolAddress,
    blockNumber: state.block.number,
    blockHash: state.block.hash,
    blockTimestamp: state.block.timestamp,
    observedAt,
    validUntil,
    valueUsdMicros: valueUsdMicros.toString(),
    quantityRaw: quantityRaw.toString(),
    priceUsdMicros: priceUsdMicros.toString(),
    estimatedSlippageBps,
    routeDigest,
  });
}

/**
 * Builds the shadow simulator's exact six-key provider. Every candidate pool is
 * dynamically re-derived from PancakeSwap V2 factory.getPair at a common block
 * and independently reproduced by two signal-aware, read-only RPC adapters.
 * `marketExecutable` describes only this pinned constant-product route math;
 * fee-on-transfer, dynamic tax, honeypot, and sellability evidence must already
 * have passed the runtime's separate live risk gate. This module never executes.
 */
export function createNarrativeBscV2QuoteProvider(config = {}, dependencies = {}) {
  onlyAllowedKeys(config, CONFIG_KEYS, "config");
  onlyAllowedKeys(dependencies, DEPENDENCY_KEYS, "dependencies");
  const providerId = config.providerId ?? NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID;
  if (typeof providerId !== "string" || !PROVIDER_ID_RE.test(providerId)) throw new TypeError("providerId is invalid");
  const primaryRpc = validateAdapter(dependencies.primaryRpc, "primaryRpc");
  const secondaryRpc = validateAdapter(dependencies.secondaryRpc, "secondaryRpc");
  if (primaryRpc.rpcId === secondaryRpc.rpcId) throw new TypeError("RPC ids must be independent");
  if (primaryRpc.trustDomain === secondaryRpc.trustDomain) throw new TypeError("RPC trust domains must be independent");
  const now = dependencies.now ?? Date.now;
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const policy = Object.freeze({
    confirmations: configInteger(config.confirmations, 2, "confirmations", 0, 20),
    quoteValidityMs: configInteger(config.quoteValidityMs, 5_000, "quoteValidityMs", 100, 30_000),
    maximumBlockAgeMs: configInteger(config.maximumBlockAgeMs, 30_000, "maximumBlockAgeMs", 1_000, 120_000),
    maximumRequestAgeMs: configInteger(config.maximumRequestAgeMs, 15_000, "maximumRequestAgeMs", 1_000, 60_000),
    maximumFutureSkewMs: configInteger(config.maximumFutureSkewMs, 1_000, "maximumFutureSkewMs", 0, 10_000),
    maximumHeadLagBlocks: configInteger(config.maximumHeadLagBlocks, 3, "maximumHeadLagBlocks", 0, 100),
    maximumOracleAgeMs: configInteger(config.maximumOracleAgeMs, 5_400_000, "maximumOracleAgeMs", 1_000, 7_200_000),
    rpcBudgetMs: configInteger(config.rpcBudgetMs, 8_000, "rpcBudgetMs", 10, 30_000),
  });
  const sources = Object.freeze([
    Object.freeze({ rpcId: primaryRpc.rpcId, trustDomain: primaryRpc.trustDomain }),
    Object.freeze({ rpcId: secondaryRpc.rpcId, trustDomain: secondaryRpc.trustDomain }),
  ]);

  async function quote(raw, expectedKind, options = {}) {
    const scope = createBudgetScope(options?.signal, policy.rpcBudgetMs);
    try {
      const startMs = clockMilliseconds(now);
      const request = validateQuoteRequest(raw, providerId, expectedKind, startMs, policy);
      const head = await consensusHead(primaryRpc, secondaryRpc, scope.signal, policy);
      const state = await consensusRoute(primaryRpc, secondaryRpc, request, head.blockNumber, scope.signal, policy);
      const observedMs = clockMilliseconds(now);
      abortIfRequested(scope.signal);
      if (state.block.timestampMs > observedMs + policy.maximumFutureSkewMs
        || observedMs - state.block.timestampMs > policy.maximumBlockAgeMs) close("stale_or_future_quote_block");
      return quoteResult(
        raw,
        request,
        state,
        new Date(observedMs).toISOString(),
        new Date(observedMs + policy.quoteValidityMs).toISOString(),
        sources,
      );
    } catch (error) {
      return unknown(error instanceof ClosedQuoteError ? error.code : "rpc_read_failure");
    } finally {
      scope.cleanup();
    }
  }

  async function readCanonicalPair(adapter, blockNumber, signal) {
    const before = await readBlock(adapter, blockNumber, signal);
    const after = await readBlock(adapter, blockNumber, signal);
    if (!sameState(before, after)) close("canonical_block_changed_during_read");
    return before;
  }

  async function checkCanonicalBlock(raw, options = {}) {
    const scope = createBudgetScope(options?.signal, policy.rpcBudgetMs);
    try {
      const request = validateCanonicalRequest(raw, providerId, clockMilliseconds(now), policy);
      const head = await consensusHead(primaryRpc, secondaryRpc, scope.signal, policy);
      if (request.blockNumber > head.blockNumber) close("canonical_block_not_confirmed");
      const primaryBlock = await readCanonicalPair(primaryRpc, request.blockNumber, scope.signal);
      const secondaryBlock = await readCanonicalPair(secondaryRpc, request.blockNumber, scope.signal);
      if (!sameState(primaryBlock, secondaryBlock)) close("rpc_block_consensus_failed");
      abortIfRequested(scope.signal);
      return Object.freeze({
        status: "ok",
        providerId,
        chainId: BSC_CHAIN_ID,
        blockNumber: primaryBlock.number,
        blockHash: primaryBlock.hash,
        observedAt: new Date(clockMilliseconds(now)).toISOString(),
      });
    } catch (error) {
      return unknown(error instanceof ClosedQuoteError ? error.code : "rpc_read_failure");
    } finally {
      scope.cleanup();
    }
  }

  return Object.freeze({
    providerId,
    trusted: true,
    readOnly: true,
    getEntryQuote: (request, options) => quote(request, "entry", options),
    getPositionMark: (request, options) => quote(request, "mark", options),
    checkCanonicalBlock,
  });
}
