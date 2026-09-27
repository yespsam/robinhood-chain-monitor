// Paper-only forward policy. Evidence labels are not predictions or wallet ownership proof.
import { THESIS_EXIT_POLICY, assessThesisExit } from './paper-thesis-exit.js';
import { assessPaperNarrative } from './paper-strategy-analysis.js';
import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { advanceStructureTrail } from './paper-structure-trail.js';

export const LEGACY_MEME_EXIT_VERSION = 'meme_evidence_exit_v1';
export const MEME_EXIT_VERSION = 'meme_evidence_exit_v2';
export const MEME_EXIT_POLICY = Object.freeze({version:MEME_EXIT_VERSION,mode:'paper_main_forward',
  fixedStop:false,fixedProfitTiers:false,trailingPercent:false,timeExit:false,
  exitQuoteMaxAgeMs:15000,flowMaxAgeMs:120000,flowConfirmationMs:30000,
  minSmartWallets:2,minWalletNetUsd:100,minNetFlowUsd:250,entryFlowReversalFraction:.5});
export const LEGACY_MEME_EXIT_POLICY = Object.freeze({...MEME_EXIT_POLICY,version:LEGACY_MEME_EXIT_VERSION});
export const MEME_EXIT_TEXT = '主模拟盘新仓按叙事、同源聪明钱行为与量价结构复核，不按固定百分比止损、倍数止盈、峰值百分比或持仓时间卖出。入场后形成高于买价的抬高低点，经右侧两根收盘线和反弹确认后，上移结构观察位；连续两根收盘失守且未见有效承接时退出。观察位只上移，不保证保本或成交价。持续新增卖盘、放量破位或派发后跌破仍可先退出。新叙事只记原文与出处，不预测后续；未知不等于利好，无新鲜报价不编造成交。';
const at = x => typeof x === 'number' ? x : Date.parse(x || '');
const fresh = (x,now,age) => Number.isFinite(at(x)) && at(x)<=now && now-at(x)<=age;
const key = x => `${x?.chain}:${gmgnFlowAddress(x?.chain,x?.address)}`;
const smart = w => w.highProfit===true || w.tags?.some(t=>['smart_degen','smart_money','smartmoney'].includes(t));
const identity = s => s.sourceId || s.sourceUrl;
export const validMemeExitPolicy = p => [MEME_EXIT_POLICY,LEGACY_MEME_EXIT_POLICY].some(policy=>!!p
  && Object.keys(p).length===Object.keys(policy).length && Object.entries(policy).every(([k,v])=>p[k]===v));

function holderEvidence(position,snapshot,nowMs) {
  const labels={top10HolderRate:'前十大集中度',devTeamHoldRate:'开发团队占比',bundlerRate:'打包买入占比'};
  if(!snapshot||key(snapshot)!==key(position)||!fresh(snapshot.observedAt,nowMs,120000))return {available:false,summary:'筹码快照缺失或过期'};
  const rows=Object.entries(labels).flatMap(([field,label])=>{
    const value=snapshot[field],original=position.entryEvidence?.safety?.metrics?.[field];
    if(!Number.isFinite(value)||value<0||value>1)return [];
    const delta=Number.isFinite(original)&&original>=0&&original<=1?value-original:null;
    return [{field,value,delta,text:`${label} ${(value*100).toFixed(2)}%${delta===null?'（入场基线未知）':`，较入场 ${delta>=0?'+':''}${(delta*100).toFixed(2)} 个百分点`}`}];
  });
  return {available:rows.length>0,observedAt:snapshot.observedAt,rows,
    summary:rows.length?rows.map(r=>r.text).join('；')+'。占比变化不等于地址卖出，也不能证明同一人控制。':'筹码指标未提供'};
}

function walletFlow(flow,token,now,provider) {
  const unknown = reason => ({usable:false,reason,provider,wallets:[]});
  if (!flow || key(flow)!==key(token) || (flow.provider||'gmgn')!==provider || flow.complete!==true
    || flow.fresh!==true || !['healthy','ok'].includes(flow.status) || flow.coverageGap
    || !fresh(flow.observedAt,now,MEME_EXIT_POLICY.flowMaxAgeMs) || !Number.isFinite(flow.netBuyUsd)
    || !Array.isArray(flow.wallets)) return unknown('资金流缺失、过期、覆盖不完整或来源不一致');
  const seen = new Set(), wallets=[];
  for (const w of flow.wallets) {
    const address=gmgnFlowAddress(token.chain,w.wallet);
    if (!address || !(token.chain==='sol'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[\da-f]{40}$/i).test(address)
      || seen.has(address) || ![w.buyUsd,w.sellUsd,w.netBuyUsd].every(Number.isFinite)
      || w.buyUsd<0 || w.sellUsd<0 || Math.abs(w.buyUsd-w.sellUsd-w.netBuyUsd)>1e-6
      || w.tags!==undefined&&!Array.isArray(w.tags)) return unknown('地址级资金流重复或金额不一致');
    const tags=provider==='binance_smartmoney'?['smart_money']:(w.tags||[]);
    seen.add(address);wallets.push({...w,wallet:address,tags});
  }
  return {usable:true,provider,observedAt:flow.observedAt,netBuyUsd:flow.netBuyUsd,wallets,
    scope:flow.scope||'所采集来源窗口，非全链；地址独立性未核实'};
}

export function memeEntryContext(token,evidence={},nowMs) {
  const provider=evidence.flow?.provider||'gmgn',flow=walletFlow(evidence.flow,token,nowMs,provider);
  const narrative=assessPaperNarrative({narrative:evidence.narrative,chain:token.chain,address:token.address,nowMs});
  const buyers=flow.wallets.filter(w=>smart(w)&&w.netBuyUsd>=100).map(w=>w.wallet);
  return {provider,observedAt:flow.observedAt||null,cohortKnown:flow.usable,smartBuyers:buyers.slice(0,200),
    cohortTruncated:buyers.length>200,narrativeSourceIds:narrative.sources.map(identity),
    note:'入场可见净买地址，不代表全部持仓、全仓买入或共同控制；无活动不等于仍持有'};
}

export function memeExitEvaluation(row,context) {
  return {...row,exitLogic:MEME_EXIT_TEXT,evidence:{...row.evidence,memeExitPolicy:{...MEME_EXIT_POLICY},
    ...(context?{memeExitContext:context}:{}),
    entryPlan:{...row.evidence?.entryPlan,effectiveExitPolicyVersion:MEME_EXIT_VERSION},
    traderDecision:row.evidence?.traderDecision?{...row.evidence.traderDecision,exitPolicyVersion:MEME_EXIT_VERSION,
      questions:row.evidence.traderDecision.questions?.map(q=>['invalidation','hold_or_exit'].includes(q.id)?{...q,text:MEME_EXIT_TEXT}:q)}:undefined}};
}

export function assessMemeExit(position,mark,nowMs) {
  if (!validMemeExitPolicy(position.memeExitPolicy)) return {version:MEME_EXIT_VERSION,status:'unavailable',exit:false,
    flowWatch:null,reason:'持仓退出版本异常，不能生成卖出'};
  // Reuse audited closed-bar analysis, not its aggregate-flow confirmation rule.
  const version=position.memeExitPolicy.version;
  let base=assessThesisExit({...position,exitExperiment:{...THESIS_EXIT_POLICY}}, {...mark,flow:null}, nowMs);
  if (!base.sentiment) return {...base,version};
  const dynamic=version===MEME_EXIT_VERSION;
  const structureTrail=dynamic?advanceStructureTrail(position,mark):null;
  const raised=structureTrail && base.structure && structureTrail.level>base.structure.referenceLevel;
  if(raised)base=assessThesisExit({...position,exitExperiment:{...THESIS_EXIT_POLICY}}, {...mark,flow:null}, nowMs,
    {referenceLevel:structureTrail.level,referenceKind:'入场后已确认的抬高低点'});
  const opened=at(position.openedAt), observed=at(mark.observedAt),p=MEME_EXIT_POLICY;
  const entry=position.entryEvidence?.memeExitContext;
  const provider=entry?.provider||position.entryEvidence?.flowDiagnostics?.provider||'gmgn';
  const f=walletFlow(mark.flow,position,observed,provider);
  if(f.usable && at(f.observedAt)<=opened){f.usable=false;f.reason='等待入场后的资金流窗口';}
  const sellers=f.usable?f.wallets.filter(w=>smart(w)&&w.netBuyUsd<=-p.minWalletNetUsd):[];
  const buyers=f.usable?f.wallets.filter(w=>smart(w)&&w.netBuyUsd>=p.minWalletNetUsd):[];
  const threshold=Math.max(p.minNetFlowUsd,Math.max(0,position.entryEvidence?.flow?.netBuyUsd||0)*p.entryFlowReversalFraction);
  const reversed=f.usable&&f.netBuyUsd<=-threshold&&sellers.length>=p.minSmartWallets;
  const newBuyers=buyers.filter(w=>fresh(w.lastBuyAt,observed,p.flowMaxAgeMs)&&at(w.lastBuyAt)>opened&&at(w.lastBuyAt)<=at(f.observedAt));
  const absorption=f.usable&&f.netBuyUsd>=p.minNetFlowUsd&&newBuyers.length>=p.minSmartWallets;
  let flowWatch=null;
  if(reversed){
    const prior=position.thesisFlowWatch,stamp=at(f.observedAt),amounts=Object.fromEntries(sellers.map(w=>[w.wallet,w.sellUsd]));
    const compatible=prior?.provider===provider&&prior.amounts&&stamp>=at(prior.lastAt)&&stamp-at(prior.lastAt)<=p.flowMaxAgeMs;
    flowWatch=compatible?{...prior}:{provider,count:1,firstAt:f.observedAt,lastAt:f.observedAt,amounts};
    // A later timestamp or a rolling buy falling out of the window is not a new sale.
    const newSellers=compatible?sellers.filter(w=>Number.isFinite(prior.amounts[w.wallet])&&w.sellUsd>prior.amounts[w.wallet]+1e-6
      &&fresh(w.lastSellAt,observed,p.flowMaxAgeMs)&&at(w.lastSellAt)>at(prior.lastAt)&&at(w.lastSellAt)<=stamp):[];
    if(compatible&&stamp>at(prior.lastAt)&&stamp-at(prior.firstAt)>=p.flowConfirmationMs&&newSellers.length>=p.minSmartWallets)
      flowWatch={...flowWatch,count:2,lastAt:f.observedAt,amounts};
  }
  const narrative=assessPaperNarrative({narrative:mark.narrative,chain:position.chain,address:position.address,nowMs:observed});
  const contested=narrative.gaps.some(g=>/争议|冲突|否认/.test(g));
  const followups=narrative.sources.filter(s=>at(s.sourceAt)>opened&&!s.contentConflict&&!entry?.narrativeSourceIds?.includes(identity(s)));
  const narrativeState=contested?'待复核':narrative.eligible&&followups.length?'出现后续原文':narrative.sources.length?'只有背景文案':'缺少原文';
  const narrativeSummary=`${narrativeState}；${narrative.quality}。${followups.length} 条入场后新出处，不等于 ${followups.length} 个独立利好。${contested?'否认/争议词仅提示复核，不能单独触发卖出。':'不把旧文案、热度或沉默当作后续发展已确认。'}`;
  const cohortSellers=entry?.cohortKnown?sellers.filter(w=>entry.smartBuyers.includes(w.wallet)).map(w=>w.wallet):null;
  const structure=base.structure;
  let exit=false,status='observing',reason='继续观察，尚无确认的退出证据；不代表叙事或趋势已获验证';
  if(flowWatch?.count===2){exit=true;reason='同源完整窗口中至少两个聪明钱地址出现持续新增卖出，资金依据失效';}
  else if(structure?.heavyBreak||structure?.distribution){exit=true;reason=base.reason;}
  else if(contested&&structure?.twoBelow&&reversed){exit=true;reason='叙事争议信号伴随关键位失守和多地址净卖出，联合依据失效；非仅按文案词语卖出';}
  else if(raised&&structure?.twoBelow&&!absorption){exit=true;reason='上涨后确认的抬高低点连续两根收盘失守，未见有效买盘承接；按动态结构退出，非固定回撤比例';}
  else if(structure?.threeBelow&&!absorption){exit=true;reason='连续收盘失守关键位，未见可核实承接；按已确认结构失效退出，不是按亏损百分比';}
  else if(structure?.twoBelow&&absorption){status='supported_pullback';reason='回踩期间可见多地址净买入承接，尚未确认放量破位或持续卖出；继续观察，不认定庄家洗盘';}
  else if(!structure){status='unavailable';reason='量价结构待补；叙事和资金证据分别展示，缺失不等于趋势健康';}
  const flowSummary=f.usable?`同源窗口净流入 ${f.netBuyUsd.toFixed(2)} U，聪明钱标签净买 ${buyers.length} / 净卖 ${sellers.length} 个地址（入场后近期买入 ${newBuyers.length} 个）；${cohortSellers===null?'入场地址群未知':`入场买家中 ${cohortSellers.length} 个转为净卖出`}。无活动不能证明未减仓。`:f.reason;
  const holders=holderEvidence(position,mark.holderSnapshot,observed);
  const legacy=dynamic?assessMemeExit({...position,memeExitPolicy:LEGACY_MEME_EXIT_POLICY,structureTrail:undefined},mark,nowMs):null;
  return {...base,version,status:exit?'invalidated':status,exit,reason,flowWatch,
    ...(dynamic?{structureTrail,comparison:{version:LEGACY_MEME_EXIT_VERSION,exit:legacy.exit,reason:legacy.reason,
      meaning:'同一当前观测下的旧规则判断，仅决策对照；不虚构卖价或对照收益'}}:{}),
    sentiment:{...base.sentiment,meaning:narrativeSummary},
    narrative:{state:narrativeState,summary:narrativeSummary,followups:followups.slice(0,3).map(s=>({sourceUrl:s.sourceUrl,sourceAt:s.sourceAt,text:s.text})),gaps:narrative.gaps},
    flow:{usable:f.usable,provider,netBuyUsd:f.usable?f.netBuyUsd:null,buyerCount:buyers.length,sellerCount:sellers.length,
      cohortSellers,absorption,reversed,confirmed:flowWatch?.count===2,summary:flowSummary,scope:f.scope||null},
    operator:{status:'unverified',holders,summary:holders.summary+' '+(structure?.distribution?'观察到放量长上影后跌破的派发形态；不能据此确认庄家身份或意图。':'庄家身份、共同控制与完整持仓变化未核实；不输出“庄家吸筹/洗盘”确定结论。')},
    evidenceScope:'基于可见行情和已采集来源的规则判断；不是 AI 预测，不自动进化参数'};
}
