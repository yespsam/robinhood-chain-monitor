import test from 'node:test';
import assert from 'node:assert/strict';
import { profitRetentionStatus, renderProfitRetention } from '../dashboard/profit-retention.js';

test('missing old backend and disabled study never imply it is collecting or profitable', () => {
  assert.equal(profitRetentionStatus(undefined), '尚未加载');
  assert.match(renderProfitRetention(undefined), /网页展示不代表后端已经启用/);
  assert.equal(profitRetentionStatus({ status: 'disabled' }), '未启用');
  assert.doesNotMatch(renderProfitRetention({ status: 'disabled' }), /0\.000 U/);
});

test('no completed pairs and stale marks stay unknown, not zero-profit', () => {
  const html = renderProfitRetention({ status: 'observing', closedPairs: 0, openPairs: 1, excludedPairs: 0,
    ineligibleEntries: 0, coverage: { gapCount: 1 }, performance: null,
    active: [{ chain: 'bsc', address: '0x1', partialTaken: false, controlUnrealizedNetUsd: null, treatmentTotalIfLiquidatedUsd: null }] });
  assert.match(html, /净收益差为未知/);
  assert.match(html, /<td>未知<\/td><td>未知<\/td>/);
  assert.doesNotMatch(html, /0\.000 U/);
});

test('complete comparison shows net difference and extra costs without mixing main balance', () => {
  const html = renderProfitRetention({ status: 'observing', closedPairs: 2, openPairs: 0, excludedPairs: 1,
    version:'profit_retention_principal_v2',policy:{triggerPriceMultiple:2},
    ineligibleEntries: 0, coverage: { gapCount: 1 }, active: [],
    performance: { controlNetUsd: -1, treatmentNetUsd: -1.2, deltaNetUsd: -.2, extraCostsUsd: .07, distinctCAs: 2 } });
  assert.match(html, /-0\.200 U/); assert.match(html, /\+0\.070 U/);
  assert.match(html, /结果不与主盘收益相加/);
  assert.match(html, /不假定成交在阈值或峰顶/);
});

test('provider identities and observer error strings are escaped', () => {
  const html = renderProfitRetention({ status: 'error', error: '<script>alert(1)</script>', active: [{ chain: '<b>', address: '<img>' }] });
  assert.doesNotMatch(html, /<script>|<img>|<b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(profitRetentionStatus({ status: 'error' }), '故障 · 保留检查点');
});

test('renders the frozen price multiple and separates principal cash from profit',()=>{
  for(const triggerPriceMultiple of [2,3,5]){
    const html=renderProfitRetention({version:'profit_retention_principal_v2',status:'observing',closedPairs:0,openPairs:1,
      policy:{triggerPriceMultiple},performance:null,active:[{chain:'bsc',address:'0x1',partialTaken:true,
        recoveredPrincipalUsd:10.24,principalTargetUsd:10.24,remainingFraction:.476,controlUnrealizedNetUsd:null,treatmentTotalIfLiquidatedUsd:null}]});
    assert.match(html,new RegExp(`入场价格的 ${triggerPriceMultiple} 倍`));assert.match(html,/10\.240 U \/ 10\.240 U/);
    assert.match(html,/47\.6%/);assert.match(html,/回收净现金不是利润/);assert.match(html,/净收益差为未知/);
    assert.doesNotMatch(html,/2R|1\/3|2\/3|情景风险/);
  }
});

test('unknown or v1 policy cannot be displayed as default 2x principal recovery',()=>{
  const old={version:'profit_retention_pair_v1',status:'observing',policy:{triggerRiskMultiple:2}};
  assert.equal(profitRetentionStatus(old),'旧版对照 · 待升级');assert.match(renderProfitRetention(old),/后端仍是旧版/);
  for(const policy of [undefined,{triggerPriceMultiple:4}]){
    const html=renderProfitRetention({status:'observing',policy});assert.match(html,/冻结的价格倍数尚未核对/);
    assert.doesNotMatch(html,/入场价格的 2 倍/);
  }
});
