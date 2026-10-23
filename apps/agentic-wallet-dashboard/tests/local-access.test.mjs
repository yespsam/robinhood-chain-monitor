import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createApplication } from '../server/app.mjs';
import { Sessions } from '../server/auth.mjs';
import { demoSnapshot } from '../server/fixtures.mjs';

async function localApp(t) {
  let calls = 0;
  const wallet = new Proxy({}, { get: () => async () => { calls++; throw Error('vendor forbidden'); } });
  const app = await createApplication({ sessions: new Sessions(), wallet, localAccess: true });
  t.after(() => app.close()); return { ...app, calls: () => calls };
}
function post(app, path, body = {}, headers = {}) {
  return fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
test('local direct access needs no password, cookie or owner identity and returns only fixtures', async t => {
  const app = await localApp(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  const status = await fetch(app.origin + '/api/status'), state = await status.json();
  assert.equal(state.accessMode, 'local'); assert.equal(state.loginRequired, false);
  assert.equal(state.authenticated, false); assert.equal(state.identityVerified, false); assert.equal(state.walletConnected, false);
  assert.equal(status.headers.get('set-cookie'), null); assert.equal(Object.values(state.capabilities).some(Boolean), false);
  const demo = await fetch(app.origin + '/api/demo'); assert.equal(demo.status, 200);
  assert.deepEqual(await demo.json(), demoSnapshot()); assert.equal(demo.headers.get('set-cookie'), null);
  const page = await (await fetch(app.origin)).text(); assert.doesNotMatch(page, /type="password"|id="login-form"|id="logout-button"/);
  assert.equal(app.sessions.items.size, 0); assert.equal(app.calls(), 0);
});
test('local access cannot authenticate, read a wallet or submit/enable any real operation', async t => {
  const app = await localApp(t);
  for (const path of ['/api/login', '/api/wallet/signin', '/api/wallet/verify', '/api/wallet/signout', '/api/wallet/read', '/api/wallet/quote', '/api/trade/enable', '/api/trade/submit', '/api/limit/submit', '/api/limit/cancel', '/api/approval/revoke', '/api/strategy/start', '/api/strategy/stop']) {
    const response = await post(app, path); assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error, 'LOCAL_ACCESS_DEMO_ONLY');
  }
  assert.notEqual((await fetch(app.origin + '/.private/owner.json')).status, 200);
  assert.equal(app.calls(), 0); assert.equal(app.sessions.items.size, 0);
});
test('local demo review retains origin, request format and size validation', async t => {
  const app = await localApp(t), data = demoSnapshot();
  const [from, to] = data.assets.filter(x => x.chainId === '56');
  const draft = { chainId: '56', fromToken: from.contract, toToken: to.contract, amount: '0.1', slippage: '0.5', kind: 'market' };
  const quote = await post(app, '/api/demo/quote', draft); assert.equal(quote.status, 200);
  const review = await quote.json(); assert.ok(review.blockers.length > 0); assert.equal(review.orderId, undefined);
  assert.equal((await post(app, '/api/demo/quote', draft, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post(app, '/api/demo/quote', draft, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(app, '/api/demo/quote', { payload: 'x'.repeat(9000) })).status, 413);
  assert.equal((await fetch(app.origin + '/api/demo', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  // fetch replaces Host with its URL authority; use node:http to exercise an actual hostile Host.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    get(app.origin + '/api/demo', { headers: { Host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(app.origin + '/api/demo/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })).status, 403);
  assert.equal(app.calls(), 0);
});
test('local access refuses construction with a wallet binding', async () => {
  await assert.rejects(createApplication({ sessions: new Sessions(), localAccess: true, binding: {} }), /LOCAL_ACCESS_REQUIRES_DEMO_ONLY/);
});
