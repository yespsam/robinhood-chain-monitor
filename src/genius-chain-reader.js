import { Interface, keccak256 } from "ethers";

// Reviewed 2026-09-18 against genius.fun/contracts/manifest.json and
// /contracts/abi/4.1.0/GeniusLaunchFactory.json. Never load executable ABI or
// replace these identity pins from a remotely changed manifest at runtime.
export const GENIUS_FACTORY = "0x78EAE9537C0ef90DFe9B7ae964682Fe8138afe31";
export const GENIUS_START_BLOCK = 122266383;
// Official manifest begins at the platform deployment, 270 blocks before this
// factory. Receipt + empty predecessor code + runtime on the birth block were
// independently checked against Blast and Blockmachine on 2026-09-18.
export const GENIUS_FACTORY_DEPLOY_BLOCK = 122266653;
export const GENIUS_FACTORY_DEPLOY_TX = "0xe22293ddd7b7b65d6c930bb888ab3da5cc23317902caffbead05562b09561557";
export const GENIUS_FACTORY_CODE_HASH = "0x416f19c32fbf75ea1a0cd2f51d05f0722f1f4cb0dbaf8f00cb22832345d4eef6";
export const GENIUS_FACTORY_ABI = Object.freeze([
  "event BuybackEnabledUpdated(address indexed token, bool enabled, address indexed controller)",
  "event CreatorFeeRecipientChangeCancelled(address indexed token, address indexed proposedRecipient)",
  "event CreatorFeeRecipientChangeProposed(address indexed token, address indexed currentRecipient, address indexed proposedRecipient, uint256 effectiveAt, uint256 expiresAt)",
  "event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)",
  "event GraduationExecutorSet(address executor)",
  "event GraduationTokensPermanentlyLocked(address indexed token, uint256 amount)",
  "event LaunchConfigAdded(uint256 indexed id)",
  "event LaunchConfigUpdated(uint256 indexed id)",
  "event LaunchDeployerSet(address deployer)",
  "event LaunchEnabledUpdated(bool enabled)",
  "event LaunchFeeUpdated(uint256 launchFee)",
  "event LaunchForceSwept(address indexed token)",
  "event LaunchForwarderSet(address forwarder)",
  "event LaunchGraduationRescued(address indexed token, address indexed recipient, uint256 quoteAmount, uint256 tokenAmount)",
  "event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)",
  "event MaxCreatorTaxUpdated(uint256 bps)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event PairTokenApprovalUpdated(address indexed pairToken, bool approved)",
  "event PairTokenEconomicsUpdated(address indexed pairToken, uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "event SnipeTaxSecondsUpdated(uint256 secondsWindow)",
  "event SnipeTaxStartBpsUpdated(uint256 bps)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event WhitelistedLauncherUpdated(address indexed launcher, bool enabled)",
]);

const FACTORY = GENIUS_FACTORY.toLowerCase();
const ABI = new Interface(GENIUS_FACTORY_ABI);
const TOKEN_ABI = new Interface([
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/u;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LOGS = 10_000;
const MAX_EVENT_BLOCKS = 24;
// Shared across reader instances and calls: a second head()/readRange() must
// not reset the host's pacing clock or open a concurrent connection burst.
const HOST_PACERS = new Map();
const MAX_PENDING_PER_HOST = 64;

function acquireHost(hostname, spacingMs, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let pacer = HOST_PACERS.get(hostname);
  if (!pacer) {
    // Bound long-lived state even if a caller repeatedly constructs readers
    // with distinct endpoints. Only expired, idle hosts can be evicted.
    if (HOST_PACERS.size >= 128) {
      for (const [host, prior] of HOST_PACERS) {
        if (!prior.active && !prior.queue.length && prior.nextAt <= Date.now()) HOST_PACERS.delete(host);
      }
      if (HOST_PACERS.size >= 128) return Promise.reject(failure("GENIUS_BUSY", "too many active RPC hosts"));
    }
    pacer = { active: false, queue: [], nextAt: 0, timer: null };
    HOST_PACERS.set(hostname, pacer);
  }
  if (pacer.queue.length >= MAX_PENDING_PER_HOST) return Promise.reject(failure("GENIUS_BUSY", "RPC host request queue is full"));
  function pump() {
    if (pacer.active || pacer.timer || !pacer.queue.length) return;
    const wait = Math.max(0, pacer.nextAt - Date.now());
    if (wait) {
      pacer.timer = setTimeout(() => { pacer.timer = null; pump(); }, wait);
      return;
    }
    const entry = pacer.queue.shift();
    entry.signal.removeEventListener("abort", entry.abort);
    if (entry.signal.aborted) { entry.reject(entry.signal.reason); pump(); return; }
    pacer.active = true;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      pacer.active = false;
      pacer.nextAt = Date.now() + entry.spacingMs;
      pump();
    });
  }
  return new Promise((resolve, reject) => {
    const entry = { signal, spacingMs, resolve, reject, abort: null };
    entry.abort = () => {
      const index = pacer.queue.indexOf(entry);
      if (index >= 0) pacer.queue.splice(index, 1);
      signal.removeEventListener("abort", entry.abort);
      reject(signal.reason);
      if (!pacer.queue.length && pacer.timer) { clearTimeout(pacer.timer); pacer.timer = null; }
      pump();
    };
    signal.addEventListener("abort", entry.abort, { once: true });
    pacer.queue.push(entry);
    pump();
  });
}

function failure(code, message) {
  return Object.assign(new Error(`Genius: ${message}`), { code });
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function quantity(value, label) {
  if (typeof value !== "string" || !QUANTITY.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw failure("GENIUS_INVALID_RPC", `${label} is not a safe canonical quantity`);
  }
  return Number(BigInt(value));
}

const tag = (number) => `0x${number.toString(16)}`;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

function provider(urlValue) {
  let url;
  try { url = new URL(urlValue); } catch { throw new TypeError("rpcUrls must contain valid HTTPS URLs"); }
  const labels = url.hostname.toLowerCase().replace(/\.$/u, "").split(".");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || labels.length < 2
    || /^[\d.]+$/u.test(url.hostname)
    || labels.some((value) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value))) {
    throw new TypeError("rpcUrls must use credential-free HTTPS DNS origins");
  }
  return { url: url.href, hostname: url.hostname.toLowerCase(), trustDomain: labels.slice(-2).join(".") };
}

function providerGroup(urls, label) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 4) throw new TypeError(`${label} must contain 2 to 4 independent RPC origins`);
  const group = urls.map(provider);
  if (new Set(group.map((source) => source.hostname)).size !== group.length
    || new Set(group.map((source) => source.trustDomain)).size !== group.length) {
    throw new TypeError(`${label} must use distinct provider trust domains`);
  }
  return group;
}

function abortRace(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(value).then((result) => {
      signal.removeEventListener("abort", stop); resolve(result);
    }, (error) => { signal.removeEventListener("abort", stop); reject(error); });
  });
}

async function responseText(response, signal) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw failure("GENIUS_RESPONSE_TOO_LARGE", "RPC response exceeds 2 MiB");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const value = await abortRace(response.text(), signal);
    if (Buffer.byteLength(value, "utf8") > MAX_RESPONSE_BYTES) throw failure("GENIUS_RESPONSE_TOO_LARGE", "RPC response exceeds 2 MiB");
    return value;
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await abortRace(reader.read(), signal);
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw failure("GENIUS_RESPONSE_TOO_LARGE", "RPC response exceeds 2 MiB");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Do not allow a broken stream's cancel promise to defeat the read deadline.
    Promise.resolve(reader.cancel()).catch(() => {});
  }
}

function normalizeBlock(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || quantity(value.number, "block.number") !== expected || !matches(HASH, value.hash)) {
    throw failure("GENIUS_INVALID_RPC", "block identity mismatch");
  }
  return { number: expected, hash: value.hash.toLowerCase(), timestamp: quantity(value.timestamp, "block.timestamp") };
}

function same(values, code, label) {
  const first = JSON.stringify(values[0]);
  if (values.some((value) => JSON.stringify(value) !== first)) throw failure(code, label);
  return values[0];
}

function normalizedLogs(logs, fromBlock, toBlock) {
  if (!Array.isArray(logs) || logs.length > MAX_LOGS) throw failure("GENIUS_RANGE_TOO_DENSE", "log result exceeds the bounded limit; subdivide range");
  const result = logs.map((log) => {
    if (!log || typeof log !== "object" || Array.isArray(log) || !matches(ADDRESS, log.address)
      || log.address.toLowerCase() !== FACTORY || log.removed !== false
      || !matches(HASH, log.blockHash) || !matches(HASH, log.transactionHash)
      || !matches(BYTES, log.data) || log.data.length > 65_538
      || !Array.isArray(log.topics) || log.topics.length < 1 || log.topics.length > 4
      || log.topics.some((topic) => !matches(HASH, topic))) {
      throw failure("GENIUS_INVALID_LOG", "invalid, removed, or foreign-factory log");
    }
    const blockNumber = quantity(log.blockNumber, "log.blockNumber");
    if (blockNumber < fromBlock || blockNumber > toBlock) throw failure("GENIUS_INVALID_LOG", "log is outside the requested range");
    return {
      address: FACTORY, blockNumber, blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(), logIndex: quantity(log.logIndex, "log.logIndex"),
      topics: log.topics.map((value) => value.toLowerCase()), data: log.data.toLowerCase(),
    };
  }).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const seen = new Set();
  for (const log of result) {
    const key = `${log.blockNumber}:${log.logIndex}`;
    if (seen.has(key)) throw failure("GENIUS_INVALID_LOG", "duplicate block/log position");
    seen.add(key);
  }
  if (new Set(result.map((log) => log.blockNumber)).size > MAX_EVENT_BLOCKS) {
    throw failure("GENIUS_RANGE_TOO_DENSE", "more than 24 event blocks; subdivide range");
  }
  return result;
}

function decode(log, block) {
  let parsed;
  try { parsed = ABI.parseLog(log); } catch { throw failure("GENIUS_INVALID_LOG", "event ABI decode failed"); }
  if (!parsed) throw failure("GENIUS_UNKNOWN_EVENT", "factory emitted an event outside the reviewed ABI");
  // Re-encoding also rejects extra/trailing words and noncanonical bool/address
  // encodings that a permissive decoder could otherwise silently normalize.
  let encoded;
  try { encoded = ABI.encodeEventLog(parsed.fragment, parsed.args); }
  catch { throw failure("GENIUS_INVALID_LOG", "event ABI re-encode failed"); }
  if (encoded.data.toLowerCase() !== log.data || JSON.stringify(encoded.topics.map((value) => value.toLowerCase())) !== JSON.stringify(log.topics)) {
    throw failure("GENIUS_INVALID_LOG", "event ABI encoding is not canonical");
  }
  const args = {};
  for (const [index, input] of parsed.fragment.inputs.entries()) {
    const value = parsed.args[index];
    args[input.name] = typeof value === "bigint" ? value.toString() : input.type === "address" ? value.toLowerCase() : value;
  }
  return {
    name: parsed.name, args, address: FACTORY, blockNumber: log.blockNumber,
    blockHash: log.blockHash, blockTimestamp: block.timestamp,
    transactionHash: log.transactionHash, logIndex: log.logIndex,
  };
}

/** Strict two-or-more-origin, pinned BSC factory reader; no signing/broadcast. */
export function createGeniusChainReader({
  rpcUrls, logRpcUrls, fetchImpl = globalThis.fetch, timeoutMs = 6_000, confirmations = 15,
  requestSpacingMs = 500, operationTimeoutMs = 60_000,
} = {}) {
  const sources = providerGroup(rpcUrls, "rpcUrls");
  const logSources = logRpcUrls === undefined ? sources : providerGroup(logRpcUrls, "logRpcUrls");
  const separateLogGroup = logSources.length !== sources.length || logSources.some((source) => !sources.some((prior) => prior.url === source.url));
  integer(timeoutMs, "timeoutMs", 10, 30_000);
  integer(confirmations, "confirmations", 1, 10_000);
  integer(requestSpacingMs, "requestSpacingMs", 0, 5_000);
  integer(operationTimeoutMs, "operationTimeoutMs", 10, 60_000);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  // Report origin URLs only: proof consumers can verify distinct HTTPS hosts
  // without exposing any provider API keys carried in a path or query string.
  const providers = Object.freeze(sources.map((source) => new URL(source.url).origin));
  const logProviders = Object.freeze(logSources.map((source) => new URL(source.url).origin));
  const rangeProviders = Object.freeze([...new Set([...providers, ...logProviders])]);
  let requestId = 0;
  let stopped = false;
  const operations = new Set();

  async function rpc(source, method, params, operationSignal) {
    // Queue time consumes the operation's deadline, not a new per-request
    // budget. A failed or stopped operation removes all of its queued work.
    const release = await acquireHost(source.hostname, requestSpacingMs, operationSignal);
    const controller = new AbortController();
    const stop = () => controller.abort(operationSignal.reason);
    if (operationSignal.aborted) stop();
    else operationSignal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(failure("GENIUS_TIMEOUT", "RPC request deadline exceeded")), timeoutMs);
    const id = ++requestId;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await abortRace(Promise.resolve().then(() => fetchImpl(source.url, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "error", signal: controller.signal,
      })), controller.signal);
      if (response?.redirected || (response?.url && new URL(response.url).origin !== new URL(source.url).origin)) {
        throw failure("GENIUS_INVALID_RPC", "RPC redirect or origin mismatch");
      }
      if (response?.status !== 200) {
        const error = failure("GENIUS_HTTP", `RPC HTTP ${Number(response?.status) || 0}`);
        error.status = Number(response?.status) || 0;
        const retryAfter = response?.headers?.get?.("retry-after");
        if (retryAfter != null) error.retryAfter = String(retryAfter).slice(0, 128);
        throw error;
      }
      let body;
      try { body = JSON.parse(await responseText(response, controller.signal)); }
      catch (error) { if (error.code) throw error; throw failure("GENIUS_INVALID_RPC", "malformed RPC JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== id
        || Object.keys(body).sort().join(",") !== "id,jsonrpc,result") {
        throw failure("GENIUS_INVALID_RPC", "RPC result identity mismatch or upstream error");
      }
      return body.result;
    } catch (error) {
      // A URL may contain a provider key; never surface a fetch implementation's
      // raw error text. Keep bounded retry/status facts and a sanitized origin.
      const known = typeof error?.code === "string" && error.code.startsWith("GENIUS_");
      const result = known ? Object.assign(new Error(error.message), { code: error.code })
        : failure("GENIUS_NETWORK", "RPC transport failed");
      if (Number.isInteger(error?.status)) result.status = error.status;
      if (error?.retryAfter != null) result.retryAfter = error.retryAfter;
      result.providerOrigin = new URL(source.url).origin;
      result.rpcMethod = method;
      throw result;
    } finally {
      clearTimeout(timer);
      operationSignal.removeEventListener("abort", stop);
      controller.abort(failure("GENIUS_ABORTED", "RPC request finished"));
      release();
    }
  }

  async function operation(run) {
    if (stopped) throw failure("GENIUS_STOPPED", "reader is stopped");
    const controller = new AbortController();
    operations.add(controller);
    const timer = setTimeout(() => controller.abort(failure("GENIUS_TIMEOUT", "operation deadline exceeded")), operationTimeoutMs);
    try { return await abortRace(run(controller.signal), controller.signal); }
    finally {
      clearTimeout(timer);
      operations.delete(controller);
      controller.abort(failure("GENIUS_ABORTED", "operation finished"));
    }
  }

  function stop() {
    stopped = true;
    for (const controller of operations) controller.abort(failure("GENIUS_STOPPED", "reader is stopped"));
  }

  async function blocks(number, signal, group = sources) {
    return same(await Promise.all(group.map(async (source) => normalizeBlock(
      await rpc(source, "eth_getBlockByNumber", [tag(number), false], signal), number,
    ))), "GENIUS_REORG", `providers disagree on block ${number}`);
  }

  async function pinned(number, signal, allowPredeployment = false) {
    await Promise.all(sources.map(async (source) => {
      const code = await rpc(source, "eth_getCode", [FACTORY, tag(number)], signal);
      if (allowPredeployment && number < GENIUS_FACTORY_DEPLOY_BLOCK) {
        if (code !== "0x") throw failure("GENIUS_FACTORY_IDENTITY", "factory unexpectedly exists before its verified deployment");
        return;
      }
      if (!matches(BYTES, code) || code === "0x" || keccak256(code) !== GENIUS_FACTORY_CODE_HASH) {
        throw failure("GENIUS_FACTORY_IDENTITY", "factory runtime bytecode does not match the reviewed pin");
      }
    }));
  }

  async function verifiedHead(signal) {
    const tips = await Promise.all(sources.map(async (source) => {
      const [chain, tip] = await Promise.all([
        rpc(source, "eth_chainId", [], signal), rpc(source, "eth_blockNumber", [], signal),
      ]);
      if (quantity(chain, "chainId") !== 56) throw failure("GENIUS_WRONG_CHAIN", "RPC chainId is not BSC 56");
      return quantity(tip, "head.number");
    }));
    const number = Math.min(...tips) - confirmations;
    if (number < GENIUS_START_BLOCK) throw failure("GENIUS_HEAD_UNAVAILABLE", "confirmed head precedes the factory deployment");
    const before = await blocks(number, signal);
    await pinned(number, signal);
    const after = await blocks(number, signal);
    same([before, after], "GENIUS_REORG", "confirmed head changed during identity verification");
    return { ...after, providers };
  }

  async function head() { return operation(verifiedHead); }

  async function readRange(fromBlock, toBlock) {
    integer(fromBlock, "fromBlock", GENIUS_START_BLOCK, Number.MAX_SAFE_INTEGER);
    integer(toBlock, "toBlock", fromBlock, Number.MAX_SAFE_INTEGER);
    if (toBlock - fromBlock + 1 > 2_048) throw new RangeError("Genius readRange accepts at most 2048 blocks");
    return operation(async (signal) => {
      const current = await verifiedHead(signal);
      if (toBlock > current.number) throw failure("GENIUS_UNCONFIRMED_RANGE", "range extends beyond the confirmed common head");
      const isCurrent = toBlock === current.number;
      const anchor = isCurrent ? { number: current.number, hash: current.hash, timestamp: current.timestamp } : await blocks(toBlock, signal);
      const start = fromBlock === toBlock ? anchor : await blocks(fromBlock, signal);
      if (!isCurrent) await pinned(toBlock, signal, true);
      if (separateLogGroup) {
        // Every log endpoint is tied to BSC 56 and the exact historical
        // boundaries agreed by the code-verification group. An overlapping
        // endpoint may reuse only this operation's completed chain-id check.
        await Promise.all(logSources.filter((source) => !sources.some((prior) => prior.url === source.url)).map(async (source) => {
          if (quantity(await rpc(source, "eth_chainId", [], signal), "log chainId") !== 56) {
            throw failure("GENIUS_WRONG_CHAIN", "log RPC chainId is not BSC 56");
          }
        }));
        same([anchor, await blocks(toBlock, signal, logSources)], "GENIUS_REORG", "log group end anchor differs from code group");
        if (fromBlock !== toBlock) same([start, await blocks(fromBlock, signal, logSources)], "GENIUS_REORG", "log group start anchor differs from code group");
      }
      const logs = same(await Promise.all(logSources.map(async (source) => normalizedLogs(
        await rpc(source, "eth_getLogs", [{ address: FACTORY, fromBlock: tag(fromBlock), toBlock: tag(toBlock) }], signal),
        fromBlock, toBlock,
      ))), "GENIUS_LOG_CONSENSUS", "providers disagree on factory logs");
      if (logs.some((log) => log.blockNumber < GENIUS_FACTORY_DEPLOY_BLOCK)) {
        throw failure("GENIUS_FACTORY_IDENTITY", "factory log precedes its verified deployment");
      }
      const headers = new Map([[fromBlock, start], [toBlock, anchor]]);
      const remaining = [...new Set(logs.map((log) => log.blockNumber))].filter((number) => !headers.has(number));
      // Bound queued work to two event blocks; host pacing further serializes
      // physical reads, and the entire operation (including queue time) expires.
      for (let offset = 0; offset < remaining.length; offset += 2) {
        await Promise.all(remaining.slice(offset, offset + 2).map(async (number) => headers.set(number, await blocks(number, signal, logSources))));
      }
      const events = logs.map((log) => {
        const block = headers.get(log.blockNumber);
        if (block.hash !== log.blockHash || block.timestamp > anchor.timestamp || block.timestamp < start.timestamp) {
          throw failure("GENIUS_REORG", "event header does not match the agreed canonical block");
        }
        return decode(log, block);
      });
      const endAfter = await blocks(toBlock, signal);
      const startAfter = fromBlock === toBlock ? endAfter : await blocks(fromBlock, signal);
      same([anchor, endAfter], "GENIUS_REORG", "range end changed during log verification");
      same([start, startAfter], "GENIUS_REORG", "range start changed during log verification");
      if (separateLogGroup) {
        same([anchor, await blocks(toBlock, signal, logSources)], "GENIUS_REORG", "log group end changed during verification");
        if (fromBlock !== toBlock) same([start, await blocks(fromBlock, signal, logSources)], "GENIUS_REORG", "log group start changed during verification");
      }
      return { fromBlock, toBlock, anchor, events, providers: rangeProviders, codeProviders: providers, logProviders };
    });
  }

  async function readToken(token) {
    if (!matches(ADDRESS, token) || token.toLowerCase() === ZERO_ADDRESS) throw new TypeError("token must be a nonzero EVM address");
    const requested = token.toLowerCase();
    return operation(async (signal) => {
      const anchor = await verifiedHead(signal);
      const data = TOKEN_ABI.encodeFunctionData("getLaunchedToken", [requested]);
      const raw = same(await Promise.all(sources.map(async (source) => {
        const result = await rpc(source, "eth_call", [{ to: FACTORY, data }, tag(anchor.number)], signal);
        if (!matches(BYTES, result) || result.length !== 2 + 15 * 64) throw failure("GENIUS_TOKEN_IDENTITY", "factory token record has an invalid ABI shape");
        return result.toLowerCase();
      })), "GENIUS_TOKEN_CONSENSUS", "providers disagree on the factory token record");
      let tuple;
      try {
        const decoded = TOKEN_ABI.decodeFunctionResult("getLaunchedToken", raw);
        if (TOKEN_ABI.encodeFunctionResult("getLaunchedToken", decoded).toLowerCase() !== raw) throw new Error("noncanonical");
        tuple = decoded[0];
      } catch { throw failure("GENIUS_TOKEN_IDENTITY", "factory token record is not canonical ABI"); }
      if (tuple.exists) {
        if (tuple.token.toLowerCase() !== requested || tuple.curve.toLowerCase() === ZERO_ADDRESS || tuple.deployer.toLowerCase() === ZERO_ADDRESS || tuple.pairToken.toLowerCase() === ZERO_ADDRESS) {
          throw failure("GENIUS_TOKEN_IDENTITY", "factory token record is inconsistent with the requested token");
        }
      } else if (raw !== `0x${"0".repeat(15 * 64)}`) {
        throw failure("GENIUS_TOKEN_IDENTITY", "nonexistent factory token has nonzero record fields");
      }
      const after = await blocks(anchor.number, signal);
      same([{ number: anchor.number, hash: anchor.hash, timestamp: anchor.timestamp }, after], "GENIUS_REORG", "token lookup anchor changed");
      return {
        exists: tuple.exists, token: requested, curve: tuple.curve.toLowerCase(), deployer: tuple.deployer.toLowerCase(),
        creatorFeeRecipient: tuple.creatorFeeRecipient.toLowerCase(), pairToken: tuple.pairToken.toLowerCase(), phase: Number(tuple.phase),
        blockNumber: anchor.number, blockHash: anchor.hash, blockTimestamp: anchor.timestamp, providers,
      };
    });
  }

  return Object.freeze({ head, readRange, readToken, stop });
}
