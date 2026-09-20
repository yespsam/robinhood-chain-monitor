import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { buildNarrativeShadowLifecycleDemo } from "../scripts/narrative-shadow-lifecycle-demo.js";

test("the offline shadow lifecycle demo opens, marks, exits, and reports deterministic PnL", async () => {
  const result = await buildNarrativeShadowLifecycleDemo();
  assert.equal(result.schema, "narrative_shadow_lifecycle_demo_v1");
  assert.equal(result.fixture, true);
  assert.equal(result.networkAccess, false);
  assert.equal(result.signing, false);
  assert.equal(result.broadcast, false);
  assert.deepEqual(result.entryCycle.actions.map((item) => item.type), ["opened"]);
  assert.deepEqual(result.exitCycle.actions.map((item) => item.type), ["closed"]);
  assert.equal(result.order.status, "closed");
  assert.equal(result.order.exitReason, "take_profit");
  assert.equal(result.order.entry.valueUsdMicros, "25000000");
  assert.equal(result.order.exit.valueUsdMicros, "31250000");
  assert.equal(result.metrics.ledger.realizedPnlUsdMicros, "6250000");
  assert.equal(result.metrics.ledger.winRateBps, 10_000);
  assert.deepEqual(result.metrics.ledger.counts, {
    created: 0,
    open: 0,
    closed: 1,
    expired: 0,
    invalidated: 0,
  });
});

test("the lifecycle demo source has no network, wallet, signing, or transaction-send capability", async () => {
  const source = await fs.readFile(new URL("../scripts/narrative-shadow-lifecycle-demo.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\b|JsonRpcProvider|\bWallet\b|privateKey|mnemonic|sendTransaction|eth_sendRawTransaction|eth_sendTransaction/iu);
});
