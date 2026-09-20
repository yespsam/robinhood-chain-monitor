import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { Interface, keccak256 } from "ethers";
import {
  createGeniusChainReader, GENIUS_FACTORY, GENIUS_START_BLOCK,
  GENIUS_FACTORY_CODE_HASH, GENIUS_FACTORY_ABI, GENIUS_FACTORY_DEPLOY_BLOCK, GENIUS_FACTORY_DEPLOY_TX,
} from "../src/genius-chain-reader.js";

// Public BSC runtime captured 2026-09-18; keccak is asserted below. Offline
// fixture avoids weakening production identity checks or requiring live RPC.
const CODE = `0x${gunzipSync(Buffer.from("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", "base64")).toString("hex")}`;
const URLS = ["https://rpc.48.club", "https://rpc-bnb.blockmachine.io"];
const ABI = new Interface(GENIUS_FACTORY_ABI);
const START = GENIUS_FACTORY_DEPLOY_BLOCK;
const TIP = START + 200;
const ADDR = "0x1111111111111111111111111111111111111111";
const CURVE = "0x2222222222222222222222222222222222222222";
const DEPLOYER = "0x3333333333333333333333333333333333333333";
const ZERO = `0x${"0".repeat(40)}`;
const TOKEN_ABI = new Interface(["function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))"]);
function tokenRecord(overrides = {}) {
  return TOKEN_ABI.encodeFunctionResult("getLaunchedToken", [{ token: ADDR, curve: CURVE, deployer: DEPLOYER, creatorFeeRecipient: DEPLOYER, pairToken: ADDR, graduationThreshold: 100n, poolFee: 3000n, tickSpacing: 200n, creatorTaxBps: 0n, buybackEnabled: false, phase: 1n, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true, ...overrides }]);
}
const tag = (number) => `0x${number.toString(16)}`;
const hash = (number) => `0x${number.toString(16).padStart(64, "0")}`;
const timestamp = (number) => 1_789_680_000 + number - START;

function block(number) { return { number: tag(number), hash: hash(number), timestamp: tag(timestamp(number)) }; }
function event(name = "TokenLaunched", values = [ADDR, CURVE, DEPLOYER, ADDR, 0n, 100n], number = START + 2, index = 0) {
  const encoded = ABI.encodeEventLog(ABI.getEvent(name), values);
  return { address: GENIUS_FACTORY, blockNumber: tag(number), blockHash: hash(number), transactionHash: hash(999), logIndex: tag(index), removed: false, ...encoded };
}
function setup(options = {}) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url, ...body, signal: request.signal });
    let result;
    if (body.method === "eth_chainId") result = "0x38";
    else if (body.method === "eth_blockNumber") result = tag(TIP);
    else if (body.method === "eth_getCode") result = Number(BigInt(body.params[1])) < GENIUS_FACTORY_DEPLOY_BLOCK ? "0x" : CODE;
    else if (body.method === "eth_getBlockByNumber") result = block(Number(BigInt(body.params[0])));
    else if (body.method === "eth_getLogs") result = options.logs || [];
    else if (body.method === "eth_call") result = tokenRecord();
    else throw new Error(`forbidden RPC method ${body.method}`);
    if (options.override) result = await options.override({ url, request, body, result, calls });
    return result instanceof Response ? result : new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  };
  return { calls, reader: createGeniusChainReader({ rpcUrls: URLS, fetchImpl, timeoutMs: options.timeoutMs || 500, requestSpacingMs: 0, ...options.reader }) };
}

test("Genius factory ABI and runtime pins are fixed official artifacts", () => {
  assert.equal(keccak256(CODE), GENIUS_FACTORY_CODE_HASH);
  assert.equal(ABI.fragments.length, 25);
  assert.ok(Object.isFrozen(GENIUS_FACTORY_ABI));
  assert.equal(GENIUS_START_BLOCK, 122266383);
  assert.equal(GENIUS_FACTORY_DEPLOY_BLOCK, GENIUS_START_BLOCK + 270);
  assert.equal(GENIUS_FACTORY_DEPLOY_TX, "0xe22293ddd7b7b65d6c930bb888ab3da5cc23317902caffbead05562b09561557");
});

test("head agrees on the slower provider's confirmed fixed block and pins both bytecodes", async () => {
  const { reader, calls } = setup({ override: ({ url, body, result }) => body.method === "eth_blockNumber" && url.includes("48.club") ? tag(TIP + 4) : result });
  const head = await reader.head();
  assert.deepEqual(head, { number: TIP - 15, hash: hash(TIP - 15), timestamp: timestamp(TIP - 15), providers: URLS });
  assert.deepEqual(Object.keys(reader), ["head", "readRange", "readToken", "stop"]);
  assert.ok(Object.isFrozen(reader));
  assert.equal(calls.filter(({ method }) => method === "eth_getCode").length, 2);
  assert.ok(calls.filter(({ method }) => method === "eth_getCode").every(({ params }) => params[0] === GENIUS_FACTORY.toLowerCase() && params[1] === tag(TIP - 15)));
  assert.ok(calls.every(({ method }) => ["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getBlockByNumber"].includes(method)));
});

test("readRange sorts logs, preserves string quantities, and derives each event's actual block time", async () => {
  const logs = [event("LaunchSwept", [ADDR, 3n, 4n], START + 3, 2), event()];
  const { reader, calls } = setup({ logs, override: ({ body, url, result }) => body.method === "eth_getLogs" && url.includes("48.club") ? [...result].reverse() : result });
  const result = await reader.readRange(START, START + 4);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[0], {
    name: "TokenLaunched", args: { token: ADDR, curve: CURVE, deployer: DEPLOYER, pairToken: ADDR, launchConfigId: "0", graduationThreshold: "100" },
    address: GENIUS_FACTORY.toLowerCase(), blockNumber: START + 2, blockHash: hash(START + 2),
    transactionHash: hash(999), logIndex: 0, blockTimestamp: timestamp(START + 2),
  });
  assert.equal(result.events[1].blockTimestamp, timestamp(START + 3));
  assert.equal(result.anchor.timestamp, timestamp(START + 4));
  assert.doesNotThrow(() => JSON.stringify(result));
  const logsCalls = calls.filter(({ method }) => method === "eth_getLogs");
  assert.equal(logsCalls.length, 2);
  assert.deepEqual(logsCalls[0].params, [{ address: GENIUS_FACTORY.toLowerCase(), fromBlock: tag(START), toBlock: tag(START + 4) }]);
});

test("every reviewed factory event decodes named plain JSON arguments including booleans", async () => {
  const logs = ABI.fragments.map((fragment, index) => event(fragment.name, fragment.inputs.map((input) => input.type === "address" ? ADDR : input.type === "bool" ? true : 42n), START + 2, index));
  const { reader } = setup({ logs });
  const result = await reader.readRange(START, START + 3);
  assert.equal(result.events.length, 25);
  assert.equal(result.events.find(({ name }) => name === "BuybackEnabledUpdated").args.enabled, true);
  assert.equal(result.events.find(({ name }) => name === "PairTokenEconomicsUpdated").args.decimals, "42");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("rejects shared origin/provider aliases, insecure URLs, invalid bounds, and unconfirmed ranges", async (t) => {
  for (const rpcUrls of [[URLS[0]], [URLS[0], URLS[0]], ["https://a.vendor.example", "https://b.vendor.example"], ["http://a.example", URLS[1]], ["https://u:p@a.example", URLS[1]], ["https://127.0.0.1", URLS[1]]]) {
    assert.throws(() => createGeniusChainReader({ rpcUrls }));
  }
  assert.throws(() => createGeniusChainReader({ rpcUrls: URLS, confirmations: 0 }));
  assert.throws(() => createGeniusChainReader({ rpcUrls: URLS, timeoutMs: Infinity }));
  const { reader, calls } = setup();
  for (const [from, to] of [[GENIUS_START_BLOCK - 1, START], [START, START + 2048], [START, START - 1], [START + 0.1, START + 2]]) {
    await assert.rejects(reader.readRange(from, to));
  }
  assert.equal(calls.length, 0);
  await assert.rejects(reader.readRange(TIP, TIP), { code: "GENIUS_UNCONFIRMED_RANGE" });
  assert.equal(calls.some(({ method }) => method === "eth_getLogs"), false);
});

test("never silently degrades to one provider or accepts wrong identity", async (t) => {
  const scenarios = [
    ["wrong chain", ({ body, result }) => body.method === "eth_chainId" ? "0x1" : result, "GENIUS_WRONG_CHAIN"],
    ["empty code", ({ body, result }) => body.method === "eth_getCode" ? "0x" : result, "GENIUS_FACTORY_IDENTITY"],
    ["changed code", ({ body, result }) => body.method === "eth_getCode" ? "0x6000" : result, "GENIUS_FACTORY_IDENTITY"],
    ["canonical quantity", ({ body, result }) => body.method === "eth_blockNumber" ? "0x00" : result, "GENIUS_INVALID_RPC"],
    ["wrong block number", ({ body, result }) => body.method === "eth_getBlockByNumber" ? { ...result, number: tag(START) } : result, "GENIUS_INVALID_RPC"],
    ["head before deployment", ({ body, result }) => body.method === "eth_blockNumber" ? tag(GENIUS_START_BLOCK) : result, "GENIUS_HEAD_UNAVAILABLE"],
    ["one provider block fork", ({ body, result }) => body.method === "eth_getBlockByNumber" ? { ...result, hash: hash(77) } : result, "GENIUS_REORG"],
  ];
  for (const [name, override, code] of scenarios) {
    await t.test(name, async () => {
      const { reader } = setup({ override: (args) => args.url.includes("48.club") ? override(args) : args.result });
      await assert.rejects(reader.head(), { code });
    });
  }
});

test("historical reads independently verify historical and current runtime identity", async () => {
  const { reader, calls } = setup({ override: ({ body, result }) => body.method === "eth_getCode" && body.params[1] === tag(START + 3) ? "0x6000" : result });
  await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_FACTORY_IDENTITY" });
  assert.equal(calls.some(({ method }) => method === "eth_getLogs"), false);
});

test("requires exact dual-source log equality even when both ranges look valid", async () => {
  const { reader } = setup({ logs: [event()], override: ({ body, url, result }) => body.method === "eth_getLogs" && url.includes("48.club") ? [] : result });
  await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_LOG_CONSENSUS" });
});

test("rejects removed, foreign, duplicate, malformed, out-of-range, and unreviewed events", async (t) => {
  const base = event();
  const scenarios = [
    ["removed", [{ ...base, removed: true }], "GENIUS_INVALID_LOG"],
    ["removed omitted", [{ ...base, removed: undefined }], "GENIUS_INVALID_LOG"],
    ["foreign", [{ ...base, address: ADDR }], "GENIUS_INVALID_LOG"],
    ["duplicate", [base, base], "GENIUS_INVALID_LOG"],
    ["out of range", [{ ...base, blockNumber: tag(START + 9) }], "GENIUS_INVALID_LOG"],
    ["bad topic", [{ ...base, topics: ["0x00"] }], "GENIUS_INVALID_LOG"],
    ["unknown event", [{ ...base, topics: [hash(4)] }], "GENIUS_UNKNOWN_EVENT"],
    ["bad data", [{ ...base, data: "0x12" }], "GENIUS_INVALID_LOG"],
    ["trailing word", [{ ...base, data: `${base.data}${"00".repeat(32)}` }], "GENIUS_INVALID_LOG"],
    ["block hash disagreement", [{ ...base, blockHash: hash(44) }], "GENIUS_REORG"],
  ];
  for (const [name, logs, code] of scenarios) {
    await t.test(name, async () => {
      const { reader } = setup({ logs });
      await assert.rejects(reader.readRange(START, START + 3), { code });
    });
  }
});

test("detects consensus forks during the head identity check and after range reads", async (t) => {
  await t.test("head changes", async () => {
    const count = new Map();
    const { reader } = setup({ override: ({ body, url, result }) => {
      if (body.method !== "eth_getBlockByNumber") return result;
      count.set(url, (count.get(url) || 0) + 1);
      return count.get(url) > 1 ? { ...result, hash: hash(777) } : result;
    } });
    await assert.rejects(reader.head(), { code: "GENIUS_REORG" });
  });
  await t.test("range end changes", async () => {
    let logsRead = 0;
    const { reader } = setup({ override: ({ body, result }) => {
      if (body.method === "eth_getLogs") logsRead++;
      if (body.method === "eth_getBlockByNumber" && body.params[0] === tag(START + 3) && logsRead) return { ...result, hash: hash(777) };
      return result;
    } });
    await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_REORG" });
  });
});

test("bounds event block density and total returned logs", async (t) => {
  for (const [name, logs] of [
    ["event blocks", Array.from({ length: 25 }, (_, index) => event("LaunchFeeUpdated", [1n], START + index, 0))],
    ["log count", Array.from({ length: 10_001 }, (_, index) => event("LaunchFeeUpdated", [1n], START + 1, index))],
  ]) {
    await t.test(name, async () => {
      const { reader } = setup({ logs, timeoutMs: 5_000 });
      await assert.rejects(reader.readRange(START, START + 150), (error) => ["GENIUS_RANGE_TOO_DENSE", "GENIUS_RESPONSE_TOO_LARGE"].includes(error.code));
    });
  }
});

test("HTTP status, response identity, response size and hanging fetches fail closed", async (t) => {
  await t.test("429 exposes bounded retry hint", async () => {
    const { reader } = setup({ override: () => new Response("", { status: 429, headers: { "retry-after": "60" } }) });
    await assert.rejects(reader.head(), (error) => error.code === "GENIUS_HTTP" && error.status === 429 && error.retryAfter === "60");
  });
  await t.test("wrong response id", async () => {
    const { reader } = setup({ override: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: -1, result: "0x38" })) });
    await assert.rejects(reader.head(), { code: "GENIUS_INVALID_RPC" });
  });
  await t.test("oversized declared body", async () => {
    const { reader } = setup({ override: () => new Response("", { headers: { "content-length": "3000000" } }) });
    await assert.rejects(reader.head(), { code: "GENIUS_RESPONSE_TOO_LARGE" });
  });
  await t.test("oversized streamed body", async () => {
    const { reader } = setup({ override: () => new Response("x".repeat(2 * 1024 * 1024 + 1)) });
    await assert.rejects(reader.head(), { code: "GENIUS_RESPONSE_TOO_LARGE" });
  });
  await t.test("fetch ignoring AbortSignal", async () => {
    const { reader, calls } = setup({ timeoutMs: 15, override: () => new Promise(() => {}) });
    await assert.rejects(reader.head(), { code: "GENIUS_TIMEOUT" });
    assert.ok(calls.every(({ signal }) => signal.aborted));
  });
  await t.test("body read ignoring AbortSignal", async () => {
    const { reader } = setup({ timeoutMs: 15, override: () => new Response(new ReadableStream({ start() {} })) });
    await assert.rejects(reader.head(), { code: "GENIUS_TIMEOUT" });
  });
});

test("verified deployment prefix accepts only agreed empty historical code and empty logs", async (t) => {
  await t.test("safe empty prefix", async () => {
    const { reader } = setup();
    const result = await reader.readRange(GENIUS_START_BLOCK, START - 1);
    assert.deepEqual(result.events, []);
    assert.equal(result.anchor.number, START - 1);
  });
  await t.test("unexpected early code", async () => {
    const { reader } = setup({ override: ({ body, result }) => body.method === "eth_getCode" ? CODE : result });
    await assert.rejects(reader.readRange(GENIUS_START_BLOCK, START - 1), { code: "GENIUS_FACTORY_IDENTITY" });
  });
  await t.test("unexpected early logs", async () => {
    const { reader } = setup({ logs: [event("LaunchFeeUpdated", [1n], START - 1)] });
    await assert.rejects(reader.readRange(GENIUS_START_BLOCK, START + 1), { code: "GENIUS_FACTORY_IDENTITY" });
  });
});

test("readToken binds the exact token to dual-source factory storage at one confirmed block", async () => {
  const { reader, calls } = setup();
  assert.deepEqual(await reader.readToken(ADDR), {
    exists: true, token: ADDR, curve: CURVE, deployer: DEPLOYER, creatorFeeRecipient: DEPLOYER,
    pairToken: ADDR, phase: 1, blockNumber: TIP - 15, blockHash: hash(TIP - 15),
    blockTimestamp: timestamp(TIP - 15), providers: URLS,
  });
  const reads = calls.filter(({ method }) => method === "eth_call");
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0].params, [{ to: GENIUS_FACTORY.toLowerCase(), data: TOKEN_ABI.encodeFunctionData("getLaunchedToken", [ADDR]) }, tag(TIP - 15)]);
  assert.ok(reads.every(({ params }) => params[1] === tag(TIP - 15)));
});

test("readToken returns a bound absent record without treating absence as an official token", async () => {
  const { reader } = setup({ override: ({ body, result }) => body.method === "eth_call" ? `0x${"0".repeat(15 * 64)}` : result });
  const result = await reader.readToken(ADDR);
  assert.equal(result.exists, false);
  assert.equal(result.token, ADDR);
  assert.equal(result.deployer, ZERO);
});

test("readToken rejects malformed, inconsistent, divergent and reorged records", async (t) => {
  const scenarios = [
    ["token mismatch", tokenRecord({ token: CURVE })],
    ["missing curve", tokenRecord({ curve: ZERO })],
    ["missing deployer", tokenRecord({ deployer: ZERO })],
    ["missing pair", tokenRecord({ pairToken: ZERO })],
    ["contradictory absence", tokenRecord({ exists: false })],
    ["empty output", "0x"],
    ["trailing bytes", `${tokenRecord()}00`],
    ["invalid bool", `${tokenRecord().slice(0, -64)}${"0".repeat(63)}2`],
  ];
  for (const [name, record] of scenarios) {
    await t.test(name, async () => {
      const { reader } = setup({ override: ({ body, result }) => body.method === "eth_call" ? record : result });
      await assert.rejects(reader.readToken(ADDR), { code: "GENIUS_TOKEN_IDENTITY" });
    });
  }
  await t.test("source divergence", async () => {
    const { reader } = setup({ override: ({ url, body, result }) => body.method === "eth_call" && url.includes("48.club") ? tokenRecord({ deployer: CURVE }) : result });
    await assert.rejects(reader.readToken(ADDR), { code: "GENIUS_TOKEN_CONSENSUS" });
  });
  await t.test("anchor reorg after call", async () => {
    let called = false;
    const { reader } = setup({ override: ({ body, result }) => {
      if (body.method === "eth_call") called = true;
      return called && body.method === "eth_getBlockByNumber" ? { ...result, hash: hash(91) } : result;
    } });
    await assert.rejects(reader.readToken(ADDR), { code: "GENIUS_REORG" });
  });
  await t.test("invalid input makes no request", async () => {
    const { reader, calls } = setup();
    await assert.rejects(reader.readToken(ZERO));
    await assert.rejects(reader.readToken("not an address"));
    assert.equal(calls.length, 0);
  });
});

test("provider proof URLs omit paths and API query strings", async () => {
  const { reader } = setup({ reader: { rpcUrls: ["https://rpc.48.club/private-key", "https://rpc-bnb.blockmachine.io/?key=private"] } });
  assert.deepEqual((await reader.head()).providers, URLS);
});

test("host pacing is shared across calls and reader instances with only one physical request per host", async () => {
  const starts = new Map();
  const active = new Map();
  const ended = new Map();
  let maximum = 0;
  const override = ({ url, body, result }) => {
    const host = new URL(url).hostname;
    active.set(host, (active.get(host) || 0) + 1);
    maximum = Math.max(maximum, active.get(host));
    const values = starts.get(host) || [];
    values.push({ start: Date.now(), previousEnd: ended.get(host) });
    starts.set(host, values);
    return new Response(new ReadableStream({ start(controller) {
      setTimeout(() => {
        active.set(host, active.get(host) - 1);
        ended.set(host, Date.now());
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })));
        controller.close();
      }, 3);
    } }));
  };
  const rpcUrls = ["https://pacing-first.example", "https://pacing-second.example"];
  const config = { rpcUrls, requestSpacingMs: 12 };
  const first = setup({ reader: config, override }).reader;
  const second = setup({ reader: config, override }).reader;
  await Promise.all([first.head(), second.head()]);
  await first.head();
  assert.equal(maximum, 1);
  for (const list of starts.values()) {
    assert.equal(list.length, 15);
    for (const { start, previousEnd } of list.slice(1)) assert.ok(start - previousEnd >= 10, `unpaced request: gap ${start - previousEnd}ms`);
  }
  first.stop(); second.stop();
});

test("default host pacing waits 500ms after completion and stop cancels the next queued request", async () => {
  let notifySecond;
  const second = new Promise((resolve) => { notifySecond = resolve; });
  let firstAt;
  const { reader } = setup({ reader: { rpcUrls: ["https://default-pace-a.example", "https://default-pace-b.example"], requestSpacingMs: undefined, operationTimeoutMs: 2_000 }, override: ({ body, result }) => {
    if (body.method === "eth_chainId") firstAt ??= Date.now();
    if (body.method === "eth_blockNumber") notifySecond(Date.now());
    return result;
  } });
  const result = assert.rejects(reader.head(), { code: "GENIUS_STOPPED" });
  const secondAt = await second;
  reader.stop();
  await result;
  assert.ok(secondAt - firstAt >= 495, `default gap ${secondAt - firstAt}ms`);
});

test("stop aborts active requests and queued work, is idempotent, and rejects later operations", async () => {
  let notifyStart;
  const started = new Promise((resolve) => { notifyStart = resolve; });
  const { reader, calls } = setup({ reader: { rpcUrls: ["https://stop-first.example", "https://stop-second.example"], requestSpacingMs: 15 }, override: () => {
    notifyStart(); return new Promise(() => {});
  } });
  const result = assert.rejects(reader.head(), { code: "GENIUS_STOPPED" });
  await started;
  reader.stop(); reader.stop();
  await result;
  const count = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(count <= 2);
  assert.equal(calls.length, count);
  assert.ok(calls.every(({ signal }) => signal.aborted));
  await assert.rejects(reader.head(), { code: "GENIUS_STOPPED" });
  await assert.rejects(reader.readRange(START, START + 1), { code: "GENIUS_STOPPED" });
  await assert.rejects(reader.readToken(ADDR), { code: "GENIUS_STOPPED" });
  assert.equal(calls.length, count);
});

test("operation deadline includes global host queue time and a stopped reader does not cancel its peers", async () => {
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const rpcUrls = ["https://deadline-first.example", "https://deadline-second.example"];
  const busy = setup({ reader: { rpcUrls }, override: () => { startedResolve(); return new Promise(() => {}); } });
  const busyResult = assert.rejects(busy.reader.head(), { code: "GENIUS_STOPPED" });
  await started;
  const queued = setup({ reader: { rpcUrls, operationTimeoutMs: 20 } });
  const began = Date.now();
  await assert.rejects(queued.reader.head(), { code: "GENIUS_TIMEOUT" });
  assert.ok(Date.now() - began < 300);
  assert.equal(queued.calls.length, 0, "expired queued work must never reach fetch");
  busy.reader.stop();
  await busyResult;
  assert.equal((await queued.reader.head()).number, TIP - 15);
  queued.reader.stop();
});

test("one fixed current-head range reuses only its own verified pre-read anchor and code", async () => {
  const { reader, calls } = setup();
  const result = await reader.readRange(TIP - 15, TIP - 15);
  assert.equal(result.anchor.number, TIP - 15);
  assert.equal(calls.filter(({ method }) => method === "eth_getCode").length, 2);
  assert.equal(calls.filter(({ method }) => method === "eth_getBlockByNumber").length, 6);
  assert.equal(calls.filter(({ method }) => method === "eth_getLogs").length, 2);
});

test("rejects out-of-bounds pacing and overall deadline options", () => {
  for (const requestSpacingMs of [-1, 5_001, 1.5, NaN]) assert.throws(() => createGeniusChainReader({ rpcUrls: URLS, requestSpacingMs }));
  for (const operationTimeoutMs of [0, 60_001, Infinity]) assert.throws(() => createGeniusChainReader({ rpcUrls: URLS, operationTimeoutMs }));
});

test("independent log group bridges its chain and fixed headers to the code group without single-source shortcuts", async () => {
  const logRpcUrls = ["https://logs-first.example", URLS[1]];
  const { reader, calls } = setup({ reader: { logRpcUrls }, logs: [event()] });
  const result = await reader.readRange(START, START + 3);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.providers, [...URLS, logRpcUrls[0]]);
  assert.deepEqual(result.codeProviders, URLS);
  assert.deepEqual(result.logProviders, logRpcUrls);
  assert.ok(calls.filter(({ method }) => method === "eth_getCode").every(({ url }) => URLS.includes(new URL(url).origin)));
  assert.deepEqual(calls.filter(({ method }) => method === "eth_getLogs").map(({ url }) => new URL(url).origin).sort(), [...logRpcUrls].sort());
  assert.equal(calls.filter(({ method }) => method === "eth_chainId").length, 3);
  assert.deepEqual(calls.filter(({ method, params }) => method === "eth_getBlockByNumber" && params[0] === tag(START + 2)).map(({ url }) => new URL(url).origin).sort(), [...logRpcUrls].sort());
  const additional = calls.filter(({ url, method }) => url.includes("logs-first") && method === "eth_getBlockByNumber");
  assert.equal(additional.filter(({ params }) => params[0] === tag(START)).length, 2);
  assert.equal(additional.filter(({ params }) => params[0] === tag(START + 3)).length, 2);
});

test("separate log groups cannot supply wrong chains, detached anchors, conflicting logs or reorged headers", async (t) => {
  const logRpcUrls = ["https://logs-one.example", "https://logs-two.example"];
  const isLogs = (url) => url.includes("logs-");
  await t.test("wrong log chain", async () => {
    const { reader } = setup({ reader: { logRpcUrls }, override: ({ url, body, result }) => isLogs(url) && body.method === "eth_chainId" ? "0x1" : result });
    await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_WRONG_CHAIN" });
  });
  await t.test("log group agrees internally but differs from code anchor", async () => {
    const { reader } = setup({ reader: { logRpcUrls }, override: ({ url, body, result }) => isLogs(url) && body.method === "eth_getBlockByNumber" ? { ...result, hash: hash(80) } : result });
    await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_REORG" });
  });
  await t.test("log group timestamp differs from code anchor", async () => {
    const { reader } = setup({ reader: { logRpcUrls }, override: ({ url, body, result }) => isLogs(url) && body.method === "eth_getBlockByNumber" ? { ...result, timestamp: tag(timestamp(START) - 1) } : result });
    await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_REORG" });
  });
  await t.test("logs disagree", async () => {
    const { reader } = setup({ reader: { logRpcUrls }, logs: [event()], override: ({ url, body, result }) => url.includes("logs-one") && body.method === "eth_getLogs" ? [] : result });
    await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_LOG_CONSENSUS" });
  });
  await t.test("event block header mismatch", async () => {
    const { reader } = setup({ reader: { logRpcUrls }, logs: [event()], override: ({ url, body, result }) => isLogs(url) && body.method === "eth_getBlockByNumber" && body.params[0] === tag(START + 2) ? { ...result, hash: hash(99) } : result });
    await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_REORG" });
  });
  await t.test("log group changes only after logs are read", async () => {
    let logsRead = false;
    const { reader } = setup({ reader: { logRpcUrls }, override: ({ url, body, result }) => {
      if (body.method === "eth_getLogs") logsRead = true;
      return isLogs(url) && body.method === "eth_getBlockByNumber" && logsRead ? { ...result, hash: hash(88) } : result;
    } });
    await assert.rejects(reader.readRange(START, START + 3), { code: "GENIUS_REORG" });
  });
});

test("explicitly identical log groups keep the default RPC call budget and readToken does not use log endpoints", async () => {
  const identical = setup({ reader: { logRpcUrls: [...URLS].reverse() } });
  await identical.reader.readRange(TIP - 15, TIP - 15);
  assert.equal(identical.calls.filter(({ method }) => method === "eth_chainId").length, 2);
  assert.equal(identical.calls.filter(({ method }) => method === "eth_getBlockByNumber").length, 6);
  const separate = setup({ reader: { logRpcUrls: ["https://ignored-log-one.example", "https://ignored-log-two.example"] } });
  await separate.reader.readToken(ADDR);
  assert.ok(separate.calls.every(({ url }) => !url.includes("ignored-log")));
});

test("log endpoint group retains independent-host and HTTPS requirements", () => {
  for (const logRpcUrls of [[], null, [URLS[0]], [URLS[0], URLS[0]], ["https://a.vendor.example", "https://b.vendor.example"], ["http://logs.example", URLS[0]]]) {
    assert.throws(() => createGeniusChainReader({ rpcUrls: URLS, logRpcUrls }));
  }
});
