import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { meetsPaperEntryFlow } from './paper-entry-policy.js';
import { paperTaxRate, PAPER_MAX_TAX_RATE } from './paper-safety-policy.js';

const stamp = value => typeof value === 'number' ? (value < 1e10 ? value * 1000 : value) : Date.parse(value || '');
const present = value => value !== null && value !== undefined && value !== '';
const flag = value => [true, 1, '1', 'true'].includes(value) ? true : [false, 0, '0', 'false'].includes(value) ? false : null;
const dangerFlags = ['isHoneypot', 'isWashTrading', 'cannotSell', 'isBlacklisted', 'canMint', 'canFreeze', 'canPause', 'fakePool', 'stageConflict'];
const riskMetrics = ['rugRatio', 'top10HolderRate', 'devTeamHoldRate', 'bundlerRate'];
const knownStage = value => ['internal', 'near_completion', 'external'].includes(value);

// All contributing snapshots must be fresh and exactly bound. The combined
// observation uses the OLDEST contributing time: refreshing price cannot
// renew borrowed safety/stage fields. This is deliberately conservative.
export function mergePaperCandidateSnapshots(prior, next, nowMs) {
  if (!prior) return next;
  if (!next) return prior;
  const same = prior.token?.chain === next.token?.chain && gmgnFlowAddress(prior.token?.chain, prior.token?.address)
    && gmgnFlowAddress(prior.token.chain, prior.token.address) === gmgnFlowAddress(next.token.chain, next.token.address);
  if (!same) return prior;
  const fresh = item => item.marketStatus === 'ok' && Number.isFinite(stamp(item.observedAt))
    && stamp(item.observedAt) <= nowMs && nowMs - stamp(item.observedAt) <= 120_000;
  const usable = [prior, next].filter(fresh).sort((a, b) => stamp(a.observedAt) - stamp(b.observedAt));
  if (!usable.length) return stamp(next.observedAt) > stamp(prior.observedAt) ? next : prior;
  if (usable.length === 1) return usable[0];
  const [older, newer] = usable, token = { ...older.token };
  for (const [key, value] of Object.entries(newer.token)) if (present(value)) token[key] = value;
  for (const key of dangerFlags) if (usable.some(item => flag(item.token[key]) === true)) token[key] = true;
  for (const key of ['renouncedMint', 'renouncedFreezeAccount']) if (usable.some(item => flag(item.token[key]) === false)) token[key] = false;
  for (const key of riskMetrics) {
    const values = usable.map(item => item.token[key]).filter(value => present(value) && typeof value !== 'boolean' && Number.isFinite(Number(value)));
    if (values.length) {
      const numbers = values.map(Number);
      token[key] = numbers.find(value => value < 0 || value > 1) ?? Math.max(...numbers);
    }
  }
  for (const key of ['buyTax', 'sellTax']) {
    const values = usable.map(item => item.token[key]).filter(present);
    const rates = values.map(paperTaxRate).filter(value => value !== null);
    // A fresh known high tax must not be hidden by a lower or malformed source.
    // Otherwise malformed supplied values remain unknown, never coerced to 0.
    if (rates.some(value => value > PAPER_MAX_TAX_RATE)) token[key] = Math.max(...rates);
    else if (values.some(value => paperTaxRate(value) === null)) token[key] = values.find(value => paperTaxRate(value) === null);
    else if (rates.length) token[key] = Math.max(...rates);
  }
  // A known zero pool may not be masked by another still-fresh snapshot.
  if (usable.some(item => item.token.liquidity === 0)) token.liquidity = 0;
  const stages = usable.map(item => item.token.marketStage).filter(knownStage);
  if (stages.includes('external') && stages.some(stage => stage !== 'external')) token.stageConflict = true;
  token.marketStage = token.stageConflict ? 'unknown' : knownStage(newer.token.marketStage) ? newer.token.marketStage : older.token.marketStage;
  return { ...newer, token, observedAt: older.observedAt, marketStatus: 'ok',
    researchSources: usable.flatMap(item => item.researchSources || [{ source: item.discoverySource || 'ranking', observedAt: item.observedAt }]) };
}

const quoteAndChart = new Set(['新鲜且足够的 K 线', '十五秒内的独立报价', '五秒内的独立报价', '连续新鲜报价确认', '触发后两次独立走强报价', '可持续取得的退出量价或地址行为证据', '等待真实订单曲线深度']);
const detailFields = new Set(['两分钟内的真实行情', '有效正数价格', '真实流动性', '真实成交量', '已核实内外盘阶段',
  '内外盘来源冲突待核对', '已知发射台', '可信创建时间', '增发权限已撤销', '冻结权限已撤销', '可卖出检测',
  '洗量检测', '撤池风险比', 'Top10 集中度', '开发团队持仓', '打包买入占比', '买入税', '卖出税']);
// A successful response is not a successful field repair. Back off only
// requested fields still absent, never market clocks, prices or flow signals.
const detailFieldReaders = {
  '可卖出检测': t => flag(t.isHoneypot), '洗量检测': t => flag(t.isWashTrading),
  '增发权限已撤销': t => flag(t.renouncedMint), '冻结权限已撤销': t => flag(t.renouncedFreezeAccount),
  '买入税': t => paperTaxRate(t.buyTax), '卖出税': t => paperTaxRate(t.sellTax),
  '撤池风险比': t => t.rugRatio, 'Top10 集中度': t => t.top10HolderRate,
  '开发团队持仓': t => t.devTeamHoldRate, '打包买入占比': t => t.bundlerRate,
  '已核实内外盘阶段': t => knownStage(t.marketStage) ? t.marketStage : null,
};
export function missingRequestedDetailFields(token, requested=[]) {
  return requested.filter(field => detailFieldReaders[field] && !present(detailFieldReaders[field](token)));
}
const quoteReasons=new Set(['报价未收复并向上确认，或已偏离结构','独立报价已偏离结构或短时波动超过 3%','报价路径存在深回撤、急拉或未持续走强，不追反抽','上新后报价尚未重新走强']);
export const onlyPricingMissing = result => result.decision !== '不买' && result.reasons.every(r=>quoteReasons.has(r))
  && result.missing.every(field => quoteAndChart.has(field));

// Quotes can finish a price/structure proof, not create a missing catalyst or
// overturn a failed reentry thesis. Keep these rows in discovery, not entry focus.
export const repairAllowsQuoteResearch = result => !result.evidence?.lossRepair
  || (result.evidence.lossRepair.entryPathAllowed??result.evidence.lossRepair.catalystReady)===true && result.evidence.lossRepair.reentry?.ready===true;
export const readyForPaperQuote = result => repairAllowsQuoteResearch(result) && (result.evidence?.opportunityRoutes || [result]).some(route => {
  const opportunity=route.evidence?.opportunity || route;
  if(route.lossRepair&&!repairAllowsQuoteResearch({evidence:{lossRepair:route.lossRepair}}))return false;
  return onlyPricingMissing(route) && (opportunity.basis !== 'ohlcv' || opportunity.pattern?.ready);
});

// A bounded read-only quote warmup. This is deliberately weaker than
// readyForPaperQuote: a candidate may still be missing a fresh quote,
// recovery proof, or a cost confirmation, but it must already have a
// route-level signal and no hard safety/data omission. Warmup only obtains
// evidence; it never makes the row trade-eligible.
const hardQuoteMissing = new Set([
  '有效链和合约地址', '两分钟内的真实行情', '真实流动性', '真实成交量',
  '可卖出检测', '洗量检测', '增发权限已撤销', '冻结权限已撤销',
  '买入税', '卖出税', '内外盘来源冲突待核对', '禁止卖出', '黑名单',
]);
export const researchReadyForQuote = result => {
  if (!result || result.decision === '不买' || result.evidence?.safety?.blocked?.length) return false;
  if (!repairAllowsQuoteResearch(result)) return false;
  const routes = Array.isArray(result.evidence?.opportunityRoutes) ? result.evidence.opportunityRoutes : [];
  const signalled = routes.some(route => route?.signalReady === true
    && (!route.lossRepair||repairAllowsQuoteResearch({evidence:{lossRepair:route.lossRepair}}))
    && (['flow','official_event','monitored_event','wallet_signal'].includes(route.basis) || route.pattern?.ready === true));
  if (!signalled) return false;
  return !(result.missing || []).some(field => hardQuoteMissing.has(field));
};

const rebuildingGaps = new Set(['feed_window_warming_or_gap', 'binance_window_warming_or_gap']);
export const canPrefetchPaperFlow = (flow, policy) => flow?.fresh === true && meetsPaperEntryFlow(flow, policy)
  && (flow.complete === true && !flow.coverageGap || rebuildingGaps.has(flow.coverageGap));
export const onlyPricingOrFlowWarmupMissing = result => result.decision !== '不买' && result.reasons.length === 0
  && result.missing.every(field => quoteAndChart.has(field) || field === '完整且新鲜的买入资金流');

// Planning research is not approval to buy. Unknown safety can request a fetch,
// while hard-danger candidates cannot consume the near-entry priority lane.
export function planPaperCandidateResearch(decisions, observedAt, nowMs) {
  const candidates = decisions.filter(row => row.decision !== '不买');
  const requestedFields = [...new Set(candidates.flatMap(row => row.missing.filter(field => detailFields.has(field))))].sort();
  const near = candidates.some(row => row.reasons.length === 0 && !row.missing.includes('新鲜且足够的 K 线')
    && row.missing.every(field => quoteAndChart.has(field) || field === '两分钟内的真实行情'));
  const ageMs = nowMs - stamp(observedAt);
  const best = candidates.toSorted((a, b) => a.missing.length + a.reasons.length - b.missing.length - b.reasons.length)[0];
  // Token detail requests cannot manufacture a verified narrative or missing
  // wallet history. Those gaps must not keep a fully researched token hot.
  const needsFields = candidates.some(row => row.missing.some(field => detailFields.has(field)));
  const verified = candidates.some(row => row.evidence?.lossRepair?.catalystReady===true
    && row.evidence.lossRepair.reentry?.ready===true && !row.evidence?.safety?.blocked?.length);
  if (verified && (needsFields || !Number.isFinite(ageMs) || ageMs >= 60_000)) return {
    needed:true,priority:3,refreshAfterMs:30_000,requestedFields,
    reason:'有效催化或核实盈利钱包：优先补齐当前行情与安全字段，不代表批准买入' };
  return { needed: candidates.length > 0 && (needsFields || near && (!Number.isFinite(ageMs) || ageMs >= 60_000)),
    requestedFields, priority: near ? 2 : best && best.missing.length <= 5 ? 1 : 0,
    refreshAfterMs: near ? 30_000 : 60_000,
    reason: near ? '接近开仓，优先刷新候选行情' : '补齐缺失的行情、阶段或安全字段' };
}
