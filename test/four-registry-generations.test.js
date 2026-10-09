import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { isFourRegistryTrackedTokenEvent } from '../src/four-registry-monitor.js';
import { isStrictFourRegistryTrackedTokenUpdate, fourRegistryEventSupersedesTrackedToken } from '../src/source-controls.js';
import {
  FourRegistryFakeProvider, fourRegistryPreset, fourRegistryTxHash,
  createFourRegistryFixture, addFourRegistryPresetUpsert, addFourRegistryTokenCreated,
  addFourRegistryActiveUpdate, addFourRegistryModule, addFourRegistryTokenImpl,
} from './helpers/four-registry-fixture.js';

const ca = digit => `0x${digit.repeat(40)}`;
const hash = fourRegistryTxHash;
const tracked = result => result.events.filter(isFourRegistryTrackedTokenEvent);
const check = async monitor => { const result = await monitor.check(); assert.equal(result.status, 'ok', JSON.stringify(result)); return result; };

async function baseline(t, presets = [], options = {}) {
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, presets);
  const fixture = await createFourRegistryFixture(t, provider, options);
  assert.equal((await fixture.monitor.check()).status, 'baseline');
  return { ...fixture, provider };
}

test('Four mechanism tracks three unique CAs in canonical order across restart; toggles never reset slots', async t => {
  const f = await baseline(t), p = fourRegistryPreset('9');
  f.provider.setSnapshot(101, [p]);
  addFourRegistryPresetUpsert(f.provider, p, { blockNumber: 101, transactionIndex: 2 });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 101, transactionIndex: 1, hash: hash('0'), token: ca('0') });
  // Deliberately insert out of order, including two creations for the same CA.
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 102, transactionIndex: 4, hash: hash('4'), token: ca('4') });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 102, transactionIndex: 2, hash: hash('2'), token: ca('2') });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 102, transactionIndex: 3, hash: hash('3'), token: ca('2') });
  f.provider.head = 104;
  const first = tracked(await check(f.monitor));
  assert.deepEqual(first.map(e => [e.featureTokenOrdinal, e.token.address]), [[1, ca('2')], [2, ca('4')]]);
  assert.ok(first.every(isStrictFourRegistryTrackedTokenUpdate));
  assert.equal(first[1].featureTokenProof.priorTokens[0].token, ca('2'));
  assert.equal(first[1].officialFirstToken, false);
  await f.monitor.stop();
  const restarted = await createFourRegistryFixture(t, f.provider, { dataDir: f.dataDir });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 103, hash: hash('5'), token: ca('5') });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 104, hash: hash('6'), token: ca('6') });
  f.provider.head = 106;
  const third = tracked(await check(restarted.monitor));
  assert.equal(third.length, 1);
  assert.equal(third[0].featureTokenOrdinal, 3);
  assert.equal(third[0].featureGenerationKey, first[0].featureGenerationKey);
  assert.ok(isStrictFourRegistryTrackedTokenUpdate(third[0]));
  const off = { ...p, active: false };
  f.provider.setSnapshot(105, [off]);
  addFourRegistryActiveUpdate(f.provider, off, { blockNumber: 105, hash: hash('7') });
  f.provider.setSnapshot(106, [p]);
  addFourRegistryActiveUpdate(f.provider, p, { blockNumber: 106, hash: hash('8') });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 107, hash: hash('9'), token: ca('9') });
  f.provider.head = 109;
  assert.equal(tracked(await check(restarted.monitor)).length, 0);
  const state = await restarted.monitor.getState();
  assert.equal(state.mechanismTracking.generations[first[0].featureGenerationKey].tokens.length, 3);
  assert.equal(state.mechanismTracking.active[p.id], undefined);
});

test('an already-creatable preset arms on substantive mechanism change, not name-only edits or repeated content', async t => {
  const old = fourRegistryPreset('10'), p = { ...old, version: '2.0.0' };
  const f = await baseline(t, [old]);
  f.provider.setSnapshot(101, [p]);
  addFourRegistryPresetUpsert(f.provider, p);
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  const first = tracked(await check(f.monitor));
  assert.equal(first.length, 1);
  assert.equal(first[0].featureTokenProof.activationEvent.kind, 'four_registry_preset_updated');
  const renamed = { ...p, name: 'Cosmetic name' };
  f.provider.setSnapshot(103, [renamed]);
  addFourRegistryPresetUpsert(f.provider, renamed, { blockNumber: 103, hash: hash('d') });
  addFourRegistryTokenCreated(f.provider, renamed, { blockNumber: 104, hash: hash('e'), token: ca('e') });
  f.provider.head = 106;
  const second = tracked(await check(f.monitor));
  assert.equal(second[0].featureTokenOrdinal, 2);
  assert.equal(second[0].featureGenerationKey, first[0].featureGenerationKey);
  assert.ok(isStrictFourRegistryTrackedTokenUpdate(second[0]));
});

test('an exact module reference arms a generation; duplicate upsert does not reset and unrelated modules do not arm', async t => {
  const p = fourRegistryPreset('11'), f = await baseline(t, [p]);
  addFourRegistryModule(f.provider, { moduleKey: p.curveModuleId, kind: 2, blockNumber: 101 });
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  const first = tracked(await check(f.monitor));
  assert.equal(first.length, 1);
  assert.equal(first[0].featureTokenProof.activationEvent.kind, 'four_registry_module_upserted');
  assert.equal(first[0].featureTokenProof.presetBinding.scope, 'canonical_preset_unchanged_within_event_block');
  addFourRegistryModule(f.provider, { moduleKey: p.curveModuleId, kind: 2, blockNumber: 103, hash: hash('d') });
  addFourRegistryModule(f.provider, { kind: 2, blockNumber: 103, transactionIndex: 2, hash: hash('e') });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 104, hash: hash('f'), token: ca('f') });
  f.provider.head = 106;
  const second = tracked(await check(f.monitor));
  assert.equal(second[0].featureTokenOrdinal, 2);
  assert.equal(second[0].featureGenerationKey, first[0].featureGenerationKey);
  addFourRegistryModule(f.provider, { moduleKey: p.curveModuleId, kind: 2, implementation: ca('a'), blockNumber: 105, hash: hash('5') });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 106, hash: hash('6'), token: ca('6') });
  f.provider.head = 108;
  const changed = tracked(await check(f.monitor));
  assert.equal(changed[0].featureTokenOrdinal, 1);
  assert.notEqual(changed[0].featureGenerationKey, first[0].featureGenerationKey);
});

test('exact token implementation changes arm; unknown module kinds and unreferenced IDs remain watch-only', async t => {
  const p = fourRegistryPreset('12'), f = await baseline(t, [p]);
  addFourRegistryModule(f.provider, { kind: 250, blockNumber: 101 });
  addFourRegistryTokenImpl(f.provider, { blockNumber: 101 });
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  assert.equal(tracked(await check(f.monitor)).length, 0);
  addFourRegistryTokenImpl(f.provider, { tokenImplId: p.tokenImplId, blockNumber: 103, hash: hash('3') });
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 104, hash: hash('4'), token: ca('4') });
  f.provider.head = 106;
  const events = tracked(await check(f.monitor));
  assert.equal(events.length, 1);
  assert.equal(events[0].featureTokenProof.activationEvent.kind, 'four_registry_token_impl_upserted');
});

test('tracked proof rejects ordinal, ordering, scope, source, generation and mechanism mutations', async t => {
  const f = await baseline(t), p = fourRegistryPreset('13');
  f.provider.setSnapshot(101, [p]);
  addFourRegistryPresetUpsert(f.provider, p);
  addFourRegistryTokenCreated(f.provider, p);
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 102, transactionIndex: 3, hash: hash('d'), token: ca('d') });
  f.provider.head = 104;
  const [first, second] = tracked(await check(f.monitor));
  for (const mutate of [
    e => { e.featureTokenOrdinal = 3; },
    e => { e.featureTokenProof.priorTokens = []; },
    e => { e.featureTokenProof.priorTokens[0].token = e.token.address; },
    e => { e.featureTokenProof.presetBinding.preset.tradeModuleId = `0x${'f'.repeat(64)}`; },
    e => { e.featureTokenProof.activationEvent.autoTradeEligible = true; },
    e => { e.featureGenerationKey += 'fake'; },
    e => { e.featureTokenProof.ordering = 'arrival_order'; },
    e => { e.featureTokenProof.contiguousFromBlock += 1; },
    e => { e.autoTradeEligible = true; },
  ]) {
    const altered = structuredClone(second); mutate(altered);
    assert.equal(isStrictFourRegistryTrackedTokenUpdate(altered), false);
  }
  assert.equal(first.informationalOnly, true);
  assert.equal(first.autoTradeEligible, false);
  assert.equal(first.trading.decision, 'watch_only');
});

test('v11 state upgrades without reopening historical mechanism slots', async t => {
  const p = fourRegistryPreset('14'), f = await baseline(t, [p]);
  const old = await f.monitor.getState();
  old.version = 11;
  delete old.mechanismTracking;
  for (const checkpoint of old.checkpoints) delete checkpoint.mechanismTracking;
  // A synthetic historical state lives only in this test temporary directory.
  await fs.writeFile(f.monitor.stateFile, JSON.stringify(old));
  await f.monitor.stop();
  const restarted = await createFourRegistryFixture(t, f.provider, { dataDir: f.dataDir });
  addFourRegistryPresetUpsert(f.provider, p);
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  assert.equal(tracked(await check(restarted.monitor)).length, 0);
  assert.equal((await restarted.monitor.getState()).version, 12);
});

test('reorg restores the checkpointed first CA and replaces second CA at ordinal two', async t => {
  const f = await baseline(t, [], { cancelPendingEvent: async evidence => ({
    status: 'delivered_orphaned', reason: 'canonical_reorg', persisted: true, terminal: true,
    eventId: evidence.eventId, deliveredAt: '2026-09-04T08:00:00.000Z',
  }) }), p = fourRegistryPreset('15');
  f.provider.setSnapshot(101, [p]);
  addFourRegistryPresetUpsert(f.provider, p);
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  const first = tracked(await check(f.monitor))[0];
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 103, hash: hash('d'), token: ca('d') });
  f.provider.head = 105;
  assert.equal(tracked(await check(f.monitor))[0].featureTokenOrdinal, 2);
  f.provider.setBlockHash(103, hash('e'));
  f.provider.logs = f.provider.logs.filter(log => log.blockNumber !== 103);
  f.provider.receipts.delete(hash('d')); f.provider.transactions.delete(hash('d'));
  addFourRegistryTokenCreated(f.provider, p, { blockNumber: 103, hash: hash('e'), token: ca('e') });
  const recovery = await f.monitor.check();
  assert.equal(recovery.status, 'recovered_reorg', JSON.stringify(recovery));
  const replacement = tracked(await check(f.monitor))[0];
  assert.equal(replacement.featureTokenOrdinal, 2);
  assert.equal(replacement.featureGenerationKey, first.featureGenerationKey);
  assert.equal(replacement.featureTokenProof.priorTokens[0].token, first.token.address);
  const record = (await f.monitor.getState()).mechanismTracking.generations[first.featureGenerationKey];
  assert.deepEqual(record.tokens.map(t => t.token), [first.token.address, ca('e')]);
});

test('later disable or material module update invalidates the old candidate; cosmetic and unrelated changes do not', async t => {
  const old = fourRegistryPreset('16'), p = { ...old, version: '2.0.0' }, f = await baseline(t, [old]);
  f.provider.setSnapshot(101, [p]);
  addFourRegistryPresetUpsert(f.provider, p);
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  const candidate = tracked(await check(f.monitor))[0];
  const renamed = { ...p, name: 'Renamed' };
  f.provider.setSnapshot(103, [renamed]);
  addFourRegistryPresetUpsert(f.provider, renamed, { blockNumber: 103, hash: hash('3') });
  addFourRegistryModule(f.provider, { blockNumber: 103, transactionIndex: 2, hash: hash('4') });
  f.provider.head = 105;
  const cosmetic = await check(f.monitor);
  assert.ok(cosmetic.events.every(event => !fourRegistryEventSupersedesTrackedToken(event, candidate)));
  const disabled = { ...renamed, active: false };
  f.provider.setSnapshot(104, [disabled]);
  addFourRegistryActiveUpdate(f.provider, disabled, { blockNumber: 104, hash: hash('5') });
  addFourRegistryModule(f.provider, { moduleKey: p.curveModuleId, kind: 2, blockNumber: 104, transactionIndex: 2, hash: hash('6') });
  f.provider.head = 106;
  const invalidations = await check(f.monitor);
  assert.ok(invalidations.events.every(event => fourRegistryEventSupersedesTrackedToken(event, candidate)));
  assert.equal((await f.monitor.getState()).mechanismTracking.active[p.id], undefined);
});

test('a referenced module with unknown kind never arms through another implementation update', async t => {
  const p = fourRegistryPreset('17'), f = await baseline(t, [p]);
  addFourRegistryModule(f.provider, { moduleKey: p.curveModuleId, kind: 250, blockNumber: 101 });
  addFourRegistryTokenImpl(f.provider, { tokenImplId: p.tokenImplId, blockNumber: 101, transactionIndex: 2 });
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  assert.equal(tracked(await check(f.monitor)).length, 0);
  assert.equal((await f.monitor.getState()).mechanismTracking.active[p.id], undefined);
});

test('multiple same-block preset writes retain observational alerts but do not invent activation attribution', async t => {
  const old = fourRegistryPreset('18'), mid = { ...old, version: '2.0.0' }, last = { ...old, version: '3.0.0' };
  const f = await baseline(t, [old]);
  f.provider.setSnapshot(101, [last]);
  addFourRegistryPresetUpsert(f.provider, mid, { blockNumber: 101, transactionIndex: 1, hash: hash('a') });
  addFourRegistryPresetUpsert(f.provider, last, { blockNumber: 101, transactionIndex: 3, hash: hash('b') });
  addFourRegistryTokenCreated(f.provider, mid, { blockNumber: 101, transactionIndex: 2, hash: hash('c') });
  addFourRegistryTokenCreated(f.provider, last, { blockNumber: 102, hash: hash('d'), token: ca('d') });
  f.provider.head = 104;
  const result = await check(f.monitor);
  assert.equal(result.events.filter(e => e.type === 'platform_capability_update').length, 2);
  assert.equal(tracked(result).length, 0);
});

test('compact checkpoint stores counts, not duplicate proofs, and rejects a poisoned token count on restart', async t => {
  const f = await baseline(t), p = fourRegistryPreset('19');
  f.provider.setSnapshot(101, [p]);
  addFourRegistryPresetUpsert(f.provider, p);
  addFourRegistryTokenCreated(f.provider, p);
  f.provider.head = 104;
  const event = tracked(await check(f.monitor))[0];
  const state = await f.monitor.getState(), checkpoint = state.checkpoints.at(-1).mechanismTracking;
  assert.equal(checkpoint.version, 2);
  assert.equal(checkpoint.generationCounts[event.featureGenerationKey], 1);
  assert.equal(JSON.stringify(checkpoint).includes('activationEvent'), false);
  assert.ok(JSON.stringify(checkpoint).length < JSON.stringify(state.mechanismTracking).length / 5);
  checkpoint.generationCounts[event.featureGenerationKey] = 2;
  await fs.writeFile(f.monitor.stateFile, JSON.stringify(state));
  await f.monitor.stop();
  const restarted = await createFourRegistryFixture(t, f.provider, { dataDir: f.dataDir });
  const result = await restarted.monitor.check();
  assert.equal(result.status, 'degraded');
  assert.equal(result.errorCode, 'FOUR_REGISTRY_TRACKING_INVALID');
});
