import { createHash } from 'node:crypto';
import { completedPaperRounds } from './paper-confirmed-policy.js';
import { traderReview } from './paper-trader-reasoning.js';
import { EVIDENCE_REVIEW_VERSION, reviewEntryEvidence } from './paper-evidence-review.js';

export const TRADE_REVIEW_VERSION = 'paper_trade_batch_v1';
export const TRADE_REVIEW_BATCH_SIZE = 100;
const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const fill = t => t.side === 'buy' || t.side === 'sell';
const fail = () => { throw new Error('百笔复盘检查点与账本不一致；保留原记录，暂停复盘但不停止持仓退出'); };

export function createTradeReview(account, nowMs) {
  return { version: TRADE_REVIEW_VERSION, mode: 'local_statistics', batchSize: TRADE_REVIEW_BATCH_SIZE,
    startedAt: new Date(nowMs).toISOString(), baselineIndex: account.trades.length,
    processedIndex: account.trades.length, processedHash: hash(account.trades),
    batchStartIndex: account.trades.length, pendingFills: 0, reports: [] };
}

export function validateTradeReview(state, account) {
  if (state?.version !== TRADE_REVIEW_VERSION || state.mode !== 'local_statistics' || state.batchSize !== 100
    || !Number.isFinite(Date.parse(state.startedAt)) || !Array.isArray(state.reports)
    || ![state.baselineIndex,state.processedIndex,state.batchStartIndex,state.pendingFills].every(Number.isSafeInteger)
    || state.baselineIndex < 0 || state.batchStartIndex < state.baselineIndex || state.processedIndex < state.batchStartIndex
    || state.processedIndex > account.trades.length || state.pendingFills < 0 || state.pendingFills >= 100
    || state.processedHash !== hash(account.trades.slice(0,state.processedIndex))) fail();
  const seen = new Set();
  for (const t of account.trades) { if (typeof t.id !== 'string' || seen.has(t.id)) fail(); seen.add(t.id); }
  if (account.trades.slice(state.batchStartIndex,state.processedIndex).filter(fill).length !== state.pendingFills) fail();
  let previousEnd = state.baselineIndex;
  for (const [i,r] of state.reports.entries()) {
    const {reportHash,...report} = r;
    if (r.sequence !== i+1 || r.startIndex !== previousEnd || !Number.isSafeInteger(r.endIndex)
      || r.endIndex <= r.startIndex || r.endIndex > state.processedIndex || r.fillCount !== 100
      || account.trades.slice(r.startIndex,r.endIndex).filter(fill).length !== 100
      || r.review?.mode !== 'descriptive_review' || !Array.isArray(r.review.cohorts) || !r.review.overall
      || reportHash !== hash(report)) fail();
    previousEnd = r.endIndex;
  }
  if (previousEnd !== state.batchStartIndex) fail();
  return true;
}

export function advanceTradeReview(state, account, nowMs) {
  if (!state) return createTradeReview(account,nowMs);
  if (state.processedIndex === account.trades.length) return state;
  validateTradeReview(state,account);
  const next = structuredClone(state);
  for (let i=state.processedIndex;i<account.trades.length;i++) {
    const t = account.trades[i];
    if (fill(t)) next.pendingFills++;
    if (next.pendingFills !== 100) continue;
    const window = account.trades.slice(next.batchStartIndex,i+1), ids = new Set(window.map(t=>t.id));
    const rounds = completedPaperRounds(account.trades.slice(0,i+1)).filter(r=>ids.has(r.exits.at(-1).id));
    const review = traderReview(rounds,Math.min(nowMs,t.atMs));
    const report = { sequence:next.reports.length+1,startIndex:next.batchStartIndex,endIndex:i+1,
      firstTradeId:window[0].id,lastTradeId:t.id,triggeredAt:new Date(t.atMs).toISOString(),generatedAt:new Date(nowMs).toISOString(),
      fillCount:100,buys:window.filter(t=>t.side==='buy').length,sells:window.filter(t=>t.side==='sell').length,
      writeoffs:window.filter(t=>t.side==='writeoff').length,
      windowRealizedPnlUsd:window.reduce((n,t)=>n+t.realizedPnl,0),
      modelCostsUsd:window.every(t=>Number.isFinite(t.costsUsd))?window.reduce((n,t)=>n+t.costsUsd,0):null,
      averageHoldMs:rounds.length?rounds.reduce((n,r)=>n+r.at-r.entry.atMs,0)/rounds.length:null,
      exitReasons:Object.fromEntries([...new Set(window.filter(t=>t.side==='sell').map(t=>t.reason||'未记录'))]
        .map(reason=>[reason,window.filter(t=>t.side==='sell'&&(t.reason||'未记录')===reason).length])),
      carriedInRounds:rounds.filter(r=>!ids.has(r.entry.id)).length,review,
      evidenceReview:reviewEntryEvidence(rounds,Math.min(nowMs,t.atMs)),
      note:'仅主盘真实数据模拟成交；买卖各计一笔，对照不累加。完整原仓可能跨批，原仓净额与本批已实现口径不同。未平仓盈亏和完整权益回撤未计入；不是AI深度复盘，不自动改参数。' };
    next.reports.push({...report,reportHash:hash(report)});
    next.pendingFills=0;next.batchStartIndex=i+1;
  }
  next.processedIndex=account.trades.length;next.processedHash=hash(account.trades);
  return next;
}

export function tradeReviewSummary(state, error=null) {
  if (error) return {status:'error',error,aiAutomatic:false};
  if (!state) return null;
  return {version:state.version,evidenceReviewVersion:EVIDENCE_REVIEW_VERSION,status:'collecting',mode:state.mode,batchSize:state.batchSize,
    startedAt:state.startedAt,baselineTradeCount:state.baselineIndex,pendingFills:state.pendingFills,
    remainingFills:100-state.pendingFills,completedBatches:state.reports.length,
    countedFills:state.reports.length*100+state.pendingFills,latestReport:state.reports.at(-1)||null,
    aiAutomatic:false,automaticParameterChanges:false};
}
