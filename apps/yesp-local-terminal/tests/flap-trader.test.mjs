import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlapTrader, validatePreview } from '../server/flap-trader.mjs';
import { portalAbi, tokenAbi, tradeEvents } from '../server/flap-reader.mjs';

const addr = n => '0x' + n.toString(16).padStart(40, '0'), U = 10n ** 18n, now = 1792760000000;
const hash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64);
const profile = { id: 'heyi', name: 'Heyi.ai', chainId: '56', wallet: addr(1), market: addr(2), portal: addr(3), factory: addr(4), quote: addr(5), probe: addr(6),
  quoteSymbol: 'BNCB', buySlippageBps: 500, sellSlippageBps: 9900, priorAuditUnavailableAcknowledged: true,
  codeHashes: Object.fromEntries([2, 3, 4, 5, 6].map(n => [addr(n), '0x' + 'c'.repeat(64)])) };
const buyPlan = { kind: 'buy', grossRaw: 5n * U, sharesRaw: 10n * U, targetSharesRaw: 10n * U, minSharesRaw: 95n * U / 10n,
  refundRaw: 0n, requiredFundingRaw: 0n, calls: 1, blockTag: '0x10' };
const buyTx = { chainId: '56', from: profile.wallet, to: profile.portal, value: '0',
  inputData: portalAbi.encodeFunctionData('buyWithQuote', [profile.market, buyPlan.grossRaw, buyPlan.minSharesRaw]) };
function preview(tx = buyTx, change = String(-buyPlan.grossRaw)) {
  return { outcome: 'PREVIEWED', data: { requestId: 'preview-1', expiresAt: now + 60000,
    parsedTx: { transactionType: 'ContractInteraction', action: tx.inputData.slice(0, 10), contractAddress: tx.to },
    simulationResult: { simulationCode: '000000000', simulationErrorDetail: null, gasTokenFromData: 0,
      balanceChanges: [{ owner: profile.wallet, contractAddress: profile.quote, tokenType: 'Erc20', change }], allowanceChanges: [], authorityChanges: [] },
    risks: { riskDetails: [], riskBehaviors: [], addresses: {} } } };
}
function memoryJournal(onSave = () => {}) {
  const rows = new Map(); let locked = false;
  return { rows, async read(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    async all() { return [...rows.values()].map(r => structuredClone(r)); },
    async save(record, { create = false } = {}) {
      if (create && rows.has(record.intentId)) throw Object.assign(new Error(), { code: 'EEXIST' });
      await onSave(record); rows.set(record.intentId, structuredClone(record)); return record;
    }, async exclusive(fn) { if (locked) throw Object.assign(new Error(), { code: 'UNRESOLVED_TRADE_LOCK' });
      locked = true; try { return await fn(); } finally { locked = false; } } };
}
function fixture(options = {}) {
  let time = now, snapshots = 0, writes = 0, previews = 0, reads = 0, submittedTx = buyTx;
  const submittedGross = options.receiptGross ?? buyPlan.grossRaw;
  const event = tradeEvents.encodeEventLog(tradeEvents.getEvent('VirtualTrade'), [1n, profile.wallet, options.side ?? 0, 10n * U,
    submittedGross, submittedGross, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
  const transfer = tokenAbi.encodeEventLog(tokenAbi.getEvent('Transfer'), [profile.wallet, profile.market, submittedGross]);
  const rec = { transactionHash: hash, from: profile.wallet, to: profile.portal, status: '0x1', blockHash, blockNumber: '0x11', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    logs: [{ address: profile.market, ...event }, { address: profile.quote, ...transfer }] };
  const journal = memoryJournal(record => {
    if (options.expireAfterIntent && record.steps.at(-1)?.status === 'SUBMITTING') time = now + 15001;
  });
  const reader = {
    async snapshot() {
      snapshots++; if (options.failFinalSnapshot && snapshots > 1) throw Object.assign(new Error(), { code: 'RPC_UNAVAILABLE' });
      if (options.expireDuringSnapshot) time = now + 15001;
      return { block: '0x10', snapshotAtMs: now, readMs: 1, phase: 1, sharesRaw: snapshots > 1 ? 10n * U : 0n,
        roomRaw: 10n * U, limitRaw: 10n * U, balanceRaw: 100n * U, allowanceRaw: 100n * U, nativeRaw: U,
        nonce: '0x64', pendingNonce: options.pending ? '0x65' : '0x64', eligible: true, buyOk: true, claimOk: false };
    },
    async buyPlan() { return structuredClone(buyPlan); },
    async probe() { return { BALANCE_OK: '1', ALLOWANCE_OK: '1' }; },
    async rpc(method) {
      if (method === 'eth_getTransactionReceipt') return rec;
      if (method === 'eth_getTransactionByHash') return { from: profile.wallet, to: submittedTx.to, input: submittedTx.inputData, value: '0x0', blockHash };
      assert.fail('unexpected RPC method ' + method);
    }
  };
  const cli = {
    async status() { reads++; return { status: options.disconnected ? 'UNCONNECTED' : 'CONNECTED' }; },
    async addresses() { return { addresses: [{ binanceChainId: '56', address: profile.wallet }] }; },
    async settings() { return { devMode: { enabled: true } }; },
    async txLock() { return { status: 'UNLOCKED' }; },
    async previewContract(tx) { previews++; submittedTx = tx; if (options.expireDuringPreview) time = now + 15001; return preview(tx); },
    async executePreview() { writes++; return options.submitted ? { outcome: 'SUBMITTED', data: { orderId: '12345', txHash: hash } }
      : { outcome: 'UNKNOWN', code: 'SUBMISSION_UNKNOWN' }; },
    async executeSwap() { assert.fail('no swap expected'); }
  };
  const trader = createFlapTrader({ allowWrites: options.allowWrites ?? true, profile, reader, cli, journal,
    clock: () => time, sleep: async ms => { time += ms; } });
  return { trader, cli, reader, journal, writes: () => writes, previews: () => previews, reads: () => reads };
}
const request = (intentId = 'intent-00000001') => ({ profile: 'heyi', action: 'buy', intentId, deadlineMs: 15000 });

test('default no-write capability rejects trade before touching wallet or journal', async () => {
  const c = fixture({ allowWrites: false });
  await assert.rejects(c.trader.handle('trade', request()), { code: 'WRITES_DISABLED' });
  assert.equal(c.writes(), 0); assert.equal(c.previews(), 0); assert.equal(c.reads(), 0); assert.equal(c.journal.rows.size, 0);
});
test('15-second expiry during reads or preview prevents execute completely', async () => {
  for (const options of [{ expireDuringSnapshot: true }, { expireDuringPreview: true }]) {
    const c = fixture(options), { operation } = await c.trader.handle('trade', request());
    assert.equal(operation.error.code, 'SUBMISSION_DEADLINE_EXCEEDED'); assert.equal(operation.status, 'FAILED'); assert.equal(c.writes(), 0);
  }
});
test('deadline is checked after durable intent write, immediately before execute', async () => {
  const c = fixture({ expireAfterIntent: true }), { operation } = await c.trader.handle('trade', request());
  assert.equal(c.writes(), 0); assert.equal(operation.error.code, 'SUBMISSION_DEADLINE_EXCEEDED');
  assert.notEqual(operation.status, 'UNKNOWN');
});
test('UNKNOWN submission is persistent; same intent returns record and a new intent cannot resubmit', async () => {
  const c = fixture(), first = await c.trader.handle('trade', request());
  assert.equal(first.operation.status, 'UNKNOWN'); assert.equal(c.writes(), 1);
  const second = await c.trader.handle('trade', request()); assert.equal(second.operation.status, 'UNKNOWN'); assert.equal(c.writes(), 1);
  await assert.rejects(c.trader.handle('trade', request('intent-00000002')), { code: 'UNRESOLVED_TRADE_EXISTS' });
  assert.equal(c.writes(), 1);
});
test('pending wallet nonce or missing login blocks preview and submission', async () => {
  for (const [options, code] of [[{ pending: true }, 'PENDING_TRANSACTION'], [{ disconnected: true }, 'LOGIN_REQUIRED']]) {
    const c = fixture(options), { operation } = await c.trader.handle('trade', request());
    assert.equal(operation.error.code, code); assert.equal(c.previews(), 0); assert.equal(c.writes(), 0);
  }
});
test('buy receipt accepts verified side 0 and matches emitted shares and actual quote debit', async () => {
  const c = fixture({ submitted: true }), { operation } = await c.trader.handle('trade', request());
  assert.equal(operation.status, 'COMPLETE'); assert.equal(operation.steps[0].status, 'CONFIRMED');
  assert.equal(operation.steps[0].actualSharesRaw, String(10n * U)); assert.equal(operation.steps[0].actualQuoteRaw, String(5n * U));
  assert.equal(c.writes(), 1);
});
test('a wrong VirtualTrade side is never treated as a completed buy', async () => {
  const c = fixture({ submitted: true, side: 1 }), { operation } = await c.trader.handle('trade', request());
  assert.notEqual(operation.status, 'COMPLETE'); assert.equal(operation.error.code, 'BUY_SETTLEMENT_MISMATCH');
});
test('buy receipt cannot claim a larger debit than the exact authorized gross amount', async () => {
  const c = fixture({ submitted: true, receiptGross: 6n * U }), { operation } = await c.trader.handle('trade', request());
  assert.notEqual(operation.status, 'COMPLETE'); assert.equal(operation.error.code, 'BUY_SETTLEMENT_MISMATCH');
});
test('a failed holdings refresh does not change a confirmed on-chain buy into a failure', async () => {
  const c = fixture({ submitted: true, failFinalSnapshot: true }), { operation } = await c.trader.handle('trade', request());
  assert.equal(operation.status, 'COMPLETE'); assert.equal(operation.steps[0].status, 'CONFIRMED'); assert.equal(operation.error.code, 'RPC_UNAVAILABLE');
});
test('preview rejects unexpected contract, debit, authority, native payment, wallet owner or provider risk', () => {
  const context = { action: 'buy', profile, plan: buyPlan, tx: buyTx };
  assert.equal(validatePreview(preview(), context), 'preview-1');
  const mutations = [p => { p.data.parsedTx.contractAddress = addr(99); }, p => { p.data.simulationResult.gasTokenFromData = 1; },
    p => { p.data.simulationResult.balanceChanges[0].change = String(-6n * U); }, p => { p.data.simulationResult.balanceChanges[0].owner = addr(99); },
    p => { p.data.simulationResult.authorityChanges = [{ spender: addr(99) }]; }, p => { p.data.risks.riskDetails.push({ code: 'RISK' }); }];
  for (const mutate of mutations) { const p = preview(); mutate(p); assert.throws(() => validatePreview(p, context)); }
});
test('preview requires an explicit zero native transfer field rather than treating missing data as zero', () => {
  const p = preview(); delete p.data.simulationResult.gasTokenFromData;
  assert.throws(() => validatePreview(p, { action: 'buy', profile, plan: buyPlan, tx: buyTx }));
});

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
function settlementFixture(options = {}) {
  const action = options.action ?? 'sell', claimedToken = addr(9), held = 10n * U;
  const saleProceeds = 7n * U, quotedSaleProceeds = 8n * U, nativeReceived = options.nativeReceived ?? U / 20n;
  const contractHash = '0x' + 'd'.repeat(64), swapHash = '0x' + 'e'.repeat(64), gas = 21000n;
  let snapshots = 0, contractWrites = 0, swapWrites = 0, submittedContract, swapTrade;
  const calls = [], journal = memoryJournal();
  const sellPlan = { kind: 'sell', sharesRaw: held, expectedOutRaw: quotedSaleProceeds, minOutRaw: quotedSaleProceeds / 100n, blockTag: '0x10' };
  const claimPlan = { kind: 'claim', claimRaw: held, token: claimedToken, blockTag: '0x10' };
  const eventLog = (iface, name, args, address) => ({ address, ...iface.encodeEventLog(iface.getEvent(name), args) });
  function contractReceipt() {
    const logs = action === 'sell' ? [
      eventLog(tradeEvents, 'VirtualTrade', [1n, profile.wallet, 1, held, 0n, saleProceeds, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], profile.market),
      eventLog(tokenAbi, 'Transfer', [profile.market, profile.wallet, saleProceeds], profile.quote)
    ] : [
      ...(!options.missingClaimEvent ? [eventLog(tradeEvents, 'Claimed', [profile.wallet, options.claimedEventAmount ?? held, profile.wallet], profile.market)] : []),
      eventLog(tokenAbi, 'Transfer', [profile.market, profile.wallet, options.claimedTransferAmount ?? held], claimedToken)
    ];
    return { transactionHash: contractHash, from: profile.wallet, to: profile.portal, status: '0x1', blockHash,
      blockNumber: '0x11', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs };
  }
  const reader = {
    async snapshot() {
      snapshots++; if (options.failFinalSnapshot && snapshots > 1) throw Object.assign(new Error(), { code: 'RPC_UNAVAILABLE' });
      return { block: '0x10', snapshotAtMs: now, readMs: 1, phase: action === 'claim' ? 3 : 1,
        sharesRaw: snapshots > 1 ? 0n : held, roomRaw: 0n, limitRaw: held, balanceRaw: 100n * U, allowanceRaw: 0n, nativeRaw: U,
        nonce: '0x64', pendingNonce: '0x64', eligible: true, buyOk: false, claimOk: action === 'claim', token: claimedToken };
    },
    async sellPlan() { return structuredClone(sellPlan); },
    async claimPlan() {
      if (options.claimNotReady) throw Object.assign(new Error(), { code: 'CLAIM_STATE_REVIEW_REQUIRED' });
      return structuredClone(claimPlan);
    },
    async rpc(method, args) {
      calls.push([method, args]);
      if (method === 'eth_getBalance') return '0x' + (args[1] === 'latest' ? U : U + nativeReceived - gas).toString(16);
      if (method === 'eth_getTransactionReceipt') return args[0] === contractHash ? contractReceipt()
        : { transactionHash: swapHash, from: profile.wallet, to: addr(20), status: '0x1', blockHash, blockNumber: '0x12', gasUsed: '0x5208', effectiveGasPrice: '0x1',
          logs: [eventLog(tokenAbi, 'Transfer', [profile.wallet, addr(20), saleProceeds], profile.quote)] };
      if (method === 'eth_getTransactionByHash') return args[0] === contractHash
        ? { from: profile.wallet, to: submittedContract.to, input: submittedContract.inputData, value: '0x0', blockHash }
        : { from: profile.wallet, to: addr(20), input: '0x12345678', value: '0x0', blockHash };
      assert.fail('unexpected mock RPC ' + method);
    }
  };
  const cli = {
    async status() { return { status: 'CONNECTED' }; },
    async addresses() { return { addresses: [{ binanceChainId: '56', address: profile.wallet }] }; },
    async settings() { return { devMode: { enabled: true } }; },
    async txLock() { return { status: 'UNLOCKED' }; },
    async previewContract(tx) {
      submittedContract = tx; const p = preview(tx, String(action === 'sell' ? quotedSaleProceeds : held));
      if (action === 'claim') p.data.simulationResult.balanceChanges[0].contractAddress = claimedToken;
      return p;
    },
    async executePreview() { contractWrites++; return { outcome: 'SUBMITTED', data: { orderId: '111', txHash: contractHash } }; },
    async quoteSwap(trade) { calls.push(['quoteSwap', structuredClone(trade)]); return { fromCoinAmount: trade.amount, toCoinAmount: '0.05' }; },
    async executeSwap(trade) { swapWrites++; swapTrade = structuredClone(trade); return { outcome: 'SUBMITTED', data: { orderId: '222' } }; },
    async readOrder(query) {
      assert.deepEqual(query, { chainId: '56', orderId: '222' });
      return { list: [{ orderId: '222', chain: '56', status: 'FINISHED', fromToken: profile.quote, toToken: NATIVE,
        fromTokenQty: '7', toTokenActualQty: '0.05', txHash: swapHash, ...options.orderPatch }] };
    }
  };
  const dependencies = { profile, reader, cli, journal, clock: () => now, sleep: async () => assert.fail('no polling expected') };
  const trader = createFlapTrader({ ...dependencies, allowWrites: true });
  return { trader, restartReadOnly: () => createFlapTrader(dependencies), calls, journal, held, saleProceeds, contractWrites: () => contractWrites, swapWrites: () => swapWrites,
    swapTrade: () => swapTrade, contract: () => submittedContract };
}
test('sell encodes 100% then converts only actual confirmed proceeds, preserving existing BNCB balance', async () => {
  const c = settlementFixture(), { operation } = await c.trader.handle('trade', { ...request(), action: 'sell' });
  assert.equal(operation.status, 'COMPLETE'); assert.equal(c.contractWrites(), 1); assert.equal(c.swapWrites(), 1);
  const decoded = portalAbi.parseTransaction({ data: c.contract().inputData });
  assert.equal(decoded.name, 'sellBps'); assert.equal(decoded.args[1], 10000n);
  assert.deepEqual(c.swapTrade(), { chainId: '56', fromToken: profile.quote, toToken: NATIVE, amount: '7.0', slippage: '99' });
  assert.deepEqual(operation.steps.map(s => [s.action, s.status]), [['sell', 'CONFIRMED'], ['convert', 'CONFIRMED']]);
  assert.equal(operation.steps[0].actualQuoteRaw, String(7n * U));
  assert.equal(operation.steps[1].observedNativeIncreaseWithGasRaw, String(U / 20n));
  assert.equal(operation.steps[1].orderActualOutRaw, String(U / 20n));
});
test('conversion cannot complete with zero/negative BNB proceeds or less BNB than the reported order output', async () => {
  for (const nativeReceived of [0n, -1n, U / 40n]) {
    const c = settlementFixture({ nativeReceived }), { operation } = await c.trader.handle('trade', { ...request(), action: 'sell' });
    assert.notEqual(operation.status, 'COMPLETE'); assert.equal(operation.error.code, 'NATIVE_PROCEEDS_UNCONFIRMED');
    assert.equal(operation.steps[0].status, 'CONFIRMED'); assert.notEqual(operation.steps[1].status, 'CONFIRMED');
    assert.equal(c.swapWrites(), 1);
    await c.trader.handle('trade', { ...request(), action: 'sell' }); assert.equal(c.swapWrites(), 1);
  }
});
test('conversion rejects order ID, chain, source, destination or input-amount mismatch', async () => {
  for (const orderPatch of [{ orderId: '999' }, { chain: '1' }, { fromToken: addr(99) }, { toToken: addr(99) }, { fromTokenQty: '100' }]) {
    const c = settlementFixture({ orderPatch }), { operation } = await c.trader.handle('trade', { ...request(), action: 'sell' });
    assert.notEqual(operation.status, 'COMPLETE'); assert.equal(operation.error.code, 'SWAP_ORDER_MISMATCH');
    assert.equal(operation.steps[0].status, 'CONFIRMED'); assert.equal(c.swapWrites(), 1);
  }
});
test('read-only reconciliation after restart checks the saved swap identity without issuing a new swap', async () => {
  for (const orderPatch of [{ orderId: '999' }, { chain: '1' }, { fromToken: addr(99) }, { toToken: addr(99) }, { fromTokenQty: '100' }]) {
    const c = settlementFixture({ orderPatch });
    await c.journal.save({ intentId: request().intentId, action: 'sell', status: 'SUBMITTED', market: profile.market, wallet: profile.wallet,
      createdAt: now, deadlineAt: now + 15000, steps: [{ action: 'sell', status: 'CONFIRMED', actualQuoteRaw: String(7n * U) },
        { action: 'convert', status: 'SUBMITTED', orderId: '222', txHash: null, amountRaw: String(7n * U), nativeBeforeRaw: String(U),
          trade: { chainId: '56', fromToken: profile.quote, toToken: NATIVE, amount: '7.0', slippage: '99' } }] }, { create: true });
    await assert.rejects(c.restartReadOnly().handle('status', { profile: 'heyi' }), { code: 'SWAP_ORDER_MISMATCH' });
    assert.equal(c.contractWrites(), 0); assert.equal(c.swapWrites(), 0);
    assert.notEqual((await c.journal.read(request().intentId)).status, 'COMPLETE');
  }
});
test('both confirmed sell and conversion remain complete when the final holdings refresh fails', async () => {
  const c = settlementFixture({ failFinalSnapshot: true }), { operation } = await c.trader.handle('trade', { ...request(), action: 'sell' });
  assert.equal(operation.steps[0].status, 'CONFIRMED'); assert.equal(operation.steps[1].status, 'CONFIRMED');
  assert.equal(operation.status, 'COMPLETE'); assert.equal(operation.error.code, 'RPC_UNAVAILABLE');
});
test('READY claim confirms exact claim event and received token without triggering a swap', async () => {
  const c = settlementFixture({ action: 'claim' }), { operation } = await c.trader.handle('trade', { ...request(), action: 'claim' });
  assert.equal(operation.status, 'COMPLETE'); assert.equal(c.contractWrites(), 1); assert.equal(c.swapWrites(), 0);
  const decoded = portalAbi.parseTransaction({ data: c.contract().inputData }); assert.equal(decoded.name, 'claim'); assert.equal(decoded.args[0], profile.market);
  assert.equal(operation.steps[0].actualTokenRaw, String(c.held)); assert.equal(operation.steps[0].status, 'CONFIRMED');
});
test('claim refuses non-READY planning and rejects missing/wrong claim event or zero token receipt', async () => {
  const notReady = settlementFixture({ action: 'claim', claimNotReady: true });
  const first = await notReady.trader.handle('trade', { ...request(), action: 'claim' });
  assert.equal(first.operation.error.code, 'CLAIM_STATE_REVIEW_REQUIRED'); assert.equal(notReady.contractWrites(), 0);
  for (const patch of [{ missingClaimEvent: true }, { claimedEventAmount: 9n * U }, { claimedTransferAmount: 0n }]) {
    const c = settlementFixture({ action: 'claim', ...patch }), { operation } = await c.trader.handle('trade', { ...request(), action: 'claim' });
    assert.notEqual(operation.status, 'COMPLETE'); assert.equal(operation.error.code, 'CLAIM_SETTLEMENT_MISMATCH'); assert.equal(c.swapWrites(), 0);
  }
});
