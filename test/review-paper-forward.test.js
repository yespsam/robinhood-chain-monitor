import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { reviewPaperForward, runForwardReviewCli, FORWARD_BASELINE, EXPECTED_SESSION,
  FORWARD_REQUIREMENTS, MARK_MAX_AGE_MS } from '../scripts/review-paper-forward.js';

const BASE = Date.parse(FORWARD_BASELINE), NOW = BASE + 86_400_000;
const CA = '0x' + 'a'.repeat(40), OTHER = '0x' + 'b'.repeat(40);
const COST = 'isolated_estimated_cost_v1';
function entryEvidence(setup = 'external_breakout') {
  return { traderDecision: { version: 'evidence_first_v1', hypothesis: setup },
    recoveryCheck: { entryFlow: { version: 'paper_entry_observed_outflow_v1' } },
    opportunity: { version: 'multi_setup_v2', id: setup,
      pattern: { targetSelectionVersion: 'pullback_nearest_observed_level_v1' } },
    costAssumptions: { version: COST }, accountPolicy: { version: 'continuous_paper_v1' },
    memeExitPolicy: { version: 'meme_evidence_exit_v2' },
    structureValidation: { version: 'reconstructed_ohlcv_entry_v1' },
    entryPlan: { entryPolicyVersion: 'meme_structure_entry_v1' } };
}
function exitEvidence() {
  return { costVersion: COST, exitPolicyVersion: 'meme_evidence_exit_v2',
    thesisDecision: { version: 'meme_evidence_exit_v2', structureObservationVersion: 'independent_confirmed_trail_v1',
      flow: { observationVersion: 'entry_cohort_sell_retention_v1' } } };
}
function buy(atMs = BASE + 1000, address = CA, setup) {
  return { id: `buy:${address}:${atMs}`, chain: 'bsc', address, side: 'buy', atMs,
    quantity: 10, price: 1, grossUsd: 10, costsUsd: .1, netUsd: -10.1, costBasisUsd: 10.1,
    realizedPnl: 0, entryEvidence: entryEvidence(setup) };
}
function sell(entry, { atMs = entry.atMs + 1000, quantity = 10, price = 1.2, writeoff = false } = {}) {
  const grossUsd = quantity * (writeoff ? 0 : price), costsUsd = writeoff ? 0 : .1;
  const costBasisUsd = entry.costBasisUsd * quantity / entry.quantity, netUsd = grossUsd - costsUsd;
  return { id: `${writeoff ? 'writeoff' : 'sell'}:${entry.address}:${atMs}`, chain: entry.chain, address: entry.address,
    side: writeoff ? 'writeoff' : 'sell', atMs, quantity, price: writeoff ? 0 : price,
    grossUsd, costsUsd, netUsd, costBasisUsd, realizedPnl: netUsd - costBasisUsd, exitEvidence: exitEvidence() };
}
function ledger(trades, { adjustments = [], markAgeMs = 1000 } = {}) {
  const ordered = structuredClone(trades).sort((a, b) => a.atMs - b.atMs), positions = {};
  for (const t of ordered) {
    const key = `${t.chain}:${t.address}`;
    if (t.side === 'buy') positions[key] = { chain: t.chain, address: t.address, quantity: t.quantity,
      costBasisUsd: t.costBasisUsd, openedAt: new Date(t.atMs).toISOString() };
    else {
      const p = positions[key]; p.quantity -= t.quantity; p.costBasisUsd -= t.costBasisUsd;
      if (p.quantity < 1e-9) delete positions[key];
    }
  }
  for (const p of Object.values(positions)) Object.assign(p, { markAt: new Date(NOW - markAgeMs).toISOString(),
    markStatus: 'ok', markPrice: 1, markValue: p.quantity, estimatedExitCostsUsd: .1,
    pnl: p.quantity - .1 - p.costBasisUsd });
  return { schema: 'yesp_atm_runtime_v1', session: { id: EXPECTED_SESSION, mode: 'paper', costModel: COST },
    account: { schema: 'yesp_atm_strategy_paper_v1', mode: 'paper', execution: false, signing: false, broadcast: false,
      estimatedCostModel: COST, initialCash: 100, cash: 100 + ordered.reduce((n, t) => n + t.netUsd, 0)
        + adjustments.reduce((n, c) => n + c.amountUsd, 0),
      realizedPnl: ordered.reduce((n, t) => n + t.realizedPnl, 0),
      positions, trades: ordered, cashAdjustments: adjustments, updatedAt: new Date(NOW).toISOString() } };
}
const review = (data, options = {}) => reviewPaperForward(data, { nowMs: NOW, ...options });
function snapshot() {
  return { ...structuredClone(FORWARD_REQUIREMENTS), session: { id: EXPECTED_SESSION }, mode: 'paper',
    execution: false, signing: false, broadcast: false, updatedAt: new Date(NOW - 1000).toISOString(),
    poolFirstThreePolicy: { version: 'paper_quote_asset_first_three_v1', maxUniqueCA: 3, mode: 'paper' } };
}

test('fixed entry baseline partitions legacy/carry-in/current without changing input or costs', () => {
  const before = buy(BASE - 5000), carried = buy(BASE - 2000, OTHER), current = buy(BASE + 3000);
  const data = ledger([before, sell(before), carried, sell(carried, { atMs: BASE + 1000 }), current, sell(current)]);
  const original = structuredClone(data), result = review(data);
  assert.equal(result.entryFrom, FORWARD_BASELINE);
  assert.equal(result.history.allClosed.closedRounds, 3);
  assert.equal(result.history.preBaselineClosed.closedRounds, 1);
  assert.equal(result.history.carriedInClosedAfterBaseline.closedRounds, 1);
  assert.equal(result.forward.currentVersion.closedRounds, 1);
  assert.ok(Math.abs(result.forward.currentVersion.netPnlUsd - 1.8) < 1e-10);
  assert.equal(result.forward.currentVersion.modelCostsUsd, .2);
  assert.equal(result.forward.currentVersion.byChainRoute[0].route, 'external_breakout');
  assert.equal(result.forward.currentVersion.byChainRoute[0].chain, 'bsc');
  assert.equal(result.automaticPromotion, false);
  assert.deepEqual(data, original);
});

test('requires frozen entry reconstruction and actual exit versions; missing/mixed/writeoff are not promoted', () => {
  const trades = [];
  for (let i = 0; i < 6; i++) {
    const b = buy(BASE + 10_000 * (i + 1)), s = sell(b);
    if (i === 1) b.entryEvidence.structureValidation.version = 'old_entry_v1';
    if (i === 2) delete s.exitEvidence.thesisDecision.structureObservationVersion;
    if (i === 3) {
      trades.push(b, sell(b, { quantity: 5 }));
      const second = sell(b, { quantity: 5, atMs: b.atMs + 2000 });
      second.exitEvidence.exitPolicyVersion = 'meme_evidence_exit_v1';
      second.exitEvidence.thesisDecision.version = 'meme_evidence_exit_v1';
      trades.push(second); continue;
    }
    if (i === 4) { trades.push(b, sell(b, { writeoff: true })); continue; }
    if (i === 5) b.entryEvidence.memeExitPolicy.version = 'meme_evidence_exit_v1';
    trades.push(b, s);
  }
  const result = review(ledger(trades));
  assert.equal(result.forward.currentVersion.closedRounds, 1);
  assert.equal(result.forward.legacyVersion.closedRounds, 2);
  assert.equal(result.forward.mixedOrMissingVersion.closedRounds, 3);
  assert.equal(result.history.allClosed.closedRounds, 6);
  assert.ok(result.forward.classifications.some(c => c.reasons.includes('frozen_entry_exit_version')));
  const totals = ['currentVersion', 'legacyVersion', 'mixedOrMissingVersion'].reduce((n, k) => n + result.forward[k].netPnlUsd, 0);
  assert.ok(Math.abs(totals - result.account.realizedPnlUsd) < 1e-10, 'no excluded loss disappears');
});

test('partial exits stay out of complete rounds, and stale/missing/future marks never turn into zero', () => {
  const b = buy(), data = ledger([b, sell(b, { quantity: 5 })], { markAgeMs: MARK_MAX_AGE_MS + 1 });
  const result = review(data);
  assert.equal(result.forward.currentVersion.closedRounds, 0);
  assert.ok(result.account.realizedPnlUsd > 0);
  assert.equal(result.openPositions[0].valuationStatus, 'stale');
  assert.equal(result.account.unrealizedPnlUsd, null);
  assert.equal(result.account.netLiquidationValueUsd, null);
  assert.equal(result.account.totalPnlIncludingOpenUsd, null);
  assert.equal(result.openPositions[0].lastRecorded.markValueUsd, 5);
  const p = Object.values(data.account.positions)[0];
  p.markAt = new Date(NOW + 1).toISOString();
  assert.equal(review(data).openPositions[0].valuationStatus, 'future_timestamp');
  delete p.markAt;
  assert.equal(review(data).openPositions[0].valuationStatus, 'missing_timestamp');
  p.markAt = new Date(NOW - 1).toISOString(); p.pnl = 9;
  assert.equal(review(data).openPositions[0].valuationStatus, 'incomplete_or_inconsistent');
});

test('fresh open position risk is reported separately; an empty account has known zero unrealized', () => {
  const b = buy(), result = review(ledger([b]));
  assert.equal(result.openPositions[0].valuationStatus, 'fresh');
  assert.ok(Math.abs(result.account.unrealizedPnlUsd + .2) < 1e-10);
  assert.ok(Math.abs(result.account.netLiquidationValueUsd - 99.8) < 1e-10);
  assert.equal(review(ledger([])).account.unrealizedPnlUsd, 0);
});

test('manual cash reset is financing, never strategy profit', () => {
  const b = buy(), s = sell(b, { price: .5 });
  const cashBefore = 100 + b.netUsd + s.netUsd;
  const adjustments = [{ id: 'manual_reset_test', kind: 'manual_paper_cash_reset', cashBefore, cashAfter: 100,
    amountUsd: 100 - cashBefore, tradeCount: 2, at: new Date(s.atMs + 1).toISOString() }];
  const result = review(ledger([b, s], { adjustments }));
  assert.ok(Math.abs(result.account.cashUsd - 100) < 1e-10);
  assert.ok(result.account.cashAdjustmentUsd > 0);
  assert.ok(result.account.realizedPnlUsd < 0);
  assert.ok(result.forward.currentVersion.netPnlUsd < 0);
  assert.equal(result.account.totalPnlIncludingOpenUsd, result.account.realizedPnlUsd);
});

test('CA concentration uses positive round profits, not net profit after losers', () => {
  const b1 = buy(BASE + 1000), b2 = buy(BASE + 3000), b3 = buy(BASE + 5000, OTHER);
  const result = review(ledger([b1, sell(b1), b2, sell(b2), b3, sell(b3, { price: .7 })]));
  const c = result.forward.currentVersion.concentration;
  assert.equal(c.caCount, 2); assert.equal(c.largestCaRoundShare, 2 / 3);
  assert.equal(c.largestCaPositivePnlShare, 1);
  assert.equal(result.forward.currentVersion.sampleStatus, 'collecting');
});

test('saved configuration does not manufacture first-three fills; recorded source yields actual counts', () => {
  const b = buy(), snap = snapshot();
  let result = review(ledger([b, sell(b)]), { snapshot: snap });
  assert.equal(result.firstThreeRoute.configured.maxUniqueCA, 3);
  assert.equal(result.firstThreeRoute.actual.forwardBuys, 0);
  b.entryEvidence = entryEvidence('monitored_event');
  b.entryEvidence.opportunity.event = { source: 'new_pool_first_three' };
  result = review(ledger([b, sell(b)]), { snapshot: snap });
  assert.equal(result.firstThreeRoute.actual.forwardBuys, 1);
  assert.equal(result.firstThreeRoute.actual.currentVersionForwardClosedRounds, 1);
  assert.equal(result.forward.currentVersion.byChainRoute[0].route, 'new_pool_first_three');
  assert.equal(review(ledger([])).firstThreeRoute.configured.observed, false);
});

test('unknown model costs remain null; missing pullback target proof remains unknown', () => {
  const b = buy(BASE + 1000, CA, 'external_pullback'), s = sell(b);
  delete b.costsUsd;
  assert.equal(review(ledger([b, s])).forward.currentVersion.modelCostsUsd, null);
  delete b.entryEvidence.opportunity.pattern.targetSelectionVersion;
  assert.equal(review(ledger([b, s])).forward.mixedOrMissingVersion.closedRounds, 1);
});

test('review milestones do not grant promotion or override route-specific frozen requirements', () => {
  const trades = [];
  for (let i = 0; i < 30; i++) {
    const address = `0x${(i % 10 + 1).toString(16).padStart(40, '0')}`;
    const b = buy(BASE + 1000 + i * 3 * 3_600_000, address);
    trades.push(b, sell(b));
  }
  const data = ledger(trades), nowMs = BASE + 4 * 86_400_000;
  data.account.updatedAt = new Date(nowMs).toISOString();
  const result = reviewPaperForward(data, { nowMs });
  assert.equal(result.forward.currentVersion.sampleStatus, 'ready_for_review');
  assert.equal(result.forward.currentVersion.closedRounds, 30);
  assert.equal(result.forward.currentVersion.automaticPromotion, false);
  assert.equal(result.automaticParameterChanges, false);
});

test('wrong sessions, weakened snapshots, duplicate IDs, oversells and unreconciled cash fail closed', () => {
  const b = buy(), data = ledger([b, sell(b)]);
  const wrong = structuredClone(data); wrong.session.id = 'other';
  assert.throws(() => review(wrong), /session/);
  const snap = snapshot(); delete snap.strategyValidationRequirements.exitStructureObservationVersion;
  assert.throws(() => review(data, { snapshot: snap }), /requirements/);
  const newer = snapshot(); newer.strategyValidationRequirements.additionalFutureProof = 'new_v1';
  assert.throws(() => review(data, { snapshot: newer }), /requirements/);
  const duplicate = structuredClone(data); duplicate.account.trades[1].id = duplicate.account.trades[0].id;
  assert.throws(() => review(duplicate), /history/);
  const oversell = structuredClone(data); oversell.account.trades[1].quantity = 11;
  oversell.account.trades[1].grossUsd = 13.2;
  assert.throws(() => review(oversell), /inventory/);
  const cash = structuredClone(data); cash.account.cash += 1;
  assert.throws(() => review(cash), /balance/);
  assert.throws(() => reviewPaperForward(data, { nowMs: BASE - 1 }), /time/);
});

test('CLI emits parseable machine JSON without changing input files or writing output artifacts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-forward-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json'), snapFile = path.join(dir, 'snapshot.json');
  const b = buy(), raw = JSON.stringify(ledger([b, sell(b)]));
  await fs.writeFile(file, raw); await fs.writeFile(snapFile, JSON.stringify(snapshot()));
  const report = await runForwardReviewCli(['--ledger', file, '--snapshot', snapFile, '--now', new Date(NOW).toISOString()]);
  assert.equal(report.inputs.ledger.sha256, createHash('sha256').update(raw).digest('hex'));
  const result = spawnSync(process.execPath, ['scripts/review-paper-forward.js', '--ledger', file, '--now', new Date(NOW).toISOString()],
    { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).forward.currentVersion.closedRounds, 1);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['ledger.json', 'snapshot.json']);
  await assert.rejects(runForwardReviewCli(['--ledger', file, '--now', '2026-10-11T14:51:42']), /timezone/);
});
