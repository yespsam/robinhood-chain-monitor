import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePaperCandidateSnapshots, planPaperCandidateResearch, canPrefetchPaperFlow, readyForPaperQuote } from '../src/paper-candidate-research.js';
import { EXPLORATORY_FLOW } from '../src/paper-entry-policy.js';

const NOW = Date.parse('2026-09-22T09:00:00Z'), ca = `0x${'a'.repeat(40)}`;
test('a quote-ready route cannot be hidden by the selected summary route',()=>{
  const route={basis:'ohlcv',pattern:{ready:true},decision:'观察',reasons:[],missing:['连续新鲜报价确认']};
  const result={decision:'观察',reasons:['等待两个净买家'],missing:['完整且新鲜的买入资金流'],evidence:{opportunityRoutes:[route]}};
  assert.equal(readyForPaperQuote(result),true);
  for(const patch of [{missing:['两分钟内的真实行情']},{reasons:['预计往返成本超过 5%']},{decision:'不买'},{pattern:{ready:false}}]) {
    assert.equal(readyForPaperQuote({...result,evidence:{opportunityRoutes:[{...route,...patch}]}}),false);
  }
});
test('prefetch is limited to genuine complete or rebuilding active flows, never conflict or unknown data', () => {
  const flow = { fresh: true, complete: false, coverageGap: 'binance_window_warming_or_gap', uniqueBuyerCount: 1, highProfitCount: 0, smartMoneyCount: 1, netBuyUsd: 200 };
  assert.equal(canPrefetchPaperFlow(flow, EXPLORATORY_FLOW), true);
  assert.equal(canPrefetchPaperFlow({ ...flow, coverageGap: 'feed_window_warming_or_gap' }, EXPLORATORY_FLOW), true);
  assert.equal(canPrefetchPaperFlow({ ...flow, complete: true, coverageGap: null }, EXPLORATORY_FLOW), true);
  for (const patch of [{ fresh: false }, { coverageGap: 'ambiguous_trade_legs' }, { coverageGap: null }, { netBuyUsd: 0 }, { smartMoneyCount: null }]) {
    assert.equal(canPrefetchPaperFlow({ ...flow, ...patch }, EXPLORATORY_FLOW), false);
  }
});
const snapshot = (age, token = {}, extra = {}) => ({ marketStatus: 'ok', observedAt: new Date(NOW - age).toISOString(),
  token: { chain: 'base', address: ca, marketStage: 'external', ...token }, ...extra });

test('fresh incomplete ranking and bound research supplement each other without renewing borrowed evidence', () => {
  const ranking = snapshot(70_000, { price: 1, liquidity: 60_000, rugRatio: null, isWashTrading: false });
  const research = snapshot(1000, { price: 1.1, liquidity: null, rugRatio: .01, isWashTrading: null });
  const original = structuredClone([ranking, research]);
  const merged = mergePaperCandidateSnapshots(ranking, research, NOW);
  assert.equal(merged.token.price, 1.1); assert.equal(merged.token.liquidity, 60_000);
  assert.equal(merged.token.rugRatio, .01); assert.equal(merged.token.isWashTrading, false);
  assert.equal(merged.observedAt, ranking.observedAt); assert.equal(merged.researchSources.length, 2);
  assert.deepEqual([ranking, research], original);
  const expired = mergePaperCandidateSnapshots(ranking, research, NOW + 51_000);
  assert.equal(expired.token.isWashTrading, null); assert.equal(expired.token.liquidity, null);
  assert.equal(expired.observedAt, research.observedAt);
});

test('old, future, failed and foreign research never supplies safety to a fresh ranking', () => {
  const ranking = snapshot(0, { rugRatio: null });
  for (const research of [snapshot(120001, { rugRatio: .01 }), snapshot(-1, { rugRatio: .01 }),
    snapshot(0, { rugRatio: .01 }, { marketStatus: 'stale' }), snapshot(0, { rugRatio: .01, chain: 'eth' }),
    snapshot(0, { rugRatio: .01, address: `0x${'b'.repeat(40)}` })]) {
    assert.equal(mergePaperCandidateSnapshots(ranking, research, NOW).token.rugRatio, null);
  }
});

test('still-fresh dangers, invalid risk fractions, zero liquidity and stage conflicts cannot be overwritten', () => {
  const bad = snapshot(1000, { cannotSell: true, isHoneypot: true, renouncedMint: false, rugRatio: .5, liquidity: 0, marketStage: 'internal' });
  const good = snapshot(0, { cannotSell: false, isHoneypot: false, renouncedMint: true, rugRatio: .01, liquidity: 100000 });
  const merged = mergePaperCandidateSnapshots(bad, good, NOW);
  assert.equal(merged.token.cannotSell, true); assert.equal(merged.token.isHoneypot, true);
  assert.equal(merged.token.renouncedMint, false); assert.equal(merged.token.rugRatio, .5);
  assert.equal(merged.token.liquidity, 0); assert.equal(merged.token.stageConflict, true); assert.equal(merged.token.marketStage, 'unknown');
  for (const invalid of [-1, 2]) assert.equal(mergePaperCandidateSnapshots(snapshot(1000, { rugRatio: invalid }), good, NOW).token.rugRatio, invalid);
});

test('known stage is borrowed only while its source is fresh', () => {
  const old = snapshot(119999, { marketStage: 'internal' }), next = snapshot(0, { marketStage: 'unknown' });
  assert.equal(mergePaperCandidateSnapshots(old, next, NOW).token.marketStage, 'internal');
  assert.equal(mergePaperCandidateSnapshots(old, next, NOW + 2).token.marketStage, 'unknown');
});

test('research plans distinguish a missing safety field, near-entry refresh and a hard block', () => {
  const missing = [{ decision: '观察', reasons: [], missing: ['撤池风险比', '五秒内的独立报价', '新鲜且足够的 K 线'] }];
  assert.equal(planPaperCandidateResearch(missing, snapshot(0).observedAt, NOW).needed, true);
  const near = [{ decision: '观察', reasons: [], missing: ['五秒内的独立报价', '新鲜且足够的 K 线'] }];
  assert.equal(planPaperCandidateResearch(near, snapshot(0).observedAt, NOW).needed, false);
  const unrelated = { decision: '观察', reasons: [], missing: ['绑定精确 CA 的新鲜叙事来源', '完整且新鲜的买入资金流'] };
  assert.equal(planPaperCandidateResearch([...near, unrelated], snapshot(0).observedAt, NOW).needed, false);
  assert.equal(planPaperCandidateResearch(near,snapshot(61000).observedAt,NOW).needed,false,'missing chart is not near-entry');
  assert.deepEqual(planPaperCandidateResearch([{decision:'观察',reasons:[],missing:['五秒内的独立报价']}], snapshot(61000).observedAt, NOW), {
    needed: true, priority: 2, refreshAfterMs: 30000, reason: '接近开仓，优先刷新候选行情' });
  assert.equal(planPaperCandidateResearch([{ decision: '不买', reasons: ['禁止卖出'], missing: [] }], null, NOW).needed, false);
});
