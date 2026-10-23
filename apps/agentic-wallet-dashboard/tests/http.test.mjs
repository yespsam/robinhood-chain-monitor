import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.mjs';
import { Sessions } from '../server/auth.mjs';
import { testOwner, testPassword, context } from './helpers.mjs';

async function appFor(t, options = {}) {
  let vendorCalls = 0;
  const wallet = new Proxy({}, { get: () => async () => { vendorCalls++; throw new Error('must not access vendor'); } });
  const app = await createApplication({ sessions: new Sessions({ owner: testOwner }), wallet, ...options });
  t.after(() => app.close()); return { ...app, vendorCalls: () => vendorCalls };
}
async function login(app) {
  const res = await fetch(app.origin + '/api/login', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: testPassword }) });
  assert.equal(res.status, 200); return { cookie: res.headers.get('set-cookie').split(';')[0], state: await res.json(), cookieHeader: res.headers.get('set-cookie') };
}
function post(app, path, auth, body = {}, headers = {}) {
  return fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', Cookie: auth.cookie, 'X-CSRF-Token': auth.state.csrf, ...headers }, body: JSON.stringify(body) });
}
test('loopback only, public UI renders, private files and unauthenticated data are inaccessible', async t => {
  const app = await appFor(t); assert.equal(app.server.address().address, '127.0.0.1');
  const ui = await fetch(app.origin); assert.equal(ui.status, 200); assert.match(await ui.text(), /YESP/);
  assert.match(ui.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(ui.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(app.origin + '/api/demo')).status, 401);
  assert.notEqual((await fetch(app.origin + '/.private/owner.json')).status, 200);
  assert.notEqual((await fetch(app.origin + '/server/auth.mjs')).status, 200);
  assert.equal(app.vendorCalls(), 0);
});
test('login is independent from wallet authorization; real write endpoints fail before CLI', async t => {
  const app = await appFor(t), auth = await login(app); assert.match(auth.cookieHeader, /HttpOnly; SameSite=Strict/);
  const demo = await fetch(app.origin + '/api/demo', { headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.state.csrf } }); assert.equal(demo.status, 200); assert.equal((await demo.json()).connected, false);
  for (const path of ['/api/wallet/signin', '/api/wallet/verify', '/api/wallet/signout', '/api/trade/enable', '/api/trade/submit', '/api/limit/submit', '/api/limit/cancel', '/api/approval/revoke', '/api/strategy/start', '/api/strategy/stop']) {
    const res = await post(app, path, auth); assert.equal(res.status, 403); assert.equal((await res.json()).error, 'DEVELOPMENT_WRITES_DISABLED');
  }
  const read = await post(app, '/api/wallet/read', auth, { kind: 'assets', chainId: '56' }); assert.equal((await read.json()).error, 'WALLET_NOT_BOUND'); assert.equal(app.vendorCalls(), 0);
});
test('CSRF, foreign origin, oversized body and client-supplied wallet identifiers rejected', async t => {
  const app = await appFor(t), auth = await login(app);
  assert.equal((await post(app, '/api/lock', auth, {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await post(app, '/api/lock', auth, {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post(app, '/api/demo/quote', auth, { payload: 'a'.repeat(9000) })).status, 413);
  const res = await post(app, '/api/wallet/read', auth, { chainId: '56', kind: 'assets', walletAddress: 'substitute' }); assert.equal(res.status, 400); assert.equal((await res.json()).error, 'CLIENT_WALLET_REJECTED'); assert.equal(app.vendorCalls(), 0);
});
test('logout rejects old cookie and reports no fictitious revocation, cancellation or strategy stop', async t => {
  const app = await appFor(t), auth = await login(app);
  const res = await post(app, '/api/logout', auth); assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { locked: true, walletSignedOut: false, tokenApprovalsRevoked: false, remoteStrategyStopped: false });
  assert.equal((await fetch(app.origin + '/api/demo', { headers: { Cookie: auth.cookie } })).status, 401);
  assert.equal((await post(app, '/api/trade/submit', auth)).status, 401); assert.equal(app.vendorCalls(), 0);
});
test('bound read is scoped by backend; logout while pending suppresses response', async t => {
  const c = await context(); let release, entered; const started = new Promise(r => { entered = r; });
  c.wallet.balance = () => { entered(); return new Promise(r => { release = r; }); };
  const app = await appFor(t, c), auth = { cookie: `aw_dashboard_${app.server.address().port}=${c.login.token}`, state: c.sessions.publicState(c.login.session) };
  const read = post(app, '/api/wallet/read', auth, { kind: 'assets', chainId: '56' }); await started;
  const logout = await post(app, '/api/logout', auth); assert.equal(logout.status, 200); release([{ symbol: 'SYNTHETIC', balance: '1', priceUsd: '2' }]);
  const res = await read; assert.equal(res.status, 401); assert.doesNotMatch(await res.text(), /SYNTHETIC/);
});
test('closed event channel invalidates backend session, preventing disconnected background work', async t => {
  const app = await appFor(t), auth = await login(app), abort = new AbortController();
  const response = await fetch(app.origin + '/api/events', { headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.state.csrf }, signal: abort.signal });
  const reader = response.body.getReader(); await reader.read();
  const invalidated = new Promise(resolve => app.sessions.onInvalidate(resolve)); abort.abort();
  await invalidated; assert.equal(app.sessions.items.size, 0); assert.equal(app.vendorCalls(), 0);
});
test('empty official balance response is never labeled a complete wallet total', async t => {
  const c = await context(), app = await appFor(t, c);
  const auth = { cookie: `aw_dashboard_${app.server.address().port}=${c.login.token}`, state: c.sessions.publicState(c.login.session) };
  const res = await post(app, '/api/wallet/read', auth, { kind: 'assets', chainId: '56' });
  assert.equal(res.status, 200); const data = await res.json();
  assert.equal(data.totalComplete, false); assert.match(data.coverage, /does not imply zero balance/);
});
test('a cookie alone cannot recover a proof or read protected data through another local port', async t => {
  const app = await appFor(t), auth = await login(app);
  const cookieOnly = { Cookie: auth.cookie };
  const status = await fetch(app.origin + '/api/status', { headers: cookieOnly }); const state = await status.json();
  assert.equal(state.authenticated, false); assert.equal(state.csrf, undefined);
  for (const path of ['/api/demo', '/api/events']) assert.equal((await fetch(app.origin + path, { headers: cookieOnly })).status, 403);
  const valid = await fetch(app.origin + '/api/status', { headers: { ...cookieOnly, 'X-CSRF-Token': auth.state.csrf } });
  assert.equal((await valid.json()).authenticated, true);
});
