import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJevShadowInput, probeJevShadow, validateJevAnswer, JEV_QUESTIONS, JEV_ENDPOINT } from '../src/jev-shadow-decision.js';

// Offline fixtures only. No API key, network, wallet or runtime ledger.
const NOW = Date.parse('2026-09-28T05:00:00Z'), CA = `0x${'a'.repeat(40)}`, at = new Date(NOW - 1000).toISOString();
function row() {
  const url = 'https://x.com/example/status/123?s=20';
  return { token: { chain: 'bsc', address: CA, symbol: 'FIXTURE', price: 1 }, decision: '观察',
    account: { cash: 123456, wallet: 'PRIVATE_WALLET', apiKey: 'PRIVATE_KEY' },
    evidence: { priceObservedAt: at, liquidity: 50000, flowFresh: true,
      flowDiagnostics: { observedAt: at, complete: true, sourceStatus: 'healthy', wallet: 'PRIVATE_FLOW_WALLET' },
      flow: { netBuyUsd: 1000, smartMoneyCount: 2 },
      safety: { blocked: [], missing: [], auditMissing: [], metrics: { buyTax: 0, sellTax: 0 } },
      narrativeThesis: { chain: 'bsc', address: CA, relationship: { kind: 'direct_ca' },
        event: { sourceUrl: url, sourceAt: at }, sources: [{ url, at, text: `Example claimed to launch token ${CA}.`, binding: 'direct_ca' }] } } };
}
function payload() {
  const selected = { relationship: 'explicit', event_status: 'claimed_completed', demand_path: 'token_mechanism' };
  return { model: 'jev-1.13.0', usage: { input_tokens: 300, output_tokens: 60 },
    answers: Object.fromEntries(Object.entries(JEV_QUESTIONS).map(([id, q]) => [id, {
      type: 'choice', choice: selected[id], confidence: .9,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === selected[id] ? .94 : .02]))
    }])) };
}
const okFetch = async () => Response.json(payload());
const options = { apiKey: 'TEST_ONLY', nowMs: NOW, fetchImpl: okFetch };

test('public allowlist omits account, wallet, secrets, local verdict and URL query; does not mutate input', () => {
  const r = row(), before = structuredClone(r), input = buildJevShadowInput(r, NOW), json = JSON.stringify(input.state);
  assert.equal(input.localChecks.sourceFresh, true);
  assert.equal(input.state.source.url, 'https://x.com/example/status/123');
  assert.doesNotMatch(json, /PRIVATE_|123456|s=20|观察/);
  assert.deepEqual(r, before); assert.equal(input.fingerprint.length, 64);
});

test('source requires same CA, exact source record and nonfuture timestamp', () => {
  for (const mutate of [r => r.evidence.narrativeThesis.address = `0x${'b'.repeat(40)}`,
    r => r.evidence.narrativeThesis.sources = [],
    r => { const n = r.evidence.narrativeThesis; n.event.sourceAt = n.sources[0].at = new Date(NOW + 1).toISOString(); },
    r => { const n = r.evidence.narrativeThesis; n.event.sourceUrl = n.sources[0].url = 'https://127.0.0.1/secret'; }]) {
    const r = row(); mutate(r); const i = buildJevShadowInput(r, NOW);
    assert.equal(i.localChecks.sourceAvailable, false); assert.equal(i.state.source, null);
  }
});

test('missing key / missing public source never call external API', async () => {
  let calls = 0; const fetchImpl = () => { calls++; throw Error('unexpected'); };
  assert.equal((await probeJevShadow(row(), { nowMs: NOW, fetchImpl })).status, 'missing_key');
  const r = row(); r.evidence.narrativeThesis.sources = [];
  assert.equal((await probeJevShadow(r, { ...options, fetchImpl })).status, 'insufficient_source');
  assert.equal(calls, 0);
});

test('official typed request is one call, no redirects; successful result cannot execute trades', async () => {
  let calls = 0;
  const result = await probeJevShadow(row(), { ...options, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, JEV_ENDPOINT); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer TEST_ONLY');
    const body = JSON.parse(init.body); assert.equal(body.model, 'jev-latest'); assert.deepEqual(body.questions, JEV_QUESTIONS);
    assert.doesNotMatch(init.body, /PRIVATE_KEY|PRIVATE_WALLET/); return Response.json(payload());
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'evaluated'); assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.comparison.researchPriority, '优先复核'); assert.equal(result.comparison.canExecute, false);
  assert.equal(result.execution, false); assert.equal(result.signing, false); assert.equal(result.broadcast, false);
  assert.ok(result.measuredLatencyMs >= 0); assert.equal(result.localChecks.originalDecision, '观察');
});

test('high model confidence does not overcome stale quote/source, unverified CA or missing safety', async () => {
  for (const mutate of [r => r.evidence.priceObservedAt = new Date(NOW - 15001).toISOString(),
    r => { const n = r.evidence.narrativeThesis; n.event.sourceAt = n.sources[0].at = new Date(NOW - 3600001).toISOString(); },
    r => r.evidence.narrativeThesis.relationship.kind = 'name_only',
    r => delete r.evidence.safety, r => delete r.evidence.safety.metrics.buyTax]) {
    const r = row(); mutate(r); const result = await probeJevShadow(r, options);
    assert.equal(result.status, 'evaluated'); assert.equal(result.comparison.researchPriority, '继续观察');
    assert.equal(result.comparison.canExecute, false); assert.ok(result.comparison.reasons.length);
  }
});

test('explicit risk and >6% tax stay excluded even with favorable model answers', async () => {
  for (const mutate of [r => r.evidence.safety.blocked.push('存在貔貅标记'), r => r.evidence.safety.metrics.sellTax = .061]) {
    const r = row(); mutate(r); const result = await probeJevShadow(r, options);
    assert.equal(result.comparison.researchPriority, '排除候选，待核实'); assert.equal(result.comparison.canExecute, false);
  }
});

test('low confidence remains observation; denial becomes exclusion, without invented reasoning', async () => {
  for (const denied of [false, true]) {
    const p = payload();
    if (denied) { const a = p.answers.event_status; a.choice = 'denied'; a.probabilities.claimed_completed = .02; a.probabilities.denied = .94; }
    else p.answers.relationship.confidence = .2;
    const result = await probeJevShadow(row(), { ...options, fetchImpl: async () => Response.json(p) });
    assert.equal(result.comparison.researchPriority, denied ? '排除候选，待核实' : '继续观察');
  }
});

test('response validates required questions, ranges, sums, winning option, usage and model', () => {
  assert.equal(validateJevAnswer(payload()).model, 'jev-1.13.0');
  assert.deepEqual(validateJevAnswer(validateJevAnswer(payload())), validateJevAnswer(payload()), 'stored typed answers survive validation on restart');
  for (const mutate of [p => delete p.answers.relationship, p => p.answers.relationship.choice = 'buy_now',
    p => p.answers.relationship.confidence = 1.1, p => p.answers.relationship.probabilities.explicit = .2,
    p => p.answers.relationship.choice = 'unknown', p => p.usage.input_tokens = -1, p => p.model = 'substitute-model',
    p => p.answers.relationship.probabilities.extra = 0]) {
    const p = payload(); mutate(p); assert.throws(() => validateJevAnswer(p), /invalid_response/);
  }
});

test('HTTP failures do not leak body or retry; no model result is fabricated', async () => {
  for (const status of [401, 403, 429, 529]) {
    let calls = 0;
    const result = await probeJevShadow(row(), { ...options, fetchImpl: async () => {
      calls++; return new Response('SECRET_BODY', { status });
    } });
    assert.equal(calls, 1); assert.equal(result.status, `http_${status}`); assert.equal(result.answers, null);
    assert.equal(result.model, null); assert.equal(result.measuredLatencyMs, null); assert.doesNotMatch(JSON.stringify(result), /SECRET_BODY/);
  }
});

test('malformed or oversized output is unavailable, never interpreted as hold/buy', async () => {
  for (const response of [new Response('not json'), Response.json({}), new Response('x'.repeat(65537))]) {
    const r = await probeJevShadow(row(), { ...options, fetchImpl: async () => response });
    assert.equal(r.status, 'invalid_response'); assert.equal(r.answers, null); assert.equal(r.comparison, undefined);
  }
});

test('timeout covers stalled fetch and stalled response body; never retries or changes rules', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const r = await probeJevShadow(row(), { ...options, fetchImpl, timeoutMs: 10 });
    assert.equal(r.status, 'timeout'); assert.equal(r.answers, null); assert.equal(r.comparison, undefined);
  }
});

test('network exception is sanitized and candidate identities are strict', async () => {
  const r = await probeJevShadow(row(), { ...options, fetchImpl: async () => { throw Error('TEST_ONLY PRIVATE_KEY'); } });
  assert.equal(r.status, 'request_failed'); assert.doesNotMatch(JSON.stringify(r), /TEST_ONLY|PRIVATE_KEY/);
  const bad = row(); bad.token.address = 'not-a-ca'; assert.throws(() => buildJevShadowInput(bad), /invalid_candidate/);
});
