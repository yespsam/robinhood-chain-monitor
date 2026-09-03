import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { id, keccak256, zeroPadValue } from "ethers";
import {
  FLAP_BOARD_URL,
  FLAP_DEPLOYED_CONTRACTS_URL,
  FLAP_ERC20_INTERFACE,
  FLAP_MRNAB_ADDRESS,
  FLAP_PORTAL_ADDRESS,
  FLAP_PORTAL_IMPLEMENTATION_SLOT,
  FLAP_PORTAL_RUNTIME_HASH,
  FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
  FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
  FLAP_PORTAL_VERIFIED_VERSION,
  FLAP_PORTAL_INTERFACE,
  FLAP_QUOTE_CHAIN_ID,
  FLAP_QUOTE_CONFIGURATION_SIGNATURE,
  FLAP_QUOTE_CONFIGURATION_TOPIC,
  FLAP_QUOTE_REFERENCE_BLOCK,
  FLAP_QUOTE_REFERENCE_BLOCK_HASH,
  FLAP_QUOTE_REFERENCE_TRANSACTION,
  FLAP_SQQQB_ADDRESS,
  atomicWriteFlapQuoteState,
  createFlapQuoteMonitor,
  decodeFlapQuoteConfigurationLog,
  flapQuoteEventKey,
} from "../src/flap-quote-monitor.js";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";
import { cancelPendingFlapQuoteActivation, drainAlertOutbox, sendAlerts } from "../src/alerts.js";
import { parseDistinctRpcOrigins } from "../src/config.js";
import { isMonitoringSourceEnabled, isStrictFlapPortalQuoteAssetUpdate } from "../src/source-controls.js";

const CONFIRMATIONS = 2;
const PORTAL_CODE = "0x60016000556002600055";
const IMPLEMENTATION = "0x1111111111111111111111111111111111111111";
const IMPLEMENTATION_CODE = "0x60026000556003600055";
const SAFE = "0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2";
const ADMIN = "0x0754Ae4F8F9090A95Fd28B473ba1e66dDcfACEFd";
const MRNAB_LOG_DATA = "0x0000000000000000000000005fd86da9b05abe396fe9d02a4a213a7c0055650300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000000";
const SQQQB_LOG_DATA = "0x00000000000000000000000025e572b466d152604d9e6c3e53b432b97882534200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003800000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000000";

const lower = (value) => String(value).toLowerCase();
const clone = (value) => structuredClone(value);

class FakeBscProvider {
  constructor({ head = 100 } = {}) {
    this.head = head;
    this.chainId = FLAP_QUOTE_CHAIN_ID;
    this.liveChainId = FLAP_QUOTE_CHAIN_ID;
    this.portalCode = PORTAL_CODE;
    this.implementation = IMPLEMENTATION;
    this.implementationCode = IMPLEMENTATION_CODE;
    this.portalVersion = "v5.22.0";
    this.blockHashes = new Map();
    this.blockNumbersByHash = new Map();
    this.blockTimestamps = new Map();
    this.logs = [];
    this.receipts = new Map();
    this.transactions = new Map();
    this.assets = new Map();
    this.configurationHistory = new Map();
    this.getLogsCalls = [];
    this.receiptCalls = 0;
    this.transactionCalls = 0;
    this.callTags = [];
    this.returnLogs = null;
  }

  hash(blockNumber) {
    const hash = this.blockHashes.get(blockNumber) || id(`fake-bsc-block:${blockNumber}`);
    this.blockNumbersByHash.set(lower(hash), Number(blockNumber));
    return hash;
  }

  setBlockHash(blockNumber, hash) {
    this.blockHashes.set(blockNumber, lower(hash));
    this.blockNumbersByHash.set(lower(hash), Number(blockNumber));
  }

  setBlockTimestamp(blockNumber, timestamp) {
    this.blockTimestamps.set(blockNumber, timestamp);
  }

  async getNetwork() {
    return { chainId: BigInt(this.chainId) };
  }

  async send(method, params) {
    if (method === "eth_chainId") {
      assert.deepEqual(params, []);
      return `0x${this.liveChainId.toString(16)}`;
    }
    if (method === "eth_call") {
      assert.equal(params.length, 2);
      let blockTag;
      if (typeof params[1] === "string") {
        blockTag = Number.parseInt(params[1], 16);
      } else {
        assert.equal(params[1]?.requireCanonical, true);
        const expectedHash = lower(params[1]?.blockHash);
        blockTag = this.blockNumbersByHash.get(expectedHash);
        assert.ok(Number.isSafeInteger(blockTag), `unknown EIP-1898 block hash ${expectedHash}`);
      }
      return this.call({ ...params[0], blockTag });
    }
    if (method === "eth_getCode") {
      assert.equal(params.length, 2);
      return this.getCode(params[0], Number.parseInt(params[1], 16));
    }
    assert.equal(method, "eth_getLogs");
    assert.equal(params.length, 1);
    const filter = params[0];
    const logs = await this.getLogs({
      ...filter,
      fromBlock: Number.parseInt(filter.fromBlock, 16),
      toBlock: Number.parseInt(filter.toBlock, 16),
    });
    return logs.map((log) => ({
      ...log,
      blockNumber: `0x${log.blockNumber.toString(16)}`,
      transactionIndex: `0x${log.transactionIndex.toString(16)}`,
      logIndex: `0x${log.index.toString(16)}`,
      index: undefined,
    }));
  }

  async getBlockNumber() {
    return this.head;
  }

  async getBlock(blockNumber) {
    const number = Number(blockNumber);
    return {
      number,
      hash: this.hash(number),
      parentHash: this.hash(number - 1),
      timestamp: this.blockTimestamps.get(number) || 1_788_418_795,
    };
  }

  async getCode(address) {
    const key = lower(address);
    if (key === lower(FLAP_PORTAL_ADDRESS)) return this.portalCode;
    if (key === lower(this.implementation)) return this.implementationCode;
    return this.assets.get(key)?.code || "0x";
  }

  async getStorage(address, slot) {
    assert.equal(lower(address), lower(FLAP_PORTAL_ADDRESS));
    assert.equal(lower(slot), lower(FLAP_PORTAL_IMPLEMENTATION_SLOT));
    return zeroPadValue(this.implementation, 32);
  }

  async call({ to, data, blockTag }) {
    this.callTags.push({ to: lower(to), selector: data.slice(0, 10), blockTag: Number(blockTag) });
    if (lower(to) === lower(FLAP_PORTAL_ADDRESS)) {
      if (data.slice(0, 10) === FLAP_PORTAL_INTERFACE.getFunction("version").selector) {
        return FLAP_PORTAL_INTERFACE.encodeFunctionResult("version", [this.portalVersion]);
      }
      if (data.slice(0, 10) === FLAP_PORTAL_INTERFACE.getFunction("getQuoteTokenConfiguration").selector) {
        const [address] = FLAP_PORTAL_INTERFACE.decodeFunctionData("getQuoteTokenConfiguration", data);
        const asset = this.assets.get(lower(address));
        if (!asset) throw new Error("unknown quote token");
        const history = this.configurationHistory.get(lower(address)) || [];
        const historical = history
          .filter((entry) => entry.blockNumber <= Number(blockTag))
          .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex)
          .at(-1);
        const selected = historical?.configuration
          || [0, ...asset.configuration.slice(1)];
        return FLAP_PORTAL_INTERFACE.encodeFunctionResult("getQuoteTokenConfiguration", [selected]);
      }
    }
    const asset = this.assets.get(lower(to));
    if (!asset) throw new Error("unknown ERC-20");
    if (data.slice(0, 10) === FLAP_ERC20_INTERFACE.getFunction("name").selector) {
      return FLAP_ERC20_INTERFACE.encodeFunctionResult("name", [asset.name]);
    }
    if (data.slice(0, 10) === FLAP_ERC20_INTERFACE.getFunction("symbol").selector) {
      return FLAP_ERC20_INTERFACE.encodeFunctionResult("symbol", [asset.symbol]);
    }
    if (data.slice(0, 10) === FLAP_ERC20_INTERFACE.getFunction("decimals").selector) {
      return FLAP_ERC20_INTERFACE.encodeFunctionResult("decimals", [asset.decimals]);
    }
    throw new Error(`unknown selector ${data.slice(0, 10)}`);
  }

  setAsset(address, {
    name,
    symbol,
    decimals = 18,
    configuration = [1, 1, 1, 1, 0],
    code = "0x6004600055",
  }) {
    this.assets.set(lower(address), { name, symbol, decimals, configuration: [...configuration], code });
  }

  setConfiguration(address, configuration) {
    this.assets.get(lower(address)).configuration = [...configuration];
  }

  seedConfigurationHistory(address, blockNumber, configuration, logIndex = 0) {
    const key = lower(address);
    const history = this.configurationHistory.get(key) || [];
    history.push({ blockNumber, logIndex, configuration: [...configuration] });
    this.configurationHistory.set(key, history);
  }

  addQuoteEvent({
    address,
    configuration,
    blockNumber,
    transactionHash = id(`quote-event:${address}:${blockNumber}:${this.logs.length}`),
    transactionIndex = 7,
    logIndex = 10 + this.logs.length,
    blockHash = this.hash(blockNumber),
    data = null,
  }) {
    this.setBlockHash(blockNumber, blockHash);
    const encoded = FLAP_PORTAL_INTERFACE.encodeEventLog(
      FLAP_PORTAL_INTERFACE.getEvent("QuoteTokenConfigurationSet"),
      [address, configuration],
    );
    const log = {
      address: FLAP_PORTAL_ADDRESS,
      blockNumber,
      blockHash: lower(blockHash),
      transactionHash: lower(transactionHash),
      transactionIndex,
      index: logIndex,
      removed: false,
      topics: encoded.topics,
      data: data || encoded.data,
    };
    this.logs.push(log);
    this.seedConfigurationHistory(address, blockNumber, configuration, logIndex);
    const key = lower(transactionHash);
    const receipt = this.receipts.get(key) || {
      hash: key,
      status: 1,
      blockNumber,
      blockHash: lower(blockHash),
      index: transactionIndex,
      logs: [],
    };
    receipt.logs.push(clone(log));
    this.receipts.set(key, receipt);
    this.transactions.set(key, {
      hash: key,
      from: ADMIN,
      to: SAFE,
      nonce: 176,
      blockNumber,
      blockHash: lower(blockHash),
      index: transactionIndex,
    });
    return log;
  }

  async getLogs(filter) {
    this.getLogsCalls.push(clone(filter));
    if (this.returnLogs) return clone(this.returnLogs(filter));
    return clone(this.logs.filter((log) => log.blockNumber >= Number(filter.fromBlock)
      && log.blockNumber <= Number(filter.toBlock)
      && lower(log.address) === lower(filter.address)
      && lower(log.topics[0]) === lower(filter.topics[0])));
  }

  async getTransactionReceipt(transactionHash) {
    this.receiptCalls += 1;
    return clone(this.receipts.get(lower(transactionHash)) || null);
  }

  async getTransaction(transactionHash) {
    this.transactionCalls += 1;
    return clone(this.transactions.get(lower(transactionHash)) || null);
  }
}

class FakeLogRpcEndpoint {
  constructor(sourceId, chain, { result } = {}) {
    this.sourceId = sourceId;
    this.chain = chain;
    this.result = result;
    this.calls = [];
  }

  async send(method, params) {
    this.calls.push({ method, params: clone(params) });
    if (method === "eth_chainId") return `0x${this.chain.liveChainId.toString(16)}`;
    assert.ok(["eth_getLogs", "eth_call", "eth_getCode"].includes(method));
    if (this.result) return clone(await this.result(method, params));
    return this.chain.send(method, params);
  }

  getNetwork(...args) { return this.chain.getNetwork(...args); }

  getBlock(...args) { return this.chain.getBlock(...args); }

  getCode(...args) { return this.chain.getCode(...args); }

  getStorage(...args) { return this.chain.getStorage(...args); }

  call(...args) { return this.chain.call(...args); }

  descriptor() {
    return { sourceId: this.sourceId, provider: this };
  }
}

function stateReaderWithPriorMode(sourceId, chain, mode = "normal") {
  let priorAttempts = 0;
  return new FakeLogRpcEndpoint(sourceId, chain, {
    result: async (method, params) => {
      const isPriorConfiguration = method === "eth_call"
        && typeof params[1] === "object"
        && params[0].data.slice(0, 10)
          === FLAP_PORTAL_INTERFACE.getFunction("getQuoteTokenConfiguration").selector;
      if (!isPriorConfiguration || mode === "normal") return chain.send(method, params);
      priorAttempts += 1;
      if (mode === "archive-once" && priorAttempts > 1) return chain.send(method, params);
      if (mode === "archive-unavailable" || mode === "archive-once") {
        const error = new Error("Archive requests require a personal token");
        error.code = -32602;
        throw error;
      }
      if (mode === "timeout") {
        const error = new Error("historical eth_call timed out");
        error.code = "TIMEOUT";
        throw error;
      }
      if (mode === "rate-limited") {
        const error = new Error("429 too many requests");
        error.code = 429;
        throw error;
      }
      if (["blockmachine-pruned", "blockmachine-wrong-code", "ordinary-revert"].includes(mode)) {
        const error = new Error("missing revert data");
        error.code = "CALL_EXCEPTION";
        error.shortMessage = "missing revert data";
        error.info = {
          error: mode === "ordinary-revert"
            ? { code: 3, message: "execution reverted" }
            : {
              code: mode === "blockmachine-pruned" ? -32000 : -32001,
              message: `historical state ${"ab".repeat(32)} is not available`,
            },
        };
        throw error;
      }
      if (Array.isArray(mode)) {
        return FLAP_PORTAL_INTERFACE.encodeFunctionResult(
          "getQuoteTokenConfiguration",
          [mode],
        );
      }
      throw new Error(`unsupported prior-state fixture mode ${String(mode)}`);
    },
  });
}

async function harness(t, {
  provider = new FakeBscProvider(),
  sendAlertsImpl,
  cancelPendingFlapQuoteActivationImpl,
  onFlapQuotePoolLifecycle,
  atomicWriteImpl,
  dataDir,
  logVerificationProviders,
  stateVerificationProviders,
  config: configOverrides = {},
  now = () => Date.parse("2026-09-03T07:00:00.000Z"),
  random = () => 0.5,
} = {}) {
  const directory = dataDir || await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-monitor-"));
  if (!dataDir) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const alerts = [];
  const cancellations = [];
  const lifecycles = [];
  const defaultLogVerificationProviders = [
    new FakeLogRpcEndpoint("https://fake-flap-log-a.test", provider).descriptor(),
    new FakeLogRpcEndpoint("https://fake-flap-log-b.test", provider).descriptor(),
  ];
  const defaultStateVerificationProviders = [
    new FakeLogRpcEndpoint("https://fake-flap-state-a.test", provider).descriptor(),
    new FakeLogRpcEndpoint("https://fake-flap-state-b.test", provider).descriptor(),
  ];
  const monitorConfig = {
    flapQuoteMonitorEnabled: true,
    dataDir: directory,
    flapQuoteConfirmations: CONFIRMATIONS,
    flapQuoteEventChunkSize: 100,
    flapQuoteMaxBlocksPerCycle: 500,
    flapQuoteBackoffBaseMs: 0,
    flapQuoteBackoffMaxMs: 0,
    ...configOverrides,
  };
  const monitorDependencies = {
    provider,
    autoStart: false,
    expectedPortalRuntimeHash: keccak256(PORTAL_CODE),
    expectedPortalVersion: "v5.22.0",
    expectedPortalImplementation: IMPLEMENTATION,
    expectedPortalImplementationHash: keccak256(IMPLEMENTATION_CODE),
    sendAlertsImpl: sendAlertsImpl || (async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    }),
    cancelPendingFlapQuoteActivationImpl: cancelPendingFlapQuoteActivationImpl || (async (_config, cancellation) => {
      cancellations.push(cancellation);
      return { status: "cancelled", reason: "quote_asset_disabled", persisted: true, terminal: true };
    }),
    onFlapQuotePoolLifecycle: onFlapQuotePoolLifecycle || (async (record) => {
      lifecycles.push(structuredClone(record));
      return {
        accepted: true,
        changed: true,
        action: record.action,
        status: record.action,
        quoteAddress: record.quoteAddress,
        generationKey: `${record.quoteAddress}:${record.activationEventKey}`,
      };
    }),
    atomicWriteImpl,
    now,
    random,
    logger: { error() {} },
  };
  monitorDependencies.logVerificationProviders = logVerificationProviders || defaultLogVerificationProviders;
  monitorDependencies.stateVerificationProviders = stateVerificationProviders || defaultStateVerificationProviders;
  const monitor = createFlapQuoteMonitor(monitorConfig, monitorDependencies);
  t.after(() => monitor.stop());
  return { provider, monitor, alerts, cancellations, lifecycles, dataDir: directory };
}

function addAssetEvent(provider, {
  address = FLAP_MRNAB_ADDRESS,
  name = "Moderna",
  symbol = "MRNAB",
  configuration = [1, 32, 32, 7, 0],
  blockNumber = 99,
  transactionHash,
  transactionIndex,
  logIndex = 10,
  data,
} = {}) {
  provider.setAsset(address, { name, symbol, decimals: 18, configuration });
  return provider.addQuoteEvent({
    address,
    configuration,
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
    data,
  });
}

test("official ABI topic and the real MRNAB/SQQQB log words decode exactly", () => {
  assert.equal(FLAP_QUOTE_CONFIGURATION_SIGNATURE, "QuoteTokenConfigurationSet(address,(uint8,uint8,uint8,uint8,uint8))");
  assert.equal(FLAP_QUOTE_CONFIGURATION_TOPIC, "0x9a1f38e55c729ebf0c45d240a00b09f0a79a715df7cfd6e8942bd3f8da839199");
  const common = { address: FLAP_PORTAL_ADDRESS, topics: [FLAP_QUOTE_CONFIGURATION_TOPIC] };
  assert.deepEqual(decodeFlapQuoteConfigurationLog({ ...common, data: MRNAB_LOG_DATA }), {
    quoteToken: FLAP_MRNAB_ADDRESS,
    configuration: {
      enabled: true,
      enabledRaw: 1,
      defaultCurve: 32,
      alternativeCurve: 32,
      nativeToQuoteSwapType: 7,
      dexId: 0,
    },
  });
  assert.deepEqual(decodeFlapQuoteConfigurationLog({ ...common, data: SQQQB_LOG_DATA }), {
    quoteToken: FLAP_SQQQB_ADDRESS,
    configuration: {
      enabled: true,
      enabledRaw: 1,
      defaultCurve: 56,
      alternativeCurve: 56,
      nativeToQuoteSwapType: 7,
      dexId: 0,
    },
  });
});

test("Flap quote log RPC configuration deduplicates by physical origin and requires two", () => {
  assert.deepEqual(parseDistinctRpcOrigins(
    "FLAP_QUOTE_LOG_RPC_URLS",
    "https://rpc-a.test/path,https://RPC-A.test/other,https://rpc-b.test/rpc",
    "",
  ), ["https://rpc-a.test/path", "https://rpc-b.test/rpc"]);
  assert.throws(
    () => parseDistinctRpcOrigins(
      "FLAP_QUOTE_LOG_RPC_URLS",
      "https://rpc-a.test/path,https://rpc-a.test/other",
      "",
    ),
    /at least two distinct physical RPC hosts/,
  );
  assert.throws(
    () => parseDistinctRpcOrigins(
      "FLAP_QUOTE_LOG_RPC_URLS",
      "http://rpc-a.test/path,https://rpc-a.test/other",
      "",
    ),
    /at least two distinct physical RPC hosts/,
  );
  assert.throws(
    () => parseDistinctRpcOrigins(
      "FLAP_QUOTE_LOG_RPC_URLS",
      "https://rpc-a.test./path,https://RPC-A.test/other",
      "",
    ),
    /at least two distinct physical RPC hosts/,
  );
  assert.throws(
    () => parseDistinctRpcOrigins("FLAP_QUOTE_LOG_RPC_URLS", "file:\/\/local,https://rpc-b.test", ""),
    /credential-free HTTP\(S\) URLs/,
  );
  const sameHost = new FakeBscProvider();
  assert.throws(() => createFlapQuoteMonitor({ flapQuoteMonitorEnabled: true }, {
    provider: sameHost,
    autoStart: false,
    logVerificationProviders: [
      new FakeLogRpcEndpoint("http://rpc-a.test", sameHost).descriptor(),
      new FakeLogRpcEndpoint("https://rpc-a.test", sameHost).descriptor(),
    ],
  }), /distinct physical hosts/);
});

test("runtime wiring owns and destroys one fixed provider per configured Flap log origin", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const configSource = await fs.readFile(new URL("../src/config.js", import.meta.url), "utf8");
  const envExample = await fs.readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(source, /const flapQuoteLogProviders = new Map\(\)/);
  assert.match(source, /const flapQuoteStateProviders = new Map\(\)/);
  assert.match(source, /for \(const rpcUrl of config\.flapQuoteLogRpcUrls\)/);
  assert.match(source, /for \(const rpcUrl of config\.flapQuoteStateRpcUrls\)/);
  assert.match(source, /flapQuoteLogProviders\.set\(sourceId, createAbortableJsonRpcProvider\(rpcUrl, 56,/);
  assert.match(source, /flapQuoteStateProviders\.set\(sourceId, createAbortableJsonRpcProvider\(rpcUrl, 56,/);
  assert.match(source, /logVerificationProviders: \[\.\.\.flapQuoteLogProviders\]/);
  assert.match(source, /stateVerificationProviders: \[\.\.\.flapQuoteStateProviders\]/);
  assert.match(source, /\.\.\.flapQuoteLogProviders\.values\(\)/);
  assert.match(source, /\.\.\.flapQuoteStateProviders\.values\(\)/);
  assert.match(source, /flapQuoteLogProviders\.clear\(\)/);
  assert.match(source, /flapQuoteStateProviders\.clear\(\)/);
  const logDefaults = "https://rpc-bnb.blockmachine.io,https://rpc.48.club";
  const stateDefaults = "https://rpc-bnb.blockmachine.io,https://bsc-mainnet.public.blastapi.io";
  assert.match(configSource, new RegExp(logDefaults.replaceAll(".", "\\.")));
  assert.match(configSource, new RegExp(stateDefaults.replaceAll(".", "\\.")));
  assert.match(envExample, new RegExp(`FLAP_QUOTE_LOG_RPC_URLS=${logDefaults.replaceAll(".", "\\.")}`));
  assert.match(envExample, new RegExp(`FLAP_QUOTE_STATE_RPC_URLS=${stateDefaults.replaceAll(".", "\\.")}`));
});

test("first check establishes a silent finalized-head-plus-one baseline", async (t) => {
  const fixture = await harness(t);
  const result = await fixture.monitor.check();
  assert.equal(result.status, "baseline");
  assert.equal(result.delivered, 0);
  assert.equal(fixture.alerts.length, 0);
  assert.equal(fixture.provider.getLogsCalls.length, 0);
  assert.deepEqual(fixture.monitor.state().cursor, {
    nextBlock: 99,
    afterLogIndex: -1,
    anchorBlock: 98,
    anchorBlockHash: lower(fixture.provider.hash(98)),
    baselineEstablishedAt: "2026-09-03T07:00:00.000Z",
  });
  const persisted = JSON.parse(await fs.readFile(fixture.monitor.stateFile, "utf8"));
  assert.equal(persisted.cursor.nextBlock, 99);
  assert.equal(persisted.identity.chainId, 56);
  assert.equal(persisted.identity.portal, FLAP_PORTAL_ADDRESS);
  assert.equal(persisted.identity.version, "v5.22.0");
  assert.equal(persisted.identity.implementation, IMPLEMENTATION);
  assert.equal((await fs.stat(fixture.monitor.stateFile)).mode & 0o777, 0o600);
});

test("a pre-baseline RPC failure uses only volatile backoff and a restart baselines cleanly", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-prebaseline-failure-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-09-03T07:00:00.000Z");
  const provider = new FakeBscProvider();
  let headCalls = 0;
  provider.getBlockNumber = async () => {
    headCalls += 1;
    const error = new Error("temporary BSC head outage");
    error.code = "SERVER_ERROR";
    error.retryAfterMs = 5_000;
    throw error;
  };
  const first = await harness(t, {
    provider,
    dataDir,
    now: () => nowMs,
    config: { flapQuoteBackoffBaseMs: 1_000, flapQuoteBackoffMaxMs: 10_000 },
  });

  const failed = await first.monitor.check();
  assert.equal(failed.status, "degraded");
  assert.equal(failed.initialized, false);
  assert.equal(failed.errorCode, "FLAP_QUOTE_HEAD_UNAVAILABLE");
  assert.equal(failed.nextAttemptAt, "2026-09-03T07:00:05.000Z");
  assert.equal(first.monitor.state().initialized, false);
  assert.equal(first.monitor.state().checkedAt, null);
  await assert.rejects(fs.stat(first.monitor.stateFile), { code: "ENOENT" });

  assert.equal((await first.monitor.check()).status, "backoff");
  assert.equal(headCalls, 1, "volatile pre-baseline backoff performs no early RPC");
  await assert.rejects(fs.stat(first.monitor.stateFile), { code: "ENOENT" });
  await first.monitor.stop();

  const restarted = await harness(t, { provider: new FakeBscProvider(), dataDir });
  const baseline = await restarted.monitor.check();
  assert.equal(baseline.status, "baseline");
  assert.notEqual(baseline.errorCode, "FLAP_QUOTE_STATE_INVALID");
  assert.equal(JSON.parse(await fs.readFile(restarted.monitor.stateFile, "utf8")).initialized, true);
});

test("a post-rename writer error is reconciled and cannot silently re-baseline past an event", async (t) => {
  const provider = new FakeBscProvider();
  let firstWrite = true;
  const fixture = await harness(t, {
    provider,
    atomicWriteImpl: async (file, value) => {
      await atomicWriteFlapQuoteState(file, value);
      if (firstWrite) {
        firstWrite = false;
        const error = new Error("simulated directory fsync failure after rename");
        error.code = "EIO";
        throw error;
      }
    },
  });
  const baseline = await fixture.monitor.check();
  assert.equal(baseline.status, "baseline", "an exact read-back proves that the baseline rename committed");
  assert.equal(fixture.monitor.state().cursor.anchorBlock, 98);

  const log = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  const next = await fixture.monitor.check();
  assert.equal(next.status, "healthy");
  assert.equal(next.delivered, 1);
  assert.equal(fixture.alerts[0].eventKey, flapQuoteEventKey(log));
  assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
});

test("the real createRpcPool facade supplies receipts while separate fixed readers verify logs and state", async (t) => {
  const backing = new FakeBscProvider();
  let pooledStateReads = 0;
  const pool = createRpcPool([
    "https://flap-quote-a.test",
    "https://flap-quote-b.test",
  ], [], 1, {
    requestTimeoutMs: 1_000,
    providerFactory: (url) => ({
      getNetwork: (...args) => backing.getNetwork(...args),
      getBlockNumber: (...args) => backing.getBlockNumber(...args),
      getTransaction: (...args) => backing.getTransaction(...args),
      getTransactionReceipt: (...args) => backing.getTransactionReceipt(...args),
      getBlock: (...args) => backing.getBlock(...args),
      getCode: async () => { pooledStateReads += 1; throw new Error("stale pooled getCode must not be trusted"); },
      getStorage: async () => { pooledStateReads += 1; throw new Error("stale pooled getStorage must not be trusted"); },
      call: async () => { pooledStateReads += 1; throw new Error("stale pooled eth_call must not be trusted"); },
      send: (...args) => backing.send(...args),
      destroy() {},
    }),
  });
  t.after(() => pool.destroy());
  const firstLogs = new FakeLogRpcEndpoint("https://fixed-flap-log-a.test", backing);
  const secondLogs = new FakeLogRpcEndpoint("https://fixed-flap-log-b.test", backing);
  const firstState = new FakeLogRpcEndpoint("https://fixed-flap-state-a.test", backing);
  const secondState = new FakeLogRpcEndpoint("https://fixed-flap-state-b.test", backing);
  const fixture = await harness(t, {
    provider: pool,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
    stateVerificationProviders: [firstState.descriptor(), secondState.descriptor()],
  });
  assert.equal((await fixture.monitor.check()).status, "baseline");
  const baselineCallCount = backing.callTags.length;
  addAssetEvent(backing, { blockNumber: 99 });
  backing.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 1);
  assert.equal(pooledStateReads, 0, "identity, configuration and metadata never use the rotating pooled state view");
  assert.equal(fixture.alerts.length, 1);
  assert.deepEqual([firstLogs.sourceId, secondLogs.sourceId], [
    "https://fixed-flap-log-a.test",
    "https://fixed-flap-log-b.test",
  ]);
  for (const endpoint of [firstLogs, secondLogs]) {
    const logCall = endpoint.calls.find(({ method }) => method === "eth_getLogs");
    assert.equal(logCall.params[0].fromBlock, "0x63");
    assert.equal(logCall.params[0].toBlock, "0x63");
  }
  for (const endpoint of [firstState, secondState]) {
    const configurationCalls = endpoint.calls.filter(({ method, params }) => method === "eth_call"
      && params[0].data.slice(0, 10) === FLAP_PORTAL_INTERFACE.getFunction("getQuoteTokenConfiguration").selector);
    assert.ok(configurationCalls.some(({ params }) => (
      params[1]?.blockHash === backing.hash(98) && params[1]?.requireCanonical === true
    )), "prior configuration is hash-bound at eventBlock-1");
    assert.ok(configurationCalls.some(({ params }) => params[1] === "0x63"), "final configuration is read on the fixed reader");
    assert.ok(endpoint.calls.some(({ method }) => method === "eth_getCode"), "token runtime is read on the fixed reader");
  }
  assert.equal(backing.getLogsCalls.length, 2);
  const finalizedSelectors = new Set([
    FLAP_PORTAL_INTERFACE.getFunction("version").selector,
    FLAP_ERC20_INTERFACE.getFunction("name").selector,
    FLAP_ERC20_INTERFACE.getFunction("symbol").selector,
    FLAP_ERC20_INTERFACE.getFunction("decimals").selector,
  ]);
  const calls = backing.callTags.slice(baselineCallCount);
  assert.ok(calls.some(({ selector }) => selector === FLAP_PORTAL_INTERFACE.getFunction("getQuoteTokenConfiguration").selector
    && calls.some((candidate) => candidate.selector === selector && candidate.blockTag === 99)));
  for (const call of calls.filter(({ selector }) => finalizedSelectors.has(selector))) {
    assert.equal(call.blockTag, 99, `${call.selector} must use the finalized transaction blockTag`);
  }
});

test("empty versus non-empty independent log results freeze the durable cursor", async (t) => {
  const provider = new FakeBscProvider();
  const firstLogs = new FakeLogRpcEndpoint("https://independent-a.test", provider);
  const secondLogs = new FakeLogRpcEndpoint("https://independent-b.test", provider, { result: async () => [] });
  const fixture = await harness(t, {
    provider,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
  });
  await fixture.monitor.check();
  const before = clone(fixture.monitor.state().cursor);
  addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_LOG_REDUNDANCY_MISMATCH");
  assert.deepEqual(fixture.monitor.state().cursor, before);
  assert.equal(fixture.alerts.length, 0);
  assert.equal(fixture.monitor.state().processedEventKeys.length, 0);
});

test("fixed log readers split wide catch-up ranges into bounded concurrent pages", async (t) => {
  const provider = new FakeBscProvider();
  const firstLogs = new FakeLogRpcEndpoint("https://paged-log-a.test", provider);
  const secondLogs = new FakeLogRpcEndpoint("https://paged-log-b.test", provider);
  const fixture = await harness(t, {
    provider,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
    config: {
      flapQuoteEventChunkSize: 100,
      flapQuoteMaxBlocksPerCycle: 100,
      flapQuoteLogMaxBlockSpan: 25,
      flapQuoteLogConcurrency: 4,
    },
  });
  assert.equal((await fixture.monitor.check()).status, "baseline");
  provider.head = 200;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.scannedBlocks, undefined);
  for (const endpoint of [firstLogs, secondLogs]) {
    const pages = endpoint.calls
      .filter(({ method }) => method === "eth_getLogs")
      .map(({ params }) => [
        Number.parseInt(params[0].fromBlock, 16),
        Number.parseInt(params[0].toBlock, 16),
      ])
      .sort((left, right) => left[0] - right[0]);
    assert.deepEqual(pages, [[99, 123], [124, 148], [149, 173], [174, 198]]);
    assert.ok(pages.every(([fromBlock, toBlock]) => toBlock - fromBlock + 1 <= 25));
  }
  assert.equal(fixture.monitor.state().cursor.nextBlock, 199);
});

test("a later page rate limit preserves earlier page commits and resumes exactly once after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-page-resume-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider();
  const firstLogs = new FakeLogRpcEndpoint("https://resume-log-a.test", provider);
  let failFifthPage = true;
  const secondLogs = new FakeLogRpcEndpoint("https://resume-log-b.test", provider, {
    result: async (method, params) => {
      if (method === "eth_getLogs"
        && Number.parseInt(params[0].fromBlock, 16) === 199
        && failFifthPage) {
        failFifthPage = false;
        const error = new Error("429 too many requests");
        error.code = 429;
        throw error;
      }
      return provider.send(method, params);
    },
  });
  const first = await harness(t, {
    provider,
    dataDir,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
    config: {
      flapQuoteEventChunkSize: 25,
      flapQuoteMaxBlocksPerCycle: 125,
      flapQuoteLogMaxBlockSpan: 25,
      flapQuoteLogConcurrency: 1,
    },
  });
  assert.equal((await first.monitor.check()).status, "baseline");
  const event = addAssetEvent(provider, { blockNumber: 150 });
  provider.head = 225;

  const interrupted = await first.monitor.check();
  assert.equal(interrupted.errorCode, "FLAP_QUOTE_GET_LOGS_FAILED");
  assert.equal(first.monitor.state().cursor.nextBlock, 199);
  assert.equal(first.alerts.length, 0, "pending activation waits until the fixed snapshot is fully caught up");
  assert.equal(
    first.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey,
    flapQuoteEventKey(event),
  );
  await first.monitor.stop();

  const callsBeforeRestart = secondLogs.calls.length;
  const restarted = await harness(t, {
    provider,
    dataDir,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
    config: {
      flapQuoteEventChunkSize: 25,
      flapQuoteMaxBlocksPerCycle: 125,
      flapQuoteLogMaxBlockSpan: 25,
      flapQuoteLogConcurrency: 1,
    },
  });
  const recovered = await restarted.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(restarted.monitor.state().cursor.nextBlock, 224);
  assert.equal(restarted.alerts.length, 1);
  assert.equal(restarted.alerts[0].eventKey, flapQuoteEventKey(event));
  const firstRestartLogCall = secondLogs.calls.slice(callsBeforeRestart)
    .find(({ method }) => method === "eth_getLogs");
  assert.equal(Number.parseInt(firstRestartLogCall.params[0].fromBlock, 16), 199);
  assert.equal(Number.parseInt(firstRestartLogCall.params[0].toBlock, 16), 223);
  assert.equal((await restarted.monitor.check()).delivered, 0);
  assert.equal(restarted.alerts.length, 1, "recovery and replay remain exact-once");
});

test("fixed readers must agree on finalized configuration state before the cursor advances", async (t) => {
  const provider = new FakeBscProvider();
  const first = new FakeLogRpcEndpoint("https://state-quorum-a.test", provider);
  const second = new FakeLogRpcEndpoint("https://state-quorum-b.test", provider, {
    result: async (method, params) => {
      if (method !== "eth_call") return provider.send(method, params);
      const selector = params[0].data.slice(0, 10);
      const blockNumber = Number.parseInt(params[1], 16);
      if (selector === FLAP_PORTAL_INTERFACE.getFunction("getQuoteTokenConfiguration").selector
        && blockNumber === 99) {
        return FLAP_PORTAL_INTERFACE.encodeFunctionResult(
          "getQuoteTokenConfiguration",
          [[0, 32, 32, 7, 0]],
        );
      }
      return provider.send(method, params);
    },
  });
  const fixture = await harness(t, {
    provider,
    stateVerificationProviders: [first.descriptor(), second.descriptor()],
  });
  await fixture.monitor.check();
  const before = clone(fixture.monitor.state().cursor);
  addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_CONFIGURATION_READ_FAILED_MISMATCH");
  assert.deepEqual(fixture.monitor.state().cursor, before);
  assert.equal(fixture.monitor.state().processedEventKeys.length, 0);
  assert.equal(fixture.alerts.length, 0);
});

test("log and state lanes must agree on the finalized fork before evidence can be combined", async (t) => {
  const logChain = new FakeBscProvider();
  const stateChain = new FakeBscProvider();
  const firstLogs = new FakeLogRpcEndpoint("https://lane-log-a.test", logChain);
  const secondLogs = new FakeLogRpcEndpoint("https://lane-log-b.test", logChain);
  const firstState = new FakeLogRpcEndpoint("https://lane-state-a.test", stateChain);
  const secondState = new FakeLogRpcEndpoint("https://lane-state-b.test", stateChain);
  const fixture = await harness(t, {
    provider: logChain,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
    stateVerificationProviders: [firstState.descriptor(), secondState.descriptor()],
  });
  assert.equal((await fixture.monitor.check()).status, "baseline");
  const before = clone(fixture.monitor.state().cursor);

  addAssetEvent(logChain, { blockNumber: 99 });
  logChain.head = 101;
  stateChain.head = 101;
  stateChain.setBlockHash(99, id("disjoint-state-lane-block:99"));

  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_FINALIZED_LANE_MISMATCH");
  assert.deepEqual(fixture.monitor.state().cursor, before);
  assert.equal(fixture.monitor.state().processedEventKeys.length, 0);
  assert.equal(fixture.alerts.length, 0);
  assert.equal(logChain.getLogsCalls.length, 0, "fork mismatch freezes before log scanning");
});

test("historical state is bound to the parent hash of the verified event block", async (t) => {
  const logChain = new FakeBscProvider({ head: 99 });
  const stateChain = new FakeBscProvider({ head: 99 });
  const firstLogs = new FakeLogRpcEndpoint("https://parent-log-a.test", logChain);
  const secondLogs = new FakeLogRpcEndpoint("https://parent-log-b.test", logChain);
  const firstState = new FakeLogRpcEndpoint("https://parent-state-a.test", stateChain);
  const secondState = new FakeLogRpcEndpoint("https://parent-state-b.test", stateChain);
  const fixture = await harness(t, {
    provider: logChain,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
    stateVerificationProviders: [firstState.descriptor(), secondState.descriptor()],
  });
  assert.equal((await fixture.monitor.check()).status, "baseline");
  const before = clone(fixture.monitor.state().cursor);

  const log = addAssetEvent(logChain, { blockNumber: 99 });
  stateChain.setBlockHash(99, log.blockHash);
  stateChain.setBlockHash(98, id("disjoint-state-lane-parent:98"));
  logChain.head = 101;
  stateChain.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_PRIOR_LANE_MISMATCH");
  assert.deepEqual(fixture.monitor.state().cursor, before);
  assert.equal(fixture.monitor.state().processedEventKeys.length, 0);
  assert.equal(fixture.alerts.length, 0);
});

test("a fixed log reader on the wrong live chain freezes before eth_getLogs", async (t) => {
  const provider = new FakeBscProvider();
  const wrongChain = new FakeBscProvider();
  wrongChain.liveChainId = 1;
  const firstLogs = new FakeLogRpcEndpoint("https://reader-chain-a.test", provider);
  const secondLogs = new FakeLogRpcEndpoint("https://reader-chain-b.test", wrongChain);
  const fixture = await harness(t, {
    provider,
    logVerificationProviders: [firstLogs.descriptor(), secondLogs.descriptor()],
  });
  await fixture.monitor.check();
  const before = clone(fixture.monitor.state().cursor);
  addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH");
  assert.deepEqual(fixture.monitor.state().cursor, before);
  assert.ok(secondLogs.calls.length >= 1);
  assert.ok(secondLogs.calls.every(({ method }) => method === "eth_chainId"));
});

test("live chain ID and every pinned Portal implementation identity field fail closed", async (t) => {
  const cases = [
    ["live eth_chainId", (provider) => { provider.liveChainId = 1; }, "FLAP_QUOTE_CHAIN_ID_MISMATCH"],
    ["version", (provider) => { provider.portalVersion = "v5.22.1"; }, "FLAP_QUOTE_PORTAL_VERSION_MISMATCH"],
    ["implementation", (provider) => { provider.implementation = "0x2222222222222222222222222222222222222222"; }, "FLAP_QUOTE_PORTAL_IMPLEMENTATION_MISMATCH"],
    ["implementation runtime", (provider) => { provider.implementationCode = "0x6009600055"; }, "FLAP_QUOTE_PORTAL_IMPLEMENTATION_HASH_MISMATCH"],
  ];
  for (const [label, mutate, expectedCode] of cases) {
    await t.test(label, async (subtest) => {
      const provider = new FakeBscProvider();
      const fixture = await harness(subtest, { provider });
      mutate(provider);
      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, expectedCode);
      assert.equal(result.initialized, false);
      assert.equal(provider.getLogsCalls.length, 0);
    });
  }
});

test("Portal identity and baseline block hashes are immutable across first-start verification", async (t) => {
  await t.test("identity reads span a reorg", async (subtest) => {
    const provider = new FakeBscProvider();
    const originalGetCode = provider.getCode.bind(provider);
    let flipped = false;
    provider.getCode = async (...args) => {
      const result = await originalGetCode(...args);
      if (!flipped && lower(args[0]) === lower(FLAP_PORTAL_ADDRESS)) {
        flipped = true;
        provider.setBlockHash(98, id("identity-read-reorg"));
      }
      return result;
    };
    const fixture = await harness(subtest, { provider });
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_PORTAL_IDENTITY_CHANGED");
    assert.equal(result.initialized, false);
    await assert.rejects(fs.stat(fixture.monitor.stateFile), { code: "ENOENT" });
  });

  await t.test("block flips after identity recheck but before baseline commit", async (subtest) => {
    const provider = new FakeBscProvider();
    const firstReader = new FakeLogRpcEndpoint("https://baseline-race-a.test", provider);
    const secondReader = new FakeLogRpcEndpoint("https://baseline-race-b.test", provider);
    let firstReaderFinalizedReads = 0;
    firstReader.getBlock = async (blockNumber) => {
      const number = Number(blockNumber);
      const block = {
        number,
        hash: provider.hash(number),
        parentHash: provider.hash(number - 1),
        timestamp: provider.blockTimestamps.get(number) || 1_788_418_795,
      };
      if (Number(blockNumber) === 98 && ++firstReaderFinalizedReads === 2) {
        provider.setBlockHash(98, id("baseline-precommit-reorg"));
      }
      return block;
    };
    const fixture = await harness(subtest, {
      provider,
      logVerificationProviders: [firstReader.descriptor(), secondReader.descriptor()],
    });
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_BASELINE_REORG");
    assert.equal(result.initialized, false);
    await assert.rejects(fs.stat(fixture.monitor.stateFile), { code: "ENOENT" });
  });
});

test("one real Safe transaction with MRNAB and SQQQB Portal logs emits two complete quote assets", async (t) => {
  const provider = new FakeBscProvider({ head: FLAP_QUOTE_REFERENCE_BLOCK - 3 });
  const fixture = await harness(t, { provider });
  await fixture.monitor.check();
  const baselineCallCount = provider.callTags.length;

  provider.setAsset(FLAP_MRNAB_ADDRESS, {
    name: "Moderna",
    symbol: "MRNAB",
    decimals: 18,
    configuration: [1, 32, 32, 7, 0],
  });
  provider.setAsset(FLAP_SQQQB_ADDRESS, {
    name: "ProShares UltraPro Short QQQ",
    symbol: "SQQQB",
    decimals: 18,
    configuration: [1, 56, 56, 7, 0],
  });
  provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [1, 32, 32, 7, 0],
    blockNumber: FLAP_QUOTE_REFERENCE_BLOCK,
    blockHash: FLAP_QUOTE_REFERENCE_BLOCK_HASH,
    transactionHash: FLAP_QUOTE_REFERENCE_TRANSACTION,
    transactionIndex: 66,
    logIndex: 428,
    data: MRNAB_LOG_DATA,
  });
  provider.addQuoteEvent({
    address: FLAP_SQQQB_ADDRESS,
    configuration: [1, 56, 56, 7, 0],
    blockNumber: FLAP_QUOTE_REFERENCE_BLOCK,
    blockHash: FLAP_QUOTE_REFERENCE_BLOCK_HASH,
    transactionHash: FLAP_QUOTE_REFERENCE_TRANSACTION,
    transactionIndex: 66,
    logIndex: 431,
    data: SQQQB_LOG_DATA,
  });
  provider.head = FLAP_QUOTE_REFERENCE_BLOCK + CONFIRMATIONS;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 2);
  assert.equal(fixture.alerts.length, 2);
  assert.deepEqual(fixture.alerts.map((event) => event.eventKey), [
    `flap-quote:56:${FLAP_QUOTE_REFERENCE_TRANSACTION}:428`,
    `flap-quote:56:${FLAP_QUOTE_REFERENCE_TRANSACTION}:431`,
  ]);
  assert.deepEqual(fixture.alerts.map((event) => event.changes.newFlapPools[0].quoteSymbol), ["MRNAB", "SQQQB"]);
  assert.deepEqual(fixture.alerts.map((event) => event.changes.newFlapPools[0].quoteName), [
    "Moderna",
    "ProShares UltraPro Short QQQ",
  ]);
  for (const event of fixture.alerts) {
    const asset = event.changes.newFlapPools[0];
    assert.equal(event.type, "platform_capability_update");
    assert.equal(event.platform.id, "flap");
    assert.equal(event.chainId, 56);
    assert.equal(event.portal, FLAP_PORTAL_ADDRESS);
    assert.equal(event.source.url, FLAP_BOARD_URL);
    assert.equal(event.source.docsUrl, FLAP_DEPLOYED_CONTRACTS_URL);
    assert.equal(event.transactionHash, FLAP_QUOTE_REFERENCE_TRANSACTION);
    assert.equal(event.blockNumber, FLAP_QUOTE_REFERENCE_BLOCK);
    assert.equal(event.blockHash, FLAP_QUOTE_REFERENCE_BLOCK_HASH);
    assert.equal(event.receiptProof.status, 1);
    assert.equal(event.receiptProof.logMatched, true);
    assert.equal(event.transactionProof.to, SAFE);
    assert.equal(event.onchainProof.receiptVerified, true);
    assert.equal(event.onchainProof.confirmations, CONFIRMATIONS);
    assert.equal(event.onchainProof.topic0, FLAP_QUOTE_CONFIGURATION_TOPIC);
    assert.equal(asset.kind, "quote_asset");
    assert.equal(asset.quoteDecimals, 18);
    assert.equal(asset.enabled, true);
    assert.equal(asset.verifiedAtBlock, FLAP_QUOTE_REFERENCE_BLOCK);
    assert.match(asset.codeHash, /^0x[a-f0-9]{64}$/);
  }
  assert.equal(provider.receiptCalls, 2, "same-transaction logs share one receipt proof per scan and delivery phase");
  assert.equal(provider.transactionCalls, 2, "same-transaction logs share one transaction proof per scan and delivery phase");
  assert.deepEqual(new Set(provider.callTags.slice(baselineCallCount).map(({ blockTag }) => blockTag)), new Set([
    FLAP_QUOTE_REFERENCE_BLOCK - 1,
    FLAP_QUOTE_REFERENCE_BLOCK,
  ]));
  assert.deepEqual(fixture.monitor.state().processedEventKeys, fixture.alerts.map((event) => event.eventKey));
});

test("a verified direct bStock activation hands off one exact monitor-only lifecycle record", async (t) => {
  const provider = new FakeBscProvider();
  const records = [];
  const fixture = await harness(t, {
    provider,
    onFlapQuotePoolLifecycle: async (record) => {
      records.push(structuredClone(record));
      return {
        accepted: true,
        changed: true,
        action: record.action,
        status: record.action,
        quoteAddress: record.quoteAddress,
        generationKey: "test-generation",
      };
    },
  });
  await fixture.monitor.check();
  const occurredAt = "2026-09-03T06:59:00.000Z";
  provider.setBlockTimestamp(99, Date.parse(occurredAt) / 1_000);
  provider.setAsset(FLAP_SQQQB_ADDRESS, {
    name: "ProShares UltraPro Short QQQ ETF Tokenized Stock (bStock)",
    symbol: "SQQQB",
    decimals: 18,
    configuration: [1, 56, 56, 7, 0],
  });
  const log = provider.addQuoteEvent({
    address: FLAP_SQQQB_ADDRESS,
    configuration: [1, 56, 56, 7, 0],
    blockNumber: 99,
    transactionHash: id("direct-bstock-lifecycle"),
    transactionIndex: 4,
    logIndex: 17,
  });
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 1);
  assert.deepEqual(records, [{
    version: 1,
    action: "activated",
    quoteAddress: lower(FLAP_SQQQB_ADDRESS),
    quoteName: "ProShares UltraPro Short QQQ ETF Tokenized Stock (bStock)",
    quoteSymbol: "SQQQB",
    activationEventKey: flapQuoteEventKey(log),
    transactionHash: lower(log.transactionHash),
    blockNumber: 99,
    blockHash: lower(log.blockHash),
    transactionIndex: 4,
    logIndex: 17,
    occurredAt,
    proofType: "verified_zero_to_one",
    requiredConfirmations: CONFIRMATIONS,
    monitorOnly: true,
  }]);
  assert.equal(fixture.alerts[0].changes.newFlapPools[0].quoteSymbol, "SQQQB");
});

test("a non-durable lifecycle reply leaves delivery pending and retries the same record after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-lifecycle-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider();
  const records = [];
  let attempts = 0;
  const lifecycle = async (record) => {
    attempts += 1;
    records.push(structuredClone(record));
    if (attempts === 1) return { accepted: false, status: "queued" };
    return {
      accepted: true,
      changed: true,
      action: record.action,
      status: "duplicate",
      quoteAddress: record.quoteAddress,
      generationKey: "test-generation",
    };
  };
  const first = await harness(t, { provider, dataDir, onFlapQuotePoolLifecycle: lifecycle });
  await first.monitor.check();
  const log = addAssetEvent(provider, {
    blockNumber: 99,
    transactionHash: id("lifecycle-restart"),
    logIndex: 19,
  });
  provider.head = 101;

  const failed = await first.monitor.check();
  assert.equal(failed.errorCode, "FLAP_QUOTE_LIFECYCLE_NOT_DURABLE");
  assert.equal(first.monitor.state().eventRecords[0].delivered, false,
    "the lifecycle failure cannot commit the direct delivery checkpoint");
  assert.equal(first.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(log));
  await first.monitor.stop();

  const restarted = await harness(t, { provider, dataDir, onFlapQuotePoolLifecycle: lifecycle });
  const recovered = await restarted.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(records[1], records[0], "restart retries the idempotent base producer record unchanged");
  assert.equal(restarted.monitor.state().eventRecords[0].delivered, true);
  assert.equal(Object.keys(restarted.monitor.state().pendingEnableCandidates).length, 0);
});

test("a thrown lifecycle hook cannot consume the direct activation", async (t) => {
  let attempts = 0;
  const fixture = await harness(t, {
    onFlapQuotePoolLifecycle: async (record) => {
      attempts += 1;
      if (attempts === 1) throw new Error("registry unavailable");
      return {
        accepted: true,
        changed: true,
        action: record.action,
        status: record.action,
        quoteAddress: record.quoteAddress,
        generationKey: "test-generation",
      };
    },
  });
  await fixture.monitor.check();
  const log = addAssetEvent(fixture.provider, { blockNumber: 99, logIndex: 21 });
  fixture.provider.head = 101;

  const failed = await fixture.monitor.check();
  assert.equal(failed.errorCode, "FLAP_QUOTE_LIFECYCLE_NOT_DURABLE");
  assert.equal(fixture.monitor.state().eventRecords[0].delivered, false);
  assert.equal(fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(log));

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(attempts, 2);
  assert.equal(fixture.monitor.state().eventRecords[0].delivered, true);
});

test("only the latest surviving 0-to-1 transition is alerted within one range and across cycles", async (t) => {
  for (const [label, config] of [
    ["one range", { flapQuoteEventChunkSize: 100, flapQuoteMaxBlocksPerCycle: 100 }],
    ["three cycles", { flapQuoteEventChunkSize: 1, flapQuoteMaxBlocksPerCycle: 1 }],
  ]) {
    await t.test(label, async (subtest) => {
      const provider = new FakeBscProvider();
      const fixture = await harness(subtest, { provider, config });
      await fixture.monitor.check();
      const first = addAssetEvent(provider, {
        blockNumber: 99,
        transactionHash: id(`superseded-enable-${label}`),
        logIndex: 10,
      });
      const disabled = [0, 32, 32, 7, 0];
      provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
      provider.addQuoteEvent({
        address: FLAP_MRNAB_ADDRESS,
        configuration: disabled,
        blockNumber: 100,
        transactionHash: id(`intervening-disable-${label}`),
        logIndex: 11,
      });
      const enabled = [1, 33, 34, 7, 0];
      provider.setConfiguration(FLAP_MRNAB_ADDRESS, enabled);
      const surviving = provider.addQuoteEvent({
        address: FLAP_MRNAB_ADDRESS,
        configuration: enabled,
        blockNumber: 101,
        transactionHash: id(`surviving-enable-${label}`),
        logIndex: 12,
      });
      provider.head = 103;

      const firstCycle = await fixture.monitor.check();
      if (label === "three cycles") {
        assert.equal(firstCycle.delivered, 0);
        assert.equal(fixture.alerts.length, 0);
        assert.equal(Object.values(fixture.monitor.state().pendingEnableCandidates)[0].eventKey, flapQuoteEventKey(first));
        assert.equal((await fixture.monitor.check()).delivered, 0);
        assert.equal(Object.keys(fixture.monitor.state().pendingEnableCandidates).length, 0);
        assert.equal((await fixture.monitor.check()).delivered, 1);
      } else {
        assert.equal(firstCycle.delivered, 1);
      }
      assert.equal(fixture.alerts.length, 1);
      assert.equal(fixture.alerts[0].eventKey, flapQuoteEventKey(surviving));
      assert.equal(fixture.alerts[0].blockNumber, 101);
      assert.equal(fixture.alerts[0].onchainProof.eventConfiguration.defaultCurve, 33);
      assert.equal(Object.keys(fixture.monitor.state().pendingEnableCandidates).length, 0);
    });
  }
});

test("the direct Portal event passes the strict focus3 monitoring-source gate", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  addAssetEvent(fixture.provider, { blockNumber: 99 });
  fixture.provider.head = 101;
  await fixture.monitor.check();
  const event = clone(fixture.alerts[0]);
  Object.assign(event.onchainProof, {
    portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
    portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
    portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
    portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
  });
  event.evidence = clone(event.onchainProof);
  assert.equal(isStrictFlapPortalQuoteAssetUpdate(event), true);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, event), true);
});

test("a fresh direct Portal event reaches the real durable T1 Telegram pipeline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-real-alert-e2e-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let telegramPayload = null;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 56001 } }),
    };
  });
  t.mock.method(console, "info", () => {});
  const provider = new FakeBscProvider();
  const fixture = await harness(t, {
    provider,
    dataDir,
    config: {
      monitorScope: "focus3",
      blockedContracts: new Set(),
      telegramToken: "flap-quote-e2e-token",
      telegramChatId: "1234567890",
      telegramStrongAlerts: true,
      alertBilingualEnabled: true,
      alertChineseTranslationEnabled: false,
      alertTelegramDeliveryMaxAgeMs: 7_200_000,
      alertNow: () => Date.parse("2026-09-03T07:00:00.000Z"),
      webhookUrl: "",
    },
    sendAlertsImpl: async (runtimeConfig, directEvent) => {
      const event = clone(directEvent);
      Object.assign(event.onchainProof, {
        portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
        portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
        portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
        portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
      });
      event.evidence = clone(event.onchainProof);
      return sendAlerts(runtimeConfig, event);
    },
  });
  await fixture.monitor.check();
  addAssetEvent(provider, {
    address: FLAP_SQQQB_ADDRESS,
    name: "ProShares UltraPro Short QQQ ETF Tokenized Stock (bStock)",
    symbol: "SQQQB",
    configuration: [1, 56, 56, 7, 0],
    blockNumber: 99,
  });
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 1);
  assert.ok(telegramPayload);
  assert.equal(telegramPayload.disable_notification, false, "a valid fresh T1 is delivered immediately");
  assert.match(telegramPayload.text, /SQQQB/);
  assert.match(telegramPayload.text, new RegExp(lower(FLAP_SQQQB_ADDRESS), "i"));
  assert.match(telegramPayload.text, /bStock[^\n]*(?:不等于 ETF\/股票所有权|not ETF\/share ownership)/iu);
  assert.match(telegramPayload.text, /(?:非自动交易|no automatic trading)/iu);

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const [entry] = Object.values(outbox.events);
  assert.equal(entry.status, "delivered");
  assert.equal(entry.event.tradingPriority.tier, "T1");
  assert.equal(entry.event.tradingPriority.plan.automaticExecution, false);
  assert.equal(entry.destinations.telegram.status, "delivered");
  assert.equal(entry.destinations.telegram.receipt.messageId, 56001);
});

test("a stale direct Portal enable reaches the real durable T2 recovery pipeline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-real-recovery-e2e-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let telegramPayload = null;
  let telegramCalls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramCalls += 1;
    telegramPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 56002 } }),
    };
  });
  t.mock.method(console, "info", () => {});
  const provider = new FakeBscProvider();
  const realSender = async (runtimeConfig, directEvent) => {
    const event = clone(directEvent);
    Object.assign(event.onchainProof, {
      portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
      portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
      portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
      portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
    });
    event.evidence = clone(event.onchainProof);
    return sendAlerts(runtimeConfig, event);
  };
  const recoveryConfig = {
    monitorScope: "focus3",
    blockedContracts: new Set(),
    telegramToken: "flap-quote-recovery-token",
    telegramChatId: "1234567890",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertForceLocalStructured: true,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    alertBscRealtimeMaxAgeMs: 600_000,
    alertBscTelegramMaxAgeMs: 7_200_000,
    alertNow: () => Date.parse("2026-09-03T07:00:00.000Z"),
    webhookUrl: "",
  };
  const fixture = await harness(t, {
    provider,
    dataDir,
    config: recoveryConfig,
    sendAlertsImpl: realSender,
  });
  await fixture.monitor.check();
  addAssetEvent(provider, {
    address: FLAP_SQQQB_ADDRESS,
    name: "ProShares UltraPro Short QQQ ETF Tokenized Stock (bStock)",
    symbol: "SQQQB",
    configuration: [1, 56, 56, 7, 0],
    blockNumber: 99,
  });
  provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 1);
  assert.ok(telegramPayload);
  assert.match(telegramPayload.text, /(?:断线恢复补报|Delayed recovery)/u);
  assert.match(telegramPayload.text, /(?:勿追价|do not chase)/iu);
  assert.match(telegramPayload.text, /SQQQB/);
  assert.match(telegramPayload.text, new RegExp(lower(FLAP_SQQQB_ADDRESS), "i"));
  assert.match(telegramPayload.text, /(?:非自动交易|no automatic trading)/iu);

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const [entry] = Object.values(outbox.events);
  assert.equal(entry.status, "delivered");
  assert.equal(entry.event.tradingPriority.tier, "T2");
  assert.equal(entry.deliveryDisposition.reason, "flap_delayed_recovery");
  assert.equal(entry.event.tradingPriority.plan.automaticExecution, false);
  assert.equal(entry.event.delayedRecovery.lagMs, 20 * 60_000);
  assert.equal(entry.destinations.telegram.receipt.messageId, 56002);
  assert.equal(telegramCalls, 1);
  await fixture.monitor.stop();

  const restarted = await harness(t, {
    provider,
    dataDir,
    config: recoveryConfig,
    sendAlertsImpl: realSender,
  });
  const replay = await restarted.monitor.check();
  assert.equal(replay.status, "healthy");
  assert.equal(replay.delivered, 0);
  assert.equal(telegramCalls, 1, "durable cursor and outbox prevent a recovery replay after restart");
});

test("archive-state loss produces a truthful first-observed T2 through the real strict alert pipeline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-first-observed-e2e-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let telegramPayload = null;
  let telegramCalls = 0;
  let producedEvent = null;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramCalls += 1;
    telegramPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 56003 } }),
    };
  });
  t.mock.method(console, "info", () => {});
  const provider = new FakeBscProvider();
  const archiveUnavailableReader = (sourceId) => new FakeLogRpcEndpoint(sourceId, provider, {
    result: async (method, params) => {
      if (method === "eth_call"
        && typeof params[1] === "object"
        && params[0].data.slice(0, 10)
          === FLAP_PORTAL_INTERFACE.getFunction("getQuoteTokenConfiguration").selector) {
        const error = new Error("Archive requests require a personal token");
        error.code = -32602;
        throw error;
      }
      return provider.send(method, params);
    },
  });
  const stateReaders = [
    archiveUnavailableReader("https://first-observed-state-a.test"),
    archiveUnavailableReader("https://first-observed-state-b.test"),
  ];
  const runtimeConfig = {
    monitorScope: "focus3",
    blockedContracts: new Set(),
    telegramToken: "flap-quote-first-observed-token",
    telegramChatId: "1234567890",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    alertBscRealtimeMaxAgeMs: 600_000,
    alertBscTelegramMaxAgeMs: 7_200_000,
    alertNow: () => Date.parse("2026-09-03T07:00:00.000Z"),
    webhookUrl: "",
  };
  const realSender = async (alertConfig, directEvent) => {
    const event = clone(directEvent);
    Object.assign(event.onchainProof, {
      portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
      portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
      portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
      portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
    });
    event.evidence = clone(event.onchainProof);
    producedEvent = clone(event);
    assert.equal(isStrictFlapPortalQuoteAssetUpdate(event), true);
    assert.equal(isMonitoringSourceEnabled(alertConfig, event), true);
    return sendAlerts(alertConfig, event);
  };
  const fixture = await harness(t, {
    provider,
    dataDir,
    config: runtimeConfig,
    stateVerificationProviders: stateReaders.map((reader) => reader.descriptor()),
    sendAlertsImpl: realSender,
  });
  assert.equal((await fixture.monitor.check()).status, "baseline");
  addAssetEvent(provider, {
    address: FLAP_SQQQB_ADDRESS,
    name: "ProShares UltraPro Short QQQ ETF Tokenized Stock (bStock)",
    symbol: "SQQQB",
    configuration: [1, 56, 56, 7, 0],
    blockNumber: 99,
  });
  provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 1);
  assert.equal(producedEvent.kind, "flap_quote_asset_first_observed_after_gap");
  assert.equal(producedEvent.changeType, "observed");
  assert.equal(producedEvent.strong, false);
  assert.equal(producedEvent.priorTransitionProof, "unavailable");
  assert.deepEqual(producedEvent.priorStateRead, {
    blockNumber: 98,
    method: "getQuoteTokenConfiguration(address)",
    requiredIndependentReaders: 2,
    successfulReaders: 0,
    matchingUnavailableReaders: 2,
    failureClass: "archive_state_unavailable",
  });
  assert.equal(producedEvent.signal.headline, "Flap first observed SQQQB currently enabled after a monitoring gap");
  assert.equal(producedEvent.signal.quotePairChange.stage, "observed");
  assert.equal(producedEvent.changes.newFlapPools.length, 0);
  assert.equal(producedEvent.changes.updatedFlapPools.length, 1);
  assert.match(producedEvent.risk, /does not prove a new 0-to-1 activation/i);
  assert.ok(telegramPayload);
  assert.match(telegramPayload.text, /补扫首次观察/u);
  assert.match(telegramPayload.text, /(?:0→1 未证|未证明.*0→1)/u);
  assert.match(telegramPayload.text, /勿追价/u);
  assert.match(telegramPayload.text, /非自动交易/u);
  assert.match(telegramPayload.text, /SQQQB/);
  assert.match(telegramPayload.text, new RegExp(lower(FLAP_SQQQB_ADDRESS), "i"));

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const [entry] = Object.values(outbox.events);
  assert.equal(entry.status, "delivered");
  assert.equal(entry.event.tradingPriority.tier, "T2");
  assert.equal(entry.event.kind, "flap_quote_asset_first_observed_after_gap");
  assert.equal(entry.destinations.telegram.receipt.messageId, 56003);
  for (const reader of stateReaders) {
    assert.equal(reader.calls.filter(({ method, params }) => (
      method === "eth_call" && typeof params[1] === "object"
    )).length, 3, "persistent archive loss is retried three times per physical reader");
  }
  assert.equal(telegramCalls, 1);
  await fixture.monitor.stop();

  const restarted = await harness(t, {
    provider,
    dataDir,
    config: runtimeConfig,
    stateVerificationProviders: stateReaders.map((reader) => reader.descriptor()),
    sendAlertsImpl: realSender,
  });
  const replay = await restarted.monitor.check();
  assert.equal(replay.status, "healthy");
  assert.equal(replay.delivered, 0);
  assert.equal(telegramCalls, 1, "durable first-observed delivery is exact-once after restart");
});

test("historical prior-state quorum follows the fail-closed recovery truth table", async (t) => {
  await t.test("a transient archive miss recovers on the same hash and preserves the proven T1 path", async (subtest) => {
    const provider = new FakeBscProvider();
    const recoveringReader = stateReaderWithPriorMode(
      "https://prior-transient-archive.test",
      provider,
      "archive-once",
    );
    const fixture = await harness(subtest, {
      provider,
      stateVerificationProviders: [
        recoveringReader.descriptor(),
        stateReaderWithPriorMode("https://prior-transient-peer.test", provider).descriptor(),
      ],
    });
    assert.equal((await fixture.monitor.check()).status, "baseline");
    addAssetEvent(provider, { blockNumber: 99 });
    provider.head = 101;

    const result = await fixture.monitor.check();
    assert.equal(result.status, "healthy");
    assert.equal(result.delivered, 1);
    assert.equal(fixture.alerts[0].kind, "flap_quote_asset_enabled");
    assert.equal(fixture.alerts[0].changeType, "added");
    assert.equal(fixture.alerts[0].strong, true);
    assert.equal(fixture.alerts[0].priorTransitionProof, undefined);
    assert.equal(recoveringReader.calls.filter(({ method, params }) => (
      method === "eth_call" && typeof params[1] === "object"
    )).length, 2);
  });

  await t.test("one result plus one explicit archive loss emits only a stale first-observed event", async (subtest) => {
    const provider = new FakeBscProvider();
    const fixture = await harness(subtest, {
      provider,
      stateVerificationProviders: [
        stateReaderWithPriorMode("https://prior-one-success.test", provider).descriptor(),
        stateReaderWithPriorMode("https://prior-one-unavailable.test", provider, "archive-unavailable").descriptor(),
      ],
    });
    assert.equal((await fixture.monitor.check()).status, "baseline");
    addAssetEvent(provider, { blockNumber: 99 });
    provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
    provider.head = 101;

    const result = await fixture.monitor.check();
    assert.equal(result.status, "healthy");
    assert.equal(result.delivered, 1);
    assert.equal(fixture.alerts[0].kind, "flap_quote_asset_first_observed_after_gap");
    assert.equal(fixture.alerts[0].priorTransitionProof, "unavailable");
    assert.deepEqual(fixture.alerts[0].priorStateRead, {
      blockNumber: 98,
      method: "getQuoteTokenConfiguration(address)",
      requiredIndependentReaders: 2,
      successfulReaders: 1,
      matchingUnavailableReaders: 1,
      failureClass: "archive_state_unavailable",
    });
    assert.equal(fixture.alerts[0].changes.newFlapPools.length, 0);
    assert.equal(fixture.alerts[0].changes.updatedFlapPools.length, 1);
    assert.equal(fixture.lifecycles.length, 0, "first-observed-after-gap is never armed");
  });

  await t.test("one enabled result plus archive loss cannot suppress the stale first-observed event", async (subtest) => {
    const provider = new FakeBscProvider();
    const fixture = await harness(subtest, {
      provider,
      stateVerificationProviders: [
        stateReaderWithPriorMode(
          "https://prior-one-enabled.test",
          provider,
          [1, 32, 32, 7, 0],
        ).descriptor(),
        stateReaderWithPriorMode("https://prior-enabled-unavailable.test", provider, "archive-unavailable").descriptor(),
      ],
    });
    assert.equal((await fixture.monitor.check()).status, "baseline");
    addAssetEvent(provider, { blockNumber: 99 });
    provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
    provider.head = 101;

    const result = await fixture.monitor.check();
    assert.equal(result.status, "healthy");
    assert.equal(result.delivered, 1);
    assert.equal(fixture.alerts[0].kind, "flap_quote_asset_first_observed_after_gap");
    assert.deepEqual(fixture.alerts[0].priorStateRead, {
      blockNumber: 98,
      method: "getQuoteTokenConfiguration(address)",
      requiredIndependentReaders: 2,
      successfulReaders: 1,
      matchingUnavailableReaders: 1,
      failureClass: "archive_state_unavailable",
    });
    assert.equal(fixture.alerts[0].changeType, "observed");
    assert.equal(fixture.alerts[0].strong, false);
    assert.equal(fixture.monitor.state().auditTrail.length, 0);
  });

  await t.test("the exact BlockMachine pruned-state error retries then becomes bounded unavailable proof", async (subtest) => {
    const provider = new FakeBscProvider();
    const blockMachineReader = stateReaderWithPriorMode(
      "https://prior-blockmachine-pruned.test",
      provider,
      "blockmachine-pruned",
    );
    const fixture = await harness(subtest, {
      provider,
      stateVerificationProviders: [
        blockMachineReader.descriptor(),
        stateReaderWithPriorMode("https://prior-blockmachine-peer.test", provider).descriptor(),
      ],
    });
    assert.equal((await fixture.monitor.check()).status, "baseline");
    addAssetEvent(provider, { blockNumber: 99 });
    provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
    provider.head = 101;

    const result = await fixture.monitor.check();
    assert.equal(result.status, "healthy");
    assert.equal(result.delivered, 1);
    assert.equal(fixture.alerts[0].kind, "flap_quote_asset_first_observed_after_gap");
    assert.deepEqual(fixture.alerts[0].priorStateRead, {
      blockNumber: 98,
      method: "getQuoteTokenConfiguration(address)",
      requiredIndependentReaders: 2,
      successfulReaders: 1,
      matchingUnavailableReaders: 1,
      failureClass: "archive_state_unavailable",
    });
    assert.equal(blockMachineReader.calls.filter(({ method, params }) => (
      method === "eth_call" && typeof params[1] === "object"
    )).length, 3);
  });

  await t.test("two conflicting successful historical reads freeze the cursor", async (subtest) => {
    const provider = new FakeBscProvider();
    const fixture = await harness(subtest, {
      provider,
      stateVerificationProviders: [
        stateReaderWithPriorMode("https://prior-disabled.test", provider).descriptor(),
        stateReaderWithPriorMode("https://prior-enabled.test", provider, [1, 32, 32, 7, 0]).descriptor(),
      ],
    });
    assert.equal((await fixture.monitor.check()).status, "baseline");
    const before = clone(fixture.monitor.state().cursor);
    addAssetEvent(provider, { blockNumber: 99 });
    provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
    provider.head = 101;

    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_PRIOR_CONFIGURATION_MISMATCH");
    assert.deepEqual(fixture.monitor.state().cursor, before);
    assert.equal(fixture.alerts.length, 0);
  });

  await t.test("fresh archive loss waits instead of inventing a transition or first-observed alert", async (subtest) => {
    const provider = new FakeBscProvider();
    const fixture = await harness(subtest, {
      provider,
      stateVerificationProviders: [
        stateReaderWithPriorMode("https://fresh-prior-a.test", provider, "archive-unavailable").descriptor(),
        stateReaderWithPriorMode("https://fresh-prior-b.test", provider, "archive-unavailable").descriptor(),
      ],
    });
    assert.equal((await fixture.monitor.check()).status, "baseline");
    const before = clone(fixture.monitor.state().cursor);
    addAssetEvent(provider, { blockNumber: 99 });
    provider.head = 101;

    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_PRIOR_CONFIGURATION_REDUNDANCY_INCOMPLETE");
    assert.deepEqual(fixture.monitor.state().cursor, before);
    assert.equal(fixture.alerts.length, 0);
  });

  for (const [label, mode] of [["timeout", "timeout"], ["rate limit", "rate-limited"]]) {
    await t.test(`${label} is not misclassified as proof of archive-state loss`, async (subtest) => {
      const provider = new FakeBscProvider();
      const fixture = await harness(subtest, {
        provider,
        stateVerificationProviders: [
          stateReaderWithPriorMode(`https://ordinary-failure-${mode}-a.test`, provider, mode).descriptor(),
          stateReaderWithPriorMode(`https://ordinary-failure-${mode}-b.test`, provider, "archive-unavailable").descriptor(),
        ],
      });
      assert.equal((await fixture.monitor.check()).status, "baseline");
      const before = clone(fixture.monitor.state().cursor);
      addAssetEvent(provider, { blockNumber: 99 });
      provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
      provider.head = 101;

      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, "FLAP_QUOTE_PRIOR_CONFIGURATION_UNAVAILABLE");
      assert.deepEqual(fixture.monitor.state().cursor, before);
      assert.equal(fixture.alerts.length, 0);
    });
  }

  for (const [label, mode] of [
    ["near-match with the wrong JSON-RPC code", "blockmachine-wrong-code"],
    ["ordinary contract revert", "ordinary-revert"],
  ]) {
    await t.test(`${label} cannot impersonate archive-state loss`, async (subtest) => {
      const provider = new FakeBscProvider();
      const fixture = await harness(subtest, {
        provider,
        stateVerificationProviders: [
          stateReaderWithPriorMode(`https://archive-impostor-${mode}.test`, provider, mode).descriptor(),
          stateReaderWithPriorMode("https://archive-impostor-peer.test", provider, "archive-unavailable").descriptor(),
        ],
      });
      assert.equal((await fixture.monitor.check()).status, "baseline");
      const before = clone(fixture.monitor.state().cursor);
      addAssetEvent(provider, { blockNumber: 99 });
      provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
      provider.head = 101;

      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, "FLAP_QUOTE_PRIOR_CONFIGURATION_UNAVAILABLE");
      assert.deepEqual(fixture.monitor.state().cursor, before);
      assert.equal(fixture.alerts.length, 0);
    });
  }

  await t.test("a same-range explicit disable proves the following enable without archive fallback", async (subtest) => {
    const provider = new FakeBscProvider();
    const stateReaders = [
      stateReaderWithPriorMode("https://sequence-prior-a.test", provider, "archive-unavailable"),
      stateReaderWithPriorMode("https://sequence-prior-b.test", provider, "archive-unavailable"),
    ];
    const fixture = await harness(subtest, {
      provider,
      stateVerificationProviders: stateReaders.map((reader) => reader.descriptor()),
    });
    assert.equal((await fixture.monitor.check()).status, "baseline");
    const enabled = [1, 32, 32, 7, 0];
    const disabled = [0, 32, 32, 7, 0];
    provider.setAsset(FLAP_MRNAB_ADDRESS, {
      name: "Moderna",
      symbol: "MRNAB",
      decimals: 18,
      configuration: enabled,
    });
    provider.addQuoteEvent({
      address: FLAP_MRNAB_ADDRESS,
      configuration: disabled,
      blockNumber: 99,
      transactionHash: id("same-range-disable"),
      logIndex: 10,
    });
    const enable = provider.addQuoteEvent({
      address: FLAP_MRNAB_ADDRESS,
      configuration: enabled,
      blockNumber: 100,
      transactionHash: id("same-range-reenable"),
      logIndex: 11,
    });
    provider.head = 102;

    const result = await fixture.monitor.check();
    assert.equal(result.status, "healthy");
    assert.equal(result.delivered, 1);
    assert.equal(fixture.alerts[0].kind, "flap_quote_asset_enabled");
    assert.equal(fixture.alerts[0].eventKey, flapQuoteEventKey(enable));
    assert.equal(fixture.alerts[0].strong, true);
    assert.equal(fixture.alerts[0].changes.newFlapPools.length, 1);
    for (const reader of stateReaders) {
      assert.equal(reader.calls.filter(({ method, params }) => (
        method === "eth_call" && typeof params[1] === "object"
      )).length, 0, "the preceding canonical disable is the transition proof");
    }
  });
});

test("a queued fresh alert holds the cursor, then recovers once as T2 after the trading window", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-queued-to-recovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let clockMs = Date.parse("2026-09-03T07:00:00.000Z");
  let failTelegram = true;
  let telegramAttempts = 0;
  const deliveredPayloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramAttempts += 1;
    if (failTelegram) throw new Error("simulated Telegram outage");
    deliveredPayloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 56003 } }),
    };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const provider = new FakeBscProvider();
  const runtimeConfig = {
    monitorScope: "focus3",
    blockedContracts: new Set(),
    telegramToken: "flap-quote-queued-recovery-token",
    telegramChatId: "1234567890",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    alertBscRealtimeMaxAgeMs: 600_000,
    alertBscTelegramMaxAgeMs: 7_200_000,
    alertRetryIntervalMs: 1_000,
    alertNow: () => clockMs,
    webhookUrl: "",
  };
  const realSender = async (alertConfig, directEvent) => {
    const event = clone(directEvent);
    Object.assign(event.onchainProof, {
      portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
      portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
      portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
      portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
    });
    event.evidence = clone(event.onchainProof);
    return sendAlerts(alertConfig, event);
  };
  const first = await harness(t, {
    provider,
    dataDir,
    now: () => clockMs,
    config: runtimeConfig,
    sendAlertsImpl: realSender,
  });
  await first.monitor.check();
  const log = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  const queued = await first.monitor.check();
  assert.equal(queued.errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
  assert.equal(first.monitor.state().cursor.nextBlock, 100);
  assert.equal(first.monitor.state().processedEventKeys.length, 1);
  assert.equal(first.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(log));
  assert.equal(telegramAttempts, 1);
  const originalEventKey = flapQuoteEventKey(log);
  let outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.ok(outbox.events[originalEventKey]);
  assert.notEqual(outbox.events[originalEventKey].status, "delivered");

  clockMs += 2 * 60 * 60_000;
  failTelegram = false;
  const recovered = await first.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(deliveredPayloads.length, 1);
  assert.equal(deliveredPayloads[0].disable_notification, true);
  assert.match(deliveredPayloads[0].text, /(?:断线恢复补报|Delayed recovery)/u);
  assert.equal(first.monitor.state().processedEventKeys[0], originalEventKey);

  outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const recovery = Object.values(outbox.events).find((entry) => entry.event?.delayedRecovery);
  assert.ok(recovery);
  assert.equal(recovery.status, "delivered");
  assert.equal(recovery.event.eventKey, `${originalEventKey}:delayed-recovery:v1`);
  assert.equal(recovery.event.tradingPriority.tier, "T2");
  await first.monitor.stop();

  const restarted = await harness(t, {
    provider,
    dataDir,
    now: () => clockMs,
    config: runtimeConfig,
    sendAlertsImpl: realSender,
  });
  assert.equal((await restarted.monitor.check()).status, "healthy");
  assert.equal(deliveredPayloads.length, 1);
});

test("receipt, canonical block and confirmation mismatches never consume the event", async (t) => {
  await t.test("failed receipt", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    const before = clone(fixture.monitor.state().cursor);
    const log = addAssetEvent(fixture.provider);
    fixture.provider.receipts.get(lower(log.transactionHash)).status = 0;
    fixture.provider.head = 101;
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_RECEIPT_MISMATCH");
    assert.deepEqual(fixture.monitor.state().cursor, before);
    assert.equal(fixture.alerts.length, 0);
  });

  await t.test("receipt block hash mismatch", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    const before = clone(fixture.monitor.state().cursor);
    const log = addAssetEvent(fixture.provider);
    fixture.provider.receipts.get(lower(log.transactionHash)).blockHash = id("wrong-receipt-block");
    fixture.provider.head = 101;
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_RECEIPT_MISMATCH");
    assert.deepEqual(fixture.monitor.state().cursor, before);
    assert.equal(fixture.alerts.length, 0);
  });

  await t.test("insufficient confirmations", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    addAssetEvent(fixture.provider, { blockNumber: 99 });
    fixture.provider.head = 100;
    const result = await fixture.monitor.check();
    assert.equal(result.status, "healthy");
    assert.equal(fixture.alerts.length, 0, "the non-finalized event is outside the requested scan range");
    assert.equal(fixture.monitor.state().cursor.nextBlock, 99);
  });
});

test("a finalized anchor reorg performs a durable rewind before rescanning", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  fixture.provider.head = 101;
  await fixture.monitor.check();
  assert.equal(fixture.monitor.state().cursor.anchorBlock, 99);
  fixture.provider.setBlockHash(99, id("replacement-bsc-99"));
  fixture.provider.head = 102;
  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.reorgRecovered, true);
  assert.equal(fixture.monitor.state()._health.reorgCount, 1);
  assert.equal(fixture.monitor.state().cursor.nextBlock, 101);
  assert.equal(fixture.monitor.state().auditTrail.at(-1).type, "flap_quote_reorg_audit");
  assert.equal(fixture.alerts.length, 0);
});

test("a stale pooled block view cannot hide a reorg seen by both fixed readers", async (t) => {
  const canonical = new FakeBscProvider();
  const oldBlockHash = canonical.hash(99);
  let stalePoolBlockReads = 0;
  const primary = {
    getNetwork: (...args) => canonical.getNetwork(...args),
    send: (...args) => canonical.send(...args),
    getBlockNumber: (...args) => canonical.getBlockNumber(...args),
    getBlock: async (blockNumber) => {
      stalePoolBlockReads += 1;
      if (Number(blockNumber) === 99) {
        return {
          number: 99,
          hash: oldBlockHash,
          parentHash: canonical.hash(98),
          timestamp: canonical.blockTimestamps.get(99) || 1_788_418_795,
        };
      }
      return canonical.getBlock(blockNumber);
    },
    getCode: (...args) => canonical.getCode(...args),
    getStorage: (...args) => canonical.getStorage(...args),
    call: (...args) => canonical.call(...args),
    getTransactionReceipt: (...args) => canonical.getTransactionReceipt(...args),
    getTransaction: (...args) => canonical.getTransaction(...args),
  };
  const firstReader = new FakeLogRpcEndpoint("https://canonical-reorg-a.test", canonical);
  const secondReader = new FakeLogRpcEndpoint("https://canonical-reorg-b.test", canonical);
  const firstStateReader = new FakeLogRpcEndpoint("https://canonical-state-a.test", canonical);
  const secondStateReader = new FakeLogRpcEndpoint("https://canonical-state-b.test", canonical);
  const fixture = await harness(t, {
    provider: primary,
    logVerificationProviders: [firstReader.descriptor(), secondReader.descriptor()],
    stateVerificationProviders: [firstStateReader.descriptor(), secondStateReader.descriptor()],
  });
  await fixture.monitor.check();
  addAssetEvent(canonical, { blockNumber: 99, transactionHash: id("old-pooled-anchor-event") });
  canonical.head = 101;
  assert.equal((await fixture.monitor.check()).delivered, 1);

  const replacementHash = id("fixed-readers-new-anchor");
  canonical.setBlockHash(99, replacementHash);
  canonical.logs = [];
  canonical.receipts.clear();
  canonical.transactions.clear();
  const replacement = canonical.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [1, 32, 32, 7, 0],
    blockNumber: 99,
    blockHash: replacementHash,
    transactionHash: id("fixed-reader-canonical-replacement"),
    logIndex: 12,
  });

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.reorgRecovered, true);
  assert.equal(result.delivered, 1);
  assert.equal(fixture.alerts.at(-1).eventKey, flapQuoteEventKey(replacement));
  assert.equal(fixture.alerts.length, 2);
  assert.equal(stalePoolBlockReads, 0, "canonical block decisions never consult the rotating primary facade");
});

test("a canonical replacement may reuse tx plus log index without persisted orphan overlap", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-same-key-reorg-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider();
  const fixture = await harness(t, { provider, dataDir });
  await fixture.monitor.check();
  const transactionHash = id("same-event-key-across-reorg");
  const oldLog = addAssetEvent(provider, { blockNumber: 99, transactionHash, logIndex: 12 });
  provider.head = 101;
  assert.equal((await fixture.monitor.check()).delivered, 1);

  const replacementHash = lower(id("same-key-canonical-replacement-block"));
  provider.setBlockHash(99, replacementHash);
  provider.logs = [];
  provider.receipts.delete(lower(transactionHash));
  provider.transactions.delete(lower(transactionHash));
  provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [1, 32, 32, 7, 0],
    blockNumber: 99,
    blockHash: replacementHash,
    transactionHash,
    logIndex: 12,
  });

  const recovered = await fixture.monitor.check();
  const eventKey = flapQuoteEventKey(oldLog);
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.reorgRecovered, true);
  assert.equal(recovered.delivered, 1);
  assert.equal(fixture.alerts.length, 2);
  assert.ok(fixture.alerts[1].reorgOrphanedEventKeys.includes(eventKey));
  assert.deepEqual(fixture.monitor.state().processedEventKeys, [eventKey]);
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(eventKey));
  assert.equal(fixture.monitor.state().eventRecords[0].blockHash, replacementHash);
  assert.equal(fixture.lifecycles.length, 2);
  assert.deepEqual(fixture.lifecycles.map(({ action, activationEventKey }) => ({ action, activationEventKey })), [
    { action: "activated", activationEventKey: eventKey },
    { action: "activated", activationEventKey: eventKey },
  ], "the replacement is handed off again even though its base producer key is unchanged");
  assert.equal(fixture.lifecycles[0].blockHash, lower(oldLog.blockHash));
  assert.equal(fixture.lifecycles[1].blockHash, replacementHash);
  await fixture.monitor.stop();

  const restarted = await harness(t, { provider, dataDir });
  const afterRestart = await restarted.monitor.check();
  assert.equal(afterRestart.status, "healthy");
  assert.notEqual(afterRestart.errorCode, "FLAP_QUOTE_STATE_INVALID");
});

test("an orphaned disable durably restores its exact activation generation across restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-disable-restore-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider();
  const lifecycles = [];
  let restoreAttempts = 0;
  const lifecycle = async (record) => {
    lifecycles.push(structuredClone(record));
    if (record.action === "restored") {
      restoreAttempts += 1;
      if (restoreAttempts === 1) return { accepted: false, status: "queued" };
    }
    return {
      accepted: true,
      changed: true,
      action: record.action,
      status: record.action,
      quoteAddress: record.quoteAddress,
      generationKey: "test-generation",
    };
  };
  const first = await harness(t, { provider, dataDir, onFlapQuotePoolLifecycle: lifecycle });
  await first.monitor.check();
  const enable = addAssetEvent(provider, {
    blockNumber: 99,
    transactionHash: id("enable-before-orphaned-disable"),
    transactionIndex: 3,
    logIndex: 13,
  });
  provider.head = 101;
  assert.equal((await first.monitor.check()).delivered, 1);

  const disabled = [0, 32, 32, 7, 0];
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  provider.setBlockTimestamp(100, Date.parse("2026-09-03T07:01:00.000Z") / 1_000);
  const disable = provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 100,
    transactionHash: id("orphaned-disable-lifecycle"),
    transactionIndex: 5,
    logIndex: 15,
  });
  provider.head = 102;
  assert.equal((await first.monitor.check()).status, "healthy");
  assert.deepEqual(lifecycles.map(({ action }) => action), ["activated", "disabled"]);

  provider.setBlockHash(100, id("replacement-without-disable"));
  provider.logs = provider.logs.filter((log) => flapQuoteEventKey(log) !== flapQuoteEventKey(disable));
  provider.receipts.delete(lower(disable.transactionHash));
  provider.transactions.delete(lower(disable.transactionHash));
  provider.configurationHistory.set(lower(FLAP_MRNAB_ADDRESS), (
    provider.configurationHistory.get(lower(FLAP_MRNAB_ADDRESS)) || []
  ).filter((entry) => entry.blockNumber !== disable.blockNumber));
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, [1, 32, 32, 7, 0]);

  const held = await first.monitor.check();
  assert.equal(held.errorCode, "FLAP_QUOTE_LIFECYCLE_NOT_DURABLE");
  assert.equal(first.monitor.state().quoteAssets[lower(FLAP_MRNAB_ADDRESS)].enabled, false,
    "a non-durable restore cannot commit the reorg rewind");
  await first.monitor.stop();

  const restarted = await harness(t, { provider, dataDir, onFlapQuotePoolLifecycle: lifecycle });
  const recovered = await restarted.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.reorgRecovered, true);
  assert.equal(restarted.monitor.state().quoteAssets[lower(FLAP_MRNAB_ADDRESS)].enabled, true);
  assert.equal(restoreAttempts, 2);
  assert.deepEqual(lifecycles.map(({ action }) => action), ["activated", "disabled", "restored", "restored"]);
  const restored = lifecycles.at(-1);
  assert.equal(restored.activationEventKey, flapQuoteEventKey(disable));
  assert.equal(restored.targetActivationEventKey, flapQuoteEventKey(enable));
  assert.equal(restored.transactionHash, lower(disable.transactionHash));
  assert.equal(restored.blockHash, lower(disable.blockHash));
  assert.equal(restored.transactionIndex, 5);
  assert.equal(restored.logIndex, 15);
  assert.equal(restored.occurredAt, "2026-09-03T07:01:00.000Z");
  assert.equal(restored.proofType, "verified_disable_orphaned");
  assert.equal(restored.monitorOnly, true);
  assert.deepEqual(lifecycles.at(-2), restored, "restart retries the identical restore proof");

  await restarted.monitor.stop();
  const stableRestart = await harness(t, { provider, dataDir, onFlapQuotePoolLifecycle: lifecycle });
  assert.equal((await stableRestart.monitor.check()).status, "healthy");
  assert.equal(restoreAttempts, 2, "a committed restore is not emitted again after restart");
});

test("an orphaned disable is not restored when fixed finalized state remains disabled", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  addAssetEvent(fixture.provider, {
    blockNumber: 99,
    transactionHash: id("enable-before-replaced-disable"),
    logIndex: 13,
  });
  fixture.provider.head = 101;
  assert.equal((await fixture.monitor.check()).delivered, 1);

  const disabled = [0, 32, 32, 7, 0];
  fixture.provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  const orphanedDisable = fixture.provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 100,
    transactionHash: id("disable-on-old-fork"),
    logIndex: 15,
  });
  fixture.provider.head = 102;
  assert.equal((await fixture.monitor.check()).status, "healthy");

  const replacementHash = lower(id("replacement-still-disabled"));
  fixture.provider.setBlockHash(100, replacementHash);
  fixture.provider.logs = fixture.provider.logs.filter((log) => flapQuoteEventKey(log) !== flapQuoteEventKey(orphanedDisable));
  fixture.provider.receipts.delete(lower(orphanedDisable.transactionHash));
  fixture.provider.transactions.delete(lower(orphanedDisable.transactionHash));
  fixture.provider.configurationHistory.set(lower(FLAP_MRNAB_ADDRESS), (
    fixture.provider.configurationHistory.get(lower(FLAP_MRNAB_ADDRESS)) || []
  ).filter((entry) => entry.blockNumber !== orphanedDisable.blockNumber));
  fixture.provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  fixture.provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 100,
    blockHash: replacementHash,
    transactionHash: id("disable-on-new-fork"),
    logIndex: 16,
  });

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.reorgRecovered, true);
  assert.equal(fixture.monitor.state().quoteAssets[lower(FLAP_MRNAB_ADDRESS)].enabled, false);
  assert.equal(fixture.lifecycles.filter(({ action }) => action === "restored").length, 0,
    "an orphan hash alone cannot restore while both fixed state readers prove disabled");
  assert.deepEqual(fixture.lifecycles.map(({ action }) => action), ["activated", "disabled", "disabled"]);
});

test("reorg of a finalized decision snapshot replays earlier canonical events it influenced", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-decision-reorg-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider({ head: 102 });
  const fixture = await harness(t, { provider, dataDir });
  assert.equal((await fixture.monitor.check()).cursor.anchorBlock, 100);

  const enableLog = addAssetEvent(provider, {
    blockNumber: 101,
    transactionHash: id("enable-before-reorged-disable"),
    logIndex: 10,
  });
  const disabled = [0, 32, 32, 7, 0];
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  const disableLog = provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 102,
    transactionHash: id("disable-that-will-be-reorged"),
    logIndex: 11,
  });
  provider.head = 104;
  const initiallyFinal = await fixture.monitor.check();
  assert.equal(initiallyFinal.delivered, 0, "the finalized disable suppresses the earlier transient enable");
  assert.equal(fixture.monitor.state().cursor.anchorBlock, 102);
  assert.deepEqual(fixture.monitor.state().eventRecords.map((item) => item.configurationVerifiedAtBlock), [102, 102]);

  const replacementHash = lower(id("replacement-finalized-decision-block"));
  provider.setBlockHash(102, replacementHash);
  provider.logs = provider.logs.filter((log) => flapQuoteEventKey(log) !== flapQuoteEventKey(disableLog));
  provider.configurationHistory.set(lower(FLAP_MRNAB_ADDRESS), (
    provider.configurationHistory.get(lower(FLAP_MRNAB_ADDRESS)) || []
  ).filter((entry) => entry.blockNumber !== 102));
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, [1, 32, 32, 7, 0]);

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.reorgRecovered, true);
  assert.equal(recovered.delivered, 1);
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].eventKey, flapQuoteEventKey(enableLog));
  assert.equal(fixture.alerts[0].blockNumber, 101);
  assert.equal(fixture.monitor.state().auditTrail.find((item) => item.type === "flap_quote_reorg_audit").rewoundToBlock, 100);
  assert.deepEqual(fixture.monitor.state().processedEventKeys, [flapQuoteEventKey(enableLog)]);
  await fixture.monitor.stop();

  const restarted = await harness(t, { provider, dataDir });
  assert.equal((await restarted.monitor.check()).status, "healthy");
});

test("dependency-only replay does not mark an already delivered canonical event orphaned", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  const attempts = [];
  const visible = new Set();
  const fixture = await harness(t, {
    provider,
    sendAlertsImpl: async (_config, event) => {
      attempts.push(event);
      if (visible.has(event.eventKey)) {
        return { status: "suppressed", persisted: true, canonicalOwnerDelivered: true, reason: "semantic_duplicate" };
      }
      visible.add(event.eventKey);
      return { status: "delivered" };
    },
  });
  await fixture.monitor.check();
  const enableLog = addAssetEvent(provider, { blockNumber: 101 });
  provider.head = 104;
  assert.equal((await fixture.monitor.check()).delivered, 1);
  const eventKey = flapQuoteEventKey(enableLog);

  provider.setBlockHash(102, id("decision-snapshot-reorg-same-result"));
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.reorgRecovered, true);
  assert.equal(attempts.length, 2, "the canonical event is re-evaluated against the replacement snapshot");
  assert.equal(visible.size, 1, "the durable semantic duplicate is not emitted again");
  assert.ok(!attempts[1].reorgOrphanedEventKeys.includes(eventKey));
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(eventKey));
});

test("a far-ahead finalized snapshot reorg is detected while the catch-up anchor stays canonical", async (t) => {
  const provider = new FakeBscProvider({ head: 102 });
  const fixture = await harness(t, {
    provider,
    config: { flapQuoteEventChunkSize: 100, flapQuoteMaxBlocksPerCycle: 100 },
  });
  assert.equal((await fixture.monitor.check()).cursor.anchorBlock, 100);
  const enableLog = addAssetEvent(provider, { blockNumber: 101 });
  const disabled = [0, 32, 32, 7, 0];
  provider.seedConfigurationHistory(FLAP_MRNAB_ADDRESS, 5_000, disabled, 0);
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  provider.head = 5_002;

  const initialCatchup = await fixture.monitor.check();
  assert.equal(initialCatchup.delivered, 0);
  assert.equal(fixture.monitor.state().cursor.anchorBlock, 200);
  assert.equal(fixture.monitor.state().eventRecords[0].configurationVerifiedAtBlock, 5_000);
  const canonicalAnchorHash = fixture.monitor.state().cursor.anchorBlockHash;

  provider.setBlockHash(5_000, id("far-finalized-snapshot-reorg"));
  provider.configurationHistory.set(lower(FLAP_MRNAB_ADDRESS), (
    provider.configurationHistory.get(lower(FLAP_MRNAB_ADDRESS)) || []
  ).filter((entry) => entry.blockNumber !== 5_000));
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, [1, 32, 32, 7, 0]);

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.reorgRecovered, true);
  assert.equal(recovered.delivered, 0, "the candidate waits until the fixed finalized snapshot is fully scanned");
  assert.equal(fixture.alerts.length, 0);
  assert.equal(fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(enableLog));
  assert.equal(fixture.monitor.state().cursor.anchorBlockHash, canonicalAnchorHash);
  await fixture.monitor.stop();

  const resumed = await harness(t, {
    provider,
    dataDir: fixture.dataDir,
    config: { flapQuoteEventChunkSize: 1_000, flapQuoteMaxBlocksPerCycle: 5_000 },
  });
  const caughtUp = await resumed.monitor.check();
  assert.equal(caughtUp.status, "healthy");
  assert.equal(caughtUp.caughtUp, true);
  assert.equal(caughtUp.delivered, 1);
  assert.equal(resumed.alerts[0].eventKey, flapQuoteEventKey(enableLog));
});

test("a mid-delivery reorg retains orphan provenance and passes it to the canonical replacement", async (t) => {
  const provider = new FakeBscProvider();
  const delivered = [];
  let first = true;
  const replacementHash = id("replacement-during-delivery");
  const fixture = await harness(t, {
    provider,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      if (first) {
        first = false;
        provider.setBlockHash(99, replacementHash);
      }
      return { status: "delivered" };
    },
  });
  await fixture.monitor.check();
  const oldLog = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  const orphaned = await fixture.monitor.check();
  assert.equal(orphaned.errorCode, "FLAP_QUOTE_PRECOMMIT_REORG");
  assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
  const oldKey = flapQuoteEventKey(oldLog);
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(oldKey));
  assert.equal(fixture.monitor.state().eventRecords[0].delivered, true);
  assert.equal(fixture.monitor.state().auditTrail.at(-1).action, "delivered_proof_orphaned_before_commit");

  provider.logs = [];
  const replacementTx = id("canonical-replacement-transaction");
  provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [1, 32, 32, 7, 0],
    blockNumber: 99,
    blockHash: replacementHash,
    transactionHash: replacementTx,
    logIndex: 12,
  });
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(delivered.length, 2);
  assert.ok(delivered[1].reorgOrphanedEventKeys.includes(oldKey));
  assert.equal(delivered[1].transactionHash, replacementTx);
  assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
});

test("a mid-delivery finalized-snapshot reorg never marks the canonical event proof orphaned", async (t) => {
  const provider = new FakeBscProvider();
  const attempts = [];
  const visible = new Set();
  let first = true;
  const fixture = await harness(t, {
    provider,
    sendAlertsImpl: async (_config, event) => {
      attempts.push(event);
      if (first) {
        first = false;
        provider.setBlockHash(100, id("mid-delivery-snapshot-only-reorg"));
      }
      if (visible.has(event.eventKey)) {
        return { status: "suppressed", persisted: true, canonicalOwnerDelivered: true, reason: "semantic_duplicate" };
      }
      visible.add(event.eventKey);
      return { status: "delivered" };
    },
  });
  await fixture.monitor.check();
  const log = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 102;
  const eventKey = flapQuoteEventKey(log);

  const interrupted = await fixture.monitor.check();
  assert.equal(interrupted.errorCode, "FLAP_QUOTE_PRECOMMIT_REORG");
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(eventKey));
  assert.equal(visible.size, 1);

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(attempts.length, 2);
  assert.equal(visible.size, 1, "the canonical proof reuses the durable first delivery");
  assert.ok(!attempts[1].reorgOrphanedEventKeys.includes(eventKey));
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(eventKey));
});

test("a post-delivery canonical lookup timeout retries without falsely orphaning or reposting", async (t) => {
  const provider = new FakeBscProvider();
  const firstReader = new FakeLogRpcEndpoint("https://post-send-timeout-a.test", provider);
  const secondReader = new FakeLogRpcEndpoint("https://post-send-timeout-b.test", provider);
  let failedReadsRemaining = 0;
  for (const reader of [firstReader, secondReader]) {
    reader.getBlock = async (blockNumber) => {
      if (Number(blockNumber) === 99 && failedReadsRemaining > 0) {
        failedReadsRemaining -= 1;
        const error = new Error("temporary fixed-reader timeout");
        error.code = "TIMEOUT";
        throw error;
      }
      return provider.getBlock(blockNumber);
    };
  }
  const visible = new Set();
  let senderAttempts = 0;
  let posts = 0;
  const fixture = await harness(t, {
    provider,
    logVerificationProviders: [firstReader.descriptor(), secondReader.descriptor()],
    sendAlertsImpl: async (_config, event) => {
      senderAttempts += 1;
      if (visible.has(event.eventKey)) {
        return { status: "suppressed", persisted: true, canonicalOwnerDelivered: true, reason: "semantic_duplicate" };
      }
      visible.add(event.eventKey);
      posts += 1;
      failedReadsRemaining = 2;
      return { status: "delivered" };
    },
  });
  await fixture.monitor.check();
  const log = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  const eventKey = flapQuoteEventKey(log);

  const interrupted = await fixture.monitor.check();
  assert.equal(interrupted.errorCode, "FLAP_QUOTE_PRECOMMIT_REORG");
  assert.equal(fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, eventKey);
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(eventKey));
  assert.equal(fixture.monitor.state().eventRecords[0].delivered, false);

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(senderAttempts, 2);
  assert.equal(posts, 1, "the durable semantic duplicate performs no second external POST");
  assert.equal(Object.keys(fixture.monitor.state().pendingEnableCandidates).length, 0);
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(eventKey));
});

test("a stale recovery orphaned mid-delivery does not hide its canonical recovery replacement", async (t) => {
  const provider = new FakeBscProvider();
  provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
  const delivered = [];
  let first = true;
  const replacementHash = id("stale-recovery-replacement-block");
  const fixture = await harness(t, {
    provider,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      if (first) {
        first = false;
        provider.setBlockHash(99, replacementHash);
      }
      return { status: "delivered", eventId: event.eventKey };
    },
  });
  await fixture.monitor.check();
  const oldLog = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;

  const orphaned = await fixture.monitor.check();
  assert.equal(orphaned.errorCode, "FLAP_QUOTE_PRECOMMIT_REORG");
  const oldBaseKey = flapQuoteEventKey(oldLog);
  assert.equal(delivered[0].eventKey, `${oldBaseKey}:delayed-recovery:v1`);
  assert.ok(!fixture.monitor.state().reorgOrphanedEventKeys.includes(oldBaseKey));
  assert.equal(fixture.monitor.state().eventRecords[0].delivered, true);

  provider.logs = [];
  const replacementTx = id("stale-canonical-replacement-transaction");
  const replacement = provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [1, 32, 32, 7, 0],
    blockNumber: 99,
    blockHash: replacementHash,
    transactionHash: replacementTx,
    logIndex: 12,
  });
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].eventKey, `${flapQuoteEventKey(replacement)}:delayed-recovery:v1`);
  assert.ok(delivered[1].reorgOrphanedEventKeys.includes(oldBaseKey));
  assert.equal(delivered[1].transactionHash, replacementTx);
});

test("log schema and finalized ERC-20 metadata failures are fail-closed", async (t) => {
  await t.test("removed log", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    const before = clone(fixture.monitor.state().cursor);
    const log = addAssetEvent(fixture.provider);
    fixture.provider.returnLogs = () => [{ ...log, removed: true }];
    fixture.provider.head = 101;
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_LOG_BOUNDARY_INVALID");
    assert.deepEqual(fixture.monitor.state().cursor, before);
    assert.equal(fixture.provider.receiptCalls, 0);
  });

  await t.test("anonymous/indexed-looking topic shape", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    const before = clone(fixture.monitor.state().cursor);
    const log = addAssetEvent(fixture.provider);
    fixture.provider.returnLogs = () => [{ ...log, topics: [...log.topics, id("foreign-indexed-value")] }];
    fixture.provider.head = 101;
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_LOG_BOUNDARY_INVALID");
    assert.deepEqual(fixture.monitor.state().cursor, before);
  });

  await t.test("invalid token symbol", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    const before = clone(fixture.monitor.state().cursor);
    addAssetEvent(fixture.provider, { symbol: "MRNA B 🚩" });
    fixture.provider.head = 101;
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_METADATA_INVALID");
    assert.deepEqual(fixture.monitor.state().cursor, before);
    assert.equal(fixture.alerts.length, 0);
  });

  await t.test("missing token runtime", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    const before = clone(fixture.monitor.state().cursor);
    addAssetEvent(fixture.provider);
    fixture.provider.assets.get(lower(FLAP_MRNAB_ADDRESS)).code = "0x";
    fixture.provider.head = 101;
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "FLAP_QUOTE_CODE_EMPTY");
    assert.deepEqual(fixture.monitor.state().cursor, before);
    assert.equal(fixture.alerts.length, 0);
  });
});

test("ERC-20 metadata accepts realistic symbols and rejects unsafe display identities", async (t) => {
  for (const symbol of ["Brk.B", "X", "Ab9_$.-z"]) {
    await t.test(`valid symbol ${symbol}`, async (subtest) => {
      const fixture = await harness(subtest);
      await fixture.monitor.check();
      addAssetEvent(fixture.provider, { symbol, name: "Verified Quote Asset", blockNumber: 99 });
      fixture.provider.head = 101;
      const result = await fixture.monitor.check();
      assert.equal(result.status, "healthy");
      assert.equal(fixture.alerts[0].changes.newFlapPools[0].quoteSymbol, symbol);
    });
  }
  for (const [label, metadata] of [
    ["leading punctuation", { symbol: ".BAD", name: "Bad Quote" }],
    ["leading dollar", { symbol: "$BAD", name: "Bad Quote" }],
    ["control character", { symbol: "BAD\u0007", name: "Bad Quote" }],
    ["URL name", { symbol: "BAD", name: "https://attacker.example" }],
    ["punctuation-only name", { symbol: "BAD", name: "---" }],
  ]) {
    await t.test(`invalid ${label}`, async (subtest) => {
      const fixture = await harness(subtest);
      await fixture.monitor.check();
      const before = clone(fixture.monitor.state().cursor);
      addAssetEvent(fixture.provider, { ...metadata, blockNumber: 99 });
      fixture.provider.head = 101;
      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, "FLAP_QUOTE_METADATA_INVALID");
      assert.deepEqual(fixture.monitor.state().cursor, before);
      assert.equal(fixture.alerts.length, 0);
    });
  }
});

test("a queued delivery retains the candidate and retries the same tx-plus-log event key", async (t) => {
  let attempts = 0;
  const attemptedKeys = [];
  const fixture = await harness(t, {
    sendAlertsImpl: async (_config, event) => {
      attempts += 1;
      attemptedKeys.push(event.eventKey);
      return attempts === 1 ? { status: "queued", persisted: true } : { status: "delivered" };
    },
  });
  await fixture.monitor.check();
  const log = addAssetEvent(fixture.provider);
  fixture.provider.head = 101;

  const failed = await fixture.monitor.check();
  assert.equal(failed.errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
  assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
  assert.equal(fixture.monitor.state().processedEventKeys.length, 1);
  assert.equal(fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(log));

  const retried = await fixture.monitor.check();
  assert.equal(retried.status, "healthy");
  assert.equal(retried.delivered, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(attemptedKeys, [flapQuoteEventKey(log), flapQuoteEventKey(log)]);
  assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
});

test("a disable cannot clear a queued activation until outbox cancellation is durable", async (t) => {
  let cancellationAttempts = 0;
  const fixture = await harness(t, {
    sendAlertsImpl: async () => ({ status: "queued", persisted: true }),
    cancelPendingFlapQuoteActivationImpl: async () => {
      cancellationAttempts += 1;
      return cancellationAttempts === 1
        ? { status: "queued", reason: "delivery_in_flight", persisted: true, terminal: false }
        : { status: "cancelled", reason: "quote_asset_disabled", persisted: true, terminal: true };
    },
  });
  await fixture.monitor.check();
  const enable = addAssetEvent(fixture.provider, { blockNumber: 99 });
  fixture.provider.head = 101;
  assert.equal((await fixture.monitor.check()).errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
  const enableKey = flapQuoteEventKey(enable);

  const disabled = [0, 32, 32, 7, 0];
  fixture.provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  fixture.provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 100,
    transactionHash: id("disable-pending-activation"),
    logIndex: 11,
  });
  fixture.provider.head = 102;
  const held = await fixture.monitor.check();
  assert.equal(held.errorCode, "FLAP_QUOTE_CANCELLATION_NOT_DURABLE");
  assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
  assert.equal(fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, enableKey);

  const cancelled = await fixture.monitor.check();
  assert.equal(cancelled.status, "healthy");
  assert.equal(cancelled.delivered, 0);
  assert.equal(cancellationAttempts, 2);
  assert.equal(fixture.monitor.state().cursor.nextBlock, 101);
  assert.equal(Object.keys(fixture.monitor.state().pendingEnableCandidates).length, 0);
});

test("a real queued Portal alert is terminally cancelled before disable cursor commit", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-real-cancel-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let destinationAvailable = false;
  let telegramPosts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    telegramPosts += 1;
    if (!destinationAvailable) throw new Error("simulated Telegram outage");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 777 } }),
    };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const provider = new FakeBscProvider();
  const runtimeConfig = {
    monitorScope: "focus3",
    blockedContracts: new Set(),
    telegramToken: "flap-quote-cancel-token",
    telegramChatId: "1234567890",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    alertBscRealtimeMaxAgeMs: 600_000,
    alertBscTelegramMaxAgeMs: 7_200_000,
    alertRetryIntervalMs: 0,
    alertNow: () => Date.parse("2026-09-03T07:00:00.000Z"),
    webhookUrl: "",
  };
  const realSender = async (alertConfig, directEvent) => {
    const event = clone(directEvent);
    Object.assign(event.onchainProof, {
      portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
      portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
      portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
      portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
    });
    event.evidence = clone(event.onchainProof);
    return sendAlerts(alertConfig, event);
  };
  const fixture = await harness(t, {
    provider,
    dataDir,
    config: runtimeConfig,
    sendAlertsImpl: realSender,
    cancelPendingFlapQuoteActivationImpl: cancelPendingFlapQuoteActivation,
  });
  await fixture.monitor.check();
  const enable = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  assert.equal((await fixture.monitor.check()).errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
  assert.equal(telegramPosts, 1);

  const disabled = [0, 32, 32, 7, 0];
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 100,
    transactionHash: id("real-disable-cancels-outbox"),
    logIndex: 11,
  });
  provider.head = 102;
  destinationAvailable = true;
  const cancelled = await fixture.monitor.check();
  assert.equal(cancelled.status, "healthy");
  assert.equal(cancelled.delivered, 0);
  assert.equal(fixture.monitor.state().cursor.nextBlock, 101);
  assert.equal(Object.keys(fixture.monitor.state().pendingEnableCandidates).length, 0);

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = Object.values(outbox.events).find((candidate) => (
    candidate.flapQuoteProducerGate?.originalEventKey === flapQuoteEventKey(enable)
  ));
  assert.ok(entry);
  assert.equal(entry.status, "suppressed");
  assert.equal(entry.destinations.telegram.status, "disabled");
  assert.equal(entry.destinations.telegram.cancellationReason, "quote_asset_disabled");
  assert.equal(entry.flapQuoteCancellation.disablingEventKey, `flap-quote:56:${id("real-disable-cancels-outbox").toLowerCase()}:11`);

  await drainAlertOutbox({ ...runtimeConfig, dataDir });
  assert.equal(telegramPosts, 1, "generic recovery cannot POST a producer-gated activation after cancellation");
});

test("a reorged disable proof reactivates its cancelled Portal alert exactly once", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-cancel-reorg-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let destinationAvailable = false;
  let telegramAttempts = 0;
  let successfulPosts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    telegramAttempts += 1;
    if (!destinationAvailable) throw new Error("simulated Telegram outage");
    successfulPosts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 778 } }),
    };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const provider = new FakeBscProvider();
  const runtimeConfig = {
    monitorScope: "focus3",
    blockedContracts: new Set(),
    telegramToken: "flap-quote-cancel-reorg-token",
    telegramChatId: "1234567890",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    alertBscRealtimeMaxAgeMs: 600_000,
    alertBscTelegramMaxAgeMs: 7_200_000,
    alertRetryIntervalMs: 0,
    alertNow: () => Date.parse("2026-09-03T07:00:00.000Z"),
    webhookUrl: "",
  };
  const realSender = async (alertConfig, directEvent) => {
    const event = clone(directEvent);
    Object.assign(event.onchainProof, {
      portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
      portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
      portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
      portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
    });
    event.evidence = clone(event.onchainProof);
    return sendAlerts(alertConfig, event);
  };
  let disableProofReorged = false;
  const fixture = await harness(t, {
    provider,
    dataDir,
    config: runtimeConfig,
    sendAlertsImpl: realSender,
    cancelPendingFlapQuoteActivationImpl: async (alertConfig, cancellation) => {
      const result = await cancelPendingFlapQuoteActivation(alertConfig, cancellation);
      if (!disableProofReorged) {
        disableProofReorged = true;
        provider.setBlockHash(cancellation.blockNumber, id("cancelled-disable-reorged-after-fsync"));
      }
      return result;
    },
  });
  await fixture.monitor.check();
  const enable = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  assert.equal((await fixture.monitor.check()).errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
  assert.equal(telegramAttempts, 1);

  const disabled = [0, 32, 32, 7, 0];
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  const disable = provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 100,
    transactionHash: id("disable-reorgs-after-cancel"),
    logIndex: 11,
  });
  provider.head = 102;
  const interrupted = await fixture.monitor.check();
  const disablingEventKey = flapQuoteEventKey(disable);
  assert.equal(interrupted.errorCode, "FLAP_QUOTE_PRECOMMIT_REORG");
  assert.ok(fixture.monitor.state().reorgOrphanedEventKeys.includes(disablingEventKey));
  assert.equal(
    fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey,
    flapQuoteEventKey(enable),
  );
  assert.equal(fixture.monitor.state().auditTrail.at(-1).action, "cancelled_disable_proof_orphaned_before_commit");

  provider.logs = provider.logs.filter((log) => flapQuoteEventKey(log) !== disablingEventKey);
  provider.receipts.delete(lower(disable.transactionHash));
  provider.transactions.delete(lower(disable.transactionHash));
  provider.configurationHistory.set(lower(FLAP_MRNAB_ADDRESS), (
    provider.configurationHistory.get(lower(FLAP_MRNAB_ADDRESS)) || []
  ).filter((entry) => entry.blockNumber !== disable.blockNumber));
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, [1, 32, 32, 7, 0]);
  destinationAvailable = true;

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(successfulPosts, 1);
  assert.equal(telegramAttempts, 2);
  assert.equal(Object.keys(fixture.monitor.state().pendingEnableCandidates).length, 0);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = Object.values(outbox.events).find((candidate) => (
    candidate.flapQuoteProducerGate?.originalEventKey === flapQuoteEventKey(enable)
  ));
  assert.equal(entry.status, "delivered");
  assert.equal(entry.destinations.telegram.receipt.messageId, 778);
  assert.equal(entry.flapQuoteCancellation, undefined);

  assert.equal((await fixture.monitor.check()).delivered, 0);
  await drainAlertOutbox({ ...runtimeConfig, dataDir });
  assert.equal(successfulPosts, 1, "replay and generic draining cannot duplicate the revived alert");
});

test("a crash after cancellation fsync can revive the revalidated Portal activation after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-cancel-crash-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let destinationAvailable = false;
  let telegramAttempts = 0;
  let successfulPosts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    telegramAttempts += 1;
    if (!destinationAvailable) throw new Error("simulated Telegram outage");
    successfulPosts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 779 } }),
    };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const provider = new FakeBscProvider();
  const runtimeConfig = {
    monitorScope: "focus3",
    blockedContracts: new Set(),
    telegramToken: "flap-quote-cancel-crash-token",
    telegramChatId: "1234567890",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    alertBscRealtimeMaxAgeMs: 600_000,
    alertBscTelegramMaxAgeMs: 7_200_000,
    alertRetryIntervalMs: 0,
    alertNow: () => Date.parse("2026-09-03T07:00:00.000Z"),
    webhookUrl: "",
  };
  const realSender = async (alertConfig, directEvent) => {
    const event = clone(directEvent);
    Object.assign(event.onchainProof, {
      portalRuntimeCodeHash: FLAP_PORTAL_RUNTIME_HASH,
      portalVersion: FLAP_PORTAL_VERIFIED_VERSION,
      portalImplementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
      portalImplementationCodeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
    });
    event.evidence = clone(event.onchainProof);
    return sendAlerts(alertConfig, event);
  };
  let crashAfterCancellation = false;
  const readers = [
    new FakeLogRpcEndpoint("https://cancel-crash-a.test", provider),
    new FakeLogRpcEndpoint("https://cancel-crash-b.test", provider),
  ];
  for (const reader of readers) {
    reader.getBlock = async (blockNumber) => {
      if (crashAfterCancellation && Number(blockNumber) === 100) {
        const error = new Error("simulated process exit after cancellation fsync");
        error.code = "FLAP_QUOTE_STOPPED";
        throw error;
      }
      return provider.getBlock(blockNumber);
    };
  }
  const first = await harness(t, {
    provider,
    dataDir,
    config: runtimeConfig,
    logVerificationProviders: readers.map((reader) => reader.descriptor()),
    sendAlertsImpl: realSender,
    cancelPendingFlapQuoteActivationImpl: async (alertConfig, cancellation) => {
      const result = await cancelPendingFlapQuoteActivation(alertConfig, cancellation);
      crashAfterCancellation = true;
      return result;
    },
  });
  await first.monitor.check();
  const enable = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  assert.equal((await first.monitor.check()).errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");

  const disabled = [0, 32, 32, 7, 0];
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, disabled);
  const disable = provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: disabled,
    blockNumber: 100,
    transactionHash: id("disable-before-cancel-crash"),
    logIndex: 11,
  });
  provider.head = 102;
  const crashed = await first.monitor.check();
  assert.equal(crashed.errorCode, "FLAP_QUOTE_STOPPED");
  assert.equal(first.monitor.state().cursor.nextBlock, 100);
  assert.equal(
    first.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey,
    flapQuoteEventKey(enable),
  );
  assert.ok(!first.monitor.state().reorgOrphanedEventKeys.includes(flapQuoteEventKey(disable)));
  await first.monitor.stop();

  provider.setBlockHash(100, id("cancel-crash-canonical-enabled-block"));
  provider.logs = provider.logs.filter((log) => flapQuoteEventKey(log) !== flapQuoteEventKey(disable));
  provider.receipts.delete(lower(disable.transactionHash));
  provider.transactions.delete(lower(disable.transactionHash));
  provider.configurationHistory.set(lower(FLAP_MRNAB_ADDRESS), (
    provider.configurationHistory.get(lower(FLAP_MRNAB_ADDRESS)) || []
  ).filter((entry) => entry.blockNumber !== disable.blockNumber));
  provider.setConfiguration(FLAP_MRNAB_ADDRESS, [1, 32, 32, 7, 0]);
  destinationAvailable = true;
  crashAfterCancellation = false;

  const restarted = await harness(t, {
    provider,
    dataDir,
    config: runtimeConfig,
    sendAlertsImpl: realSender,
    cancelPendingFlapQuoteActivationImpl: cancelPendingFlapQuoteActivation,
  });
  const recovered = await restarted.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(successfulPosts, 1);
  assert.equal(telegramAttempts, 2);
  assert.equal(Object.keys(restarted.monitor.state().pendingEnableCandidates).length, 0);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = Object.values(outbox.events).find((candidate) => (
    candidate.flapQuoteProducerGate?.originalEventKey === flapQuoteEventKey(enable)
  ));
  assert.equal(entry.status, "delivered");
  assert.equal(entry.destinations.telegram.receipt.messageId, 779);
  assert.equal(entry.flapQuoteCancellation, undefined);

  assert.equal((await restarted.monitor.check()).delivered, 0);
  await drainAlertOutbox({ ...runtimeConfig, dataDir });
  assert.equal(successfulPosts, 1, "restart retry and generic draining remain exact-once");
});

test("a stale real 0-to-1 transition emits one durable delayed-recovery envelope across restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-delayed-recovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider();
  const delivered = [];
  const sender = async (_config, event) => {
    delivered.push(event);
    return { status: "delivered", eventId: event.eventKey };
  };
  const first = await harness(t, { provider, dataDir, sendAlertsImpl: sender });
  await first.monitor.check();
  await first.monitor.stop();

  const log = addAssetEvent(provider, { blockNumber: 99 });
  provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
  provider.head = 101;
  const second = await harness(t, { provider, dataDir, sendAlertsImpl: sender });
  const recovered = await second.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.delivered, 1);
  assert.equal(delivered.length, 1);
  const event = delivered[0];
  const originalEventKey = flapQuoteEventKey(log);
  assert.equal(event.originalEventKey, originalEventKey);
  assert.equal(event.eventKey, `${originalEventKey}:delayed-recovery:v1`);
  assert.deepEqual(event.delayedRecovery, {
    version: 1,
    reason: "monitoring_gap_recovery",
    sourceOccurredAt: event.occurredAt,
    originalBlockNumber: event.blockNumber,
    originalBlockHash: event.blockHash,
    originalTransactionHash: event.transactionHash,
    originalLogIndex: event.logIndex,
    recoveredAt: event.observedAt,
    lagMs: 20 * 60_000,
    cursor: { nextBlockAtRecovery: 100, eventBlock: 99 },
  });
  assert.equal(second.monitor.state().processedEventKeys[0], originalEventKey);
  await second.monitor.stop();

  const third = await harness(t, { provider, dataDir, sendAlertsImpl: sender });
  const replay = await third.monitor.check();
  assert.equal(replay.status, "healthy");
  assert.equal(replay.delivered, 0);
  assert.equal(delivered.length, 1, "the persisted original event key prevents a second recovery summary");
});

test("freshness is sampled at delivery so a long cycle crossing 15 minutes becomes T2 recovery", async (t) => {
  let clockMs = Date.parse("2026-09-03T07:00:00.000Z");
  const provider = new FakeBscProvider();
  const delivered = [];
  const fixture = await harness(t, {
    provider,
    now: () => clockMs,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "delivered" };
    },
  });
  await fixture.monitor.check();
  provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:45:01.000Z") / 1_000);
  addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  const originalGetTransaction = provider.getTransaction.bind(provider);
  let advanced = false;
  provider.getTransaction = async (...args) => {
    const transaction = await originalGetTransaction(...args);
    if (!advanced) {
      advanced = true;
      clockMs += 2_000;
    }
    return transaction;
  };

  const result = await fixture.monitor.check();
  assert.equal(result.delivered, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].observedAt, "2026-09-03T07:00:02.000Z");
  assert.equal(delivered[0].delayedRecovery.lagMs, 15 * 60_000 + 1_000);
  assert.equal(delivered[0].eventKey, `${delivered[0].originalEventKey}:delayed-recovery:v1`);
});

test("a policy-suppressed delayed recovery retries the same derived key after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-delayed-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider();
  const attemptedKeys = [];
  const first = await harness(t, { provider, dataDir });
  await first.monitor.check();
  await first.monitor.stop();
  const log = addAssetEvent(provider, { blockNumber: 99 });
  provider.setBlockTimestamp(99, Date.parse("2026-09-03T06:40:00.000Z") / 1_000);
  provider.head = 101;

  const suppressed = await harness(t, {
    provider,
    dataDir,
    sendAlertsImpl: async (_config, event) => {
      attemptedKeys.push(event.eventKey);
      return { status: "suppressed", terminal: true, persisted: true, reason: "policy_suppressed" };
    },
  });
  const failed = await suppressed.monitor.check();
  assert.equal(failed.errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
  assert.equal(suppressed.monitor.state().cursor.nextBlock, 100);
  assert.equal(suppressed.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(log));
  await suppressed.monitor.stop();

  const retry = await harness(t, {
    provider,
    dataDir,
    sendAlertsImpl: async (_config, event) => {
      attemptedKeys.push(event.eventKey);
      return { status: "delivered", eventId: event.eventKey };
    },
  });
  assert.equal((await retry.monitor.check()).status, "healthy");
  const recoveryKey = `${flapQuoteEventKey(log)}:delayed-recovery:v1`;
  assert.deepEqual(attemptedKeys, [recoveryKey, recoveryKey]);
  assert.equal(retry.monitor.state().processedEventKeys[0], flapQuoteEventKey(log));
});

test("non-durable suppressions retain a retryable activation candidate", async (t) => {
  for (const reason of [
    "monitoring_source_disabled", "not_relevant", "policy_suppressed", "freshness_too_old", "blocked_event",
  ]) {
    await t.test(reason, async (subtest) => {
      const fixture = await harness(subtest, {
        sendAlertsImpl: async () => ({ status: "suppressed", terminal: true, reason }),
      });
      await fixture.monitor.check();
      const log = addAssetEvent(fixture.provider);
      fixture.provider.head = 101;
      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
      assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
      assert.equal(fixture.monitor.state().processedEventKeys.length, 1);
      assert.equal(fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(log));
    });
  }
});

test("only a persisted semantic duplicate with a delivered canonical owner can consume a recovery", async (t) => {
  for (const { persisted, canonicalOwnerDelivered, accepted } of [
    { persisted: false, canonicalOwnerDelivered: true, accepted: false },
    { persisted: true, canonicalOwnerDelivered: false, accepted: false },
    { persisted: true, canonicalOwnerDelivered: true, accepted: true },
  ]) {
    await t.test(`persisted=${persisted}, ownerDelivered=${canonicalOwnerDelivered}`, async (subtest) => {
      const fixture = await harness(subtest, {
        sendAlertsImpl: async () => ({
          status: "suppressed",
          terminal: true,
          reason: "semantic_duplicate",
          persisted,
          canonicalOwnerDelivered,
        }),
      });
      await fixture.monitor.check();
      const log = addAssetEvent(fixture.provider);
      fixture.provider.head = 101;
      const result = await fixture.monitor.check();
      if (accepted) {
        assert.equal(result.status, "healthy");
        assert.equal(fixture.monitor.state().processedEventKeys.length, 1);
      } else {
        assert.equal(result.errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
        assert.equal(fixture.monitor.state().cursor.nextBlock, 100);
        assert.equal(fixture.monitor.state().pendingEnableCandidates[lower(FLAP_MRNAB_ADDRESS)].eventKey, flapQuoteEventKey(log));
      }
    });
  }
});

test("disabled configuration is removal audit, never a platform capability alert", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  addAssetEvent(fixture.provider, { blockNumber: 99 });
  fixture.provider.head = 101;
  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 1);

  fixture.provider.setConfiguration(FLAP_MRNAB_ADDRESS, [0, 32, 32, 7, 0]);
  const disableLog = fixture.provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [0, 32, 32, 7, 0],
    blockNumber: 100,
    logIndex: 11,
  });
  fixture.provider.head = 102;
  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 0);
  assert.equal(result.audited, 1);
  assert.equal(fixture.alerts.length, 1);
  const audit = fixture.monitor.state().auditTrail.at(-1);
  assert.equal(audit.type, "flap_quote_configuration_audit");
  assert.equal(audit.action, "removed");
  assert.equal(audit.after.enabled, false);
  assert.equal(fixture.monitor.state().quoteAssets[lower(FLAP_MRNAB_ADDRESS)].enabled, false);
  assert.deepEqual(fixture.lifecycles.map(({ action, proofType }) => ({ action, proofType })), [
    { action: "activated", proofType: "verified_zero_to_one" },
    { action: "disabled", proofType: "verified_disable" },
  ]);
  assert.equal(fixture.lifecycles.at(-1).activationEventKey, flapQuoteEventKey(disableLog));
  assert.equal(fixture.lifecycles.at(-1).monitorOnly, true);
});

test("an enabled configuration refresh is audited instead of being mislabeled as a new pool", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  addAssetEvent(fixture.provider, { blockNumber: 99 });
  fixture.provider.head = 101;
  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 1);

  fixture.provider.setConfiguration(FLAP_MRNAB_ADDRESS, [1, 33, 34, 7, 0]);
  fixture.provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [1, 33, 34, 7, 0],
    blockNumber: 100,
    logIndex: 11,
  });
  fixture.provider.head = 102;
  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 0);
  assert.equal(result.audited, 1);
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.monitor.state().auditTrail.at(-1).action, "updated");
  assert.equal(fixture.monitor.state().quoteAssets[lower(FLAP_MRNAB_ADDRESS)].configuration.defaultCurve, 33);
  assert.deepEqual(fixture.lifecycles.map(({ action }) => action), ["activated"],
    "an enabled-to-enabled configuration refresh does not create another lifecycle generation");
});

test("an already-enabled pre-baseline asset is not mislabeled as newly enabled", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  fixture.provider.setAsset(FLAP_MRNAB_ADDRESS, {
    name: "Moderna",
    symbol: "MRNAB",
    decimals: 18,
    configuration: [1, 33, 34, 7, 0],
  });
  fixture.provider.seedConfigurationHistory(FLAP_MRNAB_ADDRESS, 90, [1, 32, 32, 7, 0]);
  fixture.provider.addQuoteEvent({
    address: FLAP_MRNAB_ADDRESS,
    configuration: [1, 33, 34, 7, 0],
    blockNumber: 99,
    logIndex: 11,
  });
  fixture.provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.delivered, 0);
  assert.equal(result.audited, 1);
  assert.equal(fixture.alerts.length, 0);
  assert.equal(fixture.monitor.state().auditTrail.at(-1).action, "updated");
  assert.equal(fixture.monitor.state().quoteAssets[lower(FLAP_MRNAB_ADDRESS)].configuration.defaultCurve, 33);
});

test("independent prior-state disagreement freezes an apparent enable transition", async (t) => {
  const provider = new FakeBscProvider();
  const first = stateReaderWithPriorMode("https://prior-state-a.test", provider);
  const second = stateReaderWithPriorMode(
    "https://prior-state-b.test",
    provider,
    [1, 32, 32, 7, 0],
  );
  const fixture = await harness(t, {
    provider,
    stateVerificationProviders: [first.descriptor(), second.descriptor()],
  });
  await fixture.monitor.check();
  const before = clone(fixture.monitor.state().cursor);
  addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;

  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_PRIOR_CONFIGURATION_MISMATCH");
  assert.deepEqual(fixture.monitor.state().cursor, before);
  assert.equal(fixture.alerts.length, 0);
});

test("corrupt persisted cursor schema is rejected without scanning or overwriting it", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-state-schema-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const first = await harness(t, { dataDir });
  await first.monitor.check();
  await first.monitor.stop();
  const stateFile = first.monitor.stateFile;
  const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  persisted.cursor.nextBlock = String(persisted.cursor.nextBlock);
  await fs.writeFile(stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  const provider = new FakeBscProvider();
  const second = await harness(t, { provider, dataDir });
  const result = await second.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_STATE_INVALID");
  assert.equal(provider.getLogsCalls.length, 0);
  const after = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(typeof after.cursor.nextBlock, "string");
});

test("corrupt or oversized persisted collections and health fail closed on restart", async (t) => {
  const cases = [
    ["malformed finalized checkpoint", (state) => { state.finalizedCheckpoints[0].blockNumber = "98"; }],
    ["malformed event record", (state) => { state.eventRecords = [{}]; }],
    ["malformed audit record", (state) => { state.auditTrail = [{ type: "flap_quote_reorg_audit" }]; }],
    ["malformed health", (state) => { state._health.consecutiveFailures = -1; }],
    ["healthy state with a future retry", (state) => {
      state._health.nextAttemptAt = "9999-01-01T00:00:00.000Z";
    }],
    ["malformed quote asset", (state) => { state.quoteAssets[lower(FLAP_MRNAB_ADDRESS)] = { enabled: true }; }],
    ["processed key without event record", (state) => {
      state.processedEventKeys = [`flap-quote:56:${lower(id("forged-processed-key"))}:0`];
    }],
    ["partial cursor without matching event record", (state) => {
      state.cursor.nextBlock = state.cursor.anchorBlock;
      state.cursor.afterLogIndex = 7;
    }],
    ["checkpoint missing the cursor anchor", (state) => { state.finalizedCheckpoints = []; }],
    ["dirty uninitialized snapshot", (state) => { state.initialized = false; }],
    ["unexpected checkpoint field", (state) => { state.finalizedCheckpoints[0].unbounded = "x".repeat(1_000); }],
    ["oversized checkpoints", (state) => {
      state.finalizedCheckpoints = Array.from({ length: 2_001 }, (_, index) => ({
        blockNumber: index,
        blockHash: lower(id(`oversized-checkpoint:${index}`)),
        observedAt: state.checkedAt,
      }));
    }],
    ["oversized event records", (state) => { state.eventRecords = Array.from({ length: 20_001 }, () => ({})); }],
    ["oversized audit trail", (state) => { state.auditTrail = Array.from({ length: 5_001 }, () => ({})); }],
    ["oversized quote assets", (state) => {
      state.quoteAssets = Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [
        `0x${(index + 1).toString(16).padStart(40, "0")}`,
        {},
      ]));
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-state-corrupt-"));
      subtest.after(() => fs.rm(dataDir, { recursive: true, force: true }));
      const first = await harness(subtest, { dataDir });
      await first.monitor.check();
      await first.monitor.stop();
      const stateFile = first.monitor.stateFile;
      const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
      mutate(persisted);
      await fs.writeFile(stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

      const provider = new FakeBscProvider();
      const second = await harness(subtest, { provider, dataDir });
      const result = await second.monitor.check();
      assert.equal(result.errorCode, "FLAP_QUOTE_STATE_INVALID");
      assert.equal(provider.getLogsCalls.length, 0);
    });
  }
});

test("corrupt pending activation journals fail closed before any restart RPC", async (t) => {
  for (const [label, mutate] of [
    ["unexpected candidate field", (state, address) => { state.pendingEnableCandidates[address].extra = "forged"; }],
    ["missing pending candidate", (state, address) => { delete state.pendingEnableCandidates[address]; }],
    ["missing candidate event record", (state) => {
      state.eventRecords = [];
      state.processedEventKeys = [];
    }],
    ["candidate points at delivered record", (state) => { state.eventRecords[0].delivered = true; }],
  ]) {
    await t.test(label, async (subtest) => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-pending-corrupt-"));
      subtest.after(() => fs.rm(dataDir, { recursive: true, force: true }));
      const provider = new FakeBscProvider();
      const first = await harness(subtest, {
        provider,
        dataDir,
        sendAlertsImpl: async () => ({ status: "queued", persisted: true }),
      });
      await first.monitor.check();
      addAssetEvent(provider, { blockNumber: 99 });
      provider.head = 101;
      assert.equal((await first.monitor.check()).errorCode, "FLAP_QUOTE_ALERT_NOT_DURABLE");
      await first.monitor.stop();
      const persisted = JSON.parse(await fs.readFile(first.monitor.stateFile, "utf8"));
      const address = lower(FLAP_MRNAB_ADDRESS);
      mutate(persisted, address);
      await fs.writeFile(first.monitor.stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

      const restartedProvider = new FakeBscProvider();
      const restarted = await harness(subtest, { provider: restartedProvider, dataDir });
      const result = await restarted.monitor.check();
      assert.equal(result.errorCode, "FLAP_QUOTE_STATE_INVALID");
      assert.equal(restartedProvider.getLogsCalls.length, 0);
    });
  }
});

test("persisted asset, configuration, and audit evidence reject unbounded extra fields", async (t) => {
  for (const target of ["asset", "configuration", "evidence"]) {
    await t.test(target, async (subtest) => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-state-exact-"));
      subtest.after(() => fs.rm(dataDir, { recursive: true, force: true }));
      const first = await harness(subtest, { dataDir });
      await first.monitor.check();
      addAssetEvent(first.provider, { blockNumber: 99 });
      first.provider.head = 101;
      await first.monitor.check();
      first.provider.setConfiguration(FLAP_MRNAB_ADDRESS, [1, 33, 34, 7, 0]);
      first.provider.addQuoteEvent({
        address: FLAP_MRNAB_ADDRESS,
        configuration: [1, 33, 34, 7, 0],
        blockNumber: 100,
        logIndex: 11,
      });
      first.provider.head = 102;
      await first.monitor.check();
      await first.monitor.stop();
      const persisted = JSON.parse(await fs.readFile(first.monitor.stateFile, "utf8"));
      if (target === "asset") persisted.quoteAssets[lower(FLAP_MRNAB_ADDRESS)].extra = "x".repeat(1_000);
      if (target === "configuration") persisted.quoteAssets[lower(FLAP_MRNAB_ADDRESS)].configuration.extra = 1;
      if (target === "evidence") persisted.auditTrail.at(-1).evidence.extra = { nested: "x".repeat(1_000) };
      await fs.writeFile(first.monitor.stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

      const provider = new FakeBscProvider();
      const second = await harness(subtest, { provider, dataDir });
      const result = await second.monitor.check();
      assert.equal(result.errorCode, "FLAP_QUOTE_STATE_INVALID");
      assert.equal(provider.getLogsCalls.length, 0);
    });
  }
});

test("persisted Portal identity pins cannot be forged or carried across an upgrade", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-state-identity-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const first = await harness(t, { dataDir });
  await first.monitor.check();
  await first.monitor.stop();
  const stateFile = first.monitor.stateFile;
  const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  persisted.identity.version = "v5.99.0";
  await fs.writeFile(stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  const provider = new FakeBscProvider();
  const second = await harness(t, { provider, dataDir });
  const result = await second.monitor.check();
  assert.equal(result.errorCode, "FLAP_QUOTE_STATE_IDENTITY_MISMATCH");
  assert.equal(provider.getLogsCalls.length, 0);
});

test("raw Node error codes are normalized before degraded health survives restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-health-code-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeBscProvider();
  let failNextWrite = false;
  const first = await harness(t, {
    provider,
    dataDir,
    atomicWriteImpl: async (file, value) => {
      if (failNextWrite) {
        failNextWrite = false;
        const error = new Error("simulated transient state filesystem failure");
        error.code = "ENOSPC";
        throw error;
      }
      await atomicWriteFlapQuoteState(file, value);
    },
  });
  await first.monitor.check();
  provider.head = 101;
  failNextWrite = true;
  const degraded = await first.monitor.check();
  assert.equal(degraded.errorCode, "FLAP_QUOTE_FAILURE");
  assert.equal(first.monitor.state()._health.lastErrorCode, "FLAP_QUOTE_FAILURE");
  await first.monitor.stop();

  const restartedProvider = new FakeBscProvider({ head: 101 });
  const second = await harness(t, { provider: restartedProvider, dataDir });
  const restarted = await second.monitor.check();
  assert.notEqual(restarted.errorCode, "FLAP_QUOTE_STATE_INVALID");
  assert.equal(restarted.status, "healthy");
});

test("persistent backoff caps RPC retryAfter and performs no early RPC or write", async (t) => {
  let nowMs = Date.parse("2026-09-03T07:00:00.000Z");
  const provider = new FakeBscProvider();
  const fixture = await harness(t, {
    provider,
    now: () => nowMs,
    config: { flapQuoteBackoffBaseMs: 1_000, flapQuoteBackoffMaxMs: 10_000 },
  });
  await fixture.monitor.check();
  const originalGetBlockNumber = provider.getBlockNumber.bind(provider);
  provider.getBlockNumber = async () => {
    const error = new Error("shared RPC host is cooling down");
    error.code = "SERVER_ERROR";
    error.retryAfterMs = 50_000;
    throw error;
  };
  const failed = await fixture.monitor.check();
  assert.equal(failed.errorCode, "FLAP_QUOTE_HEAD_UNAVAILABLE");
  assert.equal(failed.nextAttemptAt, "2026-09-03T07:00:10.000Z");
  const persistedBefore = await fs.readFile(fixture.monitor.stateFile, "utf8");
  let headCalls = 0;
  provider.getBlockNumber = async () => {
    headCalls += 1;
    return originalGetBlockNumber();
  };

  assert.equal((await fixture.monitor.check()).status, "backoff");
  nowMs += 9_999;
  assert.equal((await fixture.monitor.check()).status, "backoff");
  assert.equal(headCalls, 0);
  assert.equal(await fs.readFile(fixture.monitor.stateFile, "utf8"), persistedBefore);

  nowMs += 1;
  assert.equal((await fixture.monitor.check()).status, "healthy");
  assert.equal(headCalls, 1);
  assert.equal(fixture.monitor.state()._health.nextAttemptAt, null);
  assert.equal(fixture.monitor.state()._health.consecutiveFailures, 0);
  assert.equal(fixture.monitor.state()._health.lastErrorAt, null);
  await fixture.monitor.stop();

  const restarted = await harness(t, {
    provider,
    dataDir: fixture.dataDir,
    now: () => nowMs,
    config: { flapQuoteBackoffBaseMs: 1_000, flapQuoteBackoffMaxMs: 10_000 },
  });
  assert.equal((await restarted.monitor.check()).status, "healthy");
});

test("lowering the configured backoff cap clamps a valid persisted retry instead of invalidating state", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-quote-backoff-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-09-03T07:00:00.000Z");
  const provider = new FakeBscProvider();
  const first = await harness(t, {
    provider,
    dataDir,
    now: () => nowMs,
    config: { flapQuoteBackoffBaseMs: 300_000, flapQuoteBackoffMaxMs: 300_000 },
  });
  await first.monitor.check();
  const originalGetBlockNumber = provider.getBlockNumber.bind(provider);
  provider.getBlockNumber = async () => { throw new Error("temporary outage"); };
  assert.equal((await first.monitor.check()).nextAttemptAt, "2026-09-03T07:05:00.000Z");
  await first.monitor.stop();

  provider.getBlockNumber = originalGetBlockNumber;
  const second = await harness(t, {
    provider,
    dataDir,
    now: () => nowMs,
    config: { flapQuoteBackoffBaseMs: 3_000, flapQuoteBackoffMaxMs: 30_000 },
  });
  const clamped = await second.monitor.check();
  assert.equal(clamped.status, "backoff");
  assert.equal(clamped.nextAttemptAt, "2026-09-03T07:00:30.000Z");
  assert.notEqual(clamped.errorCode, "FLAP_QUOTE_STATE_INVALID");
  nowMs += 30_000;
  assert.equal((await second.monitor.check()).status, "healthy");
});

test("stop waits for an in-flight atomic state commit", async (t) => {
  let releaseWrite;
  let enteredWrite;
  const entered = new Promise((resolve) => { enteredWrite = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const fixture = await harness(t, {
    atomicWriteImpl: async (file, value) => {
      enteredWrite();
      await gate;
      await atomicWriteFlapQuoteState(file, value);
    },
  });
  const checking = fixture.monitor.check();
  await entered;
  let stopped = false;
  const stopping = fixture.monitor.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseWrite();
  await stopping;
  assert.equal(stopped, true);
  assert.equal((await checking).status, "baseline");
});

test("stop never abandons an in-flight durable alert delivery", async (t) => {
  const provider = new FakeBscProvider();
  let releaseDelivery;
  let enteredDelivery;
  const entered = new Promise((resolve) => { enteredDelivery = resolve; });
  const gate = new Promise((resolve) => { releaseDelivery = resolve; });
  const fixture = await harness(t, {
    provider,
    sendAlertsImpl: async () => {
      enteredDelivery();
      await gate;
      return { status: "delivered" };
    },
  });
  await fixture.monitor.check();
  const log = addAssetEvent(provider, { blockNumber: 99 });
  provider.head = 101;
  const checking = fixture.monitor.check();
  await entered;
  let stopped = false;
  const stopping = fixture.monitor.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseDelivery();
  await stopping;
  assert.equal(stopped, true);
  assert.equal((await checking).status, "healthy");
  assert.ok(fixture.monitor.state().processedEventKeys.includes(flapQuoteEventKey(log)));
});
