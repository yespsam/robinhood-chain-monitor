// Explicit post-review PAPER policy. It never signs or submits transactions.
import { opportunityChart, MAIN_CHART_WINDOW_VERSION } from './paper-opportunity-policy.js';
import { memeEntryContext } from './paper-meme-exit.js';
import {launchContext,launchQuote,verifiedLaunchContext,LAUNCH_ENTRY_TEXT} from './paper-launch-policy.js';
import {validCollectiveSignal,collectiveQuote,internalOnlySignal} from './paper-collective-signal.js';

export const PAPER_RECOVERY_VERSION = 'paper_recovery_v1';
export const EVIDENCE_GAP_EXIT_VERSION = 'evidence_gap_exit_v1';
export const EVIDENCE_GAP_POLICY = Object.freeze({version:EVIDENCE_GAP_EXIT_VERSION,
  missingForMs:300000,maxObservationGapMs:120000,quoteMaxAgeMs:15000,minObservations:2});
export const RECOVERY_ENTRY_TEXT = '恢复期：平台喊单不能直接买；监控事件须有至少两个已核实标签净买地址、近期正净流入与两次触发后走强报价。所有新仓先验证退出数据可用。按可用现金 10%、最高 10U 试仓，仍检查模型成本；不自动恢复开仓。';
export const validEvidenceGapPolicy = p => !!p && Object.keys(p).length===Object.keys(EVIDENCE_GAP_POLICY).length
  && Object.entries(EVIDENCE_GAP_POLICY).every(([k,v])=>p[k]===v);
const time = x => typeof x==='number'?x:Date.parse(x||'');
const key = x => `${x?.chain}:${x?.address}`;
const fresh = (x,now,age) => Number.isFinite(time(x))&&time(x)<=now&&now-time(x)<=age;

export const BREAKOUT_FLOW_VERSION = 'bsc_breakout_observed_outflow_v1';
// A contradiction filter for the recovered BSC breakout lane, not a new buy
// signal. Public tagged-wallet coverage is not the whole market; missing,
// stale, partial and zero flows must never be described as selling.
export function breakoutFlowCheck(flow, token, opportunity, nowMs) {
  const applicable=token?.chain==='bsc'&&opportunity?.id==='external_breakout'&&opportunity.basis==='ohlcv';
  const matches=flow?.chain===token?.chain&&typeof flow?.address==='string'&&typeof token?.address==='string'
    &&/^0x[\da-f]{40}$/i.test(token.address)&&flow.address.toLowerCase()===token.address.toLowerCase();
  // Local cohort truncation is not a source coverage failure. Preserve the
  // scalar source coverage separately without making the truncated wallets
  // usable for cohort-entry or exit validation.
  const coverage=flow?.coverageGap==='proof_wallets_truncated'&&flow.preTruncationCoverage?.version==='source_flow_coverage_v1'
    ?flow.preTruncationCoverage:flow;
  const sourceKnown=['gmgn','binance_smartmoney','binance_kol'].includes(flow?.provider)
    &&typeof flow?.scope==='string'&&flow.scope.trim().length>0;
  const usable=applicable&&matches&&sourceKnown&&flow.fresh===true&&coverage.complete===true
    &&['ok','healthy'].includes(flow.status)&&!coverage.coverageGap&&fresh(flow.observedAt,nowMs,120000)
    &&typeof flow.netBuyUsd==='number'&&Number.isFinite(flow.netBuyUsd);
  const blocked=usable&&flow.netBuyUsd<0;
  return {version:BREAKOUT_FLOW_VERSION,applicable,blocked,usable,
    status:!applicable?'not_applicable':!usable?'unknown':blocked?'observed_net_outflow':'no_observed_net_outflow',
    provider:flow?.provider||null,scope:flow?.scope||null,observedAt:flow?.observedAt??null,
    netBuyUsd:usable?flow.netBuyUsd:null,maxAgeMs:120000,
    reason:blocked?'外盘突破已有新鲜、完整的已观测净流出，先观察，不以放量单独追入':null,
    note:'只检查绑定此 CA 的已采集来源窗口；不是全市场净流量，非负或未知也不授予买入许可'};
}

export function recoveryEntryCheck(proof, token, event, nowMs, opportunity = null) {
  const missing=[],reasons=[];
  if(proof?.version!==PAPER_RECOVERY_VERSION||key(proof)!==key(token)||!fresh(proof.observedAt,nowMs,120000))
    return {ready:false,missing:['恢复期绑定此 CA 的入场证据'],reasons,exitObservable:false};
  if(proof.newLaunch) {
    const context=verifiedLaunchContext(proof,token,event,nowMs),quote=launchQuote(proof,token,event,nowMs);
    return {ready:!!context&&quote.ready,missing:context&&quote.ready?[]:[quote.reason],reasons:[],
      exitObservable:quote.ready,chartReady:false,requiresChart:false,
      basis:'新盘按已核实事件与真实报价入场；资金行为与后续结构持续采集，不把缺失当健康'};
  }
  if(proof.collectiveSignal) {
    const valid=validCollectiveSignal(proof.collectiveSignal,token,nowMs),quote=collectiveQuote(proof.quotes,token,proof.collectiveSignal,nowMs);
    const internal=['internal','near_completion'].includes(proof.marketStage);
    if(internalOnlySignal(proof.collectiveSignal.version)&&!internal)missing.push('地址/放量快线仅允许已核实内盘');
    const chart=internal?null:opportunityChart(proof.candles,proof.klineStatus,nowMs,{contiguousTail:true});
    if(!valid)missing.push('三组已核实盈利钱包的新鲜净买共振');
    if(!quote.ready)missing.push(quote.reason);
    if(!internal&&(proof.marketStage!=='external'||!chart?.ready||chart.rows.length<24))missing.push('新鲜且足够的 K 线');
    return {ready:!missing.length,missing,reasons:[],exitObservable:valid,requiresChart:!internal,
      chartReady:!!chart?.ready,basis:'同源净买群体作为入场依据；内盘不等 K 线，外盘保留真实结构检查'};
  }
  if(proof.chartWindowPolicy!=null&&proof.chartWindowPolicy!==MAIN_CHART_WINDOW_VERSION)
    return {ready:false,missing:['可验证的 K 线窗口版本'],reasons,exitObservable:false};
  const chart=opportunityChart(proof.candles,proof.klineStatus,nowMs,{contiguousTail:proof.chartWindowPolicy===MAIN_CHART_WINDOW_VERSION});
  const context=memeEntryContext(token,{flow:proof.flow},nowMs);
  const buyers=context.smartBuyers.length;
  const sourceAt=time(event?.sourceAt),flowAt=time(proof.flow?.observedAt);
  const postEventBuyers=context.smartBuyers.filter(address=>{
    const w=proof.flow?.wallets?.find(w=>w.wallet===address),bought=time(w?.lastBuyAt);
    return fresh(bought,nowMs,90000)&&bought<=flowAt&&(!event||bought>=sourceAt);
  });
  const buying=context.cohortKnown&&postEventBuyers.length>=2&&proof.flow.netBuyUsd>=300;
  const exitObservable=chart.ready&&chart.rows.length>=24||context.cohortKnown&&buyers>=2;
  const breakoutFlow=breakoutFlowCheck(proof.flow,token,opportunity,nowMs);
  if(breakoutFlow.blocked)reasons.push(breakoutFlow.reason);
  if(!exitObservable)missing.push('可持续取得的退出量价或地址行为证据');
  if(event) {
    if(!buying)reasons.push('恢复期监控事件需要近期双地址净买入及至少 300U 净流入');
    const rows=(proof.quotes||[]).filter(q=>key(q)===key(token)&&q.status==='ok'
      &&Number.isFinite(q.price)&&q.price>0&&fresh(q.observedAt,nowMs,15000)&&time(q.observedAt)>=sourceAt)
      .toSorted((a,b)=>time(a.observedAt)-time(b.observedAt));
    const times=new Set(rows.map(q=>time(q.observedAt))),last=rows.at(-1);
    if(times.size<2||rows.length!==times.size||time(last?.observedAt)-time(rows[0]?.observedAt)<3000
      ||!fresh(last?.observedAt,nowMs,5000)||last?.price!==token.price
      ||last.price<=rows[0].price||last.price<rows.at(-2)?.price)missing.push('触发后两次独立走强报价');
  }
  return {ready:!missing.length&&!reasons.length,missing,reasons,exitObservable,
    breakoutFlow,
    chartReady:chart.ready&&chart.rows.length>=24,netBuyers:buyers,recentNetBuyers:postEventBuyers.length,
    basis:event?.source==='gmgn_platform_call'?'平台提示＋真实买盘，不代表叙事已核实':event?'原帖关联＋真实买盘':'原路线＋退出数据检查'};
}

function recoveryProof(token, input) {
  const raw=input.flow||{},wallets=Array.isArray(raw.wallets)?raw.wallets:[];
  const flow=Object.fromEntries(['chain','address','provider','status','fresh','complete','observedAt','coverageGap','netBuyUsd','scope'].map(k=>[k,raw[k]]));
  flow.wallets=wallets.slice(0,200).map(w=>Object.fromEntries(['wallet','buyUsd','sellUsd','netBuyUsd','tags','highProfit','lastBuyAt','lastSellAt'].map(k=>[k,w[k]])));
  if(wallets.length>200){
    flow.preTruncationCoverage={version:'source_flow_coverage_v1',complete:raw.complete===true,coverageGap:raw.coverageGap||null};
    flow.complete=false;flow.coverageGap='proof_wallets_truncated';
  }
  return {version:PAPER_RECOVERY_VERSION,chain:token.chain,address:token.address,
    ...(input.memeExitMode?{chartWindowPolicy:MAIN_CHART_WINDOW_VERSION}:{}),
    observedAt:input.observedAt,flow:structuredClone(flow),
    candles:structuredClone((input.candles||[]).slice(-60)),klineStatus:input.klineStatus,
    quotes:structuredClone((input.quoteHistory||[]).slice(-10))};
}

// Local to one evaluation: copy source evidence once, never cache across ticks.
// Route-specific events retain distinct checks; the ledger rechecks the raw proof.
export function createRecoveryEntryFinalizer(input) {
  const proofs=new Map(),checks=new Map();
  return row=>{
    const tokenKey=key(row.token);
    if(!proofs.has(tokenKey))proofs.set(tokenKey,recoveryProof(row.token,input));
    const launch=input.lossRepairMode&&row.evidence.newLaunch?launchContext(input.sourceToken,row.evidence.opportunity?.event,input.nowMs):null;
    const proof=launch?{...proofs.get(tokenKey),newLaunch:launch}:row.evidence.collectiveSignal?
      {...proofs.get(tokenKey),collectiveSignal:row.evidence.collectiveSignal,marketStage:row.evidence.marketStage}:proofs.get(tokenKey);
    const event=row.evidence.opportunity?.id==='monitored_event'?row.evidence.opportunity.event:null;
    const opportunity=row.evidence.opportunity;
    const checkKey=JSON.stringify([tokenKey,row.token.price,event,launch,proof.collectiveSignal?.id,proof.marketStage,opportunity?.id,opportunity?.basis]);
    if(!checks.has(checkKey))checks.set(checkKey,recoveryEntryCheck(proof,row.token,event,input.nowMs,opportunity));
    return checkedRecoveryEntry(row,proof,checks.get(checkKey));
  };
}

export function applyRecoveryEntry(row,input) { return createRecoveryEntryFinalizer(input)(row); }

function checkedRecoveryEntry(row,proof,check) {
  const eligible=row.decision==='可模拟'&&check.ready;
  const missing=[...new Set([...row.missing,...check.missing])];
  const reasons=[...new Set([...(row.decision==='可模拟'&&!check.ready?[]:row.reasons),...check.reasons])];
  return {...row,decision:row.decision==='不买'?'不买':eligible?'可模拟':'观察',
    missing,reasons,score:Math.max(0,row.score-(missing.length-row.missing.length)*10-check.reasons.length*15),
    entryLogic:(proof.newLaunch||proof.collectiveSignal?row.entryLogic:`${RECOVERY_ENTRY_TEXT} ${row.entryLogic}`)
      +(check.breakoutFlow?.applicable?' BSC 突破净流出过滤试验：已采集来源窗口存在新鲜完整净流出时先观察；未知不当作卖出，仍须通过全部原有条件。':''),
    evidence:{...row.evidence,paperEligible:eligible,recoveryEntry:proof,recoveryCheck:check,
      ...(check.breakoutFlow?.applicable?{opportunity:{...row.evidence.opportunity,breakoutFlow:check.breakoutFlow,
        signalReady:row.evidence.opportunity.signalReady===true&&!check.breakoutFlow.blocked}}:{}),
      entryPlan:row.evidence.entryPlan?{...row.evidence.entryPlan,eligible,summary:proof.newLaunch||proof.collectiveSignal?row.entryLogic:RECOVERY_ENTRY_TEXT}:row.evidence.entryPlan}};
}

export function applyEvidenceGapExit(position, mark, decision, nowMs, { allowExit = true } = {}) {
  const p=position.evidenceGapPolicy;
  if(!validEvidenceGapPolicy(p))return decision;
  if(key(mark)!==key(position)||mark.status!=='ok'||!Number.isFinite(mark.price)||mark.price<=0
    ||!fresh(mark.observedAt,nowMs,p.quoteMaxAgeMs)||time(mark.observedAt)<=time(position.evidenceGapActivatedAt))return decision;
  const observable=!!decision.structure||decision.status==='warming'
    ||decision.flow?.usable===true&&(decision.flow.buyerCount+decision.flow.sellerCount)>=2;
  if(decision.exit||observable)return {...decision,evidenceGap:null};
  const observed=time(mark.observedAt),prior=position.evidenceGap;
  const continued=prior?.version===p.version&&prior.lastObservedAt<=observed
    &&observed-prior.lastObservedAt<=p.maxObservationGapMs;
  const gap=continued?{...prior}:{version:p.version,since:observed,lastObservedAt:observed,observations:1};
  if(continued&&observed>gap.lastObservedAt){gap.lastObservedAt=observed;gap.observations++;}
  const exit=allowExit && observed-gap.since>=p.missingForMs&&gap.observations>=p.minObservations;
  return {...decision,evidenceGap:gap,status:exit?'evidence_gap_exit':'data_gap',exit,
    recoveryExit:exit?{version:p.version,policy:{...p},...gap,quoteObservedAt:mark.observedAt}:null,
    reason:exit?'量价与有效地址行为证据持续中断五分钟，按新的真实报价模拟退出（非历史补单）'
      :`退出证据中断，已观察 ${Math.floor((observed-gap.since)/1000)} 秒；${allowExit?'达到五分钟后须有新鲜报价才按本仓规则模拟退出':'仅记录并等待证据恢复，不因数据缺口自动卖出'}`};
}
