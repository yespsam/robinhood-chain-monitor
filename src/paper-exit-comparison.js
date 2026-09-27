import { advancePaperStrategyAccount, validatePaperStrategyAccount } from './paper-strategy-engine.js';
import { completedPaperRounds } from './paper-confirmed-policy.js';
import { THESIS_EXIT_VERSION, THESIS_EXIT_POLICY } from './paper-thesis-exit.js';

export const EXIT_COMPARISON_VERSION = 'exit_forward_pair_v1';
export const ACTIVE_ENTRY_VERSION = 'active_entry_sampling_v1';
export function activateExitEntrySampling(pair, nowMs) {
  validateExitComparison(pair);
  if (pair.entrySampling) return pair;
  if (!Number.isFinite(nowMs) || nowMs < Date.parse(pair.startedAt)) throw new Error('invalid entry sampling activation');
  const baseline = a => ({ tradeCount:a.trades.length, realizedPnl:a.realizedPnl,
    equity:a.stats.netLiquidationValue ?? a.stats.equity });
  return { ...pair, entrySampling:{version:ACTIVE_ENTRY_VERSION, activatedAt:new Date(nowMs).toISOString(),
    control:baseline(pair.control), dynamic:baseline(pair.dynamic)} };
}
export function createExitComparison(account, nowMs) {
  validatePaperStrategyAccount(account);
  if (account.variant || account.exitExperimentVersion) throw new Error('exit comparison requires the original main account');
  return { version: EXIT_COMPARISON_VERSION, startedAt: new Date(nowMs).toISOString(),
    baselineTradeCount: account.trades.length, baselineRealizedPnl: account.realizedPnl,
    baselineEquity: account.stats.netLiquidationValue ?? account.stats.equity,
    control: structuredClone(account), dynamic: { ...structuredClone(account), exitExperimentVersion: THESIS_EXIT_VERSION } };
}
export function validateExitComparison(pair) {
  if (pair?.version !== EXIT_COMPARISON_VERSION || !Number.isFinite(Date.parse(pair.startedAt))
    || !Number.isInteger(pair.baselineTradeCount) || pair.baselineTradeCount < 0
    || !Number.isFinite(pair.baselineEquity) || !Number.isFinite(pair.baselineRealizedPnl)
    || pair.control?.exitExperimentVersion !== undefined || pair.dynamic?.exitExperimentVersion !== THESIS_EXIT_VERSION
    || pair.control?.initialCash !== pair.dynamic?.initialCash) throw new Error('退出对照账本异常，禁止重置或补款');
  for (const account of [pair.control, pair.dynamic]) {
    validatePaperStrategyAccount(account);
    if (account.variant || account.trades.length < pair.baselineTradeCount) throw new Error('退出对照历史不完整');
  }
  if (pair.entrySampling) {
    const s=pair.entrySampling, at=Date.parse(s.activatedAt);
    if (s.version!==ACTIVE_ENTRY_VERSION || !Number.isFinite(at) || at<Date.parse(pair.startedAt)) throw new Error('invalid entry sampling policy');
    for (const key of ['control','dynamic']) {
      const b=s[key];
      if (!Number.isInteger(b?.tradeCount) || b.tradeCount<pair.baselineTradeCount || b.tradeCount>pair[key].trades.length
        || !Number.isFinite(b.realizedPnl) || !Number.isFinite(b.equity)) throw new Error('invalid entry sampling baseline');
    }
  }
  return true;
}
export function advanceExitComparison(pair, { evaluations = [], samplingEvaluations = [], marksFor, enabled = false, nowMs }) {
  if (!pair) return null;
  validateExitComparison(pair);
  const active=!!pair.entrySampling;
  const mainRows=new Map(evaluations.map(r=>[`${r.token?.chain}:${r.token?.address}:${r.strategyId}`,r]));
  const entries=active ? samplingEvaluations.filter(r=>r.evidence?.opportunity?.version==='multi_setup_v1').map(r=>({ ...r,
    entryLogic:`积极采样（独立模拟）：${(r.entryLogic||'').replace('旧策略对照：','基础入口：')}`,
    evidence:{...r.evidence,entrySampling:{version:ACTIVE_ENTRY_VERSION,activatedAt:pair.entrySampling.activatedAt,
      mainDecision:mainRows.get(`${r.token.chain}:${r.token.address}:${r.strategyId}`)?.decision??'未评估',
      mainBlockers:[...(mainRows.get(`${r.token.chain}:${r.token.address}:${r.strategyId}`)?.reasons||[]),
        ...(mainRows.get(`${r.token.chain}:${r.token.address}:${r.strategyId}`)?.missing||[])].slice(0,12),
      note:'基础形态与报价确认；不强制新版趋势强度、报价向上收复及结构成本后盈亏比。费用、10 U预算、行情和安全数据校验不变。'}} })) : evaluations;
  const options = { evaluations:entries, enabled, nowMs, confirmedMode: true, continuousPaperMode: true, opportunityMode: true,
    opportunityReviewMode:!active };
  const next = { ...pair, control: advancePaperStrategyAccount(pair.control, { ...options, marks: marksFor(pair.control) }),
    dynamic: advancePaperStrategyAccount(pair.dynamic, { ...options, marks: marksFor(pair.dynamic) }) };
  if (active && enabled) {
    const rows=[...new Map(entries.map(r=>[`${r.token.chain}:${r.token.address}`,r])).values()], blockers=new Map();
    for (const r of rows.filter(r=>r.decision!=='可模拟')) for (const reason of new Set([...(r.reasons||[]),...(r.missing||[])])) blockers.set(reason,(blockers.get(reason)||0)+1);
    next.samplingScan={at:new Date(nowMs).toISOString(),observed:rows.length,eligible:rows.filter(r=>r.decision==='可模拟').length,
      blockers:[...blockers].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([reason,count])=>({reason,count}))};
  }
  validateExitComparison(next);
  return next;
}
export function exitComparisonSummary(pair) {
  if (!pair) return null;
  const summarize = account => {
    const trades = account.trades.slice(pair.baselineTradeCount), rounds = completedPaperRounds(trades);
    return { entries: trades.filter(t => t.side === 'buy').length, closedRounds: rounds.length,
      periodRealizedPnl: account.realizedPnl - pair.baselineRealizedPnl,
      netLiquidationValue: account.stats.netLiquidationValue ?? account.stats.equity,
      equityChange: (account.stats.netLiquidationValue ?? account.stats.equity) - pair.baselineEquity,
      stalePositions: account.stats.stalePositions || 0,
      positions: Object.values(account.positions).map(p => ({ chain: p.chain, address: p.address, symbol: p.symbol,
        openedAt: p.openedAt, entryLogic: p.entryLogic, entryUsd: p.entryUsd, costBasisUsd: p.costBasisUsd,
        quantity: p.quantity, pnl: p.pnl, markAt: p.markAt, markStatus: p.markStatus,
        effectiveExitVersion: p.exitExperiment?.version || p.pvpPolicy?.version || null,
        status: p.thesisStatus || p.exitStatus || null })),
      recentTrades: trades.slice(-6).map(t => ({ atMs: t.atMs, chain: t.chain, address: t.address, symbol: t.symbol,
        side: t.side, reason: t.reason, netUsd: t.netUsd, realizedPnl: t.realizedPnl, costsUsd: t.costsUsd })) };
  };
  const sampling = pair.entrySampling ? { ...pair.entrySampling,
    scan:pair.samplingScan||null,
    label:'积极采样 · 基础买点成立即可试单',
    description:'两个退出账户均改用基础入口，不再等待主账户批准；外盘趋势量能门槛由 1.2 倍回到 0.8 倍，不强制额外均线强度、逐次涨价及结构成本后盈亏比。仍要求真实形态、两次独立报价、每笔 10 U、模型成本与余额校验；非无条件买入。',
    results:Object.fromEntries(['control','dynamic'].map(key=>{const a=pair[key], b=pair.entrySampling[key], trades=a.trades.slice(b.tradeCount);
      return [key,{entries:trades.filter(t=>t.side==='buy').length,closedRounds:completedPaperRounds(trades).length,
        periodRealizedPnl:a.realizedPnl-b.realizedPnl,equityChange:(a.stats.netLiquidationValue??a.stats.equity)-b.equity}];})) } : null;
  return { version: pair.version, startedAt: pair.startedAt, baselineEquity: pair.baselineEquity, entrySampling:sampling,
    mode: 'paper_only', promotion: false, policy: THESIS_EXIT_POLICY, control: summarize(pair.control), dynamic: summarize(pair.dynamic),
    note: `${sampling ? '同数据池、同基础入口、同成本模型，两个退出账户均独立评估余额与信号，不受主账户买点批准限制；入口切换时间和分段结果单独保留。' : '同起点、共享主账户合格信号与成本模型；只改变新仓退出。'}旧仓不改。独立虚拟对照不合并主账户、不自动晋升。因退出、占用资金和同币去重不同，实际后续成交可分化，不是逐笔完全配对。无固定最大亏损保证，缺失证据可能延迟退出。` };
}
