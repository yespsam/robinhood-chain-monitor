import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperAccount, validatePaperAccount, evaluatePaperCandidate, openPaperPosition,
  markPaperPosition, paperAccountSummary, PAPER_100_POLICY } from '../src/paper-100-ledger.js';
import { NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID } from '../src/narrative-bsc-v2-quote-provider.js';

const T = Date.parse('2026-09-20T00:00:00.000Z');
const at = delta => new Date(T + delta).toISOString();
function candidate(i = 1, time = at(0)) {
  return { eventKey: `gmgn-flow:test:${i}`, chainId: 56, ca: `0x${String(i).padStart(40, '0')}`,
    poolAddress: `0x${String(i + 100).padStart(40, '0')}`, symbol: `TEST${i}`, observedAt: time,
    narrative: { status: 'sourced', text: 'Test-only verified event', sourceUrl: 'https://example.org/event' },
    evidence: { observedAt: time, sourceUrls: ['https://example.org/review'], sellSimulationPassed: true,
      contractControlsReviewed: true, lpLockOrBurnVerified: true, holderDistributionReviewed: true,
      independentWalletClusterVerified: true, buyTaxBps: 0, sellTaxBps: 0, liquidityUsd: 30000 } };
}
function quote(c, time = c.observedAt, overrides = {}) {
  const blockNumber = 123 + Math.floor((Date.parse(time) - T) / 1000);
  return { status: 'ok', providerId: NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID, canonicalVerified: true,
    marketExecutable: true, kind: 'entry', side: 'buy', chainId: 56, ca: c.ca, poolAddress: c.poolAddress,
    observedAt: time, validUntil: new Date(Date.parse(time) + 5000).toISOString(),
    blockNumber, blockHash: `0x${BigInt(blockNumber).toString(16).padStart(64, '0')}`,
    blockTimestamp: new Date(Math.floor(Date.parse(time) / 1000) * 1000).toISOString(),
    quantityRaw: '1000000000000000000', valueUsdMicros: '10000000', priceUsdMicros: '10',
    estimatedSlippageBps: 30, routeDigest: 'b'.repeat(64), ...overrides };
}
function open(state = createPaperAccount(at(0)), i = 1, delta = 0) {
  const c = candidate(i, at(delta));
  return openPaperPosition(state, c, quote(c), at(delta));
}
function mark(state, value, delta = 1000) {
  const p = Object.values(state.positions)[0];
  const q = quote(p.candidate, at(delta), { kind: 'mark', side: 'sell', quantityRaw: p.quantityRaw, valueUsdMicros: String(value) });
  return markPaperPosition(state, p.id, q, at(delta));
}

test('new paper account has $100 cash and no execution capability', () => {
  const state = createPaperAccount(at(0));
  assert.equal(validatePaperAccount(state), true);
  assert.equal(paperAccountSummary(state, at(0)).cashUsd, 100);
  assert.equal(state.executable, false);
  assert.equal(state.policy.tradeUsdMicros, 10_000_000);
});

test('entry actually debits cash and conservatively reduces quantity; immutable input', () => {
  const original = createPaperAccount(at(0)), result = open(original);
  assert.equal(result.decision, 'opened');
  assert.equal(result.state.cashUsdMicros, 89_800_000);
  assert.equal(Object.values(result.state.positions)[0].quantityRaw, '990000000000000000');
  assert.equal(original.cashUsdMicros, 100_000_000);
  assert.equal(paperAccountSummary(result.state, at(0)).estimatedLiquidationEquityUsd, null);
});

test('duplicate event cannot spend cash twice before or after exit/restart', () => {
  const first = open();
  assert.ok(open(first.state).reasons.includes('duplicate_signal'));
  const closed = mark(first.state, 15_000_000);
  const restarted = JSON.parse(JSON.stringify(closed.state));
  const c = candidate(1, at(1000));
  assert.ok(openPaperPosition(restarted, c, quote(c), at(1000)).reasons.includes('duplicate_signal'));
});

test('unpriced existing positions block new entries; at most two positions', () => {
  const first = open();
  assert.ok(open(first.state, 2).reasons.includes('open_position_unpriced'));
  const marked = mark(first.state, 11_000_000);
  const second = open(marked.state, 2, 1000);
  assert.equal(second.decision, 'opened');
  assert.equal(second.state.cashUsdMicros, 79_600_000);
  assert.ok(open(second.state, 3, 1000).reasons.includes('maximum_positions'));
});

test('independent safety, provenance, chain, narrative, and zero tax are hard gates', () => {
  for (const key of ['sellSimulationPassed', 'contractControlsReviewed', 'lpLockOrBurnVerified',
    'holderDistributionReviewed', 'independentWalletClusterVerified']) {
    const c = candidate(); c.evidence[key] = 'true';
    assert.ok(evaluatePaperCandidate(c, at(0)).includes(`unverified_${key}`));
  }
  for (const field of ['buyTaxBps', 'sellTaxBps']) {
    const c = candidate(); c.evidence[field] = 1;
    assert.ok(evaluatePaperCandidate(c, at(0)).includes('zero_transfer_tax_not_verified'));
  }
  const c = candidate(); c.chainId = 8453; c.narrative.status = 'project_claim'; c.evidence.sourceUrls = [];
  assert.deepEqual(evaluatePaperCandidate(c, at(0)), ['unsupported_chain', 'unverified_narrative', 'missing_safety_provenance']);
});

test('stale/future signals and review evidence never open', () => {
  assert.ok(evaluatePaperCandidate(candidate(), at(300001)).includes('stale_signal'));
  assert.ok(evaluatePaperCandidate(candidate(), at(60001)).includes('missing_or_stale_safety_review'));
  assert.ok(evaluatePaperCandidate(candidate(1, at(1)), at(0)).includes('stale_signal'));
});

test('wrong CA, pool, side, provider, amount, canonical result or stale quote rejected', () => {
  const c = candidate(), s = createPaperAccount(at(0));
  for (const overrides of [{ ca: candidate(2).ca }, { poolAddress: candidate(2).poolAddress },
    { side: 'sell' }, { chainId: 8453 }, { providerId: 'untrusted' }, { canonicalVerified: false },
    { valueUsdMicros: '100000000' }, { quantityRaw: 'garbage' }, { valueUsdMicros: 'garbage' },
    { estimatedSlippageBps: 301 }, { blockTimestamp: 0 }, { validUntil: at(-1) }, { observedAt: at(1) }]) {
    assert.equal(openPaperPosition(s, c, quote(c, at(0), overrides), at(0)).decision, 'watch', JSON.stringify(overrides));
  }
});

test('mark computes net profit after costs and a price gap exits at actual observed quote', () => {
  const first = open();
  const closed = mark(first.state, 6_000_000);
  assert.equal(closed.decision, 'closed');
  assert.deepEqual(closed.reasons, ['stop_loss']);
  assert.equal(closed.state.closed[0].exitValueUsdMicros, 5_740_000);
  assert.equal(closed.state.closed[0].realizedPnlUsdMicros, -4_460_000);
  assert.equal(closed.state.cashUsdMicros, 95_540_000);
});

test('take-profit and time exits credit net proceeds exactly once', () => {
  const first = open();
  const profit = mark(first.state, 15_000_000);
  assert.deepEqual(profit.reasons, ['take_profit']);
  assert.equal(paperAccountSummary(profit.state, at(1000)).realizedPnlUsd, 4.45);
  const id = profit.state.closed[0].id;
  assert.equal(markPaperPosition(profit.state, id, null, at(2000)).decision, 'unpriced');
  const timed = mark(first.state, 11_000_000, 1_800_000);
  assert.deepEqual(timed.reasons, ['time_exit']);
});

test('missing exit quote does not invent a fill, zero value or stop-price realization', () => {
  const first = open(), held = mark(first.state, 11_000_000);
  const id = Object.keys(held.state.positions)[0];
  const failed = markPaperPosition(held.state, id, { status: 'unknown' }, at(2000));
  assert.equal(failed.decision, 'unpriced');
  assert.equal(failed.state.cashUsdMicros, 89_800_000);
  assert.equal(failed.state.closed.length, 0);
  assert.equal(paperAccountSummary(failed.state, at(2000)).estimatedLiquidationEquityUsd, null);
  assert.equal(paperAccountSummary(held.state, at(40000)).estimatedLiquidationEquityUsd, null);
});

test('loss limits persist across restart, do not reset cash, and cannot block exits', () => {
  let state = createPaperAccount(at(0));
  for (let i = 0; i < 2; i++) state = mark(open(state, i + 1, i * 2000).state, 6_000_000, i * 2000 + 1000).state;
  const restarted = JSON.parse(JSON.stringify(state));
  assert.ok(open(restarted, 3, 4000).reasons.includes('daily_loss_limit'));
  const nextDay = 86400000;
  const third = open(restarted, 3, nextDay);
  assert.equal(third.decision, 'opened');
  const thirdClosed = mark(third.state, 6_000_000, nextDay + 1000);
  assert.equal(thirdClosed.decision, 'closed');
  assert.ok(open(thirdClosed.state, 4, nextDay + 2000).reasons.includes('total_loss_limit'));
  assert.equal(thirdClosed.state.cashUsdMicros, 86_620_000);
});

test('tampered state, cash, policy, and duplicated closed order fail closed', () => {
  const first = open().state;
  for (const mutate of [s => { s.cashUsdMicros += 1; }, s => { s.policy.tradeUsdMicros = 100_000_000; },
    s => { s.mode = 'live'; }, s => { s.seenEventKeys = []; }, s => { s.updatedAt = 'bad'; }]) {
    const state = structuredClone(first); mutate(state);
    assert.throws(() => validatePaperAccount(state));
  }
  const closed = mark(first, 15_000_000).state;
  closed.closed.push(structuredClone(closed.closed[0]));
  assert.throws(() => validatePaperAccount(closed));
});

test('clock regression cannot backdate entries or exits', () => {
  const first = open(undefined, 1, 1000), id = Object.keys(first.state.positions)[0];
  assert.ok(open(first.state, 2, 500).reasons.includes('clock_regression'));
  assert.ok(markPaperPosition(first.state, id, null, at(500)).reasons.includes('clock_regression'));
  assert.throws(() => createPaperAccount('today'));
});

test('repeated marks never deduct repeated fees or realize unclosed profit', () => {
  const first = open();
  const one = mark(first.state, 11_000_000), two = mark(one.state, 11_000_000, 2000);
  assert.equal(two.state.cashUsdMicros, 89_800_000);
  assert.equal(paperAccountSummary(two.state, at(2000)).realizedPnlUsd, 0);
  assert.equal(PAPER_100_POLICY.maximumPositions, 2);
});

test('exit gas is paid from cash even when sale proceeds do not cover it', () => {
  const first = open();
  const low = mark(first.state, 100_000);
  assert.equal(low.decision, 'closed');
  assert.equal(low.state.closed[0].exitValueUsdMicros, -101_000);
  assert.equal(low.state.closed[0].realizedPnlUsdMicros, -10_301_000);
  assert.equal(low.state.cashUsdMicros, 89_699_000);
  assert.equal(validatePaperAccount(JSON.parse(JSON.stringify(low.state))), true);
  const dust = mark(first.state, 1);
  assert.equal(dust.state.closed[0].exitValueUsdMicros, -200_000);
  assert.equal(dust.state.cashUsdMicros, 89_600_000);
  assert.equal(dust.state.closed[0].realizedPnlUsdMicros, -10_400_000);
});

test('malformed candidate and quote shapes return watch or unpriced without crashing', () => {
  const first = open(), held = mark(first.state, 11_000_000), id = Object.keys(held.state.positions)[0];
  for (const bad of [42, {}, [], null, true]) {
    const c = candidate(2, at(2000)); c.ca = bad;
    assert.equal(openPaperPosition(held.state, c, null, at(2000)).decision, 'watch');
    for (const field of ['ca', 'poolAddress', 'blockHash', 'routeDigest', 'blockTimestamp', 'quantityRaw', 'valueUsdMicros']) {
      const q = quote(candidate(), at(2000), { kind: 'mark', side: 'sell', quantityRaw: first.state.positions[id].quantityRaw, [field]: bad });
      const result = markPaperPosition(held.state, id, q, at(2000));
      assert.equal(result.decision, 'unpriced', field);
      assert.equal(result.state.positions[id].mark, null);
      assert.deepEqual(result.state.positions[id].lastVerifiedQuote, held.state.positions[id].lastVerifiedQuote);
      assert.equal(result.state.cashUsdMicros, held.state.cashUsdMicros);
    }
  }
  const cycle = {}; cycle.self = cycle;
  for (const extra of [() => {}, 1n, cycle, new Date()]) {
    const c = { ...candidate(2, at(2000)), extra };
    assert.equal(openPaperPosition(held.state, c, null, at(2000)).decision, 'watch');
    const q = { ...quote(candidate(), at(2000)), extra };
    assert.equal(markPaperPosition(held.state, id, q, at(2000)).decision, 'unpriced');
  }
  const hidden = candidate(2, at(2000));
  Object.defineProperty(hidden, 'evidence', { value: hidden.evidence, enumerable: false });
  assert.equal(openPaperPosition(held.state, hidden, null, at(2000)).decision, 'watch');
  const extendedArray = []; extendedArray.extra = () => {};
  const extraQuote = { ...quote(candidate(), at(2000)), extra: extendedArray };
  assert.equal(markPaperPosition(held.state, id, extraQuote, at(2000)).decision, 'unpriced');
});

test('unknown or prototype position IDs cannot mutate shared prototypes', () => {
  const state = createPaperAccount(at(0)), before = Object.getOwnPropertyDescriptor(Object.prototype, 'mark');
  for (const id of ['__proto__', 'constructor', 'toString', {}, null, 'shadow:' + 'a'.repeat(64)]) {
    assert.deepEqual(markPaperPosition(state, id, null, at(0)).reasons, ['unknown_position']);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'mark'), before);
  for (const positions of [1, true, 'value', [], new Date(), Object.create({ inherited: {} })]) {
    assert.throws(() => validatePaperAccount({ ...state, positions }));
  }
});

test('state validation rederives mark and exit values rather than trusting matching cash arithmetic', () => {
  const first = open().state, held = mark(first, 11_000_000).state, id = Object.keys(held.positions)[0];
  for (const mutate of [
    s => { s.positions[id].mark.netValueUsdMicros += 1; },
    s => { s.positions[id].mark.observedAt = at(0); },
    s => { s.positions[id].mark.checkedAt = at(0); },
    s => { delete s.positions[id].lastVerifiedQuote; },
    s => { s.positions[id].lastVerifiedAt = at(2000); },
    s => { s.positions[id].entryQuote.valueUsdMicros = '1'; },
    s => { s.positions[id].entryQuote.canonicalVerified = false; },
    s => { s.positions[id].candidate.evidence.sellSimulationPassed = false; },
    s => { s.positions[id].entryGasUsdMicros = 0; },
    s => { s.positions[id].costUsdMicros -= 200_000; s.cashUsdMicros += 200_000; },
  ]) { const state = structuredClone(held); mutate(state); assert.throws(() => validatePaperAccount(state)); }
  const closed = mark(first, 15_000_000).state;
  for (const mutate of [
    s => { s.closed[0].exitValueUsdMicros = 1_000_000_000; s.closed[0].realizedPnlUsdMicros = 989_800_000; s.cashUsdMicros = 1_089_800_000; },
    s => { s.closed[0].exitReason = 'stop_loss'; },
    s => { s.closed[0].exitReason = 'manual'; },
    s => { s.closed[0].exitQuote.ca = candidate(9).ca; },
    s => { s.closed[0].exitQuote.valueUsdMicros = '16000000'; },
    s => { s.closed[0].closedAt = at(0); },
    s => { s.closed[0].mark = null; },
  ]) { const state = structuredClone(closed); mutate(state); assert.throws(() => validatePaperAccount(state)); }
});

test('quote block high-water mark rejects past blocks and conflicting same-height anchors', () => {
  const first = open().state, id = Object.keys(first.positions)[0], p = first.positions[id];
  const attempt = overrides => markPaperPosition(first, id, quote(p.candidate, at(1000), {
    kind: 'mark', side: 'sell', quantityRaw: p.quantityRaw, valueUsdMicros: '20000000', ...overrides }), at(1000));
  assert.ok(attempt({ blockNumber: p.entryQuote.blockNumber - 1 }).reasons.includes('quote_regression'));
  assert.ok(attempt({ blockNumber: p.entryQuote.blockNumber, blockTimestamp: p.entryQuote.blockTimestamp,
    blockHash: '0x' + 'f'.repeat(64) }).reasons.includes('quote_block_conflict'));
  assert.ok(attempt({ blockNumber: p.entryQuote.blockNumber, blockHash: p.entryQuote.blockHash }).reasons.includes('quote_block_conflict'));
  const sameBlock = attempt({ blockNumber: p.entryQuote.blockNumber, blockTimestamp: p.entryQuote.blockTimestamp,
    blockHash: p.entryQuote.blockHash });
  assert.equal(sameBlock.decision, 'closed');
});

test('failed refresh and restart retain block high-water mark against later stale profit', () => {
  const first = open().state, held = mark(first, 11_000_000, 5000).state, id = Object.keys(held.positions)[0];
  const previous = structuredClone(held.positions[id].lastVerifiedQuote);
  const failed = markPaperPosition(held, id, null, at(6000)).state;
  assert.equal(failed.positions[id].mark, null);
  assert.deepEqual(failed.positions[id].lastVerifiedQuote, previous);
  const restarted = JSON.parse(JSON.stringify(failed)), p = restarted.positions[id];
  const older = quote(p.candidate, at(7000), { kind: 'mark', side: 'sell', quantityRaw: p.quantityRaw,
    valueUsdMicros: '20000000', blockNumber: previous.blockNumber - 1 });
  const denied = markPaperPosition(restarted, id, older, at(7000));
  assert.ok(denied.reasons.includes('quote_regression'));
  assert.equal(denied.state.closed.length, 0); assert.equal(denied.state.cashUsdMicros, first.cashUsdMicros);
  assert.deepEqual(denied.state.positions[id].lastVerifiedQuote, previous);
  assert.equal(mark(denied.state, 11_000_000, 8000).decision, 'held');
});

test('persisted entry and exit timestamps must match their original quote review windows', () => {
  const first = open().state, id = Object.keys(first.positions)[0];
  for (const mutate of [
    s => { s.createdAt = at(1); },
    s => { s.positions[id].openedAt = at(-1); },
    s => { s.positions[id].entryQuote.observedAt = at(-5001); s.positions[id].lastVerifiedQuote.observedAt = at(-5001); },
    s => { s.positions[id].candidate.evidence.observedAt = at(-60001); },
  ]) { const state = structuredClone(first); mutate(state); assert.throws(() => validatePaperAccount(state)); }
  assert.throws(() => paperAccountSummary(mark(first, 15_000_000).state, at(0)), /clock regression/);
});

test('a second extreme quote cannot overflow the safe cash ledger', () => {
  const rich = mark(open().state, Number.MAX_SAFE_INTEGER).state;
  const second = open(rich, 2, 2000);
  assert.equal(second.decision, 'opened');
  const rejected = mark(second.state, Number.MAX_SAFE_INTEGER, 3000);
  assert.equal(rejected.decision, 'unpriced');
  assert.ok(rejected.reasons.includes('unsafe_account_amount'));
  assert.equal(rejected.state.cashUsdMicros, second.state.cashUsdMicros);
  assert.equal(validatePaperAccount(rejected.state), true);
});
