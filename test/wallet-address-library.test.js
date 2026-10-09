import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWalletAddressLibrary } from '../src/wallet-address-library.js';
import { createWalletAddressLibraryClient } from '../src/wallet-address-library-client.js';
import { learningWalletRole } from '../src/wallet-learning.js';
import { renderWalletLearning } from '../dashboard/wallet-learning.js';
import { buildBrainView } from '../dashboard/brain-desk.js';
import { NOW, teacher, row, address } from './fixtures/wallet-learning.js';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-address-library-'));
  const library = createWalletAddressLibrary({ dataDir, now: () => NOW });
  t.after(async () => { await library.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, library };
}
function readDb(file, fn) { const db = new DatabaseSync(file, { readOnly: true }); try { return fn(db); } finally { db.close(); } }
const query = (file, sql) => readDb(file, db => db.prepare(sql).all());

test('cold catalog exceeds working-set capacity and survives eviction, 30 days and restart without promoting addresses', async t => {
  const { dataDir, library } = await fixture(t);
  const entries = Array.from({ length: 620 }, (_, i) => ({ chain: 'bsc', wallet: address(i + 1), tags: ['smart_money'], lastObservedAt: NOW - 1000 }));
  const summary = await library.capture({ leaderboard: { entries } });
  assert.equal(summary.status, 'ok'); assert.equal(summary.addresses, 620); assert.equal(summary.profileSnapshots, 0);
  assert.equal(summary.autoFollow, false); assert.equal(summary.addedAddresses, 620);
  await library.stop();
  const restored = createWalletAddressLibrary({ dataDir, now: () => NOW + 40 * 86400000 });
  try {
    const after = await restored.capture({ leaderboard: { entries: entries.slice(0, 1) } });
    assert.equal(after.addresses, 620); assert.equal(after.addedAddresses, 0);
    const stored = query(restored.file, 'SELECT * FROM addresses LIMIT 1')[0];
    assert.equal(stored.last_observed_at, NOW - 1000); assert.equal(stored.first_recorded_at, NOW);
    assert.equal(learningWalletRole({ ...entries[0], profile: {} }, NOW), 'unverified');
  } finally { await restored.stop(); }
});

test('activities deduplicate by chain wallet CA hash, preserve transfers and same-source conflicts, never count variants as trades', async t => {
  const { library } = await fixture(t), w = teacher(1, 'bsc');
  const first = row(1, 'buy', { chain: 'bsc', wallet: w.wallet });
  w.rows = [first, row(2, 'unattributable', { chain: 'bsc', quantity: null, usd: null, price: null })];
  const input = { state: { wallets: { [w.key]: w } } };
  await library.capture(input); await library.capture(input);
  let s = library.snapshot(); assert.equal(s.events, 2); assert.equal(s.evidenceVariants, 2); assert.equal(s.unattributableEvents, 1);
  await library.capture({ flow: { trades: { bsc: [{ ...first, tokenAddress: first.token, baseAmount: 10, amountUsd: 10 }] } } });
  assert.equal(library.snapshot().events, 2); assert.equal(library.snapshot().conflictingEvents, 0);
  await library.capture({ activity: { chain: w.chain, wallet: w.wallet, rows: [{ ...first, usd: 8 }, { ...first, token: address(101) }] } });
  s = library.snapshot(); assert.equal(s.events, 3); assert.equal(s.conflictingEvents, 1);
  await library.capture(input); assert.equal(library.snapshot().conflictingEvents, 1, 'later replay cannot erase a conflict');
  await library.capture({ activity: { chain: 'bsc', wallet: address(2), rows: [first] } });
  assert.equal(library.snapshot().events, 3, 'wrong response wallet cannot contaminate history');
});

test('profile versions preserve negative evidence, original time and unknown floating profit, with strict identity and field allowlist', async t => {
  const { library } = await fixture(t), w = teacher(1, 'bsc');
  w.profile['7d'].realizedProfitUsd = -20;
  w.profile['7d'].apiKey = 'DO_NOT_STORE';
  await library.capture({ flow: { profiles: { [w.key]: w.profile } } });
  assert.equal(library.snapshot().profileSnapshots, 2); assert.equal(library.snapshot().negativeProfileSamples, 1);
  await library.capture({ flow: { profiles: { [w.key]: w.profile } }, nowMs: NOW + 3 * 3600000 });
  assert.equal(library.snapshot().profileSnapshots, 2);
  const p = query(library.file, 'SELECT * FROM profiles');
  assert.ok(p.every(v => v.checked_at === NOW)); assert.ok(p.every(v => !v.payload.includes('DO_NOT_STORE')));
  assert.equal(JSON.parse(p[0].payload).unrealizedProfitUsd, null);
  const changed = structuredClone(w.profile); changed['7d'].realizedProfitUsd = 100;
  changed['7d'].checkedAt = new Date(NOW + 1).toISOString();
  await library.capture({ flow: { profiles: { [w.key]: changed, [`bsc:${address(2)}`]: w.profile } }, nowMs: NOW + 1 });
  assert.equal(library.snapshot().profileSnapshots, 3); assert.equal(library.snapshot().negativeProfileSamples, 1);
  assert.equal(library.snapshot().addresses, 1, 'wrong profile key is rejected');
});

test('EVM casing merges, Solana casing and chain identities remain distinct', async t => {
  const { library } = await fixture(t);
  const evm = address(0xabc), sol = 'B'.repeat(32), lower = 'b'.repeat(32);
  await library.capture({ leaderboard: { entries: [
    { chain: 'bsc', wallet: evm }, { chain: 'bsc', wallet: `0x${evm.slice(2).toUpperCase()}` },
    { chain: 'base', wallet: evm }, { chain: 'sol', wallet: sol }, { chain: 'sol', wallet: lower },
    { chain: 'sol', wallet: 'INVALID' }, { chain: 'bsc', wallet: address(0) },
  ] } });
  assert.equal(library.snapshot().addresses, 4);
});

test('old events do not expire and source coverage gaps remain without synthetic P&L', async t => {
  const { library } = await fixture(t), w = teacher();
  w.historyGap = true; w.rows = [row(1, 'sell', { at: NOW - 60 * 86400000 })];
  await library.capture({ state: { walletArchive: { [w.key]: w } } });
  assert.equal(library.snapshot().events, 1);
  w.rows = []; w.historyGap = false;
  await library.capture({ state: { wallets: { [w.key]: w } } });
  assert.equal(library.snapshot().events, 1);
  assert.ok(query(library.file, 'SELECT payload FROM coverage').some(r => JSON.parse(r.payload).historyGap));
  assert.equal(library.snapshot().netPnl, undefined);
});

test('corrupt archive is reported and never reset, storage is private and local worker stops cleanly', async t => {
  const { dataDir, library } = await fixture(t);
  await fs.writeFile(library.file, 'corrupt retained evidence');
  assert.equal((await library.capture({})).status, 'error');
  assert.equal(await fs.readFile(library.file, 'utf8'), 'corrupt retained evidence');
  const workerDir = path.join(dataDir, 'worker'), client = createWalletAddressLibraryClient({ dataDir: workerDir });
  try {
    const w = teacher(); const p = client.capture({ state: { wallets: { [w.key]: w } }, nowMs: NOW });
    assert.equal(client.capture({}), p, 'single flight prevents an unbounded queue');
    assert.equal((await p).addresses, 1);
    assert.equal((await fs.stat(path.join(workerDir, 'wallet-address-library.sqlite'))).mode & 0o777, 0o600);
  } finally { await client.stop(); }
});

test('Chinese inventory display distinguishes accumulated evidence from qualified teachers and exposes failures', () => {
  const addressLibrary = { addresses: 620, events: 2000, profileSnapshots: 1100, negativeProfileSamples: 8,
    unattributableEvents: 5, conflictingEvents: 2, status: 'error' };
  const html = renderWalletLearning({ addressLibrary });
  assert.match(html, /长期地址档案/); assert.match(html, /620/); assert.match(html, /写入异常/);
  assert.match(html, /收录不等于合格教师/);
  const facts = buildBrainView({ learning: { addressLibrary } }, NOW).modules.find(m => m.id === 'wallet').facts;
  assert.match(JSON.stringify(facts), /长期地址库存/); assert.match(JSON.stringify(facts), /覆盖不完整/);
});
