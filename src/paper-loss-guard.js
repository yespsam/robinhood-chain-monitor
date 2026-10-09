import fs from 'node:fs/promises';
import path from 'node:path';
import { ESTIMATED_COST_VERSION } from './paper-estimated-cost.js';

// Explicit local policy, bound to one estimated PAPER session. No ledger edits,
// funding resets, network control endpoint, or live-account permissions.
export async function loadPaperLossGuardPolicy(dataDir, session) {
  let policy;
  try { policy = JSON.parse(await fs.readFile(path.join(dataDir, 'paper-loss-guard-policy.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (policy?.schema !== 'paper_loss_guard_policy_v1' || policy.mode !== 'paper'
    || typeof policy.enforced !== 'boolean' || !Number.isFinite(Date.parse(policy.authorizedAt))
    || typeof policy.reason !== 'string' || !policy.reason.trim()
    || !/^confirmed-pvp-v2-[a-z0-9-]{1,40}$/.test(policy.sessionId || ''))
    throw new Error('模拟亏损保护配置无效，未放宽限制');
  if (session?.mode !== 'paper' || session?.costModel !== ESTIMATED_COST_VERSION || session.id !== policy.sessionId) return undefined;
  return policy.enforced;
}

/** A funded round has its own risk budget; deposits never become trading PnL. */
export function paperLossGuard(account, nowMs, { enforced = true } = {}) {
  if (typeof enforced !== 'boolean') throw new TypeError('loss guard enforcement must be boolean');
  const funding = (account.cashAdjustments || []).filter(a => Date.parse(a.at) <= nowMs).at(-1);
  const baselineTradeCount = funding?.tradeCount ?? 0;
  const capitalUsd = funding?.cashAfter ?? account.initialCash;
  const trades = account.trades.slice(baselineTradeCount).filter(t => t.atMs <= nowMs);
  const realizedPnlUsd = funding ? trades.reduce((n, t) => n + t.realizedPnl, 0) : account.realizedPnl;
  const day = Math.floor(nowMs / 86400000) * 86400000;
  const dailyRealizedPnlUsd = trades.filter(t => t.atMs >= day).reduce((n, t) => n + t.realizedPnl, 0);
  const lossLimitUsd = capitalUsd * .1;
  const reasons = [];
  if (realizedPnlUsd <= -lossLimitUsd) reasons.push('本轮累计已实现亏损达到本金 10%，暂停新仓，监控与持仓退出继续');
  if (dailyRealizedPnlUsd <= -lossLimitUsd) reasons.push('本轮 UTC 当日已实现亏损达到本金 10%，暂停新仓，监控与持仓退出继续');
  return { version: 'funded_round_loss_guard_v1', enforced, threshold: enforced ? 'daily_or_round_10_percent' : null,
    baselineTradeCount, fundingId: funding?.id ?? null, startedAt: funding?.at ?? null,
    capitalUsd, realizedPnlUsd, dailyRealizedPnlUsd, lossLimitUsd: enforced ? lossLimitUsd : null,
    triggered: enforced && reasons.length > 0, newEntriesStop: enforced && reasons.length > 0, reasons: enforced ? reasons : [] };
}
