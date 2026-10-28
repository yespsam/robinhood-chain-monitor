import test from 'node:test';
import assert from 'node:assert/strict';
import { solveAllocation, createPortalQuoteReader, QUOTE_BUY_SELECTOR } from '../server/fast-allocation.mjs';

const WAD = 10n ** 18n;
const target = 10_000_000n * WAD;
const base = {
  blockTag: '0x7b5a0ff', snapshotAtMs: 1000, now: () => 1100,
  targetSharesRaw: target, initialGrossRaw: 10n * WAD,
  maxGrossRaw: 100n * WAD, availableBalanceRaw: 20n * WAD,
};
const curve = grossRaw => {
  const feeRaw = grossRaw / 100n;
  const net = grossRaw - feeRaw;
  return { acceptedGrossRaw: grossRaw, feeRaw, refundRaw: 0n,
    sharesRaw: 300_000_000n * WAD * net / (335n * WAD + net) };
};

test('quotes a true 1% allocation using BigInt within eight calls, never above the cap', async () => {
  const requested = [];
  const result = await solveAllocation({ ...base, quoteBuy: async (gross, opts) => {
    requested.push({ gross, ...opts }); return curve(gross);
  } });
  assert.ok(result.sharesRaw <= target);
  assert.ok(target - result.sharesRaw <= 1_000_000_000n);
  assert.ok(requested.length <= 8);
  assert.equal(requested.length, result.calls);
  assert.ok(requested.every(q => q.blockTag === base.blockTag));
  assert.ok(requested.some(q => q.gross === result.grossRaw));
  assert.equal(result.sharesRaw, curve(result.grossRaw).sharesRaw);
  assert.equal(result.affordable, true);
});

test('reports exact required funding without silently buying a smaller allocation', async () => {
  const result = await solveAllocation({ ...base, availableBalanceRaw: 7n * WAD, quoteBuy: async gross => curve(gross) });
  assert.equal(result.affordable, false);
  assert.equal(result.requiredFundingRaw, result.grossRaw - 7n * WAD);
  assert.ok(target - result.sharesRaw <= 1_000_000_000n);
});

test('uses downward rounding and only returns a previously quoted gross amount', async () => {
  const seen = new Set();
  const result = await solveAllocation({ ...base, targetSharesRaw: 100n, initialGrossRaw: 51n,
    maxGrossRaw: 100n, maxShortfallRaw: 2n, quoteBuy: async gross => {
      seen.add(gross); return { acceptedGrossRaw: gross, feeRaw: 0n, refundRaw: 0n, sharesRaw: gross * 3n };
    } });
  assert.equal(result.grossRaw, 33n);
  assert.equal(result.sharesRaw, 99n);
  assert.equal(seen.has(result.grossRaw), true);
});

test('fails closed when exact integer resolution cannot meet the share tolerance', async () => {
  await assert.rejects(solveAllocation({ ...base, targetSharesRaw: 100n, initialGrossRaw: 51n,
    maxGrossRaw: 100n, maxShortfallRaw: 0n,
    quoteBuy: async gross => ({ acceptedGrossRaw: gross, feeRaw: 0n, refundRaw: 0n, sharesRaw: gross * 3n }),
  }), { code: 'NOT_CONVERGED' });
});

test('never exceeds the configured call budget and refuses unquoted extrapolation', async () => {
  let count = 0;
  await assert.rejects(solveAllocation({ ...base, maxCalls: 2, quoteBuy: async gross => { count++; return curve(gross); } }), { code: 'NOT_CONVERGED' });
  assert.equal(count, 2);
});

test('old block is rejected before requesting a quote', async () => {
  let called = false;
  await assert.rejects(solveAllocation({ ...base, now: () => 11001, quoteBuy: async () => { called = true; } }), { code: 'STALE_QUOTE' });
  assert.equal(called, false);
});

test('quote that expires during RPC is rejected even if it exactly fills the target', async () => {
  let clock = 1100;
  await assert.rejects(solveAllocation({ ...base, now: () => clock, quoteBuy: async gross => {
    clock = 11001; return { acceptedGrossRaw: gross, feeRaw: 0n, refundRaw: 0n, sharesRaw: target };
  } }), { code: 'STALE_QUOTE' });
});

test('allows bounded subsecond chain clock skew but rejects future-dated blocks', async () => {
  const result = await solveAllocation({ ...base, snapshotAtMs: 1900,
    quoteBuy: async gross => ({ acceptedGrossRaw: gross, feeRaw: 0n, refundRaw: 0n, sharesRaw: target }) });
  assert.equal(result.sharesRaw, target);
  await assert.rejects(solveAllocation({ ...base, snapshotAtMs: 3101,
    quoteBuy: async gross => curve(gross) }), { code: 'STALE_QUOTE' });
});

test('unaffordable search ceiling does not pretend to fulfill the allocation', async () => {
  await assert.rejects(solveAllocation({ ...base, maxGrossRaw: 7n * WAD, availableBalanceRaw: 7n * WAD, quoteBuy: async gross => curve(gross) }), error => {
    assert.equal(error.code, 'SEARCH_CEILING');
    assert.equal(error.details.requiredFundingRaw, null);
    return true;
  });
});

test('malformed monetary amounts, block mismatch, and incoherent refunds fail closed', async () => {
  await assert.rejects(solveAllocation({ ...base, targetSharesRaw: Number(target), quoteBuy: async gross => curve(gross) }), { code: 'INVALID_INPUT' });
  await assert.rejects(solveAllocation({ ...base, blockTag: 'latest', quoteBuy: async gross => curve(gross) }), { code: 'INVALID_INPUT' });
  await assert.rejects(solveAllocation({ ...base, quoteBuy: async gross => ({ ...curve(gross), blockTag: '0x2' }) }), { code: 'BLOCK_MISMATCH' });
  await assert.rejects(solveAllocation({ ...base, quoteBuy: async gross => ({ ...curve(gross), refundRaw: 1n }) }), { code: 'INVALID_QUOTE' });
});

test('RPC exceptions and cancellation propagate without falling back to cached quotes', async () => {
  await assert.rejects(solveAllocation({ ...base, quoteBuy: async () => { throw Error('RPC offline'); } }), /RPC offline/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(solveAllocation({ ...base, signal: controller.signal, quoteBuy: async gross => curve(gross) }), { code: 'ABORTED' });
});

test('nonmonotonic fixed-block quotes stop immediately', async () => {
  let calls = 0;
  await assert.rejects(solveAllocation({ ...base, quoteBuy: async gross => {
    calls++; return { acceptedGrossRaw: gross, feeRaw: 0n, refundRaw: 0n, sharesRaw: calls === 1 ? target / 2n : target / 3n };
  } }), { code: 'NON_MONOTONIC' });
  assert.equal(calls, 2);
});

test('Portal ABI adapter uses only fixed-block eth_call and decodes exact uint256 values', async () => {
  const portal = '0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062';
  const market = '0xeddc6C5736CD9f280bE750c408D36c8d6E1a473d';
  const wallet = '0x1111111111111111111111111111111111111111';
  const gross = 11_748_971_999_011_834_918n;
  const values = [gross, gross / 100n, 0n, 9_999_999_999_999_999_999_306_120n];
  let call;
  const reader = createPortalQuoteReader({ portal, market, wallet, rpc: async (...args) => {
    call = args; return `0x${values.map(v => v.toString(16).padStart(64, '0')).join('')}`;
  } });
  const result = await reader(gross, { blockTag: base.blockTag });
  assert.equal(call[0], 'eth_call');
  assert.equal(call[1][1], base.blockTag);
  assert.equal(call[1][0].to, portal.toLowerCase());
  assert.equal(call[1][0].data.slice(0, 10), QUOTE_BUY_SELECTOR);
  assert.equal(call[1][0].data.length, 202);
  assert.equal(BigInt(`0x${call[1][0].data.slice(-64)}`), gross);
  assert.equal(result.sharesRaw, values[3]);
  assert.equal(result.acceptedGrossRaw, gross);
});

test('Portal ABI adapter rejects truncated or extended return data', async () => {
  const config = { portal: '0x1111111111111111111111111111111111111111', market: '0x2222222222222222222222222222222222222222', wallet: '0x3333333333333333333333333333333333333333' };
  for (const words of [3, 5]) {
    const reader = createPortalQuoteReader({ ...config, rpc: async () => `0x${'0'.repeat(64 * words)}` });
    await assert.rejects(reader(1n, { blockTag: base.blockTag }), { code: 'INVALID_QUOTE' });
  }
});
