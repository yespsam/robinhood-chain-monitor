import test from 'node:test';
import assert from 'node:assert/strict';
import { paperPositionSize, paperInternalDepthPositionSize, validPaperPositionSize, paperSizingText, PAPER_FIXED_SIZING_VERSION, PAPER_INTERNAL_DEPTH_SIZING_VERSION } from '../src/paper-position-sizing.js';

test('internal curve proposal keeps cash cap and raw liquidity, never fabricates reserve evidence',()=>{
  for(const liquidity of [null,.0025,50,999])for(const [cash,budget] of [[100,10],[90,9],[9,.9],[1000,10]]) {
    const size=paperInternalDepthPositionSize({cash,liquidity,baseEntryUsd:2});
    assert.equal(size.version,PAPER_INTERNAL_DEPTH_SIZING_VERSION);assert.equal(size.budgetUsd,budget);
    assert.equal(size.liquidityUsd,liquidity);assert.equal(size.liquidityCapUsd,null);
    assert.equal(size.requiresOrderDepth,true);assert.ok(validPaperPositionSize(size,2,budget,liquidity));
    for(const patch of [{requiresOrderDepth:false},{liquidityCapUsd:10000},{entryFraction:1},{budgetUsd:20}])
      assert.equal(validPaperPositionSize({...size,...patch},2,budget,liquidity),false);
  }
  for(const patch of [{liquidity:0},{liquidity:-1},{cash:NaN},{cash:'100'},{maxBudgetUsd:Infinity}])
    assert.equal(paperInternalDepthPositionSize({cash:100,liquidity:null,baseEntryUsd:2,...patch}),null);
  assert.equal(paperInternalDepthPositionSize({cash:100,liquidity:null,baseEntryUsd:2,maxBudgetUsd:3}).budgetUsd,3);
});

test('fixed ten is an exact all-in ticket, independent of profits and cash percentages', () => {
  for (const cash of [10, 98.62589, 200, 10000]) {
    const size = paperPositionSize({ cash, liquidity: 20000, baseEntryUsd: 2, fixedEntryUsd: 10 });
    assert.equal(size.budgetUsd, 10); assert.equal(size.version, PAPER_FIXED_SIZING_VERSION);
    assert.equal(size.entryFraction, null); assert.equal(validPaperPositionSize(size, 2, 10, 20000), true);
    assert.match(paperSizingText(size), /固定单笔 10.00 U/);
  }
  for (const patch of [{ cash: 9.99 }, { liquidity: 9999 }, { maxBudgetUsd: 9.99 }, { cash: 0 }]) {
    assert.equal(paperPositionSize({ cash: 100, liquidity: 20000, baseEntryUsd: 2, fixedEntryUsd: 10, ...patch }).budgetUsd, 0);
  }
});

test('fixed ticket validates exact version, amount, cash, liquidity and signal cap', () => {
  const size = paperPositionSize({ cash: 100, liquidity: 20000, baseEntryUsd: 2, fixedEntryUsd: 10 });
  for (const patch of [{ fixedEntryUsd: 20 }, { fixedEntryUsd: null }, { version: 'cash_fraction_v1' }, { mode: 'cash_fraction' },
    { cashBeforeEntry: 9 }, { signalBudgetCapUsd: 2 }, { budgetUsd: 2 }, { liquidityCapRate: 1 }]) {
    assert.equal(validPaperPositionSize({ ...size, ...patch }, 2, 10, 20000), false, JSON.stringify(patch));
  }
  assert.equal(paperPositionSize({ cash: 100, liquidity: 20000, baseEntryUsd: 2, fixedEntryUsd: 20 }), null);
});

test('cash percentages grow and shrink without a fixed dollar floor, and respect observed liquidity', () => {
  for (const [cash, expected] of [[100, 2], [200, 4], [500, 10], [50, 1], [99.99, 1.99], [0, 0]]) {
    assert.equal(paperPositionSize({ cash, liquidity: 100000, baseEntryUsd: 2 }).budgetUsd, expected);
  }
  for (const [baseEntryUsd, expected] of [[4, 20], [5, 25], [8, 40]]) {
    assert.equal(paperPositionSize({ cash: 500, liquidity: 100000, baseEntryUsd }).budgetUsd, expected);
  }
  assert.equal(paperPositionSize({ cash: 10000, liquidity: 10000, baseEntryUsd: 8 }).budgetUsd, 10);
  assert.equal(paperPositionSize({ cash: 1000, liquidity: 100000, baseEntryUsd: 8, maxBudgetUsd: 5 }).budgetUsd, 5);
});
test('sizing fails closed on invalid balances, liquidity, fractions and altered persisted evidence', () => {
  const input = { cash: 100, liquidity: 10000, baseEntryUsd: 2 };
  for (const patch of [{ cash: NaN }, { cash: Infinity }, { cash: -1 }, { cash: '100' }, { liquidity: null },
    { liquidity: 0 }, { baseEntryUsd: 50 }, { maxBudgetUsd: Infinity }]) assert.equal(paperPositionSize({ ...input, ...patch }), null);
  const size = paperPositionSize(input); assert.equal(validPaperPositionSize(size, 2, 2, 10000), true);
  for (const patch of [{ entryFraction: .8 }, { cashBeforeEntry: 200 }, { liquidityCapRate: 1 }, { budgetUsd: 5 },
    { version: 'unknown' }, { signalBudgetCapUsd: '2' }]) assert.equal(validPaperPositionSize({ ...size, ...patch }, 2, 2, 10000), false);
});
