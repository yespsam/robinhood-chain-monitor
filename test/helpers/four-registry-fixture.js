import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FOUR_CORE_ADDRESS,
  FOUR_CORE_INTERFACE,
  FOUR_REGISTRY_ADDRESS,
  FOUR_REGISTRY_INTERFACE,
  createFourRegistryMonitor,
} from "../../src/four-registry-monitor.js";

export const FOUR_REGISTRY_FIXTURE_CREATOR = "0x1111111111111111111111111111111111111111";
export const FOUR_REGISTRY_FIXTURE_TOKEN = "0x2222222222222222222222222222222222222222";
const VALIDATOR = "0x3333333333333333333333333333333333333333";
const AUTHOR = "0x4444444444444444444444444444444444444444";
const MODULE_ADDRESSES = ["5", "6", "7", "8", "9", "a", "b"].map((digit) => `0x${digit.repeat(40)}`);

export function fourRegistryBlockHash(number) {
  return `0x${BigInt(number).toString(16).padStart(64, "0")}`;
}

export function fourRegistryTxHash(digit) {
  return `0x${digit.repeat(64)}`;
}

export function fourRegistryBytes32(digit) {
  return `0x${digit.repeat(64)}`;
}

export function fourRegistryPreset(id, overrides = {}) {
  return {
    id: String(id),
    name: `Preset ${id}`,
    description: `Official preset ${id}`,
    version: "1.0.0",
    active: true,
    createEnabled: true,
    validator: VALIDATOR,
    tokenModuleId: fourRegistryBytes32("1"),
    vaultModuleId: fourRegistryBytes32("2"),
    curveModuleId: fourRegistryBytes32("3"),
    tradeModuleId: fourRegistryBytes32("4"),
    migrateModuleId: fourRegistryBytes32("5"),
    tokenImplId: fourRegistryBytes32("6"),
    customDataId: fourRegistryBytes32("0"),
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

export class FourRegistryFakeProvider {
  constructor({ head = 102, chainId = 56 } = {}) {
    this.head = head;
    this.chainId = chainId;
    this.snapshots = new Map();
    this.logs = [];
    this.receipts = new Map();
    this.transactions = new Map();
    this.blockHashOverrides = new Map();
    this.blockTimestampOverrides = new Map();
  }

  setSnapshot(blockNumber, presets) {
    this.snapshots.set(Number(blockNumber), Object.fromEntries(
      presets.map((item) => [String(item.id), structuredClone(item)]),
    ));
  }

  snapshotAt(blockNumber) {
    const eligible = [...this.snapshots.keys()]
      .filter((number) => number <= Number(blockNumber))
      .sort((left, right) => right - left);
    return eligible.length ? this.snapshots.get(eligible[0]) : {};
  }

  block(number) {
    const value = Number(number);
    return {
      number: value,
      hash: this.blockHashOverrides.get(value) || fourRegistryBlockHash(value),
      timestamp: this.blockTimestampOverrides.get(value) ?? (1_788_508_600 + value),
    };
  }

  setBlockTimestamp(number, timestamp) {
    this.blockTimestampOverrides.set(Number(number), Number(timestamp));
  }

  setBlockHash(number, hash) {
    this.blockHashOverrides.set(Number(number), String(hash).toLowerCase());
  }

  async getNetwork() { return { chainId: BigInt(this.chainId) }; }
  async send(method) {
    if (method !== "eth_chainId") throw new Error(`unexpected RPC method ${method}`);
    return `0x${this.chainId.toString(16)}`;
  }
  async getBlockNumber() { return this.head; }
  async getBlock(number) { return this.block(number); }
  async getCode() { return "0x6000600055"; }

  async call(request) {
    if (!Number.isSafeInteger(request.blockTag)) throw new Error("all Registry reads need an exact blockTag");
    const target = String(request.to).toLowerCase();
    if (target === FOUR_CORE_ADDRESS) {
      const parsed = FOUR_CORE_INTERFACE.parseTransaction({ data: request.data });
      if (parsed.name !== "registry") throw new Error(`unexpected Core call ${parsed.name}`);
      return FOUR_CORE_INTERFACE.encodeFunctionResult("registry", [FOUR_REGISTRY_ADDRESS]);
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

  async getLogs(filter) {
    const allowed = Array.isArray(filter.topics?.[0]) ? filter.topics[0] : [filter.topics?.[0]];
    return this.logs.filter((log) => String(log.address).toLowerCase() === String(filter.address).toLowerCase()
      && log.blockNumber >= filter.fromBlock
      && log.blockNumber <= filter.toBlock
      && allowed.map((topic) => String(topic).toLowerCase()).includes(String(log.topics[0]).toLowerCase()));
  }

  async getTransactionReceipt(hash) { return this.receipts.get(String(hash).toLowerCase()) || null; }
  async getTransaction(hash) { return this.transactions.get(String(hash).toLowerCase()) || null; }

  addLog({ address, encoded, blockNumber, transactionIndex, logIndex, transactionHash }) {
    const hash = String(transactionHash).toLowerCase();
    const target = String(address).toLowerCase();
    const log = {
      address: target,
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
      to: target,
      blockNumber,
      blockHash: log.blockHash,
      transactionHash: hash,
      transactionIndex,
      logs: [structuredClone(log)],
    });
    this.transactions.set(hash, {
      hash,
      to: target,
      blockNumber,
      blockHash: log.blockHash,
      transactionIndex,
    });
    return log;
  }
}

function forwardingProvider(provider) {
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function fourRegistryVerificationDependencies(provider) {
  return {
    logVerificationProviders: [
      { sourceId: "fixture-log-a.test", provider: forwardingProvider(provider) },
      { sourceId: "fixture-log-b.test", provider: forwardingProvider(provider) },
    ],
    stateVerificationProviders: [
      { sourceId: "fixture-state-a.test", provider: forwardingProvider(provider) },
      { sourceId: "fixture-state-b.test", provider: forwardingProvider(provider) },
    ],
  };
}

export function addFourRegistryPresetUpsert(provider, record, {
  blockNumber = 101,
  transactionIndex = 1,
  logIndex = 0,
  hash = fourRegistryTxHash("a"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("PresetUpserted"),
    [record.id, record.active, record.createEnabled],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

export function addFourRegistryActiveUpdate(provider, record, {
  blockNumber = 101,
  transactionIndex = 1,
  logIndex = 0,
  hash = fourRegistryTxHash("b"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("PresetActiveUpdated"),
    [record.id, record.active],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

export function addFourRegistryCreateEnabledUpdate(provider, record, {
  blockNumber = 101,
  transactionIndex = 1,
  logIndex = 0,
  hash = fourRegistryTxHash("e"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("PresetCreateEnabledUpdated"),
    [record.id, record.createEnabled],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

export function addFourRegistryModule(provider, {
  moduleKey = fourRegistryBytes32("7"),
  beacon = "0x5555555555555555555555555555555555555555",
  implementation = "0x6666666666666666666666666666666666666666",
  kind = 2,
  active = true,
  blockNumber = 101,
  transactionIndex = 1,
  logIndex = 0,
  hash = fourRegistryTxHash("1"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("ModuleUpserted"),
    [moduleKey, beacon, implementation, kind, active],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

export function addFourRegistryTokenImpl(provider, {
  tokenImplId = fourRegistryBytes32("8"),
  implementation = "0x7777777777777777777777777777777777777777",
  version = "2.0.0",
  blockNumber = 101,
  transactionIndex = 2,
  logIndex = 0,
  hash = fourRegistryTxHash("2"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("TokenImplUpserted"),
    [tokenImplId, implementation, version],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

export function addFourRegistryTag(provider, {
  tagId = "0x1234567890abcdef",
  tag = "module.curve.lista_yield",
  blockNumber = 101,
  transactionIndex = 3,
  logIndex = 0,
  hash = fourRegistryTxHash("3"),
} = {}) {
  const encoded = FOUR_REGISTRY_INTERFACE.encodeEventLog(
    FOUR_REGISTRY_INTERFACE.getEvent("TagRegistered"),
    [tagId, tag],
  );
  return provider.addLog({ address: FOUR_REGISTRY_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

export function addFourRegistryTokenCreated(provider, record, {
  blockNumber = 102,
  transactionIndex = 2,
  logIndex = 0,
  hash = fourRegistryTxHash("c"),
  token = FOUR_REGISTRY_FIXTURE_TOKEN,
  name = "First Confirmed",
  symbol = "FIRST",
  tokenMetaUri = "ipfs://official-meta",
} = {}) {
  const encoded = FOUR_CORE_INTERFACE.encodeEventLog(
    FOUR_CORE_INTERFACE.getEvent("TokenCreated"),
    [
      99n,
      BigInt(record.id),
      FOUR_REGISTRY_FIXTURE_CREATOR,
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
  return provider.addLog({ address: FOUR_CORE_ADDRESS, encoded, blockNumber, transactionIndex, logIndex, transactionHash: hash });
}

export async function createFourRegistryFixture(t, provider, {
  now = () => Date.parse("2026-09-04T08:00:00.000Z"),
  onEvent,
  cancelPendingEvent,
  dataDir: requestedDataDir,
  config = {},
} = {}) {
  const dataDir = requestedDataDir || await fs.mkdtemp(path.join(os.tmpdir(), "four-registry-pipeline-"));
  if (!requestedDataDir) t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const delivered = [];
  const monitor = createFourRegistryMonitor({
    dataDir,
    fourRegistryConfirmations: 2,
    ...config,
  }, {
    autoStart: false,
    provider,
    ...fourRegistryVerificationDependencies(provider),
    now,
    onEvent: onEvent || (async (event) => {
      delivered.push(event);
      return { status: "delivered", eventId: event.eventKey, persisted: true };
    }),
    cancelPendingEvent: cancelPendingEvent || (async (evidence) => ({
      status: "superseded",
      reason: evidence.reason,
      persisted: true,
      terminal: true,
      eventId: evidence.eventId,
    })),
    logger: { error() {} },
  });
  return { monitor, dataDir, delivered };
}

export async function produceFourRegistryPresetAndFirstToken(t, {
  now = () => Date.parse("2026-09-04T08:00:00.000Z"),
  onEvent,
  cancelPendingEvent,
  dataDir,
  capabilityOptions = {},
  tokenOptions = {},
} = {}) {
  const existing = fourRegistryPreset("1778027615723");
  const added = fourRegistryPreset("1778027615732", { name: "Bonding Lista V2 Stake Tax V1" });
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const fixture = await createFourRegistryFixture(t, provider, {
    now,
    onEvent,
    cancelPendingEvent,
    dataDir,
  });
  await fixture.monitor.check();
  provider.head = 104;
  provider.setSnapshot(101, [existing, added]);
  provider.setSnapshot(102, [existing, added]);
  addFourRegistryPresetUpsert(provider, added, capabilityOptions);
  addFourRegistryTokenCreated(provider, added, tokenOptions);
  const result = await fixture.monitor.check();
  return { ...fixture, provider, existing, added, result, events: result.events };
}

export async function produceFourRegistrySameBlockMetadataEvents(t, {
  now = () => Date.parse("2026-09-04T08:00:00.000Z"),
  onEvent,
  cancelPendingEvent,
  dataDir,
} = {}) {
  const id = "1778027615803";
  const previous = fourRegistryPreset(id, {
    name: "Lista Yield V1",
    description: "V1 metadata",
    version: "1.0.0",
    active: false,
    createEnabled: true,
  });
  const blockEnd = fourRegistryPreset(id, {
    name: "Lista Yield V3",
    description: "V3 metadata",
    version: "3.0.0",
    active: true,
    createEnabled: true,
  });
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, [previous]);
  const fixture = await createFourRegistryFixture(t, provider, {
    now,
    onEvent,
    cancelPendingEvent,
    dataDir,
  });
  await fixture.monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [blockEnd]);
  addFourRegistryPresetUpsert(provider, blockEnd, {
    blockNumber: 101,
    transactionIndex: 4,
    hash: fourRegistryTxHash("4"),
  });
  addFourRegistryTokenCreated(provider, blockEnd, {
    blockNumber: 101,
    transactionIndex: 5,
    hash: fourRegistryTxHash("5"),
  });
  addFourRegistryPresetUpsert(provider, blockEnd, {
    blockNumber: 101,
    transactionIndex: 6,
    hash: fourRegistryTxHash("6"),
  });
  const result = await fixture.monitor.check();
  return { ...fixture, provider, previous, blockEnd, result, events: result.events };
}

export async function produceFourRegistryProtocolEvents(t, {
  now = () => Date.parse("2026-09-04T08:00:00.000Z"),
  onEvent,
  cancelPendingEvent,
  dataDir,
} = {}) {
  const existing = fourRegistryPreset("1778027615723");
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, [existing]);
  const fixture = await createFourRegistryFixture(t, provider, {
    now,
    onEvent,
    cancelPendingEvent,
    dataDir,
  });
  await fixture.monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [existing]);
  addFourRegistryModule(provider);
  addFourRegistryTokenImpl(provider);
  addFourRegistryTag(provider);
  const result = await fixture.monitor.check();
  return { ...fixture, provider, existing, result, events: result.events };
}

export async function produceFourRegistryPresetCapability(t, kind, {
  now = () => Date.parse("2026-09-04T08:00:00.000Z"),
  onEvent,
  cancelPendingEvent,
  dataDir,
} = {}) {
  const id = "1778027615732";
  const base = fourRegistryPreset(id, { name: "Lista Yield" });
  let previous = base;
  let current = base;
  let addLog;
  if (kind === "four_registry_preset_added") {
    previous = null;
    addLog = (provider) => addFourRegistryPresetUpsert(provider, current, { hash: fourRegistryTxHash("a") });
  } else if (kind === "four_registry_preset_activated") {
    previous = { ...base, active: false };
    current = { ...base, active: true };
    addLog = (provider) => addFourRegistryActiveUpdate(provider, current, { hash: fourRegistryTxHash("b") });
  } else if (kind === "four_registry_preset_deactivated") {
    previous = { ...base, active: true };
    current = { ...base, active: false };
    addLog = (provider) => addFourRegistryActiveUpdate(provider, current, { hash: fourRegistryTxHash("c") });
  } else if (kind === "four_registry_preset_create_enabled") {
    previous = { ...base, createEnabled: false };
    current = { ...base, createEnabled: true };
    addLog = (provider) => addFourRegistryCreateEnabledUpdate(provider, current, { hash: fourRegistryTxHash("d") });
  } else if (kind === "four_registry_preset_create_disabled") {
    previous = { ...base, createEnabled: true };
    current = { ...base, createEnabled: false };
    addLog = (provider) => addFourRegistryCreateEnabledUpdate(provider, current, { hash: fourRegistryTxHash("e") });
  } else if (kind === "four_registry_preset_updated") {
    previous = { ...base, name: "Lista Yield V1" };
    current = { ...base, name: "Lista Yield V2" };
    addLog = (provider) => addFourRegistryPresetUpsert(provider, current, { hash: fourRegistryTxHash("f") });
  } else {
    throw new TypeError(`unsupported Registry preset capability kind ${kind}`);
  }
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, previous ? [previous] : []);
  const fixture = await createFourRegistryFixture(t, provider, {
    now,
    onEvent,
    cancelPendingEvent,
    dataDir,
  });
  await fixture.monitor.check();
  provider.head = 103;
  provider.setSnapshot(101, [current]);
  addLog(provider);
  const result = await fixture.monitor.check();
  return { ...fixture, provider, previous, current, result, events: result.events };
}
