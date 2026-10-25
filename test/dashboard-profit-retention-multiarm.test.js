import test from 'node:test';
import assert from 'node:assert/strict';
import { profitRetentionStatus, renderProfitRetention } from '../dashboard/profit-retention-multiarm.js';
import { createProfitRetentionMultiarm, profitRetentionMultiarmSummary } from '../src/paper-profit-retention-multiarm.js';

function fixture({ closed = 0, open = 0 } = {}) {
  const common = { closedPairs: closed, openPairs: open, excludedPairs: 0, ineligibleEntries: 0 };
  return { version: 'profit_retention_multiarm_v3', status: 'observing', pairedCohort: true,
    policy: { triggerPriceMultiples: [2, 3, 5] }, ...common,
    arms: [2, 3, 5].map(multiple => ({ multiple, ...common, policy: { triggerPriceMultiple: multiple },
      coverage: { gapCount: 0 }, active: [], performance: closed ? { completedRounds: closed,
        recoveries: multiple === 2 ? closed : 0, unrecoveredRounds: multiple === 2 ? 0 : closed,
        controlNetUsd: 10, treatmentNetUsd: multiple === 2 ? 8 : 10,
        deltaNetUsd: multiple === 2 ? -2 : 0, treatmentCostsUsd: .4, extraCostsUsd: multiple === 2 ? .1 : 0,
        distinctCAs: 1, foregoneUpsideRounds: multiple === 2 ? closed : 0, foregoneUpsideUsd: multiple === 2 ? 2 : 0,
        completedWithCoverageGaps: 0, closedRoundDrawdown: { treatmentMaxDrawdownUsd: 1.4 },
        caRobustness: { treatment: { largestPositiveCAShare: .75, netExcludingLargestPositiveCAUsd: -1.1 } },
      } : null })) };
}

test('multiarm UI distinguishes unloaded, disabled and old single-arm backend', () => {
  assert.equal(profitRetentionStatus(undefined), '尚未加载');
  assert.match(renderProfitRetention(undefined), /网页展示不代表后端已经启用/);
  assert.equal(profitRetentionStatus({ status: 'disabled' }), '未启用');
  assert.doesNotMatch(renderProfitRetention({ status: 'disabled' }), /0\.000 U/);
  for (const version of ['profit_retention_principal_v2', 'profit_retention_pair_v1']) {
    const old = { version, status: 'observing', performance: { treatmentNetUsd: 999 } };
    assert.equal(profitRetentionStatus(old), '旧版对照 · 待升级');
    assert.match(renderProfitRetention(old), /不是三倍数同源比较/);
    assert.doesNotMatch(renderProfitRetention(old), /999|本组净收益/);
  }
});

test('all three empty arms show unknown performance, not invented zero gains', () => {
  const s = fixture(), html = renderProfitRetention(s);
  assert.match(profitRetentionStatus(s), /三组前向观察/);
  assert.match(html, /各组净收益差为未知/);
  assert.doesNotMatch(html, /0\.000 U/);
  assert.match(html, /不自动选择赢家/);
});

test('actual core summary schema renders as three comparable hypotheses', () => {
  const account = { mode: 'paper', execution: false, signing: false, broadcast: false,
    estimatedCostModel: 'isolated_estimated_cost_v1', trades: [] };
  const state = createProfitRetentionMultiarm(account, { sessionId: 'ui-fixture', nowMs: 1000 });
  const summary = profitRetentionMultiarmSummary(state, { nowMs: 1000 });
  assert.match(profitRetentionStatus(summary), /三组前向观察/);
  assert.match(renderProfitRetention(summary), /共同报价／观察缺口 0/);
  assert.doesNotMatch(renderProfitRetention(summary), /同源性待核对|0\.000 U/);
});

test('shared baseline appears once and untriggered completed arms remain in comparison', () => {
  const html = renderProfitRetention(fixture({ closed: 2 }));
  assert.equal((html.match(/共同原退出基准：/g) || []).length, 1);
  assert.match(html, /共同原退出基准：\+10\.000 U/);
  assert.match(html, /<td>2 倍<\/td><td>2<\/td><td>2 \/ 0<\/td>/);
  assert.match(html, /<td>3 倍<\/td><td>2<\/td><td>0 \/ 2<\/td>/);
  assert.match(html, /<td>5 倍<\/td><td>2<\/td><td>0 \/ 2<\/td>/);
  assert.match(html, /-2\.000 U/); assert.match(html, /\+0\.100 U/);
  assert.match(html, /互斥的假设结果，不能相加/);
  assert.match(html, /未触发的回合也计入每组/);
});

test('missing, duplicated, reordered or different cohorts cannot become a ranking', () => {
  const mutations = [s => s.arms.pop(), s => s.arms.reverse(), s => s.arms[1].multiple = 2,
    s => s.arms[2].closedPairs++, s => s.arms[1].performance.controlNetUsd++,
    s => s.arms[2].performance.completedRounds++, s => s.pairedCohort = false,
    s => s.policy.triggerPriceMultiples = [2, 5], s => s.arms[0].policy.triggerPriceMultiple = 3,
    s => s.arms = {}, s => s.arms[0] = null];
  for (const mutate of mutations) {
    const s = fixture({ closed: 2 }); mutate(s);
    assert.equal(profitRetentionStatus(s), '三组同源性待核对');
    const html = renderProfitRetention(s);
    assert.match(html, /缺组不能补零/); assert.doesNotMatch(html, /本组净收益|共同原退出基准：/);
  }
});

test('cash recovery and remaining inventory stay separate from profit; stale values stay unknown', () => {
  const s = fixture({ open: 1 });
  for (const a of s.arms) a.active = [{ id: 'a', chain: 'bsc', address: '0x1', partialTaken: a.multiple === 2,
    recoveredPrincipalUsd: a.multiple === 2 ? 10 : 0, principalTargetUsd: 10,
    remainingFraction: a.multiple === 2 ? .4754 : 1, treatmentTotalIfLiquidatedUsd: null }];
  const html = renderProfitRetention(s);
  assert.match(html, /10\.000 U \/ 10\.000 U/); assert.match(html, /47\.5%/);
  assert.match(html, /<td>未知<\/td>/); assert.match(html, /回收净现金不是利润/);
  assert.match(html, /不是三笔主盘买入/);
});

test('coverage and drawdown diagnostics are limited and never imply complete market coverage', () => {
  const s = fixture({ closed: 2 }); s.arms[0].performance.completedWithCoverageGaps = 1;
  const html = renderProfitRetention(s);
  assert.match(html, /有覆盖缺口的已平配对/); assert.match(html, /配对闭合不等于行情覆盖完整/);
  assert.match(html, /不是实时资金曲线或最大持仓回撤/);
  assert.match(html, /75\.0%/); assert.match(html, /-1\.100 U/);
});

test('incomplete diagnostic values are unknown, not zero or a false best arm', () => {
  const s = fixture({ closed: 1 });
  for (const a of s.arms) { a.performance.caRobustness = null; a.performance.closedRoundDrawdown = null; }
  const html = renderProfitRetention(s);
  assert.match(html, /<td>未知<\/td><td>未知<\/td><td>未知<\/td>/);
  assert.doesNotMatch(html, /最优倍数|推荐 5 倍|赢家：/);
});

test('escaped identities and observer error remain text in the multiarm view', () => {
  const s = fixture({ open: 1 }); s.status = 'error'; s.error = '<script>alert(1)</script>';
  s.arms[0].active = [{ chain: '<b>', address: '<img onerror=1>' }];
  const html = renderProfitRetention(s);
  assert.equal(profitRetentionStatus(s), '故障 · 保留检查点');
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>|<img|<b>/);
});
