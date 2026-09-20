// Pure, offline protocol helpers. A plan is data, not an execution permission.
// This module deliberately has no I/O, process runner, credential or retry API.
const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ORDER_FIELDS = new Set(['order_id', 'hash', 'status', 'state', 'error_code', 'error_status', 'strategy_order_id', 'report', 'chain', 'ambiguous', 'error']);
const REPORT_FIELDS = new Set(['input_token', 'input_token_decimals', 'swap_mode', 'input_amount', 'output_token', 'output_token_decimals',
  'output_amount', 'quote_token', 'quote_decimals', 'quote_amount', 'base_token', 'base_decimals', 'base_amount', 'price', 'price_usd',
  'height', 'order_height', 'gas_native', 'gas_usd']);

function record(value, maximumKeys = 128) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length <= maximumKeys && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && key.length <= 128 && descriptor.enumerable
        && Object.hasOwn(descriptor, 'value');
    });
  } catch { return false; }
}

function boundedData(value) {
  const seen = new Set(); let nodes = 0, characters = 0;
  function visit(item, depth) {
    if (++nodes > 2048 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') { characters += item.length; return characters <= 65_536; }
    if (!record(item) || seen.has(item)) return false;
    seen.add(item);
    const valid = Object.keys(item).every(key => { characters += key.length; return characters <= 65_536 && visit(item[key], depth + 1); });
    seen.delete(item);
    return valid;
  }
  try { return visit(value, 0); } catch { return false; }
}

export function isTradeBotRawAmount(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,77}$/u.test(value) && BigInt(value) <= UINT256_MAX;
}

// Decimal USD -> microdollars, using integer arithmetic and rounding UP so a
// positive sub-microdollar cost can never silently become zero. No floats.
export function decimalToMicros(value) {
  if (typeof value !== 'string' || value.length > 115 || !/^(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,36})?$/u.test(value)) {
    throw new TypeError('invalid decimal USD amount');
  }
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  return (micros + (/[1-9]/u.test(fraction.slice(6)) ? 1n : 0n)).toString();
}

function validIntent(intent) {
  return record(intent) && boundedData(intent) && intent.chain === 'bsc'
    && typeof intent.wallet === 'string' && ADDRESS.test(intent.wallet) && !/^0x0{40}$/u.test(intent.wallet)
    && typeof intent.inputToken === 'string' && ADDRESS.test(intent.inputToken)
    && typeof intent.outputToken === 'string' && ADDRESS.test(intent.outputToken)
    && intent.inputToken.toLowerCase() !== intent.outputToken.toLowerCase()
    && isTradeBotRawAmount(intent.amountRaw)
    && Number.isInteger(intent.slippagePercent) && intent.slippagePercent >= 1 && intent.slippagePercent <= 3
    && intent.antiMev === true
    && !['percent', 'amountPercent', 'amountInPercent', 'autoSlippage', 'conditionOrders', 'condition_orders'].some(key => Object.hasOwn(intent, key));
}

export function buildTradeBotSwapPlan(intent) {
  if (!validIntent(intent)) throw new TypeError('invalid BSC ExactIn swap intent');
  return { binary: 'gmgn-cli', args: [
    'swap', '--chain', 'bsc', '--from', intent.wallet,
    '--input-token', intent.inputToken, '--output-token', intent.outputToken,
    '--amount', intent.amountRaw, '--slippage', String(intent.slippagePercent), '--anti-mev', '--raw',
  ] };
}

function normalized(status = 'unknown', orderId = null, txHash = null, fill = null) {
  return { status, orderId, txHash, fill, ambiguous: status === 'unknown' };
}

function orderBody(raw) {
  if (!record(raw) || !boundedData(raw)) return null;
  if (Object.hasOwn(raw, 'code') || Object.hasOwn(raw, 'data')) {
    // Do not reinterpret an HTTP success, a string code, array, nested result,
    // or error envelope as an executed single-wallet swap.
    if (raw.code !== 0 || !record(raw.data) || Object.hasOwn(raw, 'status') || Object.hasOwn(raw, 'report')
      || (Object.hasOwn(raw, 'ambiguous') && raw.ambiguous !== false)
      || (Object.hasOwn(raw, 'error') && raw.error !== null && raw.error !== '')) return null;
    return Object.keys(raw.data).every(key => ORDER_FIELDS.has(key)) ? raw.data : null;
  }
  return Object.keys(raw).every(key => ORDER_FIELDS.has(key)) ? raw : null;
}

export function normalizeTradeBotOrder(raw, intent) {
  if (!validIntent(intent)) return normalized();
  const body = orderBody(raw);
  if (!body) return normalized();
  const orderId = typeof body.order_id === 'string' && ORDER_ID.test(body.order_id) ? body.order_id : null;
  const txHash = typeof body.hash === 'string' && HASH.test(body.hash) ? body.hash : null;
  const unknown = () => normalized('unknown', orderId, txHash);
  if ((Object.hasOwn(body, 'ambiguous') && body.ambiguous !== false) || !orderId
    || (Object.hasOwn(body, 'error') && body.error !== null && body.error !== '')
    || (Object.hasOwn(body, 'hash') && body.hash !== null && body.hash !== '' && !txHash)
    || (Object.hasOwn(body, 'chain') && body.chain !== intent.chain)
    || (Object.hasOwn(intent, 'orderId') && intent.orderId !== orderId)
    || (Object.hasOwn(body, 'state') && (!Number.isSafeInteger(body.state) || body.state < 0))) return unknown();

  if (body.status === 'pending' || body.status === 'processed') {
    if (body.report != null || body.state === 30) return unknown();
    return normalized('pending', orderId, txHash);
  }
  if (body.status === 'failed' || body.status === 'expired') {
    // A contradictory report may include a partial fill or charged gas. Never
    // discard it and tell a caller that the order safely failed with no fill.
    if (body.report != null || body.state === 30 || txHash) return unknown();
    // External failure status is not proof of zero expenditure. Callers must
    // reconcile before releasing any financial reservation, including gas.
    return normalized('failed', orderId, txHash);
  }
  const confirmed = body.status === 'confirmed' && (body.state == null || body.state === 30);
  const successful = body.status === 'successful' && body.state === 30;
  if (!confirmed && !successful || !txHash || !record(body.report)) return unknown();
  const report = body.report;
  if (!Object.keys(report).every(key => REPORT_FIELDS.has(key)) || report.swap_mode !== 'ExactIn'
    || typeof report.input_token !== 'string' || !ADDRESS.test(report.input_token)
    || typeof report.output_token !== 'string' || !ADDRESS.test(report.output_token)
    || report.input_token.toLowerCase() !== intent.inputToken.toLowerCase()
    || report.output_token.toLowerCase() !== intent.outputToken.toLowerCase()
    || !isTradeBotRawAmount(report.input_amount) || report.input_amount !== intent.amountRaw
    || !isTradeBotRawAmount(report.output_amount)
    || !Number.isInteger(report.input_token_decimals) || report.input_token_decimals < 0 || report.input_token_decimals > 36
    || !Number.isInteger(report.output_token_decimals) || report.output_token_decimals < 0 || report.output_token_decimals > 36) return unknown();
  let gasUsdMicros;
  try { gasUsdMicros = decimalToMicros(report.gas_usd); } catch { return unknown(); }
  return normalized('confirmed', orderId, txHash, {
    inputAmountRaw: report.input_amount, outputAmountRaw: report.output_amount,
    inputDecimals: report.input_token_decimals, outputDecimals: report.output_token_decimals, gasUsdMicros,
  });
}
