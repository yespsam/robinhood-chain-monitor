import {readyForPaperQuote, researchReadyForQuote} from './paper-candidate-research.js';
import {quoteCandidatePool, selectQuoteCandidate} from './paper-research-scheduler.js';
import {validMonitorSignal} from './paper-monitor-signal.js';
import {validCollectiveSignal, COLLECTIVE_POLICY} from './paper-collective-signal.js';
import {validAlphaSignal} from './binance-alpha-catalog.js';

export const QUOTE_OPPORTUNITY_VERSION = 'evidence_preserving_event_lease_v1';
export const EVENT_LEASE_HISTORY_LIMIT = 512;
const key = row => `${row.input.token.chain}:${row.input.token.address}`;

// Keep the CURRENT evaluation attached through the scheduling projection.
// Score alone cannot reconstruct catalyst identity, signal time or cost.
export function projectQuoteOpportunity({input, decisions, candidateBook}, {minimalEntryMode=false, recoveryMode=false}={}) {
  return {input, decisions, candidateBook,
    researchOnly: recoveryMode && !decisions.some(readyForPaperQuote),
    canQuote: minimalEntryMode && decisions.some(d => d.decision !== '不买' && !d.evidence?.safety?.blocked?.length)
      || decisions.some(readyForPaperQuote) || decisions.some(researchReadyForQuote),
    score: Math.max(...decisions.map(d => d.score))};
}

// This grants a bounded RESEARCH lease, never trading permission. Validate the
// signal again; refreshed observations cannot renew its original event clock.
function priorityEvents(row, nowMs) {
  const {token, monitorSignal: monitor, collectiveSignal: collective, alphaSignal: alpha} = row.input;
  const events = [];
  const add = (signal, sourceAt, ttl) => {
    if (!Number.isFinite(sourceAt) || sourceAt > nowMs || nowMs - sourceAt > ttl) return;
    events.push({id: `${key(row)}:${signal.id}`, sourceAt, expiresAt: sourceAt + ttl});
  };
  if (validMonitorSignal(monitor, token, nowMs)) add(monitor, Date.parse(monitor.sourceAt), 120000);
  if (validCollectiveSignal(collective, token, nowMs)) add(collective, Date.parse(collective.sourceAt), COLLECTIVE_POLICY.maxBuyAgeMs);
  if (validAlphaSignal(alpha, token, nowMs)) add(alpha, alpha.listingTime, 300000);
  return events;
}

export function selectQuoteOpportunity(rows, current, nowMs, {
  windowMs=20000, mainFirst=false, eventLeaseHistory=[], eventPreemptionSuppressedUntil=0,
}={}) {
  // Filter holdings/control rows BEFORE considering event preemption.
  const usable = quoteCandidatePool(rows, {mainFirst});
  const events = new Map(usable.map(row => [key(row), priorityEvents(row, nowMs)]));
  const history = new Map(eventLeaseHistory.slice(0, EVENT_LEASE_HISTORY_LIMIT).map(e => [e.id, e]));
  // Check clock conflicts BEFORE expiry cleanup, and keep suppression across
  // subsequent ticks. A changed clock may extend denial, never event authority.
  for (const incoming of [...events.values()].flat()) {
    const prior = history.get(incoming.id);
    if (prior && (prior.sourceAt !== incoming.sourceAt || prior.expiresAt !== incoming.expiresAt))
      history.set(incoming.id, {...prior, suppressedUntil: Math.max(prior.suppressedUntil || 0, incoming.expiresAt)});
  }
  for (const [id, e] of history) if (Math.max(e.expiresAt, e.suppressedUntil || 0) < nowMs) history.delete(id);
  for (const [tokenKey, list] of events) events.set(tokenKey, list.filter(e => {
    const prior = history.get(e.id);
    return !prior || prior.sourceAt === e.sourceAt && prior.expiresAt === e.expiresAt;
  }));
  let suppressedUntil = eventPreemptionSuppressedUntil >= nowMs ? eventPreemptionSuppressedUntil : 0;
  const retained = usable.find(row => key(row) === current?.key
    && (!mainFirst || row.candidateBook === current.candidateBook));
  const active = retained && nowMs >= current.since && nowMs - current.since < windowMs;
  const activeEvent = active && events.get(key(retained)).length > 0;
  const unserved = row => events.get(key(row)).some(e => !history.has(e.id));
  // A new event can interrupt ordinary research once, but competing event
  // groups cannot kick one another out each tick. Expiry still releases rows
  // through the normal evaluator; this does not extend any signal's lifetime.
  const newcomer = active && !activeEvent && !suppressedUntil && history.size < EVENT_LEASE_HISTORY_LIMIT
    ? usable.find(row => key(row) !== current.key && unserved(row)) : null;
  const selected = newcomer
    ? selectQuoteCandidate([newcomer, ...usable], null, nowMs, {windowMs, mainFirst})
    : selectQuoteCandidate(usable, current, nowMs, {windowMs, mainFirst});
  // Normal rotation counts too. Never evict a live tombstone to make room:
  // at capacity new events may rotate normally, but gain no preemption right.
  for (const event of selected.row ? events.get(key(selected.row)) : []) {
    if (history.has(event.id)) continue;
    if (history.size < EVENT_LEASE_HISTORY_LIMIT) history.set(event.id, event);
    // A normally rotated event still counts as served when history is full.
    // One bounded scalar prevents a second preemption after other IDs expire.
    else suppressedUntil = Math.max(suppressedUntil, event.expiresAt);
  }
  return {...selected, eventLeaseHistory: [...history.values()], eventPreemptionSuppressedUntil: suppressedUntil};
}
