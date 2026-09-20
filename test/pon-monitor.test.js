import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { id, Interface, keccak256 } from "ethers";
import {
  PON_CHAIN_ID,
  PON_COIN_IMPL,
  PON_CURVE_IMPL,
  PON_FACTORY,
  PON_FACTORY_DEPLOY_BLOCK,
  PON_FACTORY_DEPLOY_BLOCK_HASH,
  PON_FACTORY_DEPLOY_TRANSACTION,
  PON_FACTORY_EVENT_TOPICS,
  PON_FACTORY_INTERFACE,
  PON_HEALTH_URL,
  PON_INITIAL_OWNER,
  PON_MARKETS_URL,
  PON_PLATFORM_TOKEN_URL,
  PON_SOURCE_ID,
  PON_SOURCE_TRUST,
  PON_TOKEN_LIST_URL,
  PON_USDG,
  PON_VAULT_IMPL,
  PONFUN_TOKEN,
  createPonMonitor,
} from "../src/pon-monitor.js";
import { isOfficialPonFunUpdate } from "../src/source-controls.js";
import { sendAlerts } from "../src/alerts.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ORACLE = "0x85a3cC5eEb0Eaa7A6BeddC8C672F67E9d5C1e377";
const ROUTER = "0x1111111111111111111111111111111111111111";
const POSITION_MANAGER = "0x2222222222222222222222222222222222222222";
const FACTORY_CODE = "0x6001600055";
const CONTRACT_CODE = "0x6000600055";
const CREATION_DATA = "0x60006001";
const START_HEAD = PON_FACTORY_DEPLOY_BLOCK + 100;
const ERC20_INTERFACE = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

const MARKET_A = Object.freeze({
  ticker: "AMC",
  symbol: "AMCAPE",
  name: "Apes Together Strong",
  coin: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  vault: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01",
  curve: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02",
  creator: PON_INITIAL_OWNER,
  creatorFeeBps: 200,
  createdAt: 1_788_277_484,
  stockToken: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03",
  poolFee: 3_000,
  graduated: false,
  lpDeployed: false,
  backingPct: 95.8,
  progressBps: 100,
  marketCap: 15,
  reserve: 10,
  vol24: 5,
});

const MARKET_B = Object.freeze({
  ticker: "BETA",
  symbol: "BETAPON",
  name: "Beta Pon Market",
  coin: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  vault: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01",
  curve: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02",
  creator: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb03",
  creatorFeeBps: 150,
  createdAt: 1_788_300_000,
  stockToken: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb04",
  poolFee: 10_000,
  graduated: false,
  lpDeployed: false,
  backingPct: 92.5,
  progressBps: 10,
  marketCap: 2,
  reserve: 1,
  vol24: 1,
});

const MARKET_C = Object.freeze({
  ...MARKET_B,
  ticker: "GAMMA",
  symbol: "GAMMAPON",
  name: "Gamma Pon Market",
  coin: "0xcccccccccccccccccccccccccccccccccccccccc",
  vault: "0xcccccccccccccccccccccccccccccccccccccc01",
  curve: "0xcccccccccccccccccccccccccccccccccccccc02",
  creator: "0xcccccccccccccccccccccccccccccccccccccc03",
  stockToken: "0xcccccccccccccccccccccccccccccccccccccc04",
});

function syntheticMarket(index) {
  const contract = (offset) => `0x${(BigInt(index + 1) * 10n + BigInt(offset)).toString(16).padStart(40, "0")}`;
  return {
    ...clone(MARKET_B),
    ticker: `T${index}`,
    symbol: `PON${index}`,
    name: `Synthetic Pon Market ${index}`,
    coin: contract(1),
    vault: contract(2),
    curve: contract(3),
    creator: PON_INITIAL_OWNER,
    stockToken: contract(4),
    createdAt: MARKET_B.createdAt + index,
  };
}

const blockHash = (number) => number === PON_FACTORY_DEPLOY_BLOCK
  ? PON_FACTORY_DEPLOY_BLOCK_HASH
  : id(`pon-test-block:${number}`);

function clone(value) {
  return structuredClone(value);
}

function tokenList(markets) {
  return {
    name: "pon.fun",
    timestamp: new Date().toISOString(),
    version: { major: 1, minor: 0, patch: 3 },
    tokens: markets.map((market) => ({
      chainId: PON_CHAIN_ID,
      address: market.coin,
      symbol: market.symbol,
      name: market.name,
      extensions: {
        peggedToStock: market.ticker,
        vault: market.vault,
        curve: market.curve,
      },
    })),
  };
}

function jsonResponse(url, payload, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    url: options.responseUrl ?? url,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(payload),
  };
}

class FakePonProvider {
  constructor(markets = [clone(MARKET_A)]) {
    this.chainId = PON_CHAIN_ID;
    this.head = START_HEAD;
    this.factoryCode = FACTORY_CODE;
    this.platformTokenCode = CONTRACT_CODE;
    this.platformTokenName = "Ponfun";
    this.platformTokenSymbol = "PONFUN";
    this.platformTokenDecimals = 18;
    this.platformTokenTotalSupply = 1_000_000_000n * (10n ** 18n);
    this.markets = markets;
    this.logs = [];
    this.receipts = new Map();
    this.blockHashes = new Map();
    this.archiveCodeRequested = false;
    this.owner = PON_INITIAL_OWNER;
    this.pendingOwner = ZERO_ADDRESS;
    this.oracle = ORACLE;
    this.usdg = PON_USDG;
    this.swapRouter = ROUTER;
    this.positionManager = POSITION_MANAGER;
    this.protocolTreasury = PON_INITIAL_OWNER;
    this.paused = false;
    this.curveParams = {
      p0: 200_000_000_000_000n,
      slope: 7_250_000_000_000_000_000_000_000n,
      curveCap: 800_000_000_000_000_000_000_000_000n,
      lpPoolFee: 10_000,
      maxSlippageBps: 300,
      autoAcquire: true,
    };
    this.listings = new Map(this.markets.map((market) => [market.ticker, {
      stockToken: market.stockToken,
      poolFee: market.poolFee,
      active: true,
      ticker: market.ticker,
    }]));
    this.initialMarketCount = this.markets.length;
    this.initialListingTickers = new Set(this.listings.keys());
    this.historicalMarketCountOverride = null;
    this.historicalListingCountOverride = null;
    this.returnForeignLogs = false;
  }

  async getNetwork() {
    return { chainId: BigInt(this.chainId) };
  }

  async send(method) {
    assert.equal(method, "eth_chainId");
    return `0x${BigInt(this.chainId).toString(16)}`;
  }

  async getBlockNumber() {
    return this.head;
  }

  async getBlock(number) {
    const blockNumber = Number(number);
    return {
      number: blockNumber,
      hash: this.blockHashes.get(blockNumber) || blockHash(blockNumber),
      timestamp: 1_788_274_684 + (blockNumber - PON_FACTORY_DEPLOY_BLOCK),
    };
  }

  async getCode(candidate, blockTag) {
    const normalized = String(candidate).toLowerCase();
    if (normalized === PON_FACTORY.toLowerCase()) {
      if (Number(blockTag) === PON_FACTORY_DEPLOY_BLOCK) {
        this.archiveCodeRequested = true;
        throw new Error("archive metadata unavailable");
      }
      return this.factoryCode;
    }
    if (normalized === PONFUN_TOKEN.toLowerCase()) return this.platformTokenCode;
    const contractAddresses = new Set([
      this.oracle,
      this.usdg,
      PONFUN_TOKEN,
      ...this.markets.flatMap((market) => [market.coin, market.vault, market.curve, market.stockToken]),
    ].map((value) => value.toLowerCase()));
    return contractAddresses.has(normalized) ? CONTRACT_CODE : "0x";
  }

  async getTransactionReceipt(transactionHash) {
    if (transactionHash.toLowerCase() === PON_FACTORY_DEPLOY_TRANSACTION.toLowerCase()) {
      return {
        status: 1,
        blockNumber: PON_FACTORY_DEPLOY_BLOCK,
        blockHash: PON_FACTORY_DEPLOY_BLOCK_HASH,
        contractAddress: PON_FACTORY,
        from: PON_INITIAL_OWNER,
        to: null,
        logs: [],
      };
    }
    return this.receipts.get(transactionHash.toLowerCase()) || null;
  }

  async getTransaction(transactionHash) {
    if (transactionHash.toLowerCase() !== PON_FACTORY_DEPLOY_TRANSACTION.toLowerCase()) return null;
    return {
      hash: PON_FACTORY_DEPLOY_TRANSACTION,
      from: PON_INITIAL_OWNER,
      to: null,
      nonce: 1,
      data: CREATION_DATA,
    };
  }

  listingFor(ticker) {
    const listed = this.listings.get(String(ticker));
    if (listed) return listed;
    const market = this.markets.find((candidate) => candidate.ticker === String(ticker));
    return market
      ? { stockToken: market.stockToken, poolFee: market.poolFee, active: true, ticker: market.ticker }
      : { stockToken: ZERO_ADDRESS, poolFee: 0, active: false, ticker: "" };
  }

  async call({ to, data, blockTag }) {
    if (String(to || "").toLowerCase() === PONFUN_TOKEN.toLowerCase()) {
      const transaction = ERC20_INTERFACE.parseTransaction({ data });
      assert.ok(transaction, `unknown ERC20 call ${data}`);
      if (transaction.name === "name") return ERC20_INTERFACE.encodeFunctionResult("name", [this.platformTokenName]);
      if (transaction.name === "symbol") return ERC20_INTERFACE.encodeFunctionResult("symbol", [this.platformTokenSymbol]);
      if (transaction.name === "decimals") return ERC20_INTERFACE.encodeFunctionResult("decimals", [this.platformTokenDecimals]);
      if (transaction.name === "totalSupply") return ERC20_INTERFACE.encodeFunctionResult("totalSupply", [this.platformTokenTotalSupply]);
      throw new Error(`unexpected ERC20 call ${transaction.name}`);
    }
    const transaction = PON_FACTORY_INTERFACE.parseTransaction({ data });
    assert.ok(transaction, `unknown factory call ${data}`);
    const name = transaction.name;
    const single = (value) => PON_FACTORY_INTERFACE.encodeFunctionResult(name, [value]);
    if (name === "owner") return single(this.owner);
    if (name === "pendingOwner") return single(this.pendingOwner);
    if (name === "oracle") return single(this.oracle);
    if (name === "usdg") return single(this.usdg);
    if (name === "swapRouter") return single(this.swapRouter);
    if (name === "positionManager") return single(this.positionManager);
    if (name === "protocolTreasury") return single(this.protocolTreasury);
    if (name === "paused") return single(this.paused);
    if (name === "coinImpl") return single(PON_COIN_IMPL);
    if (name === "vaultImpl") return single(PON_VAULT_IMPL);
    if (name === "curveImpl") return single(PON_CURVE_IMPL);
    if (name === "marketCount") {
      const count = Number.isSafeInteger(Number(blockTag)) && Number(blockTag) < this.head
        ? (this.historicalMarketCountOverride
          ?? (this.initialMarketCount + this.logs.filter((log) => log.blockNumber <= Number(blockTag)
            && log.topics[0].toLowerCase() === PON_FACTORY_EVENT_TOPICS.MarketCreated.toLowerCase()).length))
        : this.markets.length;
      return single(BigInt(count));
    }
    if (name === "listingCount") {
      let count = this.listings.size;
      if (Number.isSafeInteger(Number(blockTag)) && Number(blockTag) < this.head) {
        if (this.historicalListingCountOverride !== null) {
          count = this.historicalListingCountOverride;
        } else {
          const tickers = new Set(this.initialListingTickers);
          for (const log of this.logs.filter((candidate) => candidate.blockNumber <= Number(blockTag)
            && candidate.topics[0].toLowerCase() === PON_FACTORY_EVENT_TOPICS.StockListed.toLowerCase())) {
            tickers.add(PON_FACTORY_INTERFACE.parseLog(log).args.ticker);
          }
          count = tickers.size;
        }
      }
      return single(BigInt(count));
    }
    if (name === "curveParams") {
      return PON_FACTORY_INTERFACE.encodeFunctionResult(name, [
        this.curveParams.p0,
        this.curveParams.slope,
        this.curveParams.curveCap,
        this.curveParams.lpPoolFee,
        this.curveParams.maxSlippageBps,
        this.curveParams.autoAcquire,
      ]);
    }
    if (name === "coinToId") {
      const coin = String(transaction.args.coin).toLowerCase();
      const index = this.markets.findIndex((market) => market.coin.toLowerCase() === coin);
      return single(index < 0 ? 0n : BigInt(index + 1));
    }
    if (name === "getMarketById") {
      const market = this.markets[Number(transaction.args.id)];
      if (!market) throw new Error("market not found");
      return single([
        market.coin,
        market.vault,
        market.curve,
        market.creator,
        market.creatorFeeBps,
        market.createdAt,
        market.ticker,
        market.symbol,
        market.name,
      ]);
    }
    if (name === "getListing") {
      const listing = this.listingFor(transaction.args.ticker);
      return single([listing.stockToken, listing.poolFee, listing.active, listing.ticker]);
    }
    throw new Error(`unexpected factory call ${name}`);
  }

  addEvent(name, args, blockNumber = this.head + 1, options = {}) {
    this.head = Math.max(this.head, blockNumber);
    const encoded = PON_FACTORY_INTERFACE.encodeEventLog(PON_FACTORY_INTERFACE.getEvent(name), args);
    const transactionHash = options.transactionHash || id(`pon-test-event:${name}:${blockNumber}:${this.logs.length}`);
    const index = options.index ?? 0;
    const log = {
      address: options.address || PON_FACTORY,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber,
      blockHash: this.blockHashes.get(blockNumber) || blockHash(blockNumber),
      transactionHash,
      transactionIndex: options.transactionIndex ?? 0,
      index,
    };
    this.logs.push(log);
    this.receipts.set(transactionHash.toLowerCase(), {
      status: 1,
      blockNumber,
      blockHash: log.blockHash,
      logs: [log],
    });
    return log;
  }

  async getLogs(filter) {
    const allowed = new Set((Array.isArray(filter.topics?.[0]) ? filter.topics[0] : [filter.topics?.[0]])
      .filter(Boolean).map((topic) => String(topic).toLowerCase()));
    return this.logs.filter((log) => log.blockNumber >= Number(filter.fromBlock)
      && log.blockNumber <= Number(filter.toBlock)
      && allowed.has(log.topics[0].toLowerCase())
      && (this.returnForeignLogs || log.address.toLowerCase() === String(filter.address).toLowerCase()));
  }
}

async function harness(t, options = {}) {
  const ownDirectory = !options.dataDir;
  const dataDir = options.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-test-"));
  if (ownDirectory) t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = options.provider || new FakePonProvider();
  const api = options.api || {
    markets: provider.markets.map(clone),
    healthFactory: PON_FACTORY,
    responseUrls: {},
    fail: new Set(),
  };
  api.platformToken ||= { address: PONFUN_TOKEN, symbol: "PONFUN", name: "Ponfun", supply: 1_000_000_000 };
  const alerts = options.alerts || [];
  api.requests ||= [];
  const fetchImpl = options.fetchImpl || (async (url, request) => {
    api.requests.push({ url, redirect: request?.redirect });
    if (api.fail.has(url)) throw new Error(`offline ${url}`);
    const responseUrl = api.responseUrls[url] || url;
    if (url === PON_HEALTH_URL) return jsonResponse(url, {
      ok: true,
      deployed: true,
      chainId: api.healthChainId ?? PON_CHAIN_ID,
      block: api.healthBlock ?? provider.head,
      latencyMs: 5,
      addresses: { factory: api.healthFactory, oracle: provider.oracle, usdg: provider.usdg },
    }, { responseUrl });
    if (url === PON_MARKETS_URL) {
      if (api.marketGate) await api.marketGate;
      return jsonResponse(url, { deployed: true, markets: api.markets }, { responseUrl });
    }
    if (url === PON_PLATFORM_TOKEN_URL) return jsonResponse(url, { ...api.platformToken, priceUsd: null }, { responseUrl });
    if (url === PON_TOKEN_LIST_URL) return jsonResponse(url, tokenList(api.markets), { responseUrl });
    throw new Error(`unexpected URL ${url}`);
  });
  const clock = options.now || (() => Date.parse("2026-09-02T12:00:00.000Z"));
  const monitor = createPonMonitor({
    dataDir,
    ponMonitorEnabled: true,
    ponPollIntervalMs: 1_000,
    ponRequestTimeoutMs: 1_000,
    ponEventChunkSize: 100,
    ponMaxBlocksPerCycle: 1_000,
    ponBackoffBaseMs: 250,
    ponBackoffMaxMs: 1_000,
    ponPendingLimit: options.pendingLimit || 10,
    confirmations: 0,
    alertNow: clock,
    ...(options.config || {}),
  }, {
    provider,
    fetchImpl,
    autoStart: options.autoStart === true,
    expectedFactoryCodeHash: keccak256(FACTORY_CODE),
    expectedCreationInputHash: keccak256(CREATION_DATA),
    sendAlertsImpl: options.sendAlertsImpl || (async (_config, event) => {
      alerts.push(event);
      return { status: "delivered", eventId: event.eventKey };
    }),
    logger: { error() {} },
    now: clock,
  });
  t.after(() => monitor.stop());
  return { dataDir, provider, api, alerts, monitor };
}

test("uses the exact official pon.fun Factory event topics", () => {
  assert.deepEqual(PON_FACTORY_EVENT_TOPICS, {
    ConfigSet: "0x8d4f9022ab10978259dead0fa01463e75fda43dfe57f0445e69b010074c016fd",
    CurveParamsSet: "0x25482d70bd81eb7de3dfac5c42283fda45887a7d1fb434a68c2a13e45baf29f3",
    MarketCreated: "0x8ada27e0afa58f4d4be8c4edbf4bfd49d9d586ce8a714938b12f51b7855893bb",
    StockListed: "0x7740fd3f56c396ca150bbd7ec72ee92798920ea8eb3f25f9a03582dc9bb564b1",
    OwnershipTransferStarted: "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700",
    OwnershipTransferred: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
    Paused: "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
    Unpaused: "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa",
  });
});

test("first successful API and on-chain closure establishes a silent baseline without archive code", async (t) => {
  const { dataDir, provider, api, alerts, monitor } = await harness(t);
  const result = await monitor.check();
  assert.equal(result.status, "baseline");
  assert.equal(alerts.length, 0);
  assert.equal(provider.archiveCodeRequested, false, "baseline must work with a non-archive public RPC");
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "pon-state.json"), "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.initialized, true);
  assert.equal(persisted.cursor.nextBlock, provider.head + 1);
  assert.equal(Object.keys(persisted.markets).length, 1);
  assert.equal(persisted.identity.deploymentVerified, true);
  assert.equal(persisted._health.identity.observedChainId, PON_CHAIN_ID);
  assert.equal(persisted._health.identity.observedFactoryCodeHash, keccak256(FACTORY_CODE));
  assert.equal(api.requests.length, 4);
  assert.equal(api.requests.every((request) => request.redirect === "error"), true);
  assert.equal((await fs.stat(path.join(dataDir, "pon-state.json"))).mode & 0o777, 0o600);
});

test("baseline remains silent when the finalized Factory includes an API-filtered historical market", async (t) => {
  const provider = new FakePonProvider([clone(MARKET_A), clone(MARKET_B)]);
  const api = {
    markets: [clone(MARKET_A)], healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set(),
  };
  const fixture = await harness(t, { provider, api });
  const result = await fixture.monitor.check();
  assert.equal(result.status, "baseline");
  assert.equal(fixture.monitor.state().cursor.marketCountAtCursor, 2);
  assert.equal(Object.keys(fixture.monitor.state().markets).length, 1);
  assert.equal(fixture.alerts.length, 0);
});

test("restart resumes the durable finalized cursor instead of replaying the baseline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-restart-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
  const first = await harness(t, { dataDir, provider, api });
  await first.monitor.check();
  await first.monitor.stop();
  provider.head += 2;
  const secondAlerts = [];
  const second = await harness(t, { dataDir, provider, api, alerts: secondAlerts });
  const result = await second.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(secondAlerts.length, 0);
  assert.equal(second.monitor.state().cursor.nextBlock, provider.head + 1);
});

test("cold start records a legitimately transferred current owner while deployment origin stays pinned", async (t) => {
  const provider = new FakePonProvider();
  provider.owner = "0x7777777777777777777777777777777777777777";
  const fixture = await harness(t, { provider });
  const result = await fixture.monitor.check();
  assert.equal(result.status, "baseline");
  assert.equal(fixture.alerts.length, 0);
  assert.equal(fixture.monitor.state().infrastructure.owner.toLowerCase(), provider.owner.toLowerCase());
  assert.equal(fixture.monitor.state().identity.deploymentVerified, true);
});

test("API disconnect records degradation without advancing the chain cursor or sending alerts", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.head += 5;
  fixture.api.fail.add(PON_MARKETS_URL);
  const failed = await fixture.monitor.check();
  assert.equal(failed.status, "degraded");
  assert.equal(failed.errorCode, "PON_HTTP_FAILED");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(fixture.monitor.state()._health.sources.api_markets.status, "backoff");
  assert.equal(fixture.alerts.length, 0);
  fixture.api.fail.delete(PON_MARKETS_URL);
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
});

test("historical Factory failures retain their streak and publish the effective global retry deadline", async (t) => {
  let current = Date.parse("2026-09-17T07:00:00.000Z");
  const provider = new FakePonProvider();
  const originalCall = provider.call.bind(provider);
  let historicalUnavailable = true;
  let historicalFailures = 0;
  provider.call = async (request) => {
    const factoryCall = String(request.to).toLowerCase() === PON_FACTORY.toLowerCase()
      ? PON_FACTORY_INTERFACE.parseTransaction({ data: request.data }) : null;
    if (historicalUnavailable && factoryCall?.name === "marketCount" && Number(request.blockTag) < provider.head) {
      historicalFailures += 1;
      current += 8_000;
      throw new Error("independent RPC hosts unavailable");
    }
    return originalCall(request);
  };
  const configuration = { ponBackoffBaseMs: 5_000, ponBackoffMaxMs: 300_000 };
  const fixture = await harness(t, { provider, now: () => current, config: configuration });
  let firstFailureAt;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await fixture.monitor.check({ force: false });
    assert.equal(result.errorCode, "PON_FACTORY_CALL_FAILED");
    assert.equal(result.initialized, false);
    const health = fixture.monitor.state()._health;
    firstFailureAt ||= health.sources.chain.failureSince;
    assert.equal(health.sources.chain.consecutiveFailures, attempt);
    assert.equal(health.sources.chain.failureSince, firstFailureAt);
    assert.equal(health.sources.chain.lastSuccessAt, null, "partial identity success is not a complete chain recovery");
    assert.equal(health.consecutiveFailures, attempt);
    const retryAt = current + 5_000 * 2 ** (attempt - 1);
    assert.equal(Date.parse(health.nextAttemptAt), retryAt);
    for (const source of Object.values(health.sources)) {
      assert.ok(Date.parse(source.nextAttemptAt) >= retryAt, "no source can run before the global cooldown");
    }
    const requestsBeforeCooldown = fixture.api.requests.length;
    const failedCallsBeforeCooldown = historicalFailures;
    current = retryAt - 1;
    assert.equal((await fixture.monitor.check({ force: false })).status, "backoff");
    assert.equal(fixture.api.requests.length, requestsBeforeCooldown);
    assert.equal(historicalFailures, failedCallsBeforeCooldown);
    current = retryAt;
  }
  assert.equal(fixture.alerts.length, 0);
  await fixture.monitor.stop();
  current -= 1;
  const requestsBeforeRestart = fixture.api.requests.length;
  const restarted = await harness(t, {
    provider, api: fixture.api, dataDir: fixture.dataDir, now: () => current, config: configuration,
  });
  assert.equal((await restarted.monitor.check({ force: false })).status, "backoff");
  assert.equal(fixture.api.requests.length, requestsBeforeRestart, "initialization must honor durable cooldown before fetching");
  assert.equal(restarted.monitor.state()._health.sources.chain.consecutiveFailures, 3);
  current += 1;
  historicalUnavailable = false;
  assert.equal((await restarted.monitor.check({ force: false })).status, "baseline");
  const recovered = restarted.monitor.state()._health;
  assert.equal(recovered.sources.chain.consecutiveFailures, 0);
  assert.equal(recovered.sources.chain.lastSuccessAt, new Date(current).toISOString());
  assert.equal(recovered.consecutiveFailures, 0);
});

test("a parsed API response cannot clear repeated semantic identity failures", async (t) => {
  let current = Date.parse("2026-09-17T07:00:00.000Z");
  const fixture = await harness(t, { now: () => current });
  await fixture.monitor.check();
  const healthy = fixture.monitor.state();
  fixture.api.healthBlock = fixture.provider.head + 129;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    current += 1_000;
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "PON_HEALTH_BLOCK_AHEAD");
    const source = fixture.monitor.state()._health.sources.api_health;
    assert.equal(source.consecutiveFailures, attempt);
    assert.equal(source.lastSuccessAt, healthy._health.sources.api_health.lastSuccessAt);
    assert.equal(source.lastErrorCode, "PON_HEALTH_BLOCK_AHEAD");
    assert.equal(fixture.monitor.state().cursor.nextBlock, healthy.cursor.nextBlock);
  }
  assert.equal(fixture.alerts.length, 0);
});

test("production autoStart preserves persisted cooldown without performing a startup network attempt", async (t) => {
  let current = Date.parse("2026-09-17T07:00:00.000Z");
  const fixture = await harness(t, { now: () => current });
  await fixture.monitor.check();
  fixture.api.fail.add(PON_MARKETS_URL);
  current += 1_000;
  assert.equal((await fixture.monitor.check()).errorCode, "PON_HTTP_FAILED");
  const failed = fixture.monitor.state();
  await fixture.monitor.stop();
  const requestsBeforeRestart = fixture.api.requests.length;
  current = Date.parse(failed._health.nextAttemptAt) - 1;
  const restarted = await harness(t, {
    provider: fixture.provider, api: fixture.api, dataDir: fixture.dataDir,
    now: () => current, autoStart: true,
  });
  assert.equal((await restarted.monitor.check({ force: false })).status, "backoff");
  assert.equal(fixture.api.requests.length, requestsBeforeRestart);
  assert.equal(restarted.monitor.state()._health.consecutiveFailures, failed._health.consecutiveFailures);
  assert.deepEqual(restarted.monitor.state().cursor, failed.cursor);
});

test("official API request timeout is degraded transport health, not a stopped monitor", async (t) => {
  const fixture = await harness(t, {
    config: { ponRequestTimeoutMs: 10 },
    fetchImpl: async () => new Promise(() => {}),
  });

  const result = await fixture.monitor.check();

  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "PON_HTTP_TIMEOUT");
  assert.equal(result.initialized, false);
  assert.match(result.error, /timed out after 250ms/);
  assert.notEqual(result.errorCode, "PON_STOPPED");
  assert.equal(fixture.monitor.state()._health.sources.api_health.status, "backoff");
});

test("official API body timeout remains abortable and is not reported as monitor shutdown", async (t) => {
  const fixture = await harness(t, {
    config: { ponRequestTimeoutMs: 10 },
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url,
      text: async () => new Promise(() => {}),
    }),
  });

  const result = await fixture.monitor.check();

  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "PON_HTTP_TIMEOUT");
  assert.notEqual(result.errorCode, "PON_STOPPED");
});

test("fake response source, wrong RPC chain, wrong API Factory and runtime mismatch all fail closed", async (t) => {
  const cases = [
    {
      name: "fake response source",
      mutate({ api }) { api.responseUrls[PON_HEALTH_URL] = "https://evil.example/api/health"; },
      code: "PON_RESPONSE_SOURCE_MISMATCH",
    },
    {
      name: "wrong RPC chain",
      mutate({ provider }) { provider.chainId = 1; },
      code: "PON_RPC_CHAIN_MISMATCH",
    },
    {
      name: "raw RPC chain overrides a static configured network",
      mutate({ provider }) {
        provider.getNetwork = async () => ({ chainId: BigInt(PON_CHAIN_ID) });
        provider.send = async () => "0x1";
      },
      code: "PON_RPC_CHAIN_MISMATCH",
    },
    {
      name: "wrong API Factory",
      mutate({ api }) { api.healthFactory = "0x9999999999999999999999999999999999999999"; },
      code: "PON_FACTORY_ROOT_MISMATCH",
    },
    {
      name: "wrong runtime fingerprint",
      mutate({ provider }) { provider.factoryCode = "0x6002600055"; },
      code: "PON_FACTORY_CODE_MISMATCH",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = await harness(subtest);
      scenario.mutate(fixture);
      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, scenario.code);
      assert.equal(result.initialized, false);
      assert.equal(fixture.monitor.state().cursor.nextBlock, null);
      assert.equal(fixture.alerts.length, 0);
    });
  }
});

test("a cross-verified MarketCreated is emitted once and remains deduplicated after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-market-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
  const alerts = [];
  const first = await harness(t, { dataDir, provider, api, alerts });
  await first.monitor.check();
  provider.markets.push(clone(MARKET_B));
  api.markets.push(clone(MARKET_B));
  provider.addEvent("MarketCreated", [
    MARKET_B.ticker,
    MARKET_B.symbol,
    MARKET_B.name,
    MARKET_B.coin,
    MARKET_B.vault,
    MARKET_B.curve,
    MARKET_B.creator,
    MARKET_B.creatorFeeBps,
  ]);
  const result = await first.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "pon_fun_update");
  assert.equal(alerts[0].kind, "market_created");
  assert.equal(alerts[0].platform.id, "ponfun");
  assert.equal(alerts[0].source.id, PON_SOURCE_ID);
  assert.equal(alerts[0].source.trust, PON_SOURCE_TRUST);
  assert.equal(alerts[0].token.toLowerCase(), MARKET_B.coin.toLowerCase());
  assert.equal(alerts[0].evidence.receiptVerified, true);
  assert.match(alerts[0].source.url, /^https:\/\/robinhoodchain\.blockscout\.com\/tx\//);
  assert.equal(isOfficialPonFunUpdate(alerts[0]), true, "the producer must satisfy the shared fail-closed source gate");
  await first.monitor.check();
  assert.equal(alerts.length, 1);
  await first.monitor.stop();
  const second = await harness(t, { dataDir, provider, api, alerts });
  await second.monitor.check();
  assert.equal(alerts.length, 1);
});

test("API lag or API-chain mismatch is durable pending, advances the scanned cursor, and never alerts until matched", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  fixture.provider.markets.push(clone(MARKET_B));
  const log = fixture.provider.addEvent("MarketCreated", [
    MARKET_B.ticker,
    MARKET_B.symbol,
    MARKET_B.name,
    MARKET_B.coin,
    MARKET_B.vault,
    MARKET_B.curve,
    MARKET_B.creator,
    MARKET_B.creatorFeeBps,
  ]);
  const lagged = await fixture.monitor.check();
  assert.equal(lagged.status, "healthy");
  assert.equal(fixture.alerts.length, 0);
  assert.equal(fixture.monitor.state().cursor.nextBlock, log.blockNumber + 1);
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(fixture.dataDir, "pon-state.json"), "utf8"));
  assert.equal(Object.keys(persisted.pendingMarketEvents).length, 1, "pending proof and cursor must share one durable state");

  fixture.api.markets.push({ ...clone(MARKET_B), vault: "0xcccccccccccccccccccccccccccccccccccccccc" });
  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 0);
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 1);

  fixture.api.markets[fixture.api.markets.length - 1] = clone(MARKET_B);
  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "market_created");
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 0);
});

test("a foreign-factory log is rejected without consuming its block", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.returnForeignLogs = true;
  fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER], fixture.provider.head + 1, {
    address: "0x9999999999999999999999999999999999999999",
  });
  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "PON_LOG_BOUNDARY_INVALID");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(fixture.alerts.length, 0);
});

test("non-terminal delivery failures retain the event and do not advance its scan block", async (t) => {
  let attempts = 0;
  const alerts = [];
  const fixture = await harness(t, {
    alerts,
    sendAlertsImpl: async (_config, event) => {
      attempts += 1;
      alerts.push(event);
      return attempts === 1 ? { status: "failed" } : { status: "queued", eventId: event.eventKey };
    },
  });
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.paused = true;
  fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER], fixture.provider.head + 1);
  const failed = await fixture.monitor.check();
  assert.equal(failed.errorCode, "PON_ALERT_NOT_DURABLE");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  const retried = await fixture.monitor.check();
  assert.equal(retried.status, "healthy");
  assert.equal(attempts, 2);
  assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
});

test("Factory config, curve, stock, pause and ownership controls emit exact structural updates", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const start = fixture.provider.head;
  const nextOracle = "0x3333333333333333333333333333333333333333";
  const nextRouter = "0x4444444444444444444444444444444444444444";
  const nextPositionManager = "0x5555555555555555555555555555555555555555";
  const nextTreasury = "0x6666666666666666666666666666666666666666";
  const nextOwner = "0x7777777777777777777777777777777777777777";
  const listedStock = "0x8888888888888888888888888888888888888888";
  fixture.provider.oracle = nextOracle;
  fixture.provider.swapRouter = nextRouter;
  fixture.provider.positionManager = nextPositionManager;
  fixture.provider.protocolTreasury = nextTreasury;
  fixture.provider.paused = true;
  fixture.provider.owner = nextOwner;
  fixture.provider.pendingOwner = ZERO_ADDRESS;
  fixture.provider.curveParams = {
    ...fixture.provider.curveParams,
    lpPoolFee: 3_000,
    maxSlippageBps: 250,
  };
  fixture.provider.listings.set("BETA", { stockToken: listedStock, poolFee: 10_000, active: true, ticker: "BETA" });
  fixture.provider.addEvent("ConfigSet", [nextOracle, nextRouter, nextPositionManager, nextTreasury], start + 1);
  fixture.provider.addEvent("CurveParamsSet", [[
    fixture.provider.curveParams.p0,
    fixture.provider.curveParams.slope,
    fixture.provider.curveParams.curveCap,
    fixture.provider.curveParams.lpPoolFee,
    fixture.provider.curveParams.maxSlippageBps,
    fixture.provider.curveParams.autoAcquire,
  ]], start + 2);
  fixture.provider.addEvent("StockListed", ["BETA", listedStock, 10_000, true], start + 3);
  fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER], start + 4);
  fixture.provider.addEvent("OwnershipTransferStarted", [PON_INITIAL_OWNER, nextOwner], start + 5);
  fixture.provider.addEvent("OwnershipTransferred", [PON_INITIAL_OWNER, nextOwner], start + 6);
  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.deepEqual(fixture.alerts.map((event) => event.kind), [
    "factory_config",
    "curve_params",
    "stock_listing",
    "factory_paused",
    "ownership_transfer_started",
    "ownership_transferred",
  ]);
  assert.equal(fixture.alerts.every((event) => event.evidence.receiptVerified === true), true);
  assert.equal(fixture.alerts.every((event) => isOfficialPonFunUpdate(event)), true);
  assert.equal(fixture.monitor.state().infrastructure.oracle.toLowerCase(), nextOracle.toLowerCase());
  assert.equal(fixture.monitor.state().infrastructure.owner.toLowerCase(), nextOwner.toLowerCase());
  assert.equal(fixture.monitor.state().curveParams.maxSlippageBps, 250);
  assert.equal(fixture.monitor.state().listings.BETA.active, true);
});

test("official API market lifecycle emits only a verified graduated or LP transition", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  fixture.api.markets[0] = { ...fixture.api.markets[0], graduated: true, lpDeployed: true };
  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "market_lifecycle");
  assert.deepEqual(fixture.alerts[0].changes, {
    graduated: { before: false, after: true },
    lpDeployed: { before: false, after: true },
  });
  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 1);
});

test("platform-token supply changes alert only after exact finalized ERC-20 re-verification", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  fixture.api.platformToken.supply = 900_000_000;
  fixture.provider.platformTokenTotalSupply = 900_000_000n * (10n ** 18n);
  const changed = await fixture.monitor.check();
  assert.equal(changed.status, "healthy");
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "platform_token_update");
  assert.equal(fixture.alerts[0].evidence.platformToken.totalSupplyRaw, fixture.provider.platformTokenTotalSupply.toString());
  assert.equal(fixture.alerts[0].evidence.platformToken.verifiedBlock, fixture.provider.head);
  assert.equal(isOfficialPonFunUpdate(fixture.alerts[0]), true);
  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 1);
});

test("API plus Factory getter changes to stockToken and poolFee emit one lifecycle update without a log", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const nextStockToken = "0xdddddddddddddddddddddddddddddddddddddddd";
  const nextPoolFee = 10_000;
  fixture.provider.markets[0] = {
    ...fixture.provider.markets[0],
    stockToken: nextStockToken,
    poolFee: nextPoolFee,
  };
  fixture.provider.listings.set(MARKET_A.ticker, {
    stockToken: nextStockToken,
    poolFee: nextPoolFee,
    active: true,
    ticker: MARKET_A.ticker,
  });
  fixture.api.markets[0] = clone(fixture.provider.markets[0]);

  const changed = await fixture.monitor.check();
  assert.equal(changed.status, "healthy");
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "market_lifecycle");
  assert.equal(fixture.alerts[0].changes.stockToken.before.toLowerCase(), MARKET_A.stockToken.toLowerCase());
  assert.equal(fixture.alerts[0].changes.stockToken.after.toLowerCase(), nextStockToken.toLowerCase());
  assert.deepEqual(fixture.alerts[0].changes.poolFee, { before: MARKET_A.poolFee, after: nextPoolFee });
  assert.equal(isOfficialPonFunUpdate(fixture.alerts[0]), true);

  await fixture.monitor.check();
  assert.equal(fixture.alerts.length, 1);
});

test("slow markets API holds Factory control delivery and the cursor in one anchored cycle", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.paused = true;
  fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER], fixture.provider.head + 1);
  let releaseMarkets;
  fixture.api.marketGate = new Promise((resolve) => { releaseMarkets = resolve; });
  let settled = false;
  const checking = fixture.monitor.check().then((result) => {
    settled = true;
    return result;
  });
  for (let attempt = 0; attempt < 50 && fixture.alerts.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.alerts.length, 0);
  assert.equal(settled, false, "the API phase should still be waiting");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before, "cursor commits only after the API phase succeeds");
  releaseMarkets();
  const result = await checking;
  fixture.api.marketGate = null;
  assert.equal(result.status, "healthy");
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "factory_paused");
  assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
});

test("a finalized hash mismatch performs one bounded durable rewind and catches up", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const oldLast = fixture.monitor.state().cursor.lastScannedBlock;
  fixture.provider.blockHashes.set(oldLast, id("replacement-finalized-block"));
  fixture.provider.head += 1;
  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(result.caughtUp, true);
  assert.equal(fixture.monitor.state()._health.reorg.count, 1);
  assert.equal(fixture.monitor.state()._health.reorg.rewindFrom, oldLast);
  assert.ok(fixture.monitor.state()._health.reorg.rewindTo >= oldLast - 127);
  assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
  assert.equal(fixture.alerts.length, 0);
});

test("reorg recovery keeps count anchors and rejects a silent replacement-log omission", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const oldLast = fixture.monitor.state().cursor.lastScannedBlock;
  fixture.provider.blockHashes.set(oldLast, id("replacement-with-new-market"));
  fixture.provider.markets.push(clone(MARKET_B));
  fixture.api.markets.push(clone(MARKET_B));
  fixture.provider.addEvent("MarketCreated", [
    MARKET_B.ticker, MARKET_B.symbol, MARKET_B.name, MARKET_B.coin, MARKET_B.vault,
    MARKET_B.curve, MARKET_B.creator, MARKET_B.creatorFeeBps,
  ], oldLast + 1);
  const getLogs = fixture.provider.getLogs.bind(fixture.provider);
  let omit = true;
  fixture.provider.getLogs = async (filter) => omit ? [] : getLogs(filter);

  const missing = await fixture.monitor.check();
  assert.equal(missing.errorCode, "PON_MARKET_EVENT_COVERAGE_GAP");
  assert.ok(fixture.monitor.state().cursor.nextBlock <= oldLast + 1);
  assert.equal(fixture.monitor.state().cursor.marketCountAtCursor, 1);
  assert.equal(fixture.alerts.length, 0);

  omit = false;
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "market_created");
});

test("a baseline-origin market orphaned by reorg self-heals after API and Factory absence across restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-reorg-orphan-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  provider.historicalMarketCountOverride = 0;
  provider.historicalListingCountOverride = 0;
  const api = {
    markets: provider.markets.map(clone),
    healthFactory: PON_FACTORY,
    responseUrls: {},
    fail: new Set(),
  };
  const alerts = [];
  const first = await harness(t, { dataDir, provider, api, alerts });
  await first.monitor.check();
  const oldLast = first.monitor.state().cursor.lastScannedBlock;

  provider.blockHashes.set(oldLast, id("replacement-removes-baseline-market"));
  provider.head += 1;
  provider.markets = [];
  provider.listings.delete(MARKET_A.ticker);
  provider.historicalMarketCountOverride = 0;
  provider.historicalListingCountOverride = 0;
  api.markets = [];
  api.fail.add(PON_MARKETS_URL);

  const interrupted = await first.monitor.check();
  assert.equal(interrupted.errorCode, "PON_HTTP_FAILED");
  assert.equal(Object.keys(first.monitor.state().reorgBaselineMarketRechecks).length, 1);
  const durableInterrupted = JSON.parse(await fs.readFile(path.join(dataDir, "pon-state.json"), "utf8"));
  assert.equal(Object.keys(durableInterrupted.reorgBaselineMarketRechecks).length, 1);
  assert.equal(Object.keys(durableInterrupted.markets).length, 1);
  await first.monitor.stop();

  api.fail.delete(PON_MARKETS_URL);
  const second = await harness(t, { dataDir, provider, api, alerts });
  const recovered = await second.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(Object.keys(second.monitor.state().reorgBaselineMarketRechecks).length, 0);
  assert.equal(Object.keys(second.monitor.state().markets).length, 0);
  assert.equal(second.monitor.state().cursor.marketCountAtCursor, 0);
  assert.equal(second.monitor.state().cursor.listingCountAtCursor, 0);
  assert.equal(second.monitor.state().cursor.nextBlock, provider.head + 1);
  assert.equal(alerts.length, 0);
});

test("reorg recheck freezes when only the API drops a baseline market still present on-chain", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const oldLast = fixture.monitor.state().cursor.lastScannedBlock;
  fixture.provider.blockHashes.set(oldLast, id("replacement-keeps-baseline-market"));
  fixture.provider.head += 1;
  fixture.api.markets = [];

  const missing = await fixture.monitor.check();
  assert.equal(missing.errorCode, "PON_API_MARKET_DISAPPEARED");
  const frozenCursor = fixture.monitor.state().cursor.nextBlock;
  assert.ok(frozenCursor <= oldLast);
  assert.equal(Object.keys(fixture.monitor.state().reorgBaselineMarketRechecks).length, 1);
  assert.equal(Object.keys(fixture.monitor.state().markets).length, 1);
  assert.equal(fixture.alerts.length, 0);

  const stillMissing = await fixture.monitor.check();
  assert.equal(stillMissing.errorCode, "PON_API_MARKET_DISAPPEARED");
  assert.equal(fixture.monitor.state().cursor.nextBlock, frozenCursor);
  assert.equal(Object.keys(fixture.monitor.state().reorgBaselineMarketRechecks).length, 1);

  fixture.api.markets = [clone(MARKET_A)];
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(Object.keys(fixture.monitor.state().reorgBaselineMarketRechecks).length, 0);
  assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
  assert.equal(fixture.alerts.length, 0);
});

test("an API market without a post-baseline MarketCreated proof remains unmatched", async (t) => {
  const provider = new FakePonProvider([clone(MARKET_A), clone(MARKET_B)]);
  const api = {
    markets: [clone(MARKET_A)],
    healthFactory: PON_FACTORY,
    responseUrls: {},
    fail: new Set(),
  };
  const fixture = await harness(t, { provider, api });
  await fixture.monitor.check();
  assert.equal(Object.keys(fixture.monitor.state().markets).length, 1);

  api.markets.push(clone(MARKET_B));
  const checked = await fixture.monitor.check();
  assert.equal(checked.status, "healthy");
  assert.equal(Object.keys(fixture.monitor.state().markets).length, 1);
  assert.equal(Object.keys(fixture.monitor.state().unmatchedApiMarkets).length, 1);
  assert.ok(fixture.monitor.state().unmatchedApiMarkets[MARKET_B.coin.toLowerCase()]);
  assert.equal(fixture.alerts.length, 0);
});

test("pending capacity never drops a MarketCreated proof or advances past it", async (t) => {
  const fixture = await harness(t, { pendingLimit: 1 });
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.markets.push(clone(MARKET_B), clone(MARKET_C));
  fixture.provider.addEvent("MarketCreated", [
    MARKET_B.ticker, MARKET_B.symbol, MARKET_B.name, MARKET_B.coin, MARKET_B.vault,
    MARKET_B.curve, MARKET_B.creator, MARKET_B.creatorFeeBps,
  ]);
  fixture.provider.addEvent("MarketCreated", [
    MARKET_C.ticker, MARKET_C.symbol, MARKET_C.name, MARKET_C.coin, MARKET_C.vault,
    MARKET_C.curve, MARKET_C.creator, MARKET_C.creatorFeeBps,
  ]);

  const saturated = await fixture.monitor.check();
  assert.equal(saturated.errorCode, "PON_PENDING_CAPACITY_EXCEEDED");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 1);
  assert.equal(fixture.alerts.length, 0);

  fixture.api.markets.push(clone(MARKET_B), clone(MARKET_C));
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 0);
  assert.deepEqual(fixture.alerts.map((event) => event.token.toLowerCase()), [
    MARKET_B.coin.toLowerCase(),
    MARKET_C.coin.toLowerCase(),
  ]);
});

test("a silent RPC MarketCreated omission is detected before cursor commit", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.markets.push(clone(MARKET_B));
  fixture.api.markets.push(clone(MARKET_B));
  fixture.provider.addEvent("MarketCreated", [
    MARKET_B.ticker, MARKET_B.symbol, MARKET_B.name, MARKET_B.coin, MARKET_B.vault,
    MARKET_B.curve, MARKET_B.creator, MARKET_B.creatorFeeBps,
  ]);
  const getLogs = fixture.provider.getLogs.bind(fixture.provider);
  let omit = true;
  fixture.provider.getLogs = async (filter) => omit ? [] : getLogs(filter);

  const missing = await fixture.monitor.check();
  assert.equal(missing.errorCode, "PON_MARKET_EVENT_COVERAGE_GAP");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(fixture.alerts.length, 0);

  omit = false;
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "market_created");
});

test("a silent RPC StockListed omission is detected before cursor commit", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.listings.set("BETA", {
    stockToken: MARKET_B.stockToken,
    poolFee: MARKET_B.poolFee,
    active: true,
    ticker: MARKET_B.ticker,
  });

  const missing = await fixture.monitor.check();
  assert.equal(missing.errorCode, "PON_LISTING_EVENT_COVERAGE_GAP");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(fixture.alerts.length, 0);

  fixture.provider.addEvent("StockListed", [MARKET_B.ticker, MARKET_B.stockToken, MARKET_B.poolFee, true]);
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(fixture.alerts.length, 1);
  assert.equal(fixture.alerts[0].kind, "stock_listing");
});

test("disabled monitor creates no state and future state versions fail closed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-disabled-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const disabled = createPonMonitor({ dataDir, ponMonitorEnabled: false }, { autoStart: false });
  assert.equal((await disabled.check()).status, "disabled");
  await disabled.stop();
  await assert.rejects(fs.access(path.join(dataDir, "pon-state.json")), { code: "ENOENT" });

  await fs.writeFile(path.join(dataDir, "pon-state.json"), `${JSON.stringify({ version: 2 })}\n`);
  const enabled = createPonMonitor({ dataDir, ponMonitorEnabled: true }, {
    autoStart: false,
    provider: new FakePonProvider(),
    fetchImpl: async () => { throw new Error("must not fetch"); },
    expectedFactoryCodeHash: keccak256(FACTORY_CODE),
    expectedCreationInputHash: keccak256(CREATION_DATA),
    logger: { error() {} },
  });
  await assert.rejects(enabled.check(), /unsupported pon\.fun state version 2/);
  await enabled.stop();
});

test("existing scalar, malformed cursor, array field and malformed pending state all fail closed", async (t) => {
  const source = await harness(t);
  await source.monitor.check();
  const valid = JSON.parse(await fs.readFile(path.join(source.dataDir, "pon-state.json"), "utf8"));
  const corruptions = [
    7,
    { ...clone(valid), cursor: { ...clone(valid.cursor), nextBlock: "not-a-block" } },
    { ...clone(valid), markets: [] },
    { ...clone(valid), pendingMarketEvents: { broken: [] } },
    { ...clone(valid), finalizedCheckpoints: clone(valid.finalizedCheckpoints).reverse() },
    { ...clone(valid), reorgOrphanedEventKeys: Array.from({ length: 501 }, (_, index) => `orphan-${index}`) },
    { ...clone(valid), retiredMarkets: { AMC: { active: false } } },
    { ...clone(valid), platformTokenVerification: { ...clone(valid.platformTokenVerification), totalSupplyRaw: "1" } },
    { ...clone(valid), pendingApiTransitions: { "market:bad": { lane: "different" } } },
  ];

  for (const [index, corrupted] of corruptions.entries()) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `pon-monitor-corrupt-${index}-`));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dataDir, "pon-state.json"), `${JSON.stringify(corrupted)}\n`);
    const monitor = createPonMonitor({ dataDir, ponMonitorEnabled: true }, {
      autoStart: false,
      provider: new FakePonProvider(),
      fetchImpl: async () => { throw new Error("corrupt state must fail before network access"); },
      expectedFactoryCodeHash: keccak256(FACTORY_CODE),
      expectedCreationInputHash: keccak256(CREATION_DATA),
      logger: { error() {} },
    });
    await assert.rejects(monitor.check(), /invalid pon\.fun state/);
    await monitor.stop();
  }
});

test("persisted deployment identity pins cannot be changed or type-confused", async (t) => {
  const source = await harness(t);
  await source.monitor.check();
  const valid = JSON.parse(await fs.readFile(path.join(source.dataDir, "pon-state.json"), "utf8"));
  const corruptions = [
    { ...clone(valid), identity: { ...clone(valid.identity), deploymentTransaction: id("forged-deployment") } },
    { ...clone(valid), identity: { ...clone(valid.identity), deploymentBlock: PON_FACTORY_DEPLOY_BLOCK + 1 } },
    { ...clone(valid), identity: { ...clone(valid.identity), deploymentVerified: "true" } },
  ];

  for (const [index, corrupted] of corruptions.entries()) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `pon-monitor-identity-${index}-`));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dataDir, "pon-state.json"), `${JSON.stringify(corrupted)}\n`);
    const monitor = createPonMonitor({ dataDir, ponMonitorEnabled: true }, {
      autoStart: false,
      provider: new FakePonProvider(),
      fetchImpl: async () => { throw new Error("identity mismatch must fail before network access"); },
      expectedFactoryCodeHash: keccak256(FACTORY_CODE),
      expectedCreationInputHash: keccak256(CREATION_DATA),
      logger: { error() {} },
    });
    await assert.rejects(monitor.check(), /persisted pon\.fun identity does not match the pinned deployment/);
    await monitor.stop();
  }
});

test("a previously verified API market disappearing degrades coverage and holds the cursor", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.head += 2;
  fixture.api.markets = [];

  const missing = await fixture.monitor.check();
  assert.equal(missing.status, "degraded");
  assert.equal(missing.errorCode, "PON_API_MARKET_DISAPPEARED");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(Object.keys(fixture.monitor.state().markets).length, 1);
  assert.equal(fixture.monitor.state()._health.sources.api_markets.status, "backoff");
  assert.equal(fixture.alerts.length, 0);

  fixture.api.markets = [clone(MARKET_A)];
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
});

test("stop aborts a hanging dependency promptly and drains its durable state write", async (t) => {
  let releaseMarkets;
  const gate = new Promise((resolve) => { releaseMarkets = resolve; });
  const provider = new FakePonProvider();
  const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
  const normalFetch = async (url) => {
    if (url === PON_HEALTH_URL) return jsonResponse(url, {
      ok: true, deployed: true, chainId: PON_CHAIN_ID, block: provider.head,
      addresses: { factory: PON_FACTORY, oracle: provider.oracle, usdg: provider.usdg },
    });
    if (url === PON_MARKETS_URL) {
      await gate;
      return jsonResponse(url, { deployed: true, markets: api.markets });
    }
    if (url === PON_PLATFORM_TOKEN_URL) return jsonResponse(url, {
      address: PONFUN_TOKEN, symbol: "PONFUN", name: "Ponfun", supply: 1_000_000_000,
    });
    if (url === PON_TOKEN_LIST_URL) return jsonResponse(url, tokenList(api.markets));
    throw new Error(`unexpected ${url}`);
  };
  const fixture = await harness(t, { provider, api, fetchImpl: normalFetch });
  const check = fixture.monitor.check();
  const started = performance.now();
  await fixture.monitor.stop();
  assert.ok(performance.now() - started < 1_000, "stop must wake lifecycle-bound HTTP/RPC waits");
  releaseMarkets();
  const result = await check;
  assert.equal(result.status, "stopped");
  assert.equal(result.errorCode, "PON_STOPPED");
  const persisted = JSON.parse(await fs.readFile(path.join(fixture.dataDir, "pon-state.json"), "utf8"));
  assert.equal(persisted.initialized, false);
  assert.equal(persisted._health.consecutiveFailures, 0);
  assert.equal(persisted._health.lastErrorCode, null);
});

test("finalized StockListed(false) retires zero or prior-token mappings and permits later API removal", async (t) => {
  for (const [label, retiredToken] of [["zero", ZERO_ADDRESS], ["prior", MARKET_A.stockToken]]) {
    await t.test(label, async (subtest) => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `pon-monitor-retire-${label}-`));
      subtest.after(() => fs.rm(dataDir, { recursive: true, force: true }));
      const provider = new FakePonProvider();
      const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
      const alerts = [];
      const first = await harness(subtest, { dataDir, provider, api, alerts });
      await first.monitor.check();
      provider.listings.set(MARKET_A.ticker, {
        stockToken: retiredToken,
        poolFee: MARKET_A.poolFee,
        active: false,
        ticker: MARKET_A.ticker,
      });
      const retirementLog = provider.addEvent("StockListed", [MARKET_A.ticker, retiredToken, MARKET_A.poolFee, false]);
      const retained = await first.monitor.check();
      assert.equal(retained.status, "healthy");
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].kind, "stock_listing");
      assert.equal(alerts[0].currentSnapshot.active, false);
      assert.equal(first.monitor.state().retiredMarkets[MARKET_A.ticker].blockHash, retirementLog.blockHash);
      await first.monitor.stop();

      const second = await harness(subtest, { dataDir, provider, api, alerts });
      assert.equal((await second.monitor.check()).status, "healthy");
      assert.equal(alerts.length, 1, "restart must not repeat the retirement");
      api.markets = [];
      provider.head += 1;
      const removed = await second.monitor.check();
      assert.equal(removed.status, "healthy");
      assert.equal(Object.keys(second.monitor.state().markets).length, 0);
      assert.equal(second.monitor.state().cursor.nextBlock, provider.head + 1);
      assert.equal(alerts.length, 1);
    });
  }
});

test("an API/RPC head split clamps every snapshot and scan to the authenticated common block", async (t) => {
  const provider = new FakePonProvider();
  const api = {
    markets: provider.markets.map(clone),
    healthFactory: PON_FACTORY,
    responseUrls: {},
    fail: new Set(),
    healthBlock: provider.head,
  };
  const fixture = await harness(t, { provider, api });
  await fixture.monitor.check();

  provider.head += 40;
  api.healthBlock = provider.head - 33;
  const commonAnchor = api.healthBlock;
  const observedCalls = [];
  const observedCodeReads = [];
  const observedLogFilters = [];
  const originalCall = provider.call.bind(provider);
  const originalGetCode = provider.getCode.bind(provider);
  const originalGetLogs = provider.getLogs.bind(provider);
  provider.call = async (request) => {
    observedCalls.push(structuredClone(request));
    return originalCall(request);
  };
  provider.getCode = async (candidate, blockTag) => {
    observedCodeReads.push({ candidate, blockTag });
    return originalGetCode(candidate, blockTag);
  };
  provider.getLogs = async (filter) => {
    observedLogFilters.push(structuredClone(filter));
    return originalGetLogs(filter);
  };

  const result = await fixture.monitor.check();
  const coverage = fixture.monitor.state()._health.apiCoverage;
  assert.equal(result.status, "healthy");
  assert.equal(fixture.monitor.state().cursor.lastScannedBlock, commonAnchor);
  assert.equal(fixture.monitor.state().cursor.nextBlock, commonAnchor + 1);
  assert.equal(coverage.reportedBlock, commonAnchor);
  assert.equal(coverage.finalizedBlock, provider.head, "coverage must retain the unclamped RPC finality boundary");
  assert.equal(coverage.blockLag, 33, "clamping must not erase the measured API lag");
  const fixedFactoryCalls = observedCalls.filter((request) =>
    String(request.to || "").toLowerCase() === PON_FACTORY.toLowerCase()
      && request.blockTag !== undefined);
  assert.ok(fixedFactoryCalls.length >= 14);
  assert.deepEqual([...new Set(fixedFactoryCalls.map((request) => request.blockTag))], [commonAnchor]);
  assert.equal(observedCalls.filter((request) => request.blockTag === undefined).length, 2,
    "only the intentional latest oracle/USDG binding checks may omit a block tag");
  assert.equal(observedCodeReads.some(({ candidate, blockTag }) =>
    String(candidate).toLowerCase() === PON_FACTORY.toLowerCase() && blockTag === commonAnchor), true);
  assert.ok(observedLogFilters.length > 0);
  assert.equal(observedLogFilters.every((filter) => Number(filter.toBlock) <= commonAnchor), true);
  assert.equal(observedLogFilters.at(-1).toBlock, commonAnchor);
  assert.equal(fixture.alerts.length, 0);
});

test("a proven finalized reorg is still the only path that may lower the API high-water", async (t) => {
  const provider = new FakePonProvider();
  const api = {
    markets: provider.markets.map(clone),
    healthFactory: PON_FACTORY,
    responseUrls: {},
    fail: new Set(),
    healthBlock: provider.head,
  };
  const fixture = await harness(t, { provider, api });
  await fixture.monitor.check();
  const oldCursor = fixture.monitor.state().cursor.lastScannedBlock;
  provider.blockHashes.set(oldCursor, id("api-high-water-reorg"));
  api.healthBlock = oldCursor - 1;

  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(fixture.monitor.state()._health.reorg.count, 1);
  assert.equal(fixture.monitor.state()._health.reorg.commonAncestorProven, true);
  assert.equal(fixture.monitor.state()._health.apiCoverage.highWaterBlock, api.healthBlock);
  assert.equal(fixture.monitor.state().cursor.lastScannedBlock, api.healthBlock);
  assert.equal(fixture.alerts.length, 0);
});

test("an API common anchor behind a valid durable cursor freezes without rewinding it", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-api-anchor-cursor-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  const api = {
    markets: provider.markets.map(clone),
    healthFactory: PON_FACTORY,
    responseUrls: {},
    fail: new Set(),
    healthBlock: provider.head,
  };
  const alerts = [];
  const first = await harness(t, { dataDir, provider, api, alerts });
  await first.monitor.check();
  const durableCursor = first.monitor.state().cursor.lastScannedBlock;
  await first.monitor.stop();

  const stateFile = path.join(dataDir, "pon-state.json");
  const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  persisted._health.apiCoverage.reportedBlock = durableCursor - 10;
  persisted._health.apiCoverage.finalizedBlock = durableCursor;
  persisted._health.apiCoverage.blockLag = 10;
  persisted._health.apiCoverage.highWaterBlock = durableCursor - 10;
  await fs.writeFile(stateFile, JSON.stringify(persisted), { mode: 0o600 });

  provider.head = durableCursor + 20;
  api.healthBlock = durableCursor - 5;
  let logReads = 0;
  const originalGetLogs = provider.getLogs.bind(provider);
  provider.getLogs = async (...args) => {
    logReads += 1;
    return originalGetLogs(...args);
  };
  const second = await harness(t, { dataDir, provider, api, alerts });
  const frozen = await second.monitor.check();
  const state = second.monitor.state();
  assert.equal(frozen.errorCode, "PON_API_ANCHOR_BEHIND_CURSOR");
  assert.equal(state.cursor.lastScannedBlock, durableCursor);
  assert.equal(state.cursor.nextBlock, durableCursor + 1);
  assert.equal(state._health.apiCoverage.highWaterBlock, api.healthBlock);
  assert.equal(state._health.apiCoverage.finalizedBlock, provider.head);
  assert.equal(state._health.apiCoverage.blockLag, 25);
  assert.equal(logReads, 0);
  assert.equal(alerts.length, 0);
});

test("API block freshness is bounded, monotonic across restart, and recovers without moving a stale cursor", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-api-freshness-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  const api = {
    markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set(), healthBlock: provider.head,
  };
  const first = await harness(t, { dataDir, provider, api, config: { ponApiMaxBlockLag: 8 } });
  await first.monitor.check();
  const before = first.monitor.state().cursor.nextBlock;
  provider.head += 20;
  const stale = await first.monitor.check();
  assert.equal(stale.errorCode, "PON_API_BLOCK_STALE");
  assert.equal(first.monitor.state().cursor.nextBlock, before);
  assert.equal(first.monitor.state()._health.apiCoverage.blockLag, 20);
  assert.equal(first.monitor.state()._health.apiCoverage.finalizedBlock, provider.head,
    "stale detection must use the raw RPC finality boundary rather than the common anchor");
  api.healthBlock = provider.head;
  assert.equal((await first.monitor.check()).status, "healthy");
  await first.monitor.stop();

  api.healthBlock = provider.head - 1;
  const second = await harness(t, { dataDir, provider, api, config: { ponApiMaxBlockLag: 8 } });
  const regressed = await second.monitor.check();
  assert.equal(regressed.errorCode, "PON_API_BLOCK_REGRESSION");
  assert.equal(second.monitor.state().cursor.nextBlock, provider.head + 1);
  assert.equal(second.monitor.state()._health.apiCoverage.highWaterBlock, provider.head);
  api.healthBlock = provider.head;
  assert.equal((await second.monitor.check()).status, "healthy");
});

test("a newer but still-stale API health high-water survives restart and later recovery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-api-stale-restart-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  const api = {
    markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set(), healthBlock: provider.head,
  };
  const first = await harness(t, { dataDir, provider, api, config: { ponApiMaxBlockLag: 8 } });
  await first.monitor.check();
  const before = first.monitor.state().cursor.nextBlock;
  provider.head += 30;
  api.healthBlock = provider.head - 12;

  const stale = await first.monitor.check();
  assert.equal(stale.errorCode, "PON_API_BLOCK_STALE");
  assert.equal(first.monitor.state()._health.apiCoverage.highWaterBlock, api.healthBlock);
  assert.equal(first.monitor.state().cursor.nextBlock, before);
  await first.monitor.stop();

  const second = await harness(t, { dataDir, provider, api, config: { ponApiMaxBlockLag: 8 } });
  const staleAfterRestart = await second.monitor.check();
  assert.equal(staleAfterRestart.errorCode, "PON_API_BLOCK_STALE");
  assert.equal(staleAfterRestart.initialized, true);
  assert.equal(second.monitor.state().cursor.nextBlock, before);
  api.healthBlock = provider.head;
  assert.equal((await second.monitor.check()).status, "healthy");
  assert.equal(second.monitor.state().cursor.nextBlock, provider.head + 1);
});

test("PONFUN API metadata requires exact finalized ERC-20 code, name, symbol and supply closure", async (t) => {
  const cases = [
    ["code", (fixture) => { fixture.provider.platformTokenCode = "0x"; }, "PON_PLATFORM_TOKEN_CODE_EMPTY"],
    ["name", (fixture) => { fixture.provider.platformTokenName = "Not Ponfun"; }, "PON_PLATFORM_TOKEN_NAME_MISMATCH"],
    ["symbol", (fixture) => { fixture.provider.platformTokenSymbol = "NOPE"; }, "PON_PLATFORM_TOKEN_SYMBOL_MISMATCH"],
    ["supply", (fixture) => { fixture.provider.platformTokenTotalSupply -= 1n; }, "PON_PLATFORM_TOKEN_SUPPLY_MISMATCH"],
  ];
  for (const [label, mutate, expectedCode] of cases) {
    await t.test(label, async (subtest) => {
      const fixture = await harness(subtest);
      mutate(fixture);
      const failed = await fixture.monitor.check();
      assert.equal(failed.errorCode, expectedCode);
      assert.equal(failed.initialized, false);
      fixture.provider.platformTokenCode = CONTRACT_CODE;
      fixture.provider.platformTokenName = "Ponfun";
      fixture.provider.platformTokenSymbol = "PONFUN";
      fixture.provider.platformTokenTotalSupply = 1_000_000_000n * (10n ** 18n);
      const recovered = await fixture.monitor.check();
      assert.equal(recovered.status, "baseline");
      assert.equal(recovered.initialized, true);
      assert.equal(fixture.monitor.state().platformTokenVerification.totalSupplyRaw, fixture.provider.platformTokenTotalSupply.toString());
    });
  }
});

test("dangerous ticker keys fail closed at baseline, after baseline, and on restart", async (t) => {
  const poisoned = { ...clone(MARKET_A), ticker: "__proto__" };
  const baselineProvider = new FakePonProvider([poisoned]);
  baselineProvider.listings = new Map([[poisoned.ticker, {
    stockToken: poisoned.stockToken, poolFee: poisoned.poolFee, active: true, ticker: poisoned.ticker,
  }]]);
  const baseline = await harness(t, { provider: baselineProvider });
  assert.equal((await baseline.monitor.check()).errorCode, "PON_UNSAFE_RECORD_KEY");

  const live = await harness(t);
  await live.monitor.check();
  const before = live.monitor.state().cursor.nextBlock;
  live.api.markets.push({ ...clone(MARKET_B), ticker: "constructor" });
  assert.equal((await live.monitor.check()).errorCode, "PON_UNSAFE_RECORD_KEY");
  assert.equal(live.monitor.state().cursor.nextBlock, before);

  const valid = JSON.parse(await fs.readFile(path.join(live.dataDir, "pon-state.json"), "utf8"));
  valid.listings.constructor = { active: true };
  await fs.writeFile(path.join(live.dataDir, "pon-state.json"), `${JSON.stringify(valid)}\n`);
  const restarted = createPonMonitor({ dataDir: live.dataDir, ponMonitorEnabled: true }, {
    autoStart: false,
    provider: new FakePonProvider(),
    fetchImpl: async () => { throw new Error("must fail before network"); },
    expectedFactoryCodeHash: keccak256(FACTORY_CODE),
    expectedCreationInputHash: keccak256(CREATION_DATA),
    logger: { error() {} },
  });
  await assert.rejects(restarted.check(), /safe record key|invalid pon\.fun state/);
  await restarted.stop();
});

test("delivered MarketCreated and ConfigSet alerts are orphaned on finalized reorg and canonical replacements alert again", async (t) => {
  await t.test("MarketCreated", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    fixture.provider.markets.push(clone(MARKET_B));
    fixture.api.markets.push(clone(MARKET_B));
    const oldLog = fixture.provider.addEvent("MarketCreated", [
      MARKET_B.ticker, MARKET_B.symbol, MARKET_B.name, MARKET_B.coin, MARKET_B.vault,
      MARKET_B.curve, MARKET_B.creator, MARKET_B.creatorFeeBps,
    ]);
    await fixture.monitor.check();
    const oldEventKey = fixture.alerts[0].eventKey;
    const replacementHash = id("canonical-market-replacement-block");
    fixture.provider.blockHashes.set(oldLog.blockNumber, replacementHash);
    fixture.provider.logs = fixture.provider.logs.filter((log) => log !== oldLog);
    fixture.provider.receipts.delete(oldLog.transactionHash.toLowerCase());
    fixture.provider.addEvent("MarketCreated", [
      MARKET_B.ticker, MARKET_B.symbol, MARKET_B.name, MARKET_B.coin, MARKET_B.vault,
      MARKET_B.curve, MARKET_B.creator, MARKET_B.creatorFeeBps,
    ], oldLog.blockNumber, { transactionHash: id("canonical-market-replacement-tx") });

    const recovered = await fixture.monitor.check();
    assert.equal(recovered.status, "healthy");
    assert.equal(fixture.alerts.length, 2);
    assert.notEqual(fixture.alerts[1].eventKey, oldEventKey);
    assert.ok(fixture.alerts[1].reorgOrphanedEventKeys.includes(oldEventKey));
    assert.ok(fixture.monitor.state().reorgOrphanedEventKeys.includes(oldEventKey));
  });

  await t.test("ConfigSet", async (subtest) => {
    const fixture = await harness(subtest);
    await fixture.monitor.check();
    const nextOracle = "0x3333333333333333333333333333333333333333";
    fixture.provider.oracle = nextOracle;
    const oldLog = fixture.provider.addEvent("ConfigSet", [
      nextOracle, fixture.provider.swapRouter, fixture.provider.positionManager, fixture.provider.protocolTreasury,
    ]);
    await fixture.monitor.check();
    const oldEventKey = fixture.alerts[0].eventKey;
    fixture.provider.blockHashes.set(oldLog.blockNumber, id("canonical-config-replacement-block"));
    fixture.provider.logs = fixture.provider.logs.filter((log) => log !== oldLog);
    fixture.provider.receipts.delete(oldLog.transactionHash.toLowerCase());
    fixture.provider.addEvent("ConfigSet", [
      nextOracle, fixture.provider.swapRouter, fixture.provider.positionManager, fixture.provider.protocolTreasury,
    ], oldLog.blockNumber, { transactionHash: id("canonical-config-replacement-tx") });

    assert.equal((await fixture.monitor.check()).status, "healthy");
    assert.equal(fixture.alerts.length, 2);
    assert.ok(fixture.alerts[1].reorgOrphanedEventKeys.includes(oldEventKey));
    assert.equal(fixture.monitor.state().infrastructure.oracle.toLowerCase(), nextOracle.toLowerCase());
  });
});

test("orphan facts survive restart when a finalized control event has no replacement", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-orphan-restart-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
  const alerts = [];
  const first = await harness(t, { dataDir, provider, api, alerts });
  await first.monitor.check();
  provider.paused = true;
  const oldLog = provider.addEvent("Paused", [PON_INITIAL_OWNER]);
  await first.monitor.check();
  const oldEventKey = alerts[0].eventKey;
  provider.paused = false;
  provider.blockHashes.set(oldLog.blockNumber, id("orphan-control-no-replacement"));
  provider.logs = [];
  provider.receipts.delete(oldLog.transactionHash.toLowerCase());
  assert.equal((await first.monitor.check()).status, "healthy");
  assert.ok(first.monitor.state().reorgOrphanedEventKeys.includes(oldEventKey));
  assert.equal(first.monitor.state()._health.reorg.lastOrphanReason, "finalized_reorg");
  await first.monitor.stop();

  const second = await harness(t, { dataDir, provider, api, alerts });
  assert.equal((await second.monitor.check()).status, "healthy");
  assert.ok(second.monitor.state().reorgOrphanedEventKeys.includes(oldEventKey));
  assert.equal(alerts.length, 1, "an orphan fact is not a fabricated revocation signal");
});

test("a finalized hash mismatch without a persisted common ancestor freezes across restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-deep-reorg-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  provider.head += 300;
  const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
  const first = await harness(t, { dataDir, provider, api });
  await first.monitor.check();
  const frozenCursor = clone(first.monitor.state().cursor);
  for (const checkpoint of first.monitor.state().finalizedCheckpoints) {
    provider.blockHashes.set(checkpoint.blockNumber, id(`deep-reorg:${checkpoint.blockNumber}`));
  }
  const failed = await first.monitor.check();
  assert.equal(failed.errorCode, "PON_REORG_COMMON_ANCESTOR_UNPROVEN");
  assert.deepEqual(first.monitor.state().cursor, frozenCursor);
  assert.equal(first.monitor.state()._health.reorg.commonAncestorProven, false);
  assert.equal(first.monitor.state()._health.reorg.commonAncestorBlock, null);
  await first.monitor.stop();

  const second = await harness(t, { dataDir, provider, api });
  const repeated = await second.monitor.check();
  assert.equal(repeated.errorCode, "PON_REORG_COMMON_ANCESTOR_UNPROVEN");
  assert.deepEqual(second.monitor.state().cursor, frozenCursor);
});

test("mid-cycle reorg after delivery rolls state back and lets the canonical replacement bypass dedup", async (t) => {
  const alerts = [];
  let changed = false;
  let provider;
  const fixture = await harness(t, {
    alerts,
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      if (!changed) {
        changed = true;
        provider.blockHashes.set(event.blockNumber, id("mid-cycle-replacement-block"));
      }
      return { status: "delivered", eventId: event.eventKey };
    },
  });
  provider = fixture.provider;
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  provider.markets.push(clone(MARKET_B));
  fixture.api.markets.push(clone(MARKET_B));
  const oldLog = provider.addEvent("MarketCreated", [
    MARKET_B.ticker, MARKET_B.symbol, MARKET_B.name, MARKET_B.coin, MARKET_B.vault,
    MARKET_B.curve, MARKET_B.creator, MARKET_B.creatorFeeBps,
  ]);
  const unstable = await fixture.monitor.check();
  assert.equal(unstable.errorCode, "PON_SCAN_ANCHOR_CHANGED");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(Object.keys(fixture.monitor.state().markets).length, 1);
  const orphanedKey = alerts[0].eventKey;
  assert.ok(fixture.monitor.state().reorgOrphanedEventKeys.includes(orphanedKey));

  provider.logs = provider.logs.filter((log) => log !== oldLog);
  provider.receipts.delete(oldLog.transactionHash.toLowerCase());
  provider.addEvent("MarketCreated", [
    MARKET_B.ticker, MARKET_B.symbol, MARKET_B.name, MARKET_B.coin, MARKET_B.vault,
    MARKET_B.curve, MARKET_B.creator, MARKET_B.creatorFeeBps,
  ], oldLog.blockNumber, { transactionHash: id("mid-cycle-canonical-tx") });
  const recovered = await fixture.monitor.check();
  assert.equal(recovered.status, "healthy");
  assert.equal(alerts.length, 2);
  assert.ok(alerts[1].reorgOrphanedEventKeys.includes(orphanedKey));
  assert.equal(fixture.monitor.state().cursor.nextBlock, provider.head + 1);
});

test("a chunk hash change after receipt verification sends nothing and holds the cursor", async (t) => {
  const fixture = await harness(t);
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.paused = true;
  const log = fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
  const getReceipt = fixture.provider.getTransactionReceipt.bind(fixture.provider);
  fixture.provider.getTransactionReceipt = async (transactionHash) => {
    const receipt = await getReceipt(transactionHash);
    if (String(transactionHash).toLowerCase() === log.transactionHash.toLowerCase()) {
      fixture.provider.blockHashes.set(log.blockNumber, id("changed-after-receipt"));
    }
    return receipt;
  };
  const failed = await fixture.monitor.check();
  assert.ok(["PON_LOG_RECEIPT_MISMATCH", "PON_SCAN_ANCHOR_CHANGED"].includes(failed.errorCode));
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(fixture.alerts.length, 0);
});

test("delivery consumption accepts only durable outcomes and the explicit terminal allowlist", async (t) => {
  const accepted = [
    { status: "delivered" },
    { status: "queued" },
    ...["semantic_duplicate", "delivery_ttl_expired", "blocked_event", "repeated_official_token", "policy_suppressed"]
      .map((reason) => ({ status: "suppressed", reason, terminal: true })),
  ];
  for (const [index, outcome] of accepted.entries()) {
    await t.test(`accepted-${index}`, async (subtest) => {
      const fixture = await harness(subtest, { sendAlertsImpl: async () => outcome });
      await fixture.monitor.check();
      fixture.provider.paused = true;
      fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
      assert.equal((await fixture.monitor.check()).status, "healthy");
      assert.equal(fixture.monitor.state().cursor.nextBlock, fixture.provider.head + 1);
    });
  }

  const rejected = [
    { label: "source-disabled", value: { status: "suppressed", reason: "monitoring_source_disabled", terminal: true } },
    { label: "not-relevant", value: { status: "suppressed", reason: "not_relevant", terminal: true } },
    { label: "unknown", value: { status: "suppressed", reason: "some_new_reason", terminal: true } },
    { label: "retry", value: { status: "suppressed", reason: "semantic_duplicate", terminal: false, disposition: "retry" } },
    { label: "failed", value: { status: "failed" } },
  ];
  for (const scenario of rejected) {
    await t.test(scenario.label, async (subtest) => {
      const fixture = await harness(subtest, { sendAlertsImpl: async () => scenario.value });
      await fixture.monitor.check();
      const before = fixture.monitor.state().cursor.nextBlock;
      fixture.provider.paused = true;
      fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, "PON_ALERT_NOT_DURABLE");
      assert.equal(fixture.monitor.state().cursor.nextBlock, before);
    });
  }
  await t.test("throw", async (subtest) => {
    const fixture = await harness(subtest, { sendAlertsImpl: async () => { throw new Error("delivery offline"); } });
    await fixture.monitor.check();
    const before = fixture.monitor.state().cursor.nextBlock;
    fixture.provider.paused = true;
    fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
    const result = await fixture.monitor.check();
    assert.equal(result.errorCode, "PON_ALERT_NOT_DURABLE");
    assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  });
});

test("an old but still-relevant control event emits a durable T2 delayed-recovery summary", async (t) => {
  const attempts = [];
  const fixture = await harness(t, {
    sendAlertsImpl: async (_config, event) => {
      attempts.push(event);
      return attempts.length === 1
        ? { status: "suppressed", reason: "freshness_too_old", terminal: true }
        : { status: "delivered", eventId: event.eventKey };
    },
  });
  await fixture.monitor.check();
  fixture.provider.paused = true;
  fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
  const result = await fixture.monitor.check();
  assert.equal(result.status, "healthy");
  assert.equal(attempts.length, 2);
  const [original, recovery] = attempts;
  assert.equal(recovery.eventKey, `${original.eventKey}:delayed-recovery:v1`);
  assert.equal(recovery.originalEventKey, original.eventKey);
  assert.equal(recovery.delayedRecovery.version, 1);
  assert.equal(recovery.delayedRecovery.reason, "monitoring_gap_recovery");
  assert.equal(recovery.delayedRecovery.sourceOccurredAt, original.blockTimestamp);
  assert.equal(recovery.delayedRecovery.recoveredAt, original.observedAt);
  assert.ok(recovery.delayedRecovery.lagMs > 2 * 60 * 60 * 1_000);
  assert.equal(isOfficialPonFunUpdate(recovery), true);
  assert.equal(fixture.monitor.state().missedCriticalChanges.length, 1);
  assert.equal(fixture.monitor.state()._health.missedCriticalChangeCount, 1);
  await fixture.monitor.check();
  assert.equal(attempts.length, 2);
});

test("an undeliverable delayed-recovery summary holds the source cursor", async (t) => {
  let attempts = 0;
  const fixture = await harness(t, {
    sendAlertsImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? { status: "suppressed", reason: "freshness_too_old", terminal: true }
        : { status: "suppressed", reason: "monitoring_source_disabled", terminal: true };
    },
  });
  await fixture.monitor.check();
  const before = fixture.monitor.state().cursor.nextBlock;
  fixture.provider.paused = true;
  fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
  const result = await fixture.monitor.check();
  assert.equal(result.errorCode, "PON_ALERT_NOT_DURABLE");
  assert.equal(fixture.monitor.state().cursor.nextBlock, before);
  assert.equal(fixture.monitor.state().missedCriticalChanges.length, 0);
});

test("delayed-recovery summaries reject non-delivery terminal policy outcomes", async (t) => {
  for (const reason of [
    "delivery_ttl_expired",
    "blocked_event",
    "repeated_official_token",
    "policy_suppressed",
    "freshness_too_old",
  ]) {
    await t.test(reason, async (subtest) => {
      let calls = 0;
      const fixture = await harness(subtest, {
        sendAlertsImpl: async () => {
          calls += 1;
          return calls === 1
            ? { status: "suppressed", reason: "freshness_too_old", terminal: true }
            : { status: "suppressed", reason, terminal: true, persisted: true };
        },
      });
      await fixture.monitor.check();
      const before = fixture.monitor.state().cursor.nextBlock;
      fixture.provider.paused = true;
      fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, "PON_ALERT_NOT_DURABLE");
      assert.equal(fixture.monitor.state().cursor.nextBlock, before);
    });
  }
  await t.test("persisted semantic duplicate", async (subtest) => {
    let calls = 0;
    const fixture = await harness(subtest, {
      sendAlertsImpl: async () => {
        calls += 1;
        return calls === 1
          ? { status: "suppressed", reason: "freshness_too_old", terminal: true }
          : { status: "suppressed", reason: "semantic_duplicate", terminal: true, persisted: true };
      },
    });
    await fixture.monitor.check();
    fixture.provider.paused = true;
    fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
    assert.equal((await fixture.monitor.check()).status, "healthy");
  });
});

test("A-B-A-B API lifecycle revisions remain distinct through the real alert outbox and retry keys stay stable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-real-alerts-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  t.mock.method(console, "info", () => {});
  const provider = new FakePonProvider();
  const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
  const fixture = await harness(t, {
    dataDir,
    provider,
    api,
    sendAlertsImpl: sendAlerts,
    config: {
      monitorScope: "focus3",
      telegramToken: "test-bot-token-secret",
      telegramChatId: "1234567890",
      telegramStrongAlerts: false,
      alertChineseTranslationEnabled: false,
      alertTelegramDeliveryMaxAgeMs: 7_200_000,
      blockedContracts: new Set(),
      webhookUrl: "",
    },
  });
  await fixture.monitor.check();
  const applyListing = (stockToken, poolFee) => {
    provider.markets[0] = { ...provider.markets[0], stockToken, poolFee };
    provider.listings.set(MARKET_A.ticker, { stockToken, poolFee, active: true, ticker: MARKET_A.ticker });
    api.markets[0] = clone(provider.markets[0]);
  };
  const alternate = "0xdddddddddddddddddddddddddddddddddddddddd";
  applyListing(alternate, 10_000);
  assert.equal((await fixture.monitor.check()).status, "healthy");
  applyListing(MARKET_A.stockToken, MARKET_A.poolFee);
  assert.equal((await fixture.monitor.check()).status, "healthy");
  applyListing(alternate, 10_000);
  assert.equal((await fixture.monitor.check()).status, "healthy");
  assert.equal(payloads.length, 3, "the repeated A-B transition must not be exact- or semantic-suppressed");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const revisions = Object.values(outbox.events).filter((entry) => entry.event?.type === "pon_fun_update");
  assert.equal(revisions.length, 3);
  assert.deepEqual(revisions.map((entry) => entry.event.evidence.transitionRevision), [1, 2, 3]);
  assert.equal(new Set(revisions.map((entry) => entry.id)).size, 3);
  assert.equal(revisions.every((entry) => entry.semanticDuplicateOf === null), true);
  assert.equal(revisions.every((entry) => entry.event.freshness.decision === "realtime"), true);
  assert.equal(revisions.every((entry) => entry.event.tradingPriority.tier === "T2"), true);
  assert.equal(revisions.every((entry) => entry.deliveryDisposition.reason === "pon_exact_onchain_realtime"), true);
});

test("a failed API lifecycle delivery reserves one stable revision across restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pon-monitor-revision-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakePonProvider();
  const api = { markets: provider.markets.map(clone), healthFactory: PON_FACTORY, responseUrls: {}, fail: new Set() };
  const attemptedKeys = [];
  const sender = async (_config, event) => {
    attemptedKeys.push(event.eventKey);
    return attemptedKeys.length === 1 ? { status: "failed" } : { status: "queued", eventId: event.eventKey };
  };
  const first = await harness(t, { dataDir, provider, api, sendAlertsImpl: sender });
  await first.monitor.check();
  const alternate = "0xdddddddddddddddddddddddddddddddddddddddd";
  provider.markets[0] = { ...provider.markets[0], stockToken: alternate, poolFee: 10_000 };
  provider.listings.set(MARKET_A.ticker, { stockToken: alternate, poolFee: 10_000, active: true, ticker: MARKET_A.ticker });
  api.markets[0] = clone(provider.markets[0]);
  assert.equal((await first.monitor.check()).errorCode, "PON_ALERT_NOT_DURABLE");
  const reserved = first.monitor.state().pendingApiTransitions[`market:${MARKET_A.coin.toLowerCase()}`];
  assert.equal(reserved.revision, 1);
  await first.monitor.stop();

  const second = await harness(t, { dataDir, provider, api, sendAlertsImpl: sender });
  assert.equal((await second.monitor.check()).status, "healthy");
  assert.deepEqual(attemptedKeys, [reserved.eventKey, reserved.eventKey]);
  assert.equal(Object.keys(second.monitor.state().pendingApiTransitions).length, 0);
  assert.equal(second.monitor.state().apiTransitionRevisions[`market:${MARKET_A.coin.toLowerCase()}`], 1);
});

test("500 pending markets are retried in a bounded batch, transport-fail as a cycle, and stop aborts hung RPC", async (t) => {
  const fixture = await harness(t, {
    pendingLimit: 500,
    config: { ponPendingBatchSize: 10, ponValidationConcurrency: 4 },
  });
  await fixture.monitor.check();
  const markets = Array.from({ length: 500 }, (_, index) => syntheticMarket(index + 100));
  fixture.provider.markets.push(...markets.map(clone));
  for (const market of markets) {
    fixture.provider.addEvent("MarketCreated", [
      market.ticker, market.symbol, market.name, market.coin, market.vault,
      market.curve, market.creator, market.creatorFeeBps,
    ]);
  }
  const queued = await fixture.monitor.check();
  assert.equal(queued.status, "healthy");
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 500);
  const durableCursor = fixture.monitor.state().cursor.nextBlock;

  fixture.api.markets.push(...markets.map(clone));
  const getReceipt = fixture.provider.getTransactionReceipt.bind(fixture.provider);
  let receiptCalls = 0;
  fixture.provider.getTransactionReceipt = async (transactionHash) => {
    if (String(transactionHash).toLowerCase() !== PON_FACTORY_DEPLOY_TRANSACTION.toLowerCase()) {
      receiptCalls += 1;
      throw new Error("RPC transport offline");
    }
    return getReceipt(transactionHash);
  };
  const offline = await fixture.monitor.check();
  assert.equal(offline.errorCode, "PON_LOG_RECEIPT_FAILED");
  assert.equal(fixture.monitor.state().cursor.nextBlock, durableCursor);
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 500);
  assert.ok(receiptCalls <= 4, "a first transport failure must stop launching more than the active worker set");

  receiptCalls = 0;
  fixture.provider.getTransactionReceipt = async (transactionHash) => {
    receiptCalls += 1;
    return getReceipt(transactionHash);
  };
  const bounded = await fixture.monitor.check();
  assert.equal(bounded.status, "healthy");
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 490);
  assert.equal(receiptCalls, 10);

  fixture.provider.getTransactionReceipt = async () => new Promise(() => {});
  const hanging = fixture.monitor.check();
  await new Promise((resolve) => setImmediate(resolve));
  const started = performance.now();
  await fixture.monitor.stop();
  assert.ok(performance.now() - started < 1_000, "stop must abort a hung pending-proof RPC batch");
  assert.equal((await hanging).errorCode, "PON_STOPPED");
  assert.equal(Object.keys(fixture.monitor.state().pendingMarketEvents).length, 490);
});

test("getLogs rejects removed, non-integer, out-of-range, foreign-address and foreign-topic records before receipt processing", async (t) => {
  const cases = [
    ["removed", (log) => ({ ...log, removed: true })],
    ["non-integer", (log) => ({ ...log, blockNumber: String(log.blockNumber) })],
    ["below-range", (log) => ({ ...log, blockNumber: log.blockNumber - 1 })],
    ["above-range", (log) => ({ ...log, blockNumber: log.blockNumber + 1 })],
    ["foreign-address", (log) => ({ ...log, address: "0x9999999999999999999999999999999999999999" })],
    ["foreign-topic", (log) => ({ ...log, topics: [id("ForeignEvent()")], data: "0x" })],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async (subtest) => {
      const fixture = await harness(subtest);
      await fixture.monitor.check();
      const before = fixture.monitor.state().cursor.nextBlock;
      const log = fixture.provider.addEvent("Paused", [PON_INITIAL_OWNER]);
      fixture.provider.getLogs = async () => [mutate(log)];
      const result = await fixture.monitor.check();
      assert.equal(result.errorCode, "PON_LOG_BOUNDARY_INVALID");
      assert.equal(fixture.monitor.state().cursor.nextBlock, before);
      assert.equal(fixture.alerts.length, 0);
    });
  }
});
