import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.mjs';
import { Sessions } from '../server/auth.mjs';

test('custom contract routes require local session capability and allow bounded ABI JSON payloads only', async t => {
  const calls = [];
  const app = await createApplication({ sessions: new Sessions(), localAccess: true, walletAccess: true, localAccessKey: 'a'.repeat(64),
    contractCallFactory: () => ({ async preview(key, body) { calls.push({ key, body }); return { reviewId: 'ok' }; },
      async submit() { return { status: 'UNKNOWN' }; }, async list() { return { list: [] }; }, async status() { return { status: 'UNKNOWN' }; } }) });
  t.after(() => app.close());
  const bootstrap = await fetch(app.origin + '/api/local/session', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Local-Access': 'a'.repeat(64) }, body: '{}' });
  assert.equal(bootstrap.status, 200); const { token } = await bootstrap.json();
  const state = await fetch(app.origin + '/api/status'); assert.equal((await state.json()).capabilities.customContractCalls, true);
  const large = { abiJson: 'x'.repeat(9000), functionSignature: 'mint()', argumentsJson: '[]' };
  const preview = await fetch(app.origin + '/api/contract-call/preview', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Local-Session': token }, body: JSON.stringify(large) });
  assert.equal(preview.status, 200); assert.equal((await preview.json()).reviewId, 'ok'); assert.equal(calls.length, 1); assert.equal(calls[0].body.abiJson.length, 9000);
  const oversized = await fetch(app.origin + '/api/contract-call/preview', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Local-Session': token }, body: JSON.stringify({ abiJson: 'x'.repeat(66_000) }) });
  assert.equal(oversized.status, 413); assert.equal(calls.length, 1);
  const noSession = await fetch(app.origin + '/api/contract-call/preview', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noSession.status, 401); assert.equal(calls.length, 1);
});
