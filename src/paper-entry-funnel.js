import { isDiagnosticPaperEntry } from './paper-diagnostic-entry.js';
import { isConfirmedPaperEntry } from './paper-confirmed-policy.js';
import { readyForPaperQuote, researchReadyForQuote } from './paper-candidate-research.js';

const key=t=>`${t?.chain}:${t?.chain==='sol'?t?.address:String(t?.address||'').toLowerCase()}`;
const stages=[
  ['safety_blocked','明确不可交易或安全检查未通过'],
  ['market_data','行情缺失或过期，等待补齐'],
  ['catalyst','缺少有效原文催化或核实盈利钱包'],
  ['reentry','上次亏损后的重入证据不足'],
  ['safety_data','该入口所需安全字段尚未补齐'],
  ['fees','所选账本的费用模型不可用'],
  ['chart_missing','买点数据未取得，尚不能判断有无机会'],
  ['chart_stale','买点K线已过期，等待刷新'],
  ['chart_incomplete','买点K线不足或断档，等待补齐'],
  ['chart_invalid','买点K线校验未通过'],
  ['structure','入场结构或退出依据尚未建立'],
  ['setup','买盘、形态或其他入场条件尚未成立'],
  ['quote_wait','已可研究报价，等待调度名额'],
  ['quote_scheduled','已进入报价调度，等待报价与资料确认'],
  ['eligible','模拟条件已通过，是否成交以账本为准'],
];

// Independent of the legacy nested funnel: one primary state per exact CA,
// with source/quote counts alongside it. This is telemetry, never an entry gate.
export function paperEntryDiagnostics(evaluations=[],{quoteTargets=[]}={}) {
  const scheduled=new Set(quoteTargets.filter(t=>t.purpose==='candidate'&&t.candidateBook!=='comparison').map(key));
  const groups=new Map();
  for(const row of evaluations) {
    if(!row?.token?.chain||!row.token.address)continue;
    const k=key(row.token);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(row);
  }
  const canQuote=r=>Array.isArray(r.reasons)&&Array.isArray(r.missing)&&(readyForPaperQuote(r)||researchReadyForQuote(r));
  const state=row=>{
    const e=row.evidence||{},repair=e.lossRepair;
    if(row.decision==='可模拟'&&e.paperEligible===true)return 'eligible';
    if(row.decision==='不买'||e.safety?.blocked?.length)return 'safety_blocked';
    if(e.marketFresh!==true)return 'market_data';
    if(repair&&(repair.entryPathAllowed??repair.catalystReady)!==true)return 'catalyst';
    if(repair&&repair.reentry?.ready!==true)return 'reentry';
    if(e.safety?.missing?.length)return 'safety_data';
    if(repair&&repair.fee?.ready!==true)return 'fees';
    if(canQuote(row))return scheduled.has(key(row.token))?'quote_scheduled':'quote_wait';
    if(repair?.entryPath==='external_structure'||e.opportunity?.basis==='ohlcv') {
      const window=e.opportunity?.chartWindow;
      if(window?.code==='source_unavailable')return 'chart_missing';
      if(window?.code==='stale_closed_bars')return 'chart_stale';
      if(['insufficient_closed_bars','missing_intervals','insufficient_contiguous_tail'].includes(window?.code))return 'chart_incomplete';
      if(window?.code&&window.code!=='ready')return 'chart_invalid';
    }
    if(repair&&!repair.thesis)return 'structure';
    return 'setup';
  };
  const rank=new Map(stages.map(([id],i)=>[id,i])),counts=new Map();
  let verifiedCatalyst=0,externalStructure=0,quoteResearchReady=0,quoteScheduled=0,eligible=0;
  for(const rows of groups.values()) {
    const states=rows.map(state).sort((a,b)=>rank.get(b)-rank.get(a));
    counts.set(states[0],(counts.get(states[0])||0)+1);
    if(rows.some(r=>r.evidence?.lossRepair?.catalystReady===true))verifiedCatalyst++;
    if(rows.some(r=>r.evidence?.lossRepair?.entryPath==='external_structure'&&r.evidence.lossRepair.entryPathAllowed===true))externalStructure++;
    if(rows.some(canQuote))quoteResearchReady++;
    if(scheduled.has(key(rows[0].token)))quoteScheduled++;
    if(states[0]==='eligible')eligible++;
  }
  return {version:'paper_entry_diagnostics_v1',detected:groups.size,verifiedCatalyst,externalStructure,quoteResearchReady,quoteScheduled,eligible,
    blockers:stages.map(([code,label])=>({code,label,count:counts.get(code)||0})).filter(s=>s.count).sort((a,b)=>b.count-a.count),
    note:'按链与 CA 去重的当前快照；每个候选只计一个主要状态。没有有效候选不代表市场没有机会，调度与条件通过均不等于成交。'};
}
// Diagnostic counts only; never used to approve a trade. Every stage is a
// subset of the preceding one, deduplicated by chain + exact normalized CA.
export function paperEntryFunnel(evaluations = []) {
  let rows = evaluations;
  const count = () => new Set(rows.map(row => `${row.token.chain}:${row.token.address}`)).size;
  const result = { detected: count() };
  for (const [name, pass] of [
    ['marketFresh', row => row.evidence?.marketFresh === true],
    ['flowReady', row => row.evidence?.opportunity ? row.evidence.opportunity.signalReady === true : row.evidence?.flowFresh === true &&
      [['uniqueBuyerCount', 'minBuyers'], ['highProfitCount', 'minHighProfit'], ['smartMoneyCount', 'minSmartMoney'], ['netBuyUsd', 'minNetBuy']]
        .every(([metric, threshold]) => Number.isFinite(row.evidence.flow?.[metric]) && Number.isFinite(row.evidence.entryThresholds?.[threshold])
          && row.evidence.flow[metric] >= row.evidence.entryThresholds[threshold])],
    ['safetyReady', row => isDiagnosticPaperEntry(row.evidence) ? row.evidence.diagnostic.fillBoundariesPass === true
      : row.evidence?.safety?.missing?.length === 0 && row.evidence.safety.blocked?.length === 0],
    ['chartReady', row => isConfirmedPaperEntry(row.evidence) ? row.evidence.confirmedPolicy.confirmation.ready === true
      : isDiagnosticPaperEntry(row.evidence) || row.evidence?.chart?.ready === true],
    ['quoteFresh', row => row.evidence?.priceFresh === true],
    ['eligible', row => row.decision === '可模拟' && row.evidence?.paperEligible === true],
  ]) { rows = rows.filter(pass); result[name] = count(); }
  return result;
}
