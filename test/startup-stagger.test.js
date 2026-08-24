import test from "node:test";
import assert from "node:assert/strict";
import {
  createBoundedStartupQueue,
  FOCUS3_MONITOR_START_DELAYS_MS,
  startIndependentMonitor,
} from "../src/startup-stagger.js";

test("focus3 staggers heavy monitor construction at the configured offsets", () => {
  const scheduled = [];
  const started = [];
  const setTimer = (callback, delayMs) => {
    scheduled.push({ callback, delayMs });
    return { delayMs };
  };

  for (const name of ["bsc", "github", "binance", "platform-capability", "twitter", "uniswap", "site"]) {
    startIndependentMonitor(
      { monitorScope: "focus3" },
      name,
      () => started.push(name),
      { setTimer },
    );
  }

  assert.deepEqual(started, ["bsc"]);
  assert.deepEqual(
    scheduled.map(({ delayMs }) => delayMs),
    [1_000, 2_000, 3_000, 4_000, 5_000, 10_000],
  );
  for (const item of scheduled) item.callback();
  assert.deepEqual(started, ["bsc", "github", "binance", "platform-capability", "twitter", "uniswap", "site"]);
  assert.equal(FOCUS3_MONITOR_START_DELAYS_MS.site, 10_000);
});

test("non-focus construction remains immediate and in caller order", () => {
  const started = [];
  const setTimer = () => assert.fail("non-focus startup must not schedule timers");
  for (const name of ["bsc", "github", "site", "twitter", "platform-capability", "binance", "uniswap"]) {
    startIndependentMonitor(
      { monitorScope: "all" },
      name,
      () => started.push(name),
      { setTimer },
    );
  }
  assert.deepEqual(started, ["bsc", "github", "site", "twitter", "platform-capability", "binance", "uniswap"]);
});

test("startup queue preserves deferred callbacks, deduplicates them, and stays bounded", () => {
  const queue = createBoundedStartupQueue(2);
  queue.remember("first", { revision: 1 });
  queue.remember("first", { revision: 2 });
  queue.remember("second", { revision: 3 });
  assert.equal(queue.size, 2);
  assert.deepEqual(queue.drain(), [{ revision: 2 }, { revision: 3 }]);
  assert.equal(queue.size, 0);

  queue.remember("oldest", 1);
  queue.remember("middle", 2);
  queue.remember("newest", 3);
  assert.deepEqual(queue.drain(), [2, 3]);
});

test("a delayed constructor failure is reported and remains fatal", () => {
  let callback;
  let reported;
  startIndependentMonitor(
    { monitorScope: "focus3" },
    "github",
    () => { throw new Error("github init failed"); },
    {
      setTimer: (scheduled) => { callback = scheduled; },
      onError: (error) => { reported = error.message; },
    },
  );
  assert.throws(callback, /github init failed/);
  assert.equal(reported, "github init failed");
});
