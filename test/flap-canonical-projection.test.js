import test from "node:test";
import assert from "node:assert/strict";
import { buildFlapCanonicalProjection, createFlapCanonicalProjectionWriter,
  FLAP_CANONICAL_PROJECTION_MAX_WINDOWS } from "../src/flap-canonical-projection.js";
import { launchEventDigest } from "../src/launch-event-identity.js";

const stateWith = (active = true, slots = [{ eventKey: "token-event", ordinal: 1,
  tokenAddress: "token", transactionHash: "tx", blockHash: "block", blockNumber: 2,
  transactionIndex: 1, logIndex: 3, event: { type: "test", security: { decision: "block" } } }]) => ({
  officialSources: { flap: { quotePoolFirstThree: {
    activeByQuote: active ? { quote: "generation" } : {},
    windows: { generation: { generationKey: "generation", quoteAddress: "quote",
      active, status: active ? "active" : "disabled", activationBlockNumber: 1,
      activationEventKey: "activation-event", slots, orphanedSlots: [{ eventKey: "orphan" }] } },
  } } },
});

test("Flap canonical projection is bounded, immutable-only, and excludes orphaned slots", () => {
  const state = stateWith();
  const projection = buildFlapCanonicalProjection(state);
  assert.equal(projection.windows.generation.active, true);
  assert.equal(projection.windows.generation.slots.length, 1);
  assert.equal(projection.windows.generation.slots[0].proofDigest,
    launchEventDigest(state.officialSources.flap.quotePoolFirstThree.windows.generation.slots[0].event));
  assert.equal(projection.windows.generation.slots[0].event, undefined);
  assert.equal(projection.windows.generation.orphanedSlots, undefined);
  delete state.officialSources.flap.quotePoolFirstThree.activeByQuote.quote;
  assert.equal(buildFlapCanonicalProjection(state).windows.generation.active, false);
  for (let i = 0; i < 400; i++) state.officialSources.flap.quotePoolFirstThree.windows[`old-${i}`] = {
    quoteAddress: `quote-${i}`, active: false, status: "disabled", activationBlockNumber: i, slots: [],
  };
  const bounded = buildFlapCanonicalProjection(state);
  assert.equal(Object.keys(bounded.windows).length, FLAP_CANONICAL_PROJECTION_MAX_WINDOWS);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 1024 * 1024);
});

test("Flap ownership invalidates before primary save and only publishes durable snapshots", async () => {
  const writes = [];
  const writer = createFlapCanonicalProjectionWriter({ file: "/fixture", now: () => 100,
    atomicWrite: async (_file, snapshot) => { writes.push(structuredClone(snapshot)); } });
  const before = stateWith();
  await writer.invalidate();
  await writer.afterSave(before);
  assert.equal(writes.at(-1).status, "ready");
  const revoked = stateWith(true, []);
  await writer.beforeSave(revoked);
  assert.equal(writes.at(-1).status, "updating", "primary save failure cannot reauthorize old slots");
  assert.deepEqual(writes.at(-1).windows, {});
  await writer.afterSave(revoked);
  assert.deepEqual(writes.at(-1).windows.generation.slots, []);
  const count = writes.length;
  assert.equal(writer.beforeSave(revoked), null);
  await writer.afterSave(revoked);
  assert.equal(writes.length, count, "unrelated health saves do not rewrite unchanged ownership");
});

test("Flap ownership projection publish failure leaves fail-closed tombstone and surfaces error", async () => {
  let published;
  const writer = createFlapCanonicalProjectionWriter({ file: "/fixture", now: () => 100,
    atomicWrite: async (_file, snapshot) => {
      published = structuredClone(snapshot);
      if (snapshot.status === "ready") throw new Error("directory fsync failed after rename");
    } });
  await writer.invalidate();
  await assert.rejects(writer.afterSave(stateWith()), { code: "BSC_FLAP_CANONICAL_PROJECTION_FAILED" });
  assert.equal(published.status, "updating");
  assert.deepEqual(published.windows, {});
});
