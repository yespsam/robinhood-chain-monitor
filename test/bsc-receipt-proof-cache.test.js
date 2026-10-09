import test from "node:test";
import assert from "node:assert/strict";
import { createBscReceiptProofCache } from "../src/bsc-receipt-proof-cache.js";
const entry = (n = 1) => ({ transactionHash: `0x${String(n).repeat(64)}`, blockHash: `0x${"a".repeat(64)}`, blockNumber: 100, transactionIndex: n });
const proof = { transaction: { fixture: true }, receipt: { fixture: true } };
test("receipt cache is bounded, expires and cannot cross a fork or transaction position", () => {
  let clock = 100;
  const cache = createBscReceiptProofCache({ now: () => clock, maxEntries: 2, ttlMs: 20 });
  cache.putValidated(entry(), proof);
  assert.equal(cache.get(entry()), proof);
  assert.equal(cache.get({ ...entry(), blockHash: `0x${"b".repeat(64)}` }), null);
  assert.equal(cache.get({ ...entry(), transactionIndex: 2 }), null);
  cache.putValidated(entry(2), proof); cache.putValidated(entry(3), proof);
  assert.equal(cache.get(entry()), null);
  assert.equal(cache.stats().size, 2);
  clock += 21;
  assert.equal(cache.get(entry(2)), null);
  cache.invalidate(entry(3));
  assert.equal(cache.stats().size, 0);
});
test("receipt cache does not survive a restart or accept unknown block identity", () => {
  const cache = createBscReceiptProofCache();
  cache.putValidated({ ...entry(), blockHash: null }, proof);
  assert.equal(cache.stats().size, 0);
  cache.putValidated(entry(), proof);
  assert.equal(createBscReceiptProofCache().get(entry()), null);
  cache.remove(entry()); assert.equal(cache.get(entry()), null);
});
