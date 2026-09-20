import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHealthSettings, runHealthCheck } from "../deploy/health-check.mjs";
import { GMGN_FLOW_CHAINS, evaluateGmgnFlowSignal, isGmgnFlowEvent } from "../src/gmgn-flow-signal.js";

const NOW = Date.parse("2026-09-20T09:00:00.000Z");
const at = (delta = -5_000) => new Date(NOW + delta).toISOString();

function flowState() {
  return { version: 1, initializedAt: at(-3_600_000), updatedAt: at(),
    health: { status: "healthy", checkedAt: at(), lastError: null, lastErrorCode: null, nextAttemptAt: null },
    chains: Object.fromEntries(Object.keys(GMGN_FLOW_CHAINS).map((key) => [key, {
      status: "healthy", checkedAt: at(-120_000), lastSuccessAt: at(-120_000), nextAttemptAt: null,
      lastError: null, lastErrorCode: null, tradeCount: 0, candidateCount: 0, feedTruncated: false, coverageGap: null,
    }])), hotDiscovery: { status: "healthy", checkedAt: at(), nextAttemptAt: null,
      lastError: null, chains: ["monad", "megaeth", "hyperevm", "tron"].map(chain => ({ chain, count: 0, mode: "discovery_only" })) },
    pendingEvents: [], episodes: {}, trades: {}, profiles: {} };
}

function validEvent() {
  const chain = "bsc", ca = "0x" + "a".repeat(40);
  const candles = Array.from({ length: 20 }, (_, i) => ({ time: NOW - (20 - i) * 60_000, volumeUsd: i < 15 ? 2_000 : 8_000 }));
  const profiles = {}, trades = [];
  for (let i = 1; i <= 6; i++) {
    const wallet = "0x" + i.toString(16).padStart(40, "0"), hash = "0x" + i.toString(16).padStart(64, "0");
    profiles[wallet] = Object.fromEntries(["7d", "30d"].map((period) => [period, {
      chain, wallet, period, checkedAt: at(), realizedProfitUsd: 20_000, realizedRoi: 0.5,
      winRate: 0.8, tokenCount: 200, buyCount: 200, sellCount: 200, tags: [],
      createdAt: Math.floor(NOW / 1_000) - 90 * 86400, lastTradeAt: Math.floor(NOW / 1_000) - 60, createdTokenCount: 0,
    }]));
    trades.push({ key: `${chain}:${hash}:${wallet}:${ca}:buy`, chain, wallet, tokenAddress: ca, hash,
      side: "buy", amountUsd: 3_000, at: NOW - 60_000, tags: i <= 3 ? ["fomo"] : [], symbol: "TOKEN" });
  }
  const evidence = { version: 1, provider: "gmgn-cli", chain, tokenAddress: ca, candles, trades, profiles };
  const result = evaluateGmgnFlowSignal({ ...evidence, nowMs: NOW });
  assert.ok(result);
  const event = { type: "gmgn_flow_surge", platform: "gmgn", chain: GMGN_FLOW_CHAINS[chain],
    token: { address: ca, symbol: "TOKEN" }, observedAt: at(0), sourceOccurredAt: result.signal.windowEndAt,
    source: { id: "gmgn_flow_observed", trust: "provider_reported", url: `https://gmgn.ai/${chain}/token/${ca}` },
    eventKey: `gmgn-flow:${chain}:${ca}:${Date.parse(result.signal.windowEndAt)}`,
    ...result, evidence, narrative: { status: "unverified", text: "叙事待核实", sourceUrl: null,
      sourceAt: null, chain, tokenAddress: ca } };
  assert.equal(isGmgnFlowEvent(event), true);
  return event;
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gmgn-flow-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"), configDir = path.join(root, "config");
  await fs.mkdir(dataDir); await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "node-id"), "test-node");
  await fs.writeFile(path.join(configDir, "ACTIVE"), "test-node");
  const hydrate = (value) => {
    if (Array.isArray(value)) return value.map(hydrate);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hydrate(v)]));
    return value === "__NOW__" ? at() : value === "__OLD__" ? at(-600_000) : value === "__NEXT__" ? at(300_000) : value;
  };
  const write = async (file, value) => {
    const filename = path.join(dataDir, file);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(value));
    await fs.utimes(filename, new Date(at()), new Date(at()));
  };
  const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/health/healthy-stack.json", import.meta.url), "utf8"));
  for (const [file, raw] of Object.entries(fixture)) {
    const value = hydrate(raw);
    if (file === "fomo-x-call-state.json" && value.health) {
      Object.assign(value.health, { operationalStatus: "healthy", lastOperationalSuccessAt: value.health.checkedAt, consecutiveFailures: 0 });
      value.health.sources ||= {}; value.health.sources.x ||= {};
      Object.assign(value.health.sources.x, { operationalStatus: "healthy", lastOperationalSuccessAt: value.health.checkedAt, consecutiveFailures: 0 });
    }
    await write(file, value);
  }
  const check = async (state = flowState(), overrides = {}) => {
    if (state) await write("gmgn-flow-state.json", state);
    return runHealthCheck({ env: { DATA_DIR: dataDir, HEALTH_CONFIG_DIR: configDir,
      HEALTH_REQUIRE_EXTERNAL_HEARTBEAT: "false", GMGN_FLOW_MONITOR_ENABLED: "true", ...overrides },
    nowMs: NOW, serviceStateImpl: async () => "active", writeReportFile: false,
    fetchImpl: async () => { throw new Error("health must not use network"); } });
  };
  return { dataDir, check };
}

test("GMGN flow health is opt-in with separate scheduler and source freshness", () => {
  assert.equal(buildHealthSettings({}).requirements.gmgnFlow, false);
  assert.equal(buildHealthSettings({ GMGN_FLOW_MONITOR_ENABLED: "true" }).requirements.gmgnFlow, true);
  assert.equal(buildHealthSettings({ GMGN_FLOW_MONITOR_ENABLED: "true", HEALTH_REQUIRE_GMGN_FLOW: "false" }).requirements.gmgnFlow, false);
  assert.equal(buildHealthSettings({}).limits.gmgnFlowAgeSeconds, 180);
  assert.equal(buildHealthSettings({}).limits.gmgnFlowSourceAgeSeconds, 900);
  assert.throws(() => buildHealthSettings({ HEALTH_GMGN_FLOW_SOURCE_MAX_AGE_SECONDS: "0" }));
});

test("GMGN disabled requires no state; healthy sources never imply full hot-only wallet coverage", async (t) => {
  const { check } = await workspace(t);
  assert.equal((await check(null, { GMGN_FLOW_MONITOR_ENABLED: "false" })).lanes.gmgnFlow.status, "disabled");
  const { lanes: { gmgnFlow: lane } } = await check();
  assert.equal(lane.operationalHealthy, true, lane.operationalReasons.join(","));
  assert.equal(lane.status, "degraded");
  assert.equal(lane.coverageComplete, false);
  assert.deepEqual(lane.coverageReasons, ["gmgn_hot_only_chains_no_wallet_verification"]);
  assert.equal(Object.keys(lane.semantic.chains).length, 5);
  assert.equal(lane.semantic.chains.sol.coverageComplete, true);
  assert.deepEqual(lane.semantic.hotOnlyChains, ["monad", "megaeth", "hyperevm", "tron"]);
});

test("GMGN required missing, corrupt or incompatible state fails operational health", async (t) => {
  const { check, dataDir } = await workspace(t);
  assert.ok((await check(null)).lanes.gmgnFlow.operationalReasons.includes("gmgn-flow-state.json_missing"));
  await fs.writeFile(path.join(dataDir, "gmgn-flow-state.json"), "{broken");
  assert.equal((await check(null)).lanes.gmgnFlow.operationalHealthy, false);
  const state = flowState(); state.version = 2;
  assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false);
});

test("GMGN round-robin sources can be older than the scheduler but not older than 900 seconds", async (t) => {
  const { check } = await workspace(t);
  const state = flowState();
  state.chains.base.checkedAt = state.chains.base.lastSuccessAt = at(-899_000);
  assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, true);
  state.chains.base.checkedAt = state.chains.base.lastSuccessAt = at(-901_000);
  assert.ok((await check(state)).lanes.gmgnFlow.operationalReasons.includes("gmgn_flow_source_base_checked_stale"));
});

test("GMGN fresh file timestamps cannot disguise stalled scheduler or state writes", async (t) => {
  const { check } = await workspace(t);
  for (const field of ["checkedAt", "updatedAt"]) {
    const state = flowState();
    if (field === "checkedAt") state.health.checkedAt = at(-181_000); else state.updatedAt = at(-181_000);
    assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false, field);
  }
});

test("GMGN bounded 429 backoff is incomplete coverage while fresh scheduler remains healthy", async (t) => {
  const { check } = await workspace(t);
  const state = flowState();
  Object.assign(state.chains.sol, { status: "backoff", checkedAt: at(-600_000), lastSuccessAt: at(-3600_000),
    nextAttemptAt: at(120_000), lastError: "HTTP 429", lastErrorCode: "GMGN_RATE_LIMIT" });
  let lane = (await check(state)).lanes.gmgnFlow;
  assert.equal(lane.operationalHealthy, true, lane.operationalReasons.join(","));
  assert.equal(lane.semantic.chains.sol.scheduledBackoff, true);
  assert.equal(lane.coverageComplete, false);
  state.health.checkedAt = at(-181_000);
  lane = (await check(state)).lanes.gmgnFlow;
  assert.equal(lane.operationalHealthy, false);
});

test("GMGN retries must be future and no longer than 15 minutes from attempt", async (t) => {
  const { check } = await workspace(t);
  for (const next of [null, "invalid", at(-1), at(901_000)]) {
    const state = flowState();
    Object.assign(state.chains.eth, { status: "backoff", checkedAt: at(0), nextAttemptAt: next, lastError: "429" });
    assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false, String(next));
  }
});

test("GMGN unsupported wallet capability and truncated feeds are coverage gaps, not process failures", async (t) => {
  const { check } = await workspace(t);
  const state = flowState();
  Object.assign(state.chains.robinhood, { status: "unsupported", checkedAt: at(-86_400_000), lastSuccessAt: null,
    lastError: "wallet stats unavailable", lastErrorCode: "GMGN_UNSUPPORTED", coverageGap: "wallet_stats_unavailable" });
  Object.assign(state.chains.bsc, { status: "partial", feedTruncated: true, coverageGap: "bounded_feed" });
  const lane = (await check(state)).lanes.gmgnFlow;
  assert.equal(lane.operationalHealthy, true, lane.operationalReasons.join(","));
  assert.ok(lane.coverageReasons.includes("gmgn_flow_source_robinhood_unsupported"));
  assert.ok(lane.coverageReasons.includes("gmgn_flow_source_bsc_feed_truncated"));
});

test("GMGN initialization has bounded scheduler and per-source grace", async (t) => {
  const { check } = await workspace(t);
  const state = flowState(); state.initializedAt = at(); state.health.status = "initializing"; state.health.checkedAt = null;
  for (const source of [...Object.values(state.chains), state.hotDiscovery]) {
    source.status = "initializing"; source.checkedAt = null;
    if (Object.hasOwn(source, "lastSuccessAt")) source.lastSuccessAt = null;
  }
  assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, true);
  state.initializedAt = at(-901_000); state.health.checkedAt = at(); state.health.status = "partial";
  assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false);
});

test("GMGN pending events retain delivery gap and enforce the same evidence gate as alerts", async (t) => {
  const { check } = await workspace(t);
  const state = flowState(); state.pendingEvents = [validEvent()];
  let lane = (await check(state)).lanes.gmgnFlow;
  assert.equal(lane.operationalHealthy, true, lane.operationalReasons.join(","));
  assert.equal(lane.semantic.pendingDeliveryCount, 1);
  assert.ok(lane.coverageReasons.includes("gmgn_flow_delivery_pending"));
  state.pendingEvents[0].signal.highProfitCount += 1;
  lane = (await check(state)).lanes.gmgnFlow;
  assert.ok(lane.operationalReasons.includes("gmgn_flow_state_schema_invalid:pendingEvents"));
});

test("GMGN nested schema corruption cannot be masked by fresh heartbeat", async (t) => {
  const { check } = await workspace(t);
  const mutations = [
    s => { delete s.chains.eth; }, s => { s.chains.tron = s.chains.eth; },
    s => { s.chains.sol = []; }, s => { s.chains.base.feedTruncated = "false"; },
    s => { s.chains.eth.tradeCount = -1; }, s => { s.chains.eth.candidateCount = 1.5; },
    s => { s.chains.sol.lastSuccessAt = null; }, s => { s.chains.sol.lastErrorCode = "UNRESOLVED"; },
    s => { s.health.status = "anything"; }, s => { s.health.lastError = "unresolved"; },
    s => { s.hotDiscovery.chains = ["unknown"]; }, s => { s.hotDiscovery.checkedAt = "invalid"; },
    s => { s.profiles = []; }, s => { s.episodes = null; }, s => { s.trades.sol = {}; },
    s => { s.pendingEvents = [null]; }, s => { s.pendingEvents = {}; },
    s => { s.initializedAt = at(61_000); }, s => { s.updatedAt = "invalid"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const state = flowState(); mutate(state);
    assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false, `mutation ${index}`);
  }
});

test("GMGN scheduler and hot discovery enforce valid backoff separately", async (t) => {
  const { check } = await workspace(t);
  for (const key of ["health", "hotDiscovery"]) {
    const state = flowState();
    Object.assign(state[key], { status: "backoff", checkedAt: at(), nextAttemptAt: at(120_000), lastError: "429" });
    assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, true, key);
    state[key].nextAttemptAt = at(-1);
    assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false, key);
  }
});

test("GMGN durable queue limits and duplicate events fail closed", async (t) => {
  const { check } = await workspace(t);
  const event = validEvent();
  const mutations = [
    s => { s.pendingEvents = [event, event]; },
    s => { s.pendingEvents = Array(501).fill(event); },
    s => { s.trades.sol = Array(10_001).fill({}); },
    s => { s.profiles = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [String(i), {}])); },
    s => { s.episodes = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [String(i), {}])); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const state = flowState(); mutate(state);
    assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false, `limit ${index}`);
  }
});

test("GMGN durable integrity failures are not excused by bounded retry", async (t) => {
  const { check } = await workspace(t);
  for (const code of ["GMGN_FLOW_STATE_INVALID", "GMGN_STATE_INVALID", "GMGN_PENDING_CAPACITY", "GMGN_DELIVERY_NOT_DURABLE",
    "GMGN_FLOW_PENDING_FULL", "GMGN_FLOW_DELIVERY_NOT_DURABLE", "GMGN_FLOW_TRADE_STATE_INVALID", "GMGN_FLOW_STATE_TOO_LARGE",
    "GMGN_FLOW_QUARANTINE_FULL"]) {
    for (const source of ["health", "bsc"]) {
      const state = flowState(), item = source === "health" ? state.health : state.chains[source];
      Object.assign(item, { status: "backoff", checkedAt: at(), nextAttemptAt: at(120_000), lastError: code, lastErrorCode: code });
      assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false, `${code}:${source}`);
    }
  }
});

test("GMGN token quarantine remains a coverage gap even if a producer status overlooks it", async (t) => {
  const { check } = await workspace(t), state = flowState(), ca = "0x" + "a".repeat(40);
  state.chains.bsc.quarantinedTokens = { [ca]: at(300_000) };
  let lane = (await check(state)).lanes.gmgnFlow;
  assert.equal(lane.operationalHealthy, true);
  assert.equal(lane.semantic.chains.bsc.quarantinedTokenCount, 1);
  assert.equal(lane.semantic.chains.bsc.coverageComplete, false);
  assert.ok(lane.coverageReasons.includes("gmgn_flow_source_bsc_quarantined_tokens"));
  state.chains.bsc.quarantinedTokens[ca] = at(-1000);
  lane = (await check(state)).lanes.gmgnFlow;
  assert.equal(lane.operationalHealthy, true);
  assert.equal(lane.semantic.chains.bsc.quarantinedTokenCount, 0);
  assert.equal(lane.semantic.chains.bsc.coverageComplete, true);
});

test("GMGN quarantine rejects invalid chain addresses, deadlines, and unbounded exclusion", async (t) => {
  const { check } = await workspace(t), ca = "0x" + "a".repeat(40);
  for (const value of [[], { invalid: at(300_000) }, { [ca]: "bad" }, { [ca]: at(901_000) }]) {
    const state = flowState(); state.chains.bsc.quarantinedTokens = value;
    assert.equal((await check(state)).lanes.gmgnFlow.operationalHealthy, false);
  }
});
