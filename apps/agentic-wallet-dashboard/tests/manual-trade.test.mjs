import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletGate } from '../server/policy.mjs';
import { Denied } from '../server/auth.mjs';
import { ManualTradeService, BSC_TRUSTED_TOKENS, buildSwapArgs } from '../server/manual-trade.mjs';

const [BNB, USDT, USDC] = BSC_TRUSTED_TOKENS;
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'a'.repeat(64);
const KEY = 'never-persist-this-browser-session';
const request = { chainId: '56', fromToken: USDT, toToken: BNB, amount: '10.123456789012345678', slippage: '2.5' };
const confirm = review => ({ reviewId: review.reviewId, confirmed: true, riskAcknowledged: true, costAcknowledged: true });
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'manual-trade-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1800000000000, active = true, quote = '2.123456789012345678', lock = 'UNLOCKED', native = '1', source = '1000000000000000000';
  let executeCount = 0, auditCount = 0, order = null, lastExecution = null;
  const sessions = { byKey(key) { if (!active || key !== KEY) throw new Denied('SESSION_REQUIRED', 401); return { owner: 'test' }; }, invalidateAll() { active = false; } };
  const wallet = {
    async status() { return 'CONNECTED'; }, async settings() { return { sessionExpireTime: new Date(now + 3600000).toISOString(), inactiveSignOutTime: new Date(now + 3600000).toISOString() }; },
    async chains() { return [{ id: '56' }]; }, async addresses() { return [{ chainId: '56', address: WALLET }]; },
    async balance(chain, contract) { return [{ chainId: chain, contract, balance: contract.toLowerCase() === BNB.toLowerCase() ? native : source }]; },
    async quote(r) { return { ...r, mode: 'official-quote', estimatedOut: quote, slippagePercent: r.slippage, fromSymbol: 'FROM', toSymbol: 'TO' }; },
    async call(args) { if (args.join(' ') === 'wallet tx-lock --binanceChainId 56') return { status: lock }; if (args.join(' ') === 'wallet gas-price --binanceChainId 56') return { medium: { gasPrice: '0.05' } }; throw new Error('Unexpected CLI call'); }
  };
  const gate = new WalletGate({ sessions, wallet, clock: () => now, binding: { sessionKey: KEY, owner: 'test', userConfirmed: true, permissions: ['read', 'manual'], addresses: { '56': WALLET } } });
  const config = { wallet, gate, clock: () => now, journalDir: join(directory, 'trades'),
    executeSwap: async trade => { executeCount++; lastExecution = trade; return options.execute ? options.execute(trade) : { status: 'SUBMITTED', orderId: 'order-1' }; },
    readOrder: async () => ({ list: order ? [order] : [] }),
    auditTarget: async () => { auditCount++; return options.audit || { hasResult: true, isSupported: true, status: 'CLEAR', riskItems: [] }; }
  };
  const service = new ManualTradeService(config);
  return { directory, config, service, wallet, gate, get executeCount() { return executeCount; }, get auditCount() { return auditCount; }, get lastExecution() { return lastExecution; },
    advance(ms) { now += ms; }, expire() { active = false; }, quote(value) { quote = value; }, lock(value) { lock = value; }, native(value) { native = value; }, source(value) { source = value; },
    order(value) { order = value; }, row(review, status = 'FINISHED', extra = {}) { return { orderId: 'order-1', chain: '56', fromToken: review.fromToken, toToken: review.toToken, fromTokenQty: review.amount, status, txHash: status === 'FINISHED' ? HASH : null, toTokenActualQty: '2.11', ...extra }; } };
}
test('review retains exact decimals, trusted target skips audit, command forces MEV', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request);
  assert.equal(r.amount, request.amount); assert.equal(c.auditCount, 0); assert.equal(r.risk.state, 'TRUSTED_TARGET');
  assert.equal(r.minimumReferenceOut, '2.070370369287037036'); assert.equal(r.totalGas, null); assert.equal(r.minimumIsReferenceOnly, true);
  const args = buildSwapArgs(r); assert.deepEqual(args.slice(-4), ['--mev', 'true', '--gasLevel', 'MEDIUM']);
  assert.equal(c.executeCount, 0);
});
test('strict fields, chain, token pair, and slippage cannot inject commands', async t => {
  const c = await setup(t);
  for (const bad of [{ ...request, command: 'send' }, { ...request, chainId: '1' }, { ...request, amount: '--max' }, { ...request, slippage: '100' }, { ...request, toToken: request.fromToken }]) await assert.rejects(c.service.preview(KEY, bad));
  assert.equal(c.executeCount, 0);
});
test('confirmation and fee acknowledgment required; submitted is not success', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request);
  await assert.rejects(c.service.submit(KEY, { reviewId: r.reviewId, confirmed: true }), { code: 'TRADE_CONFIRMATION_REQUIRED' });
  await assert.rejects(c.service.submit(KEY, { ...confirm(r), amount: '999' }), { code: 'UNEXPECTED_TRADE_FIELD' });
  const result = await c.service.submit(KEY, confirm(r));
  assert.equal(result.status, 'SUBMITTED'); assert.equal(result.successful, false); assert.equal(result.terminal, false);
  assert.deepEqual(c.lastExecution, request); assert.equal(c.executeCount, 1);
});
test('parallel clicks and repeated review submit execute exactly once', async t => {
  const c = await setup(t, { execute: async () => { await new Promise(r => setTimeout(r, 20)); return { orderId: 'order-1', status: 'SUBMITTED' }; } });
  const r = await c.service.preview(KEY, request), results = await Promise.allSettled([c.service.submit(KEY, confirm(r)), c.service.submit(KEY, confirm(r))]);
  assert.ok(results.some(x => x.status === 'fulfilled')); assert.equal(c.executeCount, 1);
  await c.service.submit(KEY, confirm(r)); assert.equal(c.executeCount, 1);
});
test('expired or deteriorated quotes require a new review without a durable submission', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request); c.advance(120001);
  await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'TRADE_REVIEW_EXPIRED' });
  const r2 = await c.service.preview(KEY, request); c.quote('1.99');
  await assert.rejects(c.service.submit(KEY, confirm(r2)), { code: 'TRADE_QUOTE_CHANGED_REVIEW_REQUIRED' });
  assert.equal(c.executeCount, 0); assert.equal((await c.service.list(KEY)).list.length, 0);
});
test('lock, spending balance, and gas reserve are rechecked before submission', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request);
  c.lock('LOCKED'); await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'WALLET_TRANSACTION_LOCKED' });
  c.lock('UNLOCKED'); c.source('1'); await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'INSUFFICIENT_TRADE_BALANCE' });
  c.source('100'); c.native('0.0001'); await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'INSUFFICIENT_GAS_RESERVE' });
  assert.equal(c.executeCount, 0);
});
test('native max spend cannot consume the configured gas reserve', async t => {
  const c = await setup(t); await assert.rejects(c.service.preview(KEY, { ...request, fromToken: BNB, toToken: USDT, amount: '1' }), { code: 'INSUFFICIENT_GAS_RESERVE' });
});
test('unavailable audit requires explicit risk acknowledgment and strips invalid risk fields', async t => {
  const c = await setup(t, { audit: { hasResult: false, isSupported: false, riskLevel: 'SAFE', riskItems: [{ isHit: true, description: 'unreliable' }] } });
  const r = await c.service.preview(KEY, { ...request, toToken: OTHER });
  assert.equal(r.risk.state, 'UNAVAILABLE'); assert.deepEqual(r.risk.items, []); assert.equal(r.risk.riskLevel, undefined);
  await assert.rejects(c.service.submit(KEY, { ...confirm(r), riskAcknowledged: false }), { code: 'TOKEN_RISK_ACKNOWLEDGMENT_REQUIRED' });
  await c.service.submit(KEY, confirm(r)); assert.equal(c.executeCount, 1);
});
test('explicit risk block cannot be acknowledged away', async t => {
  const c = await setup(t, { audit: { status: 'BLOCKED', blocked: true, hasResult: true, isSupported: true } });
  const r = await c.service.preview(KEY, { ...request, toToken: OTHER }); assert.equal(r.executable, false);
  await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'TOKEN_RISK_BLOCKED' }); assert.equal(c.executeCount, 0);
});
test('unknown submission persists across restart and blocks a new intent', async t => {
  const c = await setup(t, { execute: async () => { throw new Error('secret-bearing timeout detail'); } }), r = await c.service.preview(KEY, request);
  const result = await c.service.submit(KEY, confirm(r)); assert.equal(result.status, 'UNKNOWN'); assert.equal(c.executeCount, 1);
  const restarted = new ManualTradeService(c.config); assert.equal((await restarted.status(KEY, { intentId: r.intentId })).status, 'UNKNOWN');
  await assert.rejects(restarted.submit(KEY, confirm(r)), { code: 'UNKNOWN_TRADE_REVIEW' });
  const r2 = await restarted.preview(KEY, request); await assert.rejects(restarted.submit(KEY, confirm(r2)), { code: 'UNRESOLVED_TRADE_EXISTS' });
  assert.equal(c.executeCount, 1);
});
test('durable intent exists before execute; journal permissions and redaction hold', async t => {
  let c;
  c = await setup(t, { execute: async () => { const files = (await readdir(c.config.journalDir)).filter(x => x.endsWith('.json')); assert.equal(files.length, 1); const data = JSON.parse(await readFile(join(c.config.journalDir, files[0]), 'utf8')); assert.equal(data.status, 'SUBMITTING'); return { orderId: 'order-1' }; } });
  const r = await c.service.preview(KEY, request); await c.service.submit(KEY, confirm(r));
  const path = join(c.config.journalDir, r.intentId + '.json'), body = await readFile(path, 'utf8');
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(c.config.journalDir)).mode & 0o777, 0o700);
  assert.ok(!body.includes(KEY)); assert.ok(!body.includes('sessionKey')); assert.ok(!body.includes('secret-bearing'));
});
test('terminal order is verified by ID, chain, tokens, quantity and actual received field', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request); await c.service.submit(KEY, confirm(r));
  c.order(c.row(r, 'PENDING')); assert.equal((await c.service.status(KEY, { intentId: r.intentId })).successful, false);
  c.order(c.row(r, 'FINISHED', { fromTokenQty: '999' })); await assert.rejects(c.service.status(KEY, { intentId: r.intentId }), { code: 'TRADE_ORDER_MISMATCH' });
  c.order(c.row(r)); const restarted = new ManualTradeService(c.config), out = await restarted.status(KEY, { orderId: 'order-1' });
  assert.equal(out.status, 'FINISHED'); assert.equal(out.actualReceived, '2.11'); assert.equal(out.txHash, HASH); assert.equal(out.successful, true); assert.equal(c.executeCount, 1);
});
test('FINISHED without transaction hash is UNKNOWN, never invented success', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request); await c.service.submit(KEY, confirm(r));
  c.order(c.row(r, 'FINISHED', { txHash: null })); const out = await c.service.status(KEY, { intentId: r.intentId }); assert.equal(out.status, 'UNKNOWN'); assert.equal(out.successful, false);
});
test('explicit rejection is failed and does not require retrying same intent', async t => {
  const c = await setup(t, { execute: async () => ({ outcome: 'REJECTED', code: 'INSUFFICIENT_FUNDS', orderId: null }) }), r = await c.service.preview(KEY, request);
  const result = await c.service.submit(KEY, confirm(r)); assert.equal(result.status, 'FAILED'); assert.equal(result.failureCode, 'INSUFFICIENT_FUNDS');
  await c.service.submit(KEY, confirm(r)); assert.equal(c.executeCount, 1);
});
test('session invalidation during execution hides result but preserves durable outcome', async t => {
  let c; c = await setup(t, { execute: async () => { c.expire(); return { orderId: 'order-1' }; } });
  const r = await c.service.preview(KEY, request); await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'SESSION_REQUIRED' });
  const record = JSON.parse(await readFile(join(c.config.journalDir, r.intentId + '.json'), 'utf8')); assert.equal(record.status, 'SUBMITTED'); assert.equal(c.executeCount, 1);
});
test('session loss after journal persistence still prevents CLI invocation', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request), original = c.service.journal.create.bind(c.service.journal);
  c.service.journal.create = async record => { await original(record); c.expire(); return record; };
  await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'SESSION_REQUIRED' }); assert.equal(c.executeCount, 0);
  const record = JSON.parse(await readFile(join(c.config.journalDir, r.intentId + '.json'), 'utf8')); assert.equal(record.status, 'FAILED');
});
test('restart crash lock and corrupt journal fail closed without submission', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request);
  await mkdir(c.config.journalDir, { recursive: true }); await writeFile(join(c.config.journalDir, '.submission-lock'), '', { mode: 0o600 });
  await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'TRADE_JOURNAL_BUSY' }); assert.equal(c.executeCount, 0);
  await rm(join(c.config.journalDir, '.submission-lock')); await writeFile(join(c.config.journalDir, 'a'.repeat(32) + '.json'), '{broken', { mode: 0o600 });
  await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'TRADE_JOURNAL_INVALID' }); assert.equal(c.executeCount, 0);
});
test('journal symlink is rejected and manual permission is required', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request);
  c.gate.binding.permissions = ['read']; await assert.rejects(c.service.submit(KEY, confirm(r)), { code: 'PERMISSION_DENIED' });
  await mkdir(join(c.directory, 'elsewhere')); await symlink(join(c.directory, 'elsewhere'), c.config.journalDir);
  await assert.rejects(c.service.list(KEY), { code: 'TRADE_JOURNAL_UNSAFE_PATH' }); assert.equal(c.executeCount, 0);
});
test('quoted output cannot be reported as actual received', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request); await c.service.submit(KEY, confirm(r));
  c.order(c.row(r, 'FINISHED', { toTokenActualQty: null, toTokenQty: '999', toCoinAmount: '999' }));
  const result = await c.service.status(KEY, { intentId: r.intentId }); assert.equal(result.successful, true); assert.equal(result.actualReceived, null);
});
test('UNKNOWN with an order ID remains unknown until read-only reconciliation', async t => {
  const c = await setup(t, { execute: async () => ({ outcome: 'UNKNOWN', orderId: 'order-1' }) });
  const r = await c.service.preview(KEY, request), result = await c.service.submit(KEY, confirm(r));
  assert.equal(result.status, 'UNKNOWN'); assert.equal(result.orderId, 'order-1'); assert.equal(result.canRetry, false);
  c.order(c.row(r)); assert.equal((await c.service.status(KEY, { intentId: r.intentId })).status, 'FINISHED'); assert.equal(c.executeCount, 1);
});
test('stale SUBMITTING is shown as UNKNOWN after restart and filenames bind to intent IDs', async t => {
  const c = await setup(t), r = await c.service.preview(KEY, request); await c.service.submit(KEY, confirm(r));
  const path = join(c.config.journalDir, r.intentId + '.json'), record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...record, status: 'SUBMITTING', orderId: null }), { mode: 0o600 });
  const restarted = new ManualTradeService(c.config); assert.equal((await restarted.list(KEY)).list[0].status, 'UNKNOWN');
  const r2 = await restarted.preview(KEY, request); await assert.rejects(restarted.submit(KEY, confirm(r2)), { code: 'UNRESOLVED_TRADE_EXISTS' });
  await writeFile(path, JSON.stringify({ ...record, intentId: 'f'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(restarted.status(KEY, { intentId: r.intentId }), { code: 'TRADE_JOURNAL_INVALID' }); assert.equal(c.executeCount, 1);
});
test('unknown audit requires acknowledgment even if provider support flags are true', async t => {
  const c = await setup(t, { audit: { hasResult: true, isSupported: true, status: 'UNKNOWN', riskItems: [] } });
  const r = await c.service.preview(KEY, { ...request, toToken: OTHER }); assert.equal(r.requiresRiskAcknowledgment, true); assert.equal(r.risk.state, 'UNAVAILABLE');
});
test('provider risk acknowledgment remains required even without itemized hits', async t => {
  const c = await setup(t, { audit: { hasResult: true, isSupported: true, status: 'WARNING', requiresAcknowledgment: true, riskLevel: 2, riskItems: [] } });
  const r = await c.service.preview(KEY, { ...request, toToken: OTHER }); assert.equal(r.requiresRiskAcknowledgment, true); assert.equal(r.risk.riskLevel, '2'); assert.deepEqual(r.risk.items, []);
  await assert.rejects(c.service.submit(KEY, { ...confirm(r), riskAcknowledged: false }), { code: 'TOKEN_RISK_ACKNOWLEDGMENT_REQUIRED' }); assert.equal(c.executeCount, 0);
});
test('protected HTTP routes integrate real gate and trade engine using mock wallet only', async t => {
  const { createApplication } = await import('../server/app.mjs'), { Sessions } = await import('../server/auth.mjs');
  const c = await setup(t), accessKey = 'e'.repeat(64);
  const app = await createApplication({ sessions: new Sessions(), wallet: c.wallet, localAccess: true, walletAccess: true, localAccessKey: accessKey,
    manualTradeFactory: ({ wallet, gate }) => new ManualTradeService({ ...c.config, wallet, gate }) });
  t.after(() => app.close());
  const post = async (path, body = {}, key) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Local-Access': accessKey, ...(key ? { 'X-Local-Session': key } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const session = await post('/api/local/session'), key = session.body.token;
  assert.equal(session.status, 200); await post('/api/wallet/check', {}, key); await app.localWallet.verification;
  const state = await post('/api/local/state', {}, key); assert.equal(state.body.phase, 'REVIEW');
  const binding = await post('/api/wallet/bind', { candidateId: state.body.candidateId, confirmed: true }, key); assert.equal(binding.status, 200); assert.equal(binding.body.capabilities.manualTrades, true);
  const preview = await post('/api/trade/preview', request, key); assert.equal(preview.status, 200); assert.equal(preview.body.executable, true);
  const submit = await post('/api/trade/submit', confirm(preview.body), key); assert.equal(submit.status, 200); assert.equal(submit.body.status, 'SUBMITTED');
  c.order(c.row(preview.body)); const result = await post('/api/trade/status', { intentId: preview.body.intentId }, key);
  assert.equal(result.status, 200); assert.equal(result.body.successful, true);
  assert.equal((await post('/api/trade/list', {}, key)).body.list.length, 1); assert.equal(c.executeCount, 1);
  await post('/api/local/lock', {}, key); assert.equal((await post('/api/trade/list', {}, key)).status, 401);
});
