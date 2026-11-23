// Forward-only admission proof for the main simulated OHLCV routes. This
// replays existing rules; it neither changes thresholds nor authorizes orders.
import { createHash } from 'node:crypto';
import { PAPER_RECOVERY_VERSION } from './paper-recovery-policy.js';
import { OPPORTUNITY_ROUTES, MAIN_CHART_WINDOW_VERSION, opportunityChart, structurePattern, confirmStructureQuotes } from './paper-opportunity-policy.js';
import { OPPORTUNITY_REVIEW_VERSION, MEME_STRUCTURE_ENTRY_VERSION, reviewStructurePattern } from './paper-opportunity-review.js';
import { validateChartProvenance } from './paper-chart-source.js';

export const STRUCTURE_ENTRY_PROOF_VERSION = 'reconstructed_ohlcv_entry_v1';
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const stamp=value=>typeof value==='number'?(value<1e10?value*1000:value):Date.parse(value||'');
const fresh=(value,nowMs)=>finite(stamp(value))&&stamp(value)<=nowMs&&nowMs-stamp(value)<=120000;
const sameNumber=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=Math.max(Math.abs(a),Math.abs(b),Number.MIN_VALUE)*1e-10;
const sameValue=(a,b)=>finite(b)?sameNumber(a,b):a===b;
const key=token=>`${token?.chain}:${token?.chain==='sol'?token?.address:String(token?.address||'').toLowerCase()}`;
const candles=rows=>Array.isArray(rows)?rows.map(r=>[stamp(r?.time),r?.open,r?.high,r?.low,r?.close,r?.volume]):null;
const quotes=rows=>Array.isArray(rows)?rows.map(r=>[stamp(r?.observedAt),r?.price]):null;
const sameRows=(a,b)=>!!a&&!!b&&a.length===b.length&&a.every((r,i)=>r.length===b[i].length&&r.every((v,j)=>sameValue(v,b[i][j])));

export function reconstructStructureEntry(evaluation,nowMs) {
  const fail=reason=>({version:STRUCTURE_ENTRY_PROOF_VERSION,ready:false,reason});
  const evidence=evaluation?.evidence,opportunity=evidence?.opportunity,proof=evidence?.recoveryEntry;
  const token=evaluation?.token,plan=evidence?.entryPlan;
  const route=OPPORTUNITY_ROUTES.find(r=>r.id===opportunity?.id&&r.basis==='ohlcv');
  if(!finite(nowMs)||!route||opportunity?.basis!=='ohlcv'||evidence.marketStage!=='external'
    ||!finite(token?.price)||token.price<=0
    ||opportunity.reviewVersion!==OPPORTUNITY_REVIEW_VERSION||plan?.entryPolicyVersion!==MEME_STRUCTURE_ENTRY_VERSION
    ||proof?.version!==PAPER_RECOVERY_VERSION||key(proof)!==key(token)||proof.newLaunch||proof.collectiveSignal
    ||proof.chartWindowPolicy!==MAIN_CHART_WINDOW_VERSION||opportunity.chartWindowPolicy!==MAIN_CHART_WINDOW_VERSION)
    return fail('主盘结构入场证明、路线或 CA 不一致');
  const evaluatedAt=stamp(opportunity.evaluatedAt);
  if(!fresh(opportunity.evaluatedAt,nowMs)||!fresh(proof.observedAt,nowMs)
    ||!fresh(proof.observedAt,evaluatedAt)||!fresh(evaluation.observedAt,evaluatedAt))
    return fail('结构判定与行情来源时钟缺失、超前或过期');
  if(!Array.isArray(proof.candles)||proof.candles.length>60||proof.candles.some(r=>!r||typeof r!=='object')
    ||!Array.isArray(proof.quotes)||proof.quotes.length>10||proof.quotes.some(r=>!r||typeof r!=='object'))
    return fail('原始结构或报价证明缺失、损坏或超过冻结边界');
  const chartSource=validateChartProvenance(proof.chartProvenance,token,proof.candles,{nowMs:evaluatedAt});
  if(!chartSource.ready)return fail('冻结的 K 线来源、池、窗口或原始数据不一致');
  const chart=opportunityChart(proof.candles,proof.klineStatus,evaluatedAt,{contiguousTail:true});
  if(!chart.ready||!sameRows(candles(chart.rows),candles(opportunity.closedCandles)))
    return fail('冻结的连续闭合 K 线与原始证明不一致');
  const pattern=reviewStructurePattern(route,chart,token.price,structurePattern(route,chart,token.price,true),{evidenceExit:true});
  if(!pattern.ready||!opportunity.pattern||!Object.keys(pattern).every(k=>sameValue(opportunity.pattern[k],pattern[k]))
    ||!sameNumber(plan.stopPrice,pattern.support)||!sameNumber(plan.targetPrice,pattern.targetPrice)
    ||plan.targetKind!==pattern.targetKind||stamp(opportunity.signalAt)!==pattern.closedAt
    ||opportunity.signalId!==`${token.chain}:${token.address}:${route.id}:${pattern.closedAt}`)
    return fail('入场形态、参考位或目标不能由冻结 K 线重建');
  const original=confirmStructureQuotes(proof.quotes,token,pattern,evaluatedAt);
  const current=confirmStructureQuotes(proof.quotes,token,pattern,nowMs);
  const saved=evidence.confirmedPolicy?.confirmation;
  if(!original.ready||!current.ready||!sameRows(quotes(original.rows),quotes(saved?.rows))
    ||saved?.version!==original.version||saved?.count!==original.count
    ||stamp(saved?.confirmedAt)!==stamp(original.confirmedAt)||stamp(plan.confirmedAt)!==stamp(original.confirmedAt))
    return fail('原始独立报价与确认副本不一致、已过期或未站稳结构');
  const sourceDigest=createHash('sha256').update(JSON.stringify({key:key(token),price:token.price,evaluatedAt,
    candles:candles(chart.rows),quotes:quotes(original.rows),
    ...(chartSource.provenance?{chartProvenance:chartSource.provenance}:{})})).digest('hex');
  return {version:STRUCTURE_ENTRY_PROOF_VERSION,ready:true,validatedAt:new Date(nowMs).toISOString(),
    evaluatedAt:new Date(evaluatedAt).toISOString(),chain:token.chain,address:token.address,
    sourceDigest,chartWindowPolicy:MAIN_CHART_WINDOW_VERSION,patternVersion:OPPORTUNITY_REVIEW_VERSION,
    ...(chartSource.provenance?{chartProvenance:chartSource.provenance}:{}),
    signalClosedAt:new Date(pattern.closedAt).toISOString(),quoteCount:original.count,
    confirmedAt:original.confirmedAt,support:pattern.support,targetPrice:pattern.targetPrice,
    ...(pattern.targetSelectionVersion?{targetSelectionVersion:pattern.targetSelectionVersion}:{}),pattern};
}
