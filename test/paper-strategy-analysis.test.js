import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPaperNarrative, analyzePaperChart, buildPaperEntryPlan } from '../src/paper-strategy-analysis.js';
import { renderStrategyDetails, exactPrice } from '../dashboard/strategy-details.js';
import { breakoutCandles, sourcedNarrative } from './fixtures/paper-strategy-v2.js';

const NOW = Date.parse('2026-09-22T00:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const source = () => sourcedNarrative(NOW, 'robinhood', CA);
const assess = (narrative = source()) => assessPaperNarrative({ narrative, chain: 'robinhood', address: CA, nowMs: NOW });
const chart = (candles = breakoutCandles(NOW), nowMs = NOW) => analyzePaperChart({ candles, klineStatus: 'ok', nowMs });
const costs = { notionalUsd: (5 - .02) / 1.013, feeRate: .003, slippageRate: .01, sellTax: 0, gasUsd: .02 };
const plan = (candles = breakoutCandles(NOW), price = 1, overrides = {}) => buildPaperEntryPlan({ chart: chart(candles), price, policy: { stopLoss: .18, entryUsd: 5 }, costs, ...overrides });

test('disjoint confirmation constraints return no interval instead of an inverted buy zone', () => {
  const bars = breakoutCandles(NOW); bars.at(-2).high = 3; bars.at(-2).close = .94; bars.at(-2).volume = 50;
  const result = plan(bars);
  assert.equal(result.entryZone, null); assert.equal(result.eligible, false);
  assert.match(result.summary, /暂无有效确认区/); assert.ok(result.reasons.some(reason => reason.includes('无交集')));
});

test('source-authenticated narrative gives a hypothesis, not issuer endorsement or win probability', () => {
  const result = assess();
  assert.equal(result.eligible, true); assert.equal(result.phase, '新鲜催化');
  assert.equal(result.independentSourceCount, 1); assert.match(result.quality, /单一/);
  assert.match(result.mechanism, /研究假设/); assert.match(result.scoreMeaning, /非胜率/);
  assert.ok(result.sources[0].sourceUrl); assert.ok(result.event.includes('launched'));
});

test('name bait, project self-description, hype, denial and stale or mismatched claims never qualify as a narrative', () => {
  for (const change of [
    { sourceAuthenticated: false }, { caBound: false }, { chain: 'bsc' }, { address: `0x${'b'.repeat(40)}` },
    { sourceAt: new Date(NOW + 1).toISOString() }, { sourceAt: new Date(NOW - 6 * 3600000 - 1).toISOString() },
    { sourceUrl: 'https://user:pass@x.com/private' }, { authorKey: null },
    { text: 'Our AI token will go to the moon 1000x, buy this community now!' },
    { text: 'The mainnet launch is cancelled and the issuer denied this token.' },
  ]) assert.equal(assess({ ...source(), ...change }).eligible, false, JSON.stringify(change));
  assert.equal(assess({ status: 'project_claim', text: '官方 AI 主网马上发布' }).eligible, false);
  assert.equal(assess({ ...source(), sourceAt: new Date(NOW - 3600000).toISOString() }).phase, '传播阶段');
  const denial = { ...source(), sourceAt: new Date(NOW - 60000).toISOString(), sourceUrl: 'https://x.com/deny/status/3', authorKey: 'x-id:deny', text: 'This AI agent mainnet launch has been cancelled and is not official.' };
  assert.equal(assess({ ...source(), sources: [source(), denial] }).eligible, false);
});

test('same source, copied posts and same author do not inflate source counts or refresh age', () => {
  const a = source(), b = { ...a, sourceUrl: 'https://x.com/other/status/2', authorKey: 'x-id:5678' };
  assert.equal(assess({ ...a, sources: [a, b] }).independentSourceCount, 1);
  b.text = 'Another agent product has released a public testing roadmap for game developers.';
  assert.equal(assess({ ...a, sources: [a, b] }).independentSourceCount, 2);
  b.authorKey = a.authorKey;
  assert.equal(assess({ ...a, sources: [a, b] }).independentSourceCount, 1);
  const old = { ...a, sourceAt: new Date(NOW - 7 * 3600000).toISOString() };
  assert.equal(assess({ ...a, sources: [a, old] }).eligible, false);
  const ancient = { ...a, sourceAt: new Date(NOW - 25 * 3600000).toISOString() };
  assert.equal(assess({ ...a, sources: [a, ancient] }).sourceCount, 0);
  const conflicting = { ...a, text: 'The agent product launch has been cancelled and is fake.' };
  const result = assess({ ...a, sources: [a, conflicting] });
  assert.equal(result.eligible, false); assert.ok(result.gaps.some(text => text.includes('冲突')));
});

test('distinct Chinese source bodies are preserved, and Solana CA remains case-sensitive', () => {
  const a = { ...source(), text: '这个智能体游戏今天发布了公开测试版本，开发者可以尝试新的互动功能。' };
  const b = { ...a, text: '项目团队推出了游戏产品测试路线图，展示了智能体之间的互动机制和新功能。', sourceUrl: 'https://x.com/b/status/2', authorKey: 'x-id:2' };
  assert.equal(assess({ ...a, sources: [a, b] }).independentSourceCount, 2);
  const ca = 'So11111111111111111111111111111111111111112';
  assert.equal(assessPaperNarrative({ narrative: { ...source(), chain: 'sol', address: ca.toLowerCase() }, chain: 'sol', address: ca, nowMs: NOW }).eligible, false);
});

test('eight closed candles confirm structure; current forming candle never changes the decision', () => {
  const candles = breakoutCandles(NOW), expected = chart(candles);
  assert.equal(expected.ready, true); assert.equal(expected.observedAt, new Date(NOW).toISOString());
  assert.equal(chart(candles.slice(1)).ready, false);
  assert.deepEqual(chart([...candles, { time: NOW, open: 1, high: 500, low: 1, close: 500, volume: 99999 }]), expected);
  assert.deepEqual(chart(candles.map(row => ({ ...row, time: row.time / 1000 }))), expected);
  assert.equal(chart(candles, NOW + 90001).ready, false);
});

test('duplicate, missing, future and malformed OHLCV are not silently converted to bullish candles', () => {
  for (const mutate of [
    c => { c[2].time = c[1].time; }, c => { c[2].time = NOW + 1; }, c => { c[2].time += 1; },
    c => { c[2].high = c[2].close / 2; }, c => { c[2].low = c[2].open * 2; },
    c => { delete c[2].volume; }, c => { c[2].volume = -1; }, c => { c[2].open = null; },
  ]) { const candles = breakoutCandles(NOW); mutate(candles); assert.equal(chart(candles).ready, false); }
  assert.equal(analyzePaperChart({ candles: breakoutCandles(NOW), klineStatus: 'stale', nowMs: NOW }).ready, false);
});

test('entry records exact structural levels and cost-aware scenario reward, without chasing', () => {
  const result = plan();
  assert.equal(result.eligible, true); assert.equal(result.setup, '放量突破后回踩确认');
  assert.ok(result.stopPrice < 1 && result.stopPrice > .82); assert.ok(result.targetPrice > 1);
  assert.ok(result.netRewardRisk >= 1.5); assert.match(result.targetKind, /非预测/);
  assert.equal(plan(undefined, 1.15).eligible, false);
  const expensive = { ...costs, sellTax: .1 };
  assert.equal(plan(undefined, 1, { costs: expensive }).eligible, false);
  const wicked = breakoutCandles(NOW); wicked.at(-1).high = 1.5;
  assert.ok(plan(wicked).reasons.some(text => text.includes('上影')));
  const noVolume = breakoutCandles(NOW); noVolume.at(-2).volume = 100;
  assert.equal(plan(noVolume).eligible, false);
  const narrow = breakoutCandles(NOW); narrow[0] = { ...narrow[0], open: .85, low: .84 };
  assert.equal(plan(narrow).eligible, false);
  assert.deepEqual(plan(breakoutCandles(NOW).map(row => ({ ...row, amount: 9e12 }))), result);
});

test('shrinking-volume pullback can qualify independently of a breakout', () => {
  const rows = [[.72,.76,.69,.75,100],[.75,.86,.74,.84,100],[.84,1.28,.83,1.2,100],[1.2,1.24,1.1,1.15,100],[1.15,1.18,1.04,1.06,100],[1.06,1.1,1.02,1.04,100],[1.04,1.045,.99,1.005,60],[1.005,1.055,1.0,1.05,160]];
  const candles = rows.map(([open,high,low,close,volume], i) => ({ time: NOW - (8-i)*60000, open,high,low,close,volume }));
  const result = plan(candles, 1.05);
  assert.equal(result.setup, '缩量回踩后重新走强');
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.targetKind, '已观察前高，非保证触达');
});

test('dashboard details keep tiny prices, escape source text, reject unsafe links and label unknown levels', () => {
  assert.equal(exactPrice(.000000123456789), '$1.234568e-7');
  assert.equal(exactPrice(null), '待确认');
  const html = renderStrategyDetails(plan(), { ...assess(), event: '<img src=x onerror=alert(1)>', sources: [{ sourceUrl: 'javascript:alert(1)', authorLabel: 'bad' }] });
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|javascript:/);
  assert.match(html, /不是胜率/); assert.match(renderStrategyDetails(null, null), /待确认，不给假点位/);
});
