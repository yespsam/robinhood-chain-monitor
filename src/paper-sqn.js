// System Quality Number for the active paper ledger. This does not sign,
// broadcast, or enable LIVE. SQN is Van Tharp's: (mean R / sample stdev) * sqrt(N).
// R is the realized PnL of one fully closed round. Partial sells stay inside
// that round so they are not counted as extra trades.
import fs from "node:fs/promises";
import path from "node:path";

// Same aggregation as completedPaperRounds: one closed position is one trade.
// Partial sells stay inside that round. Kept local so this report does not
// load the paper engine or its wallet libraries.
function closedRounds(trades) {
  const open = new Map();
  const closed = [];
  for (const trade of trades) {
    if (!trade || typeof trade !== "object") continue;
    const key = `${trade.chain}:${trade.address}`;
    if (trade.side === "buy") {
      const quantity = Number(trade.quantity);
      open.set(key, { pnl: 0, left: quantity, quantity, at: trade.atMs });
    } else {
      const lot = open.get(key);
      if (!lot) continue;
      lot.pnl += Number(trade.realizedPnl);
      lot.left -= Number(trade.quantity);
      if (lot.left <= lot.quantity * 1e-9) {
        closed.push({ pnl: lot.pnl, at: trade.atMs ?? lot.at });
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
    requiredSqn = Number.isFinite(n) && n > 0 ? n : 1.6;
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
    requiredClosed = Number.isInteger(n) && n > 0 ? n : 30;
  }
  return { requiredSqn, sqnEnabled, requiredClosed, closedEnabled, enabled: sqnEnabled || closedEnabled };
}

export function systemQualityNumber(values) {
  const pnls = (Array.isArray(values) ? values : []).map(finite).filter((n) => n !== null);
  const closed = pnls.length;
  if (!closed) return { closed: 0, expectancy: null, stdev: null, sqn: null };
  const expectancy = pnls.reduce((sum, n) => sum + n, 0) / closed;
  if (closed < 2) return { closed, expectancy, stdev: null, sqn: null };
  const variance = pnls.reduce((sum, n) => sum + (n - expectancy) ** 2, 0) / (closed - 1);
  const stdev = Math.sqrt(variance);
  let sqn;
  if (stdev === 0) sqn = expectancy > 0 ? Number.POSITIVE_INFINITY : expectancy < 0 ? Number.NEGATIVE_INFINITY : 0;
  else sqn = (expectancy / stdev) * Math.sqrt(closed);
  return { closed, expectancy, stdev, sqn };
}

function roundPnls(trades) {
  if (!Array.isArray(trades)) return null;
  if (trades.every((row) => typeof row === "number")) return trades.map(finite).filter((n) => n !== null);
  if (trades.every((row) => row && typeof row === "object" && (Object.hasOwn(row, "pnl") || Object.hasOwn(row, "realizedPnl")) && !row.side)) {
    return trades.map((row) => finite(row.pnl ?? row.realizedPnl)).filter((n) => n !== null);
  }
  return closedRounds(trades).map((round) => finite(round.pnl)).filter((n) => n !== null);
}

export function paperSqnReport(trades) {
  const pnls = roundPnls(trades);
  if (pnls === null) return { closed: 0, expectancy: null, stdev: null, sqn: null, missing: true };
  return { ...systemQualityNumber(pnls), missing: false };
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
    closed: 0, sqn: null, expectancy: null, stdev: null,
    requiredSqn: config.requiredSqn, requiredClosed: config.requiredClosed,
  };
  if (!config.enabled) return base;
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
  }
  if (config.sqnEnabled && !(report.sqn >= config.requiredSqn)) {
    reasons.push(`模拟盘 SQN ${formatSqn(report.sqn)}，低于 ${config.requiredSqn}`);
  }
  return {
    ...base,
    allow: reasons.length === 0,
    reason: reasons.length ? `未达到 LIVE 晋升线：${reasons.join("；")}` : null,
    closed: report.closed,
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
    sqn: decision.sqn,
    expectancy: decision.expectancy,
    stdev: decision.stdev,
    requiredSqn: decision.requiredSqn,
    requiredClosed: decision.requiredClosed,
    promote: decision.allow === true,
    reason: decision.reason,
  };
}
