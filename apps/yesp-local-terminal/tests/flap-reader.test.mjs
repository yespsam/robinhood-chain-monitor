import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { createFlapRpc, createFlapReader, decodeProbe, tokenAbi, portalAbi, BEACON_SLOT } from '../server/flap-reader.mjs';

const addr = n => '0x' + n.toString(16).padStart(40, '0');
const U = 10n ** 18n, block = '0x10', now = 1792760000000, zero = addr(0);
const probes = new Interface(['function assetProbe()', 'function buyCapacityProbe()', 'function actionStatusProbe()',
  'function buyPlanProbe(uint256,uint256)', 'function quoteFundingProbe(uint256)', 'function sellPlanCustomProbe(uint256,uint256)',
  'function claimableProbe()', 'function launchRouteProbe()', 'error Error(string)']);
const views = new Interface(['function portal() view returns(address)', 'function market() view returns(address)',
  'function probeOfMarket(address) view returns(address)', 'function implementation() view returns(address)', 'function token() view returns(address)']);
const quote = new Interface(['function quoteBuy(address,address,uint256) view returns(uint256,uint256,uint256,uint256)']);
const profile = { wallet: addr(1), market: addr(2), portal: addr(3), factory: addr(4), probe: addr(5), quote: addr(6),
  allocationSharesRaw: String(10n * U), quoteHintRaw: String(5n * U), quoteSearchMaxRaw: String(100n * U),
  buySlippageBps: 500, sellSlippageBps: 9900, codeHashes: { [addr(2)]: keccak256('0x60016000') },
  beacons: { [addr(2)]: { address: addr(7), implementation: addr(8) } } };
const probeRow = fields => ({ error: { code: 3, data: probes.encodeErrorResult('Error', [
  Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(';') + ';END'
]) } });
function fixture(options = {}) {
  const calls = [], p = structuredClone(profile);
  const phase = String(options.phase ?? 1), held = options.held ?? 0n, token = phase === '3' ? addr(9) : zero;
  const fields = {
    assetProbe: { BLOCK: '16', MARKET: p.market, QUOTE: p.quote, DECIMALS: '18', ...options.asset },
    buyCapacityProbe: { BLOCK: '16', PHASE: phase, HELD_SHARES: String(held), ROOM_SHARES: String(10n * U - held), LIMIT_SHARES: String(10n * U), ID: '1', ...options.capacity },
    actionStatusProbe: { BLOCK: '16', PHASE: phase, BUY_OK: phase === '1' ? '1' : '0', CLAIM_OK: phase === '3' ? '1' : '0', TOKEN: token, ...options.action },
    buyPlanProbe: { BLOCK: '16', RULES_OK: '1', BUY_SHARES: String(10n * U - held), MIN_SHARES: String((10n * U - held) * 95n / 100n), ...options.buy },
    sellPlanCustomProbe: { BLOCK: '16', SHARES: String(held), OUT_RAW: String(1000n * U), MIN_RAW: String(10n * U), ...options.sell },
    claimableProbe: { BLOCK: '16', PHASE: phase, STATE: 'READY', CLAIM_RAW: String(10n * U), ...options.claim },
    launchRouteProbe: { BLOCK: '16', PHASE: phase, TOKEN: token, ...options.route }
  };
  function row(method, params) {
    calls.push([method, params]);
    if (method === 'eth_chainId') return { result: options.chain ?? '0x38' };
    if (method === 'eth_blockNumber') return { result: block };
    if (method === 'eth_getBlockByNumber') return { result: { number: block, timestamp: '0x' + BigInt(now / 1000).toString(16), ...options.head } };
    if (method === 'eth_getCode') return { result: options.code ?? '0x60016000' };
    if (method === 'eth_getStorageAt') { assert.equal(params[1], BEACON_SLOT); return { result: (options.beacon ?? addr(7)).replace('0x', '0x' + '0'.repeat(24)) }; }
    if (method === 'eth_getBalance') return { result: '0xde0b6b3a7640000' };
    if (method === 'eth_getTransactionCount') return { result: '0x64' };
    assert.equal(method, 'eth_call');
    const tx = params[0];
    for (const abi of [probes, tokenAbi, portalAbi, views, quote]) {
      let parsed; try { parsed = abi.parseTransaction(tx); } catch { continue; }
      if (!parsed) continue;
      if (Object.hasOwn(fields, parsed.name)) return probeRow(fields[parsed.name]);
      const values = { balanceOf: [100n * U], allowance: [100n * U], probeOfMarket: [options.boundProbe ?? p.probe],
        market: [options.boundMarket ?? p.market], portal: [options.boundPortal ?? p.portal], factory: [options.boundFactory ?? p.factory],
        implementation: [options.implementation ?? addr(8)], token: [token] };
      if (parsed.name === 'quoteBuy') {
        const gross = parsed.args[2];
        return { result: quote.encodeFunctionResult('quoteBuy', [gross, 0n, 0n, gross * 2n]) };
      }
      assert.ok(values[parsed.name], parsed.name); return { result: abi.encodeFunctionResult(parsed.name, values[parsed.name]) };
    }
    assert.fail('Unexpected mocked eth_call');
  }
  const rpc = async (method, params) => {
    const result = row(method, params); if (result.error) { const e = new Error('MOCK_RPC_REVERT'); e.rpcError = result.error; throw e; }
    return result.result;
  };
  rpc.batch = async requests => requests.map(([method, params]) => row(method, params));
  return { reader: createFlapReader(p, { rpc, clock: () => now }), calls, fields, profile: p };
}

test('snapshot pins contract views to one block and verifies bindings, deployed code and beacon implementation', async () => {
  const c = fixture(), s = await c.reader.snapshot();
  assert.equal(s.block, block); assert.equal(s.phase, 1); assert.equal(s.roomRaw, 10n * U); assert.equal(s.balanceRaw, 100n * U);
  assert.equal(s.eligible, true); assert.equal(s.buyOk, true);
  for (const [method, params] of c.calls) if (['eth_call', 'eth_getCode', 'eth_getBalance'].includes(method)) assert.equal(params.at(-1), block);
  assert.equal(BEACON_SLOT, '0x' + (BigInt(keccak256(toUtf8Bytes('eip1967.proxy.beacon'))) - 1n).toString(16));
});
test('snapshot rejects address rebinding, proxy implementation upgrades and changed runtime bytecode', async () => {
  for (const patch of [{ boundProbe: addr(99) }, { boundMarket: addr(99) }, { boundPortal: addr(99) }, { boundFactory: addr(99) },
    { asset: { MARKET: addr(99) } }, { asset: { QUOTE: addr(99) } }, { asset: { DECIMALS: '6' } }])
    await assert.rejects(fixture(patch).reader.snapshot(), { code: 'MARKET_BINDING_CHANGED' });
  for (const patch of [{ beacon: addr(99) }, { implementation: addr(99) }])
    await assert.rejects(fixture(patch).reader.snapshot(), { code: 'CONTRACT_UPGRADED' });
  await assert.rejects(fixture({ code: '0x60026000' }).reader.snapshot(), { code: 'CONTRACT_CODE_CHANGED' });
});
test('snapshot rejects wrong chain, stale/future blocks, missing quantities and inconsistent capacity', async () => {
  await assert.rejects(fixture({ chain: '0x1' }).reader.snapshot(), { code: 'CHAIN_MISMATCH' });
  for (const seconds of [-11, 3]) await assert.rejects(fixture({ head: { timestamp: '0x' + BigInt(now / 1000 + seconds).toString(16) } }).reader.snapshot(), { code: 'STALE_BLOCK' });
  for (const field of ['HELD_SHARES', 'ROOM_SHARES', 'LIMIT_SHARES'])
    await assert.rejects(fixture({ capacity: { [field]: undefined } }).reader.snapshot(), { code: 'INVALID_CHAIN_AMOUNT' });
  await assert.rejects(fixture({ capacity: { ROOM_SHARES: String(11n * U) } }).reader.snapshot(), { code: 'CHAIN_STATE_INCONSISTENT' });
  await assert.rejects(fixture({ action: { PHASE: '3' } }).reader.snapshot(), { code: 'CHAIN_STATE_INCONSISTENT' });
});
test('snapshot rejects an RPC block response belonging to a different height', async () => {
  await assert.rejects(fixture({ head: { number: '0x11' } }).reader.snapshot());
});
test('snapshot rejects absent phase instead of returning NaN', async () => {
  await assert.rejects(fixture({ capacity: { PHASE: undefined }, action: { PHASE: undefined } }).reader.snapshot());
});
test('probe parser requires complete, unique fields and encoded Error(string)', () => {
  assert.equal(decodeProbe(probeRow({ BLOCK: '16', ID: '1' })).ID, '1');
  for (const text of ['ID=1', 'ID=1;ID=2;END', 'ID;END']) {
    assert.throws(() => decodeProbe({ error: { data: probes.encodeErrorResult('Error', [text]) } }));
  }
  assert.throws(() => decodeProbe({ result: '0x' }), { code: 'PROBE_UNREADABLE' });
});
test('buy plan verifies the fixed-block quote against executable limits and never accepts a newly over-cap plan', async () => {
  const c = fixture(), s = await c.reader.snapshot(), p = await c.reader.buyPlan(s);
  assert.equal(p.kind, 'buy'); assert.equal(p.grossRaw, 5n * U); assert.equal(p.sharesRaw, 10n * U); assert.equal(p.minSharesRaw, 95n * U / 10n);
  for (const buy of [{ RULES_OK: '0' }, { BLOCK: '17' }, { BUY_SHARES: String(10n * U + 1n) }, { MIN_SHARES: '0' }]) {
    const f = fixture({ buy }); await assert.rejects(f.reader.buyPlan(await f.reader.snapshot()));
  }
  const full = fixture({ held: 10n * U }); await assert.rejects(full.reader.buyPlan(await full.reader.snapshot()), { code: 'ALLOCATION_FULL' });
});
test('claim requires launched phase, READY state, positive claim amount and matching live token', async () => {
  const c = fixture({ phase: 3 }), p = await c.reader.claimPlan(await c.reader.snapshot());
  assert.equal(p.kind, 'claim'); assert.equal(p.token, addr(9)); assert.equal(p.claimRaw, 10n * U);
  for (const patch of [{ phase: 1 }, { phase: 3, action: { CLAIM_OK: '0' } }, { phase: 3, claim: { STATE: 'WAITING' } },
    { phase: 3, claim: { CLAIM_RAW: '0' } }, { phase: 3, route: { TOKEN: addr(99) } }, { phase: 3, action: { TOKEN: addr(99) } }]) {
    const f = fixture(patch); await assert.rejects(f.reader.claimPlan(await f.reader.snapshot()));
  }
});
test('claim probes are pinned to the snapshot block even though their documented payload omits BLOCK', async () => {
  const c = fixture({ phase: 3, claim: { BLOCK: undefined }, route: { BLOCK: undefined } });
  const snapshot = await c.reader.snapshot(); c.calls.length = 0;
  await c.reader.claimPlan(snapshot);
  assert.equal(c.calls.length, 2);
  for (const [method, params] of c.calls) { assert.equal(method, 'eth_call'); assert.equal(params[1], block); }
});
test('sell rejects shares/block mismatches and output minimum above quote', async () => {
  const c = fixture({ held: 10n * U }), p = await c.reader.sellPlan(await c.reader.snapshot());
  assert.equal(p.kind, 'sell'); assert.equal(p.minOutRaw, 10n * U);
  for (const sell of [{ SHARES: '1' }, { BLOCK: '17' }, { MIN_RAW: String(1001n * U) }]) {
    const f = fixture({ held: 10n * U, sell }); await assert.rejects(f.reader.sellPlan(await f.reader.snapshot()));
  }
});
test('sell does not accept a minimum below the explicitly configured slippage bound', async () => {
  const c = fixture({ held: 10n * U, sell: { MIN_RAW: '0' } });
  await assert.rejects(c.reader.sellPlan(await c.reader.snapshot()));
});
test('RPC adapter is read-only, matches batch IDs despite reordering and rejects duplicate/missing responses', async () => {
  let requests;
  const rpc = createFlapRpc({ fetchImpl: async (_url, options) => {
    requests = JSON.parse(options.body); return { ok: true, text: async () => JSON.stringify(requests.map(q => ({ jsonrpc: '2.0', id: q.id, result: q.method })).reverse()) };
  } });
  const result = await rpc.batch([['eth_chainId', []], ['eth_blockNumber', []]]);
  assert.deepEqual(result.map(r => r.result), ['eth_chainId', 'eth_blockNumber']); assert.equal(requests.length, 2);
  await assert.rejects(rpc('eth_sendRawTransaction', ['0xdeadbeef']), { code: 'RPC_WRITE_FORBIDDEN' });
  for (const malformed of [[], [{ jsonrpc: '2.0', id: 999, result: '0x38' }], [{ jsonrpc: '1.0', id: 1, result: '0x38' }]]) {
    const bad = createFlapRpc({ fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(malformed) }) });
    await assert.rejects(bad('eth_chainId', []), { code: 'RPC_INVALID_RESPONSE' });
  }
});
