import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaperStrategyFocusShadowStore, PAPER_STRATEGY_FOCUS_SHADOW_STORE_VERSION } from '../src/paper-strategy-focus-shadow-store.js';

const NOW = Date.parse('2026-10-30T00:00:00Z');
const CA = `0x${'b'.repeat(40)}`;
async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'focus-shadow-')); }
function row({ status = 'watching_base', signalReady = false, reason = 'awaiting confirmation' } = {}) {
  return { chain: 'bsc', address: CA, symbol: 'SHADOW', marketStage: 'external', researchOnly: true,
    internalSmartMoney: { status: 'not_applicable' }, operatorFootprint: { status: 'unknown', reason: 'no direct evidence' },
    externalSecondBreakout: { version: 'external_second_breakout_pattern_v1', status, signalReady, reasons: [reason],
      metrics: { closedAt: new Date(NOW + 60_000).toISOString(), impulseRise: .42, pullback: .31,
        consolidationBars: 4, breakoutLevel: 1.4, lastClose: signalReady ? 1.41 : 1.39, volumeMultiple: 1.7,
        support: 1.1, targetPrice: 1.8 },
      quoteConfirmation: { ready: signalReady, count: 3, firstAt: new Date(NOW - 4000).toISOString(),
        confirmedAt: new Date(NOW - 1000).toISOString(), reason: signalReady ? null : '报价未站稳' },
      economics: { ready: signalReady, breakEvenPrice: 1.3, estimatedStopLossUsd: .5, netRewardRisk: 1.4, netReferenceGainUsd: 1 } } };
}

test('shadow store deduplicates a candle, records state transitions, flushes and restores independently', async () => {
  const dataDir = await tempDir();
  const store = createPaperStrategyFocusShadowStore({ dataDir, now: () => NOW, debounceMs: 60_000, checkpointMs: 1000 });
  assert.equal((await store.initialize()).status, 'ready');
  store.record([row()], NOW);
  await store.flush();
  store.record([row()], NOW + 1000);
  await store.flush();
  store.record([row({ status: 'candidate', signalReady: true, reason: 'fresh quote and net economics passed' })], NOW + 2000);
  await store.flush();

  const disk = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.equal(disk.version, PAPER_STRATEGY_FOCUS_SHADOW_STORE_VERSION);
  assert.equal(disk.samples.length, 1);
  assert.equal(disk.samples[0].observations, 3);
  assert.equal(disk.samples[0].transitions.length, 2);
  assert.equal(disk.samples[0].latest.externalSecondBreakout.signalReady, true);
  assert.equal(disk.samples[0].latest.entryAllowed, false);
  assert.equal(JSON.stringify(disk).includes('rawCandles'), false);

  const restored = createPaperStrategyFocusShadowStore({ dataDir, now: () => NOW + 3000 });
  assert.equal((await restored.initialize()).sampleCount, 1);
  assert.equal(restored.snapshot().status, 'ready');
});

test('shadow store is capped and records how many older samples were evicted', async () => {
  const dataDir = await tempDir();
  const store = createPaperStrategyFocusShadowStore({ dataDir, now: () => NOW, maxSamples: 2, debounceMs: 60_000 });
  await store.initialize();
  const first = row();
  store.record([first], NOW);
  store.record([{ ...first, address: `0x${'c'.repeat(40)}` }], NOW + 60_000);
  store.record([{ ...first, address: `0x${'d'.repeat(40)}` }], NOW + 120_000);
  await store.flush();
  assert.equal(store.snapshot().sampleCount, 2);
  assert.equal(store.snapshot().droppedSamples, 1);
  const disk = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.deepEqual(disk.samples.map(sample => sample.address), [`0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`]);
});

test('corrupt shadow journal is preserved and disables only shadow persistence', async () => {
  const dataDir = await tempDir();
  const file = path.join(dataDir, 'paper-strategy-focus-shadow-v1.json');
  const original = '{"schema":"broken"}';
  await fs.writeFile(file, original);
  const store = createPaperStrategyFocusShadowStore({ dataDir, now: () => NOW });
  const status = await store.initialize();
  assert.equal(status.status, 'error');
  store.record([row()], NOW);
  await store.flush();
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(store.snapshot().sampleCount, 0);
});
