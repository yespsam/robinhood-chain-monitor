import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletGate, ConfirmedQueue } from '../server/policy.mjs';
import { OfficialWallet } from '../server/official-cli.mjs';
import { Sessions } from '../server/auth.mjs';
import { context, testOwner, testPassword } from './helpers.mjs';

test('revoking permission during an awaited wallet check prevents continuation', async () => {
  const c = await context(), gate = new WalletGate(c);
  c.wallet.status = async () => { c.binding.permissions = ['read']; return 'CONNECTED'; };
  await assert.rejects(gate.check(c.key, '56', 'manual'), { code: 'WALLET_BINDING_CHANGED' });
});
test('replacing a binding while wallet status is pending invalidates the old check', async () => {
  const c = await context(), gate = new WalletGate(c);
  c.wallet.status = async () => { gate.binding = { ...c.binding, permissions: ['read'] }; return 'CONNECTED'; };
  await assert.rejects(gate.check(c.key, '56', 'manual'), { code: 'WALLET_BINDING_CHANGED' });
});
test('official expiry is rechecked after slow address/chain requests', async () => {
  const c = await context(), gate = new WalletGate(c);
  const deadline = new Date(c.clock() + 100).toISOString();
  c.wallet.settings = async () => ({ sessionExpireTime: deadline, inactiveSignOutTime: deadline });
  c.wallet.chains = async () => { c.advance(101); return [{ id: '56', name: 'BSC' }]; };
  await assert.rejects(gate.check(c.key, '56'), { code: 'WALLET_AUTH_EXPIRED' });
});
test('malformed provider payloads are rejected instead of converted to empty balances/history', async () => {
  for (const data of [null, {}, 'unexpected']) {
    const wallet = new OfficialWallet(async () => ({ success: true, data }));
    await assert.rejects(wallet.balance('56'), { code: 'OFFICIAL_RESPONSE_INVALID' });
    await assert.rejects(wallet.transactions('56'), { code: 'OFFICIAL_RESPONSE_INVALID' });
    await assert.rejects(wallet.orders('56'), { code: 'OFFICIAL_RESPONSE_INVALID' });
    await assert.rejects(wallet.approvals('56'), { code: 'OFFICIAL_RESPONSE_INVALID' });
  }
});
test('concurrent password derivations are bounded to one attempt', async () => {
  const sessions = new Sessions({ owner: testOwner });
  const first = sessions.login('owner', testPassword);
  await assert.rejects(sessions.login('owner', testPassword), { code: 'LOGIN_BUSY' });
  await first;
});
test('auth URLs containing credentials or a nonstandard port are not sent to the browser', async () => {
  for (const url of ['https://name:synthetic@web3.binance.com/en/agent-login', 'https://web3.binance.com:8443/en/agent-login']) {
    const wallet = new OfficialWallet(async () => ({ success: true, data: { urlForWeb: url, qrCodeId: 'id', pairingCode: '123456' } }));
    await assert.rejects(wallet.beginOfficialSignIn(), { code: 'AUTH_URL_REVIEW_REQUIRED' });
  }
});
test('confirmation must be the boolean true; truthy strings do not authorize a job', async () => {
  const c = await context(), q = new ConfirmedQueue({ gate: new WalletGate(c), sessions: c.sessions, clock: c.clock, execute: () => assert.fail() });
  assert.throws(() => q.enqueue({ id: 'synthetic-job-01', key: c.key, chainId: '56', confirmed: 'false', expiresAt: c.clock() + 1000, review: { amount: '1' } }), { code: 'CONFIRMATION_NOT_EXECUTABLE' });
});
test('backwards local clock does not extend a session', async () => {
  const c = await context(); c.advance(-1000);
  assert.throws(() => c.sessions.byKey(c.key), { code: 'SESSION_CLOCK_INVALID' });
});
