import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.mjs';
import { Sessions } from '../server/auth.mjs';
const accessKey = 'a'.repeat(64);
const post = (app, path, body = {}, headers = {}) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('production bootstrap requires owner-only launch capability and never exposes it', async t => {
  let calls = 0;
  const wallet = new Proxy({}, { get: () => async () => { calls++; throw new Error('vendor forbidden'); } });
  const app = await createApplication({ sessions: new Sessions(), wallet, localAccess: true, walletAccess: true, localAccessKey: accessKey });
  t.after(() => app.close());
  const status = await (await fetch(app.origin + '/api/status')).json();
  assert.equal(status.localAccessRequired, true); assert.equal(JSON.stringify(status).includes(accessKey), false);
  for (const key of ['', 'b'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    const response = await post(app, '/api/local/session', {}, { 'X-Local-Access': key });
    assert.equal(response.status, 401); const result = await response.json();
    assert.equal(result.error, 'LOCAL_ACCESS_REQUIRED'); assert.equal(result.token, undefined);
  }
  assert.equal((await post(app, '/api/local/session', {}, { 'X-Local-Access': accessKey, Origin: 'http://attacker.invalid' })).status, 403);
  const valid = await post(app, '/api/local/session', {}, { 'X-Local-Access': accessKey });
  assert.equal(valid.status, 200); const session = await valid.json(); assert.match(session.token, /^[a-f0-9]{64}$/); assert.notEqual(session.token, accessKey);
  assert.equal((await fetch(app.origin + '/.private/access.json')).status, 404);
  assert.equal(calls, 0);
});

test('manual trading cannot be enabled without a protected local launch', async () => {
  await assert.rejects(createApplication({ sessions: new Sessions(), localAccess: true, walletAccess: true, manualTradeFactory: () => ({}) }), /MANUAL_TRADES_REQUIRE_LOCAL_ACCESS_KEY/);
});

test('manual endpoints require local session even after launch secret is known', async t => {
  let called = 0;
  const app = await createApplication({ sessions: new Sessions(), localAccess: true, walletAccess: true, localAccessKey: accessKey,
    manualTradeFactory: () => ({ async preview() { called++; return {}; } }) });
  t.after(() => app.close());
  const res = await post(app, '/api/trade/preview', {}, { 'X-Local-Access': accessKey });
  assert.equal(res.status, 401); assert.equal(called, 0);
});

test('reopening a protected launcher preserves the QR waiter, review and binding', async t => {
  let connected = false, finish, calls = 0;
  const wallet = {
    async status() { return connected ? 'CONNECTED' : 'UNCONNECTED'; },
    async beginOfficialSignIn() { calls++; return { urlForWeb: 'https://app.binance.com/synthetic-login', pairingCode: 'abc123', qrCodeId: 'synthetic', expireAt: String(Date.now() + 300000) }; },
    async verifyOfficialSignIn() { calls++; return new Promise(resolve => { finish = resolve; }); },
    async settings() { const expiry = new Date(Date.now() + 3600000).toISOString(); return { sessionExpireTime: expiry, inactiveSignOutTime: expiry }; },
    async chains() { return [{ id: '56', name: 'BSC' }]; },
    async addresses() { return [{ chainId: '56', address: '0x1111111111111111111111111111111111111111' }]; }
  };
  const app = await createApplication({ sessions: new Sessions(), wallet, localAccess: true, walletAccess: true, localAccessKey: accessKey });
  t.after(async () => { finish?.({ verified: false }); await app.localWallet.verification; await app.close(); });
  const launch = async (body = {}) => post(app, '/api/local/session', body, { 'X-Local-Access': accessKey });
  const session = await (await launch()).json();
  const headers = { 'X-Local-Session': session.token };
  assert.equal((await post(app, '/api/wallet/signin', {}, headers)).status, 200);
  await new Promise(setImmediate);
  const flow = app.localWallet.flow, waiter = app.localWallet.verification;
  assert.equal(flow.phase, 'WAITING');
  const expiresAt = app.localWallet.client.expiresAt;
  assert.deepEqual(await (await launch()).json(), { ...session, expiresAt });
  assert.equal(app.localWallet.flow, flow); assert.equal(app.localWallet.verification, waiter);
  assert.equal((await launch({ replace: true })).status, 400);
  assert.equal(calls, 2);
  connected = true; finish({ verified: true }); await waiter;
  const candidateId = app.localWallet.state(session.token).candidateId;
  assert.equal((await (await launch()).json()).token, session.token);
  assert.equal(app.localWallet.state(session.token).candidateId, candidateId);
  assert.equal((await post(app, '/api/wallet/bind', { candidateId, confirmed: true }, headers)).status, 200);
  const binding = app.localWallet.gate.binding;
  assert.equal((await (await launch()).json()).token, session.token);
  assert.equal(app.localWallet.gate.binding, binding); assert.equal(calls, 2);
  await post(app, '/api/local/lock', {}, headers);
  assert.notEqual((await (await launch()).json()).token, session.token);
});

test('protected launcher cannot replace an expired session while verification is pending', async t => {
  let finish;
  const wallet = { async status() { return 'UNCONNECTED'; }, async beginOfficialSignIn() { return { qrCodeId: 'synthetic' }; },
    async verifyOfficialSignIn() { return new Promise(resolve => { finish = resolve; }); } };
  const app = await createApplication({ sessions: new Sessions(), wallet, localAccess: true, walletAccess: true, localAccessKey: accessKey });
  t.after(async () => { finish?.({ verified: false }); await app.localWallet.verification; await app.close(); });
  let now = Date.now(); app.localWallet.clock = () => now;
  const launch = () => post(app, '/api/local/session', {}, { 'X-Local-Access': accessKey });
  const initial = await (await launch()).json();
  await post(app, '/api/wallet/signin', {}, { 'X-Local-Session': initial.token }); await new Promise(setImmediate);
  now += 600001;
  const denied = await launch(); assert.equal(denied.status, 409); assert.equal((await denied.json()).error, 'AUTH_IN_PROGRESS');
  finish({ verified: false }); await app.localWallet.verification;
  const fresh = await launch(); assert.equal(fresh.status, 200); assert.notEqual((await fresh.json()).token, initial.token);
});
