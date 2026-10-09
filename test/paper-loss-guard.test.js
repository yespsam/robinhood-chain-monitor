import test from 'node:test';
import assert from 'node:assert/strict';
import { paperLossGuard } from '../src/paper-loss-guard.js';
import { confirmedAccountGate } from '../src/paper-confirmed-policy.js';
import { createPaperStrategyAccount, resetPaperCash } from '../src/paper-strategy-engine.js';

const NOW=Date.parse('2026-09-30T05:00:00Z');
function funded() {
  const a=createPaperStrategyAccount({nowMs:NOW-1000});
  a.cash=1;a.realizedPnl=-99;
  return resetPaperCash(a,{operationId:'funded_repair_test',nowMs:NOW});
}
test('explicit funding opens a new risk budget, without erasing historical losses or treating capital as profit',()=>{
  const a=funded(), g=paperLossGuard(a,NOW);
  assert.equal(g.triggered,false);assert.equal(g.capitalUsd,100);assert.equal(g.lossLimitUsd,10);
  assert.equal(g.realizedPnlUsd,0);assert.equal(a.realizedPnl,-99);
  const gate=confirmedAccountGate(a,NOW,null,null,null,{continuousPaperMode:true,enforceLossGuards:true});
  assert.equal(gate.allowed,true);assert.deepEqual(gate.reasons,[]);
  assert.equal(gate.operatingPolicy.enforceLossGuards,true);
});
test('engine risk and entry gate agree at exactly 10%, use the funded round, and cannot be cleared by midnight or low cash',()=>{
  const a=funded();a.cash=0;
  assert.equal(paperLossGuard(a,NOW).triggered,false,'allocated cash is not a realized loss');
  a.trades.push({side:'sell',atMs:NOW+1,realizedPnl:-9.99});
  a.realizedPnl=-108.99;
  assert.equal(paperLossGuard(a,NOW+1).triggered,false);
  a.trades.push({side:'sell',atMs:NOW+2,realizedPnl:-.01});a.realizedPnl=-109;
  const g=paperLossGuard(a,NOW+2);
  assert.equal(g.triggered,true);assert.equal(g.realizedPnlUsd,-10);
  const gate=confirmedAccountGate(a,NOW+2,null,null,null,{continuousPaperMode:true,enforceLossGuards:true});
  assert.equal(gate.allowed,false);assert.deepEqual(gate.reasons,g.reasons);
  assert.ok(gate.reasons.every(s=>!s.includes('不停机')));
  const nextDay=paperLossGuard(a,NOW+86400000);
  assert.equal(nextDay.dailyRealizedPnlUsd,0);assert.equal(nextDay.triggered,true);
});
