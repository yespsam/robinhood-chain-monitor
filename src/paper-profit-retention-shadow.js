/** Forward-only paired exit hypothesis. Pure bookkeeping, never an order source. */
import { createHash } from 'node:crypto';

export const PROFIT_RETENTION_VERSION = 'profit_retention_principal_v2';
const COST_VERSION = 'isolated_estimated_cost_v1';
const POLICY = Object.freeze({ triggerPriceMultiple: 2, recoveryRule: 'net_sale_proceeds_cover_all_in_original_basis',
  quoteMaxAgeMs: 15000, maxPairs: 200, maxObservations: 120, maxDetails: 200,
  nextDistinctQuote: true, mainExitPrecedence: true, disarmBelowTrigger: true,
  reusedCapital: false, historicalBackfill: false, riskMeaning: 'frozen_scenario_not_maximum_loss' });
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
const sum = (a, key) => a.reduce((n, x) => n + x[key], 0);
const assert = (v, message) => { if (!v) throw new TypeError(`profit retention: ${message}`); };
const ms = v => typeof v === 'number' ? (finite(v) ? v : NaN) : typeof v === 'string' ? Date.parse(v) : NaN;
function canonical(value) {
  if (Array.isArray(value)) return value.map(x => x === undefined ? null : canonical(x));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
// Ledger order is part of the checkpoint. Native JSON survives JSON persistence and
// structuredClone without recursively sorting megabytes of frozen source evidence.
// A key-order-only rewrite conservatively freezes rather than silently rebasing.
const sourceDigest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validDigest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const keyOf = x => `${x.chain}:${x.chain === 'sol' ? x.address : x.address.toLowerCase()}`;
const identity = x => x && ['bsc', 'sol', 'eth', 'base', 'robinhood'].includes(x.chain)
  && typeof x.address === 'string' && (x.chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.address) : /^0x[0-9a-fA-F]{40}$/.test(x.address));
function sourceStamps(trades, counts = [trades.length]) {
  const wanted = new Set(counts), result = new Map(), hash = createHash('sha256').update('[');
  const capture = count => result.set(count, { tradeCount: count, lastTradeId: trades[count - 1]?.id ?? null,
    tradePrefixHash: hash.copy().update(']').digest('hex') });
  if (wanted.has(0)) capture(0);
  for (let i = 0; i < trades.length; i++) {
    if (i) hash.update(',');
    hash.update(JSON.stringify(trades[i]));
    if (wanted.has(i + 1)) capture(i + 1);
  }
  return result;
}
const stamp = trades => sourceStamps(trades).get(trades.length);
const sameStamp = (a, b) => a.tradeCount === b.tradeCount && a.lastTradeId === b.lastTradeId && a.tradePrefixHash === b.tradePrefixHash;
const validStamp = x => x && Number.isInteger(x.tradeCount) && x.tradeCount >= 0 && validDigest(x.tradePrefixHash)
  && (x.tradeCount === 0 ? x.lastTradeId === null : typeof x.lastTradeId === 'string' && x.lastTradeId.length > 0);
function accountCheck(a) {
  assert(a?.mode === 'paper' && a.execution === false && a.signing === false && a.broadcast === false
    && a.estimatedCostModel === COST_VERSION && !a.variant && !a.exitExperimentVersion && Array.isArray(a.trades), 'isolated paper account required');
  const ids = new Set();
  for (const t of a.trades) {
    assert(typeof t?.id === 'string' && t.id && !ids.has(t.id), 'duplicate or missing source trade ID');
    ids.add(t.id);
  }
}
function costCheck(c) {
  return c?.version === COST_VERSION && ['feeRate', 'slippageRate', 'buyTax', 'sellTax'].every(k => finite(c[k]) && c[k] >= 0 && c[k] < 1)
    && finite(c.gasUsd) && c.gasUsd >= 0 && c.feeRate + c.slippageRate + c.sellTax < 1;
}
function sellLeg(entry, quantity, price, atMs, kind, sourceId = null) {
  const grossUsd = quantity * price;
  const c = entry.costs;
  const costsUsd = kind === 'writeoff' ? 0 : grossUsd * (c.feeRate + c.slippageRate + c.sellTax) + c.gasUsd;
  const costBasisUsd = entry.basisUsd * quantity / entry.quantity;
  const netUsd = grossUsd - costsUsd;
  return { kind, quantity, price, atMs, sourceId, grossUsd, costsUsd, netUsd, costBasisUsd, realizedPnl: netUsd - costBasisUsd };
}
function gain(entry, price) { return sellLeg(entry, entry.quantity, price, entry.atMs, 'mark').realizedPnl; }
function recoveryQuantity(entry, price) {
  const c = entry.costs;
  return (entry.basisUsd + c.gasUsd) / (price * (1 - c.feeRate - c.slippageRate - c.sellTax));
}
const principalClose = (actual, target) => finite(actual) && finite(target)
  && Math.abs(actual - target) <= 1e-10 * Math.max(1, Math.abs(target));
const reachesTrigger = (entry, observation, policy) => observation.price >= entry.price * policy.triggerPriceMultiple;
function gap(state, reason, nowMs, pair = null) {
  state.coverage.gapCount++;
  state.coverage.reasons[reason] = (state.coverage.reasons[reason] || 0) + 1;
  state.coverage.latest.push({ reason, atMs: nowMs, pairId: pair?.id ?? null });
  state.coverage.latest = state.coverage.latest.slice(-POLICY.maxDetails);
  if (pair) pair.gapCount++;
}
function exclude(state, pair, reason, nowMs) {
  pair.status = 'excluded'; pair.exclusion = { reason, atMs: nowMs }; pair.armed = null;
  gap(state, reason, nowMs, pair);
}
function rejection(state, trade, reason, nowMs) {
  state.ineligibleCount++;
  state.ineligible.push({ tradeId: trade.id, chain: trade.chain ?? null, address: trade.address ?? null, reason, atMs: nowMs });
  state.ineligible = state.ineligible.slice(-POLICY.maxDetails);
}
function entryFrom(t, nowMs, baselineMs) {
  const c = t.entryEvidence?.costAssumptions;
  const sourceRisk = t.entryEvidence?.traderDecision?.economics?.plannedStopLossUsd;
  const riskUsd = positive(sourceRisk) ? sourceRisk : null;
  if (!identity(t) || !positive(t.quantity) || !positive(t.price) || !positive(t.costBasisUsd) || !finite(t.atMs)
      || t.atMs < baselineMs || t.atMs > nowMs) return { error: 'entry_identity_or_time_invalid' };
  if (!costCheck(c)) return { error: 'entry_costs_missing_or_invalid' };
  const grossUsd = t.quantity * t.price;
  const costsUsd = grossUsd * (c.feeRate + c.slippageRate + c.buyTax) + c.gasUsd;
  if (!close(t.grossUsd, grossUsd) || !close(t.costsUsd, costsUsd) || !close(t.netUsd, -t.costBasisUsd)
      || !close(grossUsd + costsUsd, t.costBasisUsd) || t.realizedPnl !== 0) return { error: 'entry_arithmetic_invalid' };
  return { entry: { tradeId: t.id, sourceDigest: sourceDigest(t), chain: t.chain, address: t.address,
    symbol: typeof t.symbol === 'string' ? t.symbol : '', route: t.entryEvidence?.opportunity?.id || t.strategyId || 'unknown',
    atMs: t.atMs, price: t.price, quantity: t.quantity, basisUsd: t.costBasisUsd, grossUsd, costsUsd, riskUsd,
    costs: Object.fromEntries(['version', 'feeRate', 'slippageRate', 'buyTax', 'sellTax', 'gasUsd'].map(k => [k, c[k]])) } };
}

export function createProfitRetentionShadow(account, { sessionId, nowMs, triggerPriceMultiple = 2 } = {}) {
  accountCheck(account);
  assert(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200, 'session ID required');
  assert(finite(nowMs) && nowMs >= 0, 'invalid start time');
  assert([2, 3, 5].includes(triggerPriceMultiple), 'supported trigger price multiples are 2, 3, 5');
  assert(account.trades.every(t => finite(t.atMs) && t.atMs <= nowMs), 'future baseline trade');
  const cursor = stamp(account.trades);
  const policy = { ...POLICY, triggerPriceMultiple };
  return { version: PROFIT_RETENTION_VERSION, sessionId, mode: 'shadow_paper', execution: false, signing: false, broadcast: false,
    policy, baseline: { ...cursor, establishedAtMs: nowMs, policyDigest: digest(policy) }, cursor, updatedAtMs: nowMs,
    pairs: [], ineligible: [], ineligibleCount: 0, admissionStopped: false,
    coverage: { gapCount: 0, reasons: {}, latest: [] } };
}

export function advanceProfitRetentionShadow(state, { beforeAccount, afterAccount, marks = [], nowMs } = {}) {
  validateProfitRetentionShadow(state); accountCheck(beforeAccount); accountCheck(afterAccount);
  assert(finite(nowMs) && nowMs >= state.updatedAtMs, 'time rewind');
  const beforeProofs = sourceStamps(beforeAccount.trades, [beforeAccount.trades.length, state.baseline.tradeCount]);
  const beforeStamp = beforeProofs.get(beforeAccount.trades.length);
  assert(sameStamp(state.cursor, beforeStamp), 'source checkpoint discontinuity');
  assert(afterAccount.trades.length >= beforeAccount.trades.length, 'source ledger rewind or history mutation');
  // Reuse only proofs produced in this synchronous call, never a cached historical claim.
  const afterProofs = afterAccount.trades === beforeAccount.trades ? beforeProofs
    : sourceStamps(afterAccount.trades, [state.cursor.tradeCount, afterAccount.trades.length]);
  const afterPrefixStamp = afterProofs.get(state.cursor.tradeCount);
  assert(sameStamp(state.cursor, afterPrefixStamp), 'source ledger rewind or history mutation');
  // Matching full before/after prefixes implies the before baseline is also the after baseline.
  const baselineStamp = beforeProofs.get(state.baseline.tradeCount);
  assert(sameStamp(state.baseline, baselineStamp), 'baseline history mutation');
  const sourceById = new Map(beforeAccount.trades.map(t => [t.id, t]));
  for (const pair of state.pairs) {
    const source = sourceById.get(pair.id), parsed = source && entryFrom(source, nowMs, state.baseline.establishedAtMs);
    assert(parsed?.entry && digest(parsed.entry) === digest(pair.entry), 'frozen entry differs from committed source');
    if (pair.control) {
      const exit = sourceById.get(pair.control.sourceId);
      assert(exit && sourceDigest(exit) === pair.control.sourceDigest && exit.side === pair.control.kind
        && ['atMs', 'price', 'quantity', 'grossUsd', 'costsUsd', 'netUsd', 'costBasisUsd', 'realizedPnl'].every(k => close(exit[k], pair.control[k])), 'control differs from committed source');
    }
  }
  assert(Array.isArray(marks) || marks && typeof marks === 'object', 'invalid marks');
  const next = structuredClone(state), added = afterAccount.trades.slice(state.cursor.tradeCount);
  // Apply actual main exits BEFORE observing any quote in this call.
  for (const trade of added) {
    assert(finite(trade.atMs) && trade.atMs >= state.updatedAtMs && trade.atMs <= nowMs, 'backdated or future source trade');
    assert(['buy', 'sell', 'writeoff'].includes(trade.side), 'unknown source trade side');
    if (trade.side === 'buy') {
      if (next.pairs.length >= POLICY.maxPairs) { next.admissionStopped = true; rejection(next, trade, 'study_capacity_reached', nowMs); continue; }
      const parsed = entryFrom(trade, nowMs, next.baseline.establishedAtMs);
      if (parsed.error) { rejection(next, trade, parsed.error, nowMs); continue; }
      if (next.pairs.some(p => p.status === 'active' && keyOf(p.entry) === keyOf(trade))) {
        rejection(next, trade, 'overlapping_main_entries_unsupported', nowMs);
        for (const p of next.pairs.filter(p => p.status === 'active' && keyOf(p.entry) === keyOf(trade))) exclude(next, p, 'overlapping_main_entries_unsupported', nowMs);
        continue;
      }
      next.pairs.push({ id: trade.id, entry: parsed.entry, status: 'active', exclusion: null, control: null,
        treatment: { legs: [], remainingQuantity: trade.quantity, remainingBasisUsd: trade.costBasisUsd, partialTaken: false },
        armed: null, firstTrigger: null, peak: null, lastObservation: null, observations: [], observationCount: 0, gapCount: 0 });
      continue;
    }
    if (!identity(trade)) { gap(next, 'exit_identity_invalid', nowMs); continue; }
    const pair = next.pairs.find(p => p.status === 'active' && keyOf(p.entry) === keyOf(trade));
    if (!pair) continue; // Baseline open holdings and ineligible buys are not backfilled.
    if (!close(trade.quantity, pair.entry.quantity) || !close(trade.costBasisUsd, pair.entry.basisUsd)) {
      exclude(next, pair, 'main_partial_exit_unsupported', nowMs); continue;
    }
    if (trade.atMs < pair.entry.atMs || !(trade.side === 'writeoff' ? trade.price === 0 : positive(trade.price))) {
      exclude(next, pair, 'main_exit_price_or_time_invalid', nowMs); continue;
    }
    const expected = sellLeg(pair.entry, pair.entry.quantity, trade.price, trade.atMs, trade.side, trade.id);
    if (!['grossUsd', 'costsUsd', 'netUsd', 'costBasisUsd', 'realizedPnl'].every(k => close(expected[k], trade[k]))) {
      exclude(next, pair, 'main_exit_cost_or_arithmetic_changed', nowMs); continue;
    }
    pair.control = { ...expected, sourceDigest: sourceDigest(trade), realizedPnl: trade.realizedPnl };
    pair.treatment.legs.push(sellLeg(pair.entry, pair.treatment.remainingQuantity, trade.price, trade.atMs, trade.side, trade.id));
    pair.treatment.remainingQuantity = 0; pair.treatment.remainingBasisUsd = 0; pair.armed = null; pair.status = 'completed';
  }
  const rows = Array.isArray(marks) ? marks : Object.values(marks);
  for (const pair of next.pairs.filter(p => p.status === 'active')) {
    const matching = rows.filter(m => identity(m) && keyOf(m) === keyOf(pair.entry));
    if (!matching.length) { gap(next, 'missing_quote', nowMs, pair); continue; }
    // At most the newest quote per update; never replay a historical quote batch.
    const candidates = matching.filter(m => m.status === 'ok' && positive(m.price) && finite(ms(m.observedAt)));
    if (!candidates.length) { gap(next, 'invalid_quote', nowMs, pair); continue; }
    const mark = candidates.reduce((a, b) => ms(a.observedAt) >= ms(b.observedAt) ? a : b);
    const atMs = ms(mark.observedAt), last = pair.lastObservation;
    if (matching.some(m => ms(m.observedAt) === atMs && m.price !== mark.price)) { gap(next, 'conflicting_quote_timestamp', nowMs, pair); continue; }
    if (atMs > nowMs) { gap(next, 'future_quote', nowMs, pair); continue; }
    if (atMs <= pair.entry.atMs) { gap(next, 'pre_entry_quote', nowMs, pair); continue; }
    if (nowMs - atMs > POLICY.quoteMaxAgeMs) { gap(next, 'stale_quote', nowMs, pair); continue; }
    if (last && atMs <= last.atMs) {
      if (atMs === last.atMs && mark.price !== last.price) gap(next, 'conflicting_quote_timestamp', nowMs, pair);
      else if (atMs < last.atMs) gap(next, 'out_of_order_quote', nowMs, pair);
      continue;
    }
    const observation = { atMs, receivedAtMs: nowMs, price: mark.price, fullLiquidationNetUsd: gain(pair.entry, mark.price) };
    pair.lastObservation = observation; pair.observations.push(observation); pair.observations = pair.observations.slice(-POLICY.maxObservations); pair.observationCount++;
    if (!pair.peak || observation.price > pair.peak.price) pair.peak = { ...observation };
    if (pair.treatment.partialTaken) continue;
    if (pair.armed) {
      if (reachesTrigger(pair.entry, observation, next.policy)) {
        const quantity = recoveryQuantity(pair.entry, mark.price);
        if (!positive(quantity) || quantity >= pair.treatment.remainingQuantity) {
          gap(next, 'principal_recovery_infeasible', nowMs, pair); pair.armed = null; continue;
        }
        const leg = sellLeg(pair.entry, quantity, mark.price, atMs, 'partial');
        if (!principalClose(leg.netUsd, pair.entry.basisUsd)) { gap(next, 'principal_recovery_arithmetic_invalid', nowMs, pair); pair.armed = null; continue; }
        leg.triggerObservation = { ...pair.armed }; leg.fillObservation = { ...observation };
        pair.treatment.legs.push(leg); pair.treatment.partialTaken = true;
        pair.treatment.remainingQuantity -= leg.quantity; pair.treatment.remainingBasisUsd -= leg.costBasisUsd;
      }
      pair.armed = null;
    } else if (reachesTrigger(pair.entry, observation, next.policy)) {
      pair.armed = { ...observation }; pair.firstTrigger ??= { ...observation };
    }
  }
  next.cursor = afterProofs.get(afterAccount.trades.length); next.updatedAtMs = nowMs;
  if (next.pairs.length >= POLICY.maxPairs) next.admissionStopped = true;
  validateProfitRetentionShadow(next);
  return next;
}

function observationValid(o, entry, updatedAtMs) {
  return o && positive(o.price) && finite(o.atMs) && o.atMs > entry.atMs && o.atMs <= o.receivedAtMs
    && o.receivedAtMs <= updatedAtMs && o.receivedAtMs - o.atMs <= POLICY.quoteMaxAgeMs
    && close(o.fullLiquidationNetUsd, gain(entry, o.price));
}
export function validateProfitRetentionShadow(state) {
  assert(state?.version === PROFIT_RETENTION_VERSION && state.mode === 'shadow_paper' && state.execution === false && state.signing === false && state.broadcast === false, 'invalid study identity');
  assert(typeof state.sessionId === 'string' && state.sessionId.length > 0 && state.sessionId.length <= 200, 'invalid session');
  assert([2, 3, 5].includes(state.policy?.triggerPriceMultiple)
    && digest(state.policy) === digest({ ...POLICY, triggerPriceMultiple: state.policy.triggerPriceMultiple })
    && state.baseline?.policyDigest === digest(state.policy), 'preregistered policy changed');
  assert(validStamp(state.baseline) && validStamp(state.cursor) && state.cursor.tradeCount >= state.baseline.tradeCount
    && finite(state.baseline.establishedAtMs) && state.baseline.establishedAtMs >= 0 && finite(state.updatedAtMs) && state.updatedAtMs >= state.baseline.establishedAtMs, 'invalid checkpoint');
  assert(Array.isArray(state.pairs) && state.pairs.length <= POLICY.maxPairs && typeof state.admissionStopped === 'boolean'
    && (state.pairs.length < POLICY.maxPairs || state.admissionStopped), 'invalid capacity');
  assert(Array.isArray(state.ineligible) && state.ineligible.length <= POLICY.maxDetails && Number.isInteger(state.ineligibleCount)
    && state.ineligibleCount >= state.ineligible.length, 'invalid exclusions');
  assert(state.ineligible.every(x => typeof x.tradeId === 'string' && typeof x.reason === 'string' && finite(x.atMs) && x.atMs >= state.baseline.establishedAtMs && x.atMs <= state.updatedAtMs), 'invalid excluded entry');
  const cov = state.coverage;
  assert(cov && Number.isInteger(cov.gapCount) && cov.gapCount >= 0 && cov.reasons && typeof cov.reasons === 'object' && !Array.isArray(cov.reasons)
    && Object.values(cov.reasons).every(n => Number.isInteger(n) && n >= 0) && Object.values(cov.reasons).reduce((a, b) => a + b, 0) === cov.gapCount
    && Array.isArray(cov.latest) && cov.latest.length <= POLICY.maxDetails && cov.latest.length <= cov.gapCount
    && cov.latest.every(g => typeof g.reason === 'string' && finite(g.atMs) && g.atMs >= state.baseline.establishedAtMs && g.atMs <= state.updatedAtMs), 'invalid coverage');
  const ids = new Set(), activeKeys = new Set();
  for (const p of state.pairs) {
    const e = p.entry, t = p.treatment;
    assert(e && p.id === e.tradeId && typeof p.id === 'string' && !ids.has(p.id) && validDigest(e.sourceDigest) && identity(e), 'invalid paired identity'); ids.add(p.id);
    assert(positive(e.quantity) && positive(e.price) && positive(e.basisUsd) && (e.riskUsd === null || positive(e.riskUsd)) && finite(e.atMs)
      && e.atMs >= state.baseline.establishedAtMs && e.atMs <= state.updatedAtMs && costCheck(e.costs), 'invalid frozen entry');
    assert(close(e.grossUsd, e.quantity * e.price) && close(e.costsUsd, e.grossUsd * (e.costs.feeRate + e.costs.slippageRate + e.costs.buyTax) + e.costs.gasUsd)
      && close(e.basisUsd, e.grossUsd + e.costsUsd), 'entry accounting does not reconcile');
    assert(['active', 'completed', 'excluded'].includes(p.status) && Number.isInteger(p.gapCount) && p.gapCount >= 0, 'invalid paired status');
    if (p.status === 'active') { assert(!activeKeys.has(keyOf(e)), 'overlapping paired lots'); activeKeys.add(keyOf(e)); }
    assert(p.status === 'excluded' ? typeof p.exclusion?.reason === 'string' && finite(p.exclusion.atMs) && p.exclusion.atMs <= state.updatedAtMs : p.exclusion === null, 'invalid pair exclusion');
    assert(t && Array.isArray(t.legs) && t.legs.length <= 2 && typeof t.partialTaken === 'boolean' && finite(t.remainingQuantity) && t.remainingQuantity >= 0 && finite(t.remainingBasisUsd) && t.remainingBasisUsd >= 0, 'invalid treatment');
    let previousAt = e.atMs;
    for (let i = 0; i < t.legs.length; i++) {
      const leg = t.legs[i];
      assert(['partial', 'sell', 'writeoff'].includes(leg.kind) && positive(leg.quantity) && finite(leg.atMs) && leg.atMs >= previousAt && leg.atMs <= state.updatedAtMs
        && (leg.kind === 'writeoff' ? leg.price === 0 : positive(leg.price)), 'invalid treatment exit');
      assert(leg.kind !== 'partial' || i === 0 && principalClose(leg.quantity, recoveryQuantity(e, leg.price))
        && leg.quantity < e.quantity && principalClose(leg.netUsd, e.basisUsd) && leg.sourceId === null, 'invalid principal recovery quantity');
      const expected = sellLeg(e, leg.quantity, leg.price, leg.atMs, leg.kind, leg.sourceId);
      assert(['grossUsd', 'costsUsd', 'netUsd', 'costBasisUsd', 'realizedPnl'].every(k => close(leg[k], expected[k])), 'treatment exit arithmetic mismatch');
      previousAt = leg.atMs;
    }
    assert(t.partialTaken === t.legs.some(x => x.kind === 'partial') && close(t.remainingQuantity, e.quantity - sum(t.legs, 'quantity'))
      && close(t.remainingBasisUsd, e.basisUsd - sum(t.legs, 'costBasisUsd')), 'remaining inventory does not reconcile');
    assert(Array.isArray(p.observations) && p.observations.length <= POLICY.maxObservations && Number.isInteger(p.observationCount) && p.observationCount >= p.observations.length, 'invalid observations');
    for (let i = 0; i < p.observations.length; i++) assert(observationValid(p.observations[i], e, state.updatedAtMs) && (!i || p.observations[i].atMs > p.observations[i - 1].atMs), 'invalid observation order');
    for (const o of [p.lastObservation, p.peak, p.firstTrigger, p.armed]) assert(o === null || observationValid(o, e, state.updatedAtMs), 'invalid saved observation');
    assert(p.observationCount === 0 ? p.lastObservation === null && p.peak === null : p.lastObservation && p.peak && digest(p.lastObservation) === digest(p.observations.at(-1)), 'latest observation mismatch');
    assert(!p.peak || p.observations.every(o => p.peak.price >= o.price), 'observed peak mismatch');
    assert(!p.firstTrigger || reachesTrigger(e, p.firstTrigger, state.policy), 'invalid first trigger');
    assert(!p.armed || !t.partialTaken && p.status === 'active' && p.firstTrigger && reachesTrigger(e, p.armed, state.policy) && digest(p.armed) === digest(p.lastObservation), 'invalid armed trigger');
    if (t.partialTaken) {
      const partial = t.legs[0];
      assert(p.firstTrigger && partial.atMs > p.firstTrigger.atMs && reachesTrigger(e, partial, state.policy) && principalClose(partial.netUsd, e.basisUsd)
        && observationValid(partial.triggerObservation, e, state.updatedAtMs) && observationValid(partial.fillObservation, e, state.updatedAtMs)
        && reachesTrigger(e, partial.triggerObservation, state.policy) && partial.triggerObservation.atMs < partial.fillObservation.atMs
        && partial.fillObservation.atMs === partial.atMs && partial.fillObservation.price === partial.price, 'partial without distinct eligible observation');
    }
    if (p.status === 'completed') {
      const c = p.control, last = t.legs.at(-1);
      assert(c && ['sell', 'writeoff'].includes(c.kind) && validDigest(c.sourceDigest) && typeof c.sourceId === 'string'
        && close(c.quantity, e.quantity) && t.remainingQuantity === 0 && t.remainingBasisUsd === 0 && last.kind === c.kind && last.sourceId === c.sourceId && last.atMs === c.atMs && last.price === c.price, 'invalid completed control');
      const expected = sellLeg(e, e.quantity, c.price, c.atMs, c.kind, c.sourceId);
      assert(['grossUsd', 'costsUsd', 'netUsd', 'costBasisUsd', 'realizedPnl'].every(k => close(c[k], expected[k])), 'control arithmetic mismatch');
    } else assert(p.control === null && t.legs.every(x => x.kind === 'partial') && t.remainingQuantity > 0, 'uncompleted pair contains final exit');
  }
  return true;
}

function concentration(rows, key) {
  const totals = new Map();
  for (const r of rows) totals.set(keyOf(r.entry), (totals.get(keyOf(r.entry)) || 0) + r[key]);
  const positiveTotals = [...totals.values()].filter(n => n > 0), negativeTotals = [...totals.values()].filter(n => n < 0);
  const profits = positiveTotals.reduce((a, b) => a + b, 0), losses = -negativeTotals.reduce((a, b) => a + b, 0);
  return { positiveNetUsd: profits, negativeNetUsd: -losses, largestPositiveCAShare: profits > 0 ? Math.max(...positiveTotals) / profits : null,
    largestLossCAShare: losses > 0 ? -Math.min(...negativeTotals) / losses : null };
}
export function profitRetentionSummary(state, { nowMs } = {}) {
  validateProfitRetentionShadow(state);
  assert(finite(nowMs) && nowMs >= state.updatedAtMs, 'invalid summary time');
  const completed = state.pairs.filter(p => p.status === 'completed').map(p => ({ ...p,
    controlNetUsd: p.control.realizedPnl, treatmentNetUsd: sum(p.treatment.legs, 'realizedPnl'),
    controlCostsUsd: p.entry.costsUsd + p.control.costsUsd, treatmentCostsUsd: p.entry.costsUsd + sum(p.treatment.legs, 'costsUsd'),
    controlGrossPricePnlUsd: p.control.grossUsd - p.entry.grossUsd, treatmentGrossPricePnlUsd: sum(p.treatment.legs, 'grossUsd') - p.entry.grossUsd }));
  const totals = rows => ({ pairs: rows.length, controlNetUsd: sum(rows, 'controlNetUsd'), treatmentNetUsd: sum(rows, 'treatmentNetUsd'),
    deltaNetUsd: sum(rows, 'treatmentNetUsd') - sum(rows, 'controlNetUsd'), controlCostsUsd: sum(rows, 'controlCostsUsd'),
    treatmentCostsUsd: sum(rows, 'treatmentCostsUsd'), extraCostsUsd: sum(rows, 'treatmentCostsUsd') - sum(rows, 'controlCostsUsd'),
    controlGrossPricePnlUsd: sum(rows, 'controlGrossPricePnlUsd'), treatmentGrossPricePnlUsd: sum(rows, 'treatmentGrossPricePnlUsd') });
  const byChainRoute = {};
  for (const p of completed) { const k = `${p.entry.chain}:${p.entry.route}`; (byChainRoute[k] ??= []).push(p); }
  const performance = completed.length ? { ...totals(completed), winsControl: completed.filter(p => p.controlNetUsd > 0).length,
    winsTreatment: completed.filter(p => p.treatmentNetUsd > 0).length, distinctCAs: new Set(completed.map(p => keyOf(p.entry))).size,
    byChainRoute: Object.fromEntries(Object.entries(byChainRoute).map(([k, rows]) => [k, totals(rows)])),
    concentration: { control: concentration(completed, 'controlNetUsd'), treatment: concentration(completed, 'treatmentNetUsd') } } : null;
  const active = state.pairs.filter(p => p.status === 'active').map(p => {
    const last = p.lastObservation, fresh = last && nowMs >= last.atMs && nowMs - last.atMs <= POLICY.quoteMaxAgeMs;
    return { id: p.id, chain: p.entry.chain, address: p.entry.address, remainingQuantity: p.treatment.remainingQuantity,
      recoveredPrincipalUsd: p.treatment.partialTaken ? p.treatment.legs[0].netUsd : 0,
      principalTargetUsd: p.entry.basisUsd, remainingFraction: p.treatment.remainingQuantity / p.entry.quantity,
      recoveryAtMs: p.treatment.partialTaken ? p.treatment.legs[0].atMs : null,
      partialTaken: p.treatment.partialTaken, controlUnrealizedNetUsd: fresh ? gain(p.entry, last.price) : null,
      treatmentTotalIfLiquidatedUsd: fresh ? sum(p.treatment.legs, 'realizedPnl') + sellLeg(p.entry, p.treatment.remainingQuantity, last.price, last.atMs, 'mark').realizedPnl : null,
      valuationAtMs: fresh ? last.atMs : null };
  });
  return { version: state.version, sessionId: state.sessionId, status: state.admissionStopped ? 'admission_stopped' : 'observing',
    startedAtMs: state.baseline.establishedAtMs, updatedAtMs: state.updatedAtMs, closedPairs: completed.length, openPairs: active.length,
    excludedPairs: state.pairs.filter(p => p.status === 'excluded').length, ineligibleEntries: state.ineligibleCount,
    admissionStopped: state.admissionStopped, performance, active, coverage: structuredClone(state.coverage), policy: { ...state.policy },
    note: 'Same actual entries; forward hypothetical exits only. Price multiple, not net return multiple. Recovered principal is cashflow, not all profit; remaining inventory and future exit gas still carry risk. Hypothetical fractional quantities: token atom precision and executable routes not modeled. Model fees/slippage/gas; no execution or independent capital reuse.' };
}
