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
