import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicSnapshot } from '../src/public-dashboard-state.js';
import { publicApi } from '../src/public-dashboard-api.js';
import { buildPublicDashboard } from '../scripts/build-public-dashboard.js';
import { publishSnapshot } from '../scripts/publish-public-dashboard.js';
import { publisherPlist } from '../scripts/install-public-publisher.js';

const now = Date.now(), flags = { mode: 'paper', execution: false, signing: false, broadcast: false };
const sample = () => ({ ...flags, status: 'ok', enabled: true, updatedAt: new Date(now).toISOString(), apiKey: 'PRIVATE_SENTINEL',
  account: { ...flags, cash: 42, realizedPnl: -8, stats: { equity: 42 }, privateKey: 'PRIVATE_SENTINEL',
    positions: {}, trades: [{ symbol: 'TEST', side: 'sell', atMs: now, costsUsd: 0.2, reason: '结构失效', secret: 'PRIVATE_SENTINEL' }],
    cashAdjustments: [{ amountUsd: 10, privateKey: 'PRIVATE_SENTINEL' }] },
  evaluations: [{ token: { chain: 'sol', address: 'contract', symbol: 'TEST', secret: 'PRIVATE_SENTINEL' },
    evidence: { narrativeThesis: { event: { sourceUrl: 'https://x.com/public/status/123?token=PRIVATE_SENTINEL' } }, raw: 'PRIVATE_SENTINEL' } }],
  lastError: 'PRIVATE_SENTINEL', learning: { wallets: ['PRIVATE_SENTINEL'], walletCount: 12 },
});
test('public allowlist publishes consented paper balances/trades but no secrets, raw payloads or URLs with query credentials', () => {
  const result = createPublicSnapshot(sample(), now);
  assert.equal(result.account.cash, 42); assert.equal(result.account.trades[0].symbol, 'TEST');
  assert.equal(result.publicSummary.fundingAdjustmentsUsd, 10);
  assert.equal(result.publicSummary.totalCostsUsd, 0.2);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  assert.deepEqual(createPublicSnapshot(result, now), result);
});
test('runtime timing publishes only aggregate counters, never reader payloads or errors', () => {
  const state = sample(); state.cadence = { runtimePathVersion: 'paper_execution_slim_v1', fullCycleMs: 200,
    phaseTiming: { newsWireMs: 15, narrativeRecallMs: 5, narrativeLearningMs: 10, casebookMs: 0, ledgerWriteMs: 20, raw: 'PRIVATE_SENTINEL' },
    researchReads: { version: 'concurrent_reads_only_v1', reads: 3, joinedReads: 2, inFlight: false,
      lastRead: { durationMs: 5, evidenceMs: 5, learningMs: 1, evidenceFailed: false, learningFailed: false, raw: 'PRIVATE_SENTINEL' },
      payload: 'PRIVATE_SENTINEL' } };
  const published = createPublicSnapshot(state, now);
  assert.equal(published.cadence.researchReads.joinedReads, 2);
  assert.equal(published.cadence.phaseTiming.ledgerWriteMs, 20);
  assert.equal(published.cadence.phaseTiming.newsWireMs, 15);
  assert.equal(published.cadence.phaseTiming.narrativeRecallMs, 5);
  assert.equal(published.cadence.fullCycleMs, 200);
  assert.equal(JSON.stringify(published).includes('PRIVATE_SENTINEL'), false);
});
test('live/ambiguous account is never publishable and source time is not rewritten', () => {
  const value = sample(); value.account.signing = true;
  assert.throws(() => createPublicSnapshot(value, now));
  const missing = sample(); delete missing.execution;
  assert.throws(() => createPublicSnapshot(missing, now));
  const result = createPublicSnapshot(sample(), now + 100000);
  assert.equal(result.updatedAt, sample().updatedAt);
});
test('public entry diagnostics retain only aggregate states and remain idempotent',()=>{
  const value=sample();value.researchPipeline={entryDiagnostics:{version:'paper_entry_diagnostics_v1',detected:10,
    verifiedCatalyst:0,quoteResearchReady:0,quoteScheduled:0,eligible:0,note:'仅当前候选，不代表全市场',
    apiKey:'PRIVATE_SENTINEL',blockers:[{code:'catalyst',label:'缺原文',count:10,raw:'PRIVATE_SENTINEL'}]}};
  const result=createPublicSnapshot(value,now);
  assert.equal(result.researchPipeline.entryDiagnostics.blockers[0].count,10);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'),false);
  assert.deepEqual(createPublicSnapshot(result,now),result);
});
test('public fair-research counters expose no retry payloads or private data',()=>{
  const s=sample();s.researchPipeline={focusedReadBudget:{version:'fair_chart_detail_turn_v2',exploratoryConcurrency:1,
    chartTurnReserved:true,chartTurnDeferrals:4,detailBackoffCandidates:3,raw:'PRIVATE_SENTINEL'}};
  const r=createPublicSnapshot(s,now);assert.equal(r.researchPipeline.focusedReadBudget.chartTurnReserved,true);
  assert.equal(r.researchPipeline.focusedReadBudget.detailBackoffCandidates,3);
  assert.equal(JSON.stringify(r).includes('PRIVATE_SENTINEL'),false);assert.deepEqual(createPublicSnapshot(r,now),r);
});
test('algorithm signal publication includes reasons and measured latency, never raw profiles or proof payloads',()=>{
  const s=sample();s.algorithmSignals={version:'bsc_collective_profit_v1',enabled:true,sourceStatus:'covered',retained:1,filled:0,
    proof:'PRIVATE_SENTINEL',records:[{id:'public-id',source:'collective_smart_money',decision:'观察',missing:['可卖出检测'],
      firstDetectedAt:new Date(now).toISOString(),detectionToFillMs:null,profiles:'PRIVATE_SENTINEL'}]};
  const r=createPublicSnapshot(s,now);assert.equal(r.algorithmSignals.records[0].decision,'观察');
  assert.equal(JSON.stringify(r).includes('PRIVATE_SENTINEL'),false);assert.deepEqual(createPublicSnapshot(r,now),r);
});
test('public funding and round risk remain auditable after projection and repeated publication',()=>{
  const value=sample();
  value.account.cashAdjustments=[{amountUsd:99,at:new Date(now).toISOString(),cashBefore:1,cashAfter:100,tradeCount:204}];
  value.lossGuards={enforced:true,capitalUsd:100,realizedPnlUsd:0,lossLimitUsd:10,triggered:false,fundingId:'funding_test',privateKey:'PRIVATE_SENTINEL'};
  const result=createPublicSnapshot(value,now);
  assert.equal(result.account.cashAdjustments[0].cashAfter,100);
  assert.equal(result.lossGuards.realizedPnlUsd,0);assert.equal(result.account.realizedPnl,-8);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'),false);
  assert.deepEqual(createPublicSnapshot(result,now),result);
});
test('three-list source summary is public and idempotent without exposing raw provider data',()=>{
  const s=sample();s.discoveryScope={version:'gmgn_three_lists_v1',uniqueCandidates:3,refreshTargetMs:15000,
    otherSources:'context_only',holdings:'exit_management_unchanged',raw:'PRIVATE_SENTINEL',
    feeds:[{chain:'bsc',list:'ranking_5m',label:'热门·5分钟',status:'ok',observedAt:new Date(now).toISOString(),count:3,raw:'PRIVATE_SENTINEL'}]};
  const result=createPublicSnapshot(s,now);
  assert.equal(result.discoveryScope.feeds[0].count,3);assert.equal(result.discoveryScope.refreshTargetMs,15000);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'),false);
  assert.deepEqual(createPublicSnapshot(result,now),result);
});
test('bounded history keeps true totals and validates numbers', () => {
  const value = sample(); value.account.trades = Array.from({ length: 600 }, (_, i) => ({ id: String(i), costsUsd: 0.1 }));
  const result = createPublicSnapshot(value, now);
  assert.equal(result.account.trades.length, 500); assert.equal(result.account.trades[0].id, '100');
  assert.equal(createPublicSnapshot(result, now).publicSummary.totalTrades, 600);
});
test('receiver auth, read-only routes, content limit, stale rejection and round trip', async () => {
  let stored; const secret = 'x'.repeat(48);
  const handler = publicApi({ secret, now: () => now, store: { get: async () => stored, setJSON: async (_, value) => { stored = value; } } });
  const request = (pathname, options) => handler(new Request(`https://test.netlify.app${pathname}`, options));
  assert.equal((await request('/api/strategy-state')).status, 503);
  assert.equal((await request('/api/publish-state', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await request('/api/strategy-control', { method: 'POST' })).status, 404);
  const post = value => request('/api/publish-state', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post({ ...sample(), updatedAt: new Date(now - 180000).toISOString() })).status, 409);
  assert.equal((await post({ ...sample(), execution: true })).status, 400);
  assert.equal((await post({ ...sample(), lastError: 'x'.repeat(2_000_001) })).status, 413);
  assert.equal((await post(sample())).status, 200);
  const result = await request('/api/strategy-state');
  assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal((await result.json()).account.cash, 42);
});
test('public build contains only allowlisted static assets and no local controls', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-public-test-'));
  try {
    assert.equal(await buildPublicDashboard(dir), 12);
    assert.match(await fs.readFile(path.join(dir, 'entry-status.js'), 'utf8'), /export function entryStatus/);
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /square-settings|paper-diagnostic|focusAutoToggle/);
    const js = await fs.readFile(path.join(dir, 'app.js'), 'utf8');
    assert.doesNotMatch(js, /strategy-control|square-key|127\.0\.0\.1/);
    await fs.writeFile(path.join(dir, '.env'), 'sentinel');
    await assert.rejects(buildPublicDashboard(dir), /Unexpected public output/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('publisher only uploads projected state to a fixed receiver and never follows redirects', async () => {
  const requests = [];
  await publishSnapshot({ url: 'https://yesp-atm.netlify.app', token: 'x'.repeat(48) }, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(requests.length === 1 ? sample() : { ok: true }));
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://yesp-atm.netlify.app/api/publish-state');
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(requests[1].options.body.includes('PRIVATE_SENTINEL'), false);
  await assert.rejects(publishSnapshot({ url: 'http://example.com', token: 'x'.repeat(48) }));
});

test('publisher launch agent is isolated, escapes paths and contains no credentials', () => {
  const xml = publisherPlist('/Users/example/Research & Reports', '/opt/homebrew/bin/node');
  assert.match(xml, /Research &amp; Reports/);
  assert.match(xml, /scripts\/publish-public-dashboard\.js/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(xml, /TOKEN|secret|dashboard-server|gmgn|strategy-control/);
});
