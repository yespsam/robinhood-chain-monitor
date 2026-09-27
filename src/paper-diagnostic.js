// Explicitly user-triggered engineering exercise, NEVER strategy alpha or live execution.
import { paperPositionSize } from './paper-position-sizing.js';
import { costAssumptions } from './paper-strategy-engine.js';
import { paperTaxScreen } from './paper-safety-policy.js';
const rejected = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
const deny = problem => { if (problem) throw rejected(problem.code, problem.message, problem.details); };

export function diagnosticCandidateIssue(e, now = Date.now()) {
  const v = e?.evidence, at = Date.parse(v?.marketObservedAt);
  const issue = (code, message, details = {}) => ({ code, message, details });
  if (!v || v.safety?.missing?.length !== 0 || v.safety?.blocked?.length !== 0) return issue('DIAG_SAFETY', '安全字段缺失或存在阻断');
  const tax = paperTaxScreen(v.safety.metrics);
  if (tax.blocked || tax.missing.length) return issue('DIAG_TAX', '税率超过 6% 或数据不完整', tax);
  if (v.marketFresh !== true || !Number.isFinite(at) || at > now || now - at > 120000) return issue('DIAG_MARKET_STALE', '研究行情已过期或时间无效', { ageMs: Number.isFinite(at) ? now - at : null });
  if (!(v.liquidity >= 10000)) return issue('DIAG_LIQUIDITY', '流动性不足或缺失');
  if (!(v.volume?.value > 0)) return issue('DIAG_VOLUME', '成交量缺失或非正');
  if (v.flowFresh !== true) return issue('DIAG_FLOW_STALE', '资金流不完整或不新鲜');
  if (!(v.flow?.uniqueBuyerCount >= 1) || !(v.flow?.netBuyUsd > 0)) return issue('DIAG_NO_NET_BUY', '缺少真实净买家或正净流入');
  if (e.token?.chain === 'eth') return issue('DIAG_CHAIN_COST', '小额诊断暂不使用以太坊成本模型');
  return null;
}

export function diagnosticQuoteIssue(q, token, now = Date.now()) {
  const at = Date.parse(q?.observedAt), received = Date.parse(q?.receivedAt);
  const issue = (code, message, details = {}) => ({ code, message, details });
  if (q?.status !== 'ok') return issue('DIAG_QUOTE_UNAVAILABLE', '上游未返回可用的新报价', {
    upstreamCode: ['GMGN_REQUEST_BUSY', 'GMGN_STATE_INVALID', 'GMGN_STOPPED', 'GMGN_RATE_LIMITED', 'GMGN_CLI_TIMEOUT', 'GMGN_INVALID_QUOTE', 'GMGN_IDENTITY_MISMATCH'].includes(q?.reasonCode) ? q.reasonCode : 'GMGN_UNAVAILABLE' });
  if (q.source !== 'gmgn-cli-token-info' || q.chain !== token.chain || q.address !== token.address) return issue('DIAG_QUOTE_IDENTITY', '报价来源、链或合约绑定不一致');
  if (typeof q.price !== 'number' || !Number.isFinite(q.price) || q.price <= 0) return issue('DIAG_QUOTE_PRICE', '报价不是有效正数');
  if (!Number.isFinite(at) || !Number.isFinite(received) || at > received || received > now) return issue('DIAG_QUOTE_TIME', '报价时间戳无效或来自未来');
  if (now - at > 15000) return issue('DIAG_QUOTE_STALE', '报价超过十五秒有效期', { ageMs: now - at });
  return null;
}

export function diagnosticTarget(state) {
  const target = state.targetFills ?? 10;
  if (![2, 10, 20].includes(target)) throw Error('诊断目标只支持 2、10 或 20 笔买卖成交');
  return target;
}

export function diagnosticCandidate(e, now = Date.now()) {
  return diagnosticCandidateIssue(e, now) === null;
}

export function diagnosticQuote(q, token, now = Date.now()) {
  return diagnosticQuoteIssue(q, token, now) === null;
}

export function diagnosticBuy(state, evaluation, quote, now = Date.now()) {
  if (state.mode !== 'paper_diagnostic' || state.execution !== false || state.signing !== false || state.broadcast !== false
    || state.position || state.trades.length >= diagnosticTarget(state) - 1) throw rejected('DIAG_ENTRY_STATE', '模拟账户状态或成交上限不允许买入');
  if (now >= Date.parse(state.deadlineAt) - 30000) throw rejected('DIAG_ENTRY_DEADLINE', '进入退出预留窗口，禁止新买入');
  deny(diagnosticCandidateIssue(evaluation, now));
  deny(diagnosticQuoteIssue(quote, evaluation.token, now));
  const previous = state.trades.at(-1);
  if (previous && Date.parse(quote.observedAt) <= Date.parse(previous.quote.observedAt)) throw rejected('DIAG_QUOTE_REPEAT', '诊断买入不能重复使用上一笔成交报价');
  const size = paperPositionSize({ cash: state.cash, liquidity: evaluation.evidence.liquidity, baseEntryUsd: 2,
    // The explicit single-round flow check uses 10 virtual USD; historical multi-round tests keep their sizing.
    fixedEntryUsd: diagnosticTarget(state) === 2 ? 10 : null });
  const m = evaluation.evidence.safety.metrics;
  const costs = costAssumptions(evaluation.token.chain, m.buyTax, m.sellTax, size?.budgetUsd || 0);
  if (!size || size.budgetUsd <= costs.gasUsd || !(costs.notionalUsd > 0)
    || !Number.isFinite(costs.estimatedRoundTripCostRate) || costs.estimatedRoundTripCostRate > .15) throw rejected('DIAG_COST', '模拟成本过高', { estimatedRoundTripCostRate: costs.estimatedRoundTripCostRate });
  const position = { ...evaluation.token, entryPrice: quote.price, quantity: costs.notionalUsd / quote.price,
    budgetUsd: size.budgetUsd, costs, size, openedAt: new Date(now).toISOString(), quote,
    evidence: { safety: evaluation.evidence.safety, liquidity: evaluation.evidence.liquidity,
      flow: evaluation.evidence.flow, marketObservedAt: evaluation.evidence.marketObservedAt },
    unmetStrategyConditions: [...evaluation.missing, ...evaluation.reasons],
    reason: '用户指定限时诊断试单：安全字段通过、真实净买入和成交量存在；不代表正式策略达到开仓条件。' };
  state.cash -= size.budgetUsd; state.position = position;
  state.trades.push({ id: state.trades.length + 1, side: 'buy', chain: position.chain, address: position.address, symbol: position.symbol,
    at: position.openedAt, price: quote.price, quantity: position.quantity, amountUsd: size.budgetUsd,
    costUsd: size.budgetUsd - costs.notionalUsd, pnlUsd: null, quote, reason: position.reason,
    size, evidence: position.evidence, unmetStrategyConditions: position.unmetStrategyConditions });
  return state;
}

export function diagnosticSell(state, quote, now = Date.now(), { settleAfterDeadline = false, reason = null } = {}) {
  const p = state.position;
  const late = now >= Date.parse(state.deadlineAt);
  const allowedSettlement = settleAfterDeadline === true && late && state.status === 'incomplete_open_position'
    && Number.isFinite(Date.parse(state.finishedAt));
  if (state.mode !== 'paper_diagnostic' || state.execution !== false || state.signing !== false || state.broadcast !== false
    || !p || state.trades.length >= diagnosticTarget(state) || late && !allowedSettlement) throw rejected('DIAG_EXIT_STATE', '诊断退出状态或截止后收尾权限不满足');
  deny(diagnosticQuoteIssue(quote, p, now));
  if (Date.parse(quote.observedAt) <= Date.parse(p.quote.observedAt)) throw rejected('DIAG_QUOTE_REPEAT', '诊断卖出不能重复使用买入报价');
  const gross = p.quantity * quote.price;
  const cost = gross * (p.costs.feeRate + p.costs.slippageRate + p.costs.sellTax) + p.costs.gasUsd;
  const proceeds = gross - cost, pnl = proceeds - p.budgetUsd;
  if (![gross, cost, proceeds, pnl, state.cash + proceeds].every(Number.isFinite) || state.cash + proceeds < 0) throw Error('模拟卖出成本无法由现金承担');
  state.cash += proceeds; state.realizedPnl += pnl;
  state.trades.push({ id: state.trades.length + 1, side: 'sell', chain: p.chain, address: p.address, symbol: p.symbol,
    at: new Date(now).toISOString(), price: quote.price, quantity: p.quantity, amountUsd: proceeds,
    costUsd: cost, pnlUsd: pnl, quote,
    ...(allowedSettlement ? { lateSettlement: true } : {}),
    reason: allowedSettlement ? '截止后退出遗留诊断仓位，不计入十分钟成交目标'
      : reason || (quote.price <= p.entryPrice * .95 ? '诊断单触发 5% 价格止损' : '限时诊断退出，核验回款和下一笔滚仓') });
  state.position = null; return state;
}
