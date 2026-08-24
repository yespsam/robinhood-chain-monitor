import test from "node:test";
import assert from "node:assert/strict";
import {
  createRobinhoodScanPolicy,
  focus3RobinhoodFactoryAddresses,
  loadRobinhoodSignalCandidate,
} from "../src/robinhood-scan-policy.js";
import { launchpadByFactory } from "../src/launchpad-catalog.js";

const UNKNOWN_FACTORY = "0x1111111111111111111111111111111111111111";
const PONS_FACTORY = "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb";

test("focus3 Robinhood policy keeps only exact Flap and Pools.trade factories", () => {
  const factories = focus3RobinhoodFactoryAddresses();
  assert.ok(factories.length > 0);
  assert.deepEqual(
    new Set(factories.map((address) => launchpadByFactory(address)?.id)),
    new Set(["flap", "uniswap-pools"]),
  );

  const policy = createRobinhoodScanPolicy({ monitorScope: "focus3" });
  for (const address of factories) {
    assert.equal(policy.shouldAnalyzeTransaction({ to: address.toUpperCase().replace("0X", "0x") }), true, address);
  }
  assert.equal(policy.shouldAnalyzeTransaction({ to: PONS_FACTORY }), false);
  assert.equal(policy.shouldAnalyzeTransaction({ to: UNKNOWN_FACTORY }), false);
  assert.equal(policy.shouldAnalyzeTransaction({ to: null }), false);
});

test("focus3 prunes unrelated persisted factory scores while all-scope preserves them", () => {
  const [flapFactory] = focus3RobinhoodFactoryAddresses().filter((address) => launchpadByFactory(address)?.id === "flap");
  const persisted = [
    [flapFactory, { launches: 2 }],
    [PONS_FACTORY, { launches: 3 }],
    [UNKNOWN_FACTORY, { launches: 99 }],
  ];

  assert.deepEqual(
    createRobinhoodScanPolicy({ monitorScope: "focus3" }).retainedFactoryScoreEntries(persisted),
    [[flapFactory, { launches: 2 }]],
  );
  assert.deepEqual(
    createRobinhoodScanPolicy({ monitorScope: "all" }).retainedFactoryScoreEntries(persisted),
    persisted,
  );
});

test("focus3 bounds stale Robinhood catch-up while preserving explicit all-scope behavior", () => {
  assert.equal(createRobinhoodScanPolicy({ monitorScope: "focus3" }).catchupLimit(10_000), 400);
  assert.equal(createRobinhoodScanPolicy({ monitorScope: "focus3" }).catchupLimit(0), 0);
  assert.equal(createRobinhoodScanPolicy({ monitorScope: "all" }).catchupLimit(10_000), 10_000);
});

test("focus3 rejects unrelated pool transactions before fetching receipts", async () => {
  const calls = [];
  const provider = {
    async getTransaction(hash) {
      calls.push(["transaction", hash]);
      return { hash, to: UNKNOWN_FACTORY };
    },
    async getTransactionReceipt(hash) {
      calls.push(["receipt", hash]);
      return { transactionHash: hash };
    },
  };

  const candidate = await loadRobinhoodSignalCandidate(
    provider,
    "0xdead",
    createRobinhoodScanPolicy({ monitorScope: "focus3" }),
  );
  assert.equal(candidate, null);
  assert.deepEqual(calls, [["transaction", "0xdead"]]);
});

test("focus3 fetches receipts for exact factories and non-focus behavior stays broad", async () => {
  const [exactFactory] = focus3RobinhoodFactoryAddresses();
  const calls = [];
  const provider = {
    async getTransaction(hash) {
      calls.push(["transaction", hash]);
      return { hash, to: exactFactory };
    },
    async getTransactionReceipt(hash) {
      calls.push(["receipt", hash]);
      return { transactionHash: hash, status: 1 };
    },
  };

  const focused = await loadRobinhoodSignalCandidate(
    provider,
    "0xfocus",
    createRobinhoodScanPolicy({ monitorScope: "focus3" }),
  );
  assert.equal(focused.transaction.to, exactFactory);
  assert.equal(focused.receipt.status, 1);
  assert.deepEqual(calls, [["transaction", "0xfocus"], ["receipt", "0xfocus"]]);

  calls.length = 0;
  provider.getTransaction = async (hash) => {
    calls.push(["transaction", hash]);
    return { hash, to: UNKNOWN_FACTORY };
  };
  const broad = await loadRobinhoodSignalCandidate(
    provider,
    "0xall",
    createRobinhoodScanPolicy({ monitorScope: "all" }),
  );
  assert.equal(broad.transaction.to, UNKNOWN_FACTORY);
  assert.equal(broad.receipt.status, 1);
  assert.deepEqual(new Set(calls.map(([kind]) => kind)), new Set(["transaction", "receipt"]));
});
