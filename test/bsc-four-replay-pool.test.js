import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Interface } from "ethers";
import { createBscLaunchpadMonitor } from "../src/bsc-launchpad-monitor.js";

const manager = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const token = `0x${"1".repeat(40)}`;
const creator = `0x${"2".repeat(40)}`;
const activationQuote = `0x${"3".repeat(40)}`;
const otherQuote = `0x${"4".repeat(40)}`;
const transactionHash = `0x${"a1".repeat(32)}`;
const blockHash = `0x${"a2".repeat(32)}`;
const now = Date.parse("2026-10-21T00:00:00.000Z");
const iface = new Interface([
  "event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 raisedAmount,uint256 reservedAmount)",
  "function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)",
]);

async function fixture(t, callImpl) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-four-replay-pool-"));
  const calls = { main: [], replay: [], logs: [] };
  const encoded = iface.encodeEventLog(iface.getEvent("TokenCreate"), [creator, token, 1n, "Fixture", "FX", 100n, 0n, 0n]);
  const log = { address: manager, ...encoded, transactionHash, blockHash, blockNumber: 5, transactionIndex: 0, logIndex: 0 };
  const tokenInfo = iface.encodeFunctionResult("_tokenInfos", [token, otherQuote, 1n, 100n, 0n, 0n,
    BigInt(now / 1000), 0n, 0n, 0n, 0n, 0n, 1n]);
  const mainProvider = {
    destroy() {},
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 100; },
    async getBlock() { return { timestamp: now / 1000 }; },
    async send() { assert.fail("maintenance logs must not use the main provider"); },
    async call(request) { calls.main.push(request); assert.fail("maintenance token-info reads must not use the main provider"); },
  };
  const replayProvider = {
    destroy() {},
    async getNetwork() { return { chainId: 56n }; },
    async getBlockNumber() { return 100; },
    async getBlock() { return { timestamp: now / 1000 }; },
    async send(method, [filter]) {
      assert.equal(method, "eth_getLogs");
      calls.logs.push(structuredClone(filter));
      return Number.parseInt(filter.fromBlock, 16) <= 5 && Number.parseInt(filter.toBlock, 16) >= 5 ? [log] : [];
    },
    async call(request) {
      calls.replay.push(structuredClone(request));
      assert.equal(request.to.toLowerCase(), manager);
      assert.equal(request.data, iface.encodeFunctionData("_tokenInfos", [token]));
      return callImpl ? callImpl(request, tokenInfo, calls.replay.length) : tokenInfo;
    },
  };
  const monitor = createBscLaunchpadMonitor({ dataDir, monitorScope: "focus3", bscReplayIsolationEnabled: true,
    bscConfirmations: 2 }, {
    provider: mainProvider, replayProvider, autoStart: false, externalAttribution: false,
    fourMemeFastReplayEnabled: false, now: () => now,
    logger: { error() {}, info() {} },
  });
  t.after(async () => { await monitor.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  assert.equal(await monitor.registerFourMemeFeatureActivations([{
    quoteConfig: { symbol: "FIXTURE", address: activationQuote, status: "PUBLISH" },
    observedAt: new Date(now).toISOString(),
  }]), 1);
  const snapshot = await monitor.getState();
  const activation = Object.values(snapshot.officialSources.fourMeme.featureActivations)[0];
  return { calls, activation };
}

test("Four quote replay uses its isolated pool for exact-height manager token info", async t => {
  const { calls, activation } = await fixture(t);
  assert.deepEqual(calls.main, []);
  assert.deepEqual(calls.replay.map(request => request.blockTag), [5]);
  assert.equal(calls.logs.length, 1, "one maintenance job retains its single small-window budget");
  assert.equal(activation.replayNextBlock, 10);
  assert.equal(activation.replayScannedThroughBlock, 9);
  assert.equal(activation.replayAttemptedCandidateKeys.length, 1);
  assert.equal(activation.firstTokenTransactionHash, null, "a different quote cannot claim the activation");
});

test("existing archive-unavailable fallback stays in the injected replay pool", async t => {
  const { calls, activation } = await fixture(t, (request, result) => {
    if (request.blockTag !== undefined) throw new Error("missing trie node");
    return result;
  });
  assert.deepEqual(calls.main, []);
  assert.deepEqual(calls.replay.map(request => request.blockTag), [5, undefined]);
  assert.equal(activation.replayNextBlock, 10);
  assert.equal(activation.replayScannedThroughBlock, 9);
  assert.equal(activation.firstTokenTransactionHash, null);
});

for (const kind of ["capacity", "budget"]) {
  test(`Four replay ${kind} failure neither falls back to latest nor advances candidate/cursor`, async t => {
    const error = kind === "capacity"
      ? Object.assign(new Error("shared RPC coordinator: capacity wait deadline"), {
        code: "RPC_COORDINATOR_UNAVAILABLE", rpcFailureScope: "capacity", rpcCircuitAlreadyOpen: true, retryAfterMs: 100,
      })
      : Object.assign(new Error("call state-read retry budget exhausted; evidence retained for retry"), {
        code: "SERVER_ERROR", rpcBudgetExhausted: true, rpcCircuitAlreadyOpen: true, retryAfterMs: 1000,
      });
    const { calls, activation } = await fixture(t, () => { throw error; });
    assert.deepEqual(calls.main, []);
    assert.deepEqual(calls.replay.map(request => request.blockTag), [5]);
    assert.equal(calls.logs.length, 1);
    assert.equal(activation.replayNextBlock, 0, "the rejected candidate leaves the range start pending");
    assert.equal(activation.replayScannedThroughBlock, null);
    assert.equal(activation.replayAttemptedCandidateKeys?.length || 0, 0);
    assert.equal(activation.firstTokenTransactionHash, null);
    assert.equal(activation.replayCompletedAt, null);
    assert.match(activation.replayLastError, kind === "capacity" ? /capacity wait deadline/ : /retry budget exhausted/);
  });
}
