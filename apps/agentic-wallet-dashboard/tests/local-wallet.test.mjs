import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalWalletAccess } from '../server/local-wallet.mjs';
import { createApplication } from '../server/app.mjs';
import { Sessions } from '../server/auth.mjs';
import { NATIVE } from '../server/model.mjs';
const address = '0x1111111111111111111111111111111111111111';
function setup() {
  let now = Date.now(), calls = [];
  const wallet = {
    async beginOfficialSignIn() { calls.push('signin'); return { alreadyConnected: true }; },
    async status() { return 'CONNECTED'; },
    async settings() { return { sessionExpireTime: new Date(now + 3600000).toISOString(), inactiveSignOutTime: new Date(now + 3600000).toISOString() }; },
    async chains() { return [{ id: '56', name: 'BSC' }]; },
    async addresses() { return [{ chainId: '56', address }]; },
    async balance() { calls.push('balance'); return [{ chainId: '56', symbol: 'BNB', contract: NATIVE, balance: '0.1', priceUsd: null }]; },
    async quote(body) { calls.push('quote'); return { ...body, mode: 'official-quote', estimatedOut: '10', gasTotal: null, approvalPlan: null }; },
    async officialSignOut() { calls.push('signout'); return { localSessionCleared: true }; }
  };
  const local = new LocalWalletAccess(wallet, () => now);
  const key = local.bootstrap().token;
  return { local, wallet, key, calls, advance: ms => { now += ms; } };
}
async function bind(c) {
  await c.local.start(c.key); await c.local.verification;
  const candidate = c.local.state(c.key);
  await c.local.bind(c.key, { candidateId: candidate.candidateId, confirmed: true }); return c;
}
test('no vendor call on opening; an existing CLI login needs explicit address confirmation', async () => {
  const c = setup(); assert.deepEqual(c.calls, []); assert.equal(c.local.state(c.key).walletConnected, false);
  assert.equal((await c.local.start(c.key)).phase, 'CHECKING'); await c.local.verification;
  const s = c.local.state(c.key); assert.equal(s.phase, 'REVIEW'); assert.equal(s.walletConnected, false); assert.deepEqual(c.calls, []);
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets' }), { code: 'WALLET_NOT_BOUND' });
  await assert.rejects(c.local.bind(c.key, { candidateId: s.candidateId, confirmed: 'true' }), { code: 'WALLET_CONFIRMATION_REQUIRED' });
  await assert.rejects(c.local.bind(c.key, { candidateId: 'other', confirmed: true }), { code: 'WALLET_CONFIRMATION_REQUIRED' });
  await c.local.bind(c.key, { candidateId: s.candidateId, confirmed: true });
  assert.deepEqual(c.local.gate.binding.permissions, ['read']); assert.equal(c.local.state(c.key).capabilities.liveTrades, false);
});
test('official QR link and code are verbatim, private QR identifier never reaches browser', async () => {
  const c = setup(); let complete, received, connected = false;
  c.wallet.status = async () => connected ? 'CONNECTED' : 'UNCONNECTED';
  c.wallet.beginOfficialSignIn = async () => ({ urlForWeb: 'https://web3.binance.com/en/agent-login?url=synthetic', pairingCode: '012345', qrCodeId: 'private-id', expireAt: String(Date.now() + 300000) });
  c.wallet.verifyOfficialSignIn = async qr => { received = qr; return new Promise(resolve => { complete = resolve; }); };
  await c.local.start(c.key); await new Promise(setImmediate);
  const result = c.local.state(c.key); assert.equal(result.phase, 'WAITING'); assert.equal(result.pairingCode, '012345'); assert.equal(result.qrCodeId, undefined);
  assert.equal(received, 'private-id'); await assert.rejects(c.local.start(c.key), { code: 'AUTH_IN_PROGRESS' });
  connected = true; complete({ verified: true }); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'REVIEW'); assert.equal(c.local.state(c.key).urlForWeb, undefined);
});
test('closing local session during QR verification cannot bind a later successful response', async () => {
  const c = setup(); let complete;
  c.wallet.status = async () => 'UNCONNECTED';
  c.wallet.beginOfficialSignIn = async () => ({ urlForWeb: 'https://web3.binance.com/', pairingCode: '012345', qrCodeId: 'private-id' });
  c.wallet.verifyOfficialSignIn = () => new Promise(resolve => { complete = resolve; });
  await c.local.start(c.key); await new Promise(setImmediate); c.local.lock(); complete({ verified: true }); await c.local.verification;
  assert.equal(c.local.gate.binding, null); assert.equal(c.local.flow, null); assert.equal(c.local.busy, false);
});
test('failed official verification does not create a connected wallet', async () => {
  const c = setup(); c.wallet.beginOfficialSignIn = async () => ({ qrCodeId: 'private-id' });
  c.wallet.status = async () => 'UNCONNECTED';
  c.wallet.verifyOfficialSignIn = async () => ({ verified: false });
  await c.local.start(c.key); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'FAILED'); assert.equal(c.local.state(c.key).walletConnected, false);
});
test('scoped reads and quotes work; client wallet injection and all financial writes remain denied', async () => {
  const c = await bind(setup());
  const result = await c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets' });
  assert.equal(result.walletAddress, address); assert.equal(result.assets[0].valueUsd, null); assert.equal(result.pnl, null);
  const q = await c.local.handle('/api/wallet/quote', c.key, { chainId: '56', fromToken: NATIVE, toToken: address, amount: '0.1', slippage: '0.5' });
  assert.equal(q.wallet, address); assert.equal(q.executable, false); assert.ok(q.blockers.length > 0);
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets', wallet: 'other' }), { code: 'UNEXPECTED_FIELD' });
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '1', kind: 'assets' }), { code: 'CHAIN_OUTSIDE_BINDING' });
  for (const path of ['/api/trade/submit', '/api/trade/enable', '/api/limit/submit', '/api/limit/cancel', '/api/approval/revoke', '/api/strategy/start', '/api/wallet/verify'])
    await assert.rejects(c.local.handle(path, c.key, { confirmed: true }), { code: 'LIVE_TRANSACTION_REVIEW_INCOMPLETE' });
});
test('wallet mismatch or expired authorization locks reads before releasing private results', async () => {
  for (const kind of ['mismatch', 'expiry', 'disconnected']) {
    const c = await bind(setup());
    if (kind === 'mismatch') c.wallet.addresses = async () => [{ chainId: '56', address: '0x2222222222222222222222222222222222222222' }];
    if (kind === 'expiry') c.wallet.settings = async () => ({ sessionExpireTime: 'invalid', inactiveSignOutTime: 'invalid' });
    if (kind === 'disconnected') c.wallet.status = async () => 'UNCONNECTED';
    await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets' }));
    assert.equal(c.local.client, null); assert.ok(!c.calls.includes('balance'));
  }
});
test('lock during a read suppresses stale sensitive data; old tab and idle sessions cannot query', async () => {
  const c = await bind(setup()); c.wallet.balance = async () => { c.local.lock(); return []; };
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'assets' }), { code: 'LOCAL_SESSION_EXPIRED' });
  const d = await bind(setup()); d.local.bootstrap();
  await assert.rejects(d.local.handle('/api/wallet/read', d.key, { chainId: '56', kind: 'assets' }), { code: 'LOCAL_SESSION_EXPIRED' });
  const e = setup(); e.advance(600001);
  await assert.rejects(e.local.handle('/api/local/state', e.key, {}), { code: 'LOCAL_SESSION_EXPIRED' });
});
test('dashboard disconnect does not sign out CLI; separate confirmed signout does', async () => {
  const c = await bind(setup()); await c.local.handle('/api/local/lock', c.key, {}); assert.ok(!c.calls.includes('signout'));
  const d = await bind(setup()); await assert.rejects(d.local.handle('/api/wallet/signout', d.key, { confirmed: false }), { code: 'CONFIRMATION_REQUIRED' });
  const result = await d.local.handle('/api/wallet/signout', d.key, { confirmed: true });
  assert.equal(result.localSessionCleared, true); assert.equal(d.local.client, null); assert.equal(d.calls.filter(x => x === 'signout').length, 1);
  await assert.rejects(d.local.handle('/api/wallet/signout', d.key, { confirmed: true }), { code: 'LOCAL_SESSION_EXPIRED' });
});
test('clock rollback fails closed and polling alone cannot extend the local session', async () => {
  const c = setup(); c.advance(-1); assert.throws(() => c.local.state(c.key), { code: 'LOCAL_SESSION_EXPIRED' });
  const d = setup(); d.advance(599999); d.local.state(d.key); d.advance(1);
  assert.throws(() => d.local.state(d.key), { code: 'LOCAL_SESSION_EXPIRED' });
});
test('HTTP live mode requires same-origin JSON and tab capability, never sets cookies or logs in owner', async t => {
  const c = setup(), app = await createApplication({ sessions: new Sessions(), wallet: c.wallet, localAccess: true, walletAccess: true }); t.after(() => app.close());
  const post = (path, body = {}, headers = {}) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const publicState = await (await fetch(app.origin + '/api/status')).json(); assert.equal(publicState.capabilities.liveWalletAuth, true); assert.equal(publicState.walletConnected, false);
  assert.equal((await post('/api/wallet/signin')).status, 401);
  assert.equal((await post('/api/local/session', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/local/session', {}, { 'Content-Type': 'text/plain' })).status, 415);
  const session = await post('/api/local/session'); assert.equal(session.headers.get('set-cookie'), null); const { token } = await session.json();
  const h = { 'X-Local-Session': token };
  const initial = await (await post('/api/wallet/signin', {}, h)).json(); assert.equal(initial.phase, 'CHECKING');
  await app.localWallet.verification;
  const s = await (await post('/api/local/state', {}, h)).json();
  assert.equal(s.phase, 'REVIEW'); assert.equal(s.qrCodeId, undefined);
  assert.equal((await post('/api/wallet/bind', { candidateId: s.candidateId, confirmed: true }, h)).status, 200);
  assert.equal((await post('/api/wallet/read', { chainId: '56', kind: 'assets' }, h)).status, 200);
  assert.equal((await post('/api/trade/submit', { confirmed: true }, h)).status, 403);
  assert.equal((await fetch(app.origin + '/wallet.js')).status, 200); assert.equal(app.sessions.items.size, 0);
});

test('expired QR data disappears while the original verification keeps running without retries', async () => {
  const c = setup(); let complete, verifies = 0;
  const expiry = Date.now() + 300000;
  c.wallet.status = async () => 'UNCONNECTED';
  c.wallet.beginOfficialSignIn = async () => ({ urlForWeb: 'https://www.binance.com/synthetic-qr?url=a%2Bb', pairingCode: '012345', qrCodeId: 'synthetic', expireAt: String(expiry) });
  c.wallet.verifyOfficialSignIn = async () => { verifies++; return new Promise(resolve => { complete = resolve; }); };
  await c.local.start(c.key); await new Promise(setImmediate);
  assert.equal(c.local.state(c.key).authQrExpired, false);
  c.advance(300001);
  const expired = c.local.state(c.key);
  assert.equal(expired.phase, 'WAITING'); assert.equal(expired.authQrExpired, true);
  assert.equal(expired.urlForWeb, undefined); assert.equal(expired.pairingCode, undefined);
  assert.equal(c.local.busy, true); assert.equal(verifies, 1);
  complete({ verified: false }); await c.local.verification;
  assert.equal(c.local.state(c.key).urlForWeb, undefined);
});
test('malformed QR expiry never releases the authentication payload', async () => {
  const c = setup(); let complete;
  c.wallet.status = async () => 'UNCONNECTED';
  c.wallet.beginOfficialSignIn = async () => ({ urlForWeb: 'https://www.binance.com/synthetic-qr', pairingCode: '012345', qrCodeId: 'synthetic', expireAt: 'unknown' });
  c.wallet.verifyOfficialSignIn = () => new Promise(resolve => { complete = resolve; });
  await c.local.start(c.key); await new Promise(setImmediate);
  const s = c.local.state(c.key); assert.equal(s.authQrExpired, true); assert.equal(s.urlForWeb, undefined); assert.equal(s.pairingCode, undefined);
  complete({ verified: false }); await c.local.verification;
});
