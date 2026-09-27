import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWalletLearningMonitor, validateLearningState } from '../src/wallet-learning-monitor.js';
import { NOW, teacher, raw, address } from './fixtures/wallet-learning.js';
import { parseProfitLeaderboard, mergeProfitLeaderboards } from '../src/profit-leaderboard.js';
async function fixture(t, custom = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-wallet-learning-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let now = NOW, calls = []; const w = teacher();
  const options = { dataDir, now: () => now, sourceLoader: async () => ({ flow: { profiles: { [w.key]: w.profile } } }),
    client: { activity: async (_c, _w, options) => { calls.push(options); return { activities: [raw(1)], next: 'next' }; }, stop: async () => {} }, ...custom };
  const monitor = createWalletLearningMonitor(options); t.after(() => monitor.stop());
  return { monitor, options, dataDir, calls, advance: ms => { now += ms; } };
}
test('single flight, durable request budget, head/backfill alternation and restart preserve observations', async t => {
  const f = await fixture(t);
  await Promise.all([f.monitor.runOnce(), f.monitor.runOnce()]); assert.equal(f.calls.length, 1); assert.equal(f.monitor.snapshot().activityRecords, 1);
  await f.monitor.runOnce(); assert.equal(f.calls.length, 1);
  f.advance(120000); await f.monitor.runOnce(); assert.equal(f.calls[1].cursor, 'next');
  f.advance(120000); await f.monitor.runOnce(); assert.equal(f.calls[2].cursor, null);
  assert.equal(f.monitor.snapshot().activityRecords, 1); assert.equal(f.monitor.snapshot().policies.length, 0);
  assert.equal((await fs.stat(f.monitor.stateFile)).mode & 0o777, 0o600);
  await f.monitor.stop(); const restarted = createWalletLearningMonitor(f.options);
  try { await restarted.runOnce(); assert.equal(restarted.snapshot().activityRecords, 1); assert.equal(f.calls.length, 3); } finally { await restarted.stop(); }
});
test('upstream 429 is persisted, never wipes history or leaks raw error text', async t => {
  const f = await fixture(t); await f.monitor.runOnce(); f.advance(120000);
  f.options.client.activity = async () => { throw Object.assign(new Error('SECRET'), { code: 'GMGN_RATE_LIMITED', retryAt: new Date(NOW + 600000).toISOString() }); };
  await f.monitor.runOnce(); const state = f.monitor.snapshot();
  assert.equal(state.activityRecords, 1); assert.equal(state.lastError, 'GMGN_RATE_LIMITED'); assert.equal(state.nextAttemptAt, new Date(NOW + 600000).toISOString()); assert.equal(JSON.stringify(state).includes('SECRET'), false);
});
test('corrupt history and concurrent writers fail closed without resetting state', async t => {
  const f = await fixture(t); await f.monitor.runOnce();
  const other = createWalletLearningMonitor(f.options); try { await assert.rejects(other.runOnce(), /already_running/); } finally { await other.stop(); }
  await f.monitor.stop(); await fs.writeFile(f.monitor.stateFile, 'null');
  const broken = createWalletLearningMonitor(f.options); try { await assert.rejects(broken.runOnce(), /state_invalid/); assert.equal(await fs.readFile(f.monitor.stateFile, 'utf8'), 'null'); } finally { await broken.stop(); }
});

test('a missing head overlap blocks training until cursor recovery reaches the pre-gap anchor', async t => {
  let count = 0; const cursors = [];
  const f = await fixture(t, { client: { stop: async () => {}, activity: async (_c, _w, options) => {
    cursors.push(options.cursor); count++;
    if (count === 1) return { activities: [raw(1)], next: null };
    if (count === 2) return { activities: [raw(50)], next: 'bridge' };
    return { activities: [raw(20), raw(1)], next: 'older' };
  } } });
  await f.monitor.runOnce(); f.advance(120000); await f.monitor.runOnce(); assert.equal(f.monitor.snapshot().wallets[0].historyGap, true);
  f.advance(120000); await f.monitor.runOnce(); assert.equal(cursors[2], 'bridge'); assert.equal(f.monitor.snapshot().wallets[0].historyGap, false);
});

test('capacity expands without erasing legacy samples; candidate profiles are not counted as activity', async t => {
  const f = await fixture(t); await f.monitor.runOnce();
  const old = await fs.readFile(f.monitor.stateFile, 'utf8'); await f.monitor.stop();
  const profiles = {};
  for (const [chain, count] of [['robinhood', 150], ['bsc', 80], ['eth', 80], ['base', 2]]) for (let i = 1; i <= count; i++) { const w = teacher(i, chain); profiles[w.key] = w.profile; }
  const expanded = createWalletLearningMonitor({ ...f.options, sourceLoader: async () => ({ flow: { profiles } }) });
  try {
    f.advance(120000); await expanded.runOnce(); const r = expanded.snapshot();
    assert.equal(r.walletCount, 80); assert.equal(r.candidateCount, 312); assert.ok(r.activityRecords >= 1);
    assert.ok(r.chainCoverage.every(c => c.chain === 'sol' || c.deepWallets > 0));
    const saved = JSON.parse(await fs.readFile(expanded.stateFile, 'utf8')); const prior = JSON.parse(old);
    assert.deepEqual(saved.wallets[teacher().key].rows, prior.wallets[teacher().key].rows);
  } finally { await expanded.stop(); }
});

test('profile batches use two budgeted public calls across cycles, resume after restart and keep activity separate', async t => {
  const w = teacher(); let calls = [];
  for (const p of Object.values(w.profile)) p.checkedAt = new Date(NOW - 2 * 3600000).toISOString();
  const client = { stop: async () => {}, activity: async () => { calls.push('activity'); return { activities: [raw(1)], next: null }; },
    stats: async (_chain, wallets, period) => { calls.push(period); return wallets.map(wallet => ({ chain: 'robinhood', wallet_address: wallet, realized_profit: 20000, realized_profit_pnl: .2,
      pnl_stat: { winrate: .8, token_num: 200 }, buy: 200, sell: 200, last_timestamp: NOW / 1000 - 60,
      common: { tags: ['smart_degen', 'fomo'], created_at: NOW / 1000 - 60 * 86400, created_token_count: 0 } })); } };
  const f = await fixture(t, { client, sourceLoader: async () => ({ flow: { profiles: { [w.key]: w.profile } } }) });
  for (let i = 0; i < 4; i++) { await f.monitor.runOnce(); f.advance(120000); }
  assert.deepEqual(calls, ['activity', 'activity', 'activity', '7d']);
  assert.equal(f.monitor.snapshot().qualifiedNow, 0); await f.monitor.stop();
  const resumed = createWalletLearningMonitor(f.options);
  try { await resumed.runOnce(); assert.equal(calls.at(-1), '30d'); assert.equal(resumed.snapshot().qualifiedNow, 1); assert.equal(resumed.snapshot().activityRecords, 1); }
  finally { await resumed.stop(); }
});

const profileRow = (wallet, chain = 'robinhood') => ({ chain, wallet_address: wallet, realized_profit: 20000, realized_profit_pnl: .2,
  pnl_stat: { winrate: .8, token_num: 200 }, buy: 200, sell: 200, last_timestamp: NOW / 1000 - 60,
  common: { tags: ['smart_degen', 'fomo'], created_at: NOW / 1000 - 60 * 86400, created_token_count: 0 } });
const staleProfiles = () => Object.fromEntries([teacher(1), teacher(2)].map(w => {
  for (const p of Object.values(w.profile)) p.checkedAt = new Date(NOW - 75 * 60000).toISOString();
  return [w.key, w.profile];
}));

test('leaderboard candidates get dual-profile validation outside the full activity roster without erasing history', async t => {
  const profiles = Object.fromEntries(Array.from({ length: 80 }, (_, i) => { const w = teacher(i + 1); return [w.key, w.profile]; }));
  const wallet = address(999), parsed = parseProfitLeaderboard({ list: [{ address: wallet, realized_profit: 100,
    is_suspicious: false, addr_type: 0, history_transfer_in_amount: 0, history_transfer_out_amount: 0, tags: [] }] },
  { chain: 'robinhood', address: address(555), observedAt: new Date(NOW).toISOString() });
  const leaderboard = mergeProfitLeaderboards(null, parsed.entries, NOW); let useLeaders = false; const calls = [];
  const f = await fixture(t, { sourceLoader: async () => ({ flow: { profiles }, leaderboard: useLeaders ? leaderboard : null }), client: {
    stop: async () => {}, activity: async () => ({ activities: [raw(1)], next: null }),
    stats: async (chain, wallets, period) => { calls.push({ chain, wallets, period }); return profileRow(wallets[0], chain); },
  } });
  await f.monitor.runOnce(); const history = f.monitor.snapshot().activityRecords; useLeaders = true;
  for (let i = 0; i < 3; i++) { f.advance(120000); await f.monitor.runOnce(); }
  assert.equal(calls[0].wallets[0], wallet); assert.equal(calls[0].period, '7d');
  assert.equal(f.monitor.snapshot().profitLeaderboard.qualified, 0); await f.monitor.stop(); f.advance(120000);
  const restored = createWalletLearningMonitor(f.options);
  try {
    await restored.runOnce(); const result = restored.snapshot();
    assert.equal(calls.at(-1).period, '30d'); assert.equal(result.walletCount, 80);
    assert.ok(result.activityRecords >= history); assert.equal(result.profitLeaderboard.candidates, 1);
    assert.equal(result.profitLeaderboard.qualified, 1); assert.equal(result.profitLeaderboard.waitingForActivitySlot, 1);
    assert.equal(result.verifiedLeaderboardProfiles[`robinhood:${wallet}`]['30d'].wallet, wallet);
  } finally { await restored.stop(); }
});

test('partial batches preserve omitted evidence, persist single-wallet fallback, and retry other wallets fairly after restart', async t => {
  const profiles = staleProfiles(), calls = [];
  const f = await fixture(t, { sourceLoader: async () => ({ flow: { profiles } }), client: {
    stop: async () => {}, activity: async () => ({ activities: [], next: null }),
    stats: async (chain, wallets, period) => { calls.push({ wallets, period }); return profileRow(wallets[0], chain); },
  } });
  for (let i = 0; i < 4; i++) { await f.monitor.runOnce(); f.advance(120000); }
  assert.equal(calls[0].wallets.length, 2);
  const first = calls[0].wallets[0], omitted = calls[0].wallets[1];
  let saved = JSON.parse(await fs.readFile(f.monitor.stateFile));
  assert.equal(saved.statsBatchSizes.robinhood, 1);
  assert.equal(saved.wallets[`robinhood:${omitted}`].statsError, undefined);
  assert.deepEqual(saved.wallets[`robinhood:${omitted}`].profile, profiles[`robinhood:${omitted}`]);
  assert.equal(f.monitor.snapshot().profileCollection.missingWallets, 1);
  assert.equal(f.monitor.snapshot().qualifiedNow, 2);
  await f.monitor.stop(); const resumed = createWalletLearningMonitor(f.options);
  try {
    await resumed.runOnce(); assert.deepEqual(calls[1], { wallets: [first], period: '30d' });
    for (let i = 0; i < 5; i++) { f.advance(120000); await resumed.runOnce(); }
    assert.deepEqual(calls[2], { wallets: [omitted], period: '7d' });
    f.advance(120000); await resumed.runOnce();
    assert.deepEqual(calls[3], { wallets: [omitted], period: '30d' });
    assert.equal(resumed.snapshot().profileCollection.missingWallets, 0);
    saved = JSON.parse(await fs.readFile(resumed.stateFile)); assert.equal(saved.statsJob, null);
  } finally { await resumed.stop(); }
});

test('known single-wallet mode is reused; malformed oldest wallet does not starve the rest', async t => {
  const calls = [], f = await fixture(t, { sourceLoader: async () => ({ flow: { profiles: staleProfiles(), chains: { robinhood: { profileBatchSize: 1 } } } }), client: {
    stop: async () => {}, activity: async () => ({ activities: [], next: null }),
    stats: async (chain, wallets) => { calls.push(wallets); return { chain, wallet_address: wallets[0] }; },
  } });
  for (let i = 0; i < 10; i++) { await f.monitor.runOnce(); f.advance(120000); }
  assert.equal(calls.length, 2); assert.ok(calls.every(w => w.length === 1)); assert.notEqual(calls[0][0], calls[1][0]);
  assert.equal(f.monitor.snapshot().profileCollection.incompleteWallets, 2);
  assert.equal(f.monitor.snapshot().qualifiedNow, 0);
});

test('foreign/missing wallet responses never refresh identities or erase prior profiles', async t => {
  const profiles = staleProfiles(), f = await fixture(t, { sourceLoader: async () => ({ flow: { profiles } }), client: {
    stop: async () => {}, activity: async () => ({ activities: [], next: null }),
    stats: async () => [profileRow(address(99)), profileRow(address(1), 'bsc')],
  } });
  for (let i = 0; i < 4; i++) { await f.monitor.runOnce(); f.advance(120000); }
  const saved = JSON.parse(await fs.readFile(f.monitor.stateFile));
  assert.equal(saved.statsJob, null); assert.equal(saved.statsBatchSizes.robinhood, undefined);
  assert.equal(f.monitor.snapshot().profileCollection.missingWallets, 2);
  for (const w of Object.values(saved.wallets)) assert.deepEqual(w.profile, profiles[w.key]);
});

test('new complete source evidence recovers legacy incomplete errors, never one window or stale evidence', async t => {
  const profiles = staleProfiles(), f = await fixture(t, { sourceLoader: async () => ({ flow: { profiles } }) });
  await f.monitor.runOnce(); await f.monitor.stop();
  const saved = JSON.parse(await fs.readFile(f.monitor.stateFile));
  for (const w of Object.values(saved.wallets)) w.statsError = 'learning_profile_incomplete';
  await fs.writeFile(f.monitor.stateFile, JSON.stringify(saved));
  const resumed = createWalletLearningMonitor(f.options);
  try {
    f.advance(120000); await resumed.runOnce(); assert.equal(resumed.snapshot().qualifiedNow, 0);
    profiles[teacher().key]['7d'].checkedAt = new Date(NOW + 120000).toISOString();
    f.advance(120000); await resumed.runOnce(); assert.equal(resumed.snapshot().qualifiedNow, 0);
    profiles[teacher().key]['30d'].checkedAt = new Date(NOW + 240000).toISOString();
    f.advance(120000); await resumed.runOnce(); assert.equal(resumed.snapshot().qualifiedNow, 1);
    assert.equal(resumed.snapshot().profileCollection.incompleteWallets, 1);
  } finally { await resumed.stop(); }
});

test('profile failures retain activity slots and persisted cooldown rather than occupying the whole sampler', async t => {
  const calls = [], f = await fixture(t, { sourceLoader: async () => ({ flow: { profiles: staleProfiles() } }), client: {
    stop: async () => {}, activity: async () => { calls.push('activity'); return { activities: [], next: null }; },
    stats: async () => { calls.push('stats'); throw Object.assign(new Error('SECRET'), { code: 'GMGN_RATE_LIMITED', retryAt: new Date(NOW + 20 * 60000).toISOString() }); },
  } });
  for (let i = 0; i < 4; i++) { await f.monitor.runOnce(); f.advance(120000); }
  assert.equal(f.monitor.snapshot().nextAttemptAt, new Date(NOW + 20 * 60000).toISOString());
  await f.monitor.runOnce(); assert.equal(calls.length, 4);
  f.advance(12 * 60000); await f.monitor.runOnce(); // second profile slot
  f.advance(120000); await f.monitor.runOnce(); // reserved activity slot
  assert.deepEqual(calls, ['activity', 'activity', 'activity', 'stats', 'stats', 'activity']);
  assert.equal(JSON.stringify(f.monitor.snapshot()).includes('SECRET'), false);
});

test('new profile scheduling state is validated while legacy state remains accepted', async t => {
  const f = await fixture(t); await f.monitor.runOnce();
  const saved = JSON.parse(await fs.readFile(f.monitor.stateFile));
  assert.equal(validateLearningState(saved), true);
  assert.throws(() => validateLearningState({ ...saved, statsBatchSizes: { robinhood: 100 } }), /stats_mode_invalid/);
  assert.throws(() => validateLearningState({ ...saved, statsJob: { chain: 'robinhood', wallets: [address(1), address(1)], period: '7d', attempts: 0, startedAt: NOW } }), /stats_job_invalid/);
  saved.wallets[teacher().key].statsErrorAt = -1;
  assert.throws(() => validateLearningState(saved), /wallet_stats_invalid/);
});
