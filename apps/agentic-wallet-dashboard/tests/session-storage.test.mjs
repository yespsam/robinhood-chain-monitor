import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STORAGE_KEY, readLocalSession, saveLocalSession, clearLocalSession } from '../public/session-recovery.js';
const now = 1_800_000_000_000, token = 'a'.repeat(64);
const storage = () => {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key), map };
};
test('browser persistence contains only the short-lived local token and expiry', () => {
  const s = storage(); assert.equal(saveLocalSession(token, now + 600_000, s, now), true);
  assert.deepEqual([...s.map.keys()], [SESSION_STORAGE_KEY]);
  assert.deepEqual(JSON.parse(s.getItem(SESSION_STORAGE_KEY)), { token, expiresAt: now + 600_000 });
  assert.deepEqual(readLocalSession(s, now), { token, expiresAt: now + 600_000 });
  clearLocalSession(s); assert.equal(readLocalSession(s, now), null);
});
test('invalid, excessively old, overlong or extra-field session data is removed without restoration', () => {
  for (const value of [null, [], {}, { token, expiresAt: now - 86_400_000 }, { token, expiresAt: now + 86_400_001 },
    { token, expiresAt: String(now + 10) }, { token: 'bad', expiresAt: now + 10 },
    { token, expiresAt: now + 10, urlForWeb: 'https://app.binance.com/synthetic' },
    { token, expiresAt: now + 10, accessKey: 'not-allowed' }]) {
    const s = storage(); s.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
    assert.equal(readLocalSession(s, now), null); assert.equal(s.map.size, 0);
  }
  const s = storage(); s.setItem(SESSION_STORAGE_KEY, '{broken');
  assert.equal(readLocalSession(s, now), null); assert.equal(s.map.size, 0);
});
test('a stale tab deadline is retained only for authoritative server revalidation', () => {
  const s = storage();
  s.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token, expiresAt: now - 600_000 }));
  assert.deepEqual(readLocalSession(s, now), { token, expiresAt: now - 600_000 });
  assert.equal(saveLocalSession(token, now + 86_400_000, s, now), true);
  assert.deepEqual(readLocalSession(s, now), { token, expiresAt: now + 86_400_000 });
});
test('invalid updates clear an older capability and inaccessible storage never crashes', () => {
  const s = storage(); saveLocalSession(token, now + 600_000, s, now);
  assert.equal(saveLocalSession(token, now - 1, s, now), false); assert.equal(s.map.size, 0);
  const blocked = new Proxy({}, { get() { throw new Error('storage unavailable'); } });
  assert.equal(saveLocalSession(token, now + 10, blocked, now), false);
  assert.equal(readLocalSession(blocked, now), null); assert.doesNotThrow(() => clearLocalSession(blocked));
  assert.equal(saveLocalSession(token, now + 10, null, now), false);
});
