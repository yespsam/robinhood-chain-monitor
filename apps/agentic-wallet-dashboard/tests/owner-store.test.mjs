import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../server/auth.mjs';
import { ownerReloader } from '../server/owner-store.mjs';
import { testOwner, testPassword } from './helpers.mjs';
async function cleanup(folder) {
  const absolute = path.resolve(folder);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('aw-owner-test-'));
  await rm(absolute, { recursive: true, force: true });
}

test('owner setup activates only local login; unchanged hash does not invalidate sessions', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'aw-owner-test-'));
  t.after(() => cleanup(folder));
  const file = path.join(folder, 'owner.json'), sessions = new Sessions(), refresh = ownerReloader(sessions, file);
  await refresh(); assert.equal(sessions.configured, false);
  await writeFile(file, JSON.stringify(testOwner)); await refresh(); assert.equal(sessions.configured, true);
  const login = await sessions.login('owner', testPassword); await refresh();
  assert.equal(sessions.fromToken(login.token).autoEnabled, false);
});
test('malformed or removed owner configuration immediately invalidates existing sessions when reloaded', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'aw-owner-test-'));
  t.after(() => cleanup(folder));
  const file = path.join(folder, 'owner.json'), sessions = new Sessions(), refresh = ownerReloader(sessions, file);
  await writeFile(file, JSON.stringify(testOwner)); await refresh(); const login = await sessions.login('owner', testPassword);
  await writeFile(file, '{malformed'); await refresh(); assert.equal(sessions.configured, false);
  assert.throws(() => sessions.fromToken(login.token), { code: 'SESSION_REQUIRED' });
});
test('owner removal during password verification cannot create a session', async () => {
  const sessions = new Sessions({ owner: testOwner }); const pending = sessions.login('owner', testPassword);
  sessions.configureOwner(null); await assert.rejects(pending, { code: 'LOGIN_RETRY_REQUIRED' }); assert.equal(sessions.items.size, 0);
});
