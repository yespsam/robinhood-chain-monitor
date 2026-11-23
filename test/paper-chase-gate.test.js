import test from 'node:test';
import assert from 'node:assert/strict';
import { paperChaseGate, FRICTION_BUDGET, CHAIN_FRICTION_BONUS } from '../src/paper-chase-gate.js';
import { paperControlScore } from '../src/paper-control-score.js';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';

const NOW = Date.parse('2026-09-23T10:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const iso = n => new Date(n).toISOString();
const strongNarrative = { eligible: true, evidenceScore: 90, independentSourceCount: 2 };
const controlled = { safety: { metrics: { top10HolderRate: .4, bundlerRate: .05, devTeamHoldRate: .02 } },
  flow: { netBuyUsd: 1500, uniqueBuyerCount: 5, smartMoneyCount: 1 } };
function input() {
  const token = { chain: 'base', address: CA, symbol: 'OFFLINE_TEST', price: 1.01, liquidity: 60000, volume: 5000,
    isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .01, bundlerRate: .01, buyTax: 0, sellTax: 0 };
  return { nowMs: NOW, token, marketStatus: 'ok', observedAt: iso(NOW), priceObservedAt: iso(NOW), allowExploratory: true,
    pvpMode: true, confirmedMode: true, compoundingCash: 100,
    flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(NOW), highProfitCount: 0, fomoCount: 0,
      smartMoneyCount: 1, uniqueBuyerCount: 2, netBuyUsd: 600,
      pulse: { windowMs: 90000, recentBuyerCount: 2, recentNetBuyUsd: 600, lastBuyAt: NOW - 1000 } },
    quoteHistory: [1, 1.006, 1.01].map((price, i) => ({ ...token, price, status: 'ok', observedAt: iso(NOW - (2 - i) * 6000) })) };
}
const run = (row, opts = {}) => advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [row], confirmedMode: true, nowMs: NOW, ...opts });

test('control score is unknown without concentration data, ok inside the control band with consistent net buying', () => {
  assert.equal(paperControlScore({}).status, 'unknown');
  assert.equal(paperControlScore(controlled).status, 'ok');
  assert.equal(paperControlScore({ ...controlled, safety: { metrics: { ...controlled.safety.metrics, top10HolderRate: .1 } } }).status, 'weak');
});

test('no-narrative / exploratory evidence is shadow-only with zero main friction budget', () => {
  const g = paperChaseGate({ entryTier: 'exploratory', narrativeAssessment: { eligible: false, evidenceScore: 0, independentSourceCount: 0 }, ...controlled }, { chain: 'bsc', costRate: .01 });
  assert.equal(g.tier, 'shadow_only'); assert.equal(g.mainAllowed, false); assert.equal(g.frictionBudget, 0);
});

test('narrative + control can chase a breakout with a higher (chain-adjusted) friction budget', () => {
  const chase = paperChaseGate({ narrativeAssessment: strongNarrative, ...controlled }, { chain: 'bsc', costRate: .085 });
  assert.equal(chase.tier, 'chase'); assert.equal(chase.canChaseBreakout, true); assert.equal(chase.mainAllowed, true);
  assert.equal(chase.frictionBudget, FRICTION_BUDGET.chase + CHAIN_FRICTION_BONUS.bsc);
  const base = paperChaseGate({ narrativeAssessment: strongNarrative, opportunity: { id: 'external_pullback' } }, { chain: 'bsc', costRate: .03 });
  assert.equal(base.tier, 'base'); assert.equal(base.mainAllowed, true);
  assert.ok(base.frictionBudget < chase.frictionBudget);
  assert.equal(paperChaseGate({ narrativeAssessment: strongNarrative, opportunity: { id: 'external_pullback' } }, { chain: 'bsc', costRate: .10 }).mainAllowed, false);
});

test('narrative without control cannot chase a breakout', () => {
  const g = paperChaseGate({ narrativeAssessment: strongNarrative, opportunity: { id: 'external_breakout' } }, { chain: 'base', costRate: .01 });
  assert.equal(g.mainAllowed, false); assert.match(g.reasons[0], /控盘/);
});

test('main ledger: exploratory row without narrative cannot fill; narrative+control fills and records the gate', () => {
  const row = evaluatePaperStrategies(input())[0];
  assert.equal(row.decision, '可模拟');
  assert.equal(run(row).trades.length, 1, 'legacy behaviour unchanged when gate is off');
  const gated = run(row, { evidenceTierGate: true });
  assert.equal(gated.trades.length, 0); assert.equal(gated.cash, 100);
  const good = structuredClone(row);
  good.evidence.narrativeAssessment = { ...(good.evidence.narrativeAssessment || {}), ...strongNarrative };
  good.evidence.safety = { ...good.evidence.safety, metrics: { ...(good.evidence.safety?.metrics || {}), ...controlled.safety.metrics } };
  good.evidence.flow = { ...good.evidence.flow, ...controlled.flow };
  const a = run(good, { evidenceTierGate: true });
  assert.equal(a.trades.length, 1);
  assert.equal(a.trades[0].entryEvidence.chaseGate.tier, 'chase');
  assert.equal(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))), true);
  assert.equal(a.execution, false); assert.equal(a.signing, false); assert.equal(a.broadcast, false);
});
