import { validatePaperStrategyAccount } from './paper-strategy-engine.js';
import { completedPaperRounds } from './paper-confirmed-policy.js';
export const REVIEW_COMPARISON_VERSION='review_forward_v1';
export function createReviewComparison(account,nowMs) {
  validatePaperStrategyAccount(account);
  return {version:REVIEW_COMPARISON_VERSION,startedAt:new Date(nowMs).toISOString(),
    baselineTradeCount:account.trades.length,baselineRealizedPnl:account.realizedPnl,
    baselineEquity:account.stats.netLiquidationValue??account.stats.equity,
    baselineFunding:(account.cashAdjustments||[]).reduce((sum,item)=>sum+item.amountUsd,0),
    control:structuredClone(account)};
}
export function validateReviewComparison(value) {
  if(value?.version!==REVIEW_COMPARISON_VERSION || !Number.isFinite(Date.parse(value.startedAt))
    || !Number.isInteger(value.baselineTradeCount) || value.baselineTradeCount<0
    || !Number.isFinite(value.baselineRealizedPnl) || !Number.isFinite(value.baselineEquity)
    || value.baselineFunding!==undefined&&!Number.isFinite(value.baselineFunding)) throw new Error('复盘对照账本异常，未重建或补款');
  validatePaperStrategyAccount(value.control);
}
export function reviewComparisonSummary(value,main) {
  if(!value)return null;
  const stats=a=>{
    const trades=a.trades.slice(value.baselineTradeCount),rounds=completedPaperRounds(trades);
    const routeResults=[...new Set(rounds.map(r=>r.entry.entryEvidence?.opportunity?.id||'legacy'))].map(route=>{
      const group=rounds.filter(r=>(r.entry.entryEvidence?.opportunity?.id||'legacy')===route);
      const wins=group.filter(r=>r.pnl>0),losses=group.filter(r=>r.pnl<0);
      const gains=wins.reduce((n,r)=>n+r.pnl,0),loss=-losses.reduce((n,r)=>n+r.pnl,0);
      return {route,closedRounds:group.length,wins:wins.length,losses:losses.length,netPnl:gains-loss,
        winRate:wins.length/group.length,averageWin:wins.length?gains/wins.length:null,
        averageLoss:losses.length?loss/losses.length:null,profitFactor:loss>0?gains/loss:null,
        averageHoldMs:group.reduce((n,r)=>n+r.at-r.entry.atMs,0)/group.length};
    });
    const funding=(a.cashAdjustments||[]).reduce((sum,item)=>sum+item.amountUsd,0)-(value.baselineFunding||0);
    return {entries:trades.filter(t=>t.side==='buy').length,closedRounds:rounds.length,wins:rounds.filter(r=>r.pnl>0).length,routeResults,
      newRoundPnl:rounds.reduce((s,r)=>s+r.pnl,0),periodRealizedPnl:a.realizedPnl-value.baselineRealizedPnl,
      netLiquidationValue:a.stats.netLiquidationValue??a.stats.equity,
      manualFundingUsd:funding,equityChange:(a.stats.netLiquidationValue??a.stats.equity)-value.baselineEquity-funding,openPositions:Object.keys(a.positions).length};
  };
  return {version:value.version,startedAt:value.startedAt,mode:'paper_only',main:stats(main),control:stats(value.control),
    note:'同起始账户快照、同数据池、同新版成本；手动虚拟补资已从权益收益中扣除，但补资后仓位规模可能不同，不再视为同资金条件。旧入口只在独立对照账本运行，不影响主账户余额；样本不足不宣称盈利。'};
}
