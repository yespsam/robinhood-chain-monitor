// This is a short-lived capability for this browser tab's local dashboard session.
// Never put launch keys, Binance credentials, addresses, balances, or auth URLs here.
export const SESSION_STORAGE_KEY = 'yesp.local-session.v1';
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
// A cached deadline can be stale after another tab revalidates the same session.
// Keeping it briefly only permits a server-side check; it never grants access locally.
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const valid = (value, now) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && Object.keys(value).every(key => ['token', 'expiresAt'].includes(key))
  && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)
  && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now - MAX_STALE_MS && value.expiresAt <= now + MAX_LIFETIME_MS;
const storageFor = () => { try { return globalThis.sessionStorage; } catch { return null; } };
export function clearLocalSession(storage = storageFor()) {
  try { storage?.removeItem(SESSION_STORAGE_KEY); } catch { /* Storage can be disabled by the browser. */ }
}
export function readLocalSession(storage = storageFor(), now = Date.now()) {
  try {
    const raw = storage?.getItem(SESSION_STORAGE_KEY); if (!raw) return null;
    const value = JSON.parse(raw);
    if (!valid(value, now)) { clearLocalSession(storage); return null; }
    return { token: value.token, expiresAt: value.expiresAt };
  } catch { clearLocalSession(storage); return null; }
}
export function saveLocalSession(token, expiresAt, storage = storageFor(), now = Date.now()) {
  const value = { token, expiresAt };
  if (!valid(value, now) || expiresAt <= now) { clearLocalSession(storage); return false; }
  try { if (!storage) return false; storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value)); return true; }
  catch { return false; }
}
