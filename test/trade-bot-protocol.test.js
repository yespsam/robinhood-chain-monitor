import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildTradeBotSwapPlan, normalizeTradeBotOrder, decimalToMicros, isTradeBotRawAmount } from '../src/trade-bot-protocol.js';

const wallet = `0x${'1'.repeat(40)}`;
const token = `0x${'aB'.repeat(20)}`;
const hash = `0x${'3'.repeat(64)}`;
const intent = () => ({ chain: 'bsc', wallet, inputToken: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  outputToken: token, amountRaw: '10000000000000000000', slippagePercent: 1, antiMev: true });
function receipt() {
  const i = intent();
  return { order_id: 'offline-order-1', hash, status: 'successful', state: 30,
    report: { input_token: i.inputToken, output_token: i.outputToken, swap_mode: 'ExactIn',
      input_amount: i.amountRaw, output_amount: '98765432100000000000', input_token_decimals: 18, output_token_decimals: 18, gas_usd: '0.1234567' } };
}

test('trade protocol builds a bounded BSC absolute-amount plan without executing or forwarding secrets', async () => {
  const input = { ...intent(), apiKey: 'do-not-forward', env: { PRIVATE_KEY: 'do-not-forward' } };
  const original = structuredClone(input);
  assert.deepEqual(buildTradeBotSwapPlan(input), { binary: 'gmgn-cli', args: ['swap', '--chain', 'bsc', '--from', wallet,
    '--input-token', input.inputToken, '--output-token', token, '--amount', input.amountRaw,
    '--slippage', '1', '--anti-mev', '--raw'] });
  assert.deepEqual(input, original);
  assert.doesNotMatch(JSON.stringify(buildTradeBotSwapPlan(input)), /do-not-forward|PRIVATE_KEY|apiKey|--percent|condition/);
  const source = await fs.readFile(new URL('../src/trade-bot-protocol.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:import|require)\b|\b(?:spawn|exec|fetch)\s*\(|process\./u);
});

test('trade protocol rejects hostile addresses, loose types, percentages and automatic slippage', () => {
  for (const change of [
    { chain: 'BSC' }, { chain: 'eth' }, { wallet: ` ${wallet}` }, { wallet: `${wallet};echo` }, { wallet: `0x${'0'.repeat(40)}` },
    { inputToken: 'BNB' }, { outputToken: token.slice(1) }, { outputToken: intent().inputToken },
    { amountRaw: 100 }, { amountRaw: 1n }, { amountRaw: '0' }, { amountRaw: '01' }, { amountRaw: '-1' }, { amountRaw: '1.0' },
    { amountRaw: '1e18' }, { amountRaw: ' 1' }, { amountRaw: '1'.repeat(10000) }, { amountRaw: (1n << 256n).toString() },
    { slippagePercent: '1' }, { slippagePercent: 0 }, { slippagePercent: 4 }, { slippagePercent: 1.5 },
    { antiMev: false }, { antiMev: 'true' }, { antiMev: undefined }, { percent: 50 }, { autoSlippage: false }, { conditionOrders: [] },
  ]) assert.throws(() => buildTradeBotSwapPlan({ ...intent(), ...change }), /invalid BSC ExactIn/);
  assert.equal(isTradeBotRawAmount(((1n << 256n) - 1n).toString()), true);
  assert.ok(buildTradeBotSwapPlan({ ...intent(), inputToken: `0x${'0'.repeat(40)}`, slippagePercent: 3 }).args.includes('3'));
});

test('decimal USD conversion rounds up exactly without floating-point truncation', () => {
  for (const [value, expected] of [['0', '0'], ['0.000000', '0'], ['0.000000000000000000000000000000000001', '1'],
    ['1.2', '1200000'], ['0.123456', '123456'], ['0.1234560', '123456'], ['0.1234561', '123457'],
    ['9.9999999', '10000000'], ['9007199254740993.0000001', '9007199254740993000001']]) {
    assert.equal(decimalToMicros(value), expected, value);
  }
  for (const value of [0, null, '', '-0', '+1', '01', '.1', '1.', '1e-6', 'Infinity', 'NaN', ' 1', '1\n', '0.' + '0'.repeat(37), '9'.repeat(10000)]) {
    assert.throws(() => decimalToMicros(value), /invalid decimal USD amount/);
  }
});

test('trade receipt confirms only a complete ExactIn report with exact intent identity and actual gas', () => {
  const raw = receipt(), original = structuredClone(raw);
  const expected = { status: 'confirmed', orderId: raw.order_id, txHash: hash, ambiguous: false,
    fill: { inputAmountRaw: intent().amountRaw, outputAmountRaw: raw.report.output_amount, inputDecimals: 18, outputDecimals: 18, gasUsdMicros: '123457' } };
  assert.deepEqual(normalizeTradeBotOrder(raw, intent()), expected);
  assert.deepEqual(normalizeTradeBotOrder({ code: 0, data: raw }, intent()), expected);
  assert.deepEqual(normalizeTradeBotOrder({ ...raw, state: undefined, status: 'confirmed' }, intent()).status, 'unknown', 'undefined is not JSON data');
  const { state, ...withoutState } = raw;
  assert.deepEqual(normalizeTradeBotOrder({ ...withoutState, status: 'confirmed' }, intent()), expected);
  assert.equal(normalizeTradeBotOrder({ ...raw, report: { ...raw.report, output_token: token.toLowerCase(), output_token_decimals: 36, gas_usd: '0' } }, intent()).status, 'confirmed');
  assert.deepEqual(raw, original);
});

test('trade pending and processed statuses cannot be mistaken for fills', () => {
  for (const status of ['pending', 'processed']) {
    assert.deepEqual(normalizeTradeBotOrder({ order_id: 'offline-order-1', status }, intent()), {
      status: 'pending', orderId: 'offline-order-1', txHash: null, fill: null, ambiguous: false,
    });
    assert.equal(normalizeTradeBotOrder({ ...receipt(), status }, intent()).status, 'unknown');
  }
  for (const status of ['failed', 'expired']) {
    assert.equal(normalizeTradeBotOrder({ order_id: 'offline-order-1', status, error_status: 'secret-error-body' }, intent()).status, 'failed');
    assert.equal(normalizeTradeBotOrder({ ...receipt(), status }, intent()).status, 'unknown');
    assert.equal(normalizeTradeBotOrder({ order_id: 'offline-order-1', status, hash }, intent()).status, 'unknown', 'a hash with unknown gas cannot settle a failure');
  }
});

test('trade incomplete success, partial, token mismatch, unsupported state and malformed quantities stay ambiguous', () => {
  const raw = receipt();
  const badReports = [null, {}, ...[
    { swap_mode: 'ExactOut' }, { swap_mode: 'exactin' }, { input_token: token }, { output_token: intent().inputToken },
    { input_amount: '9999999999999999999' }, { input_amount: '10000000000000000001' }, { input_amount: '010000000000000000000' },
    { output_amount: '0' }, { output_amount: '1e18' }, { output_amount: 123 }, { output_amount: (1n << 256n).toString() },
    { input_token_decimals: '18' }, { input_token_decimals: -1 }, { output_token_decimals: 37 }, { output_token_decimals: 1.5 },
    { gas_usd: null }, { gas_usd: -1 }, { gas_usd: '1e-6' }, { wallet_address: `0x${'2'.repeat(40)}` },
  ].map(change => ({ ...raw.report, ...change }))];
  for (const report of badReports) {
    const result = normalizeTradeBotOrder({ ...raw, report }, intent());
    assert.equal(result.status, 'unknown'); assert.equal(result.ambiguous, true); assert.equal(result.fill, null);
  }
  for (const change of [{ status: 'confirmed', report: null }, { status: 'partial' }, { status: 'success' }, { status: 30 },
    { state: '30' }, { state: 29 }, { state: -1 }, { ambiguous: true }, { ambiguous: 'true' }, { error: 'sensitive-error' }, { chain: 'eth' },
    { hash: '0x123' }, { hash: null }, { wallet_address: `0x${'2'.repeat(40)}` }, { order_id: 'x'.repeat(129) }, { order_id: 'x\nsecret' }, { order_id: '--token' }]) {
    assert.equal(normalizeTradeBotOrder({ ...raw, ...change }, intent()).status, 'unknown');
  }
  assert.equal(normalizeTradeBotOrder(raw, { ...intent(), orderId: 'a-different-order' }).status, 'unknown');
});

test('trade envelope errors and unknown shapes never expose error bodies or authorize retries', () => {
  for (const raw of [null, [], 'not JSON', { code: '0', data: receipt() }, { code: 429, data: receipt(), error: 'secret-key' },
    { code: 0, data: [receipt()] }, { result: receipt() }, { code: 0, data: { result: receipt() } },
    { code: 0, data: receipt(), ambiguous: true }, { code: 0, data: receipt(), ambiguous: 'true' }, { code: 0, data: receipt(), error: 'secret-key' },
    { code: 0, data: receipt(), status: 'confirmed' }, { code: 0, data: receipt(), message: 'x'.repeat(70000) },
    { status: 'not_found', order_id: 'offline-order-1', error_status: 'secret-key' },
  ]) {
    const result = normalizeTradeBotOrder(raw, intent());
    assert.equal(result.status, 'unknown'); assert.equal(result.ambiguous, true); assert.equal(result.fill, null);
    assert.doesNotMatch(JSON.stringify(result), /secret-key|error_status|retry/);
  }
});

test('trade protocol rejects accessors, non-data prototypes and cycles without evaluating getters', () => {
  let accessed = 0;
  const withGetter = { ...receipt(), get credential() { accessed++; return 'secret'; } };
  const cycle = receipt(); cycle.self = cycle;
  const symbol = { ...receipt(), [Symbol('hidden')]: 'secret' };
  for (const raw of [withGetter, cycle, symbol, new Date(), Object.assign(Object.create({ inherited: true }), receipt())]) {
    assert.equal(normalizeTradeBotOrder(raw, intent()).status, 'unknown');
  }
  assert.equal(accessed, 0);
  const evilIntent = { ...intent(), get env() { accessed++; return {}; } };
  assert.throws(() => buildTradeBotSwapPlan(evilIntent));
  assert.equal(accessed, 0);
});
