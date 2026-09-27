import { createPaperStrategyAccount, validatePaperStrategyAccount, advancePaperStrategyAccount } from './paper-strategy-engine.js';
import { validLearningPolicy } from './wallet-learning.js';

export function validateLearningShadow(pair) {
  if (!pair || pair.schema !== 'yesp_learning_pair_v1' || !Number.isFinite(Date.parse(pair.startedAt))
    || pair.student?.variant !== 'distilled_shadow' || pair.control?.variant !== 'learning_control'
    || pair.student.initialCash !== 100 || pair.control.initialCash !== 100) throw new Error('invalid learning comparison; not reset');
  validatePaperStrategyAccount(pair.student); validatePaperStrategyAccount(pair.control); return true;
}
export function advanceLearningShadow(pair, { report, chain, evaluations, marksFor, enabled, nowMs }) {
  const personaPolicies = (report?.personaPolicies || []).filter(p => validLearningPolicy(p, chain, nowMs));
  const policy = (report?.lastError ? [] : personaPolicies.length ? personaPolicies : report?.policies || []).filter(p => validLearningPolicy(p, chain, nowMs))
    .sort((a, b) => b.teacherCount - a.teacherCount || (b.group === 'gmgn_fomo') - (a.group === 'gmgn_fomo') || String(a.personaId || '').localeCompare(String(b.personaId || '')))[0];
  if (!pair && (!policy || !enabled)) return null;
  if (pair) validateLearningShadow(pair);
  else pair = { schema: 'yesp_learning_pair_v1', startedAt: new Date(nowMs).toISOString(),
    control: { ...createPaperStrategyAccount({ nowMs }), variant: 'learning_control' },
    student: { ...createPaperStrategyAccount({ nowMs }), variant: 'distilled_shadow' } };
  const options = { evaluations, enabled: enabled && !!policy, nowMs };
  return { ...pair, latestPolicy: policy || null,
    control: advancePaperStrategyAccount(pair.control, { ...options, marks: marksFor(pair.control) }),
    student: advancePaperStrategyAccount(pair.student, { ...options, marks: marksFor(pair.student), distilledPolicy: policy }) };
}
export function learningShadowSummary(pair) {
  if (!pair) return { status: 'collecting', startedAt: null, control: null, student: null, promotion: false };
  const summarize = account => ({ cash: account.cash, entries: account.stats.entries, exits: account.stats.exits,
    netPnl: (account.stats.netLiquidationValue ?? account.cash) - account.initialCash, stalePositions: account.stats.stalePositions,
    positions: Object.values(account.positions), trades: account.trades.slice(-30) });
  return { status: 'forward_paper', startedAt: pair.startedAt, control: summarize(pair.control), student: summarize(pair.student), promotion: false,
    personaId: pair.latestPolicy?.personaId || null,
    note: '同期独立各 100 美元虚拟对照，同数据与成本模型；成交机会可因持仓期限不同而分化，不合并到主账户' };
}
