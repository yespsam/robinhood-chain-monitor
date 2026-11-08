// Paper-main admission: evidence tiers decide (1) whether a fill may use main
// paper cash, (2) whether breakout chasing is allowed, and (3) the friction
// (round-trip cost) budget. Paper only; never authorizes signing/broadcast.
import { paperControlScore } from './paper-control-score.js';

export const PAPER_CHASE_GATE_VERSION = 'evidence_tier_chase_gate_v1';
// 叙事证据阈值
export const NARRATIVE_MEDIUM_MIN_SCORE = 50;
export const NARRATIVE_MEDIUM_MIN_SOURCES = 1;
// 证据分级的往返摩擦预算（占单笔预算比例）
export const FRICTION_BUDGET = Object.freeze({
  shadow_only: 0,          // 弱证据：不占主盘，主盘预算为 0
  // gate-relax 2026-10-31: 4%/8% → 8%/12%，与 paper-cost-policy 证据分级上限对齐
  base: (v => Number.isFinite(v) && v > 0 && v <= .15 ? v : .08)(Number(process.env.PAPER_COST_CAP_NARRATIVE)),          // 叙事达标、控盘未达标
  chase: (v => Number.isFinite(v) && v > 0 && v <= .15 ? v : .12)(Number(process.env.PAPER_COST_CAP_NARRATIVE_CONTROL)), // 叙事 + 控盘齐：允许追突破
});
// 链加成：BSC 实测中位成本更高，给额外空间（加到上面的值上）
export const CHAIN_FRICTION_BONUS = Object.freeze({ bsc: .01 });
const BREAKOUT_ROUTES = new Set(['external_breakout', 'external_trend']);

export function narrativeTier(evidence = {}) {
  const a = evidence.narrativeAssessment;
  const score = Number(a?.evidenceScore) || 0, sources = Number(a?.independentSourceCount) || 0;
  const ok = a?.eligible === true && score >= NARRATIVE_MEDIUM_MIN_SCORE && sources >= NARRATIVE_MEDIUM_MIN_SOURCES;
  return { ok, score, sources, eligible: a?.eligible === true };
}

// Confirmed PVP without a route is a momentum (rising-quote) chase.
export const isBreakoutEntry = evidence => !evidence?.opportunity || BREAKOUT_ROUTES.has(evidence.opportunity.id);

export function paperChaseGate(evidence = {}, { chain = null, costRate = null } = {}) {
  const narrative = narrativeTier(evidence), control = paperControlScore(evidence);
  const canChaseBreakout = narrative.ok && control.ok;
  const tier = !narrative.ok ? 'shadow_only' : canChaseBreakout ? 'chase' : 'base';
  const frictionBudget = tier === 'shadow_only' ? 0 : FRICTION_BUDGET[tier] + (CHAIN_FRICTION_BONUS[String(chain || '').toLowerCase()] || 0);
  const breakout = isBreakoutEntry(evidence);
  const reasons = [];
  if (tier === 'shadow_only') reasons.push('叙事证据不足（无叙事/exploratory），只进影子研究账本，不占主盘现金');
  else if (breakout && !canChaseBreakout) reasons.push(control.status === 'unknown' ? '控盘数据未知，不允许追突破' : '控盘证据不足，不允许追突破');
  if (tier !== 'shadow_only' && !(Number.isFinite(costRate) && costRate >= 0)) reasons.push('往返成本无效');
  else if (tier !== 'shadow_only' && costRate > frictionBudget) reasons.push(`往返成本 ${(costRate * 100).toFixed(2)}% 超过${tier === 'chase' ? '可追' : '基础'}摩擦预算 ${(frictionBudget * 100).toFixed(2)}%`);
  return { version: PAPER_CHASE_GATE_VERSION, tier, canChaseBreakout, breakout, frictionBudget, costRate,
    narrative, control, mainAllowed: reasons.length === 0, shadowOnly: reasons.length > 0, reasons };
}
