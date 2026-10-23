import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server/app.mjs';
import { Sessions } from '../server/auth.mjs';
import { ManualTradeService, BSC_TRUSTED_TOKENS } from '../server/manual-trade.mjs';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const ACCESS = 'a'.repeat(64), HASH = '0x' + 'b'.repeat(64);
const [BNB, USDT] = BSC_TRUSTED_TOKENS;
const URL = 'https://app.binance.com/synthetic-login?url=a%2Bb%26c&synthetic=true';
const TRADE = { chainId: '56', fromToken: BNB, toToken: USDT, amount: '0.01', slippage: '1' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function setup(t, { connected = false, execute } = {}) {
  let now = Date.now(), address = ADDRESS, orderStatus = 'PENDING';
  const verify = deferred(), counters = { signin: 0, verify: 0, signout: 0, bind: 0, swap: 0, orders: 0 };
  const wallet = {
    async status() { return connected ? 'CONNECTED' : 'UNCONNECTED'; },
    async settings() { return { sessionExpireTime: new Date(now + 3_600_000).toISOString(), inactiveSignOutTime: new Date(now + 3_600_000).toISOString() }; },
    async chains() { return [{ id: '56', name: 'BNB Smart Chain' }]; },
    async addresses() { return [{ chainId: '56', address }]; },
    async beginOfficialSignIn() { counters.signin++; return { urlForWeb: URL, pairingCode: 'abc123', qrCodeId: 'synthetic-qr', expireAt: String(now + 300_000) }; },
    async verifyOfficialSignIn(qr) { assert.equal(qr, 'synthetic-qr'); counters.verify++; return verify.promise; },
    async officialSignOut() { counters.signout++; return { localSessionCleared: true }; },
    async balance(chainId, contract) { return [{ chainId, contract, balance: '1' }]; },
    async txLock() { return { status: 'UNLOCKED' }; },
    async gasPrice() { return { medium: { gasPrice: '0.05' } }; },
    async quote(body) { return { ...body, mode: 'official-quote', slippagePercent: body.slippage, estimatedOut: '10', fromSymbol: 'BNB', toSymbol: 'USDT' }; }
  };
  const directory = await mkdtemp(join(tmpdir(), 'wallet-refresh-test-'));
  const app = await createApplication({ sessions: new Sessions(), wallet, localAccess: true, walletAccess: true, localAccessKey: ACCESS,
    manualTradeFactory: ({ wallet, gate }) => new ManualTradeService({ wallet, gate, clock: () => now, journalDir: join(directory, 'trades'),
      executeSwap: async trade => { counters.swap++; assert.deepEqual(trade, TRADE); return execute ? execute(trade) : { status: 'SUBMITTED', orderId: '123' }; },
      readOrder: async ({ orderId, chainId }) => { counters.orders++; return { list: [{ orderId, chain: chainId, fromToken: BNB, toToken: USDT,
        fromTokenQty: TRADE.amount, status: orderStatus, txHash: orderStatus === 'FINISHED' ? HASH : null, toTokenActualQty: orderStatus === 'FINISHED' ? '9.99' : null }] }; }
    }) });
  app.localWallet.clock = () => now; app.localWallet.gate.clock = () => now;
  const originalBind = app.localWallet.bind.bind(app.localWallet);
  app.localWallet.bind = (...args) => { counters.bind++; return originalBind(...args); };
  t.after(async () => { verify.resolve({ verified: false }); await app.localWallet.verification; await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function post(path, body = {}, key, { launch = false, headers = {}, signal } = {}) {
    const response = await fetch(app.origin + path, { method: 'POST', signal,
      headers: { Origin: app.origin, 'Content-Type': 'application/json', ...(key ? { 'X-Local-Session': key } : {}), ...(launch ? { 'X-Local-Access': ACCESS } : {}), ...headers },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const bootstrap = await post('/api/local/session', {}, undefined, { launch: true });
  assert.equal(bootstrap.status, 200); assert.equal(bootstrap.headers.get('set-cookie'), null);
  const key = bootstrap.body.token;
  return { app, key, post, counters, get now() { return now; }, advance(ms) { now += ms; }, address(value) { address = value; },
    completeAuth() { connected = true; verify.resolve({ verified: true }); }, finishOrder() { orderStatus = 'FINISHED'; },
    restore: () => post('/api/local/state', {}, key),
    async connect() {
      assert.equal((await post('/api/wallet/check', {}, key)).status, 200); await app.localWallet.verification;
      const review = await post('/api/local/state', {}, key); assert.equal(review.body.phase, 'REVIEW');
      assert.equal((await post('/api/wallet/bind', { candidateId: review.body.candidateId, confirmed: true }, key)).status, 200);
    }
  };
}

test('HTTP refresh restores the same waiting QR and single server waiter without the launch key', async t => {
  const c = await setup(t);
  assert.equal((await c.post('/api/wallet/signin', {}, c.key)).status, 200);
  await new Promise(setImmediate);
  const flow = c.app.localWallet.flow, waiter = c.app.localWallet.verification;
  for (let i = 0; i < 3; i++) {
    const state = await c.restore();
    assert.equal(state.status, 200); assert.equal(state.body.phase, 'WAITING'); assert.equal(state.body.urlForWeb, URL);
    assert.equal(state.body.pairingCode, 'abc123'); assert.equal(state.body.qrCodeId, undefined);
    assert.equal(state.headers.get('set-cookie'), null); assert.match(state.headers.get('cache-control'), /no-store/);
    assert.equal(c.app.localWallet.client.key, c.key); assert.equal(c.app.localWallet.flow, flow); assert.equal(c.app.localWallet.verification, waiter);
  }
  assert.equal(c.counters.signin, 1); assert.equal(c.counters.verify, 1); assert.equal(c.counters.bind, 0); assert.equal(c.counters.swap, 0);
  c.completeAuth(); await waiter;
  const review = await c.restore(); assert.equal(review.body.phase, 'REVIEW'); assert.equal(review.body.walletConnected, false); assert.equal(review.body.urlForWeb, undefined);
  assert.equal(c.counters.bind, 0); assert.equal(c.app.localWallet.gate.binding, null);
});

test('refresh preserves reviewed and bound identity without another login or binding', async t => {
  const c = await setup(t, { connected: true });
  await c.post('/api/wallet/check', {}, c.key); await c.app.localWallet.verification;
  const review = await c.restore(), candidate = review.body.candidateId;
  assert.equal((await c.restore()).body.candidateId, candidate); assert.equal(c.counters.bind, 0);
  await c.post('/api/wallet/bind', { candidateId: candidate, confirmed: true }, c.key);
  const binding = c.app.localWallet.gate.binding;
  for (let i = 0; i < 3; i++) {
    const state = await c.restore(); assert.equal(state.status, 200); assert.equal(state.body.phase, 'CONNECTED'); assert.equal(state.body.walletConnected, true);
    assert.equal(c.app.localWallet.gate.binding, binding); assert.equal(c.app.localWallet.client.key, c.key);
  }
  assert.deepEqual(c.counters, { signin: 0, verify: 0, signout: 0, bind: 1, swap: 0, orders: 0 });
});

test('refresh cannot revive expired QR payloads or extend the idle session deadline', async t => {
  const c = await setup(t); await c.post('/api/wallet/signin', {}, c.key); await new Promise(setImmediate);
  const expiresAt = c.app.localWallet.client.expiresAt;
  c.advance(300_001);
  const qr = await c.restore(); assert.equal(qr.status, 200); assert.equal(qr.body.authQrExpired, true);
  assert.equal(qr.body.urlForWeb, undefined); assert.equal(qr.body.pairingCode, undefined); assert.equal(c.app.localWallet.client.expiresAt, expiresAt);
  c.advance(300_000);
  const expired = await c.restore(); assert.equal(expired.status, 401); assert.equal(expired.body.error, 'LOCAL_SESSION_EXPIRED');
  assert.equal(c.app.localWallet.client, null); assert.equal(c.counters.signin, 1); assert.equal(c.counters.verify, 1);
  assert.equal((await c.post('/api/local/session', {}, c.key)).status, 401); // Old nonce is not the launch capability.
});

test('explicit lock, clock rollback and a changed wallet reject restoration without signing out Binance', async t => {
  const c = await setup(t, { connected: true }); await c.connect();
  assert.equal((await c.post('/api/local/lock', {}, c.key)).status, 200);
  assert.equal((await c.restore()).status, 401); assert.equal(c.counters.signout, 0);
  const d = await setup(t, { connected: true }); await d.connect(); d.advance(-1);
  assert.equal((await d.restore()).status, 401); assert.equal(d.counters.signout, 0);
  const e = await setup(t, { connected: true }); await e.connect(); e.address(OTHER_ADDRESS);
  const mismatch = await e.restore(); assert.equal(mismatch.status, 403); assert.equal(mismatch.body.error, 'WALLET_IDENTITY_MISMATCH');
  assert.equal(e.app.localWallet.client, null); assert.equal(e.counters.bind, 1); assert.equal(e.counters.swap, 0);
});

test('restoration is scoped to the existing server and same-origin request capability', async t => {
  const c = await setup(t), d = await setup(t);
  assert.equal((await c.post('/api/local/state')).status, 401);
  assert.equal((await c.post('/api/local/state', {}, c.key, { headers: { Origin: d.app.origin } })).status, 403);
  assert.equal((await d.post('/api/local/state', {}, c.key)).status, 401);
  assert.equal((await c.post('/api/local/state', {}, c.key, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await c.restore()).status, 200); assert.equal(c.counters.signin, 0); assert.equal(d.counters.signin, 0);
});

test('refresh during submitted trading performs only list/status reconciliation and never another swap', async t => {
  const c = await setup(t, { connected: true }); await c.connect();
  const review = await c.post('/api/trade/preview', TRADE, c.key); assert.equal(review.status, 200);
  const submit = await c.post('/api/trade/submit', { reviewId: review.body.reviewId, confirmed: true, costAcknowledged: true }, c.key);
  assert.equal(submit.status, 200); assert.equal(submit.body.status, 'SUBMITTED'); assert.equal(c.counters.swap, 1);
  const binding = c.app.localWallet.gate.binding;
  for (let i = 0; i < 3; i++) {
    assert.equal((await c.restore()).body.walletConnected, true);
    const list = await c.post('/api/trade/list', {}, c.key); assert.equal(list.body.list.length, 1); assert.equal(list.body.list[0].intentId, submit.body.intentId);
    const status = await c.post('/api/trade/status', { intentId: submit.body.intentId }, c.key); assert.equal(status.body.status, 'PENDING');
  }
  c.finishOrder(); const result = await c.post('/api/trade/status', { intentId: submit.body.intentId }, c.key);
  assert.equal(result.body.status, 'FINISHED'); assert.equal(result.body.actualReceived, '9.99'); assert.equal(result.body.txHash, HASH);
  assert.equal(c.app.localWallet.gate.binding, binding); assert.equal(c.counters.bind, 1); assert.equal(c.counters.swap, 1); assert.equal(c.counters.signin, 0);
});

test('refresh preserves UNKNOWN submission and blocks a fresh trade instead of retrying', async t => {
  const c = await setup(t, { connected: true, execute: async () => ({ status: 'UNKNOWN', orderId: null }) }); await c.connect();
  const preview = await c.post('/api/trade/preview', TRADE, c.key);
  const submit = await c.post('/api/trade/submit', { reviewId: preview.body.reviewId, confirmed: true, costAcknowledged: true }, c.key);
  assert.equal(submit.body.status, 'UNKNOWN'); await c.restore();
  const list = await c.post('/api/trade/list', {}, c.key); assert.equal(list.body.list[0].status, 'UNKNOWN');
  const status = await c.post('/api/trade/status', { intentId: submit.body.intentId }, c.key); assert.equal(status.body.status, 'UNKNOWN'); assert.equal(status.body.canRetry, false);
  const fresh = await c.post('/api/trade/preview', TRADE, c.key);
  const blocked = await c.post('/api/trade/submit', { reviewId: fresh.body.reviewId, confirmed: true, costAcknowledged: true }, c.key);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'UNRESOLVED_TRADE_EXISTS'); assert.equal(c.counters.swap, 1); assert.equal(c.counters.orders, 0);
});

test('refresh disconnecting the submit HTTP response does not cancel or resend the server-owned trade', async t => {
  const entered = deferred(), release = deferred();
  const c = await setup(t, { connected: true, execute: async () => { entered.resolve(); return release.promise; } }); await c.connect();
  const preview = await c.post('/api/trade/preview', TRADE, c.key), controller = new AbortController();
  const response = c.post('/api/trade/submit', { reviewId: preview.body.reviewId, confirmed: true, costAcknowledged: true }, c.key,
    { signal: controller.signal }).then(value => value, error => error);
  try {
    await entered.promise; controller.abort(); assert.equal((await response).name, 'AbortError');
    assert.equal((await c.restore()).body.phase, 'CONNECTED');
    const records = await c.post('/api/trade/list', {}, c.key); assert.equal(records.body.list.length, 1);
    assert.equal(records.body.list[0].status, 'SUBMITTING'); assert.equal(records.body.list[0].successful, false); assert.equal(c.counters.swap, 1);
  } finally { release.resolve({ status: 'SUBMITTED', orderId: '123' }); }
  await Promise.all([...c.app.manualTrades.inFlight.values()]);
  const status = await c.post('/api/trade/status', { intentId: preview.body.intentId }, c.key);
  assert.equal(status.body.status, 'PENDING'); assert.equal(c.counters.swap, 1); assert.equal(c.counters.bind, 1);
});
