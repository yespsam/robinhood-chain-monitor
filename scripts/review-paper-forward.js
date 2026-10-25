// Offline, stdout-only audit. Never fetches quotes, edits a ledger or promotes a strategy.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { completedPaperRounds } from '../src/paper-confirmed-policy.js';
import { traderReview } from '../src/paper-trader-reasoning.js';
import { classifyStrategyCohort } from '../dashboard/strategy-cohorts.js';
import { gmgnFlowAddress } from '../src/gmgn-flow-signal.js';

export const FORWARD_BASELINE = '2026-10-10T14:51:42.000Z';
export const EXPECTED_SESSION = 'confirmed-pvp-v2-estimated-20260928';
export const MARK_MAX_AGE_MS = 15_000;
// Pinned to the verified reload, not inferred from the newest trade. If the
// runtime changes, a saved snapshot fails closed instead of moving the baseline.
export const FORWARD_REQUIREMENTS = Object.freeze({
  opportunityMode: 'multi_setup_v2', operatingPolicy: Object.freeze({ continuous: true }),
  mainExitPolicy: Object.freeze({ version: 'meme_evidence_exit_v2' }),
  strategyValidationRequirements: Object.freeze({
    entryFlowVersion: 'paper_entry_observed_outflow_v1',
    exitObservationVersion: 'entry_cohort_sell_retention_v1',
    exitStructureObservationVersion: 'independent_confirmed_trail_v1',
    entryStructureBySetup: Object.freeze(Object.fromEntries(['external_breakout', 'external_pullback', 'external_trend']
      .map(id => [id, 'reconstructed_ohlcv_entry_v1']))),
    targetSelectionBySetup: Object.freeze({ external_pullback: 'pullback_nearest_observed_level_v1' }),
    entryCostVersion: 'isolated_estimated_cost_v1', exitCostVersion: 'isolated_estimated_cost_v1',
  }),
});
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const stamp = x => typeof x === 'number' ? x : Date.parse(x || '');
const iso = x => Number.isFinite(x) ? new Date(x).toISOString() : null;
const sum = (rows, f) => rows.reduce((n, row) => n + f(row), 0);
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(1e-7, Math.abs(a) * 1e-8, Math.abs(b) * 1e-8);
const fail = code => { throw new Error(code); };
const addressKey = x => `${x.chain}:${x.address}`;
const isFirstThree = entry => entry.entryEvidence?.opportunity?.event?.source === 'new_pool_first_three';
const route = entry => isFirstThree(entry) ? 'new_pool_first_three' : entry.entryEvidence?.opportunity?.id || 'legacy_unknown';

function validateLedger(ledger, nowMs) {
  const a = ledger?.account;
  if (ledger?.schema !== 'yesp_atm_runtime_v1' || ledger.session?.id !== EXPECTED_SESSION
    || ledger.session.mode !== 'paper' || ledger.session.costModel !== 'isolated_estimated_cost_v1'
    || a?.schema !== 'yesp_atm_strategy_paper_v1' || a.mode !== 'paper'
    || a.execution !== false || a.signing !== false || a.broadcast !== false
    || a.estimatedCostModel !== 'isolated_estimated_cost_v1' || a.initialCash !== 100
    || !finite(a.cash) || a.cash < 0 || !finite(a.realizedPnl) || !object(a.positions)
    || !Array.isArray(a.trades) || !finite(stamp(a.updatedAt)) || stamp(a.updatedAt) > nowMs)
    fail('paper_session_or_account_invalid');
  const ids = new Set(), inventory = new Map(); let previous = 0;
  for (const t of a.trades) {
    if (!object(t) || typeof t.id !== 'string' || !t.id || ids.has(t.id)
      || !['buy', 'sell', 'writeoff'].includes(t.side) || typeof t.address !== 'string'
      || !gmgnFlowAddress(t.chain, t.address) || gmgnFlowAddress(t.chain, t.address) !== t.address
      || !Number.isSafeInteger(t.atMs) || t.atMs <= 0 || t.atMs < previous || t.atMs > stamp(a.updatedAt)
      || !positive(t.quantity) || !finite(t.price) || t.price < 0 || t.side !== 'writeoff' && t.price === 0
      || ![t.grossUsd, t.netUsd, t.costBasisUsd, t.realizedPnl].every(finite)
      || t.costBasisUsd < 0 || t.costsUsd != null && (!finite(t.costsUsd) || t.costsUsd < 0)
      || !close(t.grossUsd, t.quantity * t.price)
      || t.side === 'writeoff' && (t.price !== 0 || t.netUsd !== 0 || t.costsUsd !== 0)) fail('trade_history_invalid');
    ids.add(t.id); previous = t.atMs;
    const key = addressKey(t), lot = inventory.get(key);
    if (t.side === 'buy') {
      if (lot || !close(t.realizedPnl, 0) || !close(-t.netUsd, t.costBasisUsd)
        || finite(t.costsUsd) && !close(t.costBasisUsd, t.grossUsd + t.costsUsd)) fail('buy_inventory_invalid');
      inventory.set(key, { quantity: t.quantity, initialQuantity: t.quantity, basis: t.costBasisUsd, entry: t });
    } else {
      if (!lot || t.quantity > lot.quantity * (1 + 1e-9)
        || !close(t.costBasisUsd, lot.basis * t.quantity / lot.quantity)
        || !close(t.realizedPnl, t.netUsd - t.costBasisUsd)
        || finite(t.costsUsd) && !close(t.netUsd, t.grossUsd - t.costsUsd)) fail('exit_inventory_invalid');
      lot.quantity -= t.quantity; lot.basis -= t.costBasisUsd;
      if (lot.quantity <= lot.initialQuantity * 1e-9) inventory.delete(key);
    }
  }
  if (inventory.size !== Object.keys(a.positions).length) fail('open_inventory_mismatch');
  for (const [key, p] of Object.entries(a.positions)) {
    const lot = inventory.get(key);
    if (key !== addressKey(p) || !lot || !close(p.quantity, lot.quantity) || !close(p.costBasisUsd, lot.basis)
      || stamp(p.openedAt) !== lot.entry.atMs) fail('open_inventory_mismatch');
  }
  const adjustments = a.cashAdjustments ?? [], adjustmentIds = new Set(); let funding = 0, lastAdjustmentAt = 0;
  if (!Array.isArray(adjustments)) fail('cash_adjustments_invalid');
  for (const c of adjustments) {
    const at = stamp(c.at);
    if (!object(c) || typeof c.id !== 'string' || !c.id || adjustmentIds.has(c.id)
      || c.kind !== 'manual_paper_cash_reset' || !finite(c.amountUsd) || !finite(at) || at < lastAdjustmentAt
      || at > stamp(a.updatedAt) || !Number.isSafeInteger(c.tradeCount) || c.tradeCount < 0 || c.tradeCount > a.trades.length
      || c.cashAfter !== 100 || !close(c.cashAfter - c.cashBefore, c.amountUsd)
      || !close(c.cashBefore, a.initialCash + funding + sum(a.trades.slice(0, c.tradeCount), t => t.netUsd))
      || a.trades.slice(0, c.tradeCount).some(t => t.atMs > at)
      || a.trades.slice(c.tradeCount).some(t => t.atMs < at)) fail('cash_adjustments_invalid');
    adjustmentIds.add(c.id); funding += c.amountUsd; lastAdjustmentAt = at;
  }
  const realized = sum(a.trades, t => t.realizedPnl), basis = sum(Object.values(a.positions), p => p.costBasisUsd);
  if (!close(realized, a.realizedPnl) || !close(a.cash, a.initialCash + funding + sum(a.trades, t => t.netUsd))
    || !close(a.cash + basis, a.initialCash + funding + realized)) fail('account_balance_not_reconciled');
  return { inventory, funding, basis };
}

function validateSnapshot(snapshot, nowMs) {
  if (!snapshot) return;
  if (snapshot.session?.id !== EXPECTED_SESSION || snapshot.mode !== 'paper'
    || snapshot.execution !== false || snapshot.signing !== false || snapshot.broadcast !== false
    || !finite(stamp(snapshot.updatedAt)) || stamp(snapshot.updatedAt) > nowMs) fail('snapshot_identity_or_time_invalid');
  const expected = FORWARD_REQUIREMENTS, actual = snapshot.strategyValidationRequirements;
  if (snapshot.opportunityMode !== expected.opportunityMode || snapshot.operatingPolicy?.continuous !== true
    || snapshot.mainExitPolicy?.version !== expected.mainExitPolicy.version || !object(actual)) fail('snapshot_requirements_mismatch');
  if (Object.keys(actual).some(key => key !== 'note' && !Object.hasOwn(expected.strategyValidationRequirements, key)))
    fail('snapshot_requirements_mismatch');
  for (const [key, value] of Object.entries(expected.strategyValidationRequirements)) {
    if (object(value) ? Object.keys(value).length !== Object.keys(actual[key] || {}).length
      || Object.entries(value).some(([k, v]) => actual[key]?.[k] !== v) : actual[key] !== value)
      fail('snapshot_requirements_mismatch');
  }
}

function classify(round, nowMs) {
  const cohort = traderReview([round], nowMs).cohorts[0];
  const result = classifyStrategyCohort(cohort, FORWARD_REQUIREMENTS);
  const mixed = ['entryFlowVersionEvidence', 'exitVersionEvidence', 'exitObservationVersionEvidence',
    'exitStructureObservationVersionEvidence', 'exitCostVersionEvidence']
    .filter(key => ['mixed', 'partial', 'conflict'].includes(cohort[key]));
  if (mixed.length) { result.status = 'unknown'; result.reasons.push(...mixed); }
  // Frozen exit intent is separate from what actually ran; both are required.
  if (cohort.entryExitVersion !== FORWARD_REQUIREMENTS.mainExitPolicy.version) {
    result.status = cohort.entryExitVersion === 'legacy_unversioned' ? 'unknown' : result.status === 'unknown' ? 'unknown' : 'legacy';
    result.reasons.push('frozen_entry_exit_version');
  }
  return { ...result, cohort };
}

function summarize(rounds, nowMs) {
  const review = traderReview(rounds, nowMs), groups = new Map(), tokens = new Map();
  for (const r of rounds) {
    const group = `${r.entry.chain}:${route(r.entry)}`, ca = addressKey(r.entry);
    if (!groups.has(group)) groups.set(group, { chain: r.entry.chain, route: route(r.entry), rounds: [] });
    groups.get(group).rounds.push(r);
    if (!tokens.has(ca)) tokens.set(ca, { chain: r.entry.chain, address: r.entry.address, rounds: 0, netPnlUsd: 0, positivePnlUsd: 0 });
    const token = tokens.get(ca); token.rounds++; token.netPnlUsd += r.pnl; token.positivePnlUsd += Math.max(0, r.pnl);
  }
  const positiveTotal = sum([...tokens.values()], t => t.positivePnlUsd);
  return { ...review.overall,
    byChainRoute: [...groups.values()].map(g => ({ chain: g.chain, route: g.route, ...traderReview(g.rounds, nowMs).overall })),
    concentration: { caCount: tokens.size, largestCaRoundShare: rounds.length ? Math.max(...[...tokens.values()].map(t => t.rounds)) / rounds.length : null,
      largestCaPositivePnlShare: positiveTotal > 0 ? Math.max(...[...tokens.values()].map(t => t.positivePnlUsd)) / positiveTotal : null,
      denominator: 'sum_of_positive_round_pnl_not_total_net_pnl', byCA: [...tokens.values()] },
    cohorts: review.cohorts, automaticPromotion: false };
}

export function reviewPaperForward(ledger, { nowMs = Date.now(), snapshot = null } = {}) {
  if (!finite(nowMs) || nowMs < Date.parse(FORWARD_BASELINE)) fail('review_time_invalid');
  const { inventory, funding, basis } = validateLedger(ledger, nowMs); validateSnapshot(snapshot, nowMs);
  const a = ledger.account, baseline = Date.parse(FORWARD_BASELINE);
  const rounds = completedPaperRounds(a.trades);
  const forward = rounds.filter(r => r.entry.atMs >= baseline), current = [], legacy = [], unknown = [], classifications = [];
  for (const r of forward) {
    const c = classify(r, nowMs);
    ({ current, legacy, unknown })[c.status].push(r);
    classifications.push({ entryId: r.entry.id, exitIds: r.exits.map(t => t.id), chain: r.entry.chain,
      address: r.entry.address, route: route(r.entry), openedAt: iso(r.entry.atMs), closedAt: iso(r.at),
      netPnlUsd: r.pnl, status: c.status, reasons: c.reasons });
  }
  const positions = Object.entries(a.positions).map(([key, p]) => {
    const entry = inventory.get(key).entry, at = stamp(p.markAt), age = finite(at) ? nowMs - at : null;
    const complete = positive(p.markPrice) && finite(p.markValue) && p.markValue >= 0 && finite(p.estimatedExitCostsUsd)
      && p.estimatedExitCostsUsd >= 0 && finite(p.pnl) && close(p.markValue, p.quantity * p.markPrice)
      && close(p.pnl, p.markValue - p.estimatedExitCostsUsd - p.costBasisUsd);
    const status = !finite(at) ? 'missing_timestamp' : age < 0 ? 'future_timestamp' : age > MARK_MAX_AGE_MS ? 'stale'
      : p.markStatus !== 'ok' || !complete ? 'incomplete_or_inconsistent' : 'fresh';
    return { key, chain: p.chain, address: p.address, route: route(entry), entryId: entry.id,
      openedAt: p.openedAt, enteredAfterBaseline: entry.atMs >= baseline, quantity: p.quantity, costBasisUsd: p.costBasisUsd,
      valuationStatus: status, markAt: iso(at), valuationAgeMs: age, maxValuationAgeMs: MARK_MAX_AGE_MS,
      lastRecorded: { markPrice: p.markPrice ?? null, markValueUsd: p.markValue ?? null, unrealizedPnlUsd: p.pnl ?? null },
      currentMarkValueUsd: status === 'fresh' ? p.markValue : null,
      currentNetLiquidationUsd: status === 'fresh' ? p.markValue - p.estimatedExitCostsUsd : null,
      currentUnrealizedPnlUsd: status === 'fresh' ? p.pnl : null };
  });
  const valuationComplete = positions.every(p => p.valuationStatus === 'fresh');
  const unrealized = valuationComplete ? sum(positions, p => p.currentUnrealizedPnlUsd) : null;
  const buys = a.trades.filter(t => t.side === 'buy'), firstThree = buys.filter(isFirstThree);
  const forwardFills = a.trades.filter(t => t.atMs >= baseline), policy = snapshot?.poolFirstThreePolicy;
  return { version: 'paper_forward_review_v1', mode: 'read_only_local_review', execution: false, signing: false, broadcast: false,
    automaticParameterChanges: false, automaticPromotion: false, generatedAt: iso(nowMs), sessionId: EXPECTED_SESSION,
    entryFrom: FORWARD_BASELINE, baselineEvidence: 'docs/strategy-entry-exit-proof-2026-10-10.md',
    requirementSource: snapshot ? 'pinned_reload_requirements_checked_against_saved_snapshot' : 'pinned_verified_reload_requirements',
    requirements: FORWARD_REQUIREMENTS,
    snapshot: snapshot ? { updatedAt: snapshot.updatedAt, ageMs: nowMs - stamp(snapshot.updatedAt) } : null,
    history: { sourceUpdatedAt: a.updatedAt, tradeCount: a.trades.length, integrity: 'read_only_inventory_cash_and_realized_reconciled',
      allClosed: summarize(rounds, nowMs), preBaselineClosed: summarize(rounds.filter(r => r.at < baseline), nowMs),
      carriedInClosedAfterBaseline: summarize(rounds.filter(r => r.entry.atMs < baseline && r.at >= baseline), nowMs) },
    account: { initialCashUsd: a.initialCash, cashUsd: a.cash, cashAdjustmentUsd: funding,
      totalContributedUsd: a.initialCash + funding, cashAdjustments: structuredClone(a.cashAdjustments || []),
      modelCostsAllFillsUsd: a.trades.every(t => finite(t.costsUsd)) ? sum(a.trades, t => t.costsUsd) : null,
      remainingCostBasisUsd: basis, realizedPnlUsd: a.realizedPnl, unrealizedPnlUsd: unrealized,
      totalPnlIncludingOpenUsd: unrealized === null ? null : a.realizedPnl + unrealized,
      netLiquidationValueUsd: valuationComplete ? a.cash + sum(positions, p => p.currentNetLiquidationUsd) : null,
      valuationComplete, note: '补款不是利润；总已实现含未平仓头寸的部分卖出，不混入当前版本完整回合成绩。' },
    forward: { fills: forwardFills.length, buys: forwardFills.filter(t => t.side === 'buy').length,
      sells: forwardFills.filter(t => t.side === 'sell').length, writeoffs: forwardFills.filter(t => t.side === 'writeoff').length,
      realizedInWindowUsd: sum(forwardFills, t => t.realizedPnl),
      modelCostsForWindowFillsUsd: forwardFills.every(t => finite(t.costsUsd)) ? sum(forwardFills, t => t.costsUsd) : null,
      currentVersion: summarize(current, nowMs), legacyVersion: summarize(legacy, nowMs), mixedOrMissingVersion: summarize(unknown, nowMs),
      classifications },
    openPositions: positions,
    firstThreeRoute: { source: 'new_pool_first_three',
      configured: policy ? { observed: true, version: policy.version ?? null, maxUniqueCA: policy.maxUniqueCA ?? null, mode: policy.mode ?? null }
        : { observed: false, version: null, maxUniqueCA: null, mode: null },
      actual: { allHistoryBuys: firstThree.length, forwardBuys: firstThree.filter(t => t.atMs >= baseline).length,
        forwardDistinctCA: new Set(firstThree.filter(t => t.atMs >= baseline).map(addressKey)).size,
        forwardClosedRounds: forward.filter(r => isFirstThree(r.entry)).length,
        currentVersionForwardClosedRounds: current.filter(r => isFirstThree(r.entry)).length,
        openPositions: positions.filter(p => p.route === 'new_pool_first_three').length },
      note: '配置前三 CA 上限不等于产生三笔成交；只按冻结买入事件来源计数，不能用已配置代替实绩。' },
    limitations: ['仅本地模拟账本，不查询网络、不重放成交、不改账本或参数。',
      '当前版必须同时有冻结入场证据和实际退出版本；核销、混合或缺失退出证据不补写。',
      '模型成本不是链上实际费用；完整回合回撤不等于含浮亏的账户最大回撤。',
      '过期或未知持仓估值为 null，不按零计算；历史标记仅供定位，不作为当前净值。',
      '三十回合、十 CA、三天仅为现有描述性复核起点，不证明优势、不自动晋升或保证盈利。'],
  };
}

export async function runForwardReviewCli(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--ledger', '--snapshot', '--now'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('usage: --ledger PATH [--snapshot PATH] [--now ISO_WITH_TIMEZONE]');
    options[args[i]] = args[i + 1];
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ledgerPath = path.resolve(options['--ledger'] || path.join(root, 'data', `yesp-atm-${EXPECTED_SESSION}.json`));
  const snapshotPath = options['--snapshot'] ? path.resolve(options['--snapshot']) : null;
  if (options['--now'] && !/(?:Z|[+-]\d{2}:\d{2})$/.test(options['--now'])) fail('explicit_review_timezone_required');
  const readJson = async file => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024) fail('input_file_invalid');
    const raw = await fs.readFile(file, 'utf8');
    return { value: JSON.parse(raw), sha256: createHash('sha256').update(raw).digest('hex') };
  };
  const [ledger, snapshot] = await Promise.all([readJson(ledgerPath), snapshotPath ? readJson(snapshotPath) : null]);
  const report = reviewPaperForward(ledger.value, { nowMs: options['--now'] ? Date.parse(options['--now']) : Date.now(), snapshot: snapshot?.value });
  return { ...report, inputs: { ledger: { path: ledgerPath, sha256: ledger.sha256 },
    snapshot: snapshot ? { path: snapshotPath, sha256: snapshot.sha256 } : null } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runForwardReviewCli(process.argv.slice(2)).then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${JSON.stringify({ status: 'error', error: error.message, modifiedFiles: false })}\n`); process.exitCode = 1; });
}
