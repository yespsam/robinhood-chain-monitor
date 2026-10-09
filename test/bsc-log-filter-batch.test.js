import test from "node:test";
import assert from "node:assert/strict";
import { readBscLogFilterBatch } from "../src/bsc-log-filter-batch.js";

test("range filter failure stops new work but drains in-flight work before rejecting", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const error = Object.assign(new Error("rate limited"), { retryAfterMs: 60000, rpcFailureScope: "host" });
  const calls = [], metrics = {};
  let settled = false;
  const task = readBscLogFilterBatch([0, 1, 2, 3, 4], 2, async index => {
    calls.push(index);
    if (index === 0) throw error;
    await gate;
    return [];
  }, { metrics });
  const rejection = assert.rejects(task, observed => observed === error);
  task.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [0, 1]);
  assert.equal(settled, false, "do not release the range lane with old physical work still running");
  release();
  await rejection;
  assert.equal(metrics.started, 2);
  assert.equal(metrics.skipped, 3);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.failed, 1);
});

test("successful filters preserve order and retry rereads every filter without partial caching", async () => {
  const calls = [];
  let failing = true;
  const query = async index => {
    calls.push(index);
    if (index === 1 && failing) throw new Error("temporary error");
    return [{ index }];
  };
  await assert.rejects(readBscLogFilterBatch([0, 1, 2], 1, query));
  assert.deepEqual(calls, [0, 1]);
  failing = false;
  const metrics = {};
  assert.deepEqual(await readBscLogFilterBatch([0, 1, 2], 2, query, { metrics }), [[{ index: 0 }], [{ index: 1 }], [{ index: 2 }]]);
  assert.deepEqual(calls.slice(2), [0, 1, 2]);
  assert.equal(metrics.completed, 3);
  assert.equal(metrics.skipped, 0);
});

test("malformed filter results fail before admitting more filters", async () => {
  const calls = [];
  await assert.rejects(readBscLogFilterBatch([0, 1], 1, async index => {
    calls.push(index);
    return null;
  }), /non-array/);
  assert.deepEqual(calls, [0]);
});
