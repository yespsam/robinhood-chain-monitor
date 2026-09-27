import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScanDelay } from '../src/paper-runtime-cadence.js';

test('one-second cadence includes processing time and never creates catch-up bursts', () => {
  assert.equal(nextScanDelay(1000, 10000, 10600), 400);
  assert.equal(nextScanDelay(1000, 10000, 10000), 1000);
  assert.equal(nextScanDelay(1000, 10000, 11400), 25);
  assert.equal(nextScanDelay(1000, 10000, 9000), 1000);
});
