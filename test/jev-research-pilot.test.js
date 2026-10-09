import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJevResearchPilot, createJevResearchMonitor, JEV_PILOT_FILE, jevResearchKey } from '../src/jev-research-pilot.js';
import { buildJevShadowInput, probeJevShadow, JEV_QUESTIONS } from '../src/jev-shadow-decision.js';
const NOW = Date.parse('2026-09-28T06:30:00Z'), CA = `0x${'a'.repeat(40)}`, sessionId = 'fixture-paper';
function row(id = 1) {
  const at = new Date(NOW - 1000).toISOString(), url = `https://x.com/fixture/status/${id}`;
  return { token: { chain: 'bsc', address: CA, symbol: 'FIXTURE', price: 1 }, decision: '观察',
    account: { privateKey: 'SECRET_NOT_FOR_MODEL' }, evidence: {
      priceObservedAt: at, safety: { blocked: [], missing: [], auditMissing: [], metrics: { buyTax: 0, sellTax: 0 } },
      narrativeThesis: { chain: 'bsc', address: CA, relationship: { kind: 'direct_ca' },
        event: { sourceAt: at, sourceUrl: url }, sources: [{ at, url, text: `Token ${CA} announcement ${id}` }] }
    } };
}
function answer(choices = {}) {
  const chosen = { relationship: 'explicit', event_status: 'claimed_completed', demand_path: 'token_mechanism', ...choices };
  return { status: 'evaluated', model: 'jev-1.13.0', measuredLatencyMs: 200, usage: { input_tokens: 100, output_tokens: 30 },
    answers: Object.fromEntries(Object.entries(JEV_QUESTIONS).map(([k, q]) => [k, {
      type: 'choice', choice: chosen[k], confidence: .94,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(c => [c, c === chosen[k] ? .94 : .02])) }])) };
}
async function setup(t, overrides = {}, activate = true) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-pilot-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  if (activate) await createJevResearchPilot({ dataDir, sessionId, nowMs: NOW });
  let time = NOW, calls = 0;
  const options = { dataDir, sessionId, now: () => time, keyReader: async () => 'TEST_ONLY',
    probe: async () => { calls++; return answer(); }, ...overrides };
  const monitor = createJevResearchMonitor(options); t.after(() => monitor.stop()); await monitor.start();
  return { dataDir, options, monitor, calls: () => calls, advance: n => { time += n; } };
}
test('optional, absent pilot is disabled; activation never renews an existing budget', async t => {
  const s = await setup(t, {}, false); s.monitor.observe([row()]); await s.monitor.drain();
  assert.equal(s.monitor.snapshot().status, 'disabled'); assert.equal(s.calls(), 0);
  await createJevResearchPilot({ dataDir: s.dataDir, sessionId, nowMs: NOW });
  await assert.rejects(createJevResearchPilot({ dataDir: s.dataDir, sessionId, nowMs: NOW }), { code: 'EEXIST' });
});
test('stable dedup ignores quotes, age, casing and URL query; source or exact SOL CA changes do not collide', () => {
  const a = row(), b = row(); b.token.price = 2; b.token.address = CA.toUpperCase().replace('0X', '0x');
  b.evidence.narrativeThesis.event.sourceUrl += '?s=20'; b.evidence.narrativeThesis.sources[0].url += '?s=20';
  assert.equal(jevResearchKey(buildJevShadowInput(a, NOW)), jevResearchKey(buildJevShadowInput(b, NOW + 1000)));
  b.evidence.narrativeThesis.sources[0].text += ' changed';
  assert.notEqual(jevResearchKey(buildJevShadowInput(a, NOW)), jevResearchKey(buildJevShadowInput(b, NOW)));
  const sol = buildJevShadowInput(a, NOW); sol.state.candidate = { chain: 'sol', address: 'AbC', symbol: 'F' };
  const copy = structuredClone(sol); copy.state.candidate.address = 'abc';
  assert.notEqual(jevResearchKey(sol), jevResearchKey(copy));
});
test('one in flight, persisted reservation precedes API, no secret/full row stored, rate limited and dedup survives restart', async t => {
  let release, actual = 0, s;
  s = await setup(t, { probe: async () => {
    actual++;
    const saved = JSON.parse(await fs.readFile(path.join(s.dataDir, JEV_PILOT_FILE), 'utf8'));
    assert.equal(saved.records.length, 1); assert.equal(saved.records[0].result, null);
    return new Promise(resolve => { release = () => resolve(answer()); });
  } });
  const r = row(), before = structuredClone(r);
  s.monitor.observe([r, r]);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  s.monitor.observe([row(2)]); assert.equal(actual, 1); assert.equal(s.monitor.snapshot().status, 'in_flight');
  release(); await s.monitor.drain(); s.monitor.observe([row(2)]); assert.equal(actual, 1);
  assert.deepEqual(r, before); assert.equal(s.monitor.hint(r).adjustment, 20);
  assert.equal(s.monitor.snapshot().canExecute, false);
  const raw = await fs.readFile(path.join(s.dataDir, JEV_PILOT_FILE), 'utf8');
  assert.doesNotMatch(raw, /SECRET_NOT_FOR_MODEL|TEST_ONLY|privateKey/);
  assert.equal((await fs.stat(path.join(s.dataDir, JEV_PILOT_FILE))).mode & 0o777, 0o600);
  await s.monitor.stop(); s.advance(10000);
  const resumed = createJevResearchMonitor(s.options); t.after(() => resumed.stop()); await resumed.start();
  resumed.observe([r]); await resumed.drain(); assert.equal(actual, 1); assert.equal(resumed.snapshot().reservedCalls, 1);
});
test('30 reservations is a hard cap; restart does not refill quota', async t => {
  const s = await setup(t);
  for (let i = 0; i < 35; i++) { s.monitor.observe([row(i)]); await s.monitor.drain(); s.advance(10000); }
  assert.equal(s.calls(), 30); assert.equal(s.monitor.snapshot().status, 'budget_exhausted');
  await s.monitor.stop(); const next = createJevResearchMonitor(s.options); t.after(() => next.stop()); await next.start();
  next.observe([row(100)]); await next.drain(); assert.equal(s.calls(), 30);
});
test('one-hour deadline and source freshness stop requests; expired hints do not reorder research', async t => {
  const s = await setup(t); s.monitor.observe([row()]); await s.monitor.drain();
  assert.equal(s.monitor.hint(row()).adjustment, 20);
  s.advance(900001); assert.equal(s.monitor.hint(row()).adjustment, 0);
  s.advance(2700000); s.monitor.observe([row(2)]); await s.monitor.drain();
  assert.equal(s.calls(), 1); assert.equal(s.monitor.snapshot().status, 'expired');
});
test('overnight pilot keeps the same hard call cap with an eight-hour expiry', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-overnight-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const state = await createJevResearchPilot({ dataDir, sessionId, nowMs: NOW, durationMs: 8 * 3600000 });
  assert.equal(state.durationMs, 8 * 3600000);
  const monitor = createJevResearchMonitor({ dataDir, sessionId, now: () => NOW, keyReader: async () => 'TEST_ONLY' });
  t.after(() => monitor.stop()); await monitor.start();
  assert.equal(monitor.snapshot().durationMs, 8 * 3600000);
  assert.equal(monitor.snapshot().maxCalls, 30);
});
test('missing sources, blocked tokens, invalid identities, future and expired sources never incur a call', async t => {
  const s = await setup(t);
  for (const mutate of [r => r.evidence.narrativeThesis.sources = [], r => r.token.address = 'wrong',
    r => r.evidence.safety.blocked = ['risk'], r => r.evidence.safety.metrics.sellTax = .061,
    r => { const n = r.evidence.narrativeThesis; n.event.sourceAt = n.sources[0].at = new Date(NOW + 3600001).toISOString(); },
    r => { const n = r.evidence.narrativeThesis; n.event.sourceAt = n.sources[0].at = new Date(NOW - 3600001).toISOString(); }]) {
    const r = row(); mutate(r); s.monitor.observe([r]); await s.monitor.drain(); s.advance(5000);
  }
  assert.equal(s.calls(), 0); assert.equal(s.monitor.snapshot().reservedCalls, 0);
});
test('same-name explicit response cannot promote CA; stale quote does not prevent research; no trade authorization', async t => {
  const s = await setup(t), r = row(); r.evidence.priceObservedAt = new Date(NOW - 60000).toISOString();
  r.evidence.narrativeThesis.relationship.kind = 'name_only'; s.monitor.observe([r]); await s.monitor.drain();
  assert.equal(s.calls(), 1); assert.equal(s.monitor.hint(r).adjustment, 0); assert.equal(s.monitor.hint(r).canExecute, false);
  r.evidence.narrativeThesis.relationship.kind = 'direct_ca'; assert.equal(s.monitor.hint(r).adjustment, 20);
  r.evidence.safety.metrics.sellTax = .07; assert.equal(s.monitor.hint(r).adjustment, 0);
});
test('negative semantic hint is bound to exact source and CA; uncertain answers do not invent confidence', async t => {
  const s = await setup(t, { probe: async () => answer({ relationship: 'unrelated' }) });
  s.monitor.observe([row()]); await s.monitor.drain(); assert.equal(s.monitor.hint(row()).adjustment, -20);
  assert.equal(s.monitor.hint(row(2)).adjustment, 0);
  const r = row(); r.token.address = `0x${'b'.repeat(40)}`; assert.equal(s.monitor.hint(r).adjustment, 0);
});
test('provider failure halts only this pilot, is sanitized, and is not retried after restart', async t => {
  let calls = 0;
  const s = await setup(t, { probe: async () => { calls++; throw Error('SECRET_PROVIDER_BODY'); } });
  s.monitor.observe([row()]); await s.monitor.drain(); s.advance(10000); s.monitor.observe([row(2)]);
  await s.monitor.drain(); assert.equal(calls, 1); assert.equal(s.monitor.snapshot().status, 'request_failed');
  assert.doesNotMatch(JSON.stringify(s.monitor.snapshot()), /SECRET_PROVIDER_BODY/);
  await s.monitor.stop(); const next = createJevResearchMonitor(s.options); t.after(() => next.stop()); await next.start();
  next.observe([row(2)]); await next.drain(); assert.equal(calls, 1); assert.equal(next.snapshot().status, 'interrupted_or_failed');
});
test('missing key and failed reservation persistence make zero billable calls', async t => {
  for (const overrides of [{ keyReader: async () => null }, { persist: async () => { throw Error('disk'); } }]) {
    const s = await setup(t, overrides); s.monitor.observe([row()]); await s.monitor.drain();
    assert.equal(s.calls(), 0); assert.ok(['missing_key', 'persistence_error'].includes(s.monitor.snapshot().status));
  }
});
test('second writer, interrupted request, wrong session and invalid caps fail closed without reset', async t => {
  const s = await setup(t); const second = createJevResearchMonitor(s.options); t.after(() => second.stop()); await second.start();
  assert.equal(second.snapshot().status, 'locked'); await s.monitor.stop();
  const file = path.join(s.dataDir, JEV_PILOT_FILE), original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const mutate of [x => x.maxCalls = 999, x => x.sessionId = 'another-paper', x => x.records = [{ key: 'bad' }]]) {
    const v = structuredClone(original); mutate(v); await fs.writeFile(file, JSON.stringify(v));
    const m = createJevResearchMonitor(s.options); await m.start(); assert.equal(m.snapshot().status, 'invalid_pilot'); await m.stop();
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), v);
  }
});
test('actual adapter output persists and is usable after restart (offline HTTP fixture)',async t=>{
  let calls=0;
  const s=await setup(t,{probe:(r,opts)=>probeJevShadow(r,{...opts,fetchImpl:async()=>{calls++;return Response.json(answer());}})});
  s.monitor.observe([row()]);await s.monitor.drain();assert.equal(s.monitor.snapshot().evaluated,1);
  await s.monitor.stop();s.advance(10000);
  const resumed=createJevResearchMonitor(s.options);t.after(()=>resumed.stop());await resumed.start();
  assert.equal(resumed.hint(row()).adjustment,20);resumed.observe([row()]);await resumed.drain();assert.equal(calls,1);
});
test('interrupted reservation and corrupt result never retry or silently refill quota',async t=>{
  const s=await setup(t);s.monitor.observe([row()]);await s.monitor.drain();await s.monitor.stop();
  const file=path.join(s.dataDir,JEV_PILOT_FILE),saved=JSON.parse(await fs.readFile(file,'utf8'));
  for(const pending of [true,false]){
    const state=structuredClone(saved);
    if(pending)state.records[0].result=null;else state.records[0].result.answers.relationship.confidence=2;
    await fs.writeFile(file,JSON.stringify(state));
    const resumed=createJevResearchMonitor(s.options);await resumed.start();
    assert.equal(resumed.snapshot().status,pending?'interrupted_or_failed':'invalid_pilot');
    resumed.observe([row(2)]);await resumed.drain();await resumed.stop();assert.equal(s.calls(),1);
  }
});
test('a pending key read cannot cause a request after stop or expiry',async t=>{
  for(const stop of [true,false]){
    let unlock;const s=await setup(t,{keyReader:()=>new Promise(resolve=>{unlock=()=>resolve('TEST_ONLY');})});
    s.monitor.observe([row()]);const stopping=stop?s.monitor.stop():null;
    if(!stop)s.advance(3600001);unlock();await (stopping||s.monitor.drain());assert.equal(s.calls(),0);
  }
});
