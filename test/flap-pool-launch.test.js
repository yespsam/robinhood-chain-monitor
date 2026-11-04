import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, ZeroAddress, getAddress, id } from "ethers";
import {
  FLAP_DIRECT_LAUNCHED_TOPIC,
  FLAP_POOL_LAUNCH_DOCS_URL,
  FLAP_POOL_LAUNCH_PORTAL,
  V2_POOL_LAUNCH_SCHEMA_V1,
  buildFlapPoolLaunchUpdate,
  decodeFlapPoolLaunchReceipt,
  flapPoolLaunchInterface,
  isCanonicalFlapPoolLaunchUpdate,
} from "../src/flap-pool-launch.js";
import {
  BSC_LAUNCH_TOPICS,
  evaluateBscObservation,
  parseKnownBscLaunchEvidence,
  platformForAddress,
} from "../src/bsc-launchpad-monitor.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import { isRelevantAlert } from "../src/alerts.js";
import { deriveTradingPriority } from "../src/trading-priority.js";

const coder = AbiCoder.defaultAbiCoder();
const TOKEN = getAddress("0x2222222222222222222222222222222222227777");
const CREATOR = getAddress("0x1111111111111111111111111111111111111111");
const POOL = getAddress("0x3333333333333333333333333333333333333333");
const VAULT = getAddress("0x4444444444444444444444444444444444444444");
const VAULT_FACTORY = getAddress("0x5555555555555555555555555555555555555555");
const TX = `0x${"ab".repeat(32)}`;
const DATA_TUPLE = "tuple(uint256 nonce,uint256 ts,uint8 tokenVersion,address quoteToken,uint8 migratorType,uint256 initialPriceWad,string name,string symbol,string meta,address pool,uint256 totalSupply,uint8 antiSniperMode,uint16 maxBuyBps)";

function encodeData({
  quoteToken = ZeroAddress,
  initialPriceWad = 2n * 10n ** 18n,
  name = "Pool Token",
  symbol = "POOL",
  meta = "ipfs://pool",
  pool = POOL,
  totalSupply = 1_000_000n * 10n ** 18n,
} = {}) {
  return coder.encode([DATA_TUPLE], [[
    7n,
    1_700_000_000n,
    0,
    quoteToken,
    1,
    initialPriceWad,
    name,
    symbol,
    meta,
    pool,
    totalSupply,
    0,
    0,
  ]]);
}

function directLog({
  token = TOKEN,
  kind = 0,
  creator = CREATOR,
  schemaId = V2_POOL_LAUNCH_SCHEMA_V1,
  data = encodeData(),
  address = FLAP_POOL_LAUNCH_PORTAL,
  logIndex = 4,
} = {}) {
  const encoded = flapPoolLaunchInterface.encodeEventLog(
    flapPoolLaunchInterface.getEvent("FlapDirectLaunched"),
    [token, kind, creator, schemaId, data],
  );
  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    logIndex,
    transactionHash: TX,
  };
}

function eventLog(name, args, logIndex) {
  const encoded = flapPoolLaunchInterface.encodeEventLog(flapPoolLaunchInterface.getEvent(name), args);
  return { address: FLAP_POOL_LAUNCH_PORTAL, topics: encoded.topics, data: encoded.data, logIndex, transactionHash: TX };
}

function observationFrom(launches, overrides = {}) {
  return {
    launcher: FLAP_POOL_LAUNCH_PORTAL,
    transactionHash: TX,
    blockNumber: 200,
    blockHash: `0x${"cd".repeat(32)}`,
    transactionIndex: 1,
    platform: {
      id: "flap",
      name: "Flap",
      trust: "official_verified",
      website: "https://flap.sh",
      twitter: "https://x.com/flapdotsh",
    },
    tokens: [{ token: TOKEN, isNewContract: true, metadata: { name: "Pool Token", symbol: "POOL" } }],
    pools: [],
    mode: {
      fingerprint: "pool-mode-b",
      selector: "0x22222222",
      poolKinds: [],
      creationTopics: [FLAP_DIRECT_LAUNCHED_TOPIC],
      customTopics: [FLAP_DIRECT_LAUNCHED_TOPIC],
      tokenSelectorHash: "token-b",
      launcherCodeHash: "launcher-a",
      implementation: "0x7777777777777777777777777777777777777777",
    },
    structural: { eligible: true, mechanismEvidence: true, usesCreate2: true, codeSize: 12_000, argumentBytes: 128 },
    deployer: CREATOR,
    causalTokenEvent: true,
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
    sampleToken: TOKEN,
    observedAt: "2026-08-02T01:00:00.000Z",
    poolLaunch: launches,
    ...overrides,
  };
}

test("FlapDirectLaunched topic and V2 schema match the Pool Launch docs", () => {
  assert.equal(FLAP_DIRECT_LAUNCHED_TOPIC, id("FlapDirectLaunched(address,uint8,address,bytes32,bytes)"));
  assert.equal(V2_POOL_LAUNCH_SCHEMA_V1, id("DirectLaunchV2(DirectLaunchV2Data)"));
  assert.equal(FLAP_POOL_LAUNCH_PORTAL, getAddress("0x000042108465206185A077Edc3F3fd2b49060000"));
  assert.ok(BSC_LAUNCH_TOPICS.includes(FLAP_DIRECT_LAUNCHED_TOPIC));
  assert.equal(platformForAddress(FLAP_POOL_LAUNCH_PORTAL)?.id, "flap");
});

test("decodes a DIRECT_V2_POOL_TAX launch, graduation, vault and distribution from one receipt", () => {
  const logs = [
    directLog(),
    eventLog("FlapTokenGraduated", [TOKEN], 5),
    eventLog("FlapLaunchVaultResolved", [TOKEN, VAULT, VAULT_FACTORY], 6),
    eventLog("FlapDistributionExecuted", [TOKEN, 2, VAULT, 80n * 10n ** 18n], 7),
  ];
  const [launch] = decodeFlapPoolLaunchReceipt(logs);
  assert.equal(launch.event, "FlapDirectLaunched");
  assert.equal(launch.launchKindName, "DIRECT_V2_POOL_TAX");
  assert.equal(launch.schemaName, "V2_POOL_LAUNCH_SCHEMA_V1");
  assert.equal(launch.schemaKnown, true);
  assert.equal(launch.token, TOKEN);
  assert.equal(launch.creator, CREATOR);
  assert.equal(launch.pool, POOL);
  assert.equal(launch.quoteNative, true);
  assert.equal(launch.quoteLabel, "BNB");
  assert.equal(launch.name, "Pool Token");
  assert.equal(launch.symbol, "POOL");
  assert.equal(launch.meta, "ipfs://pool");
  assert.equal(launch.initialPriceQuotePerToken, "2");
  assert.equal(launch.initialPriceWad, (2n * 10n ** 18n).toString());
  assert.equal(launch.totalSupply, (1_000_000n * 10n ** 18n).toString());
  assert.equal(launch.tokenVersionName, "TOKEN_DIRECT_TAXED");
  assert.equal(launch.graduated, true);
  assert.equal(launch.graduationFinal, true);
  assert.equal(launch.vault, VAULT);
  assert.equal(launch.vaultFactory, VAULT_FACTORY);
  assert.equal(launch.distribution.targetName, "VAULT");
  assert.equal(launch.distribution.strategy, VAULT);
  assert.equal(launch.monitorOnly, true);
  assert.equal(launch.autoTradeEligible, false);
  assert.equal(launch.docsUrl, FLAP_POOL_LAUNCH_DOCS_URL);

  const evidence = parseKnownBscLaunchEvidence([logs[0]]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].token, TOKEN);
  assert.equal(evidence[0].event, "FlapDirectLaunched");
  assert.equal(evidence[0].launchType, "direct_v2_pool_tax");
  assert.equal(evidence[0].name, "Pool Token");
  assert.equal(evidence[0].pool, POOL);
});

test("a missing graduation event is final for DIRECT_V2_POOL_TAX and an unknown schema stays partial", () => {
  const [plain] = decodeFlapPoolLaunchReceipt([directLog()]);
  assert.equal(plain.graduated, false);
  assert.equal(plain.graduationFinal, true);
  assert.equal(plain.vault, null);

  const [unknown] = decodeFlapPoolLaunchReceipt([directLog({
    schemaId: id("DirectLaunchV2(Future)"),
    data: "0x",
    kind: 4,
  })]);
  assert.equal(unknown.schemaKnown, false);
  assert.equal(unknown.schemaName, null);
  assert.equal(unknown.name, null);
  assert.equal(unknown.pool, null);
  assert.equal(unknown.token, TOKEN);
  assert.equal(unknown.creator, CREATOR);
  assert.equal(unknown.launchKind, 4);
  assert.equal(unknown.graduationFinal, false);
  assert.equal(unknown.graduated, false);

  assert.deepEqual(decodeFlapPoolLaunchReceipt([directLog({ address: CREATOR })]), []);
  assert.deepEqual(parseKnownBscLaunchEvidence([directLog({ address: CREATOR })]), []);
});

test("the alert is monitor-only and does not become a tradable launch mode", () => {
  const launches = decodeFlapPoolLaunchReceipt([
    directLog(),
    eventLog("FlapTokenGraduated", [TOKEN], 5),
    eventLog("FlapLaunchVaultResolved", [TOKEN, VAULT, VAULT_FACTORY], 6),
  ]);
  const event = buildFlapPoolLaunchUpdate(observationFrom(launches));
  assert.equal(isCanonicalFlapPoolLaunchUpdate(event), true);
  assert.equal(event.kind, "flap_pool_launch");
  assert.equal(event.informationalOnly, true);
  assert.equal(event.autoTradeEligible, false);
  assert.equal(event.automaticExecution, false);
  assert.equal(event.mode.componentMode, "Flap Pool Launch");
  assert.equal(event.poolLaunches[0].graduated, true);
  assert.equal(event.poolLaunches[0].vault, VAULT);
  assert.equal(event.tokens[0].metadata.name, "Pool Token");
  assert.equal(event.pools[0].pool, POOL);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, { ...event, autoTradeEligible: true }), false);
  assert.equal(isRelevantAlert({ ...event, autoTradeEligible: true }), false);

  const priority = deriveTradingPriority(event, { nowMs: Date.parse("2026-08-02T01:00:05.000Z") });
  assert.equal(priority.category, "information");
  assert.equal(priority.hardGates.explicitPath, false);
  assert.equal(priority.plan.automaticExecution, false);

  const current = Date.parse("2026-08-02T01:00:00.000Z");
  const state = { initializedAt: "2020-01-01T00:00:00.000Z", launchers: {}, seenTransactions: {}, coverageGaps: [] };
  const baseline = observationFrom(null, {
    poolLaunch: null,
    transactionHash: `0x${"11".repeat(32)}`,
    mode: {
      fingerprint: "curve-baseline",
      selector: "0x11111111",
      poolKinds: [],
      creationTopics: [],
      customTopics: [],
      tokenSelectorHash: "token-a",
      launcherCodeHash: "launcher-a",
      implementation: "0x7777777777777777777777777777777777777777",
    },
  });
  assert.equal(evaluateBscObservation(state, baseline, current), null);
  const tradableTwin = observationFrom(null, { poolLaunch: null });
  const decision = evaluateBscObservation(state, tradableTwin, current);
  assert.equal(decision?.kind, "new_mode");
  const monitored = observationFrom(launches, {
    transactionHash: `0x${"22".repeat(32)}`,
    tokens: [{ token: getAddress("0x6666666666666666666666666666666666666666"), metadata: { name: "Pool Token", symbol: "POOL" } }],
    sampleToken: getAddress("0x6666666666666666666666666666666666666666"),
  });
  monitored.poolLaunch = launches.map((launch) => ({
    ...launch,
    token: monitored.sampleToken,
  }));
  monitored.tokens[0].token = monitored.sampleToken;
  assert.equal(evaluateBscObservation(state, monitored, current), null);
  assert.equal(state.launchers[FLAP_POOL_LAUNCH_PORTAL.toLowerCase()].tokens[monitored.sampleToken.toLowerCase()].token, monitored.sampleToken);
});
