import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioReader, createPublicBscRpc, BSC_CONTRACTS, BSC_RPC_ENDPOINTS } from '../server/portfolio.mjs';
import { formatUnits } from '../server/model.mjs';
import { LocalWalletAccess } from '../server/local-wallet.mjs';

const walletAddress = '0x1111111111111111111111111111111111111111';
const now = Date.parse('2026-10-23T06:00:00.000Z'), clock = () => now;
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const hash = '0x' + 'a'.repeat(64);
function fixture({ fail, editBlock, changeBlock = false } = {}) {
  const calls = [], head = 1000n; let blocks = 0, inFlight = 0, maxInFlight = 0;
  const values = {
    [`${BSC_CONTRACTS.usdt}:0x70a08231`]: 123456789000000000000n,
    [`${BSC_CONTRACTS.ptah}:0x70a08231`]: 0n,
    [`${BSC_CONTRACTS.usdt}:0x313ce567`]: 18n,
    [`${BSC_CONTRACTS.ptah}:0x313ce567`]: 18n,
    [`${BSC_CONTRACTS.relic}:0x70a08231`]: 9007199254740993n,
    [`${BSC_CONTRACTS.loom}:0x70a08231`]: 0n,
    [`${BSC_CONTRACTS.mining}:0xb55e511d`]: 0n,
    [`${BSC_CONTRACTS.mining}:0xcd3293de`]: 0n,
    [`${BSC_CONTRACTS.mining}:0x402914f5`]: 0n,
    [`${BSC_CONTRACTS.mining}:0xdd4bc101`]: 0n,
    [`${BSC_CONTRACTS.mining}:0x96c82e57`]: 124n
  };
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_getBlockByNumber') {
      blocks++; const b = { number: '0x3e6', hash: changeBlock && blocks > 1 ? '0x' + 'b'.repeat(64) : hash,
        timestamp: '0x' + BigInt(now / 1000 - 3).toString(16) };
      return editBlock ? editBlock(b) : b;
    }
    inFlight++; maxInFlight = Math.max(inFlight, maxInFlight);
    try {
      await new Promise(setImmediate);
      if (fail?.(method, params)) throw Error('PRIVATE_PROVIDER_DETAIL_DO_NOT_EXPOSE');
      if (method === 'eth_getBalance') return '0xde0b6b3a7640001';
      const c = params[0], value = values[c.to + ':' + c.data.slice(0, 10)];
      assert.notEqual(value, undefined, 'only reviewed contracts/selectors may be called');
      return word(value);
    } finally { inFlight--; }
  };
  return { rpc, values, calls, concurrency: () => maxInFlight };
}
const read = f => createPortfolioReader({ rpc: f.rpc, clock })({ chainId: '56', walletAddress });
test('same-block live portfolio preserves precision, real zero, source, and limited coverage', async () => {
  const f = fixture(), p = await read(f);
  assert.equal(p.mode, 'live'); assert.equal(p.walletAddress, walletAddress); assert.equal(p.status, 'ok');
  assert.equal(p.complete, true); assert.equal(p.totalComplete, false); assert.equal(p.knownValueUsd, null);
  assert.equal(p.block.number, '998'); assert.equal(p.block.hash, hash); assert.equal(p.observedAt, new Date(now).toISOString());
  assert.equal(p.assets[0].balance, '1.000000000000000001'); assert.equal(p.assets[1].balance, '123.456789');
  assert.equal(p.assets[2].balance, '0'); assert.ok(p.assets.every(a => a.priceUsd === null && a.valueUsd === null));
  assert.equal(p.nfts[0].quantity, '9007199254740993'); assert.equal(p.nfts[1].quantity, '0');
  assert.equal(p.mining.emissionStarted, false); assert.equal(p.mining.claimable, '0'); assert.equal(p.mining.emissionStartAt, null);
  assert.equal(p.errors.length, 0); assert.ok(f.concurrency() <= 4);
  for (const c of f.calls.filter(c => ['eth_call', 'eth_getBalance'].includes(c.method))) {
    assert.equal(c.params[1], '0x3e6');
    if (c.method === 'eth_call' && c.params[0].data.length > 10) assert.equal(c.params[0].data.slice(-40), walletAddress.slice(2));
  }
});
test('one failed NFT call is null and partial, never zero and never a mock fallback', async () => {
  const f = fixture({ fail: (m, p) => m === 'eth_call' && p[0].to === BSC_CONTRACTS.relic });
  const p = await read(f);
  assert.equal(p.status, 'partial'); assert.equal(p.complete, false); assert.equal(p.nfts[0].quantity, null);
  assert.equal(p.nfts[0].errorCode, 'RPC_READ_FAILED'); assert.equal(p.nfts[1].quantity, '0');
  assert.equal(p.assets[0].balance, '1.000000000000000001'); assert.equal(p.errors[0].field, 'relic');
  assert.ok(!JSON.stringify(p).includes('PRIVATE_PROVIDER')); assert.equal(p.mode, 'live');
});
test('all quantity reads failing yields unavailable, with no fabricated balances', async () => {
  const p = await read(fixture({ fail: () => true }));
  assert.equal(p.status, 'unavailable'); assert.equal(p.complete, false); assert.equal(p.errors.length, 12);
  assert.ok(p.assets.every(x => x.balance === null)); assert.ok(p.nfts.every(x => x.quantity === null));
});
test('unknown token precision keeps raw quantity but cannot fabricate human amounts or mining rewards', async () => {
  const f = fixture({ fail: (m, p) => m === 'eth_call' && p[0].to === BSC_CONTRACTS.ptah && p[0].data === '0x313ce567' });
  const p = await read(f); assert.equal(p.assets[2].rawBalance, '0'); assert.equal(p.assets[2].balance, null);
  assert.equal(p.assets[2].decimals, null); assert.equal(p.assets[2].status, 'unavailable');
  assert.equal(p.mining.reserveRaw, '0'); assert.equal(p.mining.reserve, null); assert.equal(p.mining.claimable, null);
  const invalid = fixture(); invalid.values[BSC_CONTRACTS.usdt + ':0x313ce567'] = 256n;
  assert.equal((await read(invalid)).assets[1].errorCode, 'RPC_INVALID_DECIMALS');
});
test('wrong network, stale block, or reorganization invalidates all chain quantities', async () => {
  const wrong = fixture(); const original = wrong.rpc;
  wrong.rpc = (m, p) => m === 'eth_chainId' ? '0x1' : original(m, p);
  for (const [f, expected] of [[wrong, 'RPC_WRONG_CHAIN'], [fixture({ changeBlock: true }), 'RPC_SNAPSHOT_CHANGED'],
    [fixture({ editBlock: b => ({ ...b, timestamp: '0x1' }) }), 'RPC_STALE_BLOCK']]) {
    const p = await read(f); assert.equal(p.status, 'unavailable'); assert.equal(p.block, null); assert.equal(p.complete, false);
    assert.ok(p.assets.every(x => x.balance === null)); assert.ok(p.nfts.every(x => x.quantity === null));
    assert.equal(p.mining.emissionStarted, null); assert.ok(p.errors.some(x => x.code === expected));
  }
  assert.equal(wrong.calls.length, 0, 'wrong chain never queries a wallet balance');
});
test('empty ABI data is an unknown balance, not zero; active emission is derived from block time', async () => {
  const f = fixture(), original = f.rpc;
  f.values[BSC_CONTRACTS.mining + ':0xb55e511d'] = BigInt(now / 1000 - 100);
  f.rpc = (m, p) => m === 'eth_call' && p[0].to === BSC_CONTRACTS.loom ? '0x' : original(m, p);
  const p = await read(f); assert.equal(p.nfts[1].quantity, null); assert.equal(p.nfts[1].errorCode, 'RPC_INVALID_RESPONSE');
  assert.equal(p.mining.emissionStarted, true); assert.equal(p.mining.emissionStartAt, new Date(now - 100000).toISOString());
});
test('invalid wallet or unsupported chain is rejected before any RPC call', async () => {
  const reader = createPortfolioReader({ rpc: () => assert.fail('no RPC') });
  await assert.rejects(reader({ chainId: '1', walletAddress }), { code: 'PORTFOLIO_CHAIN_UNSUPPORTED' });
  await assert.rejects(reader({ chainId: '56', walletAddress: 'mock-wallet' }), { code: 'INVALID_CONTRACT' });
});
test('public transport only calls fixed HTTPS endpoints and refuses state changes, overrides and oversized output', async () => {
  const urls = [], rpc = createPublicBscRpc({ fetchImpl: async (url, options) => {
    urls.push(url); const request = JSON.parse(options.body);
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    if (urls.length === 1) throw Error('SECRET');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x38' }));
  } });
  assert.equal(await rpc('eth_chainId', []), '0x38'); assert.deepEqual(urls, BSC_RPC_ENDPOINTS);
  for (const [m, p] of [['eth_sendRawTransaction', ['0x00']], ['eth_sendTransaction', [{}]],
    ['eth_call', [{ to: BSC_CONTRACTS.ptah, data: '0x095ea7b3' }, '0x1']],
    ['eth_call', [{ to: BSC_CONTRACTS.ptah, data: '0x313ce567' }, '0x1', {}]]])
    await assert.rejects(rpc(m, p), { code: 'RPC_METHOD_NOT_ALLOWED' });
  assert.equal(urls.length, 2);
  const large = createPublicBscRpc({ fetchImpl: async () => new Response('x'.repeat(256 * 1024 + 1)) });
  await assert.rejects(large('eth_chainId', []), e => e.code === 'RPC_UNAVAILABLE' && !e.message.includes('SECRET'));
});
test('unit formatter never converts uint256 through a floating point number', () => {
  assert.equal(formatUnits('9007199254740993000000000000000001', 18), '9007199254740993.000000000000000001');
  assert.equal(formatUnits('0', 18), '0'); assert.equal(formatUnits('23', 0), '23');
  for (const n of ['-1', '1.2', '01', (2n ** 256n).toString()]) assert.throws(() => formatUnits(n, 18));
});
async function boundLocal(reader) {
  const wallet = { status: async () => 'CONNECTED', settings: async () => ({ sessionExpireTime: new Date(now + 600000).toISOString(),
    inactiveSignOutTime: new Date(now + 600000).toISOString() }), chains: async () => [{ id: '56', name: 'BSC' }],
    addresses: async () => [{ chainId: '56', address: walletAddress }], beginOfficialSignIn: () => assert.fail('already connected') };
  const local = new LocalWalletAccess(wallet, clock, { portfolioReader: reader }), key = local.bootstrap().token;
  await local.start(key, { checkOnly: true }); await local.verification;
  await local.bind(key, { candidateId: local.state(key).candidateId, confirmed: true }); return { local, key };
}
test('portfolio route uses the confirmed wallet only and rechecks binding before releasing data', async () => {
  let received; const c = await boundLocal(async value => { received = value; return { mode: 'live', walletAddress: 'cannot-override-binding' }; });
  const p = await c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'portfolio' });
  assert.deepEqual(received, { chainId: '56', walletAddress }); assert.equal(p.walletAddress, walletAddress);
  assert.equal(c.local.state(c.key).capabilities.livePortfolio, true);
  assert.equal(c.local.state(c.key).capabilities.manualTrades, false);
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'portfolio', walletAddress }), { code: 'UNEXPECTED_FIELD' });
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'portfolio', contract: BSC_CONTRACTS.relic }), { code: 'UNEXPECTED_FIELD' });
  c.local.portfolioReader = async () => { c.local.lock(); return { mode: 'live' }; };
  await assert.rejects(c.local.handle('/api/wallet/read', c.key, { chainId: '56', kind: 'portfolio' }), { code: 'LOCAL_SESSION_EXPIRED' });
});
test('manual trade capability remains off unless the application injects a separate service', () => {
  const normal = new LocalWalletAccess({}, clock), normalKey = normal.bootstrap().token;
  assert.equal(normal.state(normalKey).capabilities.manualTrades, false);
  const enabled = new LocalWalletAccess({}, clock, { tradeService: {} }), key = enabled.bootstrap().token;
  assert.equal(enabled.state(key).capabilities.manualTrades, true);
  assert.equal(enabled.state(key).capabilities.liveTrades, true);
});
