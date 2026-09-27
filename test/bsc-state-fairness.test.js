import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBscLaunchpadMonitor } from '../src/bsc-launchpad-monitor.js';

test('queued BSC snapshots allow pending I/O callbacks before the queue drains', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-fairness-'));
  const monitor = createBscLaunchpadMonitor({ dataDir, bscMonitorEnabled: false }, {
    autoStart: false,
    logger: { error() {} },
  });
  t.after(async () => {
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const initial = await monitor.getState();
  let completed = 0;
  const callback = new Promise(resolve => setImmediate(() => resolve(completed)));
  const snapshots = await Promise.all(Array.from({ length: 128 }, async () => {
    const snapshot = await monitor.getState();
    completed += 1;
    return snapshot;
  }));
  assert.ok(await callback < 128, 'the original microtask-only lock starves every pending callback');
  for (const snapshot of snapshots) assert.deepEqual(snapshot, initial);
});

test('Four.Meme replay stops at the next read boundary without starting more history work', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'four-replay-stop-'));
  let releaseHead;
  let signalHead;
  const headGate = new Promise(resolve => { releaseHead = resolve; });
  const headStarted = new Promise(resolve => { signalHead = resolve; });
  let laterReads = 0;
  const monitor = createBscLaunchpadMonitor({ dataDir, bscConfirmations: 2 }, {
    autoStart: false,
    externalAttribution: false,
    logger: { error() {}, info() {} },
    provider: {
      async getBlockNumber() { signalHead(); await headGate; return 100; },
      async getBlock() { laterReads += 1; throw new Error('unstarted historical read'); },
      async send() { laterReads += 1; throw new Error('unstarted historical read'); },
      destroy() {},
    },
  });
  t.after(async () => {
    releaseHead();
    await monitor.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await monitor.registerFourMemeFeatureActivations([{
    quoteConfig: { symbol: 'SPCXB', address: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1', status: 'PUBLISH' },
    observedAt: new Date().toISOString(),
  }], { awaitReplay: false });
  await headStarted;
  const stopping = monitor.stop();
  releaseHead();
  await stopping;
  assert.equal(laterReads, 0, 'stopping must not start more historical RPC reads');
  const activation = Object.values((await monitor.getState()).officialSources.fourMeme.featureActivations)[0];
  assert.equal(activation.replayCompletedAt, null, 'unfinished replay remains pending for restart');
  assert.equal(activation.replayLastError, null, 'shutdown is not an upstream failure');
});
