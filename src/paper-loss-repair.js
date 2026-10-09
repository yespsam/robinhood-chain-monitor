// Forward-only repair overlay. No wallet, RPC, signing or historical mutations.
import { opportunityChart } from './paper-opportunity-policy.js';
import { classifyEntryEvidence } from './paper-evidence-review.js';
import { ESTIMATED_COST_VERSION, ESTIMATED_COST_TEXT } from './paper-estimated-cost.js';
import {verifiedLaunchContext,LAUNCH_THESIS_VERSION} from './paper-launch-policy.js';
import {validPoolSignal,poolEntryAllowed} from './paper-pool-signal.js';
import {paperLossLearning} from './paper-loss-learning.js';
import {validAlphaSignal,ALPHA_EVENT_TTL} from './binance-alpha-catalog.js';
import {validCollectiveSignal,collectiveWalletThesis,walletSignalRoute} from './paper-collective-signal.js';

export const LOSS_REPAIR_VERSION = 'paper_loss_repair_v1';
export const TRADE_THESIS_VERSION = 'entry_bound_structure_v1';
export const PAPER_ENTRY_ROUTES_VERSION = 'separate_event_structure_v1';
export const PAPER_ENTRY_ROUTES_TEXT = '独立估算模拟盘：新闻事件、核实盈利钱包、内盘已核逐笔放量与外盘突破/回踩/趋势分别评估；普通链上地址不授予盈利教师资格。外盘量价路线不要求新闻原文，但仍须新鲜完整结构、可卖性、税率、成本空间和连续真实报价。新原文可形成后续催化，旧帖不续期、不补造叙事。';
// A live quote has a tx field, but no validated production round-trip fee
// adapter yet. Do not silently invent one or reuse chain-wide receipt samples.
export const ORDER_FEE_CAPABILITY = Object.freeze({status:'unavailable',ready:false,
  reason:'订单级路由费用尚未接通；链级费用样本仅研究，不允许用于主盘新仓扣账'});
export const LOSS_REPAIR_TEXT = '亏损修复观察模式：订单级费用待接通，主盘新仓保持暂停。叙事、核实盈利钱包、纯量价分别研究；入退场绑定同一真实结构；亏损重入须新证据。旧仓与历史不重写，TG 和持仓退出继续。';
const stamp=v=>typeof v==='number'?v:Date.parse(v||'');
const positive=n=>Number.isFinite(n)&&n>0;
const key=t=>`${t?.chain}:${t?.chain==='sol'?t?.address:String(t?.address||'').toLowerCase()}`;
const fresh=(at,now,max)=>Number.isFinite(stamp(at))&&stamp(at)<=now&&now-stamp(at)<=max;
const walletAddress=(chain,v)=>typeof v==='string'&&(chain==='sol'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[0-9a-f]{40}$/i).test(v);
const walletKey=(chain,v)=>chain==='sol'?v:String(v).toLowerCase();
function sourceIdentity(raw) {
  try {
    const u=new URL(raw);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return null;
    const host=u.hostname.toLowerCase().replace(/^www\./,'');
    if(['x.com','twitter.com','mobile.twitter.com'].includes(host)) {
      const match=u.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/);return match?`x:status:${match[1]}`:null;
    }
    u.hash='';for(const name of [...u.searchParams.keys()])if(/^utm_|^(s|ref|ref_src|ref_url|fbclid|gclid)$/.test(name))u.searchParams.delete(name);
    u.searchParams.sort();return u.toString();
  }catch{return null;}
}

export function entryBoundThesis(row,nowMs) {
  const e=row?.evidence||{},p=e.recoveryEntry,t=row?.token;
  if(!t||key(p)!==key(t)||!fresh(p?.observedAt,nowMs,120000))return null;
  const chart=opportunityChart(p.candles,p.klineStatus,nowMs,{contiguousTail:true});
  if(!chart.ready||chart.rows.length<24||!positive(t.price))return null;
  const route=e.opportunity,structural=route?.basis==='ohlcv';
  const anchor=structural?route.pattern?.reclaimPrice:Math.min(...chart.rows.slice(-3).map(r=>r.low));
  if(!positive(anchor)||anchor>=t.price)return null;
  return {version:TRADE_THESIS_VERSION,chain:t.chain,address:t.address,createdAt:new Date(nowMs).toISOString(),
    setupId:route?.id||'unknown',anchor,entryPrice:t.price,chartClosedAt:chart.rows.at(-1).time+60000,
    kind:structural?'入场已收复结构位':'入场前最近三根已收盘 K 线低点',
    meaning:'冻结的实际结构失效参考；非固定百分比止损、保证成交价或最大亏损承诺'};
}

export function validEntryBoundThesis(thesis,position) {
  return thesis?.version===TRADE_THESIS_VERSION&&key(thesis)===key(position)
    &&positive(thesis.anchor)&&positive(thesis.entryPrice)&&thesis.anchor<thesis.entryPrice
    &&thesis.entryPrice===position.entryPrice&&stamp(thesis.createdAt)===stamp(position.openedAt)
    &&Number.isSafeInteger(thesis.chartClosedAt)&&thesis.chartClosedAt<=stamp(position.openedAt)
    &&stamp(position.openedAt)-thesis.chartClosedAt<=90000
    &&typeof thesis.setupId==='string'&&['入场已收复结构位','入场前最近三根已收盘 K 线低点'].includes(thesis.kind);
}

function eventProof(row,nowMs) {
  const poolSignal=row.evidence?.opportunity?.event;
  if(poolSignal?.source==='new_pool_first_three'&&validPoolSignal(poolSignal,row.token,nowMs))
    return {url:poolSignal.sourceUrl,identity:poolSignal.sourceId,at:stamp(poolSignal.sourceAt),binding:'onchain_pool'};
  const t=row.evidence?.narrativeThesis,c=classifyEntryEvidence({chain:row.token.chain,address:row.token.address,atMs:nowMs,entryEvidence:row.evidence});
  // Alpha has its own bounded follow-through window. Preserve the original
  // listing clock and exact catalog/CA binding; a generic old tweet cannot use it.
  const route=row.evidence?.opportunity,alpha=route?.event;
  if(route?.id==='alpha_listing'&&c.narrative==='official_catalog'
    &&validAlphaSignal(alpha,row.token,nowMs)&&!t?.invalidation?.blockNewNarrativeEntry
    &&t.event.sourceUrl===alpha.sourceUrl&&stamp(t.event.sourceAt)===alpha.listingTime
    &&t.event.sourceId===alpha.id)
    return {url:alpha.sourceUrl,identity:alpha.id,at:alpha.listingTime,binding:c.narrative,windowMs:ALPHA_EVENT_TTL};
  if(c.narrative==='official_catalog')return null;
  if(!['official_catalog','direct_ca','community_link'].includes(c.narrative)
    ||t?.invalidation?.blockNewNarrativeEntry||t?.catalyst?.phase==='repeated'||!fresh(t?.event?.sourceAt,nowMs,3600000))return null;
  const identity=sourceIdentity(t.event.sourceUrl);if(!identity)return null;
  return {url:t.event.sourceUrl,identity,at:stamp(t.event.sourceAt),binding:c.narrative};
}

export function launchEventThesis(row,nowMs) {
  const e=row.evidence||{},event=e.opportunity?.event;
  const c=verifiedLaunchContext(e.recoveryEntry,row.token,event,nowMs),proof=eventProof(row,nowMs);
  if(!c||!proof||e.opportunity?.id!=='monitored_event'||JSON.stringify(c)!==JSON.stringify(e.newLaunch)
    ||e.marketStage!==c.marketStage||!positive(row.token.price))return null;
  return {version:LAUNCH_THESIS_VERSION,chain:row.token.chain,address:row.token.address,createdAt:new Date(nowMs).toISOString(),
    entryPrice:row.token.price,sourceUrl:proof.url,sourceIdentity:proof.identity,sourceAt:new Date(proof.at).toISOString(),
    launchCreatedAt:new Date(c.creationTimestamp).toISOString(),...(c.pool?{pool:c.pool}:{}),
    kind:c.pool?'新底池前三 CA 的链上创建顺序，非 K 线结构入场':'新盘事件与 CA 关联，非 K 线结构入场',
    meaning:c.pool?'冻结底池与前三 CA 创建证据；持续核查资金行为和叙事失效，不虚构价格止损位':'冻结原文与新盘阶段；持续核查资金行为和叙事失效，不虚构价格止损位'};
}

export function validLaunchEventThesis(thesis,position) {
  const expected=launchEventThesis({token:{chain:position.chain,address:position.address,price:position.entryPrice},
    evidence:position.entryEvidence},stamp(position.openedAt));
  return !!expected&&JSON.stringify(expected)===JSON.stringify(thesis);
}

// No fixed cooldown: a new timestamp alone does not disprove a failed thesis.
export function lossReentryCheck(row,account,nowMs) {
  const fills=(account?.trades||[]).filter(t=>key(t)===key(row.token)&&t.atMs<=nowMs);
  const lastBuy=fills.findLast(t=>t.side==='buy');
  if(!lastBuy)return {ready:true,reason:null,proof:'首次入场'};
  const exits=fills.filter(t=>t.atMs>=lastBuy.atMs&&t.side!=='buy');
  if(!exits.length||exits.reduce((n,t)=>n+t.quantity,0)<lastBuy.quantity*(1-1e-9)
    ||exits.reduce((n,t)=>n+t.realizedPnl,0)>=0)return {ready:true,reason:null,proof:'非完整亏损后的重入'};
  const closedAt=exits.at(-1).atMs,lastExit=exits.at(-1),e=row.evidence||{};
  const event=eventProof(row,nowMs),previousEvent=lastBuy.entryEvidence?.narrativeThesis?.event?.sourceUrl;
  if(event&&event.at>closedAt&&event.identity!==sourceIdentity(previousEvent))return {ready:true,reason:null,proof:'平仓后新原文催化',closedAt};
  const flow=e.recoveryEntry?.flow,previousBuyers=lastBuy.entryEvidence?.memeExitContext?.smartBuyers;
  const wallets=Array.isArray(flow?.wallets)?flow.wallets:[];
  const consistent=wallets.every(w=>walletAddress(row.token.chain,w.wallet)&&[w.buyUsd,w.sellUsd,w.netBuyUsd].every(Number.isFinite)
    &&w.buyUsd>=0&&w.sellUsd>=0&&Math.abs(w.buyUsd-w.sellUsd-w.netBuyUsd)<1e-6
    &&(w.tags===undefined||Array.isArray(w.tags)))
    &&new Set(wallets.map(w=>row.token.chain==='sol'?w.wallet:w.wallet.toLowerCase())).size===wallets.length;
  const newBuyers=consistent?wallets.filter(w=>walletAddress(row.token.chain,w.wallet)&&positive(w.netBuyUsd)&&w.netBuyUsd>=100
    &&(w.highProfit===true||w.tags?.some(t=>['smart_money','smart_degen','smartmoney'].includes(t))||flow.provider==='binance_smartmoney')
    &&fresh(w.lastBuyAt,nowMs,90000)&&stamp(w.lastBuyAt)>closedAt&&stamp(w.lastBuyAt)<=stamp(flow.observedAt)
    &&Array.isArray(previousBuyers)&&!previousBuyers.some(v=>walletKey(row.token.chain,v)===walletKey(row.token.chain,w.wallet))):[];
  if(consistent&&Array.isArray(previousBuyers)&&previousBuyers.length&&lastBuy.entryEvidence?.memeExitContext?.cohortKnown===true
    &&lastBuy.entryEvidence?.memeExitContext?.cohortTruncated!==true
    &&flow.provider===lastBuy.entryEvidence?.flowDiagnostics?.provider&&key(flow)===key(row.token)
    &&flow.complete===true&&flow.fresh===true&&!flow.coverageGap&&['healthy','ok'].includes(flow.status)
    &&fresh(flow.observedAt,nowMs,120000)&&flow.netBuyUsd>=300
    &&new Set(newBuyers.map(w=>walletKey(row.token.chain,w.wallet))).size>=2)
    return {ready:true,reason:null,proof:'平仓后出现至少两个不同的标签净买地址（控制人独立性未验证）',closedAt};
  const level=lastExit.exitEvidence?.thesisDecision?.structure?.referenceLevel;
  const p=e.recoveryEntry,c=p&&key(p)===key(row.token)?opportunityChart(p.candles,p.klineStatus,nowMs,{contiguousTail:true}):null;
  if(positive(level)&&c?.ready&&c.rows.slice(-2).every(b=>b.time>=closedAt&&b.close>level)&&row.token.price>level)
    return {ready:true,reason:null,proof:'平仓后两根完整收盘重新收复上次失效位',closedAt};
  return {ready:false,closedAt,reason:'同 CA 上次亏损原因未被新催化、新买家或结构修复推翻；仅更新时间不重买',proof:null};
}

export function repairEntryReview(row,account,nowMs,{estimatedFees=false}={}) {
  const e=row.evidence||{},event=eventProof(row,nowMs);
  const wallet=classifyEntryEvidence({chain:row.token.chain,address:row.token.address,atMs:nowMs,entryEvidence:e});
  // Only the explicitly isolated estimated PAPER book enables this route.
  // Admission to research is not proof of a pattern, nor a verified catalyst.
  const external=estimatedFees&&e.costAssumptions?.version===ESTIMATED_COST_VERSION
    &&e.marketStage==='external'&&!e.newLaunch&&e.opportunity?.basis==='ohlcv'
    &&['external_breakout','external_pullback','external_trend'].includes(e.opportunity.id);
  const collective=e.opportunity?.id===walletSignalRoute(e.collectiveSignal)&&validCollectiveSignal(e.collectiveSignal,row.token,nowMs);
  const catalystReady=!!event||collective||wallet.wallet==='verified_profit';
  const entryPathAllowed=catalystReady||external;
  const group=collective?walletSignalRoute(e.collectiveSignal):event?.binding==='onchain_pool'?'new_pool_first_three':event?'event_narrative':wallet.wallet==='verified_profit'?'verified_wallet':e.opportunity?.basis==='ohlcv'?'price_only':'tagged_or_unknown_wallet';
  const researchReasons=[];
  if(e.opportunity?.event?.source==='new_pool_first_three'&&!poolEntryAllowed(e.opportunity.event,account,nowMs))
    researchReasons.push('新底池前三 CA 已消费、排序冲突或创建证明失效；不替补第四名');
  if(!entryPathAllowed || e.narrativeThesis?.invalidation?.blockNewNarrativeEntry) {
    const hasSource=['official_catalog','direct_ca','community_link'].includes(wallet.narrative);
    researchReasons.push(hasSource && e.narrativeThesis?.invalidation?.blockNewNarrativeEntry
      ? '已记录叙事存在否认或关联失效，不能作为新开仓催化'
      : wallet.narrative==='official_catalog'
        ? '官方 Alpha 目录、精确 CA 或二十四小时跟随窗口失效；等待有效目录或核实盈利买家'
      : hasSource && !fresh(e.narrativeThesis?.event?.sourceAt,nowMs,3600000)
        ? '已记录原文 / 官方目录，但已超过一小时催化窗口；等待新事件或核实盈利买家，不是未采到原文'
        : '缺少有效原文催化或核实盈利钱包；仅标签 / 纯量价保留独立研究，不进主盘');
  }
  const thesis=e.newLaunch?launchEventThesis(row,nowMs):collective&&['internal','near_completion'].includes(e.marketStage)?collectiveWalletThesis(row,nowMs):entryBoundThesis(row,nowMs);
  if(e.collectiveSignal&&(!collective||JSON.stringify(e.collectiveSignal)!==JSON.stringify(e.recoveryEntry?.collectiveSignal)
    ||e.marketStage!==e.recoveryEntry?.marketStage||e.safety?.auditComplete!==true||e.safety?.missing?.length||e.safety?.blocked?.length))
    researchReasons.push('钱包算法信号或基础安全证明尚未核实');
  if(e.newLaunch&&(e.safety?.auditComplete!==true||e.safety?.missing?.length||e.safety?.blocked?.length))
    researchReasons.push('新盘快线基础安全数据尚未验证');
  if(!thesis)researchReasons.push(e.newLaunch?'等待有效新盘阶段与原文 CA 关联':'等待可绑定入场的真实结构失效位，不能用买入前已有弱势作为新退出理由');
  const reentry=lossReentryCheck(row,account,nowMs);if(!reentry.ready)researchReasons.push(reentry.reason);
  const modelReady=estimatedFees&&e.costAssumptions?.version===ESTIMATED_COST_VERSION;
  return {version:LOSS_REPAIR_VERSION,group,thesis,reentry,fee:modelReady?{status:'model_only',ready:true,actualOnchainFee:false}:{...ORDER_FEE_CAPABILITY},
    catalystReady,entryPathAllowed,entryRoutesVersion:PAPER_ENTRY_ROUTES_VERSION,
    entryPath:collective?walletSignalRoute(e.collectiveSignal):external?'external_structure':event?'event_narrative':wallet.wallet==='verified_profit'?'verified_wallet':null,
    researchReady:researchReasons.length===0,researchReasons,ready:modelReady&&researchReasons.length===0,
    reasons:[...(modelReady?[]:[ORDER_FEE_CAPABILITY.reason]),...researchReasons],automaticParameterChanges:false};
}

export function applyLossRepair(row,account,nowMs,{estimatedFees=false}={}) {
  const repair=repairEntryReview(row,account,nowMs,{estimatedFees});
  if(estimatedFees&&repair.ready)return {...row,entryLogic:`${ESTIMATED_COST_TEXT} ${PAPER_ENTRY_ROUTES_TEXT} ${row.entryLogic}`,evidence:{...row.evidence,lossRepair:repair}};
  const decision=row.decision==='不买'?'不买':'观察';
  return {...row,decision,reasons:[...new Set([...row.reasons,...repair.reasons])],entryLogic:`${estimatedFees?ESTIMATED_COST_TEXT:LOSS_REPAIR_TEXT} ${row.entryLogic}`,
    evidence:{...row.evidence,paperEligible:false,lossRepair:repair,
      costAssumptions:estimatedFees?row.evidence.costAssumptions:row.evidence.costAssumptions?{...row.evidence.costAssumptions,accountingEligible:false,
        label:'仅旧链级费用参考，不用于主盘新仓扣账；订单级费用尚未验证'}:undefined,
      opportunityRoutes:row.evidence.opportunityRoutes?.map(r=>({...r,researchDecision:r.decision,
        decision:r.decision==='不买'?'不买':'观察',repairStatus:!repair.fee.ready?'order_fee_unavailable'
          :!repair.entryPathAllowed?'catalyst_unavailable':!repair.reentry.ready?'reentry_unproven'
          :!repair.thesis?'entry_thesis_unavailable':'research_incomplete'})),
      entryPlan:row.evidence.entryPlan?{...row.evidence.entryPlan,eligible:false}:row.evidence.entryPlan,
      traderDecision:row.evidence.traderDecision?{...row.evidence.traderDecision,decision}:undefined}};
}

// Stable IDs make immediate local anomalies visible without waking AI or
// generating more Telegram noise; historic reports and trades are untouched.
export function lossRepairReport(account,evaluations,nowMs,{estimatedFees=false}={}) {
  const alerts=[];
  for(const t of (account?.trades||[]).slice(-100)) {
    const gas=t.side==='buy'?t.entryEvidence?.costAssumptions?.gasUsd:t.exitEvidence?.gasUsd;
    if(Number.isFinite(gas)&&gas>0&&gas>t.grossUsd*.25)alerts.push({id:`gas:${t.id}`,kind:'cost_sample_anomaly',
      chain:t.chain,address:t.address,symbol:t.symbol,at:new Date(t.atMs).toISOString(),
      reason:'记录中 Gas 超过代币成交金额的 25%；仅诊断，不改写历史成本'});
    if(t.side==='sell'&&t.netUsd<0)alerts.push({id:`negative-return:${t.id}`,kind:'negative_exit_proceeds',chain:t.chain,address:t.address,
      symbol:t.symbol,at:new Date(t.atMs).toISOString(),reason:'卖出费用超过回款，正在消耗其他现金；不得用零回款掩盖'});
  }
  return {version:LOSS_REPAIR_VERSION,status:estimatedFees?'estimated_experiment':'research_only',updatedAt:new Date(nowMs).toISOString(),
    learning:paperLossLearning(account,nowMs),
    feeCapability:estimatedFees?{status:'model_only',ready:true,actualOnchainFee:false}:{...ORDER_FEE_CAPABILITY},text:estimatedFees?ESTIMATED_COST_TEXT:LOSS_REPAIR_TEXT,automaticParameterChanges:false,
    groups:Object.fromEntries(['event_narrative','new_pool_first_three','collective_smart_money','prequalified_wallet','internal_burst','onchain_internal_burst','verified_wallet','price_only','tagged_or_unknown_wallet'].map(g=>
      [g,evaluations.filter(e=>e.evidence?.lossRepair?.group===g).length])),alerts:alerts.slice(-20)};
}
