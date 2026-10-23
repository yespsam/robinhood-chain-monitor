import { hashPassword, Sessions } from '../server/auth.mjs';
export const testPassword = 'Synthetic test identity only 2026!';
export const testOwner = await hashPassword(testPassword);
export const testAddress = '0x1111111111111111111111111111111111111111';
export async function context({ idleMs, absoluteMs } = {}) {
  let now = Date.now();
  const sessions = new Sessions({ owner: testOwner, clock: () => now, idleMs, absoluteMs });
  const login = await sessions.login('owner', testPassword);
  const binding = { owner: 'owner', sessionKey: login.session.key, userConfirmed: true, permissions: ['read', 'manual'], addresses: { '56': testAddress } };
  let calls = 0;
  const wallet = {
    async status() { calls++; return 'CONNECTED'; },
    async settings() { calls++; return { sessionExpireTime: new Date(now + 3_600_000).toISOString(), inactiveSignOutTime: new Date(now + 3_600_000).toISOString() }; },
    async chains() { calls++; return [{ id: '56', name: 'BSC' }]; },
    async addresses() { calls++; return [{ chainId: '56', address: testAddress }]; },
    async balance() { calls++; return []; }
  };
  return { sessions, login, binding, wallet, key: login.session.key, clock: () => now, advance: ms => { now += ms; }, calls: () => calls };
}
