// System Quality Number for the active paper ledger. This does not sign,
// broadcast, or enable LIVE. SQN is Van Tharp's: (mean R / sample stdev) * sqrt(N).
// Each R is a fully closed round's net realized PnL divided by its frozen
// planned stop-loss risk in USD. Missing risk data blocks promotion.
import fs from "node:fs/promises";
import path from "node:path";

const PAPER_RISK_VERSION = "paper_planned_stop_r_v1";

function plannedRiskForEntry(trade) {
  const risk = trade?.entryEvidence?.paperRisk;
  if (risk && typeof risk === "object") {
    return risk.version === PAPER_RISK_VERSION
      ? { riskUsd: finite(risk.riskUsd), riskSource: "versioned" }
      : { riskUsd: null, riskSource: "unknown_version" };
  }
  const plan = trade?.entryEvidence?.entryPlan;
  if (plan && Object.hasOwn(plan, "estimatedStopLossUsd")) {
    const value = finite(plan.estimatedStopLossUsd);
    return { riskUsd: value > 0 ? value : null, riskSource: value > 0 ? "legacy_stored" : "missing" };
  }

  // Older immutable buy rows may have the exact stop and cost inputs used by
  // paper-strategy-engine, but predate the persisted riskUsd field. Recompute
  // only from those frozen inputs, using the engine's original formula; never
  // infer risk from the eventual exit or fabricate a default denominator.
  const costs = trade?.entryEvidence?.costAssumptions;
  const plannedStop = finite(plan?.stopPrice);
  const quantity = finite(trade?.quantity);
  const budget = finite(trade?.costBasisUsd);
  const feeRate = finite(costs?.feeRate);
  const slippageRate = finite(costs?.slippageRate);
  const sellTax = finite(costs?.sellTax);
  const gasUsd = finite(costs?.gasUsd);
  if (!(plannedStop > 0 && quantity > 0 && budget > 0)
      || [feeRate, slippageRate, sellTax, gasUsd].some((value) => value === null)
      || feeRate < 0 || slippageRate < 0 || sellTax < 0
      || feeRate + slippageRate + sellTax >= 1 || gasUsd < 0) {
    return { riskUsd: null, riskSource: "missing" };
  }
  const riskUsd = budget - (quantity * plannedStop * (1 - feeRate - slippageRate - sellTax) - gasUsd);
  return Number.isFinite(riskUsd) && riskUsd > 0
    ? { riskUsd, riskSource: "legacy_recomputed" }
    : { riskUsd: null, riskSource: "missing" };
}

// Same aggregation as completedPaperRounds: one closed position is one trade.
// Partial sells stay inside that round. Kept local so this report does not
// load the paper engine or its wallet libraries.
export function closedPaperRounds(trades) {
  const open = new Map();
  const closed = [];
  for (const trade of trades) {
    if (!trade || typeof trade !== "object") continue;
    const key = `${trade.chain}:${trade.address}`;
    if (trade.side === "buy") {
      const quantity = Number(trade.quantity);
      const { riskUsd, riskSource } = plannedRiskForEntry(trade);
      open.set(key, { pnl: 0, left: quantity, quantity, riskUsd, riskSource, entry: trade, at: trade.atMs });
    } else {
      const lot = open.get(key);
      if (!lot) continue;
      const pnl = finite(trade.realizedPnl);
      if (pnl === null) lot.pnl = null;
      else if (lot.pnl !== null) lot.pnl += pnl;
      lot.left -= Number(trade.quantity);
      if (lot.left <= lot.quantity * 1e-9) {
        closed.push({ pnl: lot.pnl, riskUsd: lot.riskUsd, riskSource: lot.riskSource, at: trade.atMs ?? lot.at, entry: lot.entry });
        open.delete(key);
      }
    }
  }
  return closed;
}

const POINTERS = [
  "yesp-atm-active-estimated-session.json",
  "yesp-atm-active-paper-session.json",
];

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function disabledToken(raw) {
  return ["0", "false", "off"].includes(String(raw ?? "").trim().toLowerCase());
}

export function paperSqnConfig(env = process.env) {
  const sqnRaw = env?.LIVE_REQUIRE_PAPER_SQN;
  const closedRaw = env?.LIVE_REQUIRE_PAPER_CLOSED;
  let requiredSqn = 1.6;
  let sqnEnabled = true;
  if (sqnRaw === undefined || sqnRaw === null || sqnRaw === "") {
    requiredSqn = 1.6;
  } else if (disabledToken(sqnRaw)) {
    sqnEnabled = false;
    requiredSqn = null;
  } else {
    const n = Number(sqnRaw);
    requiredSqn = Number.isFinite(n) && n > 0 ? Math.max(1.6, n) : 1.6;
  }
  let requiredClosed = 30;
  let closedEnabled = true;
  if (closedRaw === undefined || closedRaw === null || closedRaw === "") {
    requiredClosed = 30;
  } else if (disabledToken(closedRaw)) {
    closedEnabled = false;
    requiredClosed = null;
  } else {
    const n = Number(closedRaw);
    requiredClosed = Number.isInteger(n) && n > 0 ? Math.max(30, n) : 30;
  }
  return { requiredSqn, sqnEnabled, requiredClosed, closedEnabled, enabled: sqnEnabled || closedEnabled };
}

export function systemQualityNumber(values) {
  const rs = (Array.isArray(values) ? values : []).map(finite).filter((n) => n !== null);
  const closed = rs.length;
  if (!closed) return { closed: 0, expectancy: null, stdev: null, sqn: null };
  const expectancy = rs.reduce((sum, n) => sum + n, 0) / closed;
  if (closed < 2) return { closed, expectancy, stdev: null, sqn: null };
  const variance = rs.reduce((sum, n) => sum + (n - expectancy) ** 2, 0) / (closed - 1);
  const stdev = Math.sqrt(variance);
  const sqn = stdev > 0 ? (expectancy / stdev) * Math.sqrt(closed) : null;
  return { closed, expectancy, stdev, sqn };
}

export function paperSqnReport(trades) {
  if (!Array.isArray(trades)) return { closed: 0, eligible: 0, riskMissing: 0, expectancy: null, stdev: null, sqn: null, missing: true };
  const rounds = closedPaperRounds(trades);
  let sampleStart = 0;
  let riskMissing = 0;
  let outcomeMissing = 0;
  const riskSources = { versioned: 0, legacy_stored: 0, legacy_recomputed: 0, missing: 0, unknown_version: 0 };
  for (let i = 0; i < rounds.length; i += 1) {
    const outcomeMissingHere = finite(rounds[i].pnl) === null;
    const riskMissingHere = !(finite(rounds[i].riskUsd) > 0);
    if (outcomeMissingHere) outcomeMissing += 1;
    if (riskMissingHere) riskMissing += 1;
    riskSources[rounds[i].riskSource || "missing"] = (riskSources[rounds[i].riskSource || "missing"] || 0) + 1;
    if (outcomeMissingHere || riskMissingHere) sampleStart = i + 1;
  }
  const eligible = rounds.slice(sampleStart);
  const report = systemQualityNumber(eligible.map((round) => round.pnl / round.riskUsd));
  return {
    ...report, closed: rounds.length, eligible: eligible.length,
    riskMissing, outcomeMissing, riskSources,
    eligibleSince: eligible[0]?.at ?? null, missing: false,
  };
}

function formatSqn(sqn) {
  if (sqn === Number.POSITIVE_INFINITY) return "∞";
  if (sqn === Number.NEGATIVE_INFINITY) return "-∞";
  if (typeof sqn !== "number" || !Number.isFinite(sqn)) return "不可计算";
  return sqn.toFixed(2);
}

export function paperPromotionDecision({ trades = null, sessionPresent = trades != null, env = process.env } = {}) {
  const config = paperSqnConfig(env);
  const base = {
    allow: true, reason: null, gate: "paper_promotion", disabled: !config.enabled,
    closed: 0, eligible: 0, riskMissing: 0, outcomeMissing: 0, riskSources: null, sqn: null, expectancy: null, stdev: null,
    requiredSqn: config.requiredSqn, requiredClosed: config.requiredClosed,
  };
  if (!config.sqnEnabled || !config.closedEnabled) {
    return { ...base, allow: false, disabled: true, reason: "LIVE 晋级保护门被关闭，拒绝新开仓" };
  }
  if (sessionPresent !== true || trades == null) {
    return {
      ...base, allow: false, closed: 0, sqn: null,
      reason: "缺少当前模拟盘账本，拒绝 LIVE 新开仓（无法计算 SQN 和已平仓笔数）",
    };
  }
  const report = paperSqnReport(trades);
  const reasons = [];
  if (config.closedEnabled && report.closed < config.requiredClosed) {
    reasons.push(`模拟盘已平仓 ${report.closed} 笔，少于 ${config.requiredClosed}`);
  } else if (config.closedEnabled && report.eligible < config.requiredClosed) {
      reasons.push(`计划风险/结果连续完整的 R 样本 ${report.eligible} 笔，少于 ${config.requiredClosed}；风险缺失 ${report.riskMissing} 笔、结果缺失 ${report.outcomeMissing} 笔，缺口处已重置样本`);
  }
  if (config.sqnEnabled && !(report.sqn >= config.requiredSqn)) {
    reasons.push(`模拟盘 SQN ${formatSqn(report.sqn)}，低于 ${config.requiredSqn}`);
  }
  return {
    ...base,
    allow: reasons.length === 0,
    reason: reasons.length ? `未达到 LIVE 晋升线：${reasons.join("；")}` : null,
    closed: report.closed,
    eligible: report.eligible,
    riskMissing: report.riskMissing,
    outcomeMissing: report.outcomeMissing,
    riskSources: report.riskSources,
    eligibleSince: report.eligibleSince,
    sqn: report.sqn,
    expectancy: report.expectancy,
    stdev: report.stdev,
  };
}

function tradesOf(doc) {
  if (Array.isArray(doc?.account?.trades)) return doc.account.trades;
  if (Array.isArray(doc?.trades)) return doc.trades;
  return null;
}

function paperLedger(doc) {
  const account = doc?.account;
  if (account && (account.mode && account.mode !== "paper" || account.execution === true || account.signing === true || account.broadcast === true)) {
    return { ok: false, reason: "账本不是已关闭执行的模拟盘，拒绝读取" };
  }
  const trades = tradesOf(doc);
  if (!trades) return { ok: false, reason: "模拟盘账本没有成交列表" };
  return { ok: true, trades, sessionId: doc?.session?.id || doc?.id || null };
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

export async function resolvePaperLedgerPath({ dataDir = "data", file = null } = {}) {
  if (file) return path.resolve(file);
  for (const name of POINTERS) {
    const pointerPath = path.join(dataDir, name);
    let pointer;
    try { pointer = await readJson(pointerPath); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (tradesOf(pointer)) return pointerPath;
    if (typeof pointer?.id === "string" && /^confirmed-pvp-v2-[a-z0-9-]{1,40}$/.test(pointer.id)) {
      return path.join(dataDir, `yesp-atm-${pointer.id}.json`);
    }
  }
  const legacy = path.join(dataDir, "yesp-atm-strategy-paper.json");
  try { await fs.access(legacy); return legacy; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function loadPaperSqnReport({ dataDir = "data", file = null, env = process.env } = {}) {
  let ledgerPath;
  try { ledgerPath = await resolvePaperLedgerPath({ dataDir, file }); }
  catch { return { ok: false, reason: "模拟盘账本无法读取", file: file || null, closed: 0, sqn: null }; }
  if (!ledgerPath) {
    return { ok: false, reason: "缺少当前模拟盘账本，拒绝 LIVE 新开仓（无法计算 SQN 和已平仓笔数）", file: null, closed: 0, sqn: null, promote: false };
  }
  let doc;
  try { doc = await readJson(ledgerPath); }
  catch { return { ok: false, reason: "模拟盘账本无法读取", file: ledgerPath, closed: 0, sqn: null, promote: false }; }
  const ledger = paperLedger(doc);
  if (!ledger.ok) return { ok: false, reason: ledger.reason, file: ledgerPath, closed: 0, sqn: null, promote: false };
  const decision = paperPromotionDecision({ trades: ledger.trades, sessionPresent: true, env });
  return {
    ok: true,
    file: ledgerPath,
    sessionId: ledger.sessionId,
    closed: decision.closed,
    eligible: decision.eligible,
    riskMissing: decision.riskMissing,
    outcomeMissing: decision.outcomeMissing,
    riskSources: decision.riskSources,
    eligibleSince: decision.eligibleSince,
    sqn: decision.sqn,
    expectancy: decision.expectancy,
    stdev: decision.stdev,
    requiredSqn: decision.requiredSqn,
    requiredClosed: decision.requiredClosed,
    promote: decision.allow === true,
    reason: decision.reason,
  };
}
