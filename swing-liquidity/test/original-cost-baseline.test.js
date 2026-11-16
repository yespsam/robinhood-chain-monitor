import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, openPosition, closeTrade } from '../vendor/original-swing/src/swing-signal.js';

// Re-derives the reported old-model identity. This is not a replay of the 13 closed paper trades;
// those rows were not in the source bundle. 3 wins / 10 losses / -55.47U stays a reported observation.
test('legacy +20% take-profit nets about +14.6% and the -15% stop nets about -23%', () => {
  const cfg = loadConfig({});
  const pos = openPosition({ price: 1, liquidityUsd: 50_000, cfg, now: 0 });
  const tp = closeTrade(pos, pos.tpPrice, false, cfg);
  const sl = closeTrade(pos, pos.stopPrice, true, cfg);
  assert.ok(Math.abs(tp.netPct - 14.62472) < 1e-4);
  assert.ok(Math.abs(tp.grossPct - 23.6) < 1e-9);
  assert.ok(Math.abs(sl.netPct - (-23.0362665625)) < 1e-6);
  assert.ok(tp.netPct < 20);
  assert.ok(sl.netPct < -20);
});
