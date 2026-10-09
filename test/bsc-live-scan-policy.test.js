import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { validateBscScanPolicy, loadBscScanPolicy, bscScanEntryActive, bscScanFeatureActive, bscScanGapActive, splitBscScanGaps } from "../src/bsc-live-scan-policy.js";

const policy = { version: 1, mode: "live_only", fromBlock: 100, activatedAt: "2026-10-01T12:00:00.000Z" };
test("fixed boundary keeps later retry work active without making old or unknown blocks eligible", () => {
  assert.equal(bscScanEntryActive(policy, { blockNumber: 99 }), false);
  assert.equal(bscScanEntryActive(policy, { blockNumber: 100 }), true);
  assert.equal(bscScanEntryActive(policy, { blockNumber: 101, nextAttemptAt: "2026-11-01T12:00:00Z" }), true);
  assert.equal(bscScanEntryActive(policy, {}), false);
  assert.equal(bscScanEntryActive({ mode: "all" }, { blockNumber: 99 }), true);
  for (const value of [{}, { ...policy, fromBlock: "100" }, { ...policy, activatedAt: "invalid" }, { ...policy, fromBlock: 0 }]) {
    assert.throws(() => validateBscScanPolicy(value));
  }
});
test("missing control file preserves the durable pause, explicit all resumes, malformed file fails closed", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-scan-policy-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await loadBscScanPolicy(dir), { version: 1, mode: "all" });
  assert.deepEqual(await loadBscScanPolicy(dir, policy), policy);
  await fs.writeFile(path.join(dir, "bsc-scan-policy.json"), JSON.stringify({ version: 1, mode: "all" }));
  assert.deepEqual(await loadBscScanPolicy(dir, policy), { version: 1, mode: "all" });
  await fs.writeFile(path.join(dir, "bsc-scan-policy.json"), "{}");
  await assert.rejects(() => loadBscScanPolicy(dir, policy), /Invalid/);
});
test("old first-token windows are not reopened or reused as a new first token", () => {
  assert.equal(bscScanFeatureActive(policy, { activationBlockNumber: 99, firstObservedAt: "2026-10-02T00:00:00Z" }), false);
  assert.equal(bscScanFeatureActive(policy, { activationBlockNumber: 100 }), true);
  assert.equal(bscScanFeatureActive(policy, { firstObservedAt: "2026-10-01T11:59:59Z" }), false);
  assert.equal(bscScanFeatureActive(policy, { firstObservedAt: policy.activatedAt }), true);
  assert.equal(bscScanFeatureActive(policy, {}), false);
});
test("split gaps preserve pending block union and retry metadata across cutover and restart", () => {
  const gaps = [
    { id: "old", fromBlock: 80, nextBlock: 82, toBlock: 90, attempts: 3 },
    { id: "cross", fromBlock: 91, nextBlock: 95, toBlock: 110, attempts: 2, nextAttemptAt: "later" },
    { id: "new", fromBlock: 111, nextBlock: 113, toBlock: 120, attempts: 0 },
  ];
  const pending = list => list.flatMap(g => Array.from({ length: g.toBlock - g.nextBlock + 1 }, (_, i) => g.nextBlock + i));
  const split = splitBscScanGaps(policy, gaps);
  assert.deepEqual(pending(split), pending(gaps));
  assert.deepEqual(splitBscScanGaps(policy, split), split);
  const active = split.filter(g => bscScanGapActive(policy, g));
  assert.ok(active.every(g => g.nextBlock >= 100));
  assert.equal(active[0].attempts, 2);
  assert.equal(active[0].nextAttemptAt, "later");
  assert.deepEqual(split[0], gaps[0]);
});
