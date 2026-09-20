const RPC_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const DATA_RE = /^0x(?:[0-9a-f]{2})*$/u;
const HASH_RE = /^0x[0-9a-f]{64}$/u;
const QUANTITY_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

const CONFIG_KEYS = new Set(["maxResponseBytes", "requestTimeoutMs", "rpcId", "url"]);
const DEPENDENCY_KEYS = new Set(["fetchImpl", "timers"]);

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

function boundedInteger(value, fallback, label, minimum, maximum) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function canonicalQuantity(value, label) {
  if (typeof value !== "string" || !QUANTITY_RE.test(value)) {
    throw new Error(`${label} is not a canonical JSON-RPC quantity`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_BIGINT) throw new Error(`${label} exceeds the safe integer range`);
  return Number(parsed);
}

function canonicalBlockTag(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("blockTag must be a non-negative safe integer");
  return `0x${value.toString(16)}`;
}

function abortError(reason, fallback = "BSC JSON-RPC request aborted") {
  const error = reason instanceof Error ? reason : new Error(fallback);
  if (!(reason instanceof Error)) error.name = "AbortError";
  error.code ||= "ABORT_ERR";
  return error;
}

function raceWithAbort(value, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function providerTrustDomain(hostname) {
  const labels = hostname.toLowerCase().replace(/\.+$/u, "").split(".").filter(Boolean);
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new TypeError("url must use a DNS hostname");
  }
  // Production BSC origins use ordinary .com/.org/.io/.xyz domains. Grouping
  // by the last two labels prevents two subdomains of one operator from being
  // presented as independent quote evidence.
  return labels.slice(-2).join(".");
}

async function boundedResponseText(response, maximumBytes, signal) {
  const declaredLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("BSC JSON-RPC response exceeds the byte limit");
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await raceWithAbort(Promise.resolve(response.text()), signal);
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error("BSC JSON-RPC response exceeds the byte limit");
    return text;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await raceWithAbort(reader.read(), signal);
    if (done) break;
    bytes += value?.byteLength || 0;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("BSC JSON-RPC response exceeds the byte limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Creates one strict, single-origin BSC JSON-RPC reader. It deliberately has
 * no retry, fallback, signer, wallet, transaction, or broadcast capability.
 * A quote provider combines two readers with different trust domains.
 */
export function createNarrativeBscJsonRpcReader(config = {}, dependencies = {}) {
  onlyAllowedKeys(config, CONFIG_KEYS, "config");
  onlyAllowedKeys(dependencies, DEPENDENCY_KEYS, "dependencies");
  const rpcId = String(config.rpcId || "");
  if (!RPC_ID_RE.test(rpcId)) throw new TypeError("rpcId is invalid");
  let url;
  try { url = new URL(config.url); }
  catch { throw new TypeError("url must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new TypeError("url must be a credential-free HTTPS URL");
  }
  const trustDomain = providerTrustDomain(url.hostname);
  const requestTimeoutMs = boundedInteger(
    config.requestTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    "requestTimeoutMs",
    100,
    30_000,
  );
  const maxResponseBytes = boundedInteger(
    config.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    1_024,
    4_000_000,
  );
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const timers = dependencies.timers ?? globalThis;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function") {
    throw new TypeError("timers must expose setTimeout and clearTimeout");
  }
  let nextId = 1;

  async function request(method, params, options = {}) {
    if (!(exactKeys(options, []) || exactKeys(options, ["signal"]))) {
      throw new TypeError("RPC options may only contain signal");
    }
    const externalSignal = options.signal;
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
      throw new TypeError("signal must be an AbortSignal");
    }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(externalSignal.reason || abortError(null));
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = timers.setTimeout(
      () => controller.abort(Object.assign(new Error(`BSC JSON-RPC request timed out after ${requestTimeoutMs}ms`), { code: "TIMEOUT" })),
      requestTimeoutMs,
    );
    timeout?.unref?.();
    const id = nextId;
    nextId = nextId === Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
    const payload = Object.freeze({ jsonrpc: "2.0", id, method, params });
    try {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      const fetchPromise = Promise.resolve().then(() => fetchImpl(url.href, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
      }));
      const response = await raceWithAbort(fetchPromise, controller.signal);
      if (!response || typeof response.status !== "number") throw new Error("BSC JSON-RPC returned an invalid HTTP response");
      if (response.redirected === true
        || (response.url && new URL(response.url).origin !== url.origin)) {
        throw new Error("BSC JSON-RPC redirect or response origin mismatch");
      }
      if (response.status !== 200) {
        const error = new Error(`BSC JSON-RPC HTTP ${response.status}`);
        error.status = response.status;
        const retryAfter = response?.headers?.get?.("retry-after");
        if (retryAfter != null) error.retryAfter = String(retryAfter).slice(0, 128);
        throw error;
      }
      const text = await boundedResponseText(response, maxResponseBytes, controller.signal);
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { throw new Error("BSC JSON-RPC returned malformed JSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || parsed.jsonrpc !== "2.0" || parsed.id !== id
        || !(exactKeys(parsed, ["id", "jsonrpc", "result"])
          || exactKeys(parsed, ["error", "id", "jsonrpc"]))) {
        throw new Error("BSC JSON-RPC response identity or shape mismatch");
      }
      if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
        throw new Error("BSC JSON-RPC returned an error");
      }
      return parsed.result;
    } finally {
      timers.clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async function getNetwork(options = {}) {
    const result = await request("eth_chainId", [], options);
    const chainId = canonicalQuantity(result, "eth_chainId result");
    if (chainId !== 56) throw new Error("BSC JSON-RPC chain id mismatch");
    return Object.freeze({ chainId });
  }

  async function getBlockNumber(options = {}) {
    return canonicalQuantity(await request("eth_blockNumber", [], options), "eth_blockNumber result");
  }

  async function getBlock(blockNumber, options = {}) {
    const requestedNumber = canonicalBlockTag(blockNumber);
    const result = await request("eth_getBlockByNumber", [requestedNumber, false], options);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("BSC JSON-RPC block is unavailable");
    const number = canonicalQuantity(result.number, "block.number");
    const timestamp = canonicalQuantity(result.timestamp, "block.timestamp");
    const hash = String(result.hash || "");
    if (number !== blockNumber || !HASH_RE.test(hash)) throw new Error("BSC JSON-RPC block identity mismatch");
    return Object.freeze({ number, hash, timestamp });
  }

  async function call(value, options = {}) {
    if (!exactKeys(value, ["blockTag", "data", "to"])) throw new TypeError("eth_call request shape is invalid");
    if (typeof value.to !== "string" || !ADDRESS_RE.test(value.to) || /^0x0{40}$/u.test(value.to)) {
      throw new TypeError("eth_call target must be a canonical lowercase non-zero address");
    }
    if (typeof value.data !== "string" || !DATA_RE.test(value.data)) throw new TypeError("eth_call data must be canonical lowercase bytes");
    const blockTag = canonicalBlockTag(value.blockTag);
    const result = await request("eth_call", [{ to: value.to, data: value.data }, blockTag], options);
    if (typeof result !== "string" || !DATA_RE.test(result)) throw new Error("eth_call result is not canonical bytes");
    return result;
  }

  return Object.freeze({ rpcId, trustDomain, getNetwork, getBlockNumber, getBlock, call });
}
