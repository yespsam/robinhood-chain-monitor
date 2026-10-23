import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalWalletAccess } from '../server/local-wallet.mjs';
import { WalletFailure } from '../server/diagnostics.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const ADDRESS = '0x1111111111111111111111111111111111111111';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ idleMs = 15 * MINUTE, manual = false } = {}) {
  let now = 1_800_000_000_000;
  const start = now, calls = { signin: 0, verify: 0, balance: 0, signout: 0 };
  const wallet = {
    async status() { return 'CONNECTED'; },
    async settings() { return { sessionExpireTime: new Date(start + 3 * DAY).toISOString(), inactiveSignOutTime: new Date(now + idleMs).toISOString() }; },
    async chains() { return [{ id: '56', name: 'BSC' }]; },
    async addresses() { return [{ chainId: '56', address: ADDRESS }]; },
    async balance() { calls.balance++; return []; },
    async beginOfficialSignIn() { calls.signin++; throw Error('Unexpected signin'); },
    async verifyOfficialSignIn() { calls.verify++; throw Error('Unexpected verification'); },
    async officialSignOut() { calls.signout++; return { localSessionCleared: true }; }
  };
  const local = new LocalWalletAccess(wallet, () => now, { tradeService: manual ? {} : null }), key = local.bootstrap().token;
  return { local, wallet, key, calls, start, get now() { return now; }, advance(ms) { now += ms; },
    state: () => local.handle('/api/local/state', key, {}),
    async bind() {
      await local.start(key, { checkOnly: true }); await local.verification;
      return local.bind(key, { candidateId: local.state(key).candidateId, confirmed: true });
    }
  };
}

test('unbound sessions retain the ten-minute idle and one-hour absolute limits', () => {
  const c = fixture(); c.advance(10 * MINUTE);
  assert.throws(() => c.local.check(c.key), { code: 'LOCAL_SESSION_EXPIRED' });
  const d = fixture();
  for (let i = 0; i < 6; i++) { d.advance(9 * MINUTE); d.local.touch(d.key); }
  d.advance(6 * MINUTE);
  assert.throws(() => d.local.check(d.key), { code: 'LOCAL_SESSION_EXPIRED' });
});

test('confirmed sessions survive ten minutes and one hour while receiving fresh official deadlines', async () => {
  const c = fixture(); await c.bind();
  const binding = c.local.gate.binding, limit = c.local.client.maxExpiresAt;
  assert.equal(limit, c.now + DAY);
  for (let i = 0; i < 75; i++) {
    c.advance(MINUTE); const state = await c.state();
    assert.equal(state.walletConnected, true);
    assert.equal(state.walletExpiresAt, c.now + 15 * MINUTE);
    assert.equal(state.expiresAt, state.walletExpiresAt);
    assert.equal(c.local.client.maxExpiresAt, limit);
    assert.equal(c.local.gate.binding, binding);
  }
  assert.deepEqual(c.calls, { signin: 0, verify: 0, balance: 0, signout: 0 });
});

test('bound reads do not reset the local deadline to ten minutes', async () => {
  const c = fixture({ idleMs: 3 * HOUR }); await c.bind();
  const expiresAt = c.local.client.expiresAt;
  c.advance(MINUTE); c.local.touch(c.key);
  assert.equal(c.local.client.expiresAt, expiresAt);
  await c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets' });
  assert.equal(c.local.client.expiresAt, expiresAt);
  assert.equal(c.calls.balance, 1);
});

test('the confirmed local maximum is fixed at twenty-four hours and cannot roll forward', async () => {
  const c = fixture({ idleMs: 2 * DAY }); await c.bind();
  const limit = c.local.client.maxExpiresAt;
  c.advance(DAY - MINUTE); const state = await c.state();
  assert.equal(state.expiresAt, limit); assert.equal(c.local.client.maxExpiresAt, limit);
  c.advance(MINUTE);
  await assert.rejects(c.state(), { code: 'LOCAL_SESSION_EXPIRED' });
  assert.equal(c.local.client, null); assert.equal(c.local.gate.binding, null);
});

test('state recovery verifies an old cached official deadline without authorizing concurrent reads or trades', async () => {
  const c = fixture({ idleMs: MINUTE, manual: true }); await c.bind();
  const cachedDeadline = c.local.client.expiresAt, binding = c.local.gate.binding;
  c.advance(2 * MINUTE);
  const waiting = deferred(); c.wallet.status = () => waiting.promise;
  const recovery = c.state();
  assert.equal(c.local.client.expiresAt, cachedDeadline);
  assert.throws(() => c.local.check(c.key), { code: 'AUTH_STATUS_UNCONFIRMED' });
  await assert.rejects(c.local.gate.check(c.key, '56', 'manual'), { code: 'AUTH_STATUS_UNCONFIRMED' });
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets' }), { code: 'AUTH_STATUS_UNCONFIRMED' });
  assert.equal(c.calls.balance, 0); assert.equal(c.local.gate.binding, binding);
  waiting.resolve('CONNECTED'); const state = await recovery;
  assert.equal(state.walletConnected, true); assert.equal(state.walletExpiresAt, c.now + MINUTE);
  assert.equal(state.expiresAt, state.walletExpiresAt);
  assert.equal(c.local.client.key, c.key); assert.equal(c.local.gate.binding, binding);
  assert.equal((await c.local.gate.check(c.key, '56', 'manual')).walletAddress, ADDRESS);
});

test('the protected launcher reuses a bound capability with an old cached deadline for state verification', async () => {
  const c = fixture({ idleMs: MINUTE }); await c.bind(); c.advance(2 * MINUTE);
  const oldDeadline = c.local.client.expiresAt;
  const result = c.local.bootstrap({ reuseExisting: true });
  assert.equal(result.token, c.key); assert.equal(result.expiresAt, oldDeadline);
  assert.equal(c.local.client.expiresAt, oldDeadline);
  assert.equal((await c.state()).walletConnected, true);
});

test('unknown status and transient provider errors block access but allow a later read-only recovery', async () => {
  for (const uncertain of ['UNKNOWN', 'CREATING', 'OTHER', 'timeout']) {
    const c = fixture(); await c.bind(); const client = c.local.client, binding = c.local.gate.binding;
    c.wallet.status = async () => { if (uncertain === 'timeout') throw new WalletFailure('CLI_TIMEOUT', 'STATUS'); return uncertain; };
    await assert.rejects(c.state(), { code: uncertain === 'timeout' ? 'CLI_TIMEOUT' : 'AUTH_STATUS_UNCONFIRMED' });
    await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets' }));
    assert.equal(c.local.client, client); assert.equal(c.local.gate.binding, binding); assert.equal(c.calls.balance, 0);
    c.wallet.status = async () => 'CONNECTED'; assert.equal((await c.state()).walletConnected, true);
    assert.deepEqual(c.calls, { signin: 0, verify: 0, balance: 0, signout: 0 });
  }
});

test('state recovery never revives confirmed signout, actual expiry, changed identity or explicit lock', async () => {
  for (const reason of ['signout', 'expiry', 'identity', 'lock']) {
    const c = fixture({ idleMs: MINUTE }); await c.bind(); c.advance(2 * MINUTE);
    if (reason === 'signout') c.wallet.status = async () => 'UNCONNECTED';
    if (reason === 'expiry') c.wallet.settings = async () => ({ sessionExpireTime: new Date(c.now - 1).toISOString(), inactiveSignOutTime: new Date(c.now - 1).toISOString() });
    if (reason === 'identity') c.wallet.addresses = async () => [{ chainId: '56', address: '0x2222222222222222222222222222222222222222' }];
    if (reason === 'lock') c.local.lock();
    await assert.rejects(c.state()); assert.equal(c.local.client, null); assert.equal(c.local.gate.binding, null);
    assert.equal(c.calls.signin, 0); assert.equal(c.calls.signout, 0);
  }
});

test('explicit lock or clock rollback during state verification prevents renewal and private output', async () => {
  for (const reason of ['lock', 'rollback']) {
    const c = fixture({ idleMs: MINUTE }); await c.bind(); c.advance(2 * MINUTE);
    const waiting = deferred(); c.wallet.status = () => waiting.promise; const recovery = c.state();
    if (reason === 'lock') c.local.lock(); else c.advance(-1);
    waiting.resolve('CONNECTED'); await assert.rejects(recovery, { code: 'LOCAL_SESSION_EXPIRED' });
    assert.equal(c.local.client, null); assert.equal(c.local.gate.binding, null);
  }
});

test('an indeterminate official status during initial binding still discards the incomplete binding', async () => {
  const c = fixture(); await c.local.start(c.key, { checkOnly: true }); await c.local.verification;
  const candidateId = c.local.state(c.key).candidateId; c.wallet.status = async () => 'UNKNOWN';
  await assert.rejects(c.local.bind(c.key, { candidateId, confirmed: true }), { code: 'AUTH_STATUS_UNCONFIRMED' });
  assert.equal(c.local.client, null); assert.equal(c.local.gate.binding, null);
});

test('explicit disconnect still revokes a bound session whose cached official deadline is old', async () => {
  const c = fixture({ idleMs: MINUTE }); await c.bind(); c.advance(2 * MINUTE);
  const result = await c.local.handle('/api/local/lock', c.key, {});
  assert.equal(result.locked, true); assert.equal(result.walletSignedOut, false);
  assert.equal(c.local.client, null); assert.equal(c.local.gate.binding, null);
  await assert.rejects(c.state(), { code: 'LOCAL_SESSION_EXPIRED' });
});
