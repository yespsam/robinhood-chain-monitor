import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { WalletGate } from '../server/policy.mjs';
import { Denied } from '../server/auth.mjs';
import { CustomContractCallService } from '../server/custom-contract-call.mjs';
import { createManualCli } from '../server/manual-cli.mjs';
import { NATIVE } from '../server/model.mjs';

const KEY = 'custom-contract-test-session';
const WALLET = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'a'.repeat(64);
const REQUEST_ID = 'preview-id-1234';
const ABI = JSON.stringify([{ type: 'function', name: 'mint', stateMutability: 'payable', inputs: [
  { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }]);
const CALL_DATA = new Interface(JSON.parse(ABI)).encodeFunctionData('mint(address,uint256)', [WALLET, '1000000']);
const input = { chainId: '56', contractAddress: CONTRACT, abiJson: ABI, functionSignature: 'mint(address,uint256)',
  argumentsJson: `["${WALLET}","1000000"]`, valueNative: '0.01' };
const fields = { parsedTx: { transactionType: 'ContractCall', from: WALLET, chainId: '56', contractAddress: CONTRACT,
  amount: '10000000000000000', inputData: CALL_DATA }, simulationResult: { simulationCode: '000000000', preCheckCode: '',
  authorityChanges: [], allowanceChanges: [], balanceChanges: [] }, risks: { riskDetails: [], addresses: {}, riskBehaviors: [] },
  requireConfirmation: false, expiresAt: 1_800_000_060_000 };

function fixture(t, options = {}) {
  const directory = mkdtemp(join(tmpdir(), 'custom-contract-call-test-'));
  const clock = () => 1_800_000_000_000;
  const sessions = { byKey(key) { if (key !== KEY) throw new Denied('SESSION_REQUIRED', 401); return { owner: 'owner' }; } };
  const binding = { sessionKey: KEY, owner: 'owner', userConfirmed: true, permissions: ['read', 'manual'], addresses: { '56': WALLET, '1': WALLET } };
  const wallet = {
    async status() { return 'CONNECTED'; },
    async settings() { const expires = new Date(clock() + 3_600_000).toISOString(); return { sessionExpireTime: expires, inactiveSignOutTime: expires, devMode: { enabled: options.devMode !== false } }; },
    async chains() { return [{ id: '56', name: 'BNB Smart Chain' }, { id: '1', name: 'Ethereum' }]; },
    async addresses() { return [{ chainId: '56', address: WALLET }, { chainId: '1', address: WALLET }]; },
    async txLock(chain) { return options.lockChain === chain ? 'LOCKED' : 'UNLOCKED'; },
    async balance(chain, contract) { return [{ chainId: chain, contract, balance: options.balance || '1.25' }]; }
  };
  const gate = new WalletGate({ sessions, wallet, binding, clock });
  let previewCalls = 0, executeCalls = 0, lastCall;
  const previewContractCall = async call => {
    previewCalls++; lastCall = call;
    if (options.previewResult) return options.previewResult;
    return { kind: 'success', data: { requestId: REQUEST_ID, parsedTx: { ...fields.parsedTx, contractAddress: call.to, from: call.from,
      chainId: call.chainId, amount: call.value, inputData: call.inputData }, simulationResult: structuredClone(fields.simulationResult),
      risks: structuredClone(fields.risks), requireConfirmation: false, expiresAt: clock() + 60_000 } };
  };
  const executeContractCall = async (requestId, chainId) => { executeCalls++; assert.equal(requestId, REQUEST_ID); assert.ok(['56', '1'].includes(chainId));
    return options.executeResult || { status: 'BROADCASTED', orderId: 'order-1', txHash: HASH }; };
  const servicePromise = directory.then(path => new CustomContractCallService({ wallet, gate, previewContractCall, executeContractCall,
    journalDir: join(path, 'calls'), clock }));
  t.after(async () => rm(await directory, { recursive: true, force: true }));
  return { wallet, gate, servicePromise, calls: () => ({ previewCalls, executeCalls, lastCall }),
    directory: async () => join(await directory, 'calls') };
}
const acknowledged = review => ({ reviewId: review.reviewId, confirmed: true, costAcknowledged: true, riskAcknowledged: false, customCallAcknowledged: true });

test('ABI-driven preview encodes a specific EVM function and returns no executable request ID', async t => {
  const f = fixture(t), service = await f.servicePromise, review = await service.preview(KEY, input);
  assert.equal(f.calls().previewCalls, 1); assert.equal(f.calls().executeCalls, 0);
  assert.equal(f.calls().lastCall.chainId, '56'); assert.equal(f.calls().lastCall.to, CONTRACT); assert.equal(f.calls().lastCall.from, WALLET);
  assert.equal(f.calls().lastCall.value, '10000000000000000'); assert.match(f.calls().lastCall.inputData, /^0x[0-9a-f]{8}/i);
  assert.equal(review.functionSignature, 'mint(address,uint256)'); assert.equal(review.selector, f.calls().lastCall.inputData.slice(0, 10));
  assert.equal(review.requestId, undefined); assert.equal(review.executable, true);
});

test('view functions, privileged methods, non-payable value and malformed ABI inputs fail before CLI preview', async t => {
  const f = fixture(t), service = await f.servicePromise;
  for (const patch of [
    { functionSignature: 'balanceOf(address)', abiJson: JSON.stringify([{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]), argumentsJson: `["${WALLET}"]` },
    { functionSignature: 'approve(address,uint256)', abiJson: JSON.stringify([{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }] }]), argumentsJson: `["${WALLET}","1"]`, valueNative: '0' },
    { functionSignature: 'mint(address,uint256)', valueNative: '0.01', abiJson: JSON.stringify([{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }] }]) },
    { abiJson: '{' }, { argumentsJson: '{' }, { argumentsJson: `["${WALLET}",9007199254740992]` }, { chainId: 'CT_501' }, { valueNative: '1e-4' }
  ]) await assert.rejects(service.preview(KEY, { ...input, ...patch }));
  assert.equal(f.calls().previewCalls, 0);
});

test('Developer Mode, wallet tx lock, insufficient native balance and non-EVM chain fail closed', async t => {
  const disabled = fixture(t, { devMode: false }); await assert.rejects((await disabled.servicePromise).preview(KEY, input), { code: 'DEVELOPER_MODE_REQUIRED' });
  const locked = fixture(t, { lockChain: '56' }); await assert.rejects((await locked.servicePromise).preview(KEY, input), { code: 'WALLET_TRANSACTION_LOCKED' });
  const low = fixture(t, { balance: '0.0105' }); await assert.rejects((await low.servicePromise).preview(KEY, input), { code: 'INSUFFICIENT_GAS_RESERVE' });
  const f = fixture(t), service = await f.servicePromise; await assert.rejects(service.preview(KEY, { ...input, chainId: '137' }));
  for (const entry of [disabled, locked, low]) assert.equal((await entry.servicePromise).journal.directory !== undefined, true);
});

test('simulation failures, target/value mismatches, authority and allowance changes block execution', async t => {
  const variants = [
    { ...fields, simulationResult: { ...fields.simulationResult, simulationCode: '351805' } },
    { ...fields, parsedTx: { ...fields.parsedTx, contractAddress: WALLET } },
    { ...fields, parsedTx: { ...fields.parsedTx, from: undefined } },
    { ...fields, parsedTx: { ...fields.parsedTx, chainId: undefined } },
    { ...fields, parsedTx: { ...fields.parsedTx, inputData: '0x12345678' } },
    { ...fields, parsedTx: { ...fields.parsedTx, amount: '1' } },
    { ...fields, simulationResult: { ...fields.simulationResult, authorityChanges: [{ type: 'owner-change' }] } },
    { ...fields, simulationResult: { ...fields.simulationResult, allowanceChanges: [{ type: 'approval' }] } }
  ];
  for (const data of variants) {
    const f = fixture(t, { previewResult: { kind: 'success', data: { ...data, requestId: REQUEST_ID } } });
    await assert.rejects((await f.servicePromise).preview(KEY, input)); assert.equal(f.calls().executeCalls, 0);
  }
});

test('risk findings block while cautions require acknowledgement; explicit submit executes one call', async t => {
  const blocked = fixture(t, { previewResult: { kind: 'success', data: { ...fields, requestId: REQUEST_ID,
    risks: { ...fields.risks, riskDetails: [{ riskType: 'RISK', title: 'Blocked' }] } } } });
  await assert.rejects((await blocked.servicePromise).preview(KEY, input), { code: 'CONTRACT_CALL_PREVIEW_BLOCKED' });
  const cautioned = fixture(t, { previewResult: { kind: 'success', data: { ...fields, requestId: REQUEST_ID,
    risks: { ...fields.risks, riskDetails: [{ riskType: 'CAUTION', title: 'Check conditions' }] } } } });
  const cautionService = await cautioned.servicePromise, cautionReview = await cautionService.preview(KEY, input);
  await assert.rejects(cautionService.submit(KEY, acknowledged(cautionReview)), { code: 'CONTRACT_CALL_RISK_ACKNOWLEDGMENT_REQUIRED' });
  assert.equal(cautioned.calls().executeCalls, 0);
  const f = fixture(t), service = await f.servicePromise, review = await service.preview(KEY, input);
  await assert.rejects(service.submit(KEY, { ...acknowledged(review), customCallAcknowledged: false }), { code: 'CONTRACT_CALL_CONFIRMATION_REQUIRED' });
  const results = await Promise.all([service.submit(KEY, acknowledged(review)), service.submit(KEY, acknowledged(review))]);
  assert.equal(f.calls().executeCalls, 1); assert.equal(results[0].status, 'BROADCASTED'); assert.equal(results[0].successful, false);
  const directory = await f.directory(), files = await readdir(directory), data = await readFile(join(directory, files.find(x => x.endsWith('.json'))), 'utf8');
  assert.ok(!data.includes(REQUEST_ID)); assert.ok(!data.includes(f.calls().lastCall.inputData)); assert.ok(!data.includes(input.argumentsJson));
  assert.equal((await stat(join(directory, files.find(x => x.endsWith('.json'))))).mode & 0o077, 0);
});

test('unknown result blocks any second call and records remain scoped to the bound network address', async t => {
  const f = fixture(t, { executeResult: { status: 'UNKNOWN', code: 'SUBMISSION_RESULT_UNKNOWN' } }), service = await f.servicePromise;
  const first = await service.preview(KEY, input), result = await service.submit(KEY, acknowledged(first));
  assert.equal(result.status, 'UNKNOWN'); assert.equal(f.calls().executeCalls, 1);
  const second = await service.preview(KEY, input); await assert.rejects(service.submit(KEY, acknowledged(second)), { code: 'UNRESOLVED_CONTRACT_CALL_EXISTS' });
  assert.equal(f.calls().executeCalls, 1); assert.equal((await service.list(KEY)).list.length, 1);
  const status = await service.status(KEY, { intentId: first.intentId }); assert.equal(status.contractAddress, CONTRACT);
});

test('manual CLI custom preview accepts only validated EVM fields and shell-free args', async () => {
  const calls = [], cli = createManualCli({ resolveInstallation: async () => ({ metadata: { name: '@binance/agentic-wallet', version: '1.11.0', bin: { baw: 'dist/index.js' } }, entryPath: '/reviewed/dist/index.js' }),
    execute: async (exe, args, options) => { calls.push({ exe, args, options }); return { stdout: JSON.stringify({ success: true, data: { requestId: REQUEST_ID } }) }; } });
  const preview = await cli.previewCustomContractCall({ chainId: '1', from: WALLET, to: CONTRACT, value: '0', inputData: '0x12345678' });
  assert.equal(preview.kind, 'success'); assert.deepEqual(calls[0].args.slice(1, 10), ['contract-call', 'preview', '--binanceChainId', '1', '--from', WALLET, '--to', CONTRACT, '--value']);
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].args[calls[0].args.indexOf('--inputData') + 1], '0x12345678');
  for (const bad of [{ chainId: 'CT_501' }, { value: '1e18' }, { inputData: 'not hex' }, { extra: 'injection' }])
    await assert.rejects(cli.previewCustomContractCall({ chainId: '1', from: WALLET, to: CONTRACT, value: '0', inputData: '0x12345678', ...bad }));
});
