import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialWallet } from '../server/official-cli.mjs';
import { addressKey, estimateAssets, reviewBlockers, NATIVE, validContract, orderState } from '../server/model.mjs';
import { demoSnapshot, demoQuote } from '../server/fixtures.mjs';
const usdt = '0x55d398326f99059fF775485246999027B3197955';
test('official quote uses documented flags and never guesses missing review fields', async () => {
  let args; const wallet = new OfficialWallet(async a => { args = a; return { success: true, data: { toCoinAmount: '1.234', secret: 'synthetic-private-field' } }; });
  const q = await wallet.quote({ chainId: '56', fromToken: NATIVE, toToken: usdt, amount: '0.1', slippage: '0.5' });
  assert.deepEqual(args, ['market-order', 'quote', '--fromTokenQty', '0.1', '--fromToken', NATIVE, '--toToken', usdt, '--binanceChainId', '56', '--slippage', '0.5']);
  assert.equal(q.estimatedOut, '1.234'); assert.equal(q.gasTotal, null); assert.equal(q.secret, undefined); assert.ok(reviewBlockers(q).length >= 5);
});
test('bad contracts, flags, nondecimal and out-of-range amounts never call CLI', async () => {
  let calls = 0; const wallet = new OfficialWallet(async () => { calls++; });
  const q = { chainId: '56', fromToken: NATIVE, toToken: usdt, amount: '0.1', slippage: '0.5' };
  for (const extra of [{ amount: '1e9' }, { amount: '-1' }, { amount: '0' }, { slippage: '101' }, { chainId: '--help' }, { toToken: '$(malicious)' }]) await assert.rejects(wallet.quote({ ...q, ...extra }));
  assert.equal(calls, 0);
});
test('balances enforce returned network/contract and allowlist only public data fields', async () => {
  const response = [{ symbol: 'USDT', address: usdt, binanceChainId: '56', balance: '1', price: '1', token: 'synthetic-sensitive' }];
  const wallet = new OfficialWallet(async () => ({ success: true, data: response }));
  const data = await wallet.balance('56', usdt); assert.equal(data[0].token, undefined); assert.equal(data[0].priceUsd, '1');
  response[0].binanceChainId = '1'; await assert.rejects(wallet.balance('56'), { code: 'OFFICIAL_RESPONSE_CHAIN_MISMATCH' });
  response[0].binanceChainId = '56'; response[0].address = NATIVE; await assert.rejects(wallet.balance('56', usdt), { code: 'OFFICIAL_RESPONSE_TOKEN_MISMATCH' });
});
test('official auth link is returned verbatim, verify needs wallet CONNECTED, and no session secrets returned', async () => {
  const url = 'https://web3.binance.com/en/agent-login?expireAt=1&url=synthetic'; let state = 'UNCONNECTED';
  const wallet = new OfficialWallet(async a => ({ success: true, data: a[1] === 'signin' ? { urlForWeb: url, pairingCode: '654321', qrCodeId: 'synthetic-id', expireAt: '1', clientToken: 'never-output' } : a[1] === 'verify' ? { status: 'SUCCESS' } : { status: state } }));
  const start = await wallet.beginOfficialSignIn(); assert.equal(start.urlForWeb, url); assert.equal(start.pairingCode, '654321'); assert.equal(start.clientToken, undefined);
  assert.equal((await wallet.verifyOfficialSignIn(start.qrCodeId)).verified, false);
  state = 'CONNECTED'; assert.equal((await wallet.verifyOfficialSignIn(start.qrCodeId)).verified, true);
  const unsafe = new OfficialWallet(async () => ({ success: true, data: { urlForWeb: 'https://attacker.example/', pairingCode: '123', qrCodeId: 'id' } }));
  await assert.rejects(unsafe.beginOfficialSignIn(), { code: 'AUTH_URL_REVIEW_REQUIRED' });
});
test('unsupported limit networks and Solana EVM approvals are explicitly rejected', async () => {
  const wallet = new OfficialWallet(async () => assert.fail('must not call'));
  await assert.rejects(wallet.orders('8453', 'limit'), { code: 'LIMIT_CHAIN_UNSUPPORTED' });
  await assert.rejects(wallet.approvals('CT_501'), { code: 'APPROVALS_EVM_ONLY' });
});
test('same symbol/contract does not merge networks; Solana is case sensitive', () => {
  assert.notEqual(addressKey('56', usdt), addressKey('1', usdt));
  assert.equal(addressKey('56', usdt), addressKey('56', usdt.toLowerCase()));
  assert.notEqual(addressKey('CT_501', 'ABCD'), addressKey('CT_501', 'AbCD'));
  assert.throws(() => validContract('56', 'DEMO-BSC-TOKEN-NOT-A-CONTRACT'));
});
test('missing/invalid price is unknown and PnL absent; decimal values do not use float arithmetic', () => {
  const result = estimateAssets([{ balance: '0.1', priceUsd: '0.2' }, { balance: '10', priceUsd: null }, { balance: '4', priceUsd: 'bad' }]);
  assert.equal(result.knownValueUsd, '0.020000000000000000'); assert.equal(result.unpricedCount, 2); assert.equal(result.totalComplete, false);
  assert.equal(result.assets[1].valueUsd, null); assert.equal(result.pnl, null);
});
test('fixtures are marked disconnected, no real hashes, and cross-network quote substitution fails', () => {
  const snapshot = demoSnapshot(); assert.equal(snapshot.connected, false); assert.equal(snapshot.mode, 'mock'); assert.equal(snapshot.knownValueUsd, '1740.000000000000000000');
  assert.ok(snapshot.transactions.every(x => x.hash === null)); assert.ok(snapshot.assets.every(x => x.pnl === null));
  const q = { chainId: '56', fromToken: NATIVE, toToken: usdt, amount: '0.1', slippage: '0.5', kind: 'market' };
  assert.ok(reviewBlockers(demoQuote(q)).includes('模拟报价不能用于真实交易'));
  assert.throws(() => demoQuote({ ...q, chainId: '1' }), { code: 'TOKEN_PAIR_NOT_IN_DEMO' });
  assert.throws(() => demoQuote({ ...q, wallet: 'attacker' }), { code: 'INVALID_QUOTE_FIELDS' });
});
test('submission, execution and broadcast never share a success label', () => {
  assert.notEqual(orderState('SUBMITTED'), orderState('FINISHED')); assert.match(orderState('BROADCASTED'), /待链上确认/);
  assert.match(orderState('new-unknown-value'), /未知/);
});

test('official signin links preserve dynamic paths and query strings verbatim on reviewed domains', async () => {
  for (const host of ['web3.binance.com', 'www.binance.com', 'app.binance.com']) {
    const urlForWeb = `https://${host}/new/vendor-login/path?url=synthetic%2Fencoded%2Bvalue&expireAt=1`;
    const wallet = new OfficialWallet(async () => ({ success: true, data: { urlForWeb, pairingCode: '654321', qrCodeId: 'synthetic-id', expireAt: 1 } }));
    assert.equal((await wallet.beginOfficialSignIn()).urlForWeb, urlForWeb);
  }
});
