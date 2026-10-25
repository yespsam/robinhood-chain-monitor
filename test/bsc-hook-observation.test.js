import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Interface} from 'ethers';
import {
  BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, BSC_WBNB, createBscLaunchpadMonitor,
} from '../src/bsc-launchpad-monitor.js';

const address = digit => `0x${digit.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const transactionHash = hash('c'), previousTransactionHash = hash('d');
const controller = address('2'), previousCaller = address('5'), caller = address('6');
const hookA = address('3'), hookB = address('8');
const tokenA = address('1'), tokenB = address('7'), previousToken = address('4');
const occurredAt = '2026-08-05T00:00:00.000Z';
const observedAt = '2026-08-06T04:00:00.000Z';
const infinity = new Interface([
  'event Initialize(bytes32 indexed poolId,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint160 sqrtPriceX96,int24 tick)',
]);

// Exercise the real receipt observer and durable retry path with local mocks.
// Historical coverage here is fixture-only; it does not enable live backlog.
async function fixture(t, {alreadyAlertedA = false, duplicatePool = false, fail = null} = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-multi-hook-'));
  let monitor, clock = Date.parse(observedAt), failuresRemaining = fail ? 1 : 0;
  t.after(async () => {
    await monitor?.stop();
    await fs.rm(dataDir, {recursive: true, force: true});
  });
  const hooks = Object.fromEntries([hookA, hookB].map((hook, index) => [hook, {
    hook, firstSeenBlock: 89, lastSeenBlock: 89,
    transactions: [previousTransactionHash], poolIds: [hash('9')],
    poolKinds: ['Pancake Infinity CL'], newTokens: [previousToken],
    controllers: {[controller]: {
      controller, transactions: [previousTransactionHash], poolIds: [hash('9')],
      newTokens: [previousToken], safeTokens: [previousToken], callers: [previousCaller],
      alerted: index === 0 && alreadyAlertedA,
    }},
  }]));
  await fs.writeFile(path.join(dataDir, 'bsc-launchpad-state.json'), JSON.stringify({
    version: 6, initializedAt: '2026-08-02T00:00:00.000Z', lastFinalizedBlock: 50,
    realtimeTailNextBlock: 101, launchers: {}, hooks, seenTransactions: {},
    nearHeadRecoveryGaps: [{id: 'realtime-tail-gap:90:90', fromBlock: 90, toBlock: 90, nextBlock: 90}],
    coverageGaps: [],
  }));
  const poolLog = (hook, token, id, logIndex) => {
    const encoded = infinity.encodeEventLog(infinity.getEvent('Initialize'), [
      id, token, BSC_WBNB, hook, 100, hash('0'), 1n, 0,
    ]);
    return {address: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b', transactionHash,
      blockNumber: '0x5a', logIndex, topics: encoded.topics, data: encoded.data};
  };
  const pools = [poolLog(hookA, tokenA, hash('1'), 1), poolLog(hookB, tokenB, hash('2'), 3)];
  if (duplicatePool) pools.splice(1, 0, {...pools[0], logIndex: 2});
  const mints = [tokenA, tokenB].map((token, index) => ({
    address: token, transactionHash, blockNumber: '0x5a', logIndex: index * 2,
    topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC, `0x${'0'.repeat(24)}${'7'.repeat(40)}`],
    data: `0x${'0'.repeat(63)}1`,
  }));
  const receipt = {hash: transactionHash, transactionHash, blockNumber: 90, status: 1, logs: [...mints, ...pools]};
  const alerts = [], attempts = [], codeReads = [];
  const provider = {
    async send(method, [request]) {
      assert.equal(method, 'eth_getLogs');
      return request.topics?.[0] === BSC_TRANSFER_TOPIC ? mints : pools;
    },
    async getTransaction() { return {hash: transactionHash, to: controller, from: caller, data: '0x'}; },
    async getTransactionReceipt() { return receipt; },
    async getBlock(number) { return {number, timestamp: Date.parse(occurredAt) / 1000, transactions: [transactionHash]}; },
    async getCode(raw, blockTag) {
      const ca = raw.toLowerCase(); codeReads.push(ca);
      if ([tokenA, tokenB].includes(ca) && blockTag === 89) return '0x';
      if (fail === 'profile' && ca === hookB && failuresRemaining > 0) {
        failuresRemaining--;
        throw Object.assign(new Error('fixture hook profile temporarily unavailable'), {code: 'NETWORK_ERROR'});
      }
      if ([hookA, hookB].includes(ca)) return `0x63aaaaaaaa63bbbbbbbb${'00'.repeat(600)}`;
      if (ca === controller) return `0x63cccccccc63ddddddddf5${'00'.repeat(1100)}`;
      return [tokenA, tokenB].includes(ca) ? '0x60006000' : '0x6000';
    },
    async getStorage() { return '0x'; },
    async call() { throw new Error('fixture owner unavailable'); },
    destroy() {},
  };
  monitor = createBscLaunchpadMonitor({dataDir, bscNearHeadRecoveryBatchSize: 1}, {
    autoStart: false, provider, now: () => clock,
    sendAlertsImpl: async (_config, event) => {
      const hook = event.mode?.hook?.toLowerCase(); attempts.push(hook);
      if (fail === 'delivery' && hook === hookB && failuresRemaining > 0) {
        failuresRemaining--;
        throw new Error('fixture second-hook delivery unavailable');
      }
      alerts.push(event);
    },
    logger: {error() {}, info() {}},
  });
  await monitor.scanNearHeadRecovery();
  return {monitor, alerts, attempts, codeReads, advance: () => {clock += 60_000;}};
}

for (const duplicatePool of [false, true]) {
  test(`same receipt observes both hooks after the first alerts, duplicate pool=${duplicatePool}`, async t => {
    const f = await fixture(t, {duplicatePool});
    await f.monitor.processRealtimeQueue();
    const state = await f.monitor.getState();
    assert.deepEqual(f.alerts.map(event => event.mode.hook.toLowerCase()), [hookA, hookB]);
    assert.deepEqual(f.attempts, [hookA, hookB], 'duplicate pools cannot duplicate the same hook alert');
    for (const hook of [hookA, hookB]) {
      const record = state.hooks[hook].controllers[controller];
      assert.equal(record.alerted, true);
      assert.ok(record.transactions.includes(transactionHash));
    }
    assert.equal(state.seenTransactions[transactionHash], 90);
    await f.monitor.processRealtimeQueue();
    assert.deepEqual(f.attempts, [hookA, hookB], 'completed receipt remains consumed');
  });
}

test('an already-alerted first hook still records the new observation and does not hide the second hook', async t => {
  const f = await fixture(t, {alreadyAlertedA: true});
  await f.monitor.processRealtimeQueue();
  assert.deepEqual(f.attempts, [hookB]);
  const state = await f.monitor.getState();
  for (const hook of [hookA, hookB]) assert.ok(state.hooks[hook].controllers[controller].transactions.includes(transactionHash));
  assert.equal(state.seenTransactions[transactionHash], 90);
});

for (const fail of ['profile', 'delivery']) {
  test(`later hook ${fail} failure remains pending; retry preserves earlier committed alert`, async t => {
    const f = await fixture(t, {fail});
    await f.monitor.processRealtimeQueue();
    const failed = await f.monitor.getState();
    assert.deepEqual(f.alerts.map(event => event.mode.hook.toLowerCase()), [hookA]);
    assert.equal(failed.hooks[hookA].controllers[controller].alerted, true);
    assert.equal(failed.hooks[hookB].controllers[controller].alerted, false);
    assert.equal(failed.seenTransactions[transactionHash], undefined, 'partial observation is not a completed receipt');
    assert.ok(failed.realtimePendingEntries[transactionHash], 'second-hook retry survives in the durable queue');
    f.advance();
    await f.monitor.processRealtimeQueue();
    const recovered = await f.monitor.getState();
    assert.deepEqual(f.alerts.map(event => event.mode.hook.toLowerCase()), [hookA, hookB]);
    assert.equal(f.attempts.filter(hook => hook === hookA).length, 1);
    assert.equal(f.attempts.filter(hook => hook === hookB).length, fail === 'delivery' ? 2 : 1);
    assert.equal(recovered.hooks[hookB].controllers[controller].alerted, true);
    assert.equal(recovered.seenTransactions[transactionHash], 90);
    assert.equal(recovered.realtimePendingEntries[transactionHash], undefined);
  });
}
