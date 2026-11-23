// Explicit, default-off exception to the narrative tier only. This does not
// relax any structure/quote/cost rule and never signs or broadcasts orders.
import { opportunityChart } from './paper-opportunity-policy.js';
import { reconstructStructureEntry } from './paper-structure-entry-proof.js';
import { ESTIMATED_COST_VERSION } from './paper-estimated-cost.js';

export const EXTERNAL_STRUCTURE_MAIN_ADMISSION_VERSION='external_structure_main_admission_v1';
export const EXTERNAL_STRUCTURE_MAIN_ADMISSION_ENV='PAPER_EXTERNAL_STRUCTURE_MAIN_ADMISSION';
export const externalStructureMainAdmissionEnabled=env=>env?.[EXTERNAL_STRUCTURE_MAIN_ADMISSION_ENV]==='1';
const routes=new Set(['external_breakout','external_pullback','external_trend']);
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const artificial=c=>['synthetic','isSynthetic','noTrade','noTrades','forwardFilled','gapFilled']
  .some(k=>c?.[k]!=null&&c[k]!==false&&c[k]!==0&&c[k]!=='false'&&c[k]!=='0')
  ||/synthetic|forward.?fill|gap.?fill|no.?trade/i.test(String(c?.source||''));

export function reviewExternalStructureMainAdmission(evaluation,{enabled=false,account,nowMs,budget,
  repairReview,modes={}}={}) {
  const e=evaluation?.evidence||{},opportunity=e.opportunity;
  const applicable=e.marketStage==='external'&&opportunity?.basis==='ohlcv'&&routes.has(opportunity.id)
    &&!e.newLaunch&&!e.collectiveSignal&&!opportunity.event;
  const result={version:EXTERNAL_STRUCTURE_MAIN_ADMISSION_VERSION,enabled:enabled===true,applicable,allowed:false,
    scope:'external_ohlcv_narrative_tier_exception_only',route:opportunity?.id??null};
  const fail=reason=>({...result,reason});
  if(enabled!==true)return fail('外盘结构主账本独立准入未启用');
  if(!applicable)return fail('独立准入仅适用于已核实外盘的三条 OHLCV 结构路线');
  if(account?.variant||account?.exitExperimentVersion||account?.estimatedCostModel!==ESTIMATED_COST_VERSION
    ||modes.evidenceTierGate!==true||modes.confirmedMode!==true||modes.continuousPaperMode!==true
    ||modes.opportunityMode!==true||modes.opportunityReviewMode!==true||modes.memeExitMode!==true
    ||modes.recoveryMode!==true||modes.lossRepairMode!==true||modes.estimatedFeeMode!==true
    ||modes.minimalEntryMode===true||modes.diagnosticMode===true)
    return fail('独立准入只接受原有完整恢复模式的估算主账本');
  if(evaluation.decision!=='可模拟'||e.paperEligible!==true||evaluation.missing?.length
    ||e.marketFresh!==true||e.priceFresh!==true||e.safety?.auditComplete!==true
    ||!Array.isArray(e.safety?.missing)||e.safety.missing.length||!Array.isArray(e.safety?.blocked)||e.safety.blocked.length)
    return fail('原有行情、独立报价、入场与完整安全检查未通过');
  if(repairReview?.ready!==true||repairReview.entryPath!=='external_structure'||repairReview.reentry?.ready!==true||!repairReview.thesis)
    return fail('即时重算的外盘结构、退出依据或亏损重入检查未通过');
  const maxBudget=Math.min(10,(account?.cash||0)*.1);
  if(!positive(budget)||budget<1||budget>maxBudget+1e-8)
    return fail('独立准入仍受可用现金十分之一、最高 10U 的原有试仓预算限制');
  const proof=e.recoveryEntry;
  if(proof?.candles?.some(artificial))return fail('独立准入不接受合成、补造或无成交替代 K 线');
  const chart=opportunityChart(proof?.candles,proof?.klineStatus,nowMs,{contiguousTail:true});
  if(!chart.ready||chart.rows.length<24)return fail('独立准入要求至少 24 根新鲜、连续、真实收盘 K 线');
  const structureValidation=reconstructStructureEntry(evaluation,nowMs);
  if(!structureValidation.ready)return fail(structureValidation.reason);
  return {...result,allowed:true,reason:null,validatedAt:new Date(nowMs).toISOString(),
    closedBars:chart.rows.length,budgetUsd:budget,maxBudgetUsd:maxBudget,structureValidation,
    retainedChecks:'原有形态阈值、安全、真实报价、重入、预算、净成本与 writer 最终复核继续执行；此证明不单独授予成交许可'};
}
