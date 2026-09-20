import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchTeamReport, renderResearchTeamBrief, RESEARCH_TEAM_DEPARTMENTS } from '../src/ai-research-team.js';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const TOKEN = {
  chain: 'bsc', address: '0x1111111111111111111111111111111111111111', symbol: 'ALPHA', price: 1,
  change: 12, liquidity: 100_000, volume: 150_000, holders: 1_000, smartDegenCount: 5,
  renownedCount: 2, rugRatio: .05, isHoneypot: false, isWashTrading: false, buyTax: .01,
  sellTax: .01, creatorClose: true, isOpenSource: true, isRenounced: true, top10HolderRate: .3,
  buys: 100, sells: 50,
};
const EVIDENCE = {
  status: 'sourced', text: '官方产品发布带来 AI Agent 需求', sourceUrl: 'https://example.com/announcement',
  sourceAt: '2026-09-20T11:30:00.000Z', subjectMatch: true,
};

function goodReport(overrides = {}) {
  return createResearchTeamReport({
    nowMs: NOW, chain: 'bsc', token: TOKEN, narrative: EVIDENCE,
    flow: { fresh: true, highProfitCount: 5, fomoCount: 3, uniqueBuyerCount: 6, netBuyUsd: 12_000 },
    marketStatus: 'ok', observedAt: '2026-09-20T11:59:50.000Z',
    candles: [{ close: .9 }, { close: 1 }], ...overrides,
  });
}

test('research team produces an explainable paper-only candidate when every gate passes', () => {
  const report = goodReport();
  assert.equal(report.decision, '可模拟');
  assert.equal(report.executable, false);
  assert.equal(report.signing, false);
  assert.equal(report.broadcast, false);
  assert.equal(report.departments.narrative.status, '通过');
  assert.equal(report.departments.flow.status, '通过');
  assert.equal(report.departments.security.status, '通过');
  assert.equal(report.opportunityScore, 100);
  assert.deepEqual(RESEARCH_TEAM_DEPARTMENTS.map(item => item.id), ['chain', 'narrative', 'flow', 'security', 'market', 'risk']);
});

test('missing narrative evidence fails closed to observation', () => {
  const report = goodReport({ narrative: null });
  assert.equal(report.decision, '观察');
  assert.match(report.reasons.join('、'), /叙事/);
  assert.equal(report.departments.narrative.status, '观察');
});

test('honeypot is a hard block and never a paper candidate', () => {
  const report = goodReport({ token: { ...TOKEN, isHoneypot: true } });
  assert.equal(report.decision, '不买');
  assert.equal(report.departments.security.status, '拦截');
  assert.equal(report.departments.security.hardBlock, true);
});

test('stale market data cannot trigger a new paper entry', () => {
  const report = goodReport({ marketStatus: 'stale', observedAt: '2026-09-20T10:00:00.000Z' });
  assert.equal(report.decision, '观察');
  assert.match(report.tradeLogic.entryWindow, /不新增模拟仓/);
  assert.equal(report.freshness.status, 'stale');
});

test('unknown holder distribution remains a proxy gap', () => {
  const report = goodReport({ token: { ...TOKEN, top10HolderRate: null } });
  assert.equal(report.decision, '观察');
  assert.match(report.departments.flow.proxy, /代理/);
  assert.ok(report.departments.flow.missing.includes('Top10 集中度'));
});

test('brief is concise Chinese and names the evidence boundaries', () => {
  const brief = renderResearchTeamBrief(goodReport({ narrative: null }));
  assert.match(brief, /结论：观察/);
  assert.match(brief, /叙事/);
  assert.match(brief, /安全/);
  assert.match(brief, /失效条件/);
});
