import test from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../server/auth.mjs';
import { WalletGate, ConfirmedQueue, DEVELOPMENT } from '../server/policy.mjs';
import { context, testOwner, testPassword, testAddress } from './helpers.mjs';

test('no owner configured: no default login; wrong password and unknown identity denied', async () => {
  await assert.rejects(new Sessions().login('owner', testPassword), { code: 'OWNER_NOT_CONFIGURED' });
  const s = new Sessions({ owner: testOwner });
  await assert.rejects(s.login('owner', 'wrong'), { code: 'LOGIN_FAILED' });
  await assert.rejects(s.login('intruder', testPassword), { code: 'LOGIN_FAILED' });
  s.loginAttempts = Array(5).fill(Date.now());
  await assert.rejects(s.login('owner', testPassword), { code: 'LOGIN_RATE_LIMIT' });
});
test('sessions expire on idle and absolute bounds even if background tasks retain the key', async () => {
  const a = await context({ idleMs: 100, absoluteMs: 500 }); a.advance(100);
  assert.throws(() => a.sessions.fromToken(a.login.token), { code: 'SESSION_EXPIRED' });
  const b = await context({ idleMs: 100, absoluteMs: 250 });
  for (let i = 0; i < 3; i++) { b.advance(80); b.sessions.touch(b.key); }
  b.advance(11); assert.throws(() => b.sessions.byKey(b.key), { code: 'SESSION_EXPIRED' });
});
test('logout invalidates active authentication, prevents pending login race and rotates old sessions', async () => {
  const c = await context(), oldToken = c.login.token;
  const pending = c.sessions.login('owner', testPassword); c.sessions.invalidateAll('logout');
  await assert.rejects(pending, { code: 'LOGIN_RETRY_REQUIRED' });
  assert.throws(() => c.sessions.fromToken(oldToken), { code: 'SESSION_REQUIRED' });
  const fresh = await c.sessions.login('owner', testPassword); assert.notEqual(fresh.token, oldToken);
  assert.throws(() => c.sessions.checkCsrf(fresh.session, 'invalid'), { code: 'CSRF_REJECTED' });
});
test('no binding, missing permission, and unbound network are denied before vendor calls', async () => {
  const c = await context();
  await assert.rejects(new WalletGate({ ...c, binding: null }).check(c.key, '56'), { code: 'WALLET_NOT_BOUND' });
  c.binding.permissions = ['read']; const gate = new WalletGate(c);
  await assert.rejects(gate.check(c.key, '56', 'manual'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(gate.check(c.key, '1'), { code: 'CHAIN_OUTSIDE_BINDING' }); assert.equal(c.calls(), 0);
});
test('official auth expired or disconnected locks all local requests', async () => {
  for (const scenario of ['expiry', 'disconnected', 'unknownExpiry']) {
    const c = await context();
    if (scenario === 'expiry') c.wallet.settings = async () => ({ sessionExpireTime: new Date(c.clock() - 1).toISOString(), inactiveSignOutTime: new Date(c.clock() + 1000).toISOString() });
    if (scenario === 'unknownExpiry') c.wallet.settings = async () => ({});
    if (scenario === 'disconnected') c.wallet.status = async () => 'UNCONNECTED';
    await assert.rejects(new WalletGate(c).check(c.key, '56'), { code: scenario === 'disconnected' ? 'WALLET_AUTH_INVALID' : 'WALLET_AUTH_EXPIRED' });
    assert.equal(c.sessions.items.size, 0);
  }
});
test('wallet identity mismatch or ambiguous addresses cannot access owner data', async () => {
  for (const duplicate of [false, true]) {
    const c = await context();
    c.wallet.addresses = async () => duplicate ? [{ chainId: '56', address: testAddress }, { chainId: '56', address: testAddress }] : [{ chainId: '56', address: '0x2222222222222222222222222222222222222222' }];
    await assert.rejects(new WalletGate(c).check(c.key, '56'), { code: 'WALLET_IDENTITY_MISMATCH' });
    assert.equal(c.sessions.items.size, 0);
  }
});
test('wallet runtime chain inventory is enforced', async () => {
  const c = await context(); c.wallet.chains = async () => [{ id: '1', name: 'Ethereum' }];
  await assert.rejects(new WalletGate(c).check(c.key, '56'), { code: 'CHAIN_NOT_REPORTED_BY_WALLET' });
});
test('logout during an in-flight read suppresses its returned sensitive data', async () => {
  const c = await context(), gate = new WalletGate(c);
  let release, entered; const started = new Promise(r => { entered = r; });
  const result = gate.read(c.key, '56', () => { entered(); return new Promise(r => { release = r; }); });
  await started; c.sessions.invalidateAll('logout'); release({ privateBalance: '100' });
  await assert.rejects(result, { code: 'SESSION_REQUIRED' });
});
test('wallet switch during a read suppresses results after revalidation', async () => {
  const c = await context(), gate = new WalletGate(c);
  await assert.rejects(gate.read(c.key, '56', async () => { c.wallet.addresses = async () => []; return { privateBalance: '100' }; }), { code: 'WALLET_IDENTITY_MISMATCH' });
});
function queue(c, execute) { return new ConfirmedQueue({ gate: new WalletGate(c), sessions: c.sessions, clock: c.clock, execute }); }
function job(c) { return { id: 'test-job-0001', key: c.key, chainId: '56', confirmed: true, expiresAt: c.clock() + 1000, review: { amount: '1', token: testAddress } }; }
test('unconfirmed, incomplete and expired review never enters a queue', async () => {
  const c = await context(); const q = queue(c, () => assert.fail('must not execute'));
  for (const extra of [{ confirmed: false }, { blockers: ['Gas unknown'] }, { expiresAt: NaN }, { expiresAt: c.clock() }]) assert.throws(() => q.enqueue({ ...job(c), ...extra }), { code: 'CONFIRMATION_NOT_EXECUTABLE' });
});
test('duplicate/concurrent submissions invoke executor at most once; ID payload conflicts denied', async () => {
  const c = await context(); let count = 0; const q = queue(c, async () => { count++; return { orderId: 'synthetic-only' }; });
  const j = job(c); q.enqueue(j); q.enqueue(j);
  assert.throws(() => q.enqueue({ ...j, review: { amount: '2' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await Promise.all([q.run(j.id), q.run(j.id)]); assert.equal(count, 1); assert.equal(await q.run(j.id), 'SUBMITTED');
});
test('unknown execution result is sticky and is never retried', async () => {
  const c = await context(); let count = 0; const q = queue(c, async () => { count++; throw new Error('simulated timeout'); });
  const j = job(c); q.enqueue(j); assert.equal(await q.run(j.id), 'UNKNOWN'); assert.equal(await q.run(j.id), 'UNKNOWN'); assert.equal(count, 1);
});
test('logout blocks queued jobs; scope changes and expired reviews are checked at execution time', async () => {
  for (const scenario of ['logout', 'permission', 'expiry']) {
    const c = await context(); let count = 0; const q = queue(c, async () => { count++; return {}; }); const j = job(c); q.enqueue(j);
    if (scenario === 'logout') { c.sessions.invalidateAll('logout'); assert.equal(await q.run(j.id), 'BLOCKED'); }
    if (scenario === 'permission') { c.binding.permissions = ['read']; await assert.rejects(q.run(j.id), { code: 'PERMISSION_DENIED' }); }
    if (scenario === 'expiry') { c.advance(1001); await assert.rejects(q.run(j.id), { code: 'REVIEW_EXPIRED' }); }
    assert.equal(count, 0);
  }
});
test('development blocks every write and never grants offline automation', async () => {
  const c = await context(), gate = new WalletGate(c);
  assert.throws(() => gate.rejectWrite(c.key), { code: 'DEVELOPMENT_WRITES_DISABLED' });
  assert.ok(Object.values(DEVELOPMENT).every(x => x === false)); assert.ok(Object.isFrozen(DEVELOPMENT)); assert.equal(c.calls(), 0);
});
