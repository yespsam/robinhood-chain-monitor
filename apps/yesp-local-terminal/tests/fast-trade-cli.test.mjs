import test from 'node:test';
import assert from 'node:assert/strict';
import { createFastTradeCli, sanitizeFastTradeData } from '../server/fast-trade-cli.mjs';

const secret = 'SYNTHETIC_SECRET_NOT_FOR_OUTPUT';
const metadata = { name: '@binance/agentic-wallet', version: '1.11.0', bin: { baw: 'dist/index.js' } };
const installation = { metadata, entryPath: '/synthetic/agentic-wallet/dist/index.js' };
const from = '0x1111111111111111111111111111111111111111', to = '0x2222222222222222222222222222222222222222';
const tx = { chainId: '56', from, to, value: '0', inputData: '0x12345678' };
const now = 1792760000000;
const config = { resolveInstallation: async () => installation, clock: () => now };
const success = data => ({ stdout: JSON.stringify({ success: true, data }) });
const preview = () => ({ requestId: 'preview-123', parsedTx: { recipient: to, amount: '0', privateKey: secret },
  simulationResult: { simulationCode: '000000000', simulationErrorDetail: null, balanceChanges: [{ tokenAddress: to, amount: '42', sessionToken: secret }],
    allowanceChanges: [], authorityChanges: [{ spender: to }] }, risks: { riskDetails: [{ code: 'TEST_CAUTION', description: 'Review this public risk.' }], addresses: {}, riskBehaviors: [] },
  expiresAt: now + 60000, requireConfirmation: false, accessToken: secret });
const broadcast = { orderId: '12345', status: 'BROADCASTED', txHash: '0x' + 'a'.repeat(64), cookie: secret };
const failure = (name, code) => ({ stdout: JSON.stringify({ success: false, error: { name, code, message: secret } }) });
test('read errors distinguish wallet network failure and timeout without exposing stderr or retrying',async()=>{
 for(const [execute,code]of [[async()=>failure('NETWORK_ERROR',50001001),'WALLET_NETWORK_ERROR'],[async()=>failure('REQUEST_TIMEOUT',50001002),'WALLET_READ_TIMEOUT'],[async()=>{throw {killed:true,stderr:secret};},'WALLET_READ_TIMEOUT']]){
  let calls=0;const cli=createFastTradeCli({...config,execute:async()=>{calls++;return execute();}});
  await assert.rejects(()=>cli.status(),e=>e.code===code&&!JSON.stringify(e).includes(secret));assert.equal(calls,1);
 }
});

test('reads use documented argv and resolve installation only once, preserving nonsecret settings', async () => {
  let resolutions = 0; const calls = [];
  const cli = createFastTradeCli({ ...config, childEnv: { PATH: 'mock' }, resolveInstallation: async () => { resolutions++; return installation; },
    execute: async (exe, args, options) => {
      assert.equal(exe, process.execPath); assert.equal(options.shell, false); assert.equal(options.timeout, 5000);
      assert.deepEqual(options.env, { PATH: 'mock' }); assert.equal(args.at(-1), '--json'); calls.push(args.slice(1, -1));
      return success(args[2] === 'status' ? { status: 'CONNECTED', sessionToken: secret } : args[2] === 'address' ? { addresses: [{ binanceChainId: '56', address: from }] }
        : args[2] === 'settings' ? { sessionExpireTime: '2099-01-01', inactiveSignOutTime: '2099-01-01', devMode: { enabled: true }, clientId: secret }
          : { status: 'UNLOCKED', password: secret });
    } });
  const results = await Promise.all([cli.status(), cli.addresses(), cli.settings(), cli.txLock()]);
  assert.equal(resolutions, 1); assert.equal(results[2].devMode.enabled, true); assert.equal(results[2].sessionExpireTime, '2099-01-01');
  assert.ok(!JSON.stringify(results).includes(secret));
  assert.deepEqual(calls, [['wallet', 'status'], ['wallet', 'address'], ['wallet', 'settings'], ['wallet', 'tx-lock', '--binanceChainId', '56']]);
});
test('successful preview retains complete simulation and risk details but writes remain disabled by default', async () => {
  let calls = 0;
  const cli = createFastTradeCli({ ...config, execute: async (_exe, args, options) => {
    calls++; assert.equal(options.timeout, 7000);
    assert.deepEqual(args.slice(1), ['contract-call', 'preview', '--binanceChainId', '56', '--from', from, '--to', to,
      '--value', '0', '--inputData', '0x12345678', '--json']); return success(preview());
  } });
  const p = await cli.previewContract(tx); assert.equal(p.outcome, 'PREVIEWED');
  assert.equal(p.data.simulationResult.balanceChanges[0].amount, '42'); assert.equal(p.data.simulationResult.authorityChanges[0].spender, to);
  assert.equal(p.data.risks.riskDetails.length, 1); assert.ok(!JSON.stringify(p).includes(secret));
  assert.equal((await cli.executePreview(p.data.requestId)).code, 'WRITES_DISABLED'); assert.equal(calls, 1);
});
test('execute requires successful preview from same runner, consumes it once, and never claims confirmed', async () => {
  let writes = 0;
  const cli = createFastTradeCli({ ...config, allowWrites: true, execute: async (_exe, args, options) => {
    if (args[2] === 'preview') return success(preview());
    writes++; assert.equal(options.timeout, 90000); assert.deepEqual(args.slice(1), ['contract-call', 'execute', '--requestId', 'preview-123', '--json']);
    await new Promise(resolve => setTimeout(resolve, 5)); return success(broadcast);
  } });
  assert.equal((await cli.executePreview('not-issued')).code, 'PREVIEW_NOT_EXECUTABLE');
  await cli.previewContract(tx);
  const results = await Promise.all([cli.executePreview('preview-123'), cli.executePreview('preview-123')]);
  assert.equal(writes, 1); assert.equal(results[0].outcome, 'SUBMITTED'); assert.equal(results[1].outcome, 'REJECTED');
  assert.equal(results[0].data.txHash, broadcast.txHash); assert.ok(!JSON.stringify(results).includes(secret));
  assert.equal((await cli.previewContract(tx)).code, 'PREVIEW_NOT_EXECUTABLE');
});
test('transport and ambiguous execute errors stay UNKNOWN and cannot be retried', async () => {
  const outcomes = [async () => { throw { killed: true, stdout: secret, stderr: secret }; },
    async () => ({ stdout: 'broken ' + secret }), async () => failure('REQUEST_TIMEOUT', 50001002),
    async () => failure('SERVICE_ERROR', 351734), async () => success({ orderId: '123', status: 'UNRECOGNIZED' })];
  for (const outcome of outcomes) {
    let writes = 0;
    const cli = createFastTradeCli({ ...config, allowWrites: true, execute: async (_exe, args) => {
      if (args[2] === 'preview') return success(preview()); writes++; return outcome();
    } });
    await cli.previewContract(tx); const r = await cli.executePreview('preview-123');
    assert.equal(r.outcome, 'UNKNOWN'); assert.equal(r.submitted, null); assert.equal(r.retryAllowed, false);
    assert.ok(!JSON.stringify(r).includes(secret)); await cli.executePreview('preview-123'); assert.equal(writes, 1);
  }
});
test('verified authentication/validation rejection is REJECTED, unknown names cannot impersonate it', async () => {
  for (const [name, code, expected] of [['SESSION_EXPIRED', 10003002, 'REJECTED'], ['INVALID_PARAMS', 1001002, 'REJECTED'], ['SESSION_EXPIRED', 999, 'UNKNOWN']]) {
    const cli = createFastTradeCli({ ...config, allowWrites: true, execute: async (_e, args) => args[2] === 'preview' ? success(preview()) : failure(name, code) });
    await cli.previewContract(tx); const r = await cli.executePreview('preview-123'); assert.equal(r.outcome, expected); assert.ok(!JSON.stringify(r).includes(secret));
  }
});
test('App confirmation remains pending and is not reported as broadcast', async () => {
  const cli = createFastTradeCli({ ...config, allowWrites: true, execute: async (_e, args) => args[2] === 'preview' ? success(preview())
    : success({ orderId: '123', status: 'PENDING_CONFIRMATION', txHash: null }) });
  await cli.previewContract(tx); assert.equal((await cli.executePreview('preview-123')).outcome, 'PENDING_CONFIRMATION');
});

test('pending-contract discovery reads bounded documented history and rejects mixed chains',async()=>{
 let bad=false;
 const cli=createFastTradeCli({...config,execute:async(_exe,args)=>{
  assert.deepEqual(args.slice(1,-1),['wallet','tx-history','--binanceChainId','56','--type','all','--size','20','--startTime','1000']);
  return success({transactions:[{binanceChainId:bad?'1':'56',txHash:broadcast.txHash,txHashList:[{binanceChainId:'56',txHash:broadcast.txHash}]}]});
 }});
 assert.deepEqual(await cli.recentTransactions({chainId:'56',since:1000}),[broadcast.txHash]);bad=true;
 await assert.rejects(()=>cli.recentTransactions({chainId:'56',since:1000}),{code:'INVALID_RESPONSE'});
 await assert.rejects(()=>cli.recentTransactions({chainId:'56',since:1000,orderId:'injected'}),{code:'INVALID_REQUEST'});
});
test('expired, failed or malformed previews cannot execute', async () => {
  for (const response of [failure('SERVICE_ERROR', 351803), success({ ...preview(), expiresAt: now - 1 }),
    success({ ...preview(), simulationResult: { simulationCode: 'ERROR' } }), success({ ...preview(), parsedTx: null })]) {
    let writes = 0; const cli = createFastTradeCli({ ...config, allowWrites: true, execute: async (_e, args) => {
      if (args[2] === 'execute') writes++; return response;
    } });
    assert.notEqual((await cli.previewContract(tx)).outcome, 'PREVIEWED');
    assert.equal((await cli.executePreview('preview-123')).code, 'PREVIEW_NOT_EXECUTABLE'); assert.equal(writes, 0);
  }
  let time = now; const cli = createFastTradeCli({ ...config, clock: () => time, allowWrites: true, execute: async () => success(preview()) });
  await cli.previewContract(tx); time += 60000;
  assert.equal((await cli.executePreview('preview-123')).code, 'PREVIEW_NOT_EXECUTABLE');
});
test('invalid caller fields never invoke metadata resolution or process execution', async () => {
  const cli = createFastTradeCli({ resolveInstallation: () => assert.fail('no metadata'), execute: () => assert.fail('no process') });
  for (const bad of [{ ...tx, args: ['--debug'] }, { ...tx, chainId: 'CT_501' }, { ...tx, from: '$(bad)' }, { ...tx, value: '-1' },
    { ...tx, value: '1e18' }, { ...tx, value: '0.' }, { ...tx, value: (1n << 256n).toString() }, { ...tx, inputData: '0x1' }])
    await assert.rejects(cli.previewContract(bad), { code: 'INVALID_REQUEST' });
  assert.throws(() => cli.txLock('--help'), { code: 'INVALID_REQUEST' });
});
test('credential-shaped fields and inline authorization values are removed without dropping token or authority data', () => {
  const r = sanitizeFastTradeData({ tokenInfos: { [to]: { symbol: 'TEST' } }, authorityChanges: [{ spender: to }],
    sessionExpireTime: '2099-01-01', nested: { private_key: secret, sessionId: secret, seedPhrase: secret, note: 'Bearer ABC123 AgentSessionId=another' } });
  assert.equal(r.tokenInfos[to].symbol, 'TEST'); assert.equal(r.authorityChanges[0].spender, to);
  assert.equal(r.nested.note, '[REDACTED] [REDACTED]'); assert.ok(!JSON.stringify(r).includes(secret));
});
test('large raw simulation integers are preserved from CLI JSON before numeric parsing', async () => {
  const json = JSON.stringify({ success: true, data: preview() }).replace('"amount":"0"', '"amount":11748971999011834918');
  const cli = createFastTradeCli({ ...config, execute: async () => ({ stdout: json }) });
  const result = await cli.previewContract(tx);
  assert.equal(result.outcome, 'PREVIEWED'); assert.equal(result.data.parsedTx.amount, '11748971999011834918');
});
const trade = { chainId: '56', fromToken: from, toToken: to, amount: '0.05', slippage: '5' };
const auth = { urlForWeb: 'https://web3.binance.com/zh-CN/agent-login?_ul=abc&expireAt=1792760060000',
  pairingCode: 'abcdef', qrCodeId: 'qr-code-123', expireAt: String(now + 60000) };
test('authentication is independently disabled by default and never starts a process', async () => {
  const cli = createFastTradeCli({ allowWrites: true, execute: () => assert.fail('no process'), resolveInstallation: () => assert.fail('no metadata') });
  await assert.rejects(cli.signin(), { code: 'AUTH_DISABLED' }); await assert.rejects(cli.verify('qr-code-123'), { code: 'AUTH_DISABLED' });
});
test('signin returns only validated official pairing fields verbatim without exposing credentials', async () => {
  const cli = createFastTradeCli({ ...config, allowAuth: true, execute: async (_e, args) => {
    assert.deepEqual(args.slice(1), ['auth', 'signin', '--json']); return success({ ...auth, clientId: secret, cookie: secret, privateKey: secret });
  } });
  assert.deepEqual(await cli.signin(), auth);
  for (const bad of ['http://web3.binance.com/login', 'https://web3.binance.com.evil.test/login', 'https://user:pass@web3.binance.com/login',
    'https://web3.binance.com:8080/login', 'https://web3.binance.com/login#bad', 'https://web3.binance.com/\\bad']) {
    const blocked = createFastTradeCli({ ...config, allowAuth: true, execute: async () => success({ ...auth, urlForWeb: bad }) });
    await assert.rejects(blocked.signin(), { code: 'AUTH_URL_REVIEW_REQUIRED' });
  }
  const connected = createFastTradeCli({ ...config, allowAuth: true, execute: async () => success({ status: 'ALREADY_CONNECTED', cookie: secret }) });
  assert.deepEqual(await connected.signin(), { status: 'ALREADY_CONNECTED' });
});
test('verify uses blocking documented command and independently confirms connected status only once', async () => {
  const calls = [];
  const cli = createFastTradeCli({ ...config, allowAuth: true, execute: async (_e, args, options) => {
    calls.push(args.slice(1));
    if (args[1] === 'auth') { assert.equal(options.timeout, 310000); return success({ status: 'SUCCESS', sessionToken: secret }); }
    return success({ status: 'CONNECTED' });
  } });
  const [a, b] = await Promise.all([cli.verify(auth.qrCodeId), cli.verify(auth.qrCodeId)]);
  assert.deepEqual(a, { status: 'SUCCESS', verified: true }); assert.deepEqual(b, a);
  assert.deepEqual(calls, [['auth', 'verify', '--qrCodeId', auth.qrCodeId, '--json'], ['wallet', 'status', '--json']]);
  const disconnected = createFastTradeCli({ ...config, allowAuth: true, execute: async (_e, args) => success({ status: args[1] === 'auth' ? 'SUCCESS' : 'UNCONNECTED' }) });
  assert.equal((await disconnected.verify(auth.qrCodeId)).verified, false);
});
test('quoteSwap uses a fixed quote command and executeSwap remains forbidden without write capability', async () => {
  let calls = 0;
  const cli = createFastTradeCli({ ...config, execute: async (_e, args) => {
    calls++; assert.deepEqual(args.slice(1), ['market-order', 'quote', '--fromTokenQty', '0.05', '--fromToken', from, '--toToken', to,
      '--binanceChainId', '56', '--slippage', '5', '--json']);
    return success({ fromCoinAmount: '0.05', toCoinAmount: '10', fromCoinSymbol: 'BNB', toCoinSymbol: 'TEST', clientId: secret });
  } });
  assert.equal((await cli.quoteSwap(trade)).toCoinAmount, '10');
  assert.equal((await cli.executeSwap(trade)).code, 'WRITES_DISABLED'); assert.equal(calls, 1);
});
test('swap submission uses bounded explicit amount with MEV and blocks duplicate or new writes until reconciliation', async () => {
  let writes = 0;
  const cli = createFastTradeCli({ ...config, allowWrites: true, execute: async (_e, args) => {
    if (args[2] === 'swap') {
      writes++; assert.deepEqual(args.slice(1), ['market-order', 'swap', '--fromTokenQty', '0.05', '--fromToken', from, '--toToken', to,
        '--binanceChainId', '56', '--slippage', '5', '--mev', 'true', '--gasLevel', 'MEDIUM', '--json']);
      return success({ orderId: '456', privateKey: secret });
    }
    assert.deepEqual(args.slice(1), ['market-order', 'list', '--orderId', '456', '--json']);
    return success({ list: [{ orderId: '456', chain: '56', fromToken: from, toToken: to, fromTokenQty: '0.05', status: 'FINISHED', txHash: broadcast.txHash, sessionToken: secret }] });
  } });
  const results = await Promise.all([cli.executeSwap(trade), cli.executeSwap(trade)]);
  assert.equal(writes, 1); assert.equal(results[0].outcome, 'SUBMITTED'); assert.ok(!JSON.stringify(results).includes(secret));
  assert.equal((await cli.executeSwap({ ...trade, amount: '0.06' })).code, 'SWAP_PENDING');
  assert.equal((await cli.readOrder({ chainId: '56', orderId: '456' })).list[0].status, 'FINISHED');
  await cli.executeSwap(trade); assert.equal(writes, 2);
});
test('unknown swap response is sticky even when user clicks twice and is not downgraded to a safe rejection', async () => {
  let writes = 0;
  const cli = createFastTradeCli({ ...config, allowWrites: true, execute: async () => { writes++; throw { killed: true, stdout: secret, stderr: secret }; } });
  const a = await cli.executeSwap(trade), b = await cli.executeSwap(trade);
  assert.equal(a.outcome, 'UNKNOWN'); assert.deepEqual(b, a); assert.equal(writes, 1);
  assert.equal((await cli.executeSwap({ ...trade, amount: '0.06' })).code, 'SWAP_PENDING');
  assert.ok(!JSON.stringify(a).includes(secret));
});
test('typed swap/auth/order validation rejects arbitrary fields, zero/all amounts and identity mismatches', async () => {
  const cli = createFastTradeCli({ allowAuth: true, allowWrites: true, execute: () => assert.fail('no process'), resolveInstallation: () => assert.fail('no metadata') });
  for (const bad of [{ ...trade, args: ['--debug'] }, { ...trade, amount: 'all' }, { ...trade, amount: '0' }, { ...trade, slippage: 'auto' },
    { ...trade, slippage: '100' }, { ...trade, toToken: from }, { ...trade, amount: '-1' }]) {
    await assert.rejects(cli.quoteSwap(bad), { code: 'INVALID_REQUEST' }); await assert.rejects(cli.executeSwap(bad), { code: 'INVALID_REQUEST' });
  }
  await assert.rejects(cli.verify('--qrCodeId bad'), { code: 'INVALID_REQUEST' });
  await assert.rejects(cli.readOrder({ chainId: '56', orderId: '--debug' }), { code: 'INVALID_REQUEST' });
  const mismatch = createFastTradeCli({ ...config, execute: async () => success({ list: [{ orderId: 'other', chain: '56' }] }) });
  await assert.rejects(mismatch.readOrder({ chainId: '56', orderId: '456' }), { code: 'INVALID_RESPONSE' });
  const wrongQuote = createFastTradeCli({ ...config, execute: async () => success({ fromCoinAmount: '9', toCoinAmount: '10' }) });
  await assert.rejects(wrongQuote.quoteSwap(trade), { code: 'INVALID_RESPONSE' });
});
