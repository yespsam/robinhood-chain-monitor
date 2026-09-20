import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createNarrativeShadowLedger,
  NARRATIVE_SHADOW_LEDGER_SCHEMA,
} from "../src/narrative-shadow-ledger.js";

const CA = "0xa11ce00000000000000000000000000000000001";
const POOL = "0xb001000000000000000000000000000000000001";
const START = Date.parse("2026-09-06T08:05:00.000Z");

function tradeSignal(ordinal, overrides = {}) {
  const inputHash = String((ordinal % 8) + 1).repeat(64);
  const decisionHash = String.fromCharCode(97 + (ordinal % 6)).repeat(64);
  const eventKey = `shadow-test:${ordinal}`;
  const base = {
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
  return {
    ...base,
    ...overrides,
    event: { ...base.event, ...(overrides.event || {}) },
    target: { ...base.target, ...(overrides.target || {}) },
    execution: { ...base.execution, ...(overrides.execution || {}) },
    shadowOrder: { ...base.shadowOrder, ...(overrides.shadowOrder || {}) },
  };
}

function proof(signal, overrides = {}) {
  return {
    eventKey: signal.event.eventKey,
    chainId: signal.shadowOrder.chainId,
    contentDigest: signal.inputHash,
    observedAt: signal.shadowOrder.simulatedAt,
    ...overrides,
  };
}

function price(blockNumber, valueUsdMicros, quantityRaw = "1000000000000000000", overrides = {}) {
  const nibble = (blockNumber % 15).toString(16);
  return {
    blockNumber,
    blockHash: `0x${nibble.repeat(64)}`,
    valueUsdMicros,
    quantityRaw,
    observedAt: new Date(START + blockNumber * 1_000).toISOString(),
    ...overrides,
  };
}

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("shadow lifecycle persists integer quotes and recomputes PnL, win rate, unrealized value, and drawdown", async (t) => {
  const dataDir = await temporaryDirectory(t, "narrative-shadow-ledger-lifecycle-");
  let nowMs = START;
  const ledger = createNarrativeShadowLedger({
    dataDir,
    now: () => nowMs,
    integrityVerifier: () => ({ valid: true, reasons: [] }),
    entryTtlMs: 60_000,
  });
  await ledger.ready;

  const admitAndOpen = async (ordinal, entryBlock) => {
    const signal = tradeSignal(ordinal);
    const admitted = await ledger.admit(signal, { sourceProof: proof(signal) });
    nowMs = START + entryBlock * 1_000;
    await ledger.open(admitted.orderId, price(entryBlock, "25000000"));
    return admitted.orderId;
  };

  const win = await admitAndOpen(0, 1);
  nowMs = START + 2_000;
  await ledger.close(win, price(2, "30000000"), { reason: "take_profit" });

  const loss = await admitAndOpen(1, 3);
  nowMs = START + 4_000;
  await ledger.close(loss, price(4, "20000000"), { reason: "stop_loss" });

  const scratch = await admitAndOpen(2, 5);
  nowMs = START + 6_000;
  await ledger.close(scratch, price(6, "25000000"), { reason: "time_stop" });

  const expiringSignal = tradeSignal(3);
  nowMs = START + 7_000;
  const expiring = await ledger.admit(expiringSignal, { sourceProof: proof(expiringSignal) });
  nowMs += 60_000;
  await ledger.expire(expiring.orderId);

  const invalidSignal = tradeSignal(4);
  const invalid = await ledger.admit(invalidSignal, { sourceProof: proof(invalidSignal) });
  await ledger.invalidate(invalid.orderId, { reason: "source_reorg" });

  const open = await admitAndOpen(5, 70);
  nowMs = START + 71_000;
  await ledger.mark(open, price(71, "30000000"));

  const state = await ledger.getState();
  const metrics = await ledger.metrics();
  assert.equal(state.schema, NARRATIVE_SHADOW_LEDGER_SCHEMA);
  assert.equal(state.orders[win].entry.valueUsdMicros, "25000000");
  assert.equal(state.orders[open].latestMark.quantityRaw, "1000000000000000000");
  assert.deepEqual(metrics.counts, { created: 0, open: 1, closed: 3, expired: 1, invalidated: 1 });
  assert.equal(metrics.wins, 1);
  assert.equal(metrics.losses, 1);
  assert.equal(metrics.scratches, 1);
  assert.equal(metrics.winRateBps, 5_000);
  assert.equal(metrics.realizedPnlUsdMicros, "0");
  assert.equal(metrics.unrealizedPnlUsdMicros, "5000000");
  assert.equal(metrics.maxDrawdownUsdMicros, "5000000");
  assert.equal(metrics.expired, 1);
  assert.equal(metrics.invalidated, 1);
  await ledger.stop();
});

test("admission is durable and idempotent while integrity, execution, policy, and payload conflicts fail closed", async (t) => {
  const dataDir = await temporaryDirectory(t, "narrative-shadow-ledger-admit-");
  let verification = { valid: true, reasons: [] };
  const ledger = createNarrativeShadowLedger({
    dataDir,
    now: () => START,
    integrityVerifier: () => verification,
  });
  await ledger.ready;
  const signal = tradeSignal(0);
  const first = await ledger.admit(signal, { sourceProof: proof(signal) });
  const replay = await ledger.admit(signal, { sourceProof: proof(signal) });
  assert.equal(first.persisted, true);
  assert.equal(replay.orderId, first.orderId);
  assert.equal(replay.duplicate, true);
  assert.equal((await ledger.getState()).journalRevision, 1);

  await assert.rejects(
    ledger.admit(signal, { sourceProof: proof(signal, { contentDigest: "f".repeat(64) }) }),
    /idempotency conflict/u,
  );
  await assert.rejects(
    ledger.admit(tradeSignal(1, { shadowOrder: { notionalUsd: 101 } }), { sourceProof: proof(tradeSignal(1)) }),
    /at most 100 USD/u,
  );
  await assert.rejects(
    ledger.admit(tradeSignal(2, { shadowOrder: { executable: true } }), { sourceProof: proof(tradeSignal(2)) }),
    /non-executable shadow buy/u,
  );
  await assert.rejects(
    ledger.admit(tradeSignal(3, { execution: { signing: true } }), { sourceProof: proof(tradeSignal(3)) }),
    /execution capability/u,
  );
  verification = { valid: false, reasons: ["decision_hash_mismatch"] };
  const untrusted = tradeSignal(4);
  await assert.rejects(
    ledger.admit(untrusted, { sourceProof: proof(untrusted) }),
    /integrity verification failed/u,
  );
  assert.equal((await ledger.getState()).journalRevision, 1);
  await ledger.stop();
});

test("restart replays a checksummed WAL and truncates only an incomplete tail", async (t) => {
  const dataDir = await temporaryDirectory(t, "narrative-shadow-ledger-torn-");
  const options = {
    dataDir,
    now: () => START,
    integrityVerifier: () => true,
    compactEvery: 1_000,
  };
  const first = createNarrativeShadowLedger(options);
  await first.ready;
  const signal = tradeSignal(0);
  const admitted = await first.admit(signal, { sourceProof: proof(signal) });
  const walFile = path.join(dataDir, "narrative-shadow-ledger.json.wal");
  const completeSize = (await fs.stat(walFile)).size;
  await fs.appendFile(walFile, "{\"torn\"");

  const restarted = createNarrativeShadowLedger(options);
  await restarted.ready;
  assert.equal((await restarted.getOrder(admitted.orderId)).status, "created");
  assert.equal((await fs.stat(walFile)).size, completeSize);
  assert.equal((await restarted.getState()).journalRevision, 1);
  await restarted.stop();
});

test("middle-frame checksum damage and WAL revision gaps fail startup closed", async (t) => {
  const corruptDir = await temporaryDirectory(t, "narrative-shadow-ledger-corrupt-");
  const options = { now: () => START, integrityVerifier: () => true, compactEvery: 1_000 };
  const corrupt = createNarrativeShadowLedger({ ...options, dataDir: corruptDir });
  await corrupt.ready;
  const one = tradeSignal(0);
  await corrupt.admit(one, { sourceProof: proof(one) });
  const corruptWal = path.join(corruptDir, "narrative-shadow-ledger.json.wal");
  const [line] = (await fs.readFile(corruptWal, "utf8")).trimEnd().split("\n");
  const frame = JSON.parse(line);
  frame.sha256 = "0".repeat(64);
  await fs.writeFile(corruptWal, `${JSON.stringify(frame)}\n`);
  const corruptRestart = createNarrativeShadowLedger({ ...options, dataDir: corruptDir });
  await assert.rejects(corruptRestart.ready, /checksum mismatch/u);

  const gapDir = await temporaryDirectory(t, "narrative-shadow-ledger-gap-");
  const gap = createNarrativeShadowLedger({ ...options, dataDir: gapDir });
  await gap.ready;
  const firstSignal = tradeSignal(0);
  const secondSignal = tradeSignal(1);
  await gap.admit(firstSignal, { sourceProof: proof(firstSignal) });
  await gap.admit(secondSignal, { sourceProof: proof(secondSignal) });
  const gapWal = path.join(gapDir, "narrative-shadow-ledger.json.wal");
  const lines = (await fs.readFile(gapWal, "utf8")).trimEnd().split("\n");
  await fs.writeFile(gapWal, `${lines[1]}\n`);
  const gapRestart = createNarrativeShadowLedger({ ...options, dataDir: gapDir });
  await assert.rejects(gapRestart.ready, /revision gap 0 -> 2/u);
});

function failOneAppendSync(fsImpl, walFile) {
  let fail = true;
  return {
    mkdir: (...args) => fsImpl.mkdir(...args),
    readFile: (...args) => fsImpl.readFile(...args),
    rename: (...args) => fsImpl.rename(...args),
    chmod: (...args) => fsImpl.chmod(...args),
    rm: (...args) => fsImpl.rm(...args),
    open: async (file, flags, mode) => {
      const handle = await fsImpl.open(file, flags, mode);
      return {
        stat: (...args) => handle.stat(...args),
        chmod: (...args) => handle.chmod(...args),
        writeFile: (...args) => handle.writeFile(...args),
        truncate: (...args) => handle.truncate(...args),
        sync: async () => {
          if (fail && String(file) === walFile && flags === "a") {
            fail = false;
            throw new Error("injected append fsync failure");
          }
          return handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
}

test("a pre-ack WAL fsync failure rolls back bytes and never advances visible state", async (t) => {
  const dataDir = await temporaryDirectory(t, "narrative-shadow-ledger-fsync-");
  const stateFile = path.join(dataDir, "ledger.json");
  const walFile = `${stateFile}.wal`;
  const ledger = createNarrativeShadowLedger({
    stateFile,
    now: () => START,
    fsImpl: failOneAppendSync(fs, walFile),
    integrityVerifier: () => true,
  });
  await ledger.ready;
  const signal = tradeSignal(0);
  await assert.rejects(
    ledger.admit(signal, { sourceProof: proof(signal) }),
    /injected append fsync failure/u,
  );
  assert.equal((await fs.stat(walFile)).size, 0);
  assert.equal((await ledger.getState()).journalRevision, 0);
  assert.deepEqual((await ledger.getState()).orders, {});

  const retry = await ledger.admit(signal, { sourceProof: proof(signal) });
  assert.equal(retry.status, "created");
  assert.equal(retry.persisted, true);
  await ledger.stop();
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(walFile)).mode & 0o777, 0o600);
});

test("illegal transitions and mismatched or non-integer price evidence are rejected without a revision", async (t) => {
  const dataDir = await temporaryDirectory(t, "narrative-shadow-ledger-transitions-");
  let nowMs = START;
  const ledger = createNarrativeShadowLedger({
    dataDir,
    now: () => nowMs,
    integrityVerifier: () => true,
    entryTtlMs: 1_000,
  });
  const signal = tradeSignal(0);
  const admitted = await ledger.admit(signal, { sourceProof: proof(signal) });
  await assert.rejects(ledger.mark(admitted.orderId, price(1, "25000000")), /cannot mark/u);
  await assert.rejects(
    ledger.open(admitted.orderId, price(1, 25_000_000)),
    /unsigned integer string/u,
  );
  await assert.rejects(
    ledger.open(admitted.orderId, price(1, "25000000", "1000", { ca: "0xc000000000000000000000000000000000000001" })),
    /target mismatch/u,
  );
  assert.equal((await ledger.getState()).journalRevision, 1);
  nowMs += 1_000;
  await assert.rejects(ledger.open(admitted.orderId, price(1, "25000000", "1000")), /entry window expired/u);
  await ledger.expire(admitted.orderId);
  await assert.rejects(ledger.close(admitted.orderId, price(2, "25000000", "1000")), /cannot close/u);
  assert.equal((await ledger.getOrder(admitted.orderId)).status, "expired");
  await ledger.stop();
});

test("a post-close source invalidation preserves evidence but removes the orphaned sample from performance", async (t) => {
  const dataDir = await temporaryDirectory(t, "narrative-shadow-ledger-invalidation-");
  let nowMs = START;
  const ledger = createNarrativeShadowLedger({ dataDir, now: () => nowMs, integrityVerifier: () => true });
  const signal = tradeSignal(0);
  const admitted = await ledger.admit(signal, { sourceProof: proof(signal) });
  nowMs += 1_000;
  await ledger.open(admitted.orderId, price(1, "25000000"));
  nowMs += 1_000;
  await ledger.close(admitted.orderId, price(2, "30000000"), { reason: "take_profit" });
  assert.equal((await ledger.metrics()).realizedPnlUsdMicros, "5000000");

  nowMs += 1_000;
  await ledger.invalidate(admitted.orderId, { reason: "entry_source_reorg" });
  const order = await ledger.getOrder(admitted.orderId);
  const metrics = await ledger.metrics();
  assert.equal(order.status, "invalidated");
  assert.equal(order.entry.valueUsdMicros, "25000000");
  assert.equal(order.exit.valueUsdMicros, "30000000");
  assert.equal(order.performanceEligible, false);
  assert.equal(metrics.realizedPnlUsdMicros, "0");
  assert.equal(metrics.eligibleClosed, 0);
  assert.equal(metrics.invalidated, 1);
  await ledger.stop();
});

test("the ledger source has no wallet, private-key, signing, or transaction-broadcast capability", async () => {
  const source = await fs.readFile(new URL("../src/narrative-shadow-ledger.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bWallet\b|privateKey|mnemonic|sendTransaction|eth_sendRawTransaction|eth_sendTransaction/iu);
});
