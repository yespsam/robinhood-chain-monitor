import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperResearchReader } from '../src/paper-research-reader.js';

test('concurrent dispatches share one preparation, but settled evidence is never cached', async () => {
  let release, evidenceCalls = 0, learningCalls = 0, clock = 1000;
  const reader = createPaperResearchReader({ now: () => clock,
    evidenceLoader: () => { evidenceCalls++; return new Promise(resolve => { release = resolve; }); },
    learningLoader: () => { learningCalls++; return { verifiedProfiles: {} }; } });
  const a = reader.load(), b = reader.load(), c = reader.load();
  assert.equal(a, b); assert.equal(b, c);
  await Promise.resolve(); assert.equal(evidenceCalls, 1); assert.equal(learningCalls, 1);
  assert.equal(reader.snapshot().inFlight, true);
  clock += 20; release({ revision: 1 });
  assert.equal((await a).loadedEvidence.revision, 1);
  assert.equal(reader.snapshot().joinedReads, 2); assert.equal(reader.snapshot().lastRead.durationMs, 20);
  const next = reader.load(); await Promise.resolve(); release({ revision: 2 });
  assert.equal((await next).loadedEvidence.revision, 2);
  assert.equal(evidenceCalls, 2); assert.equal(learningCalls, 2);
  const stats = reader.snapshot(); stats.lastRead.durationMs = -1;
  assert.notEqual(reader.snapshot().lastRead.durationMs, -1);
});

test('read failure has no stale-success fallback or raw error; a later read can recover', async () => {
  let fail = false, asyncFailure = false;
  const value = () => {
    if (asyncFailure) return Promise.reject(new Error('SECRET'));
    if (fail) throw new Error('SECRET');
    return { revision: 1 };
  };
  const reader = createPaperResearchReader({ evidenceLoader: value, learningLoader: value });
  await reader.load();
  for (const mode of ['sync', 'async']) {
    fail = mode === 'sync'; asyncFailure = mode === 'async';
    const result = await reader.load();
    assert.deepEqual(result.loadedEvidence, {});
    assert.equal(result.learning.lastError, 'learning_unavailable');
    assert.equal(reader.snapshot().lastRead.evidenceFailed, true);
    assert.equal(reader.snapshot().lastRead.learningFailed, true);
    assert.equal(reader.snapshot().inFlight, false);
    assert.equal(JSON.stringify([result, reader.snapshot()]).includes('SECRET'), false);
  }
  fail = false; asyncFailure = false;
  assert.equal((await reader.load()).loadedEvidence.revision, 1);
  assert.equal(reader.snapshot().lastRead.evidenceFailed, false);
});

test('slow scan reads do not hold events or quotes; separate CAs never share a blocked quote read', async () => {
  let calls = 0, releaseScan, releaseQuote;
  const reader = createPaperResearchReader({ learningLoader: () => ({}), evidenceLoader: () => {
    calls++;
    if (calls === 1) return new Promise(r => { releaseScan = r; });
    if (calls === 3) return new Promise(r => { releaseQuote = r; });
    return { calls };
  } });
  const scan = reader.load(); await Promise.resolve();
  assert.equal((await reader.load({ lane: 'events' })).loadedEvidence.calls, 2);
  const slowQuote = reader.load({ isolated: true }); await Promise.resolve();
  assert.equal((await reader.load({ isolated: true })).loadedEvidence.calls, 4);
  assert.equal(reader.snapshot().inFlightReads, 2);
  releaseQuote({ calls: 3 }); releaseScan({ calls: 1 }); await Promise.all([scan, slowQuote]);
  assert.equal(reader.snapshot().inFlightReads, 0); assert.equal(reader.snapshot().isolatedReads, 2);
});
