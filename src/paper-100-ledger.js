import { createHash } from 'node:crypto';
import { NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID } from './narrative-bsc-v2-quote-provider.js';

// Hypotheses for a paper experiment, not fitted/proven profitable parameters.
export const PAPER_100_POLICY = Object.freeze({
  initialCashUsdMicros: 100_000_000, tradeUsdMicros: 10_000_000,
  maximumPositions: 2, cashReserveUsdMicros: 20_000_000,
  gasPerSideUsdMicros: 200_000, executionHaircutBps: 100,
  dailyLossLimitUsdMicros: 5_000_000, lossLimitUsdMicros: 10_000_000,
  stopLossBps: 2000, takeProfitBps: 4000, maximumHoldMs: 30 * 60_000,
  candidateMaxAgeMs: 5 * 60_000, evidenceMaxAgeMs: 60_000, quoteMaxAgeMs: 5_000,
});
const P = PAPER_100_POLICY;
function plain(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value))
      && Reflect.ownKeys(value).every(key => typeof key === 'string'
        && Object.getOwnPropertyDescriptor(value, key).enumerable === true
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
  } catch { return false; }
}
function jsonData(value) {
  const active = new Set(); let nodes = 0, bytes = 0;
  function visit(item, depth) {
    if (++nodes > 20000 || depth > 32) return false;
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); return bytes <= 1_048_576; }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return true;
    if ((!Array.isArray(item) && !plain(item)) || active.has(item)) return false;
    active.add(item);
    const valid = Array.isArray(item)
      ? item.length <= 20000 && Reflect.ownKeys(item).every(key => key === 'length' || (typeof key === 'string'
        && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length
        && Object.getOwnPropertyDescriptor(item, key).enumerable === true
        && Object.hasOwn(Object.getOwnPropertyDescriptor(item, key), 'value')))
        && Array.from({ length: item.length }, (_, i) => i).every(i => Object.hasOwn(item, i) && visit(item[i], depth + 1))
      : Object.keys(item).every(key => { bytes += Buffer.byteLength(key); return bytes <= 1_048_576 && visit(item[key], depth + 1); });
    active.delete(item);
    return valid;
  }
  try { return visit(value, 0); } catch { return false; }
}
const addr = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
const isoMs = value => typeof value === 'string' && new Date(Date.parse(value)).toJSON() === value ? Date.parse(value) : NaN;
const money = value => Number.isSafeInteger(value) && value >= 0;
const netMoney = value => Number.isSafeInteger(value) && value >= -P.gasPerSideUsdMicros;
const uint = value => typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 2n ** 256n;
const fresh = (value, nowMs, age) => Number.isFinite(isoMs(value)) && isoMs(value) <= nowMs && nowMs - isoMs(value) <= age;
const copy = value => structuredClone(value);
const orderId = eventKey => `shadow:${createHash('sha256').update(eventKey).digest('hex')}`;
const sum = list => {
  const result = list.reduce((a, b) => a + BigInt(b), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsafe paper monetary total');
  return Number(result);
};
const https = value => { try { return typeof value === 'string' && new URL(value).protocol === 'https:'; } catch { return false; } };
const sameQuote = (left, right) => plain(left) && plain(right) && Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(key => Object.hasOwn(right, key) && JSON.stringify(left[key]) === JSON.stringify(right[key]));
const netExitValue = quote => Number(BigInt(quote.valueUsdMicros) * BigInt(10000 - P.executionHaircutBps) / 10000n) - P.gasPerSideUsdMicros;
function exitReason(position, exitValue, nowMs) {
  const pnl = exitValue - position.costUsdMicros;
  return BigInt(pnl) * 10000n <= -BigInt(position.costUsdMicros) * BigInt(P.stopLossBps) ? 'stop_loss'
    : BigInt(pnl) * 10000n >= BigInt(position.costUsdMicros) * BigInt(P.takeProfitBps) ? 'take_profit'
      : nowMs - isoMs(position.openedAt) >= P.maximumHoldMs ? 'time_exit' : null;
}
function clock(nowISO) {
  const nowMs = isoMs(nowISO);
  if (!Number.isFinite(nowMs)) throw new TypeError('paper clock must be an exact ISO timestamp');
  return nowMs;
}

export function createPaperAccount(nowISO = new Date().toISOString()) {
  clock(nowISO);
  return { schema: 'paper_100_v1', mode: 'paper', executable: false, policy: { ...P },
    initialCashUsdMicros: P.initialCashUsdMicros, cashUsdMicros: P.initialCashUsdMicros,
    positions: {}, closed: [], seenEventKeys: [], createdAt: nowISO, updatedAt: nowISO };
}

export function evaluatePaperCandidate(candidate, nowISO = new Date().toISOString()) {
  const nowMs = clock(nowISO);
  if (!plain(candidate) || !jsonData(candidate)) return ['invalid_candidate_shape'];
  const c = candidate, e = plain(c.evidence) ? c.evidence : {}, reasons = [];
  if (c.chainId !== 56) reasons.push('unsupported_chain');
  if (typeof c.eventKey !== 'string' || !c.eventKey.length || c.eventKey.length > 1024) reasons.push('missing_event_identity');
  if (!addr(c.ca) || !addr(c.poolAddress) || c.ca.toLowerCase() === c.poolAddress.toLowerCase()) reasons.push('missing_exact_token_or_pool');
  if (!fresh(c.observedAt, nowMs, P.candidateMaxAgeMs)) reasons.push('stale_signal');
  if (!plain(c.narrative) || !['sourced', 'verified'].includes(c.narrative?.status) || !https(c.narrative?.sourceUrl)
    || typeof c.narrative?.text !== 'string' || !c.narrative.text.trim()) reasons.push('unverified_narrative');
  if (!fresh(e.observedAt, nowMs, P.evidenceMaxAgeMs)) reasons.push('missing_or_stale_safety_review');
  if (!Array.isArray(e.sourceUrls) || !e.sourceUrls.length || !e.sourceUrls.every(https)) reasons.push('missing_safety_provenance');
  for (const key of ['sellSimulationPassed', 'contractControlsReviewed', 'lpLockOrBurnVerified',
    'holderDistributionReviewed', 'independentWalletClusterVerified']) {
    if (e[key] !== true) reasons.push(`unverified_${key}`);
  }
  // This AMM provider cannot model transfer tax. Unknown and positive tax both fail closed.
  if (e.buyTaxBps !== 0 || e.sellTaxBps !== 0) reasons.push('zero_transfer_tax_not_verified');
  if (!Number.isFinite(e.liquidityUsd) || e.liquidityUsd < 25_000) reasons.push('insufficient_verified_liquidity');
  return reasons;
}

function quoteReasons(candidate, q, nowMs, kind, quantityRaw) {
  const reasons = [];
  if (!plain(q) || !jsonData(q) || q.status !== 'ok' || q.canonicalVerified !== true
    || q.providerId !== NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID || q.marketExecutable !== true) return ['unverified_quote'];
  if (q.chainId !== 56 || !addr(q.ca) || !addr(q.poolAddress)
    || q.ca.toLowerCase() !== candidate.ca.toLowerCase()
    || q.poolAddress.toLowerCase() !== candidate.poolAddress.toLowerCase()
    || q.kind !== kind || q.side !== (kind === 'entry' ? 'buy' : 'sell')) reasons.push('quote_identity_mismatch');
  if (!fresh(q.observedAt, nowMs, P.quoteMaxAgeMs) || !Number.isFinite(isoMs(q.validUntil))
    || isoMs(q.validUntil) < nowMs || isoMs(q.validUntil) - isoMs(q.observedAt) > 30_000
    || isoMs(q.validUntil) <= isoMs(q.observedAt)) reasons.push('stale_quote');
  if (!Number.isSafeInteger(q.blockNumber) || q.blockNumber <= 0 || typeof q.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(q.blockHash)
    || typeof q.routeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(q.routeDigest)
    || !fresh(q.blockTimestamp, nowMs, 30_000)) reasons.push('invalid_quote_block');
  if (!uint(q.quantityRaw) || !uint(q.valueUsdMicros) || BigInt(q.valueUsdMicros || '0') > BigInt(Number.MAX_SAFE_INTEGER)) reasons.push('invalid_quote_amount');
  if (!Number.isSafeInteger(q.estimatedSlippageBps) || q.estimatedSlippageBps < 0 || q.estimatedSlippageBps > 300) reasons.push('excessive_quote_slippage');
  if (kind === 'entry' && q.valueUsdMicros !== String(P.tradeUsdMicros)) reasons.push('quote_notional_mismatch');
  if (kind === 'mark' && q.quantityRaw !== quantityRaw) reasons.push('quote_quantity_mismatch');
  return reasons;
}

function quoteSequenceReasons(position, quote, previous = position.lastVerifiedQuote) {
  const reasons = [];
  if (isoMs(quote.observedAt) < isoMs(position.openedAt)
    || isoMs(quote.observedAt) < isoMs(previous.observedAt)
    || quote.blockNumber < previous.blockNumber || isoMs(quote.blockTimestamp) < isoMs(previous.blockTimestamp)) {
    reasons.push('quote_regression');
  }
  if (quote.blockNumber === previous.blockNumber
    && (quote.blockHash.toLowerCase() !== previous.blockHash.toLowerCase() || quote.blockTimestamp !== previous.blockTimestamp)) {
    reasons.push('quote_block_conflict');
  }
  return reasons;
}

// State corruption or a changed policy fails closed; it must never silently refill cash.
export function validatePaperAccount(s) {
  if (!plain(s) || s.schema !== 'paper_100_v1' || s.mode !== 'paper' || s.executable !== false
    || !plain(s.policy) || JSON.stringify(s.policy) !== JSON.stringify(P) || s.initialCashUsdMicros !== P.initialCashUsdMicros
    || !money(s.cashUsdMicros) || !Number.isFinite(isoMs(s.createdAt)) || !Number.isFinite(isoMs(s.updatedAt))
    || isoMs(s.updatedAt) < isoMs(s.createdAt) || !plain(s.positions)
    || !Array.isArray(s.closed) || !Array.isArray(s.seenEventKeys)) throw new Error('invalid paper account');
  const open = Object.values(s.positions), all = [...open, ...s.closed];
  if (open.length > P.maximumPositions || s.seenEventKeys.some(key => typeof key !== 'string' || !key.length || key.length > 1024)
    || new Set(s.seenEventKeys).size !== s.seenEventKeys.length
    || all.some(p => !plain(p)) || new Set(all.map(p => p.id)).size !== all.length
    || all.length !== s.seenEventKeys.length) throw new Error('invalid paper positions');
  for (const p of all) {
    if (!Number.isFinite(isoMs(p.openedAt)) || isoMs(p.openedAt) < isoMs(s.createdAt)
      || evaluatePaperCandidate(p.candidate, p.openedAt).length || p.id !== orderId(p.candidate.eventKey) || p.orderId !== p.id
      || !s.seenEventKeys.includes(p.candidate.eventKey) || !addr(p.candidate.ca) || !addr(p.candidate.poolAddress)
      || p.candidate.chainId !== 56 || !uint(p.quantityRaw) || !fresh(p.openedAt, isoMs(s.updatedAt), Number.MAX_SAFE_INTEGER)
      || p.costUsdMicros !== P.tradeUsdMicros + P.gasPerSideUsdMicros || p.entryGasUsdMicros !== P.gasPerSideUsdMicros
      || quoteReasons(p.candidate, p.entryQuote, isoMs(p.openedAt), 'entry').length
      || p.quantityRaw !== (BigInt(p.entryQuote.quantityRaw) * BigInt(10000 - P.executionHaircutBps) / 10000n).toString()) throw new Error('invalid paper position');
    if (!fresh(p.lastVerifiedAt, isoMs(s.updatedAt), Number.MAX_SAFE_INTEGER) || isoMs(p.lastVerifiedAt) < isoMs(p.openedAt)
      || !['entry', 'mark'].includes(p.lastVerifiedQuote?.kind)
      || quoteReasons(p.candidate, p.lastVerifiedQuote, isoMs(p.lastVerifiedAt), p.lastVerifiedQuote.kind, p.quantityRaw).length) throw new Error('invalid paper quote high-water mark');
    if (p.lastVerifiedQuote.kind === 'entry') {
      if (p.lastVerifiedAt !== p.openedAt || !sameQuote(p.lastVerifiedQuote, p.entryQuote)) throw new Error('invalid paper entry high-water mark');
    } else if (quoteSequenceReasons(p, p.lastVerifiedQuote, p.entryQuote).length) throw new Error('invalid paper quote sequence');
    if (p.mark !== null && (!plain(p.mark) || !netMoney(p.mark.netValueUsdMicros)
      || p.mark.checkedAt !== p.lastVerifiedAt || p.mark.observedAt !== p.mark.quote?.observedAt
      || !sameQuote(p.mark.quote, p.lastVerifiedQuote) || p.lastVerifiedQuote.kind !== 'mark'
      || p.mark.netValueUsdMicros !== netExitValue(p.lastVerifiedQuote))) throw new Error('invalid paper mark');
  }
  for (const p of open) if (p.status !== 'open' || !Object.hasOwn(s.positions, p.id) || s.positions[p.id] !== p
    || (p.mark && exitReason(p, p.mark.netValueUsdMicros, isoMs(p.mark.checkedAt)))) throw new Error('invalid open paper position');
  for (const p of s.closed) {
    if (p.status !== 'closed' || !netMoney(p.exitValueUsdMicros) || !Number.isSafeInteger(p.realizedPnlUsdMicros)
      || p.realizedPnlUsdMicros !== p.exitValueUsdMicros - p.costUsdMicros
      || !fresh(p.closedAt, isoMs(s.updatedAt), Number.MAX_SAFE_INTEGER)
      || isoMs(p.closedAt) < isoMs(p.openedAt) || p.closedAt !== p.lastVerifiedAt || !p.mark
      || !sameQuote(p.exitQuote, p.lastVerifiedQuote) || p.exitValueUsdMicros !== netExitValue(p.exitQuote)
      || p.exitReason !== exitReason(p, p.exitValueUsdMicros, isoMs(p.closedAt)) || !p.exitReason) throw new Error('invalid closed paper position');
  }
  const expectedCash = P.initialCashUsdMicros - sum(open.map(p => p.costUsdMicros)) + sum(s.closed.map(p => p.realizedPnlUsdMicros));
  if (!money(expectedCash) || s.cashUsdMicros !== expectedCash) throw new Error('paper cash conservation failed');
  return true;
}

function lossReasons(state, nowISO) {
  const losses = state.closed.filter(p => p.realizedPnlUsdMicros < 0);
  const dailyLoss = -sum(losses.filter(p => p.closedAt.slice(0, 10) === nowISO.slice(0, 10)).map(p => p.realizedPnlUsdMicros));
  const totalLoss = -sum(losses.map(p => p.realizedPnlUsdMicros));
  return [dailyLoss >= P.dailyLossLimitUsdMicros ? 'daily_loss_limit' : null,
    totalLoss >= P.lossLimitUsdMicros ? 'total_loss_limit' : null].filter(Boolean);
}

export function openPaperPosition(state, candidate, quote, nowISO = new Date().toISOString()) {
  validatePaperAccount(state);
  const nowMs = clock(nowISO), reasons = evaluatePaperCandidate(candidate, nowISO);
  if (nowMs < isoMs(state.updatedAt)) reasons.push('clock_regression');
  if (state.seenEventKeys.includes(candidate?.eventKey)) reasons.push('duplicate_signal');
  const open = Object.values(state.positions);
  if (open.length >= P.maximumPositions) reasons.push('maximum_positions');
  if (addr(candidate?.ca) && open.some(p => p.candidate.ca.toLowerCase() === candidate.ca.toLowerCase())) reasons.push('token_already_open');
  if (open.some(p => !p.mark || !fresh(p.mark.observedAt, nowMs, 30_000))) reasons.push('open_position_unpriced');
  reasons.push(...lossReasons(state, nowISO));
  // Reserve estimated exit gas as well as untouchable cash before every admission.
  if (state.cashUsdMicros - P.tradeUsdMicros - P.gasPerSideUsdMicros
    - (open.length + 1) * P.gasPerSideUsdMicros < P.cashReserveUsdMicros) reasons.push('cash_reserve');
  if (!reasons.length) reasons.push(...quoteReasons(candidate, quote, nowMs, 'entry'));
  if (reasons.length) return { state, decision: 'watch', reasons: [...new Set(reasons)] };
  const quantityRaw = (BigInt(quote.quantityRaw) * BigInt(10000 - P.executionHaircutBps) / 10000n).toString();
  if (!uint(quantityRaw)) return { state, decision: 'watch', reasons: ['dust_after_costs'] };
  const next = copy(state), id = orderId(candidate.eventKey);
  next.positions[id] = { id, orderId: id, status: 'open', candidate: copy(candidate), quantityRaw,
    entryQuote: copy(quote), lastVerifiedQuote: copy(quote), lastVerifiedAt: nowISO,
    openedAt: nowISO, costUsdMicros: P.tradeUsdMicros + P.gasPerSideUsdMicros,
    entryGasUsdMicros: P.gasPerSideUsdMicros, mark: null };
  next.cashUsdMicros -= P.tradeUsdMicros + P.gasPerSideUsdMicros;
  next.seenEventKeys.push(candidate.eventKey);
  next.updatedAt = nowISO;
  validatePaperAccount(next);
  return { state: next, decision: 'opened', reasons: [] };
}

export function markPaperPosition(state, positionId, quote, nowISO = new Date().toISOString()) {
  validatePaperAccount(state);
  const nowMs = clock(nowISO);
  if (typeof positionId !== 'string' || !/^shadow:[0-9a-f]{64}$/.test(positionId) || !Object.hasOwn(state.positions, positionId)) {
    return { state, decision: 'unpriced', reasons: ['unknown_position'] };
  }
  const p = state.positions[positionId];
  if (nowMs < isoMs(state.updatedAt)) return { state, decision: 'unpriced', reasons: ['clock_regression'] };
  const reasons = quoteReasons(p.candidate, quote, nowMs, 'mark', p.quantityRaw);
  if (!reasons.length) reasons.push(...quoteSequenceReasons(p, quote));
  if (!reasons.length && !money(state.cashUsdMicros + netExitValue(quote))) reasons.push('unsafe_account_amount');
  if (reasons.length) {
    const next = copy(state);
    // Invalidate an old mark immediately on a failed refresh; never report stale profit.
    next.positions[positionId].mark = null;
    next.updatedAt = nowISO;
    validatePaperAccount(next);
    return { state: next, decision: 'unpriced', reasons };
  }
  const exitValue = netExitValue(quote);
  const pnl = exitValue - p.costUsdMicros;
  const next = copy(state), np = next.positions[positionId];
  np.mark = { observedAt: quote.observedAt, checkedAt: nowISO, netValueUsdMicros: exitValue, quote: copy(quote) };
  np.lastVerifiedQuote = copy(quote);
  np.lastVerifiedAt = nowISO;
  next.updatedAt = nowISO;
  // Exit at the observed quote, not at an imaginary exact stop/target price.
  const reason = exitReason(p, exitValue, nowMs);
  if (!reason) { validatePaperAccount(next); return { state: next, decision: 'held', reasons: [] }; }
  delete next.positions[positionId];
  next.closed.push({ ...np, status: 'closed', closedAt: nowISO, exitReason: reason, exitQuote: copy(quote),
    exitValueUsdMicros: exitValue, realizedPnlUsdMicros: pnl });
  next.cashUsdMicros += exitValue;
  validatePaperAccount(next);
  return { state: next, decision: 'closed', reasons: [reason] };
}

export function paperAccountSummary(state, nowISO = new Date().toISOString()) {
  validatePaperAccount(state);
  const nowMs = clock(nowISO), open = Object.values(state.positions);
  if (nowMs < isoMs(state.updatedAt)) throw new Error('paper clock regression');
  const unpricedPositions = open.filter(p => !p.mark || !fresh(p.mark.observedAt, nowMs, 30_000)).length;
  const markedValue = unpricedPositions ? null : sum(open.map(p => p.mark.netValueUsdMicros));
  return { mode: 'paper', executable: false, initialCashUsd: 100,
    cashUsd: state.cashUsdMicros / 1e6, openPositions: open.length, closedPositions: state.closed.length,
    openCostUsd: sum(open.map(p => p.costUsdMicros)) / 1e6, unpricedPositions,
    realizedPnlUsd: sum(state.closed.map(p => p.realizedPnlUsdMicros)) / 1e6,
    estimatedLiquidationEquityUsd: markedValue === null ? null : (state.cashUsdMicros + markedValue) / 1e6,
    entryHaltReasons: lossReasons(state, nowISO),
    feeModel: 'AMM quote includes pool fee; additionally assume $0.20 gas per side and 1% output haircut per side; not actual execution costs',
  };
}
