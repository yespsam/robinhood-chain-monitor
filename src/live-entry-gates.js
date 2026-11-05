// Entry authorization for a LIVE mirror of the paper ledger. This file does
// not sign, broadcast, or turn LIVE trading on. A refused result is a reason
// string the caller logs; the paper book can keep recording.
//
// Order: an already-computed daily-loss result, then the consecutive-loss
// pause, then the paper SQN / closed-count promotion gate. There is no
// separate live-gmgn-trader.js in this repo. The paper engine calls checkGates
// at the flap / inner-curve entry that would otherwise open a LIVE ladder.
import { paperPromotionDecision } from "./paper-sqn.js";

function disabledToken(raw) {
  return ["0", "false", "off"].includes(String(raw ?? "").trim().toLowerCase());
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function liveConsecutiveLossConfig(env = process.env) {
  const raw = env?.LIVE_CONSECUTIVE_LOSS_PAUSE;
  let limit = 3;
  let enabled = true;
  if (raw === undefined || raw === null || raw === "") limit = 3;
  else if (disabledToken(raw)) { enabled = false; limit = 0; }
  else {
    const n = Number(raw);
    limit = Number.isInteger(n) && n > 0 && n <= 100 ? n : 3;
  }
  const minutesRaw = env?.LIVE_CONSECUTIVE_LOSS_PAUSE_MINUTES;
  let minutes = 0;
  if (minutesRaw !== undefined && minutesRaw !== null && minutesRaw !== "") {
    const n = Number(minutesRaw);
    minutes = Number.isInteger(n) && n >= 0 && n <= 10_080 ? n : 0;
  }
  return { enabled, limit: enabled ? limit : 0, minutes };
}

function tradePnl(trade) {
  if (!trade || typeof trade !== "object") return null;
  if (trade.pnl !== undefined) return finite(trade.pnl);
  if (trade.realizedPnl !== undefined) return finite(trade.realizedPnl);
  return null;
}

function closedAtMs(trade) {
  if (typeof trade?.closedAtMs === "number" && Number.isFinite(trade.closedAtMs)) return trade.closedAtMs;
  if (typeof trade?.atMs === "number" && Number.isFinite(trade.atMs)) return trade.atMs;
  const value = trade?.closedAt ?? trade?.at;
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// Most recent closed trade is last. A win or a scratch ends the streak.
// A missing PnL also ends it: unknown is not counted as a loss.
export function consecutiveLossStreak(closedTrades = []) {
  let streak = 0;
  for (let i = closedTrades.length - 1; i >= 0; i -= 1) {
    const pnl = tradePnl(closedTrades[i]);
    if (pnl === null || pnl >= 0) break;
    streak += 1;
  }
  return streak;
}

export function consecutiveLossPauseDecision({ closedTrades = [], nowMs = Date.now(), env = process.env } = {}) {
  const config = liveConsecutiveLossConfig(env);
  const streak = consecutiveLossStreak(closedTrades);
  const base = { allow: true, reason: null, gate: "consecutive_loss", streak, limit: config.limit, minutes: config.minutes, disabled: !config.enabled };
  if (!config.enabled) return base;
  if (streak < config.limit) return base;
  const last = closedAtMs(closedTrades.at(-1));
  if (config.minutes > 0 && last !== null && nowMs >= last + config.minutes * 60_000) {
    return { ...base, cooldownElapsed: true };
  }
  const reason = config.minutes > 0
    ? `LIVE 连亏 ${streak} 笔（阈值 ${config.limit}），冷却 ${config.minutes} 分钟内拒绝新开仓`
    : `LIVE 最近 ${config.limit} 笔已平仓全部亏损，拒绝新开仓（LIVE_CONSECUTIVE_LOSS_PAUSE=${config.limit}；设为 0 可关闭）`;
  return { ...base, allow: false, reason };
}

export function checkGates({
  closedTrades = [],
  trades = null,
  sessionPresent = trades != null,
  nowMs = Date.now(),
  env = process.env,
  dailyLoss = null,
} = {}) {
  if (dailyLoss && dailyLoss.allow === false) {
    return {
      allow: false,
      reason: dailyLoss.reason || "日亏损已达上限，拒绝 LIVE 新开仓",
      gate: "daily_loss",
      consecutive: null,
      promotion: null,
    };
  }
  const consecutive = consecutiveLossPauseDecision({ closedTrades, nowMs, env });
  if (!consecutive.allow) {
    return { allow: false, reason: consecutive.reason, gate: consecutive.gate, consecutive, promotion: null };
  }
  const promotion = paperPromotionDecision({ trades, sessionPresent, env });
  if (!promotion.allow) {
    return { allow: false, reason: promotion.reason, gate: promotion.gate, consecutive, promotion };
  }
  return { allow: true, reason: null, gate: null, consecutive, promotion };
}
