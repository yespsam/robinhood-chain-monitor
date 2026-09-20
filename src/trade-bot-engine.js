import { createHash } from 'node:crypto';
import { evaluatePaperCandidate } from './paper-100-ledger.js';
import { normalizeTradeBotOrder } from './trade-bot-protocol.js';

// Development hypotheses, NOT a live strategy or a profitability claim.
export const TRADE_BOT_POLICY = Object.freeze({ initialCashUsdMicros: 100_000_000,
  tradeUsdMicros: 10_000_000, gasLimitUsdMicros: 250_000, cashReserveUsdMicros: 20_000_000,
  maximumPositions: 2, dailyLossUsdMicros: 5_000_000, totalLossUsdMicros: 10_000_000,
  stopLossBps: 2000, takeProfitBps: 4000, maximumHoldMs: 1_800_000 });
export const TRADE_BOT_USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
const P = TRADE_BOT_POLICY;
const SCALE = 10n ** 12n; // Fixture-only assumption: 18 decimals, one USDC = one USD.
const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
const equalAddress = (a, b) => address(a) && address(b) && a.toLowerCase() === b.toLowerCase();
const uint = v => typeof v === 'string' && /^[1-9][0-9]{0,77}$/.test(v) && BigInt(v) < 2n ** 256n;
const money = v => Number.isSafeInteger(v) && v >= 0;
const idFor = value => `bot:${createHash('sha256').update(value).digest('hex')}`;
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
function check(ok, reason) { if (!ok) throw new Error(reason); }
function ms(value) {
  check(typeof value === 'string' && new Date(Date.parse(value)).toJSON() === value, 'invalid_clock');
  return Date.parse(value);
}
function safeNumber(value) {
  check(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER), 'unsafe_money');
  return Number(value);
}
const dollars = raw => safeNumber(BigInt(raw) / SCALE);
const fee = fill => safeNumber(BigInt(fill.gasUsdMicros));
const cost = order => P.tradeUsdMicros + fee(order.fill);
const netExit = order => dollars(order.fill.outputAmountRaw) - fee(order.fill);
function intentFor(s, token, side, amountRaw) {
  return { chain: 'bsc', wallet: s.wallet, inputToken: side === 'buy' ? TRADE_BOT_USDC : token,
    outputToken: side === 'buy' ? token : TRADE_BOT_USDC, amountRaw, slippagePercent: 1, antiMev: true };
}
function quoteCheck(q, intent, now, tokenDecimals = null) {
  check(q && q.source === 'offline_fixture' && q.chain === 'bsc' && equalAddress(q.wallet, intent.wallet)
    && equalAddress(q.inputToken, intent.inputToken) && equalAddress(q.outputToken, intent.outputToken)
    && q.inputAmountRaw === intent.amountRaw && uint(q.inputAmountRaw) && uint(q.outputAmountRaw)
    && uint(q.minOutputAmountRaw), 'invalid_quote_identity_or_amount');
  check(Number.isInteger(q.inputDecimals) && q.inputDecimals >= 0 && q.inputDecimals <= 36
    && Number.isInteger(q.outputDecimals) && q.outputDecimals >= 0 && q.outputDecimals <= 36,
  'invalid_quote_decimals');
  const buy = equalAddress(intent.inputToken, TRADE_BOT_USDC);
  check((buy ? q.inputDecimals : q.outputDecimals) === 18
    && (tokenDecimals === null || (buy ? q.outputDecimals : q.inputDecimals) === tokenDecimals), 'quote_decimals_mismatch');
  check(money(q.gasUsdMicros) && q.gasUsdMicros <= P.gasLimitUsdMicros, 'quote_gas_limit');
  check(BigInt(q.minOutputAmountRaw) <= BigInt(q.outputAmountRaw)
    && BigInt(q.minOutputAmountRaw) * 100n >= BigInt(q.outputAmountRaw) * 99n, 'quote_slippage_limit');
  const age = ms(now) - ms(q.observedAt), validity = ms(q.validUntil) - ms(q.observedAt);
  check(age >= 0 && age <= 5000 && validity > 0 && validity <= 30_000 && ms(q.validUntil) >= ms(now), 'stale_quote');
}
function fillCheck(o, f) {
  check(f && f.inputAmountRaw === o.intent.amountRaw && uint(f.inputAmountRaw) && uint(f.outputAmountRaw)
    && typeof f.gasUsdMicros === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(f.gasUsdMicros)
    && fee(f) <= P.gasLimitUsdMicros && f.inputDecimals === o.quote.inputDecimals
    && f.outputDecimals === o.quote.outputDecimals
    && BigInt(f.outputAmountRaw) >= BigInt(o.quote.minOutputAmountRaw), 'receipt_outside_intent');
}
function derived(s, now) {
  let cash = BigInt(P.initialCashUsdMicros), totalLoss = 0n, dailyLoss = 0n, pnl = 0n;
  const buys = s.orders.filter(o => o.side === 'buy');
  const positions = [], closed = [];
  for (const buy of buys) {
    if (buy.status !== 'confirmed') continue;
    cash -= BigInt(cost(buy));
    const sell = s.orders.find(o => o.side === 'sell' && o.positionId === buy.id);
    if (sell?.status === 'confirmed') {
      const profit = BigInt(netExit(sell) - cost(buy));
      cash += BigInt(netExit(sell)); pnl += profit;
      if (profit < 0n) { totalLoss -= profit; if (sell.confirmedAt.slice(0, 10) === now.slice(0, 10)) dailyLoss -= profit; }
      closed.push({ positionId: buy.id, realizedPnlUsdMicros: safeNumber(profit), reason: sell.exitReason });
    } else positions.push({ id: buy.id, token: buy.intent.outputToken, quantityRaw: buy.fill.outputAmountRaw,
      decimals: buy.fill.outputDecimals, costUsdMicros: cost(buy), openedAt: buy.confirmedAt, exitPending: Boolean(sell) });
  }
  const pendingBuys = buys.filter(o => o.status !== 'confirmed');
  const reserved = pendingBuys.length * (P.tradeUsdMicros + P.gasLimitUsdMicros)
    + (pendingBuys.length + positions.length) * P.gasLimitUsdMicros;
  return { cashUsdMicros: safeNumber(cash), reservedUsdMicros: reserved, availableUsdMicros: safeNumber(cash) - reserved,
    realizedPnlUsdMicros: safeNumber(pnl), dailyLossUsdMicros: safeNumber(dailyLoss), totalLossUsdMicros: safeNumber(totalLoss),
    positions, closed, unresolvedOrders: s.orders.filter(o => o.status !== 'confirmed').map(o => o.id) };
}
export function createTradeBotState({ wallet, now }) {
  const state = { schema: 'trade_bot_v1', mode: 'offline_replay', executable: false,
    valuationAssumption: 'fixture_only_USDC_18_decimals_equals_1_USD', wallet,
    policy: { ...P }, entriesPaused: false, haltedReason: null, orders: [], createdAt: now, updatedAt: now };
  validateTradeBotState(state); return state;
}
export function validateTradeBotState(s) {
  check(s && s.schema === 'trade_bot_v1' && s.mode === 'offline_replay' && s.executable === false
    && s.valuationAssumption === 'fixture_only_USDC_18_decimals_equals_1_USD' && address(s.wallet)
    && canonical(s.policy) === canonical(P) && typeof s.entriesPaused === 'boolean'
    && [null, 'contradictory_receipt'].includes(s.haltedReason) && Array.isArray(s.orders) && s.orders.length <= 10_000,
  'invalid_bot_state');
  check(ms(s.updatedAt) >= ms(s.createdAt), 'clock_regression');
  const ids = new Set(), receipts = new Set(), providerIds = new Set(), exits = new Set(), events = new Set();
  for (const o of s.orders) {
    check(o && ['buy', 'sell'].includes(o.side) && ['reserved', 'submitting', 'pending', 'uncertain', 'confirmed'].includes(o.status)
      && !ids.has(o.id) && ms(o.createdAt) >= ms(s.createdAt) && ms(o.updatedAt) >= ms(o.createdAt)
      && ms(o.updatedAt) <= ms(s.updatedAt), 'invalid_order');
    ids.add(o.id);
    check((o.orderId === null || (typeof o.orderId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(o.orderId)))
      && (o.txHash === null || /^0x[0-9a-f]{64}$/i.test(o.txHash)), 'invalid_order_reference');
    if (o.orderId) { check(!providerIds.has(o.orderId), 'duplicate_provider_order'); providerIds.add(o.orderId); }
    let expected, decimals = null;
    if (o.side === 'buy') {
      check(evaluatePaperCandidate(o.candidate, o.createdAt).length === 0
        && !equalAddress(o.candidate.ca, TRADE_BOT_USDC) && o.positionId === null
        && o.exitReason === null && o.id === idFor(`buy:${o.candidate.eventKey}`) && !events.has(o.candidate.eventKey), 'invalid_entry');
      events.add(o.candidate.eventKey);
      expected = intentFor(s, o.candidate.ca, 'buy', String(BigInt(P.tradeUsdMicros) * SCALE));
    } else {
      const buy = s.orders.find(b => b.id === o.positionId && b.side === 'buy' && b.status === 'confirmed');
      check(buy && !exits.has(o.positionId) && o.id === idFor(`sell:${o.positionId}`) && o.candidate === null
        && ms(o.createdAt) >= ms(buy.confirmedAt) && ['stop_loss', 'take_profit', 'time_exit'].includes(o.exitReason), 'invalid_exit');
      exits.add(o.positionId); decimals = buy.fill.outputDecimals;
      expected = intentFor(s, buy.intent.outputToken, 'sell', buy.fill.outputAmountRaw);
      check(o.exitReason === exitReason(cost(buy), dollars(o.quote.outputAmountRaw) - o.quote.gasUsdMicros,
        ms(o.createdAt) - ms(buy.confirmedAt)), 'invalid_exit_trigger');
    }
    check(canonical(o.intent) === canonical(expected), 'intent_changed');
    quoteCheck(o.quote, expected, o.createdAt, decimals);
    if (o.status === 'confirmed') {
      check(o.orderId && o.txHash && !receipts.has(o.txHash.toLowerCase()) && o.issue === null
        && ms(o.confirmedAt) >= ms(o.createdAt) && ms(o.confirmedAt) <= ms(o.updatedAt), 'invalid_confirmation');
      receipts.add(o.txHash.toLowerCase()); fillCheck(o, o.fill);
    } else check(o.fill === null && o.confirmedAt === null
      && (o.status !== 'reserved' || (o.orderId === null && o.txHash === null))
      && (o.status !== 'pending' || o.orderId) && (o.issue === null || ['submit_unknown', 'receipt_unknown'].includes(o.issue)), 'invalid_unresolved_order');
  }
  const summary = derived(s, s.updatedAt);
  check(summary.cashUsdMicros >= 0 && summary.availableUsdMicros >= P.cashReserveUsdMicros
    && summary.positions.length + s.orders.filter(o => o.side === 'buy' && o.status !== 'confirmed').length <= P.maximumPositions,
  'capital_invariant');
  return true;
}
function nextState(state, now) {
  validateTradeBotState(state); check(ms(now) >= ms(state.updatedAt), 'clock_regression');
  const next = clone(state); next.updatedAt = now; return next;
}
export function tradeBotSummary(state, now = state.updatedAt) {
  validateTradeBotState(state); check(ms(now) >= ms(state.updatedAt), 'clock_regression');
  return { mode: state.mode, executable: false, entriesPaused: state.entriesPaused, haltedReason: state.haltedReason,
    ...derived(state, now) };
}
function makeOrder(state, { id, side, intent, candidate = null, positionId = null, exitReason: reason = null, quote, now }) {
  const next = nextState(state, now);
  next.orders.push({ id, side, intent, candidate: clone(candidate), positionId, exitReason: reason, quote: clone(quote),
    status: 'reserved', orderId: null, txHash: null, fill: null, confirmedAt: null, issue: null, createdAt: now, updatedAt: now });
  validateTradeBotState(next); return { state: next, decision: 'reserved', orderId: id, reasons: [] };
}
export function reserveTradeBotEntry(state, candidate, quote, now) {
  nextState(state, now);
  const summary = derived(state, now), reasons = evaluatePaperCandidate(candidate, now);
  if (state.entriesPaused || state.haltedReason) reasons.push('entries_paused');
  if (summary.unresolvedOrders.length) reasons.push('unresolved_order');
  if (summary.dailyLossUsdMicros >= P.dailyLossUsdMicros) reasons.push('daily_loss_limit');
  if (summary.totalLossUsdMicros >= P.totalLossUsdMicros) reasons.push('total_loss_limit');
  if (summary.positions.length >= P.maximumPositions) reasons.push('maximum_positions');
  if (state.orders.some(o => o.candidate?.eventKey === candidate?.eventKey)) reasons.push('duplicate_signal');
  if (equalAddress(candidate?.ca, TRADE_BOT_USDC)) reasons.push('quote_asset_is_not_candidate');
  if (summary.positions.some(p => equalAddress(p.token, candidate?.ca))) reasons.push('token_already_open');
  if (summary.availableUsdMicros - P.tradeUsdMicros - 2 * P.gasLimitUsdMicros < P.cashReserveUsdMicros) reasons.push('cash_reserve');
  if (reasons.length) return { state, decision: 'watch', reasons: [...new Set(reasons)] };
  const intent = intentFor(state, candidate.ca, 'buy', String(BigInt(P.tradeUsdMicros) * SCALE));
  try { quoteCheck(quote, intent, now); } catch (error) { return { state, decision: 'watch', reasons: [error.message] }; }
  return makeOrder(state, { id: idFor(`buy:${candidate.eventKey}`), side: 'buy', intent, candidate, quote, now });
}
function exitReason(basis, value, age) {
  const pnl = BigInt(value - basis) * 10_000n;
  return pnl <= -BigInt(basis) * BigInt(P.stopLossBps) ? 'stop_loss'
    : pnl >= BigInt(basis) * BigInt(P.takeProfitBps) ? 'take_profit' : age >= P.maximumHoldMs ? 'time_exit' : null;
}
export function reserveTradeBotExit(state, positionId, quote, now) {
  nextState(state, now);
  const p = derived(state, now).positions.find(item => item.id === positionId);
  if (!p || p.exitPending) return { state, decision: 'watch', reasons: [p ? 'exit_already_pending' : 'position_not_open'] };
  const intent = intentFor(state, p.token, 'sell', p.quantityRaw);
  try { quoteCheck(quote, intent, now, p.decimals); } catch (error) { return { state, decision: 'watch', reasons: [error.message] }; }
  const reason = exitReason(p.costUsdMicros, dollars(quote.outputAmountRaw) - quote.gasUsdMicros, ms(now) - ms(p.openedAt));
  if (!reason) return { state, decision: 'hold', reasons: [] };
  return makeOrder(state, { id: idFor(`sell:${positionId}`), side: 'sell', intent, positionId, exitReason: reason, quote, now });
}
export function beginTradeBotSubmission(state, id, now) {
  const next = nextState(state, now), order = next.orders.find(o => o.id === id);
  check(order?.status === 'reserved', 'order_not_submittable');
  quoteCheck(order.quote, order.intent, now);
  order.status = 'submitting'; order.updatedAt = now;
  validateTradeBotState(next); return next;
}
export function markTradeBotSubmissionUnknown(state, id, now) {
  const next = nextState(state, now), order = next.orders.find(o => o.id === id);
  check(order && order.status !== 'confirmed' && order.status !== 'reserved', 'order_not_pending');
  order.status = 'uncertain'; order.issue = 'submit_unknown'; order.updatedAt = now;
  validateTradeBotState(next); return next;
}
export function applyTradeBotOrder(state, id, raw, now) {
  const next = nextState(state, now), order = next.orders.find(o => o.id === id);
  check(order && order.status !== 'reserved', 'order_not_submitted');
  const report = normalizeTradeBotOrder(raw, order.intent);
  const conflicts = (order.orderId && report.orderId && order.orderId !== report.orderId)
    || (order.txHash && report.txHash && order.txHash.toLowerCase() !== report.txHash.toLowerCase())
    || next.orders.some(o => o.id !== id && ((report.orderId && report.orderId === o.orderId)
      || (report.txHash && report.txHash.toLowerCase() === o.txHash?.toLowerCase())));
  if (order.status === 'confirmed') {
    if (conflicts || report.status !== 'confirmed' || JSON.stringify(report.fill) !== JSON.stringify(order.fill)) next.haltedReason = 'contradictory_receipt';
    validateTradeBotState(next); return next;
  }
  order.updatedAt = now;
  if (conflicts) { order.status = 'uncertain'; order.issue = 'receipt_unknown'; next.haltedReason = 'contradictory_receipt'; }
  else {
    order.orderId = report.orderId || order.orderId; order.txHash = report.txHash || order.txHash;
    if (report.status === 'confirmed') {
      try { fillCheck(order, report.fill); order.fill = report.fill; order.status = 'confirmed'; order.confirmedAt = now; order.issue = null; }
      catch { order.status = 'uncertain'; order.issue = 'receipt_unknown'; }
    } else if (report.status === 'pending' && order.orderId) { order.status = 'pending'; order.issue = null; }
    else { order.status = 'uncertain'; order.issue = 'receipt_unknown'; }
  }
  validateTradeBotState(next); return next;
}
export function pauseTradeBotEntries(state, paused, now) {
  check(typeof paused === 'boolean', 'invalid_pause');
  const next = nextState(state, now); next.entriesPaused = paused; return next;
}

// Dependency injection is for tests/replays ONLY. No executable live adapter is supplied.
// Save errors propagate: never send after a failed checkpoint, never continue a poisoned writer.
export function createTradeBotReplayController({ store, broker }) {
  check(broker?.mode === 'offline_fixture', 'offline_broker_required');
  let tail = Promise.resolve();
  const serialized = task => { const result = tail.then(task); tail = result.catch(() => {}); return result; };
  const submit = async (transition, now) => {
    const result = transition(await store.read());
    if (result.decision !== 'reserved') return result;
    await store.save(result.state);
    const submitting = beginTradeBotSubmission(result.state, result.orderId, now);
    await store.save(submitting); // Durable intent BEFORE the potentially ambiguous operation.
    let raw;
    try { raw = await broker.submit(clone(submitting.orders.find(o => o.id === result.orderId))); }
    catch { const unknown = markTradeBotSubmissionUnknown(submitting, result.orderId, now); await store.save(unknown); return { ...result, state: unknown, decision: 'uncertain' }; }
    const settled = applyTradeBotOrder(submitting, result.orderId, raw, now);
    await store.save(settled);
    return { ...result, state: settled, decision: settled.orders.find(o => o.id === result.orderId).status };
  };
  return {
    enter: (candidate, quote, now) => serialized(() => submit(s => reserveTradeBotEntry(s, candidate, quote, now), now)),
    exit: (positionId, quote, now) => serialized(() => submit(s => reserveTradeBotExit(s, positionId, quote, now), now)),
    reconcile: now => serialized(async () => {
      let state = await store.read(); validateTradeBotState(state);
      for (const order of state.orders.filter(o => o.status !== 'confirmed' && o.orderId)) {
        let raw; try { raw = await broker.query(clone(order)); } catch { continue; }
        state = applyTradeBotOrder(state, order.id, raw, now); await store.save(state);
      }
      return state; // No blind retransmission, including orders with no provider ID.
    }),
  };
}
