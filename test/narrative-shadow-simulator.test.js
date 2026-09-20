import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNarrativeShadowLedger } from "../src/narrative-shadow-ledger.js";
import {
  createNarrativeShadowSimulator,
  NARRATIVE_SHADOW_SIMULATOR_SCHEMA,
} from "../src/narrative-shadow-simulator.js";

const CA = "0xa11ce00000000000000000000000000000000001";
const POOL = "0xb001000000000000000000000000000000000001";
const START = Date.parse("2026-09-06T10:00:00.000Z");
const HEX = ["a", "b", "c", "d", "e", "f", "1", "2"];

function signal(ordinal) {
  const inputHash = HEX[(ordinal + 3) % HEX.length].repeat(64);
  const decisionHash = HEX[ordinal % HEX.length].repeat(64);
  const eventKey = `simulator-test:${ordinal}`;
  return {
    version: 1,
    schema: "narrative_trade_signal_v1",
    deterministic: true,
    decision: "do",
    score: 92,
    event: { eventKey },
    target: { chainId: 56, ca: CA, poolAddress: POOL },
    execution: {
      automaticExecution: false,
      networkAccess: false,
      signing: false,
      broadcast: false,
    },
    hardBlocks: [],
    shadowOrder: {
      mode: "shadow",
      executable: false,
      side: "buy",
      chainId: 56,
      ca: CA,
      poolAddress: POOL,
      assetKey: `eip155:56/erc20:${CA}`,
      notionalUsd: 25,
      maxSlippageBps: 300,
      simulatedAt: new Date(START).toISOString(),
      signalInputHash: inputHash,
    },
    inputHash,
    decisionHash,
  };
}

function offchainProof(value) {
  return {
    eventKey: value.event.eventKey,
    chainId: 56,
    contentDigest: value.inputHash,
    observedAt: value.shadowOrder.simulatedAt,
  };
}

function onchainProof(value, blockNumber = 5) {
  return {
    eventKey: value.event.eventKey,
    stableEventKey: value.event.eventKey,
    chainId: 56,
    blockNumber,
    blockHash: `0x${"5".repeat(64)}`,
    transactionHash: `0x${"6".repeat(64)}`,
    logIndex: 1,
    observedAt: value.shadowOrder.simulatedAt,
  };
}

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function ledgerAt(t, now, options = {}) {
  const dataDir = options.dataDir || await temporaryDirectory(t, "narrative-shadow-simulator-");
  const ledger = createNarrativeShadowLedger({
    dataDir,
    now,
    entryTtlMs: options.entryTtlMs || 60_000,
    integrityVerifier: () => true,
    compactEvery: options.compactEvery || 1_000,
  });
  await ledger.ready;
  return { ledger, dataDir };
}

function fixtureProvider({ now, entry, mark, canonical } = {}) {
  const calls = { entry: [], mark: [], canonical: [] };
  const providerId = "fixture.market.v1";
  const currentIso = () => new Date(now()).toISOString();
  const defaultQuote = (request, kind, blockNumber) => ({
    status: "ok",
    providerId,
    kind,
    side: kind === "entry" ? "buy" : "sell",
    marketExecutable: true,
    chainId: request.chainId,
    ca: request.ca,
    poolAddress: request.poolAddress,
    blockNumber,
    blockHash: `0x${(blockNumber % 10).toString(16).repeat(64)}`,
    blockTimestamp: currentIso(),
    observedAt: currentIso(),
    validUntil: new Date(now() + 5_000).toISOString(),
    valueUsdMicros: kind === "entry" ? request.valueUsdMicros : "25000000",
    quantityRaw: kind === "entry" ? `${blockNumber}000000000000000000` : request.quantityRaw,
    priceUsdMicros: "25000000",
    estimatedSlippageBps: 50,
    routeDigest: "7".repeat(64),
  });
  const provider = {
    providerId,
    trusted: true,
    readOnly: true,
    getEntryQuote: async (request, options) => {
      calls.entry.push(request);
      const fallback = defaultQuote(request, "entry", 10 + calls.entry.length);
      return entry ? entry(request, fallback, calls, options) : fallback;
    },
    getPositionMark: async (request, options) => {
      calls.mark.push(request);
      const fallback = defaultQuote(request, "mark", 100 + calls.mark.length);
      return mark ? mark(request, fallback, calls, options) : fallback;
    },
    checkCanonicalBlock: async (request, options) => {
      calls.canonical.push(request);
      const fallback = {
        status: "ok",
        providerId,
        chainId: request.chainId,
        blockNumber: request.blockNumber,
        blockHash: request.expectedBlockHash,
        observedAt: currentIso(),
      };
      return canonical ? canonical(request, fallback, calls, options) : fallback;
    },
  };
  return { provider, calls };
}

function simulatorConfig(overrides = {}) {
  return {
    narrativeShadowSimulatorEnabled: true,
    narrativeShadowSimulatorAutoStart: false,
    narrativeShadowMarkIntervalMs: 1_000,
    narrativeShadowQuoteMaxAgeMs: 30_000,
    narrativeShadowQuoteBlockMaxAgeMs: 30_000,
    narrativeShadowQuoteMaxValidityMs: 10_000,
    narrativeShadowTakeProfitBps: 2_000,
    narrativeShadowStopLossBps: 1_000,
    narrativeShadowTimeStopMs: 2_000,
    ...overrides,
  };
}

test("construction is default-off and accepts only the exact trusted read-only provider surface", async (t) => {
  let nowMs = START;
  const { ledger } = await ledgerAt(t, () => nowMs);
  const { provider } = fixtureProvider({ now: () => nowMs });
  assert.throws(
    () => createNarrativeShadowSimulator({}, { ledger, quoteProvider: provider }),
    /only be created when explicitly enabled/u,
  );
  assert.throws(
    () => createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: { ...provider, trusted: false },
    }),
    /explicitly trusted/u,
  );
  assert.throws(
    () => createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: { ...provider, extraCapability: () => {} },
    }),
    /only the trusted read-only/u,
  );
  await ledger.stop();
});

test("a fresh market-executable entry quote opens only a non-executable shadow position", async (t) => {
  let nowMs = START;
  const { ledger } = await ledgerAt(t, () => nowMs);
  const candidate = signal(0);
  const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
  const { provider, calls } = fixtureProvider({ now: () => nowMs });
  const simulator = createNarrativeShadowSimulator(simulatorConfig(), { ledger, quoteProvider: provider, now: () => nowMs });

  const cycle = await simulator.check();
  const order = await ledger.getOrder(admitted.orderId);
  assert.equal(cycle.status, "healthy");
  assert.deepEqual(cycle.actions.map((item) => item.type), ["opened"]);
  assert.equal(cycle.actions[0].mode, "shadow");
  assert.equal(cycle.actions[0].executable, false);
  assert.equal(order.status, "open");
  assert.equal(order.entry.valueUsdMicros, "25000000");
  assert.equal(calls.entry.length, 1);
  assert.equal(calls.entry[0].mode, "shadow");
  assert.equal(calls.entry[0].executable, false);
  assert.equal(calls.entry[0].chainId, 56);
  assert.equal(calls.entry[0].ca, CA);
  assert.equal(calls.entry[0].poolAddress, POOL);
  assert.equal(calls.entry[0].valueUsdMicros, "25000000");
  const state = await simulator.getState();
  const metrics = await simulator.getMetrics();
  assert.equal(state.schema, NARRATIVE_SHADOW_SIMULATOR_SCHEMA);
  assert.equal(state.executable, false);
  assert.equal(state.ledger.orders[admitted.orderId].status, "open");
  assert.equal(metrics.simulator.opened, 1);
  assert.equal(metrics.ledger.counts.open, 1);
  await simulator.stop();
  await ledger.stop();
});

test("quotes that become stale during canonical verification never mutate the ledger", async (t) => {
  await t.test("entry expires before open", async (subtest) => {
    let nowMs = START;
    const { ledger } = await ledgerAt(subtest, () => nowMs);
    const candidate = signal(0);
    const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
    const { provider } = fixtureProvider({
      now: () => nowMs,
      canonical: (request, response) => {
        if (request.blockNumber >= 11) nowMs += 6_000;
        return response;
      },
    });
    const simulator = createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: provider,
      now: () => nowMs,
    });

    const before = (await ledger.getState()).journalRevision;
    const cycle = await simulator.check();
    const order = await ledger.getOrder(admitted.orderId);
    assert.deepEqual(cycle.actions.map((item) => item.type), ["blocked"]);
    assert.match(cycle.actions[0].reason, /expired before ledger mutation/u);
    assert.equal(order.status, "created");
    assert.equal((await ledger.getState()).journalRevision, before);
    assert.equal((await simulator.getMetrics()).simulator.staleRejected, 1);
    await simulator.stop();
    await ledger.stop();
  });

  await t.test("mark expires before mark or close", async (subtest) => {
    let nowMs = START;
    const { ledger } = await ledgerAt(subtest, () => nowMs);
    const candidate = signal(1);
    const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
    const { provider } = fixtureProvider({
      now: () => nowMs,
      canonical: (request, response) => {
        if (request.blockNumber >= 100) nowMs += 6_000;
        return response;
      },
    });
    const simulator = createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: provider,
      now: () => nowMs,
    });

    assert.deepEqual((await simulator.check()).actions.map((item) => item.type), ["opened"]);
    const before = (await ledger.getState()).journalRevision;
    const cycle = await simulator.check();
    const order = await ledger.getOrder(admitted.orderId);
    assert.deepEqual(cycle.actions.map((item) => item.type), ["blocked"]);
    assert.match(cycle.actions[0].reason, /expired before ledger mutation/u);
    assert.equal(order.status, "open");
    assert.equal(order.marks.length, 0);
    assert.equal((await ledger.getState()).journalRevision, before);
    assert.equal((await simulator.getMetrics()).simulator.staleRejected, 1);
    await simulator.stop();
    await ledger.stop();
  });
});

test("unknown, stale, identity-mismatched, and non-executable quotes never mutate admission", async (t) => {
  const cases = [
    {
      name: "unknown",
      change: () => ({ status: "unknown", reason: "route unavailable" }),
      metric: "unknownRejected",
    },
    {
      name: "stale",
      change: (_request, quote) => ({
        ...quote,
        blockTimestamp: new Date(START - 60_000).toISOString(),
        observedAt: new Date(START - 60_000).toISOString(),
        validUntil: new Date(START + 1_000).toISOString(),
      }),
      metric: "staleRejected",
    },
    {
      name: "wrong pool",
      change: (_request, quote) => ({ ...quote, poolAddress: "0xc001000000000000000000000000000000000001" }),
      metric: "identityRejected",
    },
    {
      name: "not executable",
      change: (_request, quote) => ({ ...quote, marketExecutable: false }),
      metric: "quoteRejected",
    },
  ];
  for (const [ordinal, scenario] of cases.entries()) {
    await t.test(scenario.name, async (subtest) => {
      let nowMs = START;
      const { ledger } = await ledgerAt(subtest, () => nowMs);
      const candidate = signal(ordinal);
      const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
      const { provider } = fixtureProvider({ now: () => nowMs, entry: scenario.change });
      const simulator = createNarrativeShadowSimulator(simulatorConfig(), { ledger, quoteProvider: provider, now: () => nowMs });
      const before = (await ledger.getState()).journalRevision;
      const cycle = await simulator.check();
      const after = await ledger.getState();
      assert.equal(after.journalRevision, before);
      assert.equal(after.orders[admitted.orderId].status, "created");
      assert.deepEqual(cycle.actions.map((item) => item.type), ["blocked"]);
      assert.equal(cycle.status, "degraded");
      assert.equal((await simulator.getMetrics()).simulator[scenario.metric], 1);
      await simulator.stop();
      await ledger.stop();
    });
  }
});

test("entry and mark evidence cannot travel backward across the signal lifecycle", async (t) => {
  await t.test("entry quote block cannot precede an on-chain signal", async (subtest) => {
    let nowMs = START;
    const { ledger } = await ledgerAt(subtest, () => nowMs);
    const candidate = signal(0);
    const admitted = await ledger.admit(candidate, { sourceProof: onchainProof(candidate, 20) });
    const { provider } = fixtureProvider({
      now: () => nowMs,
      entry: (_request, quote) => ({
        ...quote,
        blockNumber: 19,
        blockHash: `0x${"9".repeat(64)}`,
      }),
    });
    const simulator = createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: provider,
      now: () => nowMs,
    });
    const before = (await ledger.getState()).journalRevision;
    const cycle = await simulator.check();
    assert.equal(cycle.status, "degraded");
    assert.match(cycle.actions[0].reason, /precedes the on-chain signal/u);
    assert.equal((await ledger.getState()).journalRevision, before);
    assert.equal((await ledger.getOrder(admitted.orderId)).status, "created");
    assert.equal((await simulator.getMetrics()).simulator.staleRejected, 1);
    await simulator.stop();
    await ledger.stop();
  });

  await t.test("entry observation cannot precede its source evidence", async (subtest) => {
    let nowMs = START + 1_000;
    const { ledger } = await ledgerAt(subtest, () => nowMs);
    const candidate = signal(1);
    const proof = { ...offchainProof(candidate), observedAt: new Date(nowMs + 1_000).toISOString() };
    const admitted = await ledger.admit(candidate, { sourceProof: proof });
    const { provider } = fixtureProvider({
      now: () => nowMs,
      entry: (_request, quote) => ({
        ...quote,
        blockTimestamp: new Date(nowMs).toISOString(),
        observedAt: new Date(nowMs + 500).toISOString(),
      }),
    });
    const simulator = createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: provider,
      now: () => nowMs,
    });
    const before = (await ledger.getState()).journalRevision;
    const cycle = await simulator.check();
    assert.equal(cycle.status, "degraded");
    assert.match(cycle.actions[0].reason, /observation precedes the source signal/u);
    assert.equal((await ledger.getState()).journalRevision, before);
    assert.equal((await ledger.getOrder(admitted.orderId)).status, "created");
    await simulator.stop();
    await ledger.stop();
  });

  await t.test("entry block time cannot precede shadow admission", async (subtest) => {
    let nowMs = START;
    const { ledger } = await ledgerAt(subtest, () => nowMs);
    const candidate = signal(2);
    const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
    const { provider } = fixtureProvider({
      now: () => nowMs,
      entry: (_request, quote) => ({
        ...quote,
        blockTimestamp: new Date(START - 1).toISOString(),
      }),
    });
    const simulator = createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: provider,
      now: () => nowMs,
    });
    const before = (await ledger.getState()).journalRevision;
    const cycle = await simulator.check();
    assert.equal(cycle.status, "degraded");
    assert.match(cycle.actions[0].reason, /block time precedes shadow admission/u);
    assert.equal((await ledger.getState()).journalRevision, before);
    assert.equal((await ledger.getOrder(admitted.orderId)).status, "created");
    await simulator.stop();
    await ledger.stop();
  });

  await t.test("same-block entry evidence must match the source block hash", async (subtest) => {
    let nowMs = START;
    const { ledger } = await ledgerAt(subtest, () => nowMs);
    const candidate = signal(2);
    const admitted = await ledger.admit(candidate, { sourceProof: onchainProof(candidate, 11) });
    const { provider } = fixtureProvider({ now: () => nowMs });
    const simulator = createNarrativeShadowSimulator(simulatorConfig(), {
      ledger,
      quoteProvider: provider,
      now: () => nowMs,
    });
    const before = (await ledger.getState()).journalRevision;
    const cycle = await simulator.check();
    assert.equal(cycle.status, "degraded");
    assert.match(cycle.actions[0].reason, /conflicts with the on-chain signal block/u);
    assert.equal((await ledger.getState()).journalRevision, before);
    assert.equal((await ledger.getOrder(admitted.orderId)).status, "created");
    assert.equal((await simulator.getMetrics()).simulator.identityRejected, 1);
    await simulator.stop();
    await ledger.stop();
  });

  const markCases = [
    {
      name: "mark block cannot precede entry block",
      mutate: (_request, quote) => ({
        ...quote,
        blockNumber: 10,
        blockHash: `0x${"0".repeat(63)}1`,
      }),
      reason: /block precedes the shadow entry/u,
    },
    {
      name: "mark block time cannot precede entry observation",
      mutate: (_request, quote) => ({
        ...quote,
        blockTimestamp: new Date(START - 1).toISOString(),
      }),
      reason: /block time precedes the shadow entry/u,
    },
    {
      name: "same-block mark evidence must match the entry block hash",
      mutate: (_request, quote) => ({
        ...quote,
        blockNumber: 11,
        blockHash: `0x${"2".repeat(64)}`,
      }),
      reason: /conflicts with the shadow entry block/u,
      metric: "identityRejected",
    },
  ];
  for (const [index, scenario] of markCases.entries()) {
    await t.test(scenario.name, async (subtest) => {
      let nowMs = START;
      const { ledger } = await ledgerAt(subtest, () => nowMs);
      const candidate = signal(index + 1);
      const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
      const { provider } = fixtureProvider({ now: () => nowMs, mark: scenario.mutate });
      const simulator = createNarrativeShadowSimulator(simulatorConfig({
        narrativeShadowTimeStopMs: 60_000,
      }), { ledger, quoteProvider: provider, now: () => nowMs });
      await simulator.check();
      const opened = await ledger.getOrder(admitted.orderId);
      assert.equal(opened.status, "open");
      const revisionAfterEntry = (await ledger.getState()).journalRevision;
      nowMs += 1_000;
      const cycle = await simulator.check();
      assert.equal(cycle.status, "degraded");
      assert.match(cycle.actions[0].reason, scenario.reason);
      assert.equal((await ledger.getState()).journalRevision, revisionAfterEntry);
      assert.equal((await ledger.getOrder(admitted.orderId)).marks.length, 0);
      const metric = scenario.metric || "staleRejected";
      assert.equal((await simulator.getMetrics()).simulator[metric], 1);
      await simulator.stop();
      await ledger.stop();
    });
  }
});

test("active orders cannot be starved by an older terminal history", async (t) => {
  let nowMs = START;
  const { ledger: sourceLedger } = await ledgerAt(t, () => nowMs);
  const candidate = signal(0);
  const admitted = await sourceLedger.admit(candidate, { sourceProof: offchainProof(candidate) });
  const active = await sourceLedger.getOrder(admitted.orderId);
  const terminals = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
    const orderId = `shadow:${(index + 1000).toString(16).padStart(64, "0")}`;
    return [orderId, {
      orderId,
      status: "closed",
      performanceEligible: true,
      createdAt: new Date(START - 100_000 + index).toISOString(),
      sourceProof: { kind: "offchain" },
      entry: null,
      latestMark: null,
      exit: null,
    }];
  }));
  let openedOrderId = null;
  const ledger = {
    ready: Promise.resolve(),
    getState: async () => ({ orders: { ...terminals, [active.orderId]: active } }),
    getOrder: async () => active,
    open: async (orderId) => {
      openedOrderId = orderId;
      return { orderId, status: "open", revision: 1, persisted: true, duplicate: false };
    },
    mark: async () => { throw new Error("unexpected mark"); },
    close: async () => { throw new Error("unexpected close"); },
    expire: async () => { throw new Error("unexpected expiry"); },
    invalidate: async () => { throw new Error("unexpected invalidation"); },
    getMetrics: async () => ({ counts: { created: 1 } }),
  };
  const { provider, calls } = fixtureProvider({ now: () => nowMs });
  const simulator = createNarrativeShadowSimulator(simulatorConfig({
    narrativeShadowMaxOrdersPerCycle: 1,
    narrativeShadowTerminalAuditPerCycle: 1,
  }), { ledger, quoteProvider: provider, now: () => nowMs });
  const cycle = await simulator.check();
  assert.equal(openedOrderId, active.orderId);
  assert.equal(calls.entry.length, 1);
  assert.equal(cycle.actions[0].type, "opened");
  await simulator.stop();
  await sourceLedger.stop();
});

test("provider deadline bounds a never-resolving call and stop drains to a fail-closed result", async (t) => {
  let nowMs = START;
  let providerSignal = null;
  const { ledger } = await ledgerAt(t, () => nowMs);
  const candidate = signal(0);
  const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
  const { provider } = fixtureProvider({
    now: () => nowMs,
    entry: (_request, _fallback, _calls, options) => {
      providerSignal = options.signal;
      return new Promise(() => {});
    },
  });
  const simulator = createNarrativeShadowSimulator(simulatorConfig({
    narrativeShadowProviderTimeoutMs: 20,
  }), { ledger, quoteProvider: provider, now: () => nowMs });
  const checking = simulator.check();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = simulator.stop();
  const [cycle] = await Promise.race([
    Promise.all([checking, stopping]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("worker failed to drain")), 500)),
  ]);
  assert.equal(cycle.status, "degraded");
  assert.deepEqual(cycle.actions.map((item) => item.type), ["blocked"]);
  assert.match(cycle.actions[0].reason, /deadline exceeded/u);
  assert.equal(providerSignal?.aborted, true);
  assert.equal((await ledger.getOrder(admitted.orderId)).status, "created");
  const metrics = await simulator.getMetrics();
  assert.equal(metrics.simulator.providerTimeouts, 1);
  assert.equal(metrics.simulator.providerErrors, 1);
  await ledger.stop();
});

test("a quote that expires while its provider call is resolving is rejected using the fresh clock", async (t) => {
  let nowMs = START;
  const { ledger } = await ledgerAt(t, () => nowMs);
  const candidate = signal(0);
  const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
  const { provider } = fixtureProvider({
    now: () => nowMs,
    entry: (_request, quote) => {
      nowMs += 6_000;
      return quote;
    },
  });
  const simulator = createNarrativeShadowSimulator(simulatorConfig(), { ledger, quoteProvider: provider, now: () => nowMs });
  const cycle = await simulator.check();
  assert.equal(cycle.status, "degraded");
  assert.equal(cycle.actions[0].type, "blocked");
  assert.match(cycle.actions[0].reason, /validity window/u);
  assert.equal((await ledger.getOrder(admitted.orderId)).status, "created");
  assert.equal((await simulator.getMetrics()).simulator.staleRejected, 1);
  await simulator.stop();
  await ledger.stop();
});

test("fresh periodic marks deterministically take profit, stop loss, and time stop", async (t) => {
  let nowMs = START;
  const { ledger } = await ledgerAt(t, () => nowMs);
  const admitted = [];
  for (let ordinal = 0; ordinal < 3; ordinal += 1) {
    const candidate = signal(ordinal);
    admitted.push(await ledger.admit(candidate, { sourceProof: offchainProof(candidate) }));
  }
  const exitValues = new Map([
    [admitted[0].orderId, "30000000"],
    [admitted[1].orderId, "22000000"],
    [admitted[2].orderId, "25000000"],
  ]);
  const { provider } = fixtureProvider({
    now: () => nowMs,
    mark: (request, quote) => ({ ...quote, valueUsdMicros: exitValues.get(request.orderId) }),
  });
  const simulator = createNarrativeShadowSimulator(simulatorConfig(), { ledger, quoteProvider: provider, now: () => nowMs });
  const entries = await simulator.check();
  assert.deepEqual(entries.actions.map((item) => item.type), ["opened", "opened", "opened"]);

  nowMs += 3_000;
  const exits = await simulator.check();
  assert.deepEqual(exits.actions.map((item) => item.type), ["closed", "closed", "closed"]);
  const orders = await Promise.all(admitted.map((item) => ledger.getOrder(item.orderId)));
  assert.deepEqual(orders.map((order) => order.exitReason), ["take_profit", "stop_loss", "time_stop"]);
  assert.ok(orders.every((order) => order.marks.length === 1));
  assert.ok(exits.actions.every((item) => item.executable === false));
  const metrics = await simulator.getMetrics();
  assert.equal(metrics.simulator.marked, 3);
  assert.equal(metrics.simulator.closed, 3);
  assert.equal(metrics.ledger.wins, 1);
  assert.equal(metrics.ledger.losses, 1);
  assert.equal(metrics.ledger.scratches, 1);
  await simulator.stop();
  await ledger.stop();
});

test("a canonical hash change invalidates an open sample and prevents further marks", async (t) => {
  let nowMs = START;
  let reorgSource = false;
  const { ledger } = await ledgerAt(t, () => nowMs);
  const candidate = signal(0);
  const admitted = await ledger.admit(candidate, { sourceProof: onchainProof(candidate) });
  const { provider, calls } = fixtureProvider({
    now: () => nowMs,
    canonical: (request, response) => (
      reorgSource && request.blockNumber === 5
        ? { ...response, blockHash: `0x${"9".repeat(64)}` }
        : response
    ),
  });
  const simulator = createNarrativeShadowSimulator(simulatorConfig(), { ledger, quoteProvider: provider, now: () => nowMs });
  await simulator.check();
  assert.equal((await ledger.getOrder(admitted.orderId)).status, "open");
  assert.equal(calls.mark.length, 0);

  reorgSource = true;
  nowMs += 1_000;
  const cycle = await simulator.check();
  const order = await ledger.getOrder(admitted.orderId);
  assert.equal(order.status, "invalidated");
  assert.equal(order.terminalReason, "source_reorg");
  assert.equal(order.performanceEligible, false);
  assert.equal(calls.mark.length, 0);
  assert.deepEqual(cycle.actions.map((item) => item.type), ["invalidated"]);
  assert.equal((await simulator.getMetrics()).ledger.invalidated, 1);
  await simulator.stop();
  await ledger.stop();
});

test("restart replay is idempotent when the provider repeats the same mark block", async (t) => {
  let nowMs = START;
  const dataDir = await temporaryDirectory(t, "narrative-shadow-simulator-restart-");
  const firstLedger = (await ledgerAt(t, () => nowMs, { dataDir })).ledger;
  const candidate = signal(0);
  const admitted = await firstLedger.admit(candidate, { sourceProof: offchainProof(candidate) });
  const firstProvider = fixtureProvider({ now: () => nowMs }).provider;
  const first = createNarrativeShadowSimulator(simulatorConfig(), {
    ledger: firstLedger,
    quoteProvider: firstProvider,
    now: () => nowMs,
  });
  await first.check();
  await first.stop();
  await firstLedger.stop();

  nowMs += 1_000;
  const repeatedMark = (request, quote) => ({
    ...quote,
    blockNumber: 101,
    blockHash: `0x${"1".repeat(64)}`,
    quantityRaw: request.quantityRaw,
    valueUsdMicros: "25500000",
    blockTimestamp: new Date(nowMs).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs + 5_000).toISOString(),
  });
  const secondLedger = (await ledgerAt(t, () => nowMs, { dataDir })).ledger;
  const second = createNarrativeShadowSimulator(simulatorConfig({ narrativeShadowTimeStopMs: 60_000 }), {
    ledger: secondLedger,
    quoteProvider: fixtureProvider({ now: () => nowMs, mark: repeatedMark }).provider,
    now: () => nowMs,
  });
  await second.check();
  const revisionAfterFirstMark = (await secondLedger.getState()).journalRevision;
  await second.stop();
  await secondLedger.stop();

  const thirdLedger = (await ledgerAt(t, () => nowMs, { dataDir })).ledger;
  const third = createNarrativeShadowSimulator(simulatorConfig({ narrativeShadowTimeStopMs: 60_000 }), {
    ledger: thirdLedger,
    quoteProvider: fixtureProvider({ now: () => nowMs, mark: repeatedMark }).provider,
    now: () => nowMs,
  });
  const replay = await third.check();
  assert.equal(replay.actions[0].type, "marked");
  assert.equal(replay.actions[0].duplicate, true);
  assert.equal((await thirdLedger.getState()).journalRevision, revisionAfterFirstMark);
  assert.equal((await thirdLedger.getOrder(admitted.orderId)).marks.length, 1);
  assert.equal((await third.getMetrics()).simulator.marked, 0);
  await third.stop();
  await thirdLedger.stop();
});

test("check is single-flight and stop drains an accepted in-flight quote without owning the ledger", async (t) => {
  let nowMs = START;
  const { ledger } = await ledgerAt(t, () => nowMs);
  const candidate = signal(0);
  const admitted = await ledger.admit(candidate, { sourceProof: offchainProof(candidate) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fallbackQuote;
  const { provider, calls } = fixtureProvider({
    now: () => nowMs,
    entry: async (_request, fallback) => {
      fallbackQuote = fallback;
      await gate;
      return fallbackQuote;
    },
  });
  const simulator = createNarrativeShadowSimulator(simulatorConfig(), { ledger, quoteProvider: provider, now: () => nowMs });
  const first = simulator.check();
  const second = simulator.check();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.entry.length, 1);

  let drained = false;
  const stopping = simulator.stop().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await stopping;
  assert.equal(drained, true);
  assert.equal((await ledger.getOrder(admitted.orderId)).status, "open");
  assert.equal((await simulator.getMetrics()).simulator.singleFlightJoins, 1);
  assert.equal((await ledger.getState()).orders[admitted.orderId].status, "open", "the worker did not stop its shared ledger");
  await ledger.stop();
});

test("the simulator source contains no account, signing, transaction-send, or exchange dependency", async () => {
  const source = await fs.readFile(new URL("../src/narrative-shadow-simulator.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:ethers|viem|web3)\b|privateKey|mnemonic|sendTransaction|sendRawTransaction|eth_send|\bswap\b|\bWallet\b/u);
  assert.match(source, /executable:\s*false/gu);
});
