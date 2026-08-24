import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { analyzeReceipt, bytecodeFeatures, classifyModeObservation, jaccard, modeFamilyKey, parseRpcQuantity, readTokenMetadata } from "../src/detector.js";
import { PONS_V2_TOKEN_LAUNCHED_TOPIC } from "../src/pons-version-monitor.js";

test("non-token metadata calls return null", async () => {
  const provider = { call: async () => { throw new Error("revert"); } };
  assert.equal(await readTokenMetadata(provider, "0x0000000000000000000000000000000000000001", 1), null);
});

test("bytecode feature extraction ignores CREATE2 byte inside PUSH data", () => {
  assert.equal(bytecodeFeatures("0x60f500").usesCreate2, false);
  assert.equal(bytecodeFeatures("0xf500").usesCreate2, true);
  assert.equal(bytecodeFeatures("0x60f000").usesCreate, false);
  assert.equal(bytecodeFeatures("0xf000").usesCreate, true);
});

test("receipt analysis accepts chain-specific wrapped native exclusions", async () => {
  const wrapped = "0x1111111111111111111111111111111111111111";
  const factory = "0x2222222222222222222222222222222222222222";
  const sender = "0x3333333333333333333333333333333333333333";
  const zeroTopic = `0x${"0".repeat(64)}`;
  const recipientTopic = `0x${"0".repeat(24)}${sender.slice(2)}`;
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const provider = { getCode: async () => "0x6000", call: async () => { throw new Error("not used"); } };
  const result = await analyzeReceipt(provider, { to: factory, from: sender, data: "0x12345678" }, {
    status: 1,
    contractAddress: null,
    logs: [{ address: wrapped, topics: [transferTopic, zeroTopic, recipientTopic], data: `0x${"0".repeat(63)}1` }],
  }, { number: 10 }, { includeTokenMetadata: false, wrappedNativeAddresses: [wrapped] });
  assert.equal(result.launch, null);
  assert.equal(result.mintedTokens.length, 0);
});

test("receipt analysis never reports a freshly minted V2 LP pair as a launched token", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const quote = "0x2222222222222222222222222222222222222222";
  const pair = "0x3333333333333333333333333333333333333333";
  const factory = "0x4444444444444444444444444444444444444444";
  const sender = "0x5555555555555555555555555555555555555555";
  const zeroTopic = `0x${"0".repeat(64)}`;
  const recipientTopic = `0x${"0".repeat(24)}${sender.slice(2)}`;
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const iface = new Interface(["event PairCreated(address indexed token0,address indexed token1,address pair,uint256)"]);
  const created = iface.encodeEventLog(iface.getEvent("PairCreated"), [token, quote, pair, 1]);
  const provider = { getCode: async () => "0x6000", call: async () => { throw new Error("not used"); } };
  const result = await analyzeReceipt(provider, { to: factory, from: sender, data: "0x12345678" }, {
    status: 1,
    contractAddress: null,
    logs: [
      { address: factory, topics: created.topics, data: created.data },
      { address: pair, topics: [transferTopic, zeroTopic, recipientTopic], data: `0x${"0".repeat(63)}1` },
    ],
  }, { number: 10 }, { includeTokenMetadata: false, assumeContractCaller: true });
  assert.equal(result.mintedTokens.length, 0);
  assert.equal(result.launch, null);
});

test("receipt analysis recognizes a Uniswap v4 pool initialization launch", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const quote = "0x2222222222222222222222222222222222222222";
  const launcher = "0x3333333333333333333333333333333333333333";
  const poolManager = "0x4444444444444444444444444444444444444444";
  const sender = "0x5555555555555555555555555555555555555555";
  const zeroTopic = `0x${"0".repeat(64)}`;
  const recipientTopic = `0x${"0".repeat(24)}${sender.slice(2)}`;
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const iface = new Interface(["event Initialize(bytes32 indexed poolId,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)"]);
  const initialized = iface.encodeEventLog(iface.getEvent("Initialize"), [
    `0x${"1".repeat(64)}`, token, quote, 3000, 60, launcher, 2n ** 96n, 0,
  ]);
  const provider = {
    getCode: async (address, blockTag) => address.toLowerCase() === token && blockTag === 9 ? "0x" : "0x6000",
    call: async () => { throw new Error("metadata unavailable"); },
  };
  const result = await analyzeReceipt(provider, { to: launcher, from: sender, data: "0x12345678" }, {
    status: 1,
    contractAddress: null,
    logs: [
      { address: token, topics: [transferTopic, zeroTopic, recipientTopic], data: `0x${"0".repeat(63)}1` },
      { address: poolManager, topics: initialized.topics, data: initialized.data },
    ],
  }, { number: 10 }, { includeTokenMetadata: false, assumeContractCaller: true });
  assert.equal(result.launch.confidence, "high");
  assert.equal(result.launch.pools[0].kind, "uniswap-v4");
  assert.equal(result.launch.pools[0].poolId, `0x${"1".repeat(64)}`);
  assert.equal(result.launch.pools[0].hook.toLowerCase(), launcher);
});

test("selector similarity uses Jaccard score", () => {
  assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
});

test("empty RPC quantity is treated as zero", () => {
  assert.equal(parseRpcQuantity("0x"), 0n);
  assert.equal(parseRpcQuantity("0x2a"), 42n);
});

test("mode family ignores noisy log counts but detects selector or pool changes", () => {
  const base = { selector: "0x12345678", poolKinds: ["uniswap-v3"], mintCount: 1, logCount: 10 };
  assert.equal(modeFamilyKey(base), modeFamilyKey({ ...base, mintCount: 2, logCount: 99, emitterCount: 20 }));
  assert.notEqual(modeFamilyKey(base), modeFamilyKey({ ...base, poolKinds: ["uniswap-v2"] }));
  assert.notEqual(modeFamilyKey(base), modeFamilyKey({ ...base, selector: "0x87654321" }));
});

test("a new mode needs two independent observations while the baseline never alerts", () => {
  const baseline = { selector: "0x11111111", poolKinds: ["uniswap-v3"] };
  const novel = { selector: "0x22222222", poolKinds: ["uniswap-v4"] };
  assert.equal(classifyModeObservation({ launches: 0, modes: {} }, baseline).status, "baseline_mode");
  assert.equal(classifyModeObservation({
    launches: 10,
    modes: { baseline: { count: 10, shape: baseline } },
  }, novel).status, "new_mode_candidate");
  assert.equal(classifyModeObservation({
    launches: 11,
    modes: {
      baseline: { count: 10, shape: baseline },
      novel: { count: 1, shape: novel },
    },
  }, novel).status, "new_mode_confirmed");
  assert.equal(classifyModeObservation({
    launches: 12,
    modes: {
      baseline: { count: 10, shape: baseline },
      novel: { count: 2, shape: novel },
    },
  }, novel).status, "known_mode");
});

test("known launchpad fast path skips token metadata RPC calls", async () => {
  let metadataCalls = 0;
  const provider = {
    getCode: async (_address, blockTag) => blockTag === 9 ? "0x" : "0x6000",
    call: async () => { metadataCalls += 1; throw new Error("metadata should be skipped"); },
  };
  const token = "0x1111111111111111111111111111111111111111";
  const factory = "0x2222222222222222222222222222222222222222";
  const sender = "0x3333333333333333333333333333333333333333";
  const zeroTopic = `0x${"0".repeat(64)}`;
  const recipientTopic = `0x${"0".repeat(24)}${sender.slice(2)}`;
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const result = await analyzeReceipt(provider, { to: factory, from: sender, data: "0x12345678" }, {
    status: 1,
    contractAddress: null,
    logs: [{ address: token, topics: [transferTopic, zeroTopic, recipientTopic], data: `0x${"0".repeat(63)}1` }],
  }, { number: 10 }, { includeTokenMetadata: false });
  assert.equal(result.launch.tokens[0].metadata, null);
  assert.equal(metadataCalls, 0);
});

test("pons v2 curve launch is detected without an initial liquidity pool", async () => {
  const token = "0x1111111111111111111111111111111111111111";
  const curve = "0x2222222222222222222222222222222222222222";
  const factory = "0x3333333333333333333333333333333333333333";
  const sender = "0x4444444444444444444444444444444444444444";
  const zeroTopic = `0x${"0".repeat(64)}`;
  const curveTopic = `0x${"0".repeat(24)}${curve.slice(2)}`;
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const provider = {
    getCode: async (address, blockTag) => address.toLowerCase() === token && blockTag === 99 ? "0x" : "0x6000",
    call: async () => { throw new Error("metadata unavailable"); },
  };
  const result = await analyzeReceipt(provider, { to: factory, from: sender, data: "0x12345678" }, {
    status: 1,
    contractAddress: null,
    logs: [
      { address: token, topics: [transferTopic, zeroTopic, curveTopic], data: `0x${"0".repeat(63)}1` },
      { address: factory, topics: [PONS_V2_TOKEN_LAUNCHED_TOPIC], data: "0x" },
    ],
  }, { number: 100 });
  assert.equal(result.launch.lifecycle, "new_creation_or_curve");
  assert.equal(result.launch.tokens[0].token.toLowerCase(), token);
  assert.ok(result.launch.mode.topicShape.includes(PONS_V2_TOKEN_LAUNCHED_TOPIC));
});
