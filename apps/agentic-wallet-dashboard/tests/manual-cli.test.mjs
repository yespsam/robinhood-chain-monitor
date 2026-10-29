import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualCli, evaluateTargetAudit, AUDIT_ENDPOINT } from '../server/manual-cli.mjs';
import { NATIVE } from '../server/model.mjs';

const token = '0x1111111111111111111111111111111111111111', usdt = '0x55d398326f99059fF775485246999027B3197955';
const trade = { chainId: '56', fromToken: NATIVE, toToken: token, amount: '0.1', slippage: '0.5' };
const metadata = { name: '@binance/agentic-wallet', version: '1.11.0', bin: { baw: 'dist/index.js' } };
const installation = { metadata, entryPath: '/synthetic/node_modules/@binance/agentic-wallet/dist/index.js' };
const secret = 'SYNTHETIC_PRIVATE_OUTPUT_MUST_NOT_ESCAPE';
const clock = () => Date.parse('2026-10-23T00:00:00.000Z');
const config = { clock, resolveInstallation: async () => installation };
const success = data => ({ stdout: JSON.stringify({ success: true, data }) });
const failure = (name, code) => ({ stdout: JSON.stringify({ success: false, error: { name, code, message: secret, sessionToken: secret } }) });

test('manual swap uses exact reviewed CLI arguments and reports submitted, never completed', async () => {
  let calls = 0;
  const cli = createManualCli({ ...config, childEnv: { PATH: 'mock' }, execute: async (exe, args, options) => {
    calls++; assert.equal(exe, process.execPath); assert.deepEqual(args, [installation.entryPath, 'market-order', 'swap', '--fromTokenQty', '0.1',
      '--fromToken', NATIVE, '--toToken', token, '--binanceChainId', '56', '--slippage', '0.5', '--mev', 'true', '--gasLevel', 'MEDIUM', '--json']);
    assert.equal(options.shell, false); assert.equal(options.timeout, 90000); assert.deepEqual(options.env, { PATH: 'mock' });
    return success({ orderId: '1234567890', txHash: secret, sessionToken: secret });
  } });
  const result = await cli.executeSwap(trade);
  assert.equal(result.status, 'SUBMITTED'); assert.equal(result.outcome, 'SUBMITTED'); assert.equal(result.submitted, true);
  assert.equal(result.orderId, '1234567890'); assert.equal(result.retryAllowed, false); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes(secret));
});
test('invalid fields, chains, contracts, amount and slippage never access metadata or execute', async () => {
  const cli = createManualCli({ resolveInstallation: () => assert.fail('no metadata'), execute: () => assert.fail('no execution') });
  for (const override of [{ command: 'send' }, { args: ['swap'] }, { chainId: '137' }, { chainId: '--help' }, { fromToken: '$(bad)' },
    { amount: '1e18' }, { amount: '0' }, { amount: '-1' }, { slippage: 'auto' }, { slippage: '101' }, { slippage: '100.0000000000000001' }, { toToken: NATIVE }])
    await assert.rejects(cli.executeSwap({ ...trade, ...override }));
  await assert.rejects(cli.readOrder({ orderId: '--json', chainId: '56' }));
  await assert.rejects(cli.txLock('$(bad)')); await assert.rejects(cli.gasPrice('137'));
});
test('missing or mismatched reviewed CLI is a known local rejection with no process invocation', async () => {
  for (const resolveInstallation of [async () => { throw Error(secret); }, async () => ({ ...installation, metadata: { ...metadata, version: '9.9.9' } })]) {
    const cli = createManualCli({ clock, resolveInstallation, execute: () => assert.fail('no execution') });
    const result = await cli.executeSwap(trade); assert.equal(result.status, 'REJECTED'); assert.equal(result.submitted, false);
    assert.equal(result.code, 'CLI_NOT_AVAILABLE'); assert.ok(!JSON.stringify(result).includes(secret));
  }
});
test('definite official rejection retains only known official identity, without arbitrary message', async () => {
  const cli = createManualCli({ ...config, execute: async () => failure('INVALID_PARAMS', 1001002) });
  const r = await cli.executeSwap(trade); assert.equal(r.status, 'REJECTED'); assert.equal(r.officialName, 'INVALID_PARAMS');
  assert.equal(r.officialCode, 1001002); assert.equal(r.submitted, false); assert.ok(!JSON.stringify(r).includes(secret));
  const notLoggedIn = createManualCli({ ...config, execute: async () => { throw { code: 1, ...failure('NOT_LOGGED_IN', 10003000) }; } });
  assert.equal((await notLoggedIn.executeSwap(trade)).status, 'REJECTED');
});
test('timeout, broken output, network error and unrecognized failure stay unknown and never retry', async () => {
  const responses = [async () => { throw { killed: true, stdout: secret, stderr: secret }; },
    async () => { throw { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: secret }; },
    async () => { throw { code: 1, stdout: secret, stderr: secret }; }, async () => ({ stdout: 'malformed ' + secret }),
    async () => failure('REQUEST_TIMEOUT', 50001002), async () => failure('NETWORK_ERROR', 50001001), async () => failure('SERVICE_ERROR', 351734),
    async () => failure('UNKNOWN_NAME_' + secret, 12345), async () => success({ orderId: '--json' }), async () => success({})];
  for (const response of responses) {
    let calls = 0; const cli = createManualCli({ ...config, execute: async (...a) => { calls++; return response(...a); } });
    const r = await cli.executeSwap(trade); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.submitted, null);
    assert.equal(r.retryAllowed, false); assert.equal(calls, 1); assert.equal(r.orderId, null); assert.ok(!JSON.stringify(r).includes(secret));
  }
  const notStarted = createManualCli({ ...config, execute: async () => { throw { code: 'ENOENT', stderr: secret }; } });
  assert.equal((await notStarted.executeSwap(trade)).status, 'REJECTED');
});
const order = { orderId: '123', chain: '56', fromToken: NATIVE, toToken: usdt, fromTokenQty: '0.1', toTokenQty: '60.2', toTokenActualQty: '60.189200000000000001', status: 'FINISHED',
  txHash: '0x' + 'a'.repeat(64), fromTokenName: 'BNB', toTokenName: 'USDT', bookTime: '2026-10-23T00:00:00Z', updatedTime: '2026-10-23T00:00:01Z' };
test('order lookup is scoped to exact order/network and returned fields are allowlisted', async () => {
  const cli = createManualCli({ ...config, execute: async (_exe, args) => {
    assert.deepEqual(args.slice(1), ['market-order', 'list', '--orderId', '123', '--json']);
    return success({ list: [{ ...order, sessionToken: secret }], total: 1, privateKey: secret });
  } });
  const r = await cli.readOrder({ orderId: '123', chainId: '56' }); assert.equal(r.list[0].status, 'FINISHED');
  assert.equal(r.list[0].toTokenQty, '60.2'); assert.equal(r.list[0].toTokenActualQty, '60.189200000000000001');
  assert.equal(r.list[0].txHash, order.txHash); assert.ok(!JSON.stringify(r).includes(secret));
  for (const patch of [{ chain: '1' }, { orderId: '456' }, { status: 'MADE_UP' }, { fromToken: secret }]) {
    const bad = createManualCli({ ...config, execute: async () => success({ list: [{ ...order, ...patch }] }) });
    await assert.rejects(bad.readOrder({ orderId: '123', chainId: '56' }), { code: 'INVALID_RESPONSE' });
  }
  const empty = createManualCli({ ...config, execute: async () => success({ list: [] }) });
  assert.deepEqual((await empty.readOrder({ orderId: '123', chainId: '56' })).list, []);
});
test('tx-lock is a fixed read and unknown/missing lock state cannot be treated as unlocked', async () => {
  const cli = createManualCli({ ...config, execute: async (_e, args) => {
    assert.deepEqual(args.slice(1), ['wallet', 'tx-lock', '--binanceChainId', '56', '--json']); return success({ status: 'LOCKED', secret });
  } });
  assert.equal((await cli.txLock('56')).status, 'LOCKED');
  const bad = createManualCli({ ...config, execute: async () => success({ status: secret }) });
  await assert.rejects(bad.txLock('56'), e => e.code === 'INVALID_RESPONSE' && !JSON.stringify(e).includes(secret));
});
const gas = { baseFeePerGas: '0', low: { gasPrice: '0.053', maxFeePerGas: '0.053', maxPriorityFeePerGas: '0.053', tipAmount: null, waitTimeEstimate: 16000 },
  medium: { gasPrice: '0.054', maxFeePerGas: '0.054', maxPriorityFeePerGas: '0.054', tipAmount: null, waitTimeEstimate: 8000 },
  high: { gasPrice: '0.055', maxFeePerGas: '0.055', maxPriorityFeePerGas: '0.055', tipAmount: null, waitTimeEstimate: 3000 } };
test('gas price preserves official unit prices and fails on missing/invalid values without guessing a fee', async () => {
  const cli = createManualCli({ ...config, execute: async (_e, args) => {
    assert.deepEqual(args.slice(1), ['wallet', 'gas-price', '--binanceChainId', '56', '--json']); return success({ ...gas, secret });
  } });
  const r = await cli.gasPrice('56'); assert.equal(r.medium.gasPrice, '0.054'); assert.equal(r.unit, 'gwei'); assert.equal(r.totalGasCost, null);
  assert.ok(!JSON.stringify(r).includes(secret));
  for (const patch of [{ medium: null }, { medium: { gasPrice: '0' } }, { medium: { gasPrice: secret } }]) {
    const bad = createManualCli({ ...config, execute: async () => success({ ...gas, ...patch }) });
    await assert.rejects(bad.gasPrice('56'), { code: 'INVALID_RESPONSE' });
  }
});

const requestId = '12345678-1234-4234-8234-123456789abc';
const auditData = { requestId, hasResult: true, isSupported: true, riskLevel: 3, riskLevelEnum: 'MID', isHidden: false,
  extraInfo: { buyTax: '0', sellTax: '0', isVerified: null }, riskItems: [{ id: 'CONTRACT_RISK', name: 'Contract Risk', details: [
    { title: 'Mintable Detected', description: 'Supply may increase.', isHit: true, riskType: 'CAUTION' },
    { title: 'Honeypot not found', description: 'Sale restrictions', isHit: false, riskType: 'RISK' }
  ] }] };
const auditRequest = { chainId: '56', contractAddress: token };
const auditOptions = data => ({ clock, uuid: () => requestId, fetchImpl: async () => new Response(JSON.stringify({ success: true, code: '000000', data })) });
test('public audit matches actual MID/category/details shape and sends only token/network/UUID', async () => {
  const options = auditOptions(auditData), response = options.fetchImpl;
  options.fetchImpl = async (url, init) => {
    assert.equal(url, AUDIT_ENDPOINT); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), { binanceChainId: '56', contractAddress: token, requestId });
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined);
    return response();
  };
  const r = await evaluateTargetAudit(auditRequest, options); assert.equal(r.status, 'WARNING'); assert.equal(r.requiresAcknowledgment, true);
  assert.equal(r.riskLevelEnum, 'MEDIUM'); assert.equal(r.riskItems.length, 2); assert.equal(r.riskItems[0].code, 'CONTRACT_RISK');
});
test('critical hit, high overall risk, or tax above 10 percent is blocked and cannot be acknowledged away', async () => {
  for (const data of [{ ...auditData, riskLevel: 4, riskLevelEnum: 'HIGH' },
    { ...auditData, riskLevel: 5, riskLevelEnum: 'HIGH', riskItems: null },
    { ...auditData, riskLevel: null, riskItems: [{ details: [{ isHit: true, riskType: 'RISK' }] }] },
    { ...auditData, riskItems: [{ id: 'TRADE_RISK', details: [{ isHit: true, riskType: 'RISK', description: '<script>bad</script> Cannot sell' }] }] },
    { ...auditData, extraInfo: { buyTax: '0', sellTax: '10.01' } }]) {
    const r = await evaluateTargetAudit(auditRequest, auditOptions(data)); assert.equal(r.status, 'BLOCKED');
    assert.equal(r.blocked, true); assert.equal(r.requiresAcknowledgment, false); assert.ok(!JSON.stringify(r).includes('<script>'));
  }
});
test('missing, unsupported, mismatched, malformed or unavailable audit never produces a green result', async () => {
  for (const data of [{ ...auditData, hasResult: false }, { ...auditData, isSupported: false }, { ...auditData, requestId: 'other' },
    { ...auditData, riskLevel: 0, riskLevelEnum: 'MID' }, { ...auditData, riskItems: null },
    { ...auditData, riskItems: [{ details: [{ isHit: 'false', riskType: 'RISK' }] }] }, { ...auditData, isHidden: true }]) {
    const r = await evaluateTargetAudit(auditRequest, auditOptions(data)); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.requiresAcknowledgment, true);
    assert.equal(r.riskLevel, null); assert.deepEqual(r.riskItems, []);
  }
  for (const fetchImpl of [async () => { throw Error(secret); }, async () => new Response(secret, { status: 503 }),
    async () => new Response('x'.repeat(300000))]) {
    const r = await evaluateTargetAudit(auditRequest, { clock, uuid: () => requestId, fetchImpl });
    assert.equal(r.status, 'UNKNOWN'); assert.ok(!JSON.stringify(r).includes(secret));
  }
});
test('a complete low-risk snapshot is never labeled safe and unknown taxes still require acknowledgment', async () => {
  const low = { ...auditData, riskLevel: '1', riskLevelEnum: 'LOW', riskItems: [{ details: [] }] };
  const r = await evaluateTargetAudit(auditRequest, auditOptions(low)); assert.equal(r.status, 'CLEAR'); assert.equal(r.blocked, false);
  assert.match(r.disclaimer, /不代表安全保证/);
  const unknownTax = await evaluateTargetAudit(auditRequest, auditOptions({ ...low, extraInfo: {} }));
  assert.equal(unknownTax.status, 'WARNING'); assert.equal(unknownTax.requiresAcknowledgment, true);
  const unsupported = await evaluateTargetAudit({ ...auditRequest, chainId: '137' }, { fetchImpl: () => assert.fail('must not query unsupported') });
  assert.equal(unsupported.status, 'UNKNOWN');
  await assert.rejects(evaluateTargetAudit({ ...auditRequest, wallet: secret }, { fetchImpl: () => assert.fail('no fetch') }));
});
