import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { id } from "ethers";
import { classifyAlertFreshness, isRelevantAlert, isStrongAlert, sendAlerts } from "../src/alerts.js";
import {
  PONS_DEPLOYER,
  PONS_DEPLOYER_TRANSACTIONS_URL,
  PONS_EXPLORER_API_URL,
  PONS_EXPLORER_INDEXING_STATUS_URL,
  PONS_EXPLORER_STATS_URL,
  PONS_V2_BUYBACK_VAULT_SET_TOPIC,
  PONS_V2_CURRENT_OWNER,
  PONS_V2_FACTORY_SET_TOPIC,
  PONS_V2_FEE_ESCROW,
  PONS_V2_HOOK,
  PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC,
  PONS_V2_MAIN_FACTORY,
  PONS_V2_MIGRATION_FACTORY,
  PONS_V2_MIGRATION_HOOK,
  PONS_V2_OWNERSHIP_TRANSFERRED_TOPIC,
  PONS_V2_POOL_MANAGER,
  PONS_V2_TOKEN_LAUNCHED_TOPIC,
  PONS_V2_TOKEN_MIGRATED_TOPIC,
  assertPonsExplorerCoverage,
  createPonsVersionMonitor,
  extractPonsDeployerCreations,
  extractOfficialPonsGithubRepositories,
  extractPonsV2FactoryAddresses,
  fetchPonsBaselineLifecycleLogs,
  readPonsV2FactoryFromHook,
  readPonsV2FactoryStatus,
  verifyPonsV2Factory,
} from "../src/pons-version-monitor.js";

const MAIN_VAULT = "0x2d6e3aa895eda2603189c2a89679bd4279175fdb";
const MIGRATION_VAULT = "0xd87aef40c0732aff071e7b59050313876a59e256";
const NEW_OWNER = "0x9999999999999999999999999999999999999999";
const NEW_FACTORY = "0x7777777777777777777777777777777777777777";
const NEW_VAULT = "0x8888888888888888888888888888888888888888";
const FAKE_FACTORY = "0x1111111111111111111111111111111111111111";
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASELINE_BLOCK = 23_700_000;

const selector = (signature) => id(signature).slice(0, 10);
const addressWord = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const uintWord = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const response = (body, url) => ({
  ok: true,
  status: 200,
  url,
  text: async () => typeof body === "string" ? body : JSON.stringify(body),
  json: async () => typeof body === "string" ? JSON.parse(body) : body,
});

const makeLog = ({ address, topic, topics = [], data = uintWord(0), blockNumber, transactionHash, index = 0, timestamp, blockTimestamp }) => ({
  address,
  topics: [topic, ...topics],
  data,
  blockNumber,
  transactionHash,
  transactionIndex: 0,
  index,
  ...(timestamp == null ? {} : { timestamp }),
  ...(blockTimestamp == null ? {} : { blockTimestamp }),
});

class FakePonsProvider {
  constructor() {
    this.latest = BASELINE_BLOCK;
    this.logs = [];
    this.filters = [];
    this.blockRequests = [];
    this.blockTimestamps = new Map();
    this.blockErrors = new Map();
    this.hooks = {
      [PONS_V2_HOOK]: {
        factory: PONS_V2_MAIN_FACTORY,
        buybackVault: MAIN_VAULT,
        owner: PONS_V2_CURRENT_OWNER,
        feeEscrow: PONS_V2_FEE_ESCROW,
        poolManager: PONS_V2_POOL_MANAGER,
      },
      [PONS_V2_MIGRATION_HOOK]: {
        factory: PONS_V2_MIGRATION_FACTORY,
        buybackVault: MIGRATION_VAULT,
        owner: PONS_V2_CURRENT_OWNER,
        feeEscrow: PONS_V2_FEE_ESCROW,
        poolManager: PONS_V2_POOL_MANAGER,
      },
    };
    this.factories = {
      [PONS_V2_MAIN_FACTORY]: {
        memeHook: PONS_V2_HOOK,
        buybackVault: MAIN_VAULT,
        feeEscrow: PONS_V2_FEE_ESCROW,
        poolManager: PONS_V2_POOL_MANAGER,
        launchConfigCount: 1n,
        launchEnabled: false,
      },
      [PONS_V2_MIGRATION_FACTORY]: {
        memeHook: PONS_V2_MIGRATION_HOOK,
        buybackVault: MIGRATION_VAULT,
        feeEscrow: PONS_V2_FEE_ESCROW,
        poolManager: PONS_V2_POOL_MANAGER,
      },
    };
  }

  async getBlockNumber() { return this.latest; }

  async getBlock(blockNumber) {
    const number = Number(blockNumber);
    this.blockRequests.push(number);
    if (this.blockErrors.has(number)) throw this.blockErrors.get(number);
    return {
      number,
      timestamp: this.blockTimestamps.get(number) ?? Math.floor(Date.now() / 1_000),
    };
  }

  async getCode(address) {
    const normalized = address.toLowerCase();
    return this.hooks[normalized] || this.factories[normalized] ? "0x6001600055" : "0x";
  }

  async getTransactionReceipt(transactionHash) {
    const logs = this.logs.filter((log) => log.transactionHash === transactionHash);
    if (!logs.length) return null;
    return { status: 1, blockNumber: logs[0].blockNumber, logs };
  }

  async call({ to, data }) {
    const normalized = to.toLowerCase();
    const hook = this.hooks[normalized];
    if (hook) {
      const getters = {
        [selector("factory()")]: hook.factory,
        [selector("buybackVault()")]: hook.buybackVault,
        [selector("owner()")]: hook.owner,
        [selector("feeEscrow()")]: hook.feeEscrow,
        [selector("poolManager()")]: hook.poolManager,
      };
      if (getters[data]) return addressWord(getters[data]);
    }
    const factory = this.factories[normalized];
    if (factory) {
      const addressGetters = {
        [selector("memeHook()")]: factory.memeHook,
        [selector("buybackVault()")]: factory.buybackVault,
        [selector("feeEscrow()")]: factory.feeEscrow,
        [selector("poolManager()")]: factory.poolManager,
      };
      if (addressGetters[data]) return addressWord(addressGetters[data]);
      if (data === selector("launchConfigCount()") && factory.launchConfigCount != null) return uintWord(factory.launchConfigCount);
      if (data === selector("launchEnabled()") && factory.launchEnabled != null) return uintWord(factory.launchEnabled ? 1 : 0);
    }
    throw new Error(`unexpected call ${normalized} ${data}`);
  }

  async getLogs(filter) {
    this.filters.push(filter);
    const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((address) => address.toLowerCase());
    const accepted = Array.isArray(filter.topics?.[0]) ? filter.topics[0] : [filter.topics?.[0]];
    const topics = accepted.filter(Boolean).map((topic) => topic.toLowerCase());
    return this.logs.filter((log) => addresses.includes(log.address.toLowerCase())
      && log.blockNumber >= filter.fromBlock
      && log.blockNumber <= filter.toBlock
      && topics.includes(log.topics[0].toLowerCase()));
  }
}

const docsFetch = async (url) => {
  assert.equal(url, "https://docs.ponsfamily.com/v2");
  assert.notEqual(url, PONS_DEPLOYER_TRANSACTIONS_URL);
  return response("", url);
};

const createMonitorFixture = async (provider = new FakePonsProvider(), options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pons-v2-monitor-"));
  if (options.initialState) {
    await fs.writeFile(path.join(dataDir, "pons-version-state.json"), `${JSON.stringify(options.initialState)}\n`);
  }
  const alerts = [];
  const registrations = [];
  const monitor = createPonsVersionMonitor(
    { dataDir, confirmations: options.confirmations ?? 0, ponsVersionPollIntervalMs: 5_000, ponsVersionEventChunkSize: 100 },
    {
      autoStart: false,
      provider,
      fetchImpl: options.fetchImpl || docsFetch,
      fetchBaselineLogsImpl: options.fetchBaselineLogsImpl || (async ({ factory, topic, fromBlock, toBlock }) => provider.getLogs({
        address: factory,
        fromBlock,
        toBlock,
        topics: [topic],
      })),
      assertBaselineCoverageImpl: options.assertBaselineCoverageImpl || (async () => true),
      ...(options.verifyFactoryImpl ? { verifyFactoryImpl: options.verifyFactoryImpl } : {}),
      sendAlertsImpl: async (_config, event) => {
        alerts.push(event);
        if (options.alertFailure) await options.alertFailure(event);
      },
      onFactory: async (record) => registrations.push(record),
      logger: { error() {} },
    },
  );
  return { dataDir, provider, monitor, alerts, registrations };
};

test("uses the exact official Pons lifecycle event signatures", () => {
  assert.equal(PONS_V2_TOKEN_LAUNCHED_TOPIC, "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607");
  assert.equal(PONS_V2_TOKEN_MIGRATED_TOPIC, "0xf3c83d8e76cef55dc49b749dd53058325073a50b828db860ef649b3c1b829e3a");
});

test("Blockscout lifecycle baseline keeps only an exact official factory event", async () => {
  let requestedUrl = null;
  const valid = makeLog({
    address: PONS_V2_MAIN_FACTORY,
    topic: PONS_V2_TOKEN_LAUNCHED_TOPIC,
    topics: [addressWord(TOKEN_A)],
    blockNumber: BASELINE_BLOCK - 5,
    transactionHash: `0x${"a".repeat(64)}`,
  });
  const fetchImpl = async (url) => {
    requestedUrl = new URL(url);
    return response({
      status: "1",
      message: "OK",
      result: [
        {
          ...valid,
          blockNumber: `0x${(BASELINE_BLOCK - 5).toString(16)}`,
          transactionIndex: "0x1",
          logIndex: "0x2",
        },
      ],
    }, url);
  };
  const logs = await fetchPonsBaselineLifecycleLogs(fetchImpl, {
    factory: PONS_V2_MAIN_FACTORY,
    topic: PONS_V2_TOKEN_LAUNCHED_TOPIC,
    fromBlock: BASELINE_BLOCK - 10,
    toBlock: BASELINE_BLOCK,
  });
  assert.equal(requestedUrl.origin + requestedUrl.pathname, PONS_EXPLORER_API_URL);
  assert.equal(requestedUrl.searchParams.get("address"), PONS_V2_MAIN_FACTORY);
  assert.equal(requestedUrl.searchParams.get("topic0"), PONS_V2_TOKEN_LAUNCHED_TOPIC);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].blockNumber, BASELINE_BLOCK - 5);
  assert.equal(logs[0].topics[1], addressWord(TOKEN_A));
});

test("Blockscout lifecycle baseline rejects a nonempty mismatched log set", async () => {
  const invalid = makeLog({
    address: FAKE_FACTORY,
    topic: PONS_V2_TOKEN_LAUNCHED_TOPIC,
    topics: [addressWord(TOKEN_A)],
    blockNumber: BASELINE_BLOCK - 5,
    transactionHash: `0x${"b".repeat(64)}`,
  });
  await assert.rejects(fetchPonsBaselineLifecycleLogs(
    async (url) => response({
      status: "1",
      message: "OK",
      result: [{ ...invalid, transactionIndex: "0x1", logIndex: "0x2" }],
    }, url),
    {
      factory: PONS_V2_MAIN_FACTORY,
      topic: PONS_V2_TOKEN_LAUNCHED_TOPIC,
      fromBlock: BASELINE_BLOCK - 10,
      toBlock: BASELINE_BLOCK,
    },
  ), /mismatched log/);
});

test("Blockscout lifecycle baseline fails closed on an invalid response", async () => {
  await assert.rejects(fetchPonsBaselineLifecycleLogs(
    async (url) => response({ message: "NOTOK", result: "upstream failed" }, url),
    {
      factory: PONS_V2_MAIN_FACTORY,
      topic: PONS_V2_TOKEN_LAUNCHED_TOPIC,
      fromBlock: BASELINE_BLOCK - 10,
      toBlock: BASELINE_BLOCK,
    },
  ), /invalid logs response/);
});

test("Blockscout lifecycle baseline requires complete indexing through the history boundary", async () => {
  const healthyFetch = async (url) => {
    if (url === PONS_EXPLORER_INDEXING_STATUS_URL) return response({ finished_indexing_blocks: true }, url);
    if (url === PONS_EXPLORER_STATS_URL) return response({ total_blocks: String(BASELINE_BLOCK) }, url);
    throw new Error(`unexpected URL ${url}`);
  };
  assert.deepEqual(await assertPonsExplorerCoverage(healthyFetch, BASELINE_BLOCK - 1), {
    indexedHeight: BASELINE_BLOCK,
    finishedIndexingBlocks: true,
  });
  await assert.rejects(assertPonsExplorerCoverage(async (url) => {
    if (url === PONS_EXPLORER_INDEXING_STATUS_URL) return response({ finished_indexing_blocks: false }, url);
    return response({ total_blocks: String(BASELINE_BLOCK - 10) }, url);
  }, BASELINE_BLOCK), /not indexed through/);
});

test("extracts only a labelled v2 launch factory and never mistakes the hook for it", () => {
  const current = `Launch factory Deploys every launch. Bonding curve One per launch. Meme hook Robinhood Chain, block 23011979
    0x8e99D2009D60A917e9B1c00C04C077b8c0c3a044 Fee escrow 0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c`;
  assert.deepEqual(extractPonsV2FactoryAddresses(current), []);
  const future = `Launch factory Robinhood Chain, block 25000000 ${FAKE_FACTORY} Bonding curve One per launch.`;
  assert.deepEqual(extractPonsV2FactoryAddresses(future), [FAKE_FACTORY]);
});

test("accepts GitHub repositories only from explicit links in official Pons HTML", () => {
  const html = `<script>const hidden = "https://github.com/fake/embedded"</script>
    <a href="https://github.com/pons-labs/contracts">Source code</a>`;
  assert.deepEqual(extractOfficialPonsGithubRepositories(html), ["pons-labs/contracts"]);
});

test("reads the current factory pointer from either official v2 hook", async () => {
  const provider = new FakePonsProvider();
  assert.deepEqual(await readPonsV2FactoryFromHook(provider), {
    address: PONS_V2_MAIN_FACTORY,
    hookAddress: PONS_V2_HOOK,
    source: "official_v2_hook",
  });
  assert.deepEqual(await readPonsV2FactoryFromHook(provider, PONS_V2_MIGRATION_HOOK), {
    address: PONS_V2_MIGRATION_FACTORY,
    hookAddress: PONS_V2_MIGRATION_HOOK,
    source: "official_v2_migration_hook",
  });
});

test("reads the launch switch and config count from a v2 factory", async () => {
  const status = await readPonsV2FactoryStatus(new FakePonsProvider(), PONS_V2_MAIN_FACTORY);
  assert.deepEqual(status, { launchConfigCount: 1, launchEnabled: false });
});

test("keeps only successful top-level creations from the confirmed legacy owner", () => {
  const creations = extractPonsDeployerCreations({ items: [
    { status: "ok", from: { hash: PONS_DEPLOYER }, created_contract: { hash: FAKE_FACTORY }, hash: "0xabc", block_number: 25 },
    { status: "error", from: { hash: PONS_DEPLOYER }, created_contract: { hash: NEW_FACTORY } },
    { status: "ok", from: { hash: NEW_OWNER }, created_contract: { hash: NEW_FACTORY } },
  ] });
  assert.deepEqual(creations, [{ address: FAKE_FACTORY, transactionHash: "0xabc", blockNumber: 25, timestamp: null, source: "pons_deployer" }]);
});

test("requires reciprocal Hook/Factory getters and rejects a copied factory shape", async () => {
  const provider = new FakePonsProvider();
  const verified = await verifyPonsV2Factory(provider, PONS_V2_MAIN_FACTORY, { hookAddress: PONS_V2_HOOK });
  assert.equal(verified.bindingVerified, true);
  assert.equal(verified.reciprocalFactoryGetter, PONS_V2_MAIN_FACTORY);
  assert.equal(verified.reciprocalHookGetter, PONS_V2_HOOK);

  provider.factories[FAKE_FACTORY] = {
    ...provider.factories[PONS_V2_MAIN_FACTORY],
    memeHook: PONS_V2_HOOK,
  };
  const copied = await verifyPonsV2Factory(provider, FAKE_FACTORY, { hookAddress: PONS_V2_HOOK });
  assert.equal(copied, null, "same getters/code on a candidate are insufficient when official hook.factory() points elsewhere");

  provider.factories[PONS_V2_MAIN_FACTORY].memeHook = PONS_V2_MIGRATION_HOOK;
  const oneWayOnly = await verifyPonsV2Factory(provider, PONS_V2_MAIN_FACTORY, { hookAddress: PONS_V2_HOOK });
  assert.equal(oneWayOnly, null, "hook -> factory without factory -> hook must fail closed");
});

test("factory verification throws on unavailable RPCs but returns null for deterministic getter shape mismatches", async () => {
  const getCodeFailure = new FakePonsProvider();
  const originalGetCode = getCodeFailure.getCode.bind(getCodeFailure);
  getCodeFailure.getCode = async (address, blockTag) => {
    if (address.toLowerCase() === PONS_V2_MAIN_FACTORY) throw new Error("temporary getCode RPC failure");
    return originalGetCode(address, blockTag);
  };
  await assert.rejects(
    verifyPonsV2Factory(getCodeFailure, PONS_V2_MAIN_FACTORY, { hookAddress: PONS_V2_HOOK }),
    /temporary getCode RPC failure/,
  );

  const getterFailure = new FakePonsProvider();
  const originalCall = getterFailure.call.bind(getterFailure);
  getterFailure.call = async (request) => {
    if (request.to.toLowerCase() === PONS_V2_MAIN_FACTORY && request.data === selector("memeHook()")) {
      throw new Error("temporary getter RPC failure");
    }
    return originalCall(request);
  };
  await assert.rejects(
    verifyPonsV2Factory(getterFailure, PONS_V2_MAIN_FACTORY, { hookAddress: PONS_V2_HOOK }),
    /temporary getter RPC failure/,
  );

  const deterministicMismatch = new FakePonsProvider();
  const deterministicCall = deterministicMismatch.call.bind(deterministicMismatch);
  deterministicMismatch.call = async (request) => request.to.toLowerCase() === PONS_V2_MAIN_FACTORY && request.data === selector("memeHook()")
    ? "0x"
    : deterministicCall(request);
  assert.equal(
    await verifyPonsV2Factory(deterministicMismatch, PONS_V2_MAIN_FACTORY, { hookAddress: PONS_V2_HOOK }),
    null,
  );
});

test("first run silently builds both official bindings, owners and an event cursor", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    const state = fixture.monitor.state();
    assert.equal(fixture.alerts.length, 0, "historical baseline must not be announced");
    assert.equal(fixture.registrations.length, 2);
    assert.equal(state.knownFactories[PONS_V2_MAIN_FACTORY].role, "main");
    assert.equal(state.knownFactories[PONS_V2_MIGRATION_FACTORY].role, "migration");
    assert.equal(state.trustGraph.hooks[PONS_V2_HOOK].factory, PONS_V2_MAIN_FACTORY);
    assert.equal(state.trustGraph.hooks[PONS_V2_MIGRATION_HOOK].factory, PONS_V2_MIGRATION_FACTORY);
    assert.equal(state.trustGraph.owners[PONS_DEPLOYER].retained, true);
    assert.equal(state.trustGraph.owners[PONS_V2_CURRENT_OWNER].retained, true);
    assert.equal(state.eventCursor.nextBlock, BASELINE_BLOCK + 1);
    assert.ok(fixture.provider.filters.every((filter) => filter.address !== PONS_DEPLOYER));
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("v3 getter-built production baselines migrate as confirmed without replay or pending promotion", async () => {
  const fixture = await createMonitorFixture(new FakePonsProvider(), {
    initialState: {
      version: 3,
      knownFactories: {
        [PONS_V2_MAIN_FACTORY]: {
          version: "v2",
          role: "main",
          hookAddress: PONS_V2_HOOK,
          source: "official_v2_hook",
          blockNumber: null,
          verification: { bindingVerified: true, launchEnabled: false, launchConfigCount: 1 },
        },
        [PONS_V2_MIGRATION_FACTORY]: {
          version: "v2",
          role: "migration",
          hookAddress: PONS_V2_MIGRATION_HOOK,
          source: "official_v2_migration_hook",
          blockNumber: null,
          verification: { bindingVerified: true, launchEnabled: null, launchConfigCount: null },
        },
      },
      eventCursor: { nextBlock: BASELINE_BLOCK + 1, lastScannedBlock: BASELINE_BLOCK },
    },
  });
  try {
    await fixture.monitor.check();
    const state = fixture.monitor.state();
    assert.equal(state.version, 4);
    assert.equal(state.knownFactories[PONS_V2_MAIN_FACTORY].authority, "legacy_baseline_confirmed");
    assert.deepEqual(state.knownFactories[PONS_V2_MAIN_FACTORY].confirmedStatus, {
      launchEnabled: false,
      launchConfigCount: 1,
      source: "legacy_v3_baseline",
    });
    assert.equal(Object.keys(state.pendingFactories).length, 0);
    assert.equal(fixture.alerts.length, 0);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("legacy topic-only factory state is quarantined and not replayed as official", async () => {
  const fixture = await createMonitorFixture(new FakePonsProvider(), {
    initialState: {
      version: 2,
      knownFactories: {
        [FAKE_FACTORY]: {
          version: "v2",
          source: "v2_token_launched_event",
          verification: { evidence: "official_v2_token_launched_signature" },
        },
      },
    },
  });
  try {
    await fixture.monitor.check();
    assert.equal(fixture.registrations.some((record) => record.address === FAKE_FACTORY), false);
    assert.equal(fixture.monitor.state().knownFactories[FAKE_FACTORY], undefined);
    assert.ok(fixture.monitor.state().candidates[FAKE_FACTORY]);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("historical TokenLaunched and TokenMigrated become a silent no-replay baseline", async () => {
  const provider = new FakePonsProvider();
  provider.logs.push(
    makeLog({ address: PONS_V2_MAIN_FACTORY, topic: PONS_V2_TOKEN_LAUNCHED_TOPIC, topics: [addressWord(TOKEN_A)], blockNumber: BASELINE_BLOCK - 5, transactionHash: "0xoldlaunch" }),
    makeLog({ address: PONS_V2_MIGRATION_FACTORY, topic: PONS_V2_TOKEN_MIGRATED_TOPIC, topics: [addressWord(TOKEN_B)], blockNumber: BASELINE_BLOCK - 4, transactionHash: "0xoldmigration" }),
  );
  const fixture = await createMonitorFixture(provider);
  try {
    await fixture.monitor.check();
    assert.equal(fixture.alerts.length, 0);
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MAIN_FACTORY].firstToken.baseline, true);
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MIGRATION_FACTORY].firstMigration.baseline, true);
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MAIN_FACTORY].firstToken.source, "rpc_tail");
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MIGRATION_FACTORY].firstMigration.source, "rpc_tail");

    provider.latest += 1;
    provider.logs.push(
      makeLog({ address: PONS_V2_MAIN_FACTORY, topic: PONS_V2_TOKEN_LAUNCHED_TOPIC, topics: [addressWord(TOKEN_B)], blockNumber: provider.latest, transactionHash: "0xnewlaunch" }),
      makeLog({ address: PONS_V2_MIGRATION_FACTORY, topic: PONS_V2_TOKEN_MIGRATED_TOPIC, topics: [addressWord(TOKEN_A)], blockNumber: provider.latest, transactionHash: "0xnewmigration" }),
    );
    await fixture.monitor.check();
    assert.equal(fixture.alerts.length, 0, "ordinary later lifecycle events are not repeated");
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("a mismatched historical receipt fails closed without committing the Pons cursor", async () => {
  const provider = new FakePonsProvider();
  provider.logs.push(makeLog({
    address: PONS_V2_MAIN_FACTORY,
    topic: PONS_V2_TOKEN_LAUNCHED_TOPIC,
    topics: [addressWord(TOKEN_A)],
    blockNumber: BASELINE_BLOCK - 3_000,
    transactionHash: "0xold-launch-with-bad-receipt",
  }));
  provider.getTransactionReceipt = async () => ({ status: 1, blockNumber: BASELINE_BLOCK - 3_000, logs: [] });
  const fixture = await createMonitorFixture(provider);
  try {
    await assert.rejects(fixture.monitor.check(), /receipt log mismatch/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, null);
    assert.deepEqual(fixture.monitor.state().lifecycle, {});
    assert.equal(fixture.alerts.length, 0);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("verified setter events rotate the active graph while retaining old and current owners", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    fixture.provider.latest += 1;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: NEW_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    fixture.provider.logs.push(
      makeLog({ address: PONS_V2_HOOK, topic: PONS_V2_OWNERSHIP_TRANSFERRED_TOPIC, topics: [addressWord(PONS_V2_CURRENT_OWNER), addressWord(NEW_OWNER)], blockNumber: fixture.provider.latest, transactionHash: "0xowner", index: 0 }),
      makeLog({ address: PONS_V2_HOOK, topic: PONS_V2_FACTORY_SET_TOPIC, data: addressWord(NEW_FACTORY), blockNumber: fixture.provider.latest, transactionHash: "0xfactory", index: 1 }),
      makeLog({ address: PONS_V2_HOOK, topic: PONS_V2_BUYBACK_VAULT_SET_TOPIC, data: addressWord(NEW_VAULT), blockNumber: fixture.provider.latest, transactionHash: "0xvault", index: 2 }),
    );

    await fixture.monitor.check();
    const state = fixture.monitor.state();
    const discovery = fixture.alerts.find((event) => event.type === "pons_v2_factory_discovered");
    assert.equal(state.trustGraph.hooks[PONS_V2_HOOK].factory, NEW_FACTORY);
    assert.equal(state.trustGraph.hooks[PONS_V2_HOOK].buybackVault, NEW_VAULT);
    assert.equal(state.trustGraph.hooks[PONS_V2_HOOK].lastFactorySet.transactionHash, "0xfactory");
    assert.equal(state.trustGraph.hooks[PONS_V2_HOOK].lastBuybackVaultSet.transactionHash, "0xvault");
    assert.equal(state.trustGraph.factories[PONS_V2_MAIN_FACTORY].active, false);
    assert.equal(state.trustGraph.factories[NEW_FACTORY].active, true);
    assert.equal(state.trustGraph.owners[PONS_DEPLOYER].retained, true);
    assert.equal(state.trustGraph.owners[PONS_V2_CURRENT_OWNER].retained, true);
    assert.equal(state.trustGraph.owners[NEW_OWNER].retained, true);
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_discovered").length, 1);
    assert.equal(discovery.blockNumber, fixture.provider.latest);
    assert.match(discovery.blockTimestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("a getter-only factory rotation is recorded silently until a verified FactorySet log exists", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    fixture.provider.latest += 1;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };

    await fixture.monitor.check();
    const state = fixture.monitor.state();
    assert.equal(state.knownFactories[NEW_FACTORY], undefined, "getter fallback must not become authoritative");
    assert.ok(state.pendingFactories[NEW_FACTORY], "the verified getter fallback remains visible in pending audit state");
    assert.equal(state.pendingFactories[NEW_FACTORY].blockTimestamp, undefined);
    assert.equal(state.trustGraph.hooks[PONS_V2_HOOK].factory, PONS_V2_MAIN_FACTORY);
    assert.equal(fixture.alerts.some((event) => event.type === "pons_v2_factory_discovered"), false, "no chain alert is emitted without FactorySet block evidence");
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("getter-only Pons status changes update audit state without an unassessed alert", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    fixture.provider.latest += 1;
    fixture.provider.factories[PONS_V2_MAIN_FACTORY].launchEnabled = true;
    fixture.provider.factories[PONS_V2_MAIN_FACTORY].launchConfigCount = 2n;

    await fixture.monitor.check();
    const record = fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY];
    assert.equal(record.verification.launchEnabled, false);
    assert.equal(record.verification.launchConfigCount, 1);
    assert.equal(record.confirmedStatus.launchEnabled, false);
    assert.equal(record.confirmedStatus.launchConfigCount, 1);
    assert.equal(record.statusRevision, undefined);
    assert.equal(record.pendingStatus.source, "getter_fallback_unconfirmed");
    assert.deepEqual(record.pendingStatus.fields, {
      launchEnabled: { confirmed: false, observed: true },
      launchConfigCount: { confirmed: 1, observed: 2 },
    });
    assert.deepEqual(record.lastGetterStatusChanges, {
      launchEnabled: { before: false, after: true },
      launchConfigCount: { before: 1, after: 2 },
    });
    assert.equal(fixture.alerts.some((event) => event.type === "pons_v2_factory_status_update"), false);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("an unconfirmed getter factory rotation stays pending until the exact finalized FactorySet promotes and alerts once", async () => {
  const provider = new FakePonsProvider();
  const fixture = await createMonitorFixture(provider, { confirmations: 1 });
  try {
    await fixture.monitor.check();
    const factorySetBlock = fixture.monitor.state().eventCursor.nextBlock;
    provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    provider.logs.push(makeLog({
      address: PONS_V2_HOOK,
      topic: PONS_V2_FACTORY_SET_TOPIC,
      data: addressWord(NEW_FACTORY),
      blockNumber: factorySetBlock,
      transactionHash: "0xconfirmation-race-factory",
    }));

    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, factorySetBlock, "the exact log is not finalized yet");
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY], undefined);
    assert.ok(fixture.monitor.state().pendingFactories[NEW_FACTORY]);
    assert.equal(fixture.alerts.length, 0);

    provider.latest += 1;
    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, factorySetBlock + 1);
    assert.equal(fixture.monitor.state().pendingFactories[NEW_FACTORY], undefined);
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY].authority, "factory_set_confirmed");
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY].transactionHash, "0xconfirmation-race-factory");
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_discovered").length, 1);

    await fixture.monitor.check();
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_discovered").length, 1);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("an unconfirmed getter status stays pending until exact finalized LaunchEnabledUpdated alerts from the last confirmed value", async () => {
  const provider = new FakePonsProvider();
  const fixture = await createMonitorFixture(provider, { confirmations: 1 });
  try {
    await fixture.monitor.check();
    const statusBlock = fixture.monitor.state().eventCursor.nextBlock;
    provider.factories[PONS_V2_MAIN_FACTORY].launchEnabled = true;
    provider.logs.push(makeLog({
      address: PONS_V2_MAIN_FACTORY,
      topic: PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC,
      data: uintWord(1),
      blockNumber: statusBlock,
      transactionHash: "0xconfirmation-race-status",
    }));

    await fixture.monitor.check();
    let record = fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY];
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, statusBlock);
    assert.equal(record.verification.launchEnabled, false);
    assert.equal(record.confirmedStatus.launchEnabled, false);
    assert.deepEqual(record.pendingStatus.fields.launchEnabled, { confirmed: false, observed: true });
    assert.equal(fixture.alerts.length, 0);

    provider.latest += 1;
    await fixture.monitor.check();
    record = fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY];
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, statusBlock + 1);
    assert.equal(record.verification.launchEnabled, true);
    assert.equal(record.confirmedStatus.launchEnabled, true);
    assert.equal(record.confirmedStatus.confirmedAtBlock, statusBlock);
    assert.equal(record.pendingStatus, undefined);
    const alerts = fixture.alerts.filter((event) => event.type === "pons_v2_factory_status_update");
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].changes.launchEnabled, { before: false, after: true });

    await fixture.monitor.check();
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_status_update").length, 1);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("LaunchEnabledUpdated is getter-confirmed and announced once", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    fixture.provider.latest += 1;
    fixture.provider.factories[PONS_V2_MAIN_FACTORY].launchEnabled = true;
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_MAIN_FACTORY,
      topic: PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC,
      data: uintWord(1),
      blockNumber: fixture.provider.latest,
      transactionHash: "0xenabled",
    }));
    await fixture.monitor.check();
    await fixture.monitor.check();
    const updates = fixture.alerts.filter((event) => event.type === "pons_v2_factory_status_update");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].changes.launchEnabled, { before: false, after: true });
    assert.equal(updates[0].blockNumber, fixture.provider.latest);
    assert.match(updates[0].blockTimestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("a failed LaunchEnabledUpdated delivery does not advance status or the event cursor", async () => {
  let failOnce = true;
  const fixture = await createMonitorFixture(new FakePonsProvider(), {
    alertFailure: async (event) => {
      if (event.type === "pons_v2_factory_status_update" && failOnce) {
        failOnce = false;
        throw new Error("telegram down");
      }
    },
  });
  try {
    await fixture.monitor.check();
    const firstUnscanned = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest += 1;
    fixture.provider.factories[PONS_V2_MAIN_FACTORY].launchEnabled = true;
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_MAIN_FACTORY,
      topic: PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC,
      data: uintWord(1),
      blockNumber: fixture.provider.latest,
      transactionHash: "0xenabled-retry",
    }));

    await assert.rejects(fixture.monitor.check(), /telegram down/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, firstUnscanned);
    assert.equal(fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY].verification.launchEnabled, false);

    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, fixture.provider.latest + 1);
    assert.equal(fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY].verification.launchEnabled, true);
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_status_update").length, 2);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("future ordinary TokenLaunched stays silent while first TokenMigrated is a unique strong alert", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    fixture.provider.latest += 1;
    fixture.provider.logs.push(
      makeLog({ address: PONS_V2_MAIN_FACTORY, topic: PONS_V2_TOKEN_LAUNCHED_TOPIC, topics: [addressWord(TOKEN_A)], blockNumber: fixture.provider.latest, transactionHash: "0xlaunch-a", index: 0 }),
      makeLog({ address: PONS_V2_MAIN_FACTORY, topic: PONS_V2_TOKEN_LAUNCHED_TOPIC, topics: [addressWord(TOKEN_B)], blockNumber: fixture.provider.latest, transactionHash: "0xlaunch-b", index: 1 }),
      makeLog({ address: PONS_V2_MIGRATION_FACTORY, topic: PONS_V2_TOKEN_MIGRATED_TOPIC, topics: [addressWord(TOKEN_B)], blockNumber: fixture.provider.latest, transactionHash: "0xmigrate-a", index: 0 }),
      makeLog({ address: PONS_V2_MIGRATION_FACTORY, topic: PONS_V2_TOKEN_MIGRATED_TOPIC, topics: [addressWord(TOKEN_A)], blockNumber: fixture.provider.latest, transactionHash: "0xmigrate-b", index: 1 }),
    );
    await fixture.monitor.check();
    await fixture.monitor.check();

    const launches = fixture.alerts.filter((event) => event.eventKey === `pons-v2-first-token:${PONS_V2_MAIN_FACTORY}`);
    const migrations = fixture.alerts.filter((event) => event.eventKey === `pons-v2-first-migration:${PONS_V2_MIGRATION_FACTORY}`);
    assert.equal(launches.length, 0);
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MAIN_FACTORY].firstToken.token, TOKEN_A);
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MAIN_FACTORY].firstToken.baseline, false);
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0].modeStatus, "new_mode_candidate");
    assert.equal(migrations[0].mode.selector, "TokenMigrated");
    assert.equal(migrations[0].tokens[0].token, TOKEN_B);
    assert.equal(migrations[0].blockNumber, fixture.provider.latest);
    assert.match(migrations[0].blockTimestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(isRelevantAlert(migrations[0]), true);
    assert.equal(isStrongAlert(migrations[0]), true);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, fixture.provider.latest + 1);

    const queriedTopics = fixture.provider.filters.flatMap((filter) => Array.isArray(filter.topics?.[0]) ? filter.topics[0] : [filter.topics?.[0]]);
    assert.ok(queriedTopics.includes(PONS_V2_FACTORY_SET_TOPIC));
    assert.ok(queriedTopics.includes(PONS_V2_TOKEN_LAUNCHED_TOPIC));
    assert.ok(queriedTopics.includes(PONS_V2_TOKEN_MIGRATED_TOPIC));
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("3h-old Pons config, migration and factory events use cached block time and are freshness-suppressed", async (t) => {
  const fixture = await createMonitorFixture();
  const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), "pons-v2-stale-alerts-"));
  t.after(() => Promise.all([
    fs.rm(fixture.dataDir, { recursive: true, force: true }),
    fs.rm(auditDir, { recursive: true, force: true }),
  ]));

  await fixture.monitor.check();
  const discoveredAt = new Date();
  const oldTimestampMs = discoveredAt.getTime() - 3 * 60 * 60_000;
  const oldBlockTimestamp = new Date(Math.floor(oldTimestampMs / 1_000) * 1_000).toISOString();

  const lifecycleBlock = ++fixture.provider.latest;
  fixture.provider.blockTimestamps.set(lifecycleBlock, Math.floor(oldTimestampMs / 1_000));
  fixture.provider.factories[PONS_V2_MAIN_FACTORY].launchEnabled = true;
  fixture.provider.logs.push(
    makeLog({ address: PONS_V2_MAIN_FACTORY, topic: PONS_V2_TOKEN_LAUNCHED_TOPIC, topics: [addressWord(TOKEN_A)], blockNumber: lifecycleBlock, transactionHash: "0xstale-launch", index: 0 }),
    makeLog({ address: PONS_V2_MAIN_FACTORY, topic: PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC, data: uintWord(1), blockNumber: lifecycleBlock, transactionHash: "0xstale-enabled", index: 1 }),
    makeLog({ address: PONS_V2_MIGRATION_FACTORY, topic: PONS_V2_TOKEN_MIGRATED_TOPIC, topics: [addressWord(TOKEN_B)], blockNumber: lifecycleBlock, transactionHash: "0xstale-migration", index: 0 }),
  );
  await fixture.monitor.check();

  const factoryBlock = ++fixture.provider.latest;
  fixture.provider.blockTimestamps.set(factoryBlock, Math.floor(oldTimestampMs / 1_000));
  fixture.provider.hooks[PONS_V2_HOOK] = {
    factory: NEW_FACTORY,
    buybackVault: NEW_VAULT,
    owner: PONS_V2_CURRENT_OWNER,
    feeEscrow: PONS_V2_FEE_ESCROW,
    poolManager: PONS_V2_POOL_MANAGER,
  };
  fixture.provider.factories[NEW_FACTORY] = {
    memeHook: PONS_V2_HOOK,
    buybackVault: NEW_VAULT,
    feeEscrow: PONS_V2_FEE_ESCROW,
    poolManager: PONS_V2_POOL_MANAGER,
    launchConfigCount: 1n,
    launchEnabled: false,
  };
  fixture.provider.logs.push(
    makeLog({ address: PONS_V2_HOOK, topic: PONS_V2_FACTORY_SET_TOPIC, data: addressWord(NEW_FACTORY), blockNumber: factoryBlock, transactionHash: "0xstale-factory", index: 0 }),
    makeLog({ address: PONS_V2_HOOK, topic: PONS_V2_BUYBACK_VAULT_SET_TOPIC, data: addressWord(NEW_VAULT), blockNumber: factoryBlock, transactionHash: "0xstale-vault", index: 1 }),
  );
  await fixture.monitor.check();

  const configEvent = fixture.alerts.find((event) => event.type === "pons_v2_factory_status_update");
  const migrationEvent = fixture.alerts.find((event) => event.eventKey === `pons-v2-first-migration:${PONS_V2_MIGRATION_FACTORY}`);
  const factoryEvent = fixture.alerts.find((event) => event.type === "pons_v2_factory_discovered");
  const staleEvents = [configEvent, migrationEvent, factoryEvent];
  assert.ok(staleEvents.every(Boolean));
  assert.equal(fixture.alerts.some((event) => event.eventKey === `pons-v2-first-token:${PONS_V2_MAIN_FACTORY}`), false);
  assert.equal(fixture.provider.blockRequests.filter((block) => block === lifecycleBlock).length, 1, "same-block config and migration share one timestamp lookup");
  assert.equal(fixture.provider.blockRequests.filter((block) => block === factoryBlock).length, 1);

  for (const event of staleEvents) {
    assert.equal(event.blockTimestamp, oldBlockTimestamp);
    const freshness = classifyAlertFreshness({}, event, discoveredAt);
    assert.equal(freshness.scope, "robinhood_chain");
    assert.equal(freshness.basis, "blockTimestamp");
    assert.equal(freshness.sourceOccurredAt, oldBlockTimestamp);
    assert.equal(freshness.decision, "suppress");
    const result = await sendAlerts({ dataDir: auditDir, blockedContracts: new Set() }, event);
    assert.equal(result.status, "suppressed");
    assert.equal(result.freshness.decision, "suppress");
  }

  const outbox = JSON.parse(await fs.readFile(path.join(auditDir, "alert-outbox.json"), "utf8"));
  assert.equal(Object.keys(outbox.events).length, 3);
  assert.ok(Object.values(outbox.events).every((entry) => entry.status === "suppressed"));
});

test("transient Pons verification RPC failures keep FactorySet and related-log cursors retryable", async (t) => {
  await t.test("FactorySet getCode failure", async () => {
    const fixture = await createMonitorFixture();
    t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));
    await fixture.monitor.check();
    const nextBlock = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest = nextBlock;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_HOOK,
      topic: PONS_V2_FACTORY_SET_TOPIC,
      data: addressWord(NEW_FACTORY),
      blockNumber: nextBlock,
      transactionHash: "0xtransient-factory-code",
    }));
    const originalGetCode = fixture.provider.getCode.bind(fixture.provider);
    let unavailable = true;
    fixture.provider.getCode = async (address, blockTag) => {
      if (unavailable && address.toLowerCase() === NEW_FACTORY) throw new Error("temporary FactorySet getCode RPC failure");
      return originalGetCode(address, blockTag);
    };

    await assert.rejects(fixture.monitor.check(), /temporary FactorySet getCode RPC failure/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock);
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY], undefined);
    assert.equal(fixture.monitor.state().trustGraph.hooks[PONS_V2_HOOK].factory, PONS_V2_MAIN_FACTORY);
    assert.equal(fixture.alerts.length, 0);

    unavailable = false;
    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock + 1);
    assert.ok(fixture.monitor.state().knownFactories[NEW_FACTORY]);
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_discovered").length, 1);
  });

  await t.test("FactorySet confirmCandidate verification failure", async () => {
    const provider = new FakePonsProvider();
    let setterVerifications = 0;
    const fixture = await createMonitorFixture(provider, {
      verifyFactoryImpl: async (address, evidence) => {
        if (address.toLowerCase() === NEW_FACTORY && evidence.evidenceSource === "verified_factory_set_event") {
          setterVerifications += 1;
          if (setterVerifications === 2) throw new Error("temporary confirmCandidate RPC failure");
        }
        return verifyPonsV2Factory(provider, address, evidence);
      },
    });
    t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));
    await fixture.monitor.check();
    const nextBlock = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest = nextBlock;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_HOOK,
      topic: PONS_V2_FACTORY_SET_TOPIC,
      data: addressWord(NEW_FACTORY),
      blockNumber: nextBlock,
      transactionHash: "0xtransient-confirm-candidate",
    }));

    await assert.rejects(fixture.monitor.check(), /temporary confirmCandidate RPC failure/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock);
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY], undefined);
    assert.equal(fixture.alerts.length, 0);

    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock + 1);
    assert.ok(fixture.monitor.state().knownFactories[NEW_FACTORY]);
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_discovered").length, 1);
  });

  await t.test("deterministic FactorySet mismatch", async () => {
    const fixture = await createMonitorFixture();
    t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));
    await fixture.monitor.check();
    const nextBlock = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest = nextBlock;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_MIGRATION_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_HOOK,
      topic: PONS_V2_FACTORY_SET_TOPIC,
      data: addressWord(NEW_FACTORY),
      blockNumber: nextBlock,
      transactionHash: "0xdeterministic-mismatch",
    }));

    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock + 1, "a conclusive non-Pons shape is not an RPC coverage gap");
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY], undefined);
    assert.ok(fixture.monitor.state().candidates[NEW_FACTORY]);
    assert.equal(fixture.alerts.length, 0);
  });

  await t.test("LaunchEnabledUpdated reciprocal-getter failure", async () => {
    const fixture = await createMonitorFixture();
    t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));
    await fixture.monitor.check();
    const nextBlock = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest = nextBlock;
    fixture.provider.factories[PONS_V2_MAIN_FACTORY].launchEnabled = true;
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_MAIN_FACTORY,
      topic: PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC,
      data: uintWord(1),
      blockNumber: nextBlock,
      transactionHash: "0xtransient-related-getter",
    }));
    const originalCall = fixture.provider.call.bind(fixture.provider);
    let unavailable = true;
    fixture.provider.call = async (request) => {
      if (unavailable
        && Number(request.blockTag) === nextBlock
        && request.to.toLowerCase() === PONS_V2_MAIN_FACTORY
        && request.data === selector("memeHook()")) {
        throw new Error("temporary related-log getter RPC failure");
      }
      return originalCall(request);
    };

    await assert.rejects(fixture.monitor.check(), /temporary related-log getter RPC failure/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock);
    assert.equal(fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY].verification.launchEnabled, false);
    assert.equal(fixture.alerts.length, 0);

    unavailable = false;
    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock + 1);
    assert.equal(fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY].verification.launchEnabled, true);
    assert.equal(fixture.alerts.filter((event) => event.type === "pons_v2_factory_status_update").length, 1);
  });
});

test("Pons chain events fail closed without advancing their cursor or related state when block time is unavailable", async (t) => {
  await t.test("LaunchEnabledUpdated", async () => {
    const fixture = await createMonitorFixture();
    t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));
    await fixture.monitor.check();
    const nextBlock = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest = nextBlock;
    fixture.provider.factories[PONS_V2_MAIN_FACTORY].launchEnabled = true;
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_MAIN_FACTORY,
      topic: PONS_V2_LAUNCH_ENABLED_UPDATED_TOPIC,
      data: uintWord(1),
      blockNumber: nextBlock,
      transactionHash: "0xmissing-config-time",
    }));
    fixture.provider.blockErrors.set(nextBlock, new Error("block time unavailable"));

    await assert.rejects(fixture.monitor.check(), /block time unavailable/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock);
    assert.equal(fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY].verification.launchEnabled, false);
    assert.equal(fixture.alerts.some((event) => event.transactionHash === "0xmissing-config-time"), false);

    fixture.provider.blockErrors.delete(nextBlock);
    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock + 1);
    assert.equal(fixture.monitor.state().knownFactories[PONS_V2_MAIN_FACTORY].verification.launchEnabled, true);
  });

  await t.test("first TokenMigrated", async () => {
    const fixture = await createMonitorFixture();
    t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));
    await fixture.monitor.check();
    const nextBlock = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest = nextBlock;
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_MIGRATION_FACTORY,
      topic: PONS_V2_TOKEN_MIGRATED_TOPIC,
      topics: [addressWord(TOKEN_A)],
      blockNumber: nextBlock,
      transactionHash: "0xmissing-migration-time",
    }));
    fixture.provider.blockErrors.set(nextBlock, new Error("block time unavailable"));

    await assert.rejects(fixture.monitor.check(), /block time unavailable/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock);
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MIGRATION_FACTORY]?.firstMigration, undefined);
    assert.equal(fixture.alerts.some((event) => event.transactionHash === "0xmissing-migration-time"), false);

    fixture.provider.blockErrors.delete(nextBlock);
    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock + 1);
    assert.equal(fixture.monitor.state().lifecycle[PONS_V2_MIGRATION_FACTORY].firstMigration.transactionHash, "0xmissing-migration-time");
  });

  await t.test("verified FactorySet discovery", async () => {
    const fixture = await createMonitorFixture();
    t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));
    await fixture.monitor.check();
    const nextBlock = fixture.monitor.state().eventCursor.nextBlock;
    fixture.provider.latest = nextBlock;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_HOOK,
      topic: PONS_V2_FACTORY_SET_TOPIC,
      data: addressWord(NEW_FACTORY),
      blockNumber: nextBlock,
      transactionHash: "0xmissing-factory-time",
    }));
    fixture.provider.blockErrors.set(nextBlock, new Error("block time unavailable"));

    await assert.rejects(fixture.monitor.check(), /block time unavailable/);
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock);
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY], undefined);
    assert.equal(fixture.monitor.state().trustGraph.hooks[PONS_V2_HOOK].factory, PONS_V2_MAIN_FACTORY);
    assert.equal(fixture.alerts.some((event) => event.factory === NEW_FACTORY), false);

    fixture.provider.blockErrors.delete(nextBlock);
    await fixture.monitor.check();
    assert.equal(fixture.monitor.state().eventCursor.nextBlock, nextBlock + 1);
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY].transactionHash, "0xmissing-factory-time");
  });
});

test("a verified factory candidate normalizes its supplied chain timestamp before RPC lookup", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    const nextBlock = ++fixture.provider.latest;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    fixture.provider.logs.push(makeLog({
      address: PONS_V2_HOOK,
      topic: PONS_V2_FACTORY_SET_TOPIC,
      data: addressWord(NEW_FACTORY),
      blockNumber: nextBlock,
      transactionHash: "0xsupplied-factory-time",
      timestamp: "2026-08-06T12:34:56+08:00",
    }));

    await fixture.monitor.check();
    const discovery = fixture.alerts.find((event) => event.factory === NEW_FACTORY);
    assert.equal(discovery.blockTimestamp, "2026-08-06T04:34:56.000Z");
    assert.equal(fixture.provider.blockRequests.includes(nextBlock), false);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("observeLaunchFactory records a new verified factory silently and fails closed on missing block time", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    const nextBlock = fixture.provider.latest + 1;
    fixture.provider.hooks[PONS_V2_HOOK] = {
      factory: NEW_FACTORY,
      buybackVault: NEW_VAULT,
      owner: PONS_V2_CURRENT_OWNER,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
    };
    fixture.provider.factories[NEW_FACTORY] = {
      memeHook: PONS_V2_HOOK,
      buybackVault: NEW_VAULT,
      feeEscrow: PONS_V2_FEE_ESCROW,
      poolManager: PONS_V2_POOL_MANAGER,
      launchConfigCount: 1n,
      launchEnabled: false,
    };
    fixture.provider.blockErrors.set(nextBlock, new Error("block time unavailable"));

    await assert.rejects(fixture.monitor.observeLaunchFactory(NEW_FACTORY, {
      transactionHash: "0xobserved-new-factory",
      blockNumber: nextBlock,
    }), /block time unavailable/);
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY], undefined);
    assert.equal(fixture.alerts.length, 0);

    fixture.provider.blockErrors.delete(nextBlock);
    const accepted = await fixture.monitor.observeLaunchFactory(NEW_FACTORY, {
      transactionHash: "0xobserved-new-factory",
      blockNumber: nextBlock,
    });
    assert.equal(accepted, true);
    assert.equal(fixture.alerts.length, 0, "TokenLaunched evidence without FactorySet stays completely silent");
    assert.equal(fixture.monitor.state().knownFactories[NEW_FACTORY], undefined);
    assert.match(fixture.monitor.state().pendingFactories[NEW_FACTORY].blockTimestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("observeLaunchFactory refuses topic-only attribution", async () => {
  const fixture = await createMonitorFixture();
  try {
    await fixture.monitor.check();
    fixture.provider.factories[FAKE_FACTORY] = {
      ...fixture.provider.factories[PONS_V2_MAIN_FACTORY],
      memeHook: PONS_V2_HOOK,
    };
    const accepted = await fixture.monitor.observeLaunchFactory(FAKE_FACTORY, {
      transactionHash: "0xfake",
      blockNumber: fixture.provider.latest,
    });
    assert.equal(accepted, false);
    assert.equal(fixture.monitor.state().knownFactories[FAKE_FACTORY], undefined);
  } finally {
    await fs.rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("Pons stop is idempotent and drains an in-flight lifecycle checkpoint", async (t) => {
  const provider = new FakePonsProvider();
  let headRequests = 0;
  let releaseHead;
  const headHeld = new Promise((resolve) => { releaseHead = resolve; });
  let markHeadStarted;
  const headStarted = new Promise((resolve) => { markHeadStarted = resolve; });
  provider.getBlockNumber = async () => {
    headRequests += 1;
    markHeadStarted();
    await headHeld;
    return provider.latest;
  };
  const fixture = await createMonitorFixture(provider);
  t.after(() => fs.rm(fixture.dataDir, { recursive: true, force: true }));

  const checking = fixture.monitor.check();
  await headStarted;
  const stopping = fixture.monitor.stop();
  assert.equal(fixture.monitor.stop(), stopping, "repeated stops share one drain boundary");
  void fixture.monitor.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(headRequests, 1, "post-stop checks cannot start a second lifecycle scan");
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseHead();
  await Promise.all([checking, stopping]);
  assert.equal(await fixture.monitor.observeLaunchFactory(NEW_FACTORY, {
    transactionHash: "0xlate-after-stop",
    blockNumber: BASELINE_BLOCK + 1,
  }), false);
  const durable = JSON.parse(await fs.readFile(path.join(fixture.dataDir, "pons-version-state.json"), "utf8"));
  assert.equal(durable.eventCursor.lastScannedBlock, BASELINE_BLOCK);
  assert.equal(durable.pendingFactories[NEW_FACTORY], undefined);
});
