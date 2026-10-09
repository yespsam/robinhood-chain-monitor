import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Signature, Transaction } from "ethers";
import {
  FOUR_CORE_ADDRESS,
  FOUR_CORE_INTERFACE,
  FOUR_REGISTRY_ADDRESS,
  FOUR_REGISTRY_INTERFACE,
  FOUR_REGISTRY_MULTICALL3_ADDRESS,
  FOUR_REGISTRY_MULTICALL3_CODE_HASH,
  FOUR_REGISTRY_MULTICALL3_INTERFACE,
  FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE,
  atomicWriteFourRegistryState,
  classifyFourRegistryDelivery,
  createFourRegistryMonitor,
  isFourRegistryCapabilityEvent,
  isFourRegistryFirstTokenEvent,
  isFourRegistryProtocolCapabilityEvent,
  readFourRegistryInventory,
  restoreFourLegacyTransaction,
} from "../src/four-registry-monitor.js";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";

const CREATOR = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x9999999999999999999999999999999999999999";
const VALIDATOR = "0x3333333333333333333333333333333333333333";
const AUTHOR = "0x4444444444444444444444444444444444444444";
const MODULE_ADDRESSES = ["5", "6", "7", "8", "9", "a", "b"].map((digit) => `0x${digit.repeat(40)}`);
const TEST_MULTICALL3_CODE_HASH = "0xa9c7ddf1ae0410c3a502ed7c7152ebd190fad85ab7fe3497c68869d5079c5219";

function blockHash(number) {
  return `0x${BigInt(number).toString(16).padStart(64, "0")}`;
}

function txHash(digit) {
  return `0x${digit.repeat(64)}`;
}

function bytes32(digit) {
  return `0x${digit.repeat(64)}`;
}

function preset(id, overrides = {}) {
  return {
    id: String(id),
    name: `Preset ${id}`,
    description: `Official preset ${id}`,
    version: "1.0.0",
    active: true,
    createEnabled: true,
    validator: VALIDATOR,
    tokenModuleId: bytes32("1"),
    vaultModuleId: bytes32("2"),
    curveModuleId: bytes32("3"),
    tradeModuleId: bytes32("4"),
    migrateModuleId: bytes32("5"),
    tokenImplId: bytes32("6"),
    customDataId: bytes32("0"),
    author: AUTHOR,
    ...overrides,
  };
}

function tuple(value) {
  return [
    BigInt(value.id),
    value.name,
    value.description,
    value.version,
    value.active,
    value.createEnabled,
    value.validator,
    value.tokenModuleId,
    value.vaultModuleId,
    value.curveModuleId,
    value.tradeModuleId,
    value.migrateModuleId,
    value.tokenImplId,
    value.customDataId,
    value.author,
  ];
}

class FakeBscProvider {
  constructor({ head = 102, chainId = 56 } = {}) {
    this.head = head;
    this.chainId = chainId;
    this.snapshots = new Map();
    this.logs = [];
    this.receipts = new Map();
    this.transactions = new Map();
    this.calls = [];
    this.logQueries = [];
    this.blockHashOverrides = new Map();
    this.blockTimestampOverrides = new Map();
    this.coreRegistry = FOUR_REGISTRY_ADDRESS;
  }

  setSnapshot(blockNumber, presets) {
    this.snapshots.set(Number(blockNumber), Object.fromEntries(presets.map((item) => [String(item.id), structuredClone(item)])));
  }

  snapshotAt(blockNumber) {
    const eligible = [...this.snapshots.keys()].filter((number) => number <= Number(blockNumber)).sort((a, b) => b - a);
    return eligible.length ? this.snapshots.get(eligible[0]) : {};
  }

  block(number) {
    const value = Number(number);
    return {
      number: value,
      hash: this.blockHashOverrides.get(value) || blockHash(value),
      timestamp: this.blockTimestampOverrides.get(value) ?? (1_788_508_600 + value),
    };
  }

  setBlockHash(number, hash) { this.blockHashOverrides.set(Number(number), String(hash).toLowerCase()); }
  setBlockTimestamp(number, timestamp) { this.blockTimestampOverrides.set(Number(number), Number(timestamp)); }

  async getNetwork() { return { chainId: BigInt(this.chainId) }; }
  async send(method) {
    if (method !== "eth_chainId") throw new Error(`unexpected RPC method ${method}`);
    return `0x${this.chainId.toString(16)}`;
  }
  async getBlockNumber() { return this.head; }
  async getBlock(number) { return this.block(number); }
  async getCode(address, blockTag) {
    this.calls.push({ name: "getCode", address: String(address).toLowerCase(), blockTag });
    return "0x6000600055";
  }

  async executeCall(request, track = true) {
    if (track) this.calls.push({ name: "call", to: String(request.to).toLowerCase(), blockTag: request.blockTag, data: request.data });
    if (!Number.isSafeInteger(request.blockTag)) throw new Error("all contract reads must use an exact blockTag");
    const target = String(request.to).toLowerCase();
    if (target === FOUR_REGISTRY_MULTICALL3_ADDRESS) {
      const parsed = FOUR_REGISTRY_MULTICALL3_INTERFACE.parseTransaction({ data: request.data });
      if (parsed.name !== "aggregate3") throw new Error(`unexpected Multicall3 call ${parsed.name}`);
      const results = [];
      for (const item of parsed.args[0]) {
        try {
          results.push({
            success: true,
            returnData: await this.executeCall({
              to: item.target,
              data: item.callData,
              blockTag: request.blockTag,
            }, false),
          });
        } catch (error) {
          if (item.allowFailure !== true) throw error;
          results.push({ success: false, returnData: "0x" });
        }
      }
      return FOUR_REGISTRY_MULTICALL3_INTERFACE.encodeFunctionResult("aggregate3", [results]);
    }
    if (target === FOUR_CORE_ADDRESS) {
      const parsed = FOUR_CORE_INTERFACE.parseTransaction({ data: request.data });
      if (parsed.name !== "registry") throw new Error(`unexpected Core call ${parsed.name}`);
      return FOUR_CORE_INTERFACE.encodeFunctionResult("registry", [this.coreRegistry]);
    }
    if (target !== FOUR_REGISTRY_ADDRESS) throw new Error(`unexpected call target ${target}`);
    const parsed = FOUR_REGISTRY_INTERFACE.parseTransaction({ data: request.data });
    const snapshot = this.snapshotAt(request.blockTag);
    if (parsed.name === "openFourCore") {
      return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [FOUR_CORE_ADDRESS]);
    }
    if (parsed.name === "getPresetIds") {
      return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [Object.keys(snapshot).map(BigInt)]);
    }
    const id = parsed.args[0].toString();
    const record = snapshot[id];
    if (!record) throw new Error(`missing preset ${id} at block ${request.blockTag}`);
    if (parsed.name === "getPreset") return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [tuple(record)]);
    if (parsed.name === "isPresetActive") return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [record.active]);
    if (parsed.name === "isPresetCreateEnabled") return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [record.createEnabled]);
    throw new Error(`unexpected Registry call ${parsed.name}`);
  }

  async call(request) { return this.executeCall(request); }

  async getLogs(filter) {
    this.logQueries.push(structuredClone(filter));
    const allowed = Array.isArray(filter.topics?.[0]) ? filter.topics[0] : [filter.topics?.[0]];
    const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address])
      .map((value) => String(value).toLowerCase());
    return this.logs.filter((log) => addresses.includes(String(log.address).toLowerCase())
      && log.blockNumber >= filter.fromBlock
      && log.blockNumber <= filter.toBlock
      && allowed.map((topic) => String(topic).toLowerCase()).includes(String(log.topics[0]).toLowerCase()));
  }

  async getTransactionReceipt(hash) { return this.receipts.get(String(hash).toLowerCase()) || null; }
  async getTransaction(hash) { return this.transactions.get(String(hash).toLowerCase()) || null; }

  addLog({ address, encoded, blockNumber, transactionIndex, logIndex, transactionHash }) {
    const hash = String(transactionHash).toLowerCase();
    const log = {
      address: String(address).toLowerCase(),
      topics: encoded.topics,
      data: encoded.data,
      blockNumber,
      blockHash: this.block(blockNumber).hash,
      transactionIndex,
      index: logIndex,
      transactionHash: hash,
      removed: false,
    };
    this.logs.push(log);
    this.receipts.set(hash, {
      status: 1,
      to: String(address).toLowerCase(),
      blockNumber,
      blockHash: this.block(blockNumber).hash,
      transactionHash: hash,
      transactionIndex,
      logs: [structuredClone(log)],
    });
    this.transactions.set(hash, {
      hash,
      to: String(address).toLowerCase(),
      blockNumber,
      blockHash: this.block(blockNumber).hash,
      transactionIndex,
    });
    return log;
  }
}

function rawLogFacade(provider) {
  const rawFilters = [];
  return {
    rawFilters,
    getNetwork: (...args) => provider.getNetwork(...args),
    getBlockNumber: (...args) => provider.getBlockNumber(...args),
    getBlock: (...args) => provider.getBlock(...args),
    getCode: (...args) => provider.getCode(...args),
    call: (...args) => provider.call(...args),
    getTransaction: (...args) => provider.getTransaction(...args),
    getTransactionReceipt: (...args) => provider.getTransactionReceipt(...args),
    async send(method, params) {
      if (method !== "eth_getLogs") return provider.send(method, params);
      const [filter] = params;
      rawFilters.push(structuredClone(filter));
      const logs = await provider.getLogs({
        ...filter,
        fromBlock: Number.parseInt(filter.fromBlock.slice(2), 16),
        toBlock: Number.parseInt(filter.toBlock.slice(2), 16),
      });
      return logs.map((log) => ({
        ...log,
        blockNumber: `0x${log.blockNumber.toString(16)}`,
        transactionIndex: `0x${log.transactionIndex.toString(16)}`,
        logIndex: `0x${log.index.toString(16)}`,
        index: undefined,
      }));
    },
  };
}

function forwardingProvider(provider) {
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function providerFacade(provider, overrides = {}) {
  return new Proxy(provider, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function verificationDependencies(provider) {
  return {
    multicall3CodeHashForTesting: TEST_MULTICALL3_CODE_HASH,
    logVerificationProviders: [
      { sourceId: "log-a.test", provider: forwardingProvider(provider) },
      { sourceId: "log-b.test", provider: forwardingProvider(provider) },
    ],
    stateVerificationProviders: [
      { sourceId: "state-a.test", provider: forwardingProvider(provider) },
      { sourceId: "state-b.test", provider: forwardingProvider(provider) },
    ],
  };
}

async function supersedeCancellation({ eventId }) {
  return {
    status: "superseded",
    reason: "canonical_reorg",
    persisted: true,
    terminal: true,
    eventId,
  };
}

function addUpsert(provider, record, blockNumber = 101, transactionIndex = 1, logIndex = 0, hash = txHash("a")) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("PresetUpserted"),
    [record.id, record.active, record.createEnabled],
  );
  return provider.addLog({
    address: FOUR_REGISTRY_ADDRESS,
    encoded,
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash: hash,
  });
}

function addActiveUpdate(provider, id, active, blockNumber = 101, transactionIndex = 1, logIndex = 0, hash = txHash("b")) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("PresetActiveUpdated"),
    [id, active],
  );
  return provider.addLog({
    address: FOUR_REGISTRY_ADDRESS,
    encoded,
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash: hash,
  });
}

function addCreateEnabledUpdate(provider, id, createEnabled, blockNumber = 101, transactionIndex = 1, logIndex = 0, hash = txHash("e")) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("PresetCreateEnabledUpdated"),
    [id, createEnabled],
  );
  return provider.addLog({
    address: FOUR_REGISTRY_ADDRESS,
    encoded,
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash: hash,
  });
}

function addModuleUpserted(provider, {
  moduleKey = bytes32("7"),
  beacon = "0x5555555555555555555555555555555555555555",
  implementation = "0x6666666666666666666666666666666666666666",
  kind = 2,
  active = true,
  blockNumber = 101,
  transactionIndex = 1,
  logIndex = 0,
  hash = txHash("a"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("ModuleUpserted"),
    [moduleKey, beacon, implementation, kind, active],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

function addTokenImplUpserted(provider, {
  tokenImplId = bytes32("8"),
  implementation = "0x7777777777777777777777777777777777777777",
  version = "2.0.0",
  blockNumber = 101,
  transactionIndex = 2,
  logIndex = 0,
  hash = txHash("b"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("TokenImplUpserted"),
    [tokenImplId, implementation, version],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

function addTagRegistered(provider, {
  tagId = "0x1234567890abcdef",
  tag = "module.curve.lista_yield",
  blockNumber = 101,
  transactionIndex = 3,
  logIndex = 0,
  hash = txHash("c"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("TagRegistered"),
    [tagId, tag],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

function addTokenCreated(provider, record, {
  blockNumber = 102,
  transactionIndex = 2,
  logIndex = 0,
  hash = txHash("c"),
  token = TOKEN,
  name = "First Confirmed",
  symbol = "FIRST",
  tokenMetaUri = "ipfs://official-meta",
} = {}) {
  const encoded = FOUR_CORE_INTERFACE.encodeEventLog(
    FOUR_CORE_INTERFACE.getEvent("TokenCreated"),
    [
      99n,
      BigInt(record.id),
      CREATOR,
      token,
      name,
      symbol,
      1_000n,
      800n,
      20n,
      1n,
      ...MODULE_ADDRESSES,
      tokenMetaUri,
      0n,
      "0x",
    ],
  );
  return provider.addLog({
    address: FOUR_CORE_ADDRESS,
    encoded,
    blockNumber,
    transactionIndex,
    logIndex,
    transactionHash: hash,
  });
}

async function fixture(t, provider, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-monitor-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const delivered = [];
  const errors = [];
  const deliveryOwners = new Map();
  const eventSink = options.onEvent === false
    ? undefined
    : typeof options.onEvent === "function"
      ? options.onEvent
      : async (event) => {
        delivered.push(event);
        return { status: "delivered", eventId: event.eventKey, persisted: true };
      };
  const monitor = createFourRegistryMonitor({
    dataDir,
    fourRegistryConfirmations: options.confirmations ?? 2,
    ...(options.reorgLookback === undefined ? {} : { fourRegistryReorgLookbackBlocks: options.reorgLookback }),
    ...(options.chunkSize === undefined ? {} : { fourRegistryLogChunkSize: options.chunkSize }),
  }, {
    autoStart: false,
    provider,
    ...verificationDependencies(provider),
    ...(options.dependencies || {}),
    now: options.now || (() => Date.parse("2026-09-04T08:00:00.000Z")),
    onEvent: eventSink
      ? async (event) => {
        const result = await eventSink(event);
        deliveryOwners.set(event.eventKey, structuredClone(result));
        return result;
      }
      : undefined,
    cancelPendingEvent: options.cancelPendingEvent || (eventSink
      ? async ({ eventId }) => {
        const owner = deliveryOwners.get(eventId);
        if (!owner) return {
          status: "not_found",
          reason: "registry_event_not_found",
          persisted: false,
          terminal: false,
          eventId,
        };
        if (owner.status === "delivered"
          || (owner.reason === "semantic_duplicate" && owner.canonicalOwnerDelivered === true)) {
          return {
            status: "delivered_orphaned",
            reason: "canonical_reorg",
            persisted: true,
            terminal: true,
            eventId,
            deliveredAt: owner.deliveredAt || "2026-09-04T08:00:00.000Z",
          };
        }
        return { status: "superseded", reason: "canonical_reorg", persisted: true, terminal: true, eventId };
      }
      : undefined),
    logger: { error(message) { errors.push(String(message)); } },
  });
  return { monitor, dataDir, delivered, errors };
}

test("Four Registry first finalized inventory becomes a silent durable baseline", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [preset("1778027615723"), preset("1778027615732")]);
  addTokenCreated(provider, preset("1778027615723"), { blockNumber: 99 });
  addModuleUpserted(provider, { blockNumber: 99, hash: txHash("d") });
  addTokenImplUpserted(provider, { blockNumber: 99, hash: txHash("e") });
  addTagRegistered(provider, { blockNumber: 99, hash: txHash("f") });
  const { monitor, dataDir, delivered } = await fixture(t, provider);

  const result = await monitor.check();
  assert.equal(result.status, "baseline");
  assert.equal(result.lifecycleStage, "baseline");
  assert.deepEqual(result.events, []);
  assert.deepEqual(delivered, []);
  assert.equal(provider.logQueries.length, 0, "baseline must not replay historical TokenCreated logs");

  const state = await monitor.getState();
  assert.equal(state.initialized, true);
  assert.equal(state.cursor.anchorBlock, 100);
  assert.equal(state.cursor.nextBlock, 101);
  assert.deepEqual(Object.keys(state.presets), ["1778027615723", "1778027615732"]);
  assert.deepEqual(state.pendingConfirmations, {});
  assert.equal((await fs.stat(path.join(dataDir, "four-registry-state.json"))).mode & 0o777, 0o600);
  assert.ok(provider.calls.filter((call) => call.name === "call").every((call) => call.blockTag === 100));
});

test("post-baseline ModuleUpserted, TokenImplUpserted, and TagRegistered emit exact official capability events once", async (t) => {
  const existing = preset("1778027615723");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, delivered } = await fixture(t, provider);
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  addModuleUpserted(provider, { blockNumber: 101, transactionIndex: 1, hash: txHash("1") });
  addTokenImplUpserted(provider, { blockNumber: 101, transactionIndex: 2, hash: txHash("2") });
  addTagRegistered(provider, { blockNumber: 101, transactionIndex: 3, hash: txHash("3") });
  const result = await monitor.check();

  assert.deepEqual(result.events.map((event) => event.kind), [
    "four_registry_module_upserted",
    "four_registry_token_impl_upserted",
    "four_registry_tag_registered",
  ]);
  assert.equal(result.protocolCapabilityEventsObserved, 3);
  assert.equal(delivered.length, 3);
  for (const event of delivered) {
    assert.equal(isFourRegistryCapabilityEvent(event), true);
    assert.equal(isFourRegistryProtocolCapabilityEvent(event), true);
    assert.equal(event.evidence.canonical, true);
    assert.equal(event.evidence.finality, "confirmed");
    assert.equal(event.evidence.transactionHash, event.transactionHash);
    assert.equal(event.noveltyKey, event.lifecycleKey);
    assert.equal(event.informationalOnly, true);
    assert.equal(event.autoTradeEligible, false);
    assert.equal(event.automaticExecution, false);
    assert.deepEqual(event.tokens, []);
    assert.deepEqual(event.pools, []);
  }
  assert.deepEqual(Object.keys(delivered[0].changes), ["registryModules"]);
  assert.deepEqual(Object.keys(delivered[1].changes), ["registryTokenImplementations"]);
  assert.deepEqual(Object.keys(delivered[2].changes), ["registryTags"]);

  provider.head = 104;
  provider.setSnapshot(102, [existing]);
  assert.deepEqual((await monitor.check()).events, []);
  assert.equal(delivered.length, 3, "the canonical log identities remain exact-once");
  const state = await monitor.getState();
  assert.equal(state.processedEventKeys.length, 3);
  assert.deepEqual(Object.values(state.processedEvents).map((entry) => entry.subjectType), ["module", "token-impl", "tag"]);
});

test("a finalized new preset emits one capability update then ordered distinct TokenCreated confirmations", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732", { name: "Lista Yield" });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, delivered } = await fixture(t, provider);
  assert.equal((await monitor.check()).status, "baseline");

  provider.head = 104;
  provider.setSnapshot(101, [existing, added]);
  provider.setSnapshot(102, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("a"));
  addTokenCreated(provider, added, { blockNumber: 102, transactionIndex: 2, logIndex: 0, hash: txHash("c") });
  addTokenCreated(provider, added, {
    blockNumber: 102,
    transactionIndex: 3,
    logIndex: 0,
    hash: txHash("d"),
    token: "0xdddddddddddddddddddddddddddddddddddddddd",
  });

  const result = await monitor.check();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.events.map((event) => event.type), [
    "platform_capability_update",
    "bsc_launchpad_update",
    "bsc_launchpad_update",
  ]);
  assert.equal(result.events[0].kind, "four_registry_preset_added");
  assert.equal(result.events[0].lifecycleStage, "preset_added");
  assert.equal(result.events[0].presetId, added.id);
  assert.equal(result.events[0].evidence.basis, "canonical_registry_event_and_finalized_block_snapshot");
  assert.equal(result.events[0].evidence.canonical, true);
  assert.equal(result.events[0].currentPreset.active, true);
  assert.equal(result.events[0].currentPreset.createEnabled, true);
  assert.equal(result.events[0].trading.automaticExecution, false);
  assert.equal(isFourRegistryCapabilityEvent(result.events[0]), true);
  assert.equal(result.events[1].token.address, TOKEN);
  assert.equal(result.events[1].security.status, "unknown");
  assert.match(result.events[1].security.reason, /not a contract safety verdict/u);
  assert.equal(result.events[1].trading.automaticExecution, false);
  assert.equal(result.events[1].kind, "four_registry_first_token");
  assert.equal(result.events[1].lifecycleStage, "first_token_confirmed");
  assert.equal(result.events[1].lifecycleKey, result.events[0].lifecycleKey);
  assert.equal(isFourRegistryFirstTokenEvent(result.events[1]), true);
  assert.deepEqual(result.events.slice(1).map((event) => event.featureTokenOrdinal), [1, 2]);
  assert.equal(isFourRegistryFirstTokenEvent(result.events[2]), true);
  assert.equal(result.events[2].featureFirstToken, false);
  assert.deepEqual(delivered.map((event) => event.eventKey), result.events.map((event) => event.eventKey));

  const state = await monitor.getState();
  assert.deepEqual(state.pendingConfirmations, {});
  assert.equal((await monitor.check()).events.length, 0, "cursor and deterministic keys suppress repeats");
  assert.equal(delivered.length, 3);

  const restartedDelivered = [];
  const restarted = createFourRegistryMonitor({ dataDir: path.dirname(monitor.stateFile), fourRegistryConfirmations: 2 }, {
    autoStart: false,
    provider,
    ...verificationDependencies(provider),
    now: () => Date.parse("2026-09-04T08:01:00.000Z"),
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      restartedDelivered.push(event);
      return { status: "delivered", eventId: event.eventKey, persisted: true };
    },
    logger: { error() {} },
  });
  const afterRestart = await restarted.check();
  assert.equal(afterRestart.status, "ok");
  assert.deepEqual(afterRestart.events, [], "a durable cursor makes post-baseline events exact-once across restart");
  assert.deepEqual(restartedDelivered, []);
});

test("unfinalized capability and TokenCreated logs wait, then an active transition arms confirmation", async (t) => {
  const disabled = preset("1778027615723", { active: false });
  const active = preset("1778027615723", { active: true });
  const provider = new FakeBscProvider({ head: 101 });
  provider.setSnapshot(99, [disabled]);
  const { monitor } = await fixture(t, provider);
  assert.equal((await monitor.check()).status, "baseline");

  provider.head = 102;
  provider.setSnapshot(100, [disabled]);
  provider.setSnapshot(101, [active]);
  addActiveUpdate(provider, active.id, true, 101, 1, 0, txHash("b"));
  addTokenCreated(provider, active, { blockNumber: 101, transactionIndex: 2, hash: txHash("c") });
  const waiting = await monitor.check();
  assert.equal(waiting.finalizedBlock.number, 100);
  assert.deepEqual(waiting.events, []);
  assert.ok(provider.logQueries.every((query) => query.toBlock <= 100));

  provider.head = 103;
  const finalized = await monitor.check();
  assert.deepEqual(finalized.events.map((event) => event.type), [
    "platform_capability_update",
    "bsc_launchpad_update",
  ]);
  assert.equal(finalized.events[0].kind, "four_registry_preset_activated");
  assert.deepEqual(finalized.events[0].changedFields, ["active"]);
  assert.deepEqual(finalized.events[0].transition.active, { from: false, to: true });
  assert.equal(finalized.events[1].presetId, active.id);
});

test("wrong chain or broken fixed Registry/Core cross-link fails closed before creating a baseline", async (t) => {
  const wrongChain = new FakeBscProvider({ head: 102, chainId: 97 });
  wrongChain.setSnapshot(100, [preset("1")]);
  const wrong = await fixture(t, wrongChain);
  const wrongResult = await wrong.monitor.check();
  assert.equal(wrongResult.status, "degraded");
  assert.equal(wrongResult.errorCode, "FOUR_REGISTRY_CHAIN_ID_MISMATCH");
  await assert.rejects(fs.access(path.join(wrong.dataDir, "four-registry-state.json")));

  const broken = new FakeBscProvider({ head: 102 });
  broken.setSnapshot(100, [preset("1")]);
  broken.coreRegistry = CREATOR;
  const mismatch = await fixture(t, broken);
  const mismatchResult = await mismatch.monitor.check();
  assert.equal(mismatchResult.status, "degraded");
  assert.equal(mismatchResult.errorCode, "FOUR_REGISTRY_BINDING_MISMATCH");
  await assert.rejects(fs.access(path.join(mismatch.dataDir, "four-registry-state.json")));

  const wrongMulticall = new FakeBscProvider({ head: 102 });
  wrongMulticall.setSnapshot(100, [preset("1")]);
  const untrustedRuntime = await fixture(t, wrongMulticall, {
    dependencies: { multicall3CodeHashForTesting: FOUR_REGISTRY_MULTICALL3_CODE_HASH },
  });
  const untrustedResult = await untrustedRuntime.monitor.check();
  assert.equal(untrustedResult.status, "degraded");
  assert.equal(untrustedResult.errorCode, "FOUR_REGISTRY_MULTICALL_IDENTITY_MISMATCH");
  await assert.rejects(fs.access(path.join(untrustedRuntime.dataDir, "four-registry-state.json")));
});

test("a non-canonical receipt proof emits nothing and does not advance the cursor", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, delivered } = await fixture(t, provider);
  await monitor.check();
  const before = await monitor.getState();

  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  const log = addUpsert(provider, added, 101, 1, 0, txHash("e"));
  provider.receipts.get(log.transactionHash).blockHash = blockHash(100);
  const result = await monitor.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_LOG_NOT_CANONICAL");
  assert.deepEqual(delivered, []);
  const after = await monitor.getState();
  assert.deepEqual(after.cursor, before.cursor);
  assert.deepEqual(Object.keys(after.presets), Object.keys(before.presets));
});

function malformedLegacyFixture(v = 28) {
  // Synthetic public signature components: no wallet/key or signing call.
  const r = "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const s = `0x${"0".repeat(63)}1`;
  const transaction = Transaction.from({ type: 0, chainId: Signature.getChainId(v),
    nonce: 1, gasLimit: 100000n, gasPrice: 1000000000n, value: 0n,
    to: FOUR_REGISTRY_ADDRESS, data: "0x1234", signature: { r, s, v } });
  return { hash: transaction.hash, from: transaction.from, to: transaction.to,
    nonce: "0x1", gas: "0x186a0", gasPrice: "0x3b9aca00", value: "0x0",
    input: "0x1234", chainId: "", type: "0x0", r, s, v: `0x${v.toString(16)}`,
    blockNumber: "0x65", blockHash: blockHash(101), transactionIndex: "0x1" };
}

test("legacy empty chainId is recovered from the signed transaction, not filled with BSC", () => {
  for (const v of [27, 28, 147, 148]) {
    const raw = malformedLegacyFixture(v), before = structuredClone(raw);
    const restored = restoreFourLegacyTransaction(raw, raw.hash);
    assert.equal(restored.chainId, v < 35 ? "0x0" : "0x38");
    assert.equal(restored.index, 1);
    assert.deepEqual(raw, before);
  }
});

test("legacy recovery rejects altered payloads, identity, inclusion fields and foreign signatures", () => {
  const raw = malformedLegacyFixture();
  for (const change of [{ input: "0x1235" }, { input: undefined }, { from: CREATOR },
    { hash: txHash("f") }, { chainId: null }, { type: "0x2" }, { gas: null },
    { blockHash: null }, { transactionIndex: null }, { v: "0x25" }]) {
    assert.throws(() => restoreFourLegacyTransaction({ ...raw, ...change }, raw.hash),
      { code: "FOUR_REGISTRY_TRANSACTION_INVALID" });
  }
});

test("canonical Four proof recovers malformed legacy RPC data through the same source", async (t) => {
  const existing = preset("1778027615723"), added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, delivered } = await fixture(t, provider);
  await monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  const raw = malformedLegacyFixture();
  addUpsert(provider, added, 101, 1, 0, raw.hash);
  provider.getTransaction = async () => { throw new Error("invalid value.chainId: empty string"); };
  const originalSend = provider.send.bind(provider);
  let rawReads = 0;
  let badBlock = true;
  provider.send = async (method, args) => {
    if (method !== "eth_getTransactionByHash") return originalSend(method, args);
    assert.deepEqual(args, [raw.hash]); rawReads++;
    return { ...raw, blockHash: badBlock ? blockHash(100) : raw.blockHash };
  };
  const rejected = await monitor.check();
  assert.equal(rejected.status, "degraded");
  assert.equal(rejected.errorCode, "FOUR_REGISTRY_LOG_NOT_CANONICAL");
  assert.equal(delivered.length, 0);
  badBlock = false;
  const result = await monitor.check();
  assert.equal(result.status, "ok");
  assert.ok(rawReads > 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].evidence.canonical, true);
});

test("a changed finalized anchor hash performs bounded checkpoint recovery and replays post-baseline canonical events", async (t) => {
  const existing = preset("1778027615723");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const first = await fixture(t, provider, { reorgLookback: 1 });
  await first.monitor.check();
  const durableBefore = await first.monitor.getState();

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  provider.setBlockHash(100, `0x${"f".repeat(64)}`);
  const restarted = createFourRegistryMonitor({
    dataDir: first.dataDir,
    fourRegistryConfirmations: 2,
    fourRegistryReorgLookbackBlocks: 1,
  }, {
    autoStart: false,
    provider,
    ...verificationDependencies(provider),
    logger: { error() {} },
  });
  const result = await restarted.check();
  assert.equal(result.status, "recovered_reorg");
  assert.equal(result.lifecycleStage, "reorg_checkpoint_replay");
  assert.deepEqual(result.events, []);
  assert.equal(result.historicalTokenBackfill, true);
  assert.equal((await restarted.getState()).cursor.anchorBlock, 100);
  const onDisk = JSON.parse(await fs.readFile(path.join(first.dataDir, "four-registry-state.json"), "utf8"));
  assert.equal(onDisk.cursor.anchorBlock, 100);
  assert.equal(onDisk.reorgRecoveries.length, 1);
  assert.equal(onDisk.reorgRecoveries[0].oldAnchorBlockHash, durableBefore.cursor.anchorBlockHash);
});

test("a post-baseline inventory diff without a quorum Registry log fails closed without advancing", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor } = await fixture(t, provider);
  await monitor.check();

  provider.head = 104;
  provider.setSnapshot(101, [existing, added]);
  provider.setSnapshot(102, [existing, added]);
  addTokenCreated(provider, added, { blockNumber: 101, transactionIndex: 2, hash: txHash("f") });
  const result = await monitor.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_LOG_CONSENSUS_INCOMPLETE");
  const state = await monitor.getState();
  assert.equal(state.cursor.anchorBlock, 100);
  assert.equal(state.pendingConfirmations[added.id], undefined);
});

test("the monitor works through a createRpcPool-style raw eth_getLogs facade with no getLogs method", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const backing = new FakeBscProvider({ head: 102 });
  backing.setSnapshot(100, [existing]);
  const facade = rawLogFacade(backing);
  const { monitor } = await fixture(t, facade);
  await monitor.check();

  backing.head = 103;
  backing.setSnapshot(101, [existing, added]);
  addUpsert(backing, added, 101, 1, 0, txHash("7"));
  const result = await monitor.check();
  assert.equal(result.status, "ok");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, "four_registry_preset_added");
  assert.equal(facade.rawFilters.length, 2);
  assert.ok(facade.rawFilters.every((filter) => filter.fromBlock === "0x65" && filter.toBlock === "0x65"));
  assert.ok(facade.rawFilters.every((filter) => Array.isArray(filter.address) && filter.address.length === 2));
});

test("Multicall3 keeps the default 10000-block catch-up scan within the fixed physical-host RPC budget", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, Array.from({ length: 7 }, (_, index) => preset(String(1778027615800 + index))));
  const dependencies = {
    logVerificationProviders: [
      { sourceId: "shared-budget.test", provider: forwardingProvider(provider) },
      { sourceId: "log-budget.test", provider: forwardingProvider(provider) },
    ],
    stateVerificationProviders: [
      { sourceId: "shared-budget.test", provider: forwardingProvider(provider) },
      { sourceId: "state-budget.test", provider: forwardingProvider(provider) },
    ],
  };
  const { monitor } = await fixture(t, provider, { dependencies });
  assert.equal((await monitor.check()).status, "baseline");
  const before = monitor.getRpcTelemetry();

  provider.head = 10_102;
  const result = await monitor.check();
  const after = monitor.getRpcTelemetry();
  assert.equal(result.status, "ok");
  assert.equal(result.finalizedBlock.number, 10_100);
  assert.ok(provider.logQueries.every((filter) => filter.toBlock - filter.fromBlock + 1 <= 10_000));
  assert.equal(result.hasMore, false);

  const delta = (host, lane) => (
    (after.hosts[host].lanes[lane]?.calls || 0) - (before.hosts[host].lanes[lane]?.calls || 0)
  );
  assert.equal(delta("shared-budget.test", "state"), 12,
    "the large catch-up step also revalidates all three pinned runtimes on both state sources");
  assert.equal(delta("shared-budget.test", "log"), 2, "combined Registry/Core logs share one range hash and one eth_getLogs call");
  assert.equal(
    after.hosts["shared-budget.test"].calls - before.hosts["shared-budget.test"].calls,
    14,
    "the complete default catch-up cycle remains below the hard rolling host budget even with runtime revalidation",
  );
  assert.equal(after.hosts["shared-budget.test"].rateLimited, 0);
});

test("low-latency catch-up enforces the per-host rolling-minute ceiling across sixty 64-block cycles", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, Array.from({ length: 7 }, (_, index) => preset(String(1778027615900 + index))));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-capacity-window-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let rpcNowMs = 0;
  const sharedCallStarts = [];
  const timers = [];
  const monitor = createFourRegistryMonitor({
    dataDir,
    fourRegistryConfirmations: 2,
    fourRegistryLogChunkSize: 64,
    fourRegistryPollIntervalMs: 1,
    fourRegistryCatchUpIntervalMs: 1,
  }, {
    provider,
    multicall3CodeHashForTesting: TEST_MULTICALL3_CODE_HASH,
    logVerificationProviders: [
      { sourceId: "shared-capacity.test", provider: forwardingProvider(provider) },
      { sourceId: "log-capacity.test", provider: forwardingProvider(provider) },
    ],
    stateVerificationProviders: [
      { sourceId: "shared-capacity.test", provider: forwardingProvider(provider) },
      { sourceId: "state-capacity.test", provider: forwardingProvider(provider) },
    ],
    rpcBudgetNowForTesting: () => rpcNowMs,
    rpcBudgetSleepForTesting: async (delayMs) => { rpcNowMs += delayMs; },
    onRpcCallStartForTesting(record) {
      if (record.sourceId === "shared-capacity.test") sharedCallStarts.push(record.atMs);
    },
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { timer.cleared = true; },
    logger: { error() {} },
  });

  assert.equal((await monitor.start()).status, "baseline");
  provider.head = 100 + 60 * 64 + 2;
  for (let cycle = 0; cycle < 60; cycle += 1) {
    const timer = timers.shift();
    assert.ok(timer, `cycle ${cycle + 1} must remain scheduled`);
    assert.equal(timer.delay, 5_000, "configured sub-five-second intervals are raised to the hard minimum");
    rpcNowMs += timer.delay;
    await timer.callback();
  }
  const state = await monitor.getState();
  assert.equal(state.cursor.anchorBlock, provider.head - 2, "sixty cycles still consume sixty complete 64-block chunks");
  for (let index = 0; index < sharedCallStarts.length; index += 1) {
    const end = sharedCallStarts[index];
    const callsInWindow = sharedCallStarts.filter((startedAt) => startedAt > end - 60_000 && startedAt <= end).length;
    assert.ok(
      callsInWindow <= FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE,
      `rolling window at ${end}ms used ${callsInWindow} shared-host calls`,
    );
  }
  const telemetry = monitor.getRpcTelemetry();
  assert.ok(telemetry.hosts["shared-capacity.test"].throttleWaits > 0, "the low-latency fixture must exercise the hard limiter");
  assert.ok(telemetry.hosts["shared-capacity.test"].rollingWindowCalls <= FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE);
  assert.equal(telemetry.perHostRollingLimit, FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE);
  await monitor.stop();
});

test("stop cancels a saturated RPC budget wait without starting or committing the next call", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, Array.from({ length: 7 }, (_, index) => preset(String(1778027616000 + index))));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-budget-stop-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let rpcNowMs = 0;
  let releaseBudgetWait;
  const budgetWaitEntered = new Promise((resolve) => { releaseBudgetWait = resolve; });
  const sharedCallStarts = [];
  const monitor = createFourRegistryMonitor({
    dataDir,
    fourRegistryConfirmations: 2,
    fourRegistryLogChunkSize: 1,
  }, {
    provider,
    multicall3CodeHashForTesting: TEST_MULTICALL3_CODE_HASH,
    logVerificationProviders: [
      { sourceId: "shared-stop-budget.test", provider: forwardingProvider(provider) },
      { sourceId: "log-stop-budget.test", provider: forwardingProvider(provider) },
    ],
    stateVerificationProviders: [
      { sourceId: "shared-stop-budget.test", provider: forwardingProvider(provider) },
      { sourceId: "state-stop-budget.test", provider: forwardingProvider(provider) },
    ],
    rpcBudgetNowForTesting: () => rpcNowMs,
    rpcBudgetSleepForTesting: () => {
      releaseBudgetWait();
      return new Promise(() => {});
    },
    onRpcCallStartForTesting(record) {
      if (record.sourceId === "shared-stop-budget.test") sharedCallStarts.push(record);
    },
    logger: { error() {} },
  });

  assert.equal((await monitor.check()).status, "baseline");
  // Move beyond the baseline's rolling window, then consume exactly twelve
  // ordinary nine-call cycles. The next cycle is stopped before its first RPC.
  rpcNowMs = 60_001;
  sharedCallStarts.length = 0;
  provider.head = 100 + 20 + 2;
  for (let cycle = 0; cycle < 12; cycle += 1) {
    assert.equal((await monitor.check()).status, "ok");
  }
  assert.equal(sharedCallStarts.length, FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE);
  const anchorBeforeBlockedCycle = (await monitor.getState()).cursor.anchorBlock;
  const active = monitor.check();
  await budgetWaitEntered;

  const stoppedQuickly = await Promise.race([
    monitor.stop().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  assert.equal(stoppedQuickly, true, "stop must wake a saturated budget waiter immediately");
  const activeResult = await active;
  assert.equal(activeResult.status, "degraded");
  assert.equal(activeResult.errorCode, "FOUR_REGISTRY_STOPPED");
  assert.equal(sharedCallStarts.length, FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE, "the blocked call never starts");
  assert.equal((await monitor.getState()).cursor.anchorBlock, anchorBeforeBlockedCycle, "the interrupted cycle cannot commit a partial cursor");
  assert.equal((await monitor.check()).status, "stopped");
});

test("physical-host telemetry exposes a 429 without advancing the durable cursor", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [preset("1778027615807")]);
  let failLogs = false;
  const limitedLogs = async (filter) => {
    if (!failLogs) return provider.getLogs(filter);
    const error = new Error("429 compute units exhausted");
    error.status = 429;
    throw error;
  };
  const dependencies = {
    logVerificationProviders: [
      { sourceId: "limited-rpc.test", provider: providerFacade(provider, { getLogs: limitedLogs }) },
      { sourceId: "healthy-rpc.test", provider: forwardingProvider(provider) },
    ],
    stateVerificationProviders: [
      { sourceId: "state-one.test", provider: forwardingProvider(provider) },
      { sourceId: "state-two.test", provider: forwardingProvider(provider) },
    ],
  };
  const { monitor, errors } = await fixture(t, provider, { dependencies });
  await monitor.check();
  failLogs = true;
  provider.head = 103;
  const result = await monitor.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_LOG_QUERY_FAILED");
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
  const telemetry = monitor.getRpcTelemetry();
  assert.equal(telemetry.hosts["limited-rpc.test"].rateLimited, 1);
  assert.equal(telemetry.hosts["limited-rpc.test"].lanes.log.rateLimited, 1);
  assert.ok(errors.some((message) => message.includes("limited-rpc.test log/getLogs rate limited")));
});

test("nested 429 waits for Retry-After without recursively splitting ranges or moving the cursor", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [preset("1778027615807")]);
  let failing = false;
  let attempts = 0;
  const dependencies = verificationDependencies(provider);
  dependencies.logVerificationProviders[0].provider = providerFacade(provider, {
    getLogs: async (filter) => {
      attempts += 1;
      if (!failing) return provider.getLogs(filter);
      const cause = Object.assign(new Error("log query rate limit exceeded"), { status: 429, retryAfterMs: 120_000 });
      throw new Error("log query limit exceeded", { cause });
    },
  });
  const timers = [];
  dependencies.setTimeoutImpl = (callback, delay) => {
    const handle = { callback, delay, unref() {} };
    timers.push(handle);
    return handle;
  };
  dependencies.clearTimeoutImpl = (handle) => { handle.cleared = true; };
  const { monitor } = await fixture(t, provider, { dependencies });
  assert.equal((await monitor.start()).status, "baseline");
  failing = true;
  provider.head = 112;
  await timers.shift().callback();
  assert.equal(attempts, 1, "quota errors cannot trigger range bisection");
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
  assert.equal(timers.length, 1, "no overlapping retry timers");
  assert.equal(timers[0].delay, 120_000, "wrapped provider Retry-After survives Registry error wrapping");
  failing = false;
  await timers.shift().callback();
  assert.equal((await monitor.getState()).cursor.anchorBlock, 110);
  assert.equal(timers[0].delay, 30_000, "normal cadence returns after a complete successful scan");
  await monitor.stop();
  assert.equal(timers[0].cleared, true, "stop cancels even a deferred retry");
});

test("scheduler respects non-429 shared cooldowns and backs off repeated unclassified failures", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [preset("1778027615807")]);
  const timers = [];
  let failure = Object.assign(new Error("providers cooling down"), { retryAfterMs: 180_000 });
  const { monitor } = await fixture(t, provider, { dependencies: {
    provider: providerFacade(provider, { getBlockNumber: async () => {
      if (failure) throw failure;
      return provider.head;
    } }),
    setTimeoutImpl: (callback, delay) => {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { handle.cleared = true; },
  } });
  assert.equal((await monitor.start()).status, "degraded");
  assert.equal(timers[0].delay, 180_000);
  failure = null;
  await timers.shift().callback();
  assert.equal(timers[0].delay, 30_000);
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
  failure = new Error("network unavailable");
  for (const expected of [30_000, 60_000, 60_000]) {
    await timers.shift().callback();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, expected);
  }
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
  failure = null;
  provider.head = 103;
  await timers.shift().callback();
  assert.equal(timers[0].delay, 30_000);
  assert.equal((await monitor.getState()).cursor.anchorBlock, 101);
  await monitor.stop();
});

test("a divergent Multicall3 state snapshot fails closed under the two fixed state readers", async (t) => {
  const original = preset("1778027615808");
  const changed = preset(original.id, { description: "different state result" });
  const canonical = new FakeBscProvider({ head: 102 });
  const divergent = new FakeBscProvider({ head: 102 });
  canonical.setSnapshot(100, [original]);
  divergent.setSnapshot(100, [original]);
  const dependencies = {
    logVerificationProviders: [
      { sourceId: "log-state-a.test", provider: forwardingProvider(canonical) },
      { sourceId: "log-state-b.test", provider: forwardingProvider(canonical) },
    ],
    stateVerificationProviders: [
      { sourceId: "state-canonical.test", provider: forwardingProvider(canonical) },
      { sourceId: "state-divergent.test", provider: forwardingProvider(divergent) },
    ],
  };
  const { monitor } = await fixture(t, canonical, { dependencies });
  assert.equal((await monitor.check()).status, "baseline");
  canonical.head = 103;
  divergent.head = 103;
  canonical.setSnapshot(101, [original]);
  divergent.setSnapshot(101, [changed]);
  const result = await monitor.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_STATE_CONSENSUS_MISMATCH");
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
});

test("policy/source suppression stays in the durable outbox and retries in lifecycle order", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let delivery = { status: "suppressed", reason: "policy_suppressed", terminal: true, disposition: "terminal" };
  const attempts = [];
  const monitor = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      attempts.push(event.eventKey);
      return delivery.status === "queued" ? { ...delivery, eventId: event.eventKey } : delivery;
    },
    logger: { error() {} },
  });
  await monitor.check();
  provider.head = 104;
  provider.setSnapshot(101, [existing, added]);
  provider.setSnapshot(102, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("8"));
  addTokenCreated(provider, added, { blockNumber: 102, transactionIndex: 2, hash: txHash("9") });

  const suppressed = await monitor.check();
  assert.equal(suppressed.delivery.accepted, 0);
  assert.equal(suppressed.outboxPending, 2);
  assert.equal(attempts.length, 1, "first blocked lifecycle stage prevents first-token overtaking");
  const retained = await monitor.getState();
  assert.equal(retained.outbox.length, 2);
  assert.deepEqual(retained.processedEventKeys, []);
  assert.equal(retained.cursor.anchorBlock, 102, "chain cursor may advance only because full events are already durable");

  delivery = { status: "queued", persisted: true };
  const retried = await monitor.check();
  assert.equal(retried.delivery.accepted, 2);
  assert.equal(retried.outboxPending, 0);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(classifyFourRegistryDelivery({ status: "suppressed", reason: "policy_suppressed", terminal: true }), "retry");
});

test("an acknowledgement fsync failure retries the identical eventKey after restart and accepts only canonical-owner semantic duplicate", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-ack-failure-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let writes = 0;
  const firstAttempts = [];
  const first = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      firstAttempts.push(event.eventKey);
      return { status: "delivered", eventId: event.eventKey, persisted: true };
    },
    atomicWriteImpl: async (file, state) => {
      writes += 1;
      if (writes === 3) throw new Error("simulated acknowledgement fsync failure");
      return atomicWriteFourRegistryState(file, state);
    },
    logger: { error() {} },
  });
  await first.check();
  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("6"));
  const failedAck = await first.check();
  assert.equal(failedAck.status, "degraded");
  assert.equal(firstAttempts.length, 1);
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, "four-registry-state.json"), "utf8"));
  assert.equal(durable.outbox.length, 1, "the complete event was fsync'd before the external delivery");
  assert.equal(durable.outbox[0].eventKey, firstAttempts[0]);
  assert.deepEqual(durable.processedEventKeys, []);

  const retryAttempts = [];
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      retryAttempts.push(event.eventKey);
      return {
        status: "suppressed",
        reason: "semantic_duplicate",
        eventId: event.eventKey,
        persisted: true,
        canonicalOwnerDelivered: true,
        duplicateOf: "bsc-owner:event",
      };
    },
    logger: { error() {} },
  });
  const retried = await restarted.check();
  assert.equal(retried.status, "ok");
  assert.deepEqual(retryAttempts, firstAttempts, "restart retries the exact same deterministic eventKey");
  const accepted = await restarted.getState();
  assert.equal(accepted.outbox.length, 0);
  assert.deepEqual(accepted.processedEventKeys, firstAttempts);
  assert.equal(accepted.processedEvents[firstAttempts[0]].deliveryStatus, "semantic_duplicate");
  assert.equal(classifyFourRegistryDelivery({
    status: "suppressed",
    reason: "semantic_duplicate",
    eventId: firstAttempts[0],
    persisted: true,
  }, firstAttempts[0]), "retry");
});

test("persisted processed indexes and pending lifecycle references fail closed when corrupted", async (t) => {
  const existing = preset("1778027615723");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, dataDir } = await fixture(t, provider);
  await monitor.check();
  const file = path.join(dataDir, "four-registry-state.json");
  const corrupted = JSON.parse(await fs.readFile(file, "utf8"));
  corrupted.processedEventKeys.push("invented-skip-key");
  await fs.writeFile(file, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    logger: { error() {} },
  });
  const result = await restarted.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_STATE_INVALID");
});

test("pending arm coordinates cannot be jointly poisoned in live state and its checkpoint", async (t) => {
  const id = "1778027615739";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const { monitor, dataDir } = await fixture(t, provider);
  await monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, txHash("3"));
  await monitor.check();

  const file = path.join(dataDir, "four-registry-state.json");
  const corrupted = JSON.parse(await fs.readFile(file, "utf8"));
  const inventedHash = `0x${"f".repeat(64)}`;
  corrupted.pendingConfirmations[id].armedAt.blockHash = inventedHash;
  corrupted.checkpoints.at(-1).pendingConfirmations[id].armedAt.blockHash = inventedHash;
  await fs.writeFile(file, `${JSON.stringify(corrupted)}\n`, { mode: 0o600 });
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    logger: { error() {} },
  });
  const result = await restarted.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_STATE_INVALID");
});

test("persisted uninitialized state and a future token-suppression poison fail closed", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [preset("1778027615723")]);
  const first = await fixture(t, provider);
  await first.monitor.check();
  const file = path.join(first.dataDir, "four-registry-state.json");
  const original = JSON.parse(await fs.readFile(file, "utf8"));

  await fs.writeFile(file, `${JSON.stringify({ ...original, initialized: false })}\n`, { mode: 0o600 });
  let restarted = createFourRegistryMonitor({ dataDir: first.dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    logger: { error() {} },
  });
  let result = await restarted.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_STATE_INVALID");

  await fs.writeFile(file, `${JSON.stringify({ ...original, attackerState: true })}\n`, { mode: 0o600 });
  restarted = createFourRegistryMonitor({ dataDir: first.dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    logger: { error() {} },
  });
  result = await restarted.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_STATE_INVALID");

  await fs.writeFile(file, `${JSON.stringify({ ...original, tokenBackfillSuppressedThroughBlock: 999_999_999 })}\n`, { mode: 0o600 });
  restarted = createFourRegistryMonitor({ dataDir: first.dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    logger: { error() {} },
  });
  result = await restarted.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_STATE_INVALID");
});

test("a post-rename write error adopts the exact durable baseline instead of silently rebaselining", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-readback-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let writes = 0;
  const delivered = [];
  const monitor = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    atomicWriteImpl: async (file, state) => {
      writes += 1;
      await atomicWriteFourRegistryState(file, state);
      if (writes === 1) throw new Error("simulated directory fsync report after rename");
    },
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      delivered.push(event);
      return { status: "delivered", eventId: event.eventKey, persisted: true };
    },
    logger: { error() {} },
  });
  assert.equal((await monitor.check()).status, "baseline");

  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("5"));
  const updated = await monitor.check();
  assert.equal(updated.status, "ok");
  assert.deepEqual(updated.events.map((event) => event.kind), ["four_registry_preset_added"]);
  assert.equal(delivered.length, 1, "the update after the durable baseline is not silently swallowed");
});

test("state quorum disagreement cannot re-elect a mismatched anchor checkpoint", async (t) => {
  const existing = preset("1778027615723");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  provider.setSnapshot(103, [existing]);
  const { monitor } = await fixture(t, provider);
  await monitor.check();
  provider.head = 103;
  await monitor.check();
  provider.head = 104;
  await monitor.check();

  provider.head = 105;
  let anchorReads = 0;
  const canonicalGetBlock = provider.getBlock.bind(provider);
  provider.getBlock = async (number) => {
    if (Number(number) !== 102) return canonicalGetBlock(number);
    anchorReads += 1;
    if (anchorReads === 1) return { ...provider.block(102), hash: `0x${"a".repeat(64)}` };
    return canonicalGetBlock(number);
  };
  const recovered = await monitor.check();
  assert.equal(recovered.status, "degraded");
  assert.equal(recovered.errorCode, "FOUR_REGISTRY_STATE_CONSENSUS_MISMATCH");
  assert.equal(anchorReads, 2, "independent state readers expose the rotating endpoint disagreement");
});

test("long outage catch-up is bounded into configured eth_getLogs chunks and does not skip a late preset", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, delivered } = await fixture(t, provider, { chunkSize: 5 });
  await monitor.check();

  provider.head = 132;
  provider.setSnapshot(118, [existing]);
  provider.setSnapshot(119, [existing, added]);
  addUpsert(provider, added, 119, 1, 0, txHash("4"));
  const results = [];
  for (let cycle = 0; cycle < 6; cycle += 1) results.push(await monitor.check());
  assert.deepEqual(results.map((result) => result.finalizedBlock.number), [105, 110, 115, 120, 125, 130]);
  assert.deepEqual(results.map((result) => result.hasMore), [true, true, true, true, true, false]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].presetId, added.id);
  assert.ok(provider.logQueries.every((filter) => filter.toBlock - filter.fromBlock + 1 <= 5));
});

test("reorg recovery replays the canonical post-baseline capability and its true first TokenCreated", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(99, [existing]);
  provider.setSnapshot(100, [existing]);
  const { monitor, delivered } = await fixture(t, provider, { reorgLookback: 1, chunkSize: 10 });
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  provider.setBlockHash(100, `0x${"e".repeat(64)}`);
  addUpsert(provider, added, 101, 1, 0, txHash("3"));
  addTokenCreated(provider, added, { blockNumber: 101, transactionIndex: 2, hash: txHash("2") });

  const recovered = await monitor.check();
  assert.equal(recovered.status, "recovered_reorg");
  assert.equal(recovered.resumeFromBlock, 101);
  assert.equal(recovered.catchUpThroughBlock, 101);
  assert.deepEqual(delivered, []);

  const replayed = await monitor.check();
  assert.equal(replayed.status, "ok");
  assert.deepEqual(replayed.events.map((event) => event.kind), ["four_registry_preset_added", "four_registry_first_token"]);
  assert.equal(delivered.length, 2);
  let state = await monitor.getState();
  assert.equal(state.pendingConfirmations[added.id], undefined);
  assert.equal(state.tokenBackfillSuppressedThroughBlock, 100);
});

test("an orphaned durable outbox event is rolled back before delivery resumes", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-reorg-retain-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const attempted = [];
  let delivery = { status: "suppressed", reason: "monitoring_source_disabled", terminal: true };
  const monitor = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      attempted.push(event.eventKey);
      return delivery;
    },
    logger: { error() {} },
  });
  await monitor.check();
  provider.head = 104;
  provider.setSnapshot(102, [existing]);
  await monitor.check();

  provider.head = 105;
  provider.setSnapshot(103, [existing, added]);
  addUpsert(provider, added, 103, 1, 0, txHash("a"));
  await monitor.check();
  const before = await monitor.getState();
  assert.equal(before.outbox.length, 1);
  assert.equal(before.cursor.anchorBlock, 103);
  assert.equal(attempted.length, 1);

  delivery = { status: "delivered", eventId: before.outbox[0].eventKey, persisted: true };
  provider.setBlockHash(103, `0x${"d".repeat(64)}`);
  const recovered = await monitor.check();
  assert.equal(recovered.status, "recovered_reorg");
  assert.equal(recovered.finalizedBlock.number, 102);
  assert.deepEqual(recovered.droppedOutboxEventKeys, [before.outbox[0].eventKey]);
  assert.deepEqual(recovered.retainedOutboxEventKeys, []);
  const after = await monitor.getState();
  assert.equal(after.outbox.length, 0);
  assert.equal(after.pendingConfirmations[added.id], undefined);
  assert.equal(attempted.length, 1, "the recovered sender never receives the orphaned event");
});

test("delivery acknowledgements are bound to the exact incoming event id", () => {
  const expected = "four-registry:56:expected";
  assert.equal(classifyFourRegistryDelivery({ status: "delivered", eventId: expected, persisted: true }, expected), "delivered");
  assert.equal(classifyFourRegistryDelivery({ status: "delivered", eventId: expected }, expected), "retry");
  assert.equal(classifyFourRegistryDelivery({ status: "queued", eventId: "other" }, expected), "retry");
  assert.equal(classifyFourRegistryDelivery({ status: "suppressed", reason: "freshness_too_old", eventId: expected, persisted: true, terminal: true }, expected), "retry");
  assert.equal(classifyFourRegistryDelivery({
    status: "suppressed",
    reason: "policy_suppressed",
    eventId: expected,
    persisted: true,
    terminal: true,
  }, expected), "retry");
  assert.equal(classifyFourRegistryDelivery({
    status: "suppressed",
    reason: "semantic_duplicate",
    eventId: expected,
    persisted: true,
    canonicalOwnerDelivered: true,
    duplicateOf: "bsc-owner:event",
  }, expected), "semantic_duplicate");
  assert.equal(classifyFourRegistryDelivery({
    status: "suppressed",
    reason: "semantic_duplicate",
    eventId: "other",
    persisted: true,
    canonicalOwnerDelivered: true,
  }, expected), "retry");
});

test("a TokenCreated emitted by Core through a top-level router call keeps its canonical proof", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, delivered } = await fixture(t, provider);
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("7"));
  await monitor.check();

  provider.head = 104;
  provider.setSnapshot(102, [existing, added]);
  const tokenTransactionHash = txHash("8");
  addTokenCreated(provider, added, { blockNumber: 102, hash: tokenTransactionHash });
  provider.receipts.get(tokenTransactionHash).to = ROUTER;
  provider.transactions.get(tokenTransactionHash).to = ROUTER;

  const result = await monitor.check();
  assert.deepEqual(result.events.map((event) => event.kind), ["four_registry_first_token"]);
  assert.equal(delivered.at(-1).token.address, TOKEN);
  assert.equal(delivered.at(-1).evidence.canonical, true);
});

test("the scheduler uses a capacity-safe catch-up cadence and converges while the BSC head advances", async (t) => {
  const existing = preset("1778027615723");
  const added = preset("1778027615732");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  provider.setSnapshot(135, [existing, added]);
  addUpsert(provider, added, 135, 1, 0, txHash("9"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-scheduler-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const delivered = [];
  const timers = [];
  const setTimeoutImpl = (callback, delay) => {
    const handle = { callback, delay, cleared: false, unref() {} };
    timers.push(handle);
    return handle;
  };
  const monitor = createFourRegistryMonitor({
    dataDir,
    fourRegistryConfirmations: 2,
    fourRegistryLogChunkSize: 5,
    fourRegistryPollIntervalMs: 30_000,
    fourRegistryCatchUpIntervalMs: 1_000,
  }, {
    provider,
    ...verificationDependencies(provider),
    setTimeoutImpl,
    clearTimeoutImpl: (handle) => { handle.cleared = true; },
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      delivered.push(event);
      return { status: "delivered", eventId: event.eventKey, persisted: true };
    },
    logger: { error() {} },
  });

  assert.equal((await monitor.start()).status, "baseline");
  let next = timers.shift();
  assert.equal(next.delay, 30_000);
  provider.head = 152;
  for (let cycle = 0; cycle < 30; cycle += 1) {
    await next.callback();
    next = timers.shift();
    assert.ok(next, "scheduler must always leave exactly one next poll");
    if (next.delay === 30_000) break;
    assert.equal(next.delay, 5_000, "a remaining backlog keeps the physical-host capacity reserve");
    provider.head += 1;
  }
  const state = await monitor.getState();
  assert.equal(state.cursor.anchorBlock, provider.head - 2, "the cursor catches the moving finalized head");
  assert.equal(next.delay, 30_000, "normal polling resumes only after the backlog is gone");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].presetId, added.id);
  await monitor.stop();
});

test("same-block enable, first token, then disable is replayed in canonical log order", async (t) => {
  const id = "1778027615801";
  const before = preset(id, { active: false, createEnabled: true });
  const after = preset(id, { active: true, createEnabled: false });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [before]);
  const { monitor, delivered } = await fixture(t, provider);
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [after]);
  addActiveUpdate(provider, id, true, 101, 1, 0, txHash("1"));
  addTokenCreated(provider, after, { blockNumber: 101, transactionIndex: 2, hash: txHash("2") });
  addCreateEnabledUpdate(provider, id, false, 101, 3, 0, txHash("3"));

  const result = await monitor.check();
  assert.deepEqual(result.events.map((event) => event.kind), [
    "four_registry_preset_activated",
    "four_registry_first_token",
    "four_registry_preset_create_disabled",
  ]);
  assert.equal(result.events[1].capabilityEventKey, result.events[0].eventKey);
  assert.equal(result.events[1].lifecycleKey, result.events[0].lifecycleKey);
  assert.equal(delivered.length, 3);
  assert.equal((await monitor.getState()).pendingConfirmations[id], undefined);
});

test("same-block two-step enable arms only the transition that makes the preset creatable", async (t) => {
  const id = "1778027615802";
  const before = preset(id, { active: false, createEnabled: false });
  const after = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [before]);
  const { monitor } = await fixture(t, provider);
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [after]);
  addActiveUpdate(provider, id, true, 101, 1, 0, txHash("4"));
  addCreateEnabledUpdate(provider, id, true, 101, 2, 0, txHash("5"));
  addTokenCreated(provider, after, { blockNumber: 101, transactionIndex: 3, hash: txHash("6") });

  const result = await monitor.check();
  assert.deepEqual(result.events.map((event) => event.kind), [
    "four_registry_preset_activated",
    "four_registry_preset_create_enabled",
    "four_registry_first_token",
  ]);
  assert.equal(result.events[2].capabilityEventKey, result.events[1].eventKey);
  assert.equal(result.events[2].lifecycleKey, result.events[1].lifecycleKey);
});

test("same-block preset upserts defer block-end metadata to an explicit final settlement", async (t) => {
  const id = "1778027615803";
  const before = preset(id, { name: "V1", description: "V1 metadata", version: "1.0.0" });
  const blockEnd = preset(id, { name: "V3", description: "V3 metadata", version: "3.0.0" });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [before]);
  const { monitor, dataDir, delivered } = await fixture(t, provider);
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [blockEnd]);
  addUpsert(provider, blockEnd, 101, 4, 0, txHash("4"));
  addUpsert(provider, blockEnd, 101, 5, 0, txHash("5"));
  const result = await monitor.check();

  assert.equal(result.status, "ok");
  assert.equal(result.events.length, 2);
  const [first, final] = result.events;
  assert.equal(first.transactionHash, txHash("4"));
  assert.equal(first.previousPreset.name, "V1");
  assert.equal(first.currentPreset.name, "V1", "the first tx must not inherit a later block-end tuple");
  assert.deepEqual(first.changedFields, ["registryEvent"]);
  assert.equal(first.snapshotScope, "canonical_event_status_only_metadata_deferred_within_block");
  assert.equal(first.lifecycleKey, `fourmeme:openfour:preset:${id}:generation:${txHash("4")}:0`);

  assert.equal(final.transactionHash, txHash("5"));
  assert.equal(final.previousPreset.name, "V1");
  assert.equal(final.currentPreset.name, "V3");
  assert.deepEqual(final.changedFields, ["blockEndMetadataSettlement"]);
  assert.equal(final.snapshotScope, "canonical_event_status_plus_same_block_final_metadata_settlement");
  assert.equal(final.lifecycleKey, `fourmeme:openfour:preset:${id}:generation:${txHash("5")}:0`);
  assert.equal(final.changes.updatedPresets[0].changedFields.includes("name"), false);
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((event) => isFourRegistryCapabilityEvent(event)));

  const forgedScope = structuredClone(first);
  forgedScope.snapshotScope = "canonical_event_status_plus_block_end_metadata";
  assert.equal(
    isFourRegistryCapabilityEvent(forgedScope),
    false,
    "snapshot attribution is part of the immutable payload digest",
  );

  await monitor.stop();
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    autoStart: false,
    logger: { error() {} },
  });
  assert.ok(["ok", "up_to_date"].includes((await restarted.check()).status));
  assert.equal((await restarted.getState()).processedEventKeys.length, 2);
});

test("deferred same-block metadata survives durable retry and marks an intervening first token", async (t) => {
  const id = "1778027615804";
  const before = preset(id, {
    name: "V1",
    description: "V1 metadata",
    version: "1.0.0",
    active: false,
    createEnabled: true,
  });
  const blockEnd = preset(id, {
    name: "V3",
    description: "V3 metadata",
    version: "3.0.0",
    active: true,
    createEnabled: true,
  });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [before]);
  let deliveryAvailable = false;
  const attempts = [];
  const accepted = [];
  const sink = async (event) => {
    attempts.push(event.eventKey);
    if (!deliveryAvailable) {
      return { status: "suppressed", reason: "policy_suppressed", terminal: true, disposition: "terminal" };
    }
    accepted.push(event);
    return { status: "delivered", eventId: event.eventKey, persisted: true };
  };
  const { monitor, dataDir } = await fixture(t, provider, { onEvent: sink });
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [blockEnd]);
  addUpsert(provider, blockEnd, 101, 4, 0, txHash("4"));
  addTokenCreated(provider, blockEnd, { blockNumber: 101, transactionIndex: 5, hash: txHash("5") });
  addUpsert(provider, blockEnd, 101, 6, 0, txHash("6"));
  const discovered = await monitor.check();
  assert.deepEqual(discovered.events.map((event) => event.kind), [
    "four_registry_preset_activated",
    "four_registry_first_token",
    "four_registry_preset_updated",
  ]);
  assert.equal(attempts.length, 1, "the first retry keeps later lifecycle cards ordered behind it");
  assert.equal(discovered.events[1].preset.name, "V1");
  assert.equal(
    discovered.events[1].presetSnapshotScope,
    "canonical_event_status_only_metadata_deferred_within_block",
  );
  assert.equal(isFourRegistryFirstTokenEvent(discovered.events[1]), true);
  assert.equal((await monitor.getState()).outbox.length, 3);

  await monitor.stop();
  deliveryAvailable = true;
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    autoStart: false,
    onEvent: sink,
    cancelPendingEvent: supersedeCancellation,
    logger: { error() {} },
  });
  const replayed = await restarted.check();
  assert.notEqual(replayed.status, "degraded");
  assert.deepEqual(accepted.map((event) => event.eventKey), discovered.events.map((event) => event.eventKey));
  assert.equal((await restarted.getState()).outbox.length, 0);
});

test("a direct preset retry still fails closed if its exact block-end metadata proof changes", async (t) => {
  const id = "1778027615805";
  const before = preset(id, { name: "V1" });
  const updated = preset(id, { name: "V2" });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [before]);
  const { monitor } = await fixture(t, provider, { onEvent: false });
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [updated]);
  addUpsert(provider, updated, 101, 1, 0, txHash("7"));
  assert.equal((await monitor.check()).status, "ok");
  assert.equal((await monitor.getState()).outbox.length, 1);

  provider.setSnapshot(101, [preset(id, { name: "forged block-end metadata" })]);
  const failed = await monitor.check();
  assert.equal(failed.status, "degraded");
  assert.equal(failed.errorCode, "FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH");
  assert.equal((await monitor.getState()).outbox.length, 1);
});

test("post-proof observation time authenticates delayed recovery and the exact fifteen-minute boundary", async (t) => {
  const existing = preset("1778027615901");
  const provider = new FakeBscProvider({ head: 102 });
  const eventTimestamp = Date.parse("2026-09-04T07:00:00.000Z") / 1_000;
  provider.setBlockTimestamp(100, eventTimestamp - 1);
  provider.setBlockTimestamp(101, eventTimestamp);
  provider.setSnapshot(100, [existing]);
  let nowMs = eventTimestamp * 1_000 + 14 * 60_000 + 59_000;
  const { monitor, dataDir } = await fixture(t, provider, { now: () => nowMs });
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  addModuleUpserted(provider, { blockNumber: 101, hash: txHash("7") });
  const originalGetLogs = provider.getLogs.bind(provider);
  provider.getLogs = async (filter) => {
    const result = await originalGetLogs(filter);
    nowMs = eventTimestamp * 1_000 + 15 * 60_000 + 1;
    return result;
  };
  const delayed = (await monitor.check()).events[0];
  assert.equal(delayed.deliveryPolicy.tier, "T2");
  assert.equal(delayed.delayedRecovery.lagMs, 900_001);
  assert.equal(delayed.delayedRecovery.priorAnchorBlock, 100);
  assert.equal(delayed.delayedRecovery.scanFromBlock, 101);
  assert.equal(delayed.delayedRecovery.scanThroughBlock, 101);
  assert.equal(delayed.delayedRecovery.eventBlockNumber, 101);
  assert.equal(delayed.delayedRecovery.eventBlockHash, delayed.blockHash);
  assert.equal(isFourRegistryCapabilityEvent(delayed), true);
  const missingRecovery = structuredClone(delayed);
  delete missingRecovery.delayedRecovery;
  assert.equal(isFourRegistryCapabilityEvent(missingRecovery), false);
  const badLag = structuredClone(delayed);
  badLag.delayedRecovery.lagMs -= 1;
  assert.equal(isFourRegistryCapabilityEvent(badLag), false);
  const forgedFresh = structuredClone(delayed);
  forgedFresh.observedAt = new Date(eventTimestamp * 1_000 + 14 * 60_000).toISOString();
  forgedFresh.deliveryPolicy.tier = "T1";
  forgedFresh.deliveryPolicy.firstObservedAt = forgedFresh.observedAt;
  delete forgedFresh.delayedRecovery;
  assert.equal(forgedFresh.payloadDigest, delayed.payloadDigest, "canonical payload identity excludes delivery timing");
  assert.equal(
    isFourRegistryCapabilityEvent(forgedFresh),
    false,
    "the independent delivery evidence digest rejects a coordinated fresh/delayed rewrite",
  );

  provider.getLogs = originalGetLogs;
  provider.head = 104;
  provider.setBlockTimestamp(102, eventTimestamp + 10);
  provider.setSnapshot(102, [existing]);
  addTagRegistered(provider, { blockNumber: 102, hash: txHash("8") });
  nowMs = (eventTimestamp + 10) * 1_000 + 15 * 60_000;
  const boundary = (await monitor.check()).events[0];
  assert.equal(boundary.deliveryPolicy.tier, "T1");
  assert.equal(Object.hasOwn(boundary, "delayedRecovery"), false);
  assert.equal(isFourRegistryCapabilityEvent(boundary), true);

  await monitor.stop();
  const stateFile = path.join(dataDir, "four-registry-state.json");
  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  raw.processedEvents[delayed.eventKey].event = forgedFresh;
  await fs.writeFile(stateFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    autoStart: false,
    logger: { error() {} },
  });
  const corrupted = await restarted.check();
  assert.equal(corrupted.status, "degraded");
  assert.equal(corrupted.errorCode, "FOUR_REGISTRY_STATE_INVALID");
});

test("closed producer validators reject root, URL, proof, payload, and lifecycle mutations", async (t) => {
  const existing = preset("1778027615902");
  const added = preset("1778027615903", { name: "Validator fixture" });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor } = await fixture(t, provider);
  await monitor.check();

  provider.head = 104;
  provider.setSnapshot(101, [existing, added]);
  provider.setSnapshot(102, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("9"));
  addModuleUpserted(provider, { blockNumber: 101, transactionIndex: 2, hash: txHash("a") });
  addTokenCreated(provider, added, { blockNumber: 102, transactionIndex: 1, hash: txHash("b") });
  const events = (await monitor.check()).events;
  const presetEvent = events.find((event) => event.kind === "four_registry_preset_added");
  const protocolEvent = events.find((event) => event.kind === "four_registry_module_upserted");
  const tokenEvent = events.find((event) => event.kind === "four_registry_first_token");
  assert.equal(isFourRegistryCapabilityEvent(presetEvent), true);
  assert.equal(isFourRegistryCapabilityEvent(protocolEvent), true);
  assert.equal(isFourRegistryFirstTokenEvent(tokenEvent), true);

  const mutations = [
    [presetEvent, (event) => { event.attackerUrl = "https://evil.invalid"; }],
    [presetEvent, (event) => { event.platform.twitter = "https://evil.invalid"; }],
    [presetEvent, (event) => { event.source.url = "https://evil.invalid"; }],
    [presetEvent, (event) => { event.eventKey = "attacker-controlled-key"; }],
    [presetEvent, (event) => { event.evidence.blockHash = blockHash(999); }],
    [presetEvent, (event) => { event.currentPreset.active = false; }],
    [presetEvent, (event) => { delete event.deliveryPolicy; }],
    [protocolEvent, (event) => { event.registryEventName = "TagRegistered"; }],
    [protocolEvent, (event) => { event.module.kindName = "attacker-kind"; }],
    [protocolEvent, (event) => { event.evidence.canonicalLog.data = "0x"; }],
  ];
  for (const [original, mutate] of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.equal(isFourRegistryCapabilityEvent(changed), false);
  }
  const changedToken = structuredClone(tokenEvent);
  changedToken.token.token = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  changedToken.token.address = changedToken.token.token;
  changedToken.tokens[0] = structuredClone(changedToken.token);
  changedToken.canonicalTokenCreatedKey = `fourmeme:openfour-core-token-created:56:${changedToken.transactionHash}:${changedToken.logIndex}:${changedToken.token.address}`;
  assert.equal(isFourRegistryFirstTokenEvent(changedToken), false, "decoded indexed TokenCreated proof binds the CA");
  const changedCapabilityOwner = structuredClone(tokenEvent);
  changedCapabilityOwner.capabilityEventKey = changedCapabilityOwner.capabilityEventKey.replace(/:added$/u, ":activated");
  assert.equal(isFourRegistryFirstTokenEvent(changedCapabilityOwner), false);
});

test("all presets are reconciled with bounded calls so a ninth missing status log cannot advance", async (t) => {
  const presets = Array.from({ length: 10 }, (_, index) => preset(String(1778027616000 + index)));
  presets[8] = preset(presets[8].id, { active: false, createEnabled: true });
  const enabled = preset(presets[8].id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, presets);
  let activeCalls = 0;
  let maxCalls = 0;
  const originalCall = provider.call.bind(provider);
  provider.call = async (...args) => {
    activeCalls += 1;
    maxCalls = Math.max(maxCalls, activeCalls);
    await new Promise((resolve) => setImmediate(resolve));
    try { return await originalCall(...args); }
    finally { activeCalls -= 1; }
  };
  let omitLogs = true;
  const canonicalGetLogs = provider.getLogs.bind(provider);
  const controlledLogs = (filter) => omitLogs ? Promise.resolve([]) : canonicalGetLogs(filter);
  const dependencies = {
    logVerificationProviders: [
      { sourceId: "log-empty-a.test", provider: providerFacade(provider, { getLogs: controlledLogs }) },
      { sourceId: "log-empty-b.test", provider: providerFacade(provider, { getLogs: controlledLogs }) },
    ],
    stateVerificationProviders: [
      { sourceId: "state-empty-a.test", provider: providerFacade(provider, { getLogs: controlledLogs }) },
      { sourceId: "state-empty-b.test", provider: providerFacade(provider, { getLogs: controlledLogs }) },
    ],
  };
  const { monitor } = await fixture(t, provider, { dependencies });
  await monitor.check();
  maxCalls = 0;

  provider.head = 103;
  provider.setSnapshot(101, [...presets.slice(0, 8), enabled, presets[9]]);
  addActiveUpdate(provider, enabled.id, true, 101, 1, 0, txHash("c"));
  addTokenCreated(provider, enabled, { blockNumber: 101, transactionIndex: 2, hash: txHash("d") });
  const failed = await monitor.check();
  assert.equal(failed.status, "degraded");
  assert.equal(failed.errorCode, "FOUR_REGISTRY_LOG_CONSENSUS_INCOMPLETE");
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
  assert.ok(maxCalls <= 8, `two state hosts must stay at <=8 concurrent tuple reads, saw ${maxCalls}`);

  omitLogs = false;
  const replayed = await monitor.check();
  assert.equal(replayed.status, "ok");
  assert.deepEqual(replayed.events.map((event) => event.kind), [
    "four_registry_preset_activated",
    "four_registry_first_token",
  ]);
  assert.equal((await monitor.getState()).cursor.anchorBlock, 101);
});

test("unknown uint8 module kinds and long governance strings remain observable", async (t) => {
  const existing = preset("1778027616101");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor } = await fixture(t, provider);
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  addModuleUpserted(provider, { kind: 6, blockNumber: 101, transactionIndex: 1, hash: txHash("1") });
  addTokenImplUpserted(provider, { version: "v".repeat(400), blockNumber: 101, transactionIndex: 2, hash: txHash("2") });
  addTagRegistered(provider, { tag: "tag-".repeat(300), blockNumber: 101, transactionIndex: 3, hash: txHash("3") });
  const events = (await monitor.check()).events;
  assert.equal(events.length, 3);
  assert.equal(events[0].module.kind, 6);
  assert.equal(events[0].module.kindName, "unknown_numeric_kind");
  assert.equal(events[1].tokenImplementation.version.length, 80);
  assert.equal(events[1].tokenImplementation.versionProof.truncated, true);
  assert.equal(events[2].tag.tag.length, 256);
  assert.equal(events[2].tag.tagProof.truncated, true);
  assert.ok(events.every((event) => isFourRegistryCapabilityEvent(event)));
});

test("an unrelated oversized TokenCreated with unavailable history cannot block Registry governance", async (t) => {
  const existing = preset("1778027616201");
  const unrelated = preset("1778027616299");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor } = await fixture(t, provider);
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  const unavailableHash = txHash("4");
  addTokenCreated(provider, unrelated, {
    blockNumber: 101,
    transactionIndex: 1,
    hash: unavailableHash,
    name: "N".repeat(2_000),
    symbol: "S".repeat(500),
    tokenMetaUri: `ipfs://${"u".repeat(10_000)}`,
  });
  provider.receipts.delete(unavailableHash);
  provider.transactions.delete(unavailableHash);
  addTagRegistered(provider, { blockNumber: 101, transactionIndex: 2, hash: txHash("5") });
  const result = await monitor.check();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.events.map((event) => event.kind), ["four_registry_tag_registered"]);
});

test("a malformed persisted outbox payload fails closed on restart", async (t) => {
  const existing = preset("1778027616301");
  const added = preset("1778027616302");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const { monitor, dataDir } = await fixture(t, provider, { onEvent: false });
  await monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("6"));
  await monitor.check();
  const stateFile = path.join(dataDir, "four-registry-state.json");
  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  raw.outbox[0].event.attackerUrl = "https://evil.invalid";
  await fs.writeFile(stateFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    autoStart: false,
    logger: { error() {} },
  });
  const result = await restarted.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_STATE_INVALID");
});

test("zero confirmations fail fast instead of claiming unconfirmed logs are finalized", () => {
  const provider = new FakeBscProvider();
  assert.throws(() => createFourRegistryMonitor({ fourRegistryConfirmations: 0 }, {
    provider,
    ...verificationDependencies(provider),
  }), (error) => error?.code === "FOUR_REGISTRY_NUMBER_INVALID");
});

test("a fixed log host disagreement fails closed before the cursor advances", async (t) => {
  const existing = preset("1778027616401");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  let disagree = false;
  const canonicalGetLogs = provider.getLogs.bind(provider);
  const dependencies = verificationDependencies(provider);
  dependencies.logVerificationProviders[1] = {
    sourceId: "log-disagrees.test",
    provider: providerFacade(provider, {
      getLogs: (filter) => disagree ? Promise.resolve([]) : canonicalGetLogs(filter),
    }),
  };
  const { monitor } = await fixture(t, provider, { dependencies });
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  addTagRegistered(provider, { blockNumber: 101, hash: txHash("7") });
  disagree = true;
  const result = await monitor.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_LOG_QUERY_FAILED");
  assert.match(result.error, /disagreed across independent RPC hosts/u);
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
});

test("state-only verification hosts are never queried for raw range logs", async (t) => {
  const existing = preset("17780276164015");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  let stateLogQueries = 0;
  const dependencies = verificationDependencies(provider);
  dependencies.stateVerificationProviders[1] = {
    sourceId: "state-no-logs.test",
    provider: providerFacade(provider, {
      getLogs: async () => {
        stateLogQueries += 1;
        throw new Error("state verifier must not query raw logs");
      },
    }),
  };
  const { monitor, delivered } = await fixture(t, provider, { dependencies });
  assert.equal((await monitor.check()).status, "baseline");

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  addTagRegistered(provider, { blockNumber: 101, hash: txHash("7") });
  const result = await monitor.check();

  assert.equal(result.status, "ok");
  assert.deepEqual(result.events.map((event) => event.kind), ["four_registry_tag_registered"]);
  assert.equal(delivered.length, 1);
  assert.equal(stateLogQueries, 0, "raw Registry/Core logs belong only to the dedicated log quorum");
  assert.equal((await monitor.getState()).cursor.anchorBlock, 101);
});

test("a log host whose range-end hash is stale cannot certify an empty or partial range", async (t) => {
  const existing = preset("1778027616402");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  let stale = false;
  const canonicalGetBlock = provider.getBlock.bind(provider);
  const dependencies = verificationDependencies(provider);
  dependencies.logVerificationProviders[0] = {
    sourceId: "log-stale.test",
    provider: providerFacade(provider, {
      getBlock: async (number) => {
        const block = await canonicalGetBlock(number);
        return stale && Number(number) === 101 ? { ...block, hash: `0x${"f".repeat(64)}` } : block;
      },
    }),
  };
  const { monitor } = await fixture(t, provider, { dependencies });
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  stale = true;
  const result = await monitor.check();
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "FOUR_REGISTRY_LOG_QUERY_FAILED");
  assert.match(result.error, /not on the state-quorum range end/u);
  assert.equal((await monitor.getState()).cursor.anchorBlock, 100);
});

test("a shallow reorg recovers from a recent checkpoint without rereading old baseline storage", async (t) => {
  const existing = preset("1778027616501");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  let baselineStorageUnavailable = false;
  const canonicalCall = provider.call.bind(provider);
  provider.call = async (request) => {
    if (baselineStorageUnavailable && request.blockTag === 100) throw new Error("historical state is not available");
    return canonicalCall(request);
  };
  const { monitor } = await fixture(t, provider, { chunkSize: 1 });
  await monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  await monitor.check();
  provider.head = 104;
  provider.setSnapshot(102, [existing]);
  await monitor.check();

  baselineStorageUnavailable = true;
  provider.head = 105;
  provider.setBlockHash(102, `0x${"e".repeat(64)}`);
  const result = await monitor.check();
  assert.equal(result.status, "recovered_reorg");
  assert.equal(result.finalizedBlock.number, 101);
  assert.equal(result.resumeFromBlock, 102);
  assert.equal((await monitor.getState()).cursor.anchorBlock, 101);
});

test("a deep post-baseline fork replays its true first token with delayed recovery instead of a silent rebaseline", async (t) => {
  const existing = preset("1778027616601");
  const added = preset("1778027616602");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const nowMs = Date.parse("2026-09-04T10:00:00.000Z");
  const { monitor, delivered } = await fixture(t, provider, { chunkSize: 10, now: () => nowMs });
  await monitor.check();

  provider.head = 172;
  for (let index = 0; index < 7; index += 1) await monitor.check();
  assert.equal((await monitor.getState()).cursor.anchorBlock, 170);
  for (const block of [110, 120, 130, 140, 150, 160, 170]) {
    provider.setBlockHash(block, `0x${(block / 10).toString(16).padStart(64, "a").slice(-64)}`);
  }
  provider.setBlockHash(101, `0x${"d".repeat(64)}`);
  provider.setSnapshot(101, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("8"));
  addTokenCreated(provider, added, { blockNumber: 101, transactionIndex: 2, hash: txHash("9") });

  const recovered = await monitor.check();
  assert.equal(recovered.status, "recovered_reorg");
  assert.equal(recovered.finalizedBlock.number, 100);
  assert.equal(recovered.resumeFromBlock, 101);
  assert.equal((await monitor.getState()).tokenBackfillSuppressedThroughBlock, 100);
  const replayed = await monitor.check();
  assert.deepEqual(replayed.events.map((event) => event.kind), [
    "four_registry_preset_added",
    "four_registry_first_token",
  ]);
  assert.equal(delivered.length, 2);
  assert.ok(replayed.events.every((event) => event.deliveryPolicy.tier === "T2"));
  assert.ok(replayed.events.every((event) => event.delayedRecovery?.continuousCoverage === true));
  assert.equal(replayed.events[1].delayedRecovery.scanFromBlock, 101);
  assert.equal(replayed.events[1].delayedRecovery.scanThroughBlock, 110);
});

test("stop waits for an in-flight durable delivery before returning", async (t) => {
  const existing = preset("1778027616701");
  const added = preset("1778027616702");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const { monitor } = await fixture(t, provider, {
    onEvent: async (event) => {
      entered();
      await releasePromise;
      return { status: "queued", eventId: event.eventKey, persisted: true };
    },
  });
  await monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("a"));
  const active = monitor.check();
  await enteredPromise;
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await Promise.all([active, stopping]);
  assert.equal(stopped, true);
  assert.equal((await monitor.check()).status, "stopped");
});

test("a delayed first-token lifecycle survives freshness suppression and restart without reordering", async (t) => {
  const existing = preset("1778027616801");
  const added = preset("1778027616802");
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  provider.setBlockTimestamp(101, Date.parse("2026-09-04T06:00:00.000Z") / 1_000);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-delayed-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const attempts = [];
  const first = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    now: () => Date.parse("2026-09-04T08:00:00.000Z"),
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      attempts.push(event.eventKey);
      return { status: "suppressed", reason: "freshness_too_old", eventId: event.eventKey, persisted: true, terminal: true };
    },
    logger: { error() {} },
  });
  await first.check();
  provider.head = 103;
  provider.setSnapshot(101, [existing, added]);
  addUpsert(provider, added, 101, 1, 0, txHash("b"));
  addTokenCreated(provider, added, { blockNumber: 101, transactionIndex: 2, hash: txHash("c") });
  await first.check();
  const durable = await first.getState();
  assert.equal(durable.outbox.length, 2);
  assert.equal(attempts.length, 1);
  assert.ok(durable.outbox.every((entry) => entry.event.delayedRecovery?.continuousCoverage === true));

  const accepted = [];
  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2 }, {
    provider,
    ...verificationDependencies(provider),
    now: () => Date.parse("2026-09-04T08:30:00.000Z"),
    cancelPendingEvent: supersedeCancellation,
    onEvent: async (event) => {
      accepted.push(event.eventKey);
      return { status: "queued", eventId: event.eventKey, persisted: true };
    },
    logger: { error() {} },
  });
  const result = await restarted.check();
  assert.equal(result.status, "ok");
  assert.deepEqual(accepted, durable.outbox.map((entry) => entry.eventKey));
  assert.equal((await restarted.getState()).outbox.length, 0);
});

test("the actual createRpcPool facade routes Registry historical proofs and calls to archive providers", async (t) => {
  const existing = preset("1778027616901");
  const added = preset("1778027616902");
  const backing = new FakeBscProvider({ head: 102 });
  backing.setSnapshot(100, [existing]);
  const standardHistorical = [];
  const archiveMethods = [];
  const pools = Array.from({ length: 4 }, (_, poolIndex) => createRpcPool(
    [`https://standard-${poolIndex}.test`],
    [`https://archive-${poolIndex}.test`],
    1,
    {
      providerFactory: (_url, context) => ({
        async getNetwork() { return backing.getNetwork(); },
        async getBlockNumber() { return backing.getBlockNumber(); },
        async send(method, params) {
          if (context.kind === "standard" && method === "eth_chainId") return backing.send(method, params);
          if (context.kind !== "archive" || method !== "eth_getLogs") {
            standardHistorical.push(`${context.kind}:send:${method}`);
            throw new Error("historical/log access is archive-only in this fixture");
          }
          archiveMethods.push("eth_getLogs");
          const [filter] = params;
          const logs = await backing.getLogs({
            ...filter,
            fromBlock: Number.parseInt(filter.fromBlock.slice(2), 16),
            toBlock: Number.parseInt(filter.toBlock.slice(2), 16),
          });
          return logs.map((log) => ({
            ...log,
            blockNumber: `0x${log.blockNumber.toString(16)}`,
            transactionIndex: `0x${log.transactionIndex.toString(16)}`,
            logIndex: `0x${log.index.toString(16)}`,
            index: undefined,
          }));
        },
        async getBlock(number) {
          if (context.kind !== "archive") {
            standardHistorical.push("getBlock");
            throw new Error("standard historical block unavailable");
          }
          archiveMethods.push("getBlock");
          return backing.getBlock(number);
        },
        async getTransaction(hash) {
          if (context.kind !== "archive") {
            standardHistorical.push("getTransaction");
            throw new Error("standard historical transaction unavailable");
          }
          archiveMethods.push("getTransaction");
          return backing.getTransaction(hash);
        },
        async getTransactionReceipt(hash) {
          if (context.kind !== "archive") {
            standardHistorical.push("getTransactionReceipt");
            throw new Error("standard historical receipt unavailable");
          }
          archiveMethods.push("getTransactionReceipt");
          return backing.getTransactionReceipt(hash);
        },
        async getCode(addressValue, blockTag) {
          if (context.kind !== "archive") {
            standardHistorical.push("getCode");
            throw new Error("standard historical code unavailable");
          }
          archiveMethods.push("getCode");
          return backing.getCode(addressValue, blockTag);
        },
        async call(request) {
          if (context.kind !== "archive") {
            standardHistorical.push("call");
            throw new Error("standard historical state unavailable");
          }
          archiveMethods.push("call");
          return backing.call(request);
        },
        destroy() {},
      }),
      requestTimeoutMs: 2_000,
    },
  ));
  t.after(() => pools.forEach((pool) => pool.destroy()));
  const dependencies = {
    logVerificationProviders: [
      { sourceId: "log-pool-a.test", provider: pools[0] },
      { sourceId: "log-pool-b.test", provider: pools[1] },
    ],
    stateVerificationProviders: [
      { sourceId: "state-pool-a.test", provider: pools[2] },
      { sourceId: "state-pool-b.test", provider: pools[3] },
    ],
  };
  const { monitor } = await fixture(t, backing, { dependencies });
  assert.equal((await monitor.check()).status, "baseline");

  backing.head = 103;
  backing.setSnapshot(101, [existing, added]);
  addUpsert(backing, added, 101, 1, 0, txHash("d"));
  const result = await monitor.check();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.events.map((event) => event.kind), ["four_registry_preset_added"]);
  assert.deepEqual(standardHistorical, []);
  assert.ok(archiveMethods.includes("eth_getLogs"));
  assert.ok(archiveMethods.includes("getBlock"));
  assert.ok(archiveMethods.includes("getTransaction"));
  assert.ok(archiveMethods.includes("getTransactionReceipt"));
  assert.ok(archiveMethods.includes("call"));
});

test("only the exact same-hash historical-state race gets the bounded 50/100ms retry", async () => {
  const provider = new FakeBscProvider();
  provider.setSnapshot(100, [preset("1778027617001")]);
  const canonicalCall = provider.call.bind(provider);
  const unavailableHash = blockHash(100);
  let transientAttempts = 0;
  provider.call = async (request) => {
    const parsed = String(request.to).toLowerCase() === FOUR_REGISTRY_ADDRESS
      ? FOUR_REGISTRY_INTERFACE.parseTransaction({ data: request.data })
      : null;
    if (parsed?.name === "getPresetIds" && transientAttempts < 2) {
      transientAttempts += 1;
      const outer = new Error("CALL_EXCEPTION");
      outer.info = { error: { code: -32000, message: `historical state ${unavailableHash} is not available` } };
      throw outer;
    }
    return canonicalCall(request);
  };
  const inventory = await readFourRegistryInventory(provider, 100);
  assert.deepEqual(Object.keys(inventory), ["1778027617001"]);
  assert.equal(transientAttempts, 2);

  let genericAttempts = 0;
  provider.call = async () => {
    genericAttempts += 1;
    const error = new Error("HTTP 429");
    error.code = "SERVER_ERROR";
    throw error;
  };
  await assert.rejects(
    readFourRegistryInventory(provider, 100),
    (error) => error?.code === "FOUR_REGISTRY_CALL_FAILED",
  );
  assert.equal(genericAttempts, 1, "rate limits and generic failures must freeze immediately");
});

test("checkpointed pending state survives replacement of a consumed old-fork first token", async (t) => {
  const id = "1778027617101";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const { monitor, delivered } = await fixture(t, provider, { chunkSize: 1 });
  await monitor.check();

  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, txHash("1"));
  await monitor.check();
  const armed = await monitor.getState();
  assert.equal(armed.pendingConfirmations[id]?.armedAt.blockNumber, 101);
  assert.equal(armed.checkpoints.at(-1).pendingConfirmations[id]?.armedAt.blockNumber, 101);

  provider.head = 104;
  provider.setSnapshot(102, [enabled]);
  const oldHash = txHash("2");
  addTokenCreated(provider, enabled, { blockNumber: 102, transactionIndex: 1, hash: oldHash });
  await monitor.check();
  assert.equal((await monitor.getState()).pendingConfirmations[id], undefined);

  provider.logs = provider.logs.filter((log) => log.transactionHash !== oldHash);
  provider.receipts.delete(oldHash);
  provider.transactions.delete(oldHash);
  provider.setBlockHash(102, `0x${"e".repeat(64)}`);
  const newHash = txHash("3");
  addTokenCreated(provider, enabled, { blockNumber: 102, transactionIndex: 1, hash: newHash, token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const recovered = await monitor.check();
  assert.equal(recovered.status, "recovered_reorg");
  assert.equal((await monitor.getState()).pendingConfirmations[id]?.armedAt.blockNumber, 101);
  const replayed = await monitor.check();
  assert.deepEqual(replayed.events.map((event) => event.kind), ["four_registry_first_token"]);
  assert.equal(replayed.events[0].token.address, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(delivered.filter((event) => event.kind === "four_registry_first_token").length, 2);
});

test("checkpointed pending state is restored when an old-fork disable disappears", async (t) => {
  const id = "1778027617102";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const { monitor } = await fixture(t, provider, { chunkSize: 1 });
  await monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, txHash("4"));
  await monitor.check();

  provider.head = 104;
  const oldDisabled = preset(id, { active: false, createEnabled: true });
  provider.setSnapshot(102, [oldDisabled]);
  const disableHash = txHash("5");
  addActiveUpdate(provider, id, false, 102, 1, 0, disableHash);
  await monitor.check();
  assert.equal((await monitor.getState()).pendingConfirmations[id], undefined);

  provider.logs = provider.logs.filter((log) => log.transactionHash !== disableHash);
  provider.receipts.delete(disableHash);
  provider.transactions.delete(disableHash);
  provider.setBlockHash(102, `0x${"d".repeat(64)}`);
  provider.setSnapshot(102, [enabled]);
  addTokenCreated(provider, enabled, { blockNumber: 102, transactionIndex: 1, hash: txHash("6") });
  assert.equal((await monitor.check()).status, "recovered_reorg");
  assert.equal((await monitor.getState()).pendingConfirmations[id]?.armedAt.blockNumber, 101);
  const replayed = await monitor.check();
  assert.deepEqual(replayed.events.map((event) => event.kind), ["four_registry_first_token"]);
});

test("same tx and log re-included under new canonical hashes emits unique capability and first-token revisions", async (t) => {
  const id = "1778027617201";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const { monitor, dataDir, delivered } = await fixture(t, provider, { chunkSize: 1 });
  await monitor.check();

  const capabilityTx = txHash("7");
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, capabilityTx);
  const originalCapability = (await monitor.check()).events[0];

  const tokenTx = txHash("8");
  provider.head = 104;
  provider.setSnapshot(102, [enabled]);
  addTokenCreated(provider, enabled, { blockNumber: 102, transactionIndex: 1, logIndex: 0, hash: tokenTx });
  const originalToken = (await monitor.check()).events[0];
  assert.equal(delivered.length, 2);

  provider.logs = provider.logs.filter((log) => ![capabilityTx, tokenTx].includes(log.transactionHash));
  provider.receipts.delete(capabilityTx);
  provider.receipts.delete(tokenTx);
  provider.transactions.delete(capabilityTx);
  provider.transactions.delete(tokenTx);
  provider.setBlockHash(101, `0x${"d".repeat(64)}`);
  provider.setBlockHash(102, `0x${"e".repeat(64)}`);
  addActiveUpdate(provider, id, true, 101, 1, 0, capabilityTx);
  addTokenCreated(provider, enabled, { blockNumber: 102, transactionIndex: 1, logIndex: 0, hash: tokenTx });

  const recovered = await monitor.check();
  assert.equal(recovered.status, "recovered_reorg");
  assert.equal(recovered.resumeFromBlock, 101);
  const replayedCapability = (await monitor.check()).events[0];
  const replayedToken = (await monitor.check()).events[0];
  assert.equal(replayedCapability.kind, "four_registry_preset_activated");
  assert.equal(replayedToken.kind, "four_registry_first_token");
  for (const [current, original] of [
    [replayedCapability, originalCapability],
    [replayedToken, originalToken],
  ]) {
    assert.equal(
      current.eventKey,
      `${current.canonicalRevision.baseEventKey}:canonical-revision:${current.blockHash}:${current.canonicalRevision.recoveryEpoch}`,
    );
    assert.equal(current.canonicalRevision.replacesEventKey, original.eventKey);
    assert.equal(current.canonicalRevision.replacesBaseEventKey, original.eventKey);
    assert.equal(current.canonicalRevision.replacesBlockHash, original.blockHash);
    assert.equal(current.canonicalRevision.replacesPayloadDigest, original.payloadDigest);
    assert.equal(current.canonicalRevision.newBlockHash, current.blockHash);
    assert.equal(current.deliveryPolicy.tier, "T2");
  }
  assert.equal(isFourRegistryCapabilityEvent(replayedCapability), true);
  assert.equal(isFourRegistryFirstTokenEvent(replayedToken), true);
  const forgedCapabilityEpoch = structuredClone(replayedCapability);
  forgedCapabilityEpoch.canonicalRevision.recoveryEpoch += 1;
  assert.equal(isFourRegistryCapabilityEvent(forgedCapabilityEpoch), false);
  const forgedTokenEpoch = structuredClone(replayedToken);
  forgedTokenEpoch.canonicalRevision.recoveryEpoch += 1;
  assert.equal(isFourRegistryFirstTokenEvent(forgedTokenEpoch), false);
  assert.equal(new Set(delivered.map((event) => event.eventKey)).size, 4);

  const restarted = createFourRegistryMonitor({ dataDir, fourRegistryConfirmations: 2, fourRegistryLogChunkSize: 1 }, {
    provider,
    ...verificationDependencies(provider),
    onEvent: async (event) => ({ status: "delivered", eventId: event.eventKey, persisted: true }),
    cancelPendingEvent: supersedeCancellation,
    logger: { error() {} },
  });
  assert.equal((await restarted.check()).status, "ok", "revision owners and processed payloads survive restart validation");
});

test("a queued old-fork proof is atomically superseded by the different current proof without a revision card", async (t) => {
  const id = "1778027617202";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const attempts = [];
  const cancellations = [];
  const { monitor } = await fixture(t, provider, {
    chunkSize: 1,
    onEvent: async (event) => {
      attempts.push(structuredClone(event));
      return { status: "queued", eventId: event.eventKey, persisted: true };
    },
    cancelPendingEvent: async (request) => {
      cancellations.push(structuredClone(request));
      return supersedeCancellation(request);
    },
  });
  await monitor.check();
  const hash = txHash("9");
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  const original = (await monitor.check()).events[0];

  provider.logs = provider.logs.filter((log) => log.transactionHash !== hash);
  provider.receipts.delete(hash);
  provider.transactions.delete(hash);
  provider.setBlockHash(101, `0x${"c".repeat(64)}`);
  addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  assert.equal((await monitor.check()).status, "recovered_reorg");
  const current = (await monitor.check()).events[0];
  assert.equal(current.eventKey, original.eventKey);
  assert.equal(current.canonicalRevision, undefined);
  assert.equal(current.canonicalSupersession.cancelledEventId, original.eventKey);
  assert.equal(current.canonicalSupersession.cancelledBlockHash, original.blockHash);
  assert.equal(current.canonicalSupersession.newBlockHash, current.blockHash);
  assert.equal(current.deliveryPolicy.tier, "T1");
  assert.equal(isFourRegistryCapabilityEvent(current), true);
  assert.equal(cancellations.length, 1);
  assert.equal(attempts.length, 2);
});

test("a superseded undelivered proof that becomes canonical again emits a closed restoration", async (t) => {
  const id = "1778027617203";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const attempts = [];
  const { monitor } = await fixture(t, provider, {
    chunkSize: 1,
    onEvent: async (event) => {
      attempts.push(structuredClone(event));
      return { status: "queued", eventId: event.eventKey, persisted: true };
    },
    cancelPendingEvent: supersedeCancellation,
  });
  await monitor.check();
  const hash = txHash("a");
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  const original = (await monitor.check()).events[0];

  provider.logs = provider.logs.filter((log) => log.transactionHash !== hash);
  provider.receipts.delete(hash);
  provider.transactions.delete(hash);
  provider.setBlockHash(101, `0x${"b".repeat(64)}`);
  provider.setSnapshot(101, [disabled]);
  assert.equal((await monitor.check()).status, "recovered_reorg");

  provider.setBlockHash(101, original.blockHash);
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  const restored = (await monitor.check()).events[0];
  assert.equal(restored.eventKey, original.eventKey);
  assert.equal(restored.canonicalRestoration.cancelledEventId, original.eventKey);
  assert.equal(restored.canonicalRestoration.blockHash, original.blockHash);
  assert.equal(restored.canonicalRestoration.payloadDigest, original.payloadDigest);
  assert.equal(isFourRegistryCapabilityEvent(restored), true);
  assert.equal(attempts.length, 2);
});

test("an unchanged event above the replay checkpoint is not cancelled or announced twice", async (t) => {
  const id = "1778027617204";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  let cancellations = 0;
  const { monitor, delivered } = await fixture(t, provider, {
    chunkSize: 10,
    cancelPendingEvent: async (request) => {
      cancellations += 1;
      return {
        status: "delivered_orphaned",
        reason: "canonical_reorg",
        persisted: true,
        terminal: true,
        eventId: request.eventId,
        deliveredAt: "2026-09-04T08:00:00.000Z",
      };
    },
  });
  await monitor.check();
  provider.head = 112;
  provider.setSnapshot(110, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, txHash("b"));
  assert.equal((await monitor.check()).events.length, 1);
  assert.equal(delivered.length, 1);

  provider.setBlockHash(110, `0x${"f".repeat(64)}`);
  assert.equal((await monitor.check()).status, "recovered_reorg");
  const replayed = await monitor.check();
  assert.deepEqual(replayed.events, []);
  assert.equal(cancellations, 0, "the unchanged event proof is not cancelled merely because replay starts earlier");
  assert.equal(delivered.length, 1);
  assert.equal((await monitor.getState()).cursor.anchorBlock, 110);
});

test("a retained unchanged owner is cancelled if a second fork changes its block before replay", async (t) => {
  const id = "1778027617205";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  let cancellations = 0;
  const { monitor, delivered } = await fixture(t, provider, {
    chunkSize: 10,
    now: () => now.value,
    cancelPendingEvent: async (request) => {
      cancellations += 1;
      return {
        status: "delivered_orphaned",
        reason: "canonical_reorg",
        persisted: true,
        terminal: true,
        eventId: request.eventId,
        deliveredAt: "2026-09-04T08:00:00.000Z",
      };
    },
  });
  await monitor.check();
  const hash = txHash("c");
  provider.head = 112;
  provider.setSnapshot(110, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  const original = (await monitor.check()).events[0];

  now.value = Date.parse("2026-09-04T08:01:00.000Z");
  provider.setBlockHash(110, `0x${"e".repeat(64)}`);
  assert.equal((await monitor.check()).status, "recovered_reorg");
  assert.equal(cancellations, 0, "the first rollback retains the still-canonical event proof");

  provider.logs = provider.logs.filter((log) => log.transactionHash !== hash);
  provider.receipts.delete(hash);
  provider.transactions.delete(hash);
  provider.setBlockHash(101, `0x${"d".repeat(64)}`);
  addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  now.value = Date.parse("2026-09-04T09:00:00.000Z");
  const replayed = await monitor.check();
  assert.equal(cancellations, 1, "pre-replay quorum detects and cancels the now-orphaned owner");
  assert.equal(replayed.events.length, 1);
  assert.equal(replayed.events[0].canonicalRevision.replacesEventKey, original.eventKey);
  assert.equal(replayed.events[0].canonicalRevision.newBlockHash, `0x${"d".repeat(64)}`);
  assert.equal(replayed.events[0].canonicalRevision.recoveryDetectedAt, "2026-09-04T09:00:00.000Z");
  assert.equal(replayed.events[0].canonicalRevision.recoveryOldAnchorBlock, 101);
  assert.equal(replayed.events[0].canonicalRevision.recoveryOldAnchorBlockHash, original.blockHash);
  assert.equal(replayed.events[0].canonicalRevision.recoveryObservedAnchorBlockHash, `0x${"d".repeat(64)}`);
  assert.equal(delivered.length, 2);
});

test("an unchanged queued capability and its pending arm survive replay gaps and still capture the first token", async (t) => {
  const id = "1778027617207";
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, []);
  const attempts = [];
  let cancellations = 0;
  const { monitor, dataDir } = await fixture(t, provider, {
    chunkSize: 10,
    onEvent: async (event) => {
      attempts.push(structuredClone(event));
      return { status: "queued", eventId: event.eventKey, persisted: true };
    },
    cancelPendingEvent: async (request) => {
      cancellations += 1;
      return supersedeCancellation(request);
    },
  });
  await monitor.check();
  const capabilityTx = txHash("1");
  provider.head = 112;
  provider.setSnapshot(101, [enabled]);
  provider.setSnapshot(110, [enabled]);
  addUpsert(provider, enabled, 101, 1, 0, capabilityTx);
  const capability = (await monitor.check()).events[0];
  assert.equal((await monitor.getState()).pendingConfirmations[id].capabilityEventKey, capability.eventKey);

  provider.setBlockHash(110, `0x${"b".repeat(64)}`);
  assert.equal((await monitor.check()).status, "recovered_reorg");
  let recoveredState = await monitor.getState();
  assert.equal(recoveredState.cursor.anchorBlock, 100);
  assert.equal(recoveredState.processedEvents[capability.eventKey].deliveryStatus, "queued");
  assert.equal(recoveredState.pendingConfirmations[id].capabilityEventKey, capability.eventKey);
  assert.equal(cancellations, 0);

  const restarted = createFourRegistryMonitor({
    dataDir,
    fourRegistryConfirmations: 2,
    fourRegistryLogChunkSize: 10,
  }, {
    provider,
    ...verificationDependencies(provider),
    onEvent: async (event) => {
      attempts.push(structuredClone(event));
      return { status: "queued", eventId: event.eventKey, persisted: true };
    },
    cancelPendingEvent: async (request) => {
      cancellations += 1;
      return supersedeCancellation(request);
    },
    logger: { error() {} },
  });
  recoveredState = await restarted.getState();
  assert.equal(recoveredState.pendingConfirmations[id].capabilityEventKey, capability.eventKey);

  provider.logs = provider.logs.filter((log) => log.transactionHash !== capabilityTx);
  provider.receipts.delete(capabilityTx);
  provider.transactions.delete(capabilityTx);
  const incomplete = await restarted.check();
  assert.equal(incomplete.status, "degraded");
  assert.equal(incomplete.errorCode, "FOUR_REGISTRY_LOG_CONSENSUS_INCOMPLETE");
  recoveredState = await restarted.getState();
  assert.equal(recoveredState.cursor.anchorBlock, 100, "a replay index gap cannot consume the retained proof or arm");
  assert.equal(recoveredState.pendingConfirmations[id].capabilityEventKey, capability.eventKey);

  addUpsert(provider, enabled, 101, 1, 0, capabilityTx);
  assert.deepEqual((await restarted.check()).events, []);
  provider.head = 113;
  provider.setSnapshot(111, [enabled]);
  addTokenCreated(provider, enabled, { blockNumber: 111, transactionIndex: 1, hash: txHash("2") });
  const tokenResult = await restarted.check();
  assert.deepEqual(tokenResult.events.map((event) => event.kind), ["four_registry_first_token"]);
  assert.equal(tokenResult.events[0].capabilityEventKey, capability.eventKey);
  assert.equal(attempts.filter((event) => event.eventKey === capability.eventKey).length, 1);
  assert.equal(cancellations, 0);
});

test("position and block-hash owner history gives every A-B-A-B transition one stable correction", async (t) => {
  const id = "1778027617206";
  const disabled = preset(id, { active: false, createEnabled: true });
  const enabled = preset(id, { active: true, createEnabled: true });
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const { monitor, dataDir, delivered } = await fixture(t, provider, { chunkSize: 1 });
  await monitor.check();
  const hash = txHash("d");
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  const branchA = (await monitor.check()).events[0];

  const replaceBranch = (nextBlockHash) => {
    provider.logs = provider.logs.filter((log) => log.transactionHash !== hash);
    provider.receipts.delete(hash);
    provider.transactions.delete(hash);
    provider.setBlockHash(101, nextBlockHash);
    addActiveUpdate(provider, id, true, 101, 1, 0, hash);
  };
  const branchBHash = `0x${"e".repeat(64)}`;
  replaceBranch(branchBHash);
  assert.equal((await monitor.check()).status, "recovered_reorg");
  const branchB = (await monitor.check()).events[0];
  assert.equal(
    branchB.eventKey,
    `${branchB.canonicalRevision.baseEventKey}:canonical-revision:${branchBHash}:${branchB.canonicalRevision.recoveryEpoch}`,
  );

  replaceBranch(branchA.blockHash);
  assert.equal((await monitor.check()).status, "recovered_reorg");
  const branchASecond = (await monitor.check()).events[0];
  assert.equal(branchASecond.canonicalRevision.newBlockHash, branchA.blockHash);
  assert.equal(branchASecond.canonicalRevision.replacesEventKey, branchB.eventKey);
  assert.equal(branchASecond.canonicalRevision.recoveryEpoch, branchB.canonicalRevision.recoveryEpoch + 1);

  replaceBranch(branchBHash);
  assert.equal((await monitor.check()).status, "recovered_reorg");
  const branchBSecond = (await monitor.check()).events[0];
  assert.equal(branchBSecond.canonicalRevision.newBlockHash, branchBHash);
  assert.equal(branchBSecond.canonicalRevision.replacesEventKey, branchASecond.eventKey);
  assert.equal(branchBSecond.canonicalRevision.recoveryEpoch, branchASecond.canonicalRevision.recoveryEpoch + 1);
  assert.equal(delivered.length, 4);
  assert.equal(new Set(delivered.map((event) => event.eventKey)).size, 4);

  const restarted = createFourRegistryMonitor({
    dataDir,
    fourRegistryConfirmations: 2,
    fourRegistryLogChunkSize: 1,
  }, {
    provider,
    ...verificationDependencies(provider),
    onEvent: async (event) => ({ status: "delivered", eventId: event.eventKey, persisted: true }),
    cancelPendingEvent: supersedeCancellation,
    logger: { error() {} },
  });
  assert.equal((await restarted.check()).status, "ok", "multi-hash owner history survives strict restart validation");
});

test("a delivered canonical position may change governance kind and payload on the replacement fork", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  provider.setSnapshot(100, []);
  const { monitor } = await fixture(t, provider, { chunkSize: 1 });
  await monitor.check();
  const hash = txHash("f");
  provider.head = 103;
  provider.setSnapshot(101, []);
  addTagRegistered(provider, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash });
  const oldTag = (await monitor.check()).events[0];

  provider.logs = provider.logs.filter((log) => log.transactionHash !== hash);
  provider.receipts.delete(hash);
  provider.transactions.delete(hash);
  provider.setBlockHash(101, `0x${"a".repeat(64)}`);
  addModuleUpserted(provider, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash });
  assert.equal((await monitor.check()).status, "recovered_reorg");
  const currentModule = (await monitor.check()).events[0];
  assert.equal(currentModule.kind, "four_registry_module_upserted");
  assert.notEqual(currentModule.canonicalRevision.baseEventKey, oldTag.eventKey);
  assert.equal(currentModule.canonicalRevision.replacesEventKey, oldTag.eventKey);
  assert.equal(currentModule.canonicalRevision.transactionHash, hash);
  assert.equal(currentModule.canonicalRevision.logIndex, 0);
  assert.equal(currentModule.deliveryPolicy.tier, "T2");
  assert.equal(isFourRegistryProtocolCapabilityEvent(currentModule), true);
});
