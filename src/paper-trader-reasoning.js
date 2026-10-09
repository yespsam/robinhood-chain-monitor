// Observable decision summaries, not inferred wallet psychology or profit forecasts.
import { isEvidenceHold, EVIDENCE_HOLD_TEXT } from './paper-pvp-policy.js';
export const TRADER_REASONING_VERSION = 'evidence_first_v1';
export const CATALYST_SELECTION_VERSION = 'eligible_algorithm_catalyst_v3';
const catalystRank = r => {
  const p=r.evidence?.lossRepair;
  if(p?.ready!==true||p.catalystReady!==true)return 0;
  return ['event_narrative','new_pool_first_three','collective_smart_money'].includes(p.group)?2:['verified_wallet','prequalified_wallet','internal_burst','onchain_internal_burst'].includes(p.group)?1:0;
};
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const money = n => finite(n) ? `$${n.toFixed(4)}` : '待确认';
const price = n => positive(n) ? `$${Number(n.toPrecision(7))}` : '待确认';
const pct = n => finite(n) ? `${(n * 100).toFixed(2)}%` : '待确认';
const unique = rows => [...new Set(rows.filter(Boolean))];

export function traderDecision(row, nowMs) {
  const e = row.evidence || {}, plan = e.entryPlan || {}, c = e.costAssumptions || {};
  const pulse = e.confirmedPolicy?.pulse, confirmation = e.confirmedPolicy?.confirmation;
  const recall = e.narrativeRecall, exit = e.exitPolicy || {};
  const quantity = positive(row.token?.price) && positive(c.notionalUsd) ? c.notionalUsd / row.token.price : null;
  const sellRate = [c.feeRate, c.slippageRate, c.sellTax].every(n => finite(n) && n >= 0)
    ? c.feeRate + c.slippageRate + c.sellTax : null;
  const valid = positive(quantity) && positive(row.entryUsd) && finite(c.gasUsd) && c.gasUsd >= 0 && sellRate !== null && sellRate < 1;
  const netAt = p => valid && positive(p) ? quantity * p * (1 - sellRate) - c.gasUsd - row.entryUsd : null;
  const breakEvenPrice = valid ? (row.entryUsd + c.gasUsd) / (quantity * (1 - sellRate)) : null;
  const stopNet = netAt(plan.stopPrice), scenarioNet = netAt(plan.targetPrice);
  const blockers = row.decision === '可模拟' ? [] : unique([...(row.missing || []), ...(row.reasons || [])]);
  const whyNow = e.opportunity?.basis === 'ohlcv' ? `${e.opportunity.label}：${plan.summary} 已收盘结构时间 ${e.opportunity.pattern?.closedAt ? new Date(e.opportunity.pattern.closedAt).toISOString() : '待确认'}；量能为基线 ${finite(e.opportunity.pattern?.volumeMultiple) ? e.opportunity.pattern.volumeMultiple.toFixed(2) : '待确认'} 倍。${confirmation?.ready ? '独立报价确认通过' : '报价待确认'}；未声称聪明钱进入。` : recall
    ? `七天内同题材回流：${recall.summary || '已核实历史主题与新出处'}；仍需新买盘和报价确认。`
    : `动量假设：90 秒净买家 ${finite(pulse?.recentBuyerCount) ? pulse.recentBuyerCount : '待确认'} 个，净流入 ${money(pulse?.recentNetBuyUsd)}；${confirmation?.ready ? '报价路径已确认' : '报价路径待确认'}。没有叙事出处时只记资金动量，不编故事。`;
  return { version: TRADER_REASONING_VERSION, mode: 'paper', execution: false, signing: false, broadcast: false,
    recordedAt: new Date(nowMs).toISOString(), chain: row.token?.chain, address: row.token?.address,
    hypothesis: e.opportunity?.id || (recall ? 'narrative_recall' : 'fresh_flow_momentum'), decision: row.decision, blockers,
    sourceUrl: e.opportunity?.event?.sourceUrl || recall?.sourceUrl || e.narrativeSource || null,
    selectionPolicy: e.lossRepair ? CATALYST_SELECTION_VERSION : e.opportunity ? 'eligible_cost_then_signal_recency_v1' : 'eligible_cost_then_flow_recency_v1',
    economics: { source: 'assumption', budgetUsd: finite(row.entryUsd) ? row.entryUsd : null,
      roundTripCostRate: finite(c.estimatedRoundTripCostRate) ? c.estimatedRoundTripCostRate : null,
      breakEvenPrice, breakEvenRise: positive(breakEvenPrice) ? breakEvenPrice / row.token.price - 1 : null,
      plannedStopLossUsd: finite(stopNet) && stopNet < 0 ? -stopNet : null, scenarioNetUsd: scenarioNet,
      scenarioPrice: positive(plan.targetPrice) ? plan.targetPrice : null,
      scenarioMeaning: '参考情景不是价格预测；止损损失不含跳价超幅', expectedProfitUsd: null },
    questions: [
      { id: 'why_now', label: '为什么现在买', text: e.narrativeThesis?`${e.narrativeThesis.summary} ${row.entryLogic}`:['official_event','monitored_event','wallet_signal'].includes(e.opportunity?.basis)?row.entryLogic:whyNow },
      { id: 'invalidation', label: '什么情况说明买错', text: `初始止损 ${price(plan.stopPrice)}；完整资金流反向按既有规则确认退出，缺失数据不冒充反向证据。不因亏损摊平或加大仓位。` },
      { id: 'economics', label: '成本后是否值得', text: `预算 ${money(row.entryUsd)}，往返模型成本 ${pct(c.estimatedRoundTripCostRate)}；价格需上涨 ${pct(positive(breakEvenPrice) ? breakEvenPrice / row.token.price - 1 : null)} 才覆盖一次完整退出成本。情景净收益 ${money(scenarioNet)}，触发价情景损失 ${money(finite(stopNet) && stopNet < 0 ? -stopNet : null)}；真实胜率和净期望未验证。` },
      { id: 'hold_or_exit', label: '凭什么继续持有', text: exit?.version==='structure_hold_v2' ? row.exitLogic : isEvidenceHold(exit) ? EVIDENCE_HOLD_TEXT
        : `沿用入场时退出版本：${finite(exit.noFollowThroughMs) ? exit.noFollowThroughMs / 1000 : '待确认'} 秒价格停滞检查，主仓最多 ${finite(exit.coreHoldMs) ? exit.coreHoldMs / 60000 : '待确认'} 分钟；仅扣费后盈利、价格继续走强才留尾仓，不因期待暴涨延期。` },
    ],
    ignoredAsAlpha: ['资料完整度分数不是盈利概率', '钱包标签不是已验证买点', '没有出处的叙事不补猜', '交易数量不是盈利目标'],
  };
}

// Applied only AFTER eligibility gates. Repair candidates prioritize a verified
// catalyst and its recency, then cost; legacy/price-only routes retain cost order.
// This is not an expected-profit estimate or relaxation of safety constraints.
export function compareConfirmedCandidates(a, b) {
  const cost = r => {
    const v = r.evidence?.costAssumptions?.estimatedRoundTripCostRate;
    return finite(v) && v >= 0 ? v : Infinity;
  };
  const fresh = r => finite(r.evidence?.opportunity?.signalAt) ? r.evidence.opportunity.signalAt : finite(r.evidence?.confirmedPolicy?.pulse?.lastBuyAt) ? r.evidence.confirmedPolicy.pulse.lastBuyAt : 0;
  if(catalystRank(a)!==catalystRank(b))return catalystRank(b)-catalystRank(a);
  if(catalystRank(a)>0&&fresh(a)!==fresh(b))return fresh(b)-fresh(a);
  if (cost(a) !== cost(b)) return cost(a) < cost(b) ? -1 : 1;
  if (fresh(a) !== fresh(b)) return fresh(b) - fresh(a);
  return `${a.token.chain}:${a.token.address}`.localeCompare(`${b.token.chain}:${b.token.address}`);
}

function cohortOf(round) {
  const e = round.entry.entryEvidence || {};
  // An explicitly migrated old lot keeps its entry version, but a recovery
  // exit must not be attributed to the legacy exit strategy's performance.
  const recoveryExits=unique((round.exits||[]).map(t=>t.exitEvidence?.evidenceRecovery?.version));
  return { chain: round.entry.chain, hypothesis: e.traderDecision?.hypothesis || (e.narrativeRecall ? 'narrative_recall' : 'fresh_flow_momentum'),
    selectionPolicy:e.traderDecision?.selectionPolicy || 'legacy_unknown',
    ...(e.recoveryEntry?.version?{recoveryEntryVersion:e.recoveryEntry.version}:{}),
    ...(e.routeSelectionVersion?{routeSelectionVersion:e.routeSelectionVersion}:{}),
    ...((e.recoveryEntry?.chartWindowPolicy||e.opportunity?.chartWindowPolicy)?
      {chartWindowPolicy:e.recoveryEntry?.chartWindowPolicy||e.opportunity.chartWindowPolicy}:{}),
    ...(e.narrativeThesis?.version?{narrativeAnalysisVersion:e.narrativeThesis.version}:{}),
    entryVersion: e.entryPlan?.entryPolicyVersion || e.confirmedPolicy?.version || e.entryPolicyVersion || 'legacy_unknown',
    accountPolicyVersion: e.accountPolicy?.version || 'bounded_paper_v1',
    opportunityVersion: e.opportunity?.version || 'legacy_single_setup',
    setupId: e.opportunity?.id || 'legacy_single_setup',
    sizingVersion: e.positionSizing?.version || 'legacy_fixed',
    quoteVersion: e.confirmedPolicy?.confirmation?.version || 'legacy_unversioned',
    lossResponseVersion: e.confirmedPolicy?.lossResponseVersion || 'legacy_unversioned',
    reasoningVersion: e.traderDecision?.version || 'legacy_unversioned', exitVersion: recoveryExits.length?recoveryExits.join('+'):e.memeExitPolicy?.version || e.exitExperiment?.version || e.exitPolicy?.version || 'legacy_unversioned' };
}

function summarize(rounds) {
  const wins = rounds.filter(r => r.pnl > 0), losses = rounds.filter(r => r.pnl < 0);
  const gain = wins.reduce((n, r) => n + r.pnl, 0), loss = -losses.reduce((n, r) => n + r.pnl, 0);
  const costsFor = r => [r.entry, ...r.exits].every(t => finite(t.costsUsd) && t.costsUsd >= 0)
    ? [r.entry, ...r.exits].reduce((n, t) => n + t.costsUsd, 0) : null;
  const knownCosts = rounds.every(r => costsFor(r) !== null);
  const costs = knownCosts ? rounds.reduce((n, r) => n + costsFor(r), 0) : null;
  const net = rounds.reduce((n, r) => n + r.pnl, 0);
  let equity = 0, peak = 0, drawdown = 0;
  for (const r of rounds) { equity += r.pnl; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  const tokens = new Set(rounds.map(r => `${r.entry.chain}:${r.entry.address}`)).size;
  const spanMs = rounds.length ? Math.max(...rounds.map(r => r.at)) - Math.min(...rounds.map(r => r.entry.atMs)) : 0;
  const stopExits = rounds.flatMap(r => r.exits).filter(t => /止损/.test(t.reason || ''));
  const netR = rounds.flatMap(r => {
    const risk = r.entry.entryEvidence?.traderDecision?.economics?.plannedStopLossUsd ?? r.entry.entryEvidence?.entryPlan?.estimatedStopLossUsd;
    return positive(risk) ? [r.pnl / risk] : [];
  });
  return { closedRounds: rounds.length, tokens, spanMs, wins: wins.length, losses: losses.length,
    breakeven: rounds.length - wins.length - losses.length, netPnlUsd: net, modelCostsUsd: costs,
    grossPricePnlUsd: costs === null ? null : net + costs, winRate: rounds.length ? wins.length / rounds.length : null,
    averageNetUsd: rounds.length ? net / rounds.length : null, averageWinUsd: wins.length ? gain / wins.length : null,
    averageLossUsd: losses.length ? loss / losses.length : null, profitFactor: loss > 0 ? gain / loss : null,
    payoffRatio: wins.length && losses.length ? (gain / wins.length) / (loss / losses.length) : null,
    averageNetR: netR.length ? netR.reduce((n, v) => n + v, 0) / netR.length : null, riskKnownRounds: netR.length,
    closedRoundDrawdownUsd: drawdown,
    costOnlyLosses: rounds.filter(r => r.pnl < 0 && costsFor(r) !== null && r.pnl + costsFor(r) >= 0).length,
    priceLosses: rounds.filter(r => costsFor(r) !== null && r.pnl + costsFor(r) < 0).length,
    stopShortfalls: stopExits.filter(t => positive(t.exitEvidence?.activeStopPrice) && positive(t.price) && t.price < t.exitEvidence.activeStopPrice).length,
    stopExitsWithoutQuotePath: stopExits.filter(t => !t.exitEvidence?.quoteDiagnostics).length,
    sampleStatus: rounds.length >= 30 && tokens >= 10 && spanMs >= 3 * 86400_000 ? 'ready_for_review' : 'collecting',
  };
}

export function traderReview(rounds, nowMs) {
  // Complete lots only, chronological and as-of. Never backfill new entry evidence.
  const complete = rounds.filter(r => finite(r.at) && finite(r.entry?.atMs) && r.entry.atMs <= r.at && r.at <= nowMs && finite(r.pnl))
    .sort((a, b) => a.at - b.at);
  const groups = new Map();
  for (const r of complete) {
    const cohort = cohortOf(r), key = JSON.stringify(cohort);
    if (!groups.has(key)) groups.set(key, { cohort, rows: [] });
    groups.get(key).rows.push(r);
  }
  return { version: TRADER_REASONING_VERSION, mode: 'descriptive_review', automaticParameterChanges: false,
    objective: '比较同版本的成本后净收益与回撤，不最大化交易笔数', overall: summarize(complete),
    cohorts: [...groups.values()].map(g => ({ ...g.cohort, ...summarize(g.rows) })),
    limitations: ['均为完整平仓的样本统计，不预测未来净期望', '模型费用不等于链上成交费用', '完整平仓回撤不是含浮亏的账户最大回撤', '三十笔、十币、三天只是复核起点，不证明盈利优势'],
    nextStep: '亏损按价格、费用和止损报价缺口分类；钱包候选规则先经既有同期对照，不自动晋升主策略',
  };
}
