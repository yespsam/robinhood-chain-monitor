import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TRADE_BOT_USDC, TRADE_BOT_POLICY, applyTradeBotOrder, beginTradeBotSubmission,
  createTradeBotReplayController, createTradeBotState, markTradeBotSubmissionUnknown,
  pauseTradeBotEntries, reserveTradeBotEntry, reserveTradeBotExit, tradeBotSummary,
  validateTradeBotState,
} from '../src/trade-bot-engine.js';
import { createTradeBotStore } from '../src/trade-bot-store.js';

const NOW = '2026-09-20T00:00:00.000Z';
const wallet = `0x${'1'.repeat(40)}`;
const e18 = value => String(BigInt(value) * 10n ** 18n);
const plus = (now, seconds) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const address = hex => `0x${hex.repeat(40)}`;
const candidate = (now, suffix = 'a', eventKey = `fixture-${suffix}`) => ({
  eventKey, chainId: 56, ca: address(suffix), poolAddress: address(suffix === 'a' ? 'b' : 'a'), observedAt: now,
  narrative: { status: 'sourced', sourceUrl: 'https://example.invalid/fixture', text: '合成演练叙事。' },
  evidence: { observedAt: now, sourceUrls: ['https://example.invalid/fixture'], sellSimulationPassed: true,
    contractControlsReviewed: true, lpLockOrBurnVerified: true, holderDistributionReviewed: true,
    independentWalletClusterVerified: true, buyTaxBps: 0, sellTaxBps: 0, liquidityUsd: 30_000 },
});
const quote = (now, token, { sell = false, output = sell ? 15 : 100, input = sell ? 100 : 10 } = {}) => ({
  source: 'offline_fixture', chain: 'bsc', wallet, inputToken: sell ? token : TRADE_BOT_USDC,
  outputToken: sell ? TRADE_BOT_USDC : token, inputAmountRaw: e18(input), outputAmountRaw: e18(output),
  minOutputAmountRaw: String(BigInt(e18(output)) * 99n / 100n), inputDecimals: 18, outputDecimals: 18,
  gasUsdMicros: 150_000, observedAt: now, validUntil: plus(now, 5),
});
const receipt = (order, output = order.side === 'sell' ? 15 : 100, hashDigit = '1') => ({
  order_id: order.orderId ?? `${order.side}-fixture-order`, hash: `0x${hashDigit.repeat(64)}`, status: 'successful', state: 30,
  report: { swap_mode: 'ExactIn', input_token: order.intent.inputToken, output_token: order.intent.outputToken,
    input_amount: order.intent.amountRaw, output_amount: e18(output), input_token_decimals: 18,
    output_token_decimals: 18, gas_usd: '0.15' },
});
function initial(now = NOW) { return createTradeBotState({ wallet, now }); }
function entry(state, now = NOW, suffix = 'a', eventKey = `fixture-${suffix}`) {
  const c = candidate(now, suffix, eventKey), r = reserveTradeBotEntry(state, c, quote(now, c.ca), now);
  assert.equal(r.decision, 'reserved', r.reasons?.join(','));
  return { ...r, candidate: c };
}
function confirmBuy(state, now = NOW, suffix = 'a', eventKey = `fixture-${suffix}`, hashDigit = '1') {
  const reserved = entry(state, now, suffix, eventKey);
  const submitting = beginTradeBotSubmission(reserved.state, reserved.orderId, plus(now, 1));
  const pending = applyTradeBotOrder(submitting, reserved.orderId, { order_id: `${suffix}-order`, status: 'pending' }, plus(now, 2));
  return { state: applyTradeBotOrder(pending, reserved.orderId, receipt(pending.orders.at(-1), 100, hashDigit), plus(now, 3)), orderId: reserved.orderId };
}

test('engine reserves before submission, confirms exact fills, and derives cash from receipts only', () => {
  let state = initial();
  const reserved = entry(state);
  assert.equal(reserved.state.orders[0].status, 'reserved');
  state = beginTradeBotSubmission(reserved.state, reserved.orderId, plus(NOW, 1));
  assert.equal(state.orders[0].status, 'submitting');
  state = applyTradeBotOrder(state, reserved.orderId, { order_id: 'a-order', status: 'pending' }, plus(NOW, 2));
  assert.equal(state.orders[0].status, 'pending');
  const confirmed = applyTradeBotOrder(state, reserved.orderId, receipt(state.orders[0]), plus(NOW, 3));
  assert.equal(confirmed.orders[0].status, 'confirmed');
  const summary = tradeBotSummary(confirmed);
  assert.equal(summary.cashUsdMicros, 89_850_000);
  assert.equal(summary.positions[0].quantityRaw, e18(100));
  assert.equal(summary.reservedUsdMicros, TRADE_BOT_POLICY.gasLimitUsdMicros);
  validateTradeBotState(confirmed);
  const replayed = applyTradeBotOrder(confirmed, reserved.orderId, receipt(confirmed.orders[0]), plus(NOW, 4));
  assert.equal(tradeBotSummary(replayed).cashUsdMicros, summary.cashUsdMicros, 'receipt replay must not double book');
});

test('partial, failed, and unknown receipts remain unresolved and block new entries', () => {
  const reserved = entry(initial());
  let state = beginTradeBotSubmission(reserved.state, reserved.orderId, plus(NOW, 1));
  const order = state.orders[0];
  const partial = receipt(order); partial.report.input_amount = e18(9);
  state = applyTradeBotOrder(state, reserved.orderId, partial, plus(NOW, 2));
  assert.equal(state.orders[0].status, 'uncertain');
  assert.equal(tradeBotSummary(state).reservedUsdMicros, 10_500_000);
  assert.equal(reserveTradeBotEntry(state, candidate(plus(NOW, 3), 'c'), quote(plus(NOW, 3), address('c')), plus(NOW, 3)).decision, 'watch');

  let failed = beginTradeBotSubmission(reserved.state, reserved.orderId, plus(NOW, 1));
  failed = applyTradeBotOrder(failed, reserved.orderId, { order_id: 'a-order', status: 'failed' }, plus(NOW, 2));
  assert.equal(failed.orders[0].status, 'uncertain');
  assert.equal(failed.orders[0].issue, 'receipt_unknown');
  validateTradeBotState(failed);
});

test('take-profit exit is a separate exact-size order, allowed while new entries are paused', () => {
  const bought = confirmBuy(initial());
  let state = pauseTradeBotEntries(bought.state, true, plus(NOW, 4));
  const sellQuote = quote(plus(NOW, 5), address('a'), { sell: true });
  const planned = reserveTradeBotExit(state, bought.orderId, sellQuote, plus(NOW, 5));
  assert.equal(planned.decision, 'reserved');
  assert.equal(planned.state.orders[1].exitReason, 'take_profit');
  state = beginTradeBotSubmission(planned.state, planned.state.orders[1].id, plus(NOW, 6));
  state = applyTradeBotOrder(state, planned.state.orders[1].id, { order_id: 'sell-order', status: 'pending' }, plus(NOW, 7));
  state = applyTradeBotOrder(state, planned.state.orders[1].id, receipt(state.orders[1], 15, '2'), plus(NOW, 8));
  const summary = tradeBotSummary(state);
  assert.equal(summary.positions.length, 0);
  assert.equal(summary.closed[0].reason, 'take_profit');
  assert.equal(summary.realizedPnlUsdMicros, 4_700_000);
  const duplicate = reserveTradeBotExit(state, bought.orderId, sellQuote, plus(NOW, 9));
  assert.equal(duplicate.decision, 'watch');
  assert.ok(duplicate.reasons.includes('position_not_open'));
});

test('contradictory confirmation halts new entries and does not mutate the settled fill', () => {
  const bought = confirmBuy(initial());
  const original = bought.state.orders[0].fill;
  const altered = receipt(bought.state.orders[0], 101, '1');
  const state = applyTradeBotOrder(bought.state, bought.orderId, altered, plus(NOW, 4));
  assert.equal(state.haltedReason, 'contradictory_receipt');
  assert.deepEqual(state.orders[0].fill, original);
  const blocked = reserveTradeBotEntry(state, candidate(plus(NOW, 5), 'c'), quote(plus(NOW, 5), address('c')), plus(NOW, 5));
  assert.equal(blocked.decision, 'watch');
  assert.ok(blocked.reasons.includes('entries_paused'));
});

test('stale and over-slippage quotes fail closed; duplicate signal and max positions are rejected', () => {
  const stale = quote(NOW, address('a')); stale.validUntil = plus(NOW, 31);
  assert.equal(reserveTradeBotEntry(initial(), candidate(NOW), stale, NOW).decision, 'watch');
  const bad = quote(NOW, address('a')); bad.minOutputAmountRaw = e18(1);
  assert.equal(reserveTradeBotEntry(initial(), candidate(NOW), bad, NOW).decision, 'watch');
  const first = confirmBuy(initial(), NOW, 'a');
  assert.equal(reserveTradeBotEntry(first.state, candidate(plus(NOW, 4), 'a', 'fixture-a'), quote(plus(NOW, 4), address('a')), plus(NOW, 4)).decision, 'watch');
  const second = confirmBuy(first.state, plus(NOW, 4), 'c', 'fixture-c', '3');
  const third = reserveTradeBotEntry(second.state, candidate(plus(NOW, 8), 'd'), quote(plus(NOW, 8), address('d')), plus(NOW, 8));
  assert.equal(third.decision, 'watch'); assert.ok(third.reasons.includes('maximum_positions'));
});

test('ambiguous submit is checkpointed once and is never blindly resubmitted', async t => {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'trade-bot-engine-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'store');
  const store = createTradeBotStore({ directory, validate: validateTradeBotState });
  await store.open(); await store.save(initial());
  let submitCalls = 0, queryCalls = 0;
  const broker = { mode: 'offline_fixture', async submit() { submitCalls++; throw new Error('timeout'); },
    async query() { queryCalls++; return { status: 'pending', order_id: 'never-used' }; } };
  const controller = createTradeBotReplayController({ store, broker });
  const result = await controller.enter(candidate(NOW), quote(NOW, address('a')), NOW);
  assert.equal(result.decision, 'uncertain'); assert.equal(submitCalls, 1);
  const retry = await controller.enter(candidate(plus(NOW, 1), 'c'), quote(plus(NOW, 1), address('c')), plus(NOW, 1));
  assert.equal(retry.decision, 'watch'); assert.equal(submitCalls, 1);
  await controller.reconcile(plus(NOW, 2));
  assert.equal(queryCalls, 0, 'no provider order id means no blind query or retry');
  const saved = await store.read(); assert.equal(saved.orders[0].status, 'uncertain');
  await store.close();
});

test('controller persists submitting state before calling the offline broker and serializes entries', async t => {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'trade-bot-engine-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'store');
  const store = createTradeBotStore({ directory, validate: validateTradeBotState });
  await store.open(); await store.save(initial());
  let calls = 0, sawSubmitting = false;
  const broker = { mode: 'offline_fixture', async submit(order) {
    calls++; sawSubmitting = (await store.read()).orders.find(o => o.id === order.id).status === 'submitting';
    return { order_id: `${order.side}-order`, status: 'pending' };
  }, async query() { return { status: 'pending', order_id: 'unused' }; } };
  const controller = createTradeBotReplayController({ store, broker });
  const p1 = controller.enter(candidate(NOW, 'a'), quote(NOW, address('a')), NOW);
  const p2 = controller.enter(candidate(NOW, 'c'), quote(NOW, address('c')), NOW);
  const [one, two] = await Promise.all([p1, p2]);
  assert.equal(one.decision, 'pending'); assert.equal(two.decision, 'watch');
  assert.equal(calls, 1); assert.equal(sawSubmitting, true);
  await store.close();
});

test('controller rejects non-offline brokers and mark-unknown never releases a reserved order', () => {
  assert.throws(() => createTradeBotReplayController({ store: {}, broker: { mode: 'live' } }), /offline_broker_required/);
  const reserved = entry(initial()), submitting = beginTradeBotSubmission(reserved.state, reserved.orderId, plus(NOW, 1));
  const unknown = markTradeBotSubmissionUnknown(submitting, reserved.orderId, plus(NOW, 2));
  assert.equal(unknown.orders[0].status, 'uncertain');
  assert.equal(tradeBotSummary(unknown).unresolvedOrders.length, 1);
});
