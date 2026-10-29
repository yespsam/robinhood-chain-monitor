import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletGate } from '../server/policy.mjs';
import { Denied } from '../server/auth.mjs';
import { encodeFlapNewToken, FLAP_BSC_PORTAL, FlapMintService } from '../server/flap-mint.mjs';
import { createManualCli } from '../server/manual-cli.mjs';
import { NATIVE } from '../server/model.mjs';

const KEY = 'mint-test-session';
const WALLET = '0x1111111111111111111111111111111111111111';
const HASH = '0x' + 'a'.repeat(64);
const input = { name: 'Example Token', symbol: 'EXAMPLE', metadataUri: 'ipfs://bafybeigdyrzt/example.json' };
const word = data => BigInt('0x' + data).toString(10);

function fixture(t, options = {}) {
  const directoryPromise = mkdtemp(join(tmpdir(), 'flap-mint-test-'));
  const clock = () => 1_800_000_000_000;
  const sessions = { byKey(key) { if (key !== KEY) throw new Denied('SESSION_REQUIRED', 401); return { owner: 'owner' }; } };
  const binding = { sessionKey: KEY, owner: 'owner', userConfirmed: true, permissions: ['read', 'manual'], addresses: { '56': WALLET } };
  const wallet = {
    async status() { return 'CONNECTED'; },
    async settings() { const expires = new Date(clock() + 3_600_000).toISOString(); return { sessionExpireTime: expires, inactiveSignOutTime: expires, devMode: { enabled: options.devMode !== false } }; },
    async chains() { return [{ id: '56', name: 'BNB Smart Chain' }]; },
    async addresses() { return [{ chainId: '56', address: WALLET }]; },
    async txLock() { return options.lock || 'UNLOCKED'; },
    async balance(chain, contract) { return [{ chainId: chain, contract, balance: options.balance || '1.25' }]; }
  };
  const gate = new WalletGate({ sessions, wallet, binding, clock });
  let previewCalls = 0, executeCalls = 0, lastCall, requestId = 'preview-id-1234';
  const previewContractCall = async call => {
    previewCalls++; lastCall = call;
    return options.previewResult || { kind: 'success', data: {
      requestId, parsedTx: { transactionType: 'ContractCall', contractAddress: FLAP_BSC_PORTAL, amount: '0' },
      simulationResult: { simulationCode: '000000000', preCheckCode: '', authorityChanges: [], allowanceChanges: [], balanceChanges: [] },
      risks: { riskDetails: [], addresses: {}, riskBehaviors: [] }, requireConfirmation: false, expiresAt: clock() + 60_000
    } };
  };
  const executeContractCall = async id => { executeCalls++; assert.equal(id, requestId); return options.executeResult || { status: 'BROADCASTED', orderId: 'order-1', txHash: HASH }; };
  const config = { wallet, gate, previewContractCall, executeContractCall, clock };
  const servicePromise = directoryPromise.then(directory => new FlapMintService({ ...config, journalDir: join(directory, 'mints') }));
  t.after(async () => rm(await directoryPromise, { recursive: true, force: true }));
  return { clock, wallet, gate, servicePromise, calls: () => ({ previewCalls, executeCalls, lastCall }), setRequestId: x => { requestId = x; } };
}

test('Flap encoder uses the fixed method selector and canonical ABI string offsets', () => {
  const data = encodeFlapNewToken(input).slice(2);
  assert.equal(data.slice(0, 8), '2ca9cd6d');
  const head = data.slice(8, 8 + 192);
  assert.deepEqual([0, 64, 128].map(i => word(head.slice(i, i + 64))), ['96', '160', '224']);
  assert.equal(word(data.slice(8 + 192, 8 + 256)), String(Buffer.byteLength(input.name)));
  assert.equal(word(data.slice(8 + 256 + 64, 8 + 256 + 128)), String(Buffer.byteLength(input.symbol)));
});

test('mint metadata is constrained to safe public HTTPS or IPFS URIs', () => {
  assert.throws(() => encodeFlapNewToken({ ...input, metadataUri: 'http://example.com/meta.json' }), { code: 'INVALID_MINT_METADATA_URI' });
  assert.throws(() => encodeFlapNewToken({ ...input, metadataUri: 'https://user:pass@example.com/meta.json' }), { code: 'INVALID_MINT_METADATA_URI' });
  assert.throws(() => encodeFlapNewToken({ ...input, symbol: 'BAD SYMBOL' }), { code: 'INVALID_MINT_METADATA' });
});

test('external-call adapter only previews the fixed Flap call and executes a validated preview ID', async () => {
  const calls = [];
  const cli = createManualCli({ resolveInstallation: async () => ({ metadata: { name: '@binance/agentic-wallet', version: '1.11.0', bin: { baw: 'dist/index.js' } }, entryPath: '/reviewed/dist/index.js' }),
    execute: async (exe, args, options) => { calls.push({ exe, args, options }); return { stdout: JSON.stringify({ success: true, data: { requestId: 'preview-12345678', parsedTx: {}, simulationResult: {}, risks: {} } }) }; } });
  const request = { chainId: '56', from: WALLET, to: FLAP_BSC_PORTAL, value: '0', inputData: encodeFlapNewToken(input) };
  const preview = await cli.previewContractCall(request);
  assert.equal(preview.kind, 'success');
  assert.deepEqual(calls[0].args.slice(1, 3), ['contract-call', 'preview']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--to') + 1], FLAP_BSC_PORTAL);
  assert.equal(calls[0].args[calls[0].args.indexOf('--value') + 1], '0');
  assert.equal(calls[0].options.shell, false);
  const execution = await cli.executeContractCall('preview-12345678');
  assert.equal(execution.status, 'UNKNOWN');
  assert.deepEqual(calls[1].args.slice(1, 3), ['contract-call', 'execute']);
  assert.equal(calls[1].args[calls[1].args.indexOf('--requestId') + 1], 'preview-12345678');
  await assert.rejects(cli.previewContractCall({ ...request, to: WALLET }), { code: 'EXTERNAL_CALL_NOT_ALLOWED' });
  await assert.rejects(cli.previewContractCall({ ...request, inputData: '0xdeadbeef' }), { code: 'EXTERNAL_CALL_NOT_ALLOWED' });
  await assert.rejects(cli.executeContractCall('--inject'), { code: 'INVALID_EXTERNAL_PREVIEW_ID' });
  assert.equal(calls.length, 2);
});

test('preview is fixed to the Flap BSC Portal, attaches no initial buy, and never executes', async t => {
  const f = fixture(t), service = await f.servicePromise, review = await service.preview(KEY, input);
  assert.equal(f.calls().previewCalls, 1); assert.equal(f.calls().executeCalls, 0);
  assert.equal(f.calls().lastCall.chainId, '56'); assert.equal(f.calls().lastCall.to, FLAP_BSC_PORTAL);
  assert.equal(f.calls().lastCall.value, '0'); assert.match(f.calls().lastCall.inputData, /^0x2ca9cd6d/);
  assert.equal(review.executable, true); assert.equal(review.valueWei, '0'); assert.equal(review.requestId, undefined);
});

test('Developer Mode, transaction lock, and wallet balance fail closed before preview', async t => {
  const disabled = fixture(t, { devMode: false }), service1 = await disabled.servicePromise;
  await assert.rejects(service1.preview(KEY, input), { code: 'DEVELOPER_MODE_REQUIRED' });
  assert.equal(disabled.calls().previewCalls, 0);
  const locked = fixture(t, { lock: 'LOCKED' }), service2 = await locked.servicePromise;
  await assert.rejects(service2.preview(KEY, input), { code: 'WALLET_TRANSACTION_LOCKED' });
  assert.equal(locked.calls().previewCalls, 0);
  const low = fixture(t, { balance: '0.001' }), service3 = await low.servicePromise;
  await assert.rejects(service3.preview(KEY, input), { code: 'INSUFFICIENT_GAS_RESERVE' });
  assert.equal(low.calls().previewCalls, 0);
});

test('failed simulation or any authority change blocks preview and execution', async t => {
  const failed = fixture(t, { previewResult: { kind: 'success', data: { requestId: 'preview-id-1234', parsedTx: { contractAddress: FLAP_BSC_PORTAL },
    simulationResult: { simulationCode: '351805', preCheckCode: '', authorityChanges: [], allowanceChanges: [] }, risks: { riskDetails: [], addresses: {}, riskBehaviors: [] } } } });
  await assert.rejects((await failed.servicePromise).preview(KEY, input), { code: 'MINT_PREVIEW_BLOCKED' });
  assert.equal(failed.calls().executeCalls, 0);
  const changed = fixture(t, { previewResult: { kind: 'success', data: { requestId: 'preview-id-1234', parsedTx: { contractAddress: FLAP_BSC_PORTAL },
    simulationResult: { simulationCode: '000000000', preCheckCode: '', authorityChanges: [{ type: 'owner-change' }], allowanceChanges: [] },
    risks: { riskDetails: [], addresses: {}, riskBehaviors: [] } } } });
  await assert.rejects((await changed.servicePromise).preview(KEY, input), { code: 'MINT_PREVIEW_BLOCKED' });
  assert.equal(changed.calls().executeCalls, 0);
});

test('explicit confirmation is required and duplicate clicks execute once; journal excludes preview IDs', async t => {
  const f = fixture(t), service = await f.servicePromise, review = await service.preview(KEY, input);
  await assert.rejects(service.submit(KEY, { reviewId: review.reviewId, confirmed: true, costAcknowledged: false }), { code: 'MINT_CONFIRMATION_REQUIRED' });
  const body = { reviewId: review.reviewId, confirmed: true, costAcknowledged: true, riskAcknowledged: false };
  const results = await Promise.all([service.submit(KEY, body), service.submit(KEY, body)]);
  assert.equal(f.calls().executeCalls, 1); assert.equal(results[0].status, 'BROADCASTED');
  assert.equal(results[0].successful, false); assert.equal(results[0].canRetry, false);
  const records = await service.list(KEY); assert.equal(records.list.length, 1);
  const journalFiles = await readdir(service.journal.directory); const filename = journalFiles.find(x => x.endsWith('.json')); const raw = await readFile(join(service.journal.directory, filename), 'utf8');
  assert.ok(!raw.includes('preview-id-1234')); assert.equal((await stat(join(service.journal.directory, journalFiles.find(x => x.endsWith('.json'))))).mode & 0o077, 0);
  const second = await service.preview(KEY, { ...input, name: 'Another Token' });
  const next = await service.submit(KEY, { reviewId: second.reviewId, confirmed: true, costAcknowledged: true, riskAcknowledged: false });
  assert.equal(next.status, 'BROADCASTED'); assert.equal(f.calls().executeCalls, 2);
});

test('journal only reclaims a lock whose recorded process has exited', async t => {
  const f = fixture(t), service = await f.servicePromise;
  await service.journal.ready();
  const lock = join(service.journal.directory, '.submission-lock');
  await writeFile(lock, JSON.stringify({ pid: 2_147_483_647, nonce: 'a'.repeat(32) }), { mode: 0o600 });
  assert.equal(await service.journal.withSubmissionLock(async () => 'recovered'), 'recovered');
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'b'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(service.journal.withSubmissionLock(async () => 'must not run'), { code: 'MINT_JOURNAL_BUSY' });
});

test('indeterminate submission blocks a separate mint instead of risking a duplicate', async t => {
  const f = fixture(t, { executeResult: { status: 'UNKNOWN', code: 'SUBMISSION_RESULT_UNKNOWN' } }), service = await f.servicePromise;
  const first = await service.preview(KEY, input);
  const result = await service.submit(KEY, { reviewId: first.reviewId, confirmed: true, costAcknowledged: true, riskAcknowledged: false });
  assert.equal(result.status, 'UNKNOWN'); assert.equal(f.calls().executeCalls, 1);
  const second = await service.preview(KEY, { ...input, name: 'Another Token' });
  await assert.rejects(service.submit(KEY, { reviewId: second.reviewId, confirmed: true, costAcknowledged: true, riskAcknowledged: false }), { code: 'UNRESOLVED_MINT_EXISTS' });
  assert.equal(f.calls().executeCalls, 1);
});

test('caution previews require risk acknowledgment before execution', async t => {
  const caution = fixture(t, { previewResult: { kind: 'success', data: { requestId: 'preview-id-1234', parsedTx: { contractAddress: FLAP_BSC_PORTAL },
    simulationResult: { simulationCode: '000000000', preCheckCode: '', authorityChanges: [], allowanceChanges: [], balanceChanges: [] },
    risks: { riskDetails: [{ riskType: 'CAUTION', title: 'Caution', description: 'Check metadata' }], addresses: {}, riskBehaviors: [] } } } });
  const service = await caution.servicePromise, review = await service.preview(KEY, input);
  assert.equal(review.requiresRiskAcknowledgment, true);
  await assert.rejects(service.submit(KEY, { reviewId: review.reviewId, confirmed: true, costAcknowledged: true, riskAcknowledged: false }), { code: 'MINT_RISK_ACKNOWLEDGMENT_REQUIRED' });
  assert.equal(caution.calls().executeCalls, 0);
});
