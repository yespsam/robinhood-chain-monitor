import { completedPaperRounds } from './paper-confirmed-policy.js';
import { classifyEntryEvidence } from './paper-evidence-review.js';
import {ONCHAIN_BURST_VERSION,validCollectiveSignal} from './paper-collective-signal.js';
import {createHash} from 'node:crypto';

// Raw log decoding is expensive. Cache only the deterministic validation
// result, keyed by all frozen proof/identity/time contents, never by a route
// label or mutable object identity. The bounded cache stores no raw evidence.
const frozenOnchainChecks=new Map();
function validFrozenOnchain(entry) {
  const signal=entry.entryEvidence?.collectiveSignal;
  if(signal?.version!==ONCHAIN_BURST_VERSION)return false;
  const digest=createHash('sha256').update(JSON.stringify([entry.chain,entry.address,entry.atMs,signal])).digest('hex');
  if(frozenOnchainChecks.has(digest))return frozenOnchainChecks.get(digest);
  const valid=validCollectiveSignal(signal,entry,entry.atMs);frozenOnchainChecks.set(digest,valid);
  if(frozenOnchainChecks.size>256)frozenOnchainChecks.delete(frozenOnchainChecks.keys().next().value);
  return valid;
}

const summary = rounds => {
  const fills = rounds.flatMap(r => [r.entry, ...r.exits]);
  const costsComplete = fills.every(t => Number.isFinite(t.costsUsd) && t.costsUsd >= 0);
  const netPnlUsd = rounds.reduce((n,r) => n+r.pnl,0);
  const modelCostsUsd = costsComplete ? fills.reduce((n,t) => n+t.costsUsd,0) : null;
  return { closedRounds: rounds.length, wins: rounds.filter(r=>r.pnl>0).length,
    losses: rounds.filter(r=>r.pnl<0).length, netPnlUsd, modelCostsUsd,
    grossPricePnlUsd: costsComplete ? netPnlUsd+modelCostsUsd : null };
};
const laneLabels={event_narrative:'事件叙事',new_pool_first_three:'新底池前三 CA',collective_smart_money:'集体聪明钱算法',prequalified_wallet:'内盘预核验地址',internal_burst:'内盘逐笔放量',onchain_internal_burst:'内盘链上普通地址放量',verified_wallet:'核实盈利钱包',
  price_only:'外盘纯量价',tagged_or_unknown_wallet:'标签 / 未核实钱包',unknown:'未记录路线'};
// Record which route was used, not a hindsight reassessment of its truth.
const laneOf=r=>Object.hasOwn(laneLabels,r.entry.entryEvidence?.lossRepair?.group)
  ? r.entry.entryEvidence.lossRepair.group : 'unknown';

// Descriptive local learning only. Use evidence frozen at entry, not a later
// winning story. Never rewrite fills, promote a strategy or claim causal P&L.
export function paperLossLearning(account, nowMs) {
  const trades = (account?.trades || []).filter(t => t.atMs <= nowMs);
  const rounds = completedPaperRounds(trades).filter(r => r.entry.atMs <= r.at && Number.isFinite(r.pnl));
  const withCosts = r => [r.entry,...r.exits].every(t => Number.isFinite(t.costsUsd) && t.costsUsd>=0);
  // Revalidate frozen evidence at ENTRY time; route labels or a later winner
  // never manufacture proof. This is a distinct basis, not a profit teacher.
  const onchainBurst=rounds.filter(r=>validFrozenOnchain(r.entry));
  const onchainRounds=new Set(onchainBurst);
  const noProof = rounds.filter(r => {
    if(onchainRounds.has(r))return false;
    const e=classifyEntryEvidence(r.entry);
    return !['onchain_pool','official_catalog','direct_ca','community_link'].includes(e.narrative) && e.wallet!=='verified_profit';
  });
  const gaps = rounds.filter(r => r.exits.some(t => t.exitEvidence?.thesisDecision?.evidenceGap?.exit === true
    || /证据持续中断/.test(t.reason || '')));
  const costOnly = rounds.filter(r => r.pnl<0 && withCosts(r)
    && r.pnl+[r.entry,...r.exits].reduce((n,t)=>n+t.costsUsd,0)>=0);
  const funding = (account?.cashAdjustments || []).filter(f => Date.parse(f.at)<=nowMs
    && Number.isSafeInteger(f.tradeCount) && f.tradeCount>=0 && f.tradeCount<=trades.length).at(-1);
  const baseline = funding?.tradeCount || 0;
  const nextTrades = trades.slice(baseline), nextBuys = new Set(nextTrades.filter(t=>t.side==='buy').map(t=>t.id));
  const currentRounds=rounds.filter(r=>nextBuys.has(r.entry.id));
  const lessons = [
    { id:'entry_evidence',label:'入场依据不足',...summary(noProof),
      action:'新仓冻结原文与 CA 关联或已核验盈利买盘；历史不补故事，缺口进入研究队列' },
    { id:'evidence_gap_exit',label:'退出跟踪中断',...summary(gaps),
      action:'保持持仓退出优先；区分采集断档与叙事失效，未知不冒充卖出或持有证据' },
    { id:'cost_drag',label:'毛结果非负却净亏',...summary(costOnly),
      action:'分别核算价格损益与成本；估算费用不冒充真实订单报价，不靠频繁补款掩盖磨损' }
  ];
  if(onchainBurst.length)lessons.push({id:'onchain_burst_context',label:'链上普通地址放量',...summary(onchainBurst),
    action:'链上普通地址放量，无已核叙事/盈利画像；只确认入场时的限定逐笔证据，不认定独立控制人或盈利教师，另看此路线实际净结果'});
  return { version:'paper_loss_learning_v1', mode:'frozen_entry_descriptive', automaticParameterChanges:false,
    asOfTradeCount:trades.length, lastFillAt:trades.at(-1)?.atMs ?? null, overall:summary(rounds),lessons,
    currentRound:{ baselineTradeCount:baseline, fundingId:funding?.id || null, startedAt:funding?.at || null,
      fills:nextTrades.filter(t=>['buy','sell'].includes(t.side)).length,
      realizedPnlUsd:nextTrades.filter(t=>t.side!=='buy').reduce((n,t)=>n+(Number.isFinite(t.realizedPnl)?t.realizedPnl:0),0),
      ...summary(currentRounds) },
    routePerformance:{version:'frozen_route_results_v1',scope:'since_last_funding',baselineTradeCount:baseline,
      groups:Object.entries(laneLabels).map(([id,label])=>({id,label,...summary(currentRounds.filter(r=>laneOf(r)===id))})),
      selectionCohorts:[...new Set(currentRounds.map(r=>r.entry.entryEvidence?.traderDecision?.selectionPolicy||'legacy_unknown'))]
        .map(selectionPolicy=>({selectionPolicy,...summary(currentRounds.filter(r=>(r.entry.entryEvidence?.traderDecision?.selectionPolicy||'legacy_unknown')===selectionPolicy))})),
      note:'仅按本轮买入时冻结路线分组；零笔不是零机会。未平仓不算完整收益；非随机对照，不能归因或证明盈利。'},
    byChain:[...new Set(rounds.map(r=>r.entry.chain))].map(chain=>({chain,...summary(rounds.filter(r=>r.entry.chain===chain))})),
    note:'分组可能重叠，不能相加；只描述完整平仓，未平仓另看账户。补款不是盈利，相关性不是因果；旧策略亏损不证明新策略有效。' };
}
