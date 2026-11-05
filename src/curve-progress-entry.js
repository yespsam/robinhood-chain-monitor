// Inner-curve entry gate for the paper session that live mirrors
// (paper-atm-confirmed-pvp-v2). GMGN already normalizes bondingCurveProgress
// as a fraction in [0, 1] (see gmgn-readonly-market.js). This module does not
// sign or broadcast.
//
// Bounds are percentages. Default window is 30–70. A known progress outside
// that window is skipped. Unknown progress on a flap inner-curve entry is
// also skipped: that is the safer LIVE default, because a missing figure is
// not evidence the token is in the researched window.
//
// Non-curve venues are not gated. Flap Pool Launch (DIRECT_V2_POOL_TAX)
// skips the bonding curve. External / graduated markets are not inner-curve.
// new_pool_first_three without a progress figure is a creation-order lane,
// not a progress lane, so a missing figure does not skip it. A known progress
// on that flap curve signal is still checked.

const FLAP_CURVE_LAUNCHPAD = /^(flap|flap_stocks|flap_aioracle)$/i;

function disabled(value) {
  return /^false$/i.test(String(value ?? ""));
}

function percentBound(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return fallback;
  return value;
}

export function curveProgressConfig(env = process.env) {
  const enabled = !disabled(env?.CURVE_PROGRESS_ENTRY_FILTER);
  let minPct = percentBound(env?.CURVE_PROGRESS_MIN, 30);
  let maxPct = percentBound(env?.CURVE_PROGRESS_MAX, 70);
  if (minPct >= maxPct) { minPct = 30; maxPct = 70; }
  return { enabled, minPct, maxPct, unknownPolicy: "skip" };
}

// Fraction [0, 1] (GMGN bondingCurveProgress) or an already-percent figure
// in (1, 100]. Anything else is unknown.
export function curveProgressPercent(value) {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return value * 100;
  if (value > 1 && value <= 100) return value;
  return null;
}

// GMGN bondingCurveProgress is a fraction of 1. A percent figure in (1, 100]
// is converted back to that fraction. Anything else stays unknown — never a guess.
export function bondingCurveProgressFraction(value) {
  const pct = curveProgressPercent(value);
  return pct === null ? null : pct / 100;
}

function progressCandidates(token, event) {
  return [
    token?.bondingCurveProgress,
    token?.curveProgress,
    event?.bondingCurveProgress,
    event?.curveProgress,
    event?.pool?.bondingCurveProgress,
    event?.pool?.curveProgress,
  ];
}

function readProgress(token, event) {
  for (const value of progressCandidates(token, event)) {
    if (value === undefined) continue;
    return curveProgressPercent(value);
  }
  return null;
}

function hasProgressInput(token, event) {
  return progressCandidates(token, event).some((value) => value !== undefined);
}

// Fraction stored for later bucket analysis. Null means the figure was absent
// or not a usable progress, not that the curve is at 0%.
export function curveProgressSnapshot(token = {}, event = null) {
  let fraction = null;
  for (const value of progressCandidates(token, event)) {
    if (value === undefined) continue;
    const next = bondingCurveProgressFraction(value);
    if (next !== null) { fraction = next; break; }
  }
  return {
    bondingCurveProgress: fraction,
    bondingCurveProgressStatus: fraction === null ? "unknown" : "known",
  };
}

// Flap / inner-curve rows, plus the internal lane, keep an explicit progress
// field even when the 30–70 gate does not apply.
export function curveProgressTracked(token = {}, event = null, { strategyId = null } = {}) {
  if (strategyId === "internal") return true;
  if (["internal", "near_completion"].includes(token?.marketStage)) return true;
  if (["new_creation", "near_completion"].includes(token?.marketCategory)) return true;
  if (FLAP_CURVE_LAUNCHPAD.test(flapLaunchpad(token))) return true;
  if (event?.source === "flap_pool_launch" || event?.pool?.platform === "flap" || event?.pool?.launchKind === "DIRECT_V2_POOL_TAX") return true;
  return flapCurveProgressApplies(token, event);
}

function isPoolLaunch(event) {
  return event?.source === "flap_pool_launch" || event?.pool?.launchKind === "DIRECT_V2_POOL_TAX";
}

function isInnerCurve(token) {
  return ["internal", "near_completion"].includes(token?.marketStage)
    || ["new_creation", "near_completion"].includes(token?.marketCategory);
}

function flapLaunchpad(token) {
  return String(token?.launchpadPlatform || token?.launchpad || "");
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "未知";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

// Returns whether this entry is a flap bonding-curve entry the gate should see.
export function flapCurveProgressApplies(token = {}, event = null) {
  if (isPoolLaunch(event)) return false;
  if (token?.marketStage === "external" || token?.marketCategory === "completed") return false;
  if (FLAP_CURVE_LAUNCHPAD.test(flapLaunchpad(token)) && isInnerCurve(token)) return true;
  if (event?.source === "new_pool_first_three" && event?.pool?.platform === "flap" && hasProgressInput(token, event)) return true;
  return false;
}

export function curveProgressEntryDecision({ token = {}, event = null, env = process.env } = {}) {
  const config = curveProgressConfig(env);
  const base = {
    applied: false, allow: true, decision: null, reason: null, progressPct: null,
    minPct: config.minPct, maxPct: config.maxPct, unknownPolicy: config.unknownPolicy,
    venue: "not_curve",
    launchpadPlatform: token?.launchpadPlatform ?? null,
    launchpad: token?.launchpad ?? null,
    marketCategory: token?.marketCategory ?? null,
    bondingCurveProgress: token?.bondingCurveProgress ?? null,
  };
  if (!config.enabled || !flapCurveProgressApplies(token, event)) return base;
  const progressPct = readProgress(token, event);
  const venue = "flap_bonding_curve";
  if (progressPct === null) {
    const reason = `内盘曲线进度未知，跳过入场（LIVE 安全默认：缺少 bondingCurveProgress，不把未知当成 ${config.minPct}–${config.maxPct}%）`;
    return { ...base, applied: true, allow: false, decision: "观察", reason, venue, progressPct: null };
  }
  if (progressPct < config.minPct || progressPct > config.maxPct) {
    const reason = `内盘曲线进度 ${formatPct(progressPct)}% 不在 ${config.minPct}–${config.maxPct}%，跳过入场`;
    return { ...base, applied: true, allow: false, decision: "观察", reason, venue, progressPct };
  }
  return { ...base, applied: true, allow: true, decision: null, reason: null, venue, progressPct };
}

export function curveProgressBlocksEntry(evidence, event = null, env = process.env) {
  const stored = evidence?.curveProgressGate;
  const decision = curveProgressEntryDecision({
    token: {
      marketStage: evidence?.marketStage,
      marketCategory: stored?.marketCategory ?? evidence?.marketCategory,
      launchpadPlatform: stored?.launchpadPlatform,
      launchpad: stored?.launchpad,
      bondingCurveProgress: stored?.bondingCurveProgress ?? evidence?.bondingCurveProgress,
      curveProgress: stored?.curveProgress,
    },
    event: event || evidence?.opportunity?.event || null,
    env,
  });
  return decision.applied === true && decision.allow !== true;
}
