// Evidence-chain research, not an LLM, a probability model, or trade authority.
import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { validNarrativeMemory } from './paper-narrative-recall.js';
import { assessPaperNarrative, analyzePaperChart } from './paper-strategy-analysis.js';
import { memeEntryContext } from './paper-meme-exit.js';
import { validMonitorSignal } from './paper-monitor-signal.js';
import { validAlphaSignal } from './binance-alpha-catalog.js';

export const NARRATIVE_THESIS_VERSION='narrative_evidence_chain_v1';
const HOUR=3600000,DAY=24*HOUR;
const stamp=v=>typeof v==='number'?v:Date.parse(v||'');
const clean=v=>typeof v==='string'?v.normalize('NFKC').replace(/\s+/gu,' ').trim():'';
const key=t=>`${t?.chain}:${gmgnFlowAddress(t?.chain,t?.address)}`;
const norm=v=>clean(v).toLowerCase().replace(/https?:\/\/\S+/gu,'').replace(/moon\s*cakes?|月饼|中秋(?:快乐|节)?/gu,'mooncake').replace(/[^\p{L}\p{N}]/gu,'');
const unique=a=>[...new Set(a)];
const fresh=(v,now,age)=>Number.isFinite(stamp(v))&&stamp(v)<=now&&now-stamp(v)<=age;
const iso=v=>new Date(v).toISOString();
const median=a=>{const s=a.toSorted((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;};
const generic=new Set(['crypto','token','coin','chain','blockchain','binance','bitcoin','ethereum','solana','community','market','news','web3','agent','agents','人工智能','智能体','社区','代币','币安']);
export function narrativeSourceKey(value) {
  try {const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
    if(['x.com','twitter.com','www.x.com','www.twitter.com'].includes(u.hostname)) {
      const m=u.pathname.match(/^\/(?:[a-z\d_]{1,15}\/status|i\/(?:web\/)?status)\/(\d+)\/?$/i);
      return m?`x:${m[1]}`:null;
    }
    u.search='';u.hash='';return u.href;
  }catch{return null;}
}
const tokenLinks=t=>[t?.twitterUsername,t?.website,t?.raw?.twitter,t?.raw?.twitter_username,
  t?.raw?.link?.twitter,t?.raw?.link?.twitter_username,t?.raw?.link?.website]
  .map(v=>typeof v==='string'&&/^(?:i\/|[a-z\d_]{1,15}\/status\/)/i.test(v)?`https://x.com/${v}`:v).map(narrativeSourceKey).filter(Boolean);
const tokenTerms=t=>unique([t?.symbol,t?.name].map(norm)).filter(t=>t.length>=(/\p{Script=Han}/u.test(t)?2:4)&&!generic.has(t));
const denial=/\b(?:not affiliated|unaffiliated|not official|no token|do not buy|don't buy|cancelled|denied|fake token|scam token)\b|没有发行|未发行|不是官方|非官方|不要买|别买|假币|仿盘|取消发布|辟谣|与.{0,8}无关/iu;
const conditional=/\b(?:will|plans? to|planning|may|might|rumou?r|propos(?:e|al)|could)\b|计划|拟推出|即将|可能|传闻|尚未|提议/iu;
const frames=[
  {id:'exchange_access',label:'交易入口 / 上线催化',pattern:/\blist(?:ed|ing)?\b|alpha|交易对|上币|交易所.{0,10}上线/iu,
    mechanism:'新增交易入口可能带来关注和可交易资金；名单出现本身不证明真实增量买盘。',need:'核对官方上新时间和同链 CA，再看事件后新增买家与实际成交。'},
  {id:'product_delivery',label:'产品 / 技术交付',pattern:/\b(?:launch(?:ed)?|releas(?:e|ed)|mainnet|testnet|open.?source|integrat\w*|upgrade)\b|发布|主网|测试网|开源|集成|产品上线|升级/iu,
    mechanism:'交付或应用传播可能吸引用户；产品成功到代币需求之间仍需价值归属证据。',need:'核对可访问产品、发行主体与代币关系；没有使用量或收入证据时不宣称价值兑现。'},
  {id:'token_value',label:'代币权益 / 供给变化',pattern:/\b(?:buyback|burn|revenue|rewards?|fees?|airdrop|unlock)\b|回购|销毁|分红|收入|手续费|空投|解锁/iu,
    mechanism:'若权益或供给变化真实执行，可能影响供需；文案承诺不等于链上执行。',need:'核对执行交易、受益 CA 和权益规则，区分已执行与计划。'},
  {id:'attention_culture',label:'人物 / 社区文化题材',pattern:/moon\s*cakes?|中秋|月饼|\b(?:meme|viral|dog|cat|frog|mascot|birthday|holiday)\b|新梗|吉祥物|生日|节日|爆火|走红/iu,
    mechanism:'传播可能让社区选择一个代币表达题材；与原作者发行、背书及持续需求是三件不同的事。',need:'比较同名 CA 的原帖关联、流动性和新买盘，不因名人提到词语就认定正统币。'},
  {id:'ai_research',label:'AI / 研究进展',pattern:/\b(?:ai|agents?|llm|gpt\w*|research|h100s?|model)\b|人工智能|智能体|研究|模型/iu,
    mechanism:'研究或能力进展可能带来关注；技术主张与代币价值捕获未必相关。',need:'核对研究原文、可验证产物和代币关联，避免把同名 AI 标签当成使用需求。'},
];
export function narrativeEventFrame(text) {
  const body=clean(text).slice(0,4000),warning=denial.test(body),frame=frames.find(f=>f.pattern.test(body));
  return {kind:frame?.id||'unclassified',label:frame?.label||'事件含义待核实',
    claimStatus:warning?'含否认或争议信号':conditional.test(body)?'原文为计划 / 条件 / 传闻，未确认兑现':body?'原文主张，未独立证实':'未取得原文',
    warning,excerpt:body.slice(0,300),
    mechanism:frame?.mechanism||'尚不能从原文建立事件到代币需求的路径；不按币名补故事。',
    verification:frame?.need||'需要完整原文、事件主体和具体 CA 的对应证据。',
    method:'规则辅助归类；含义、反讽、图片梗或隐喻可能未识别，不是通用语义模型'};
}
const phase=age=>age===null?'unknown':age<=120000?'fresh':age<=HOUR?'follow_through':age<=DAY?'background':'old';
const phaseText={unknown:'催化时间未知',fresh:'发布两分钟内的新消息，非币的首波认证',follow_through:'发布后跟随窗口，不补造首发买点',background:'背景叙事，等待新的实质催化',old:'旧叙事，不能冒充新消息',repeated:'重复文案 / 旧故事再传播，未证明有新增催化'};

export function createNarrativeResearchIndex({memory,documents=[],episodes=[],nowMs=Date.now()}={}) {
  const valid=memory&&validNarrativeMemory(memory),conflicts=new Set(valid?memory.conflicts.map(narrativeSourceKey).filter(Boolean):[]),docs=new Map();
  for(const d of [...(valid?memory.documents:[]),...documents].slice(-2500)) {
    const id=narrativeSourceKey(d?.url),at=stamp(d?.at),body=clean(d?.text);
    if(!id||d.authenticated!==true||!body||!fresh(at,nowMs,7*DAY))continue;
    const old=docs.get(id);
    if(d.contentConflict||old&&(clean(old.text)!==clean(body).slice(0,4000)||old.at!==at||old.author!==(clean(d.author)||null)))conflicts.add(id);
    if(!old)docs.set(id,{id,url:d.url,at,text:body.slice(0,4000),author:clean(d.author)||null,
      chain:d.chain||null,assetKey:d.assetKey||null,authenticated:true,frame:narrativeEventFrame(body),normalizedText:norm(body),
      evmAddresses:(body.match(/(?<![\da-f])0x[\da-f]{40}(?![\da-f])/ig)||[]).map(x=>x.toLowerCase()),
      solAddresses:body.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[]});
  }
  const byAsset=new Map();
  for(const e of episodes.slice(-2000)) {
    if(!e||!fresh(e.at,nowMs,30*DAY))continue;
    const k=key(e);if(!byAsset.has(k))byAsset.set(k,[]);byAsset.get(k).push(e);
    // Already verified public text attached by the learning source adapter is
    // reusable for research, but a project permalink never becomes a CA claim.
    for(const n of e.narratives||[]) {
      const id=narrativeSourceKey(n.url),body=clean(n.text);
      if(!id||docs.has(id)||!body||!['verified_ca','provider_permalink'].includes(n.binding)
        ||!fresh(n.at,nowMs,7*DAY)||n.at>e.at||!Number.isFinite(n.associatedAt)||n.associatedAt>nowMs)continue;
      docs.set(id,{id,url:n.url,at:n.at,text:body,author:clean(n.author)||null,authenticated:true,
        chain:n.binding==='verified_ca'?e.chain:null,assetKey:n.binding==='verified_ca'?k:null,
        frame:narrativeEventFrame(body),normalizedText:norm(body),
        evmAddresses:(body.match(/(?<![\da-f])0x[\da-f]{40}(?![\da-f])/ig)||[]).map(x=>x.toLowerCase()),
        solAddresses:body.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[]});
    }
  }
  return {documents:[...docs.values()].filter(d=>!conflicts.has(d.id)).sort((a,b)=>b.at-a.at).slice(0,200),
    byAsset,relations:new Map(),conflictIds:conflicts,conflicts:conflicts.size,method:'authenticated_sources_and_observed_links'};
}
function relation(doc,token,links,terms) {
  const ca=gmgnFlowAddress(token.chain,token.address);
  if(!ca)return null;
  const mentions=token.chain==='sol'?doc.solAddresses:doc.evmAddresses;
  if(doc.assetKey===key(token)||doc.chain===token.chain&&mentions.includes(ca))return 'direct_ca';
  const named=terms.some(term=>doc.normalizedText.includes(term));
  if(links.includes(doc.id))return named?'community_link':'project_link';
  return named?'name_only':null;
}
const bindingLabels={direct_ca:'原文明确提及同链 CA；不等于作者发行',official_catalog:'官方目录确认同链 CA；不等于盈利承诺',
  community_link:'名称与项目所引原帖一致：社区题材关联，非作者认领',project_link:'项目资料引用原帖：关系待核实',name_only:'仅名称相符，不能认定为该叙事承接币',unverified:'缺少可核实的叙事与 CA 关系'};
const bindingRank={official_catalog:4,direct_ca:3,community_link:2,project_link:1,name_only:0,unverified:-1};

export function classifyNarrativeCase(episode,nowMs) {
  const source=episode.narratives?.find(n=>n.binding==='verified_ca')||episode.narratives?.[0];
  if(!source||!Number.isFinite(source.at)||source.at>episode.at||!narrativeSourceKey(source.url))return null;
  const frame=narrativeEventFrame(source.text),ageMs=episode.at-source.at;
  return {version:NARRATIVE_THESIS_VERSION,recordedAt:nowMs,sourceKey:narrativeSourceKey(source.url),kind:frame.kind,label:frame.label,
    binding:source.binding,phase:phase(ageMs),ageAtSurgeMs:ageMs,claimStatus:frame.claimStatus,
    knowledge:source.associatedAt<=episode.at?'known_at_observation':'retrospective_association',
    note:'起量时的消息年龄，不证明首发或因果；事后关联不用于重写历史买入证据'};
}
export function narrativeStageReport(episodes,nowMs=Date.now()) {
  const groups=new Map();let associated=0,retrospective=0;
  for(const e of episodes) {
    const p=e.researchProfile||classifyNarrativeCase(e,nowMs);
    if(!p||!e.narratives?.some(n=>narrativeSourceKey(n.url)===p.sourceKey))continue;
    associated++;if(p.knowledge==='retrospective_association')retrospective++;
    const k=[p.kind,p.phase,p.binding,p.knowledge].join(':');if(!groups.has(k))groups.set(k,{kind:p.kind,label:p.label,phase:p.phase,phaseText:phaseText[p.phase],binding:p.binding,knowledge:p.knowledge,cases:[]});
    groups.get(k).cases.push(e);
  }
  return {version:NARRATIVE_THESIS_VERSION,associated,retrospective,autoTradingChanges:false,
    groups:[...groups.values()].map(({cases,...g})=>{
      const done=cases.filter(e=>e.outcomes?.['24h']?.status==='observed'&&e.outcomes['24h'].at<=nowMs);
      return {...g,samples:cases.length,uniqueTokens:new Set(cases.map(key)).size,completed24h:done.length,
        positive:done.filter(e=>e.outcomes['24h'].returnRate>0).length,negative:done.filter(e=>e.outcomes['24h'].returnRate<0).length,
        medianReturn24h:median(done.map(e=>e.outcomes['24h'].returnRate)),
        interpretation:'描述性观察、未扣成本；非独立样本、非回测收益，不据此自动放宽交易'};
    }).sort((a,b)=>b.samples-a.samples).slice(0,16)};
}

export function buildNarrativeThesis({token,narrative={},monitorSignal,alphaSignal,index,flow={},candles=[],klineStatus,nowMs=Date.now()}={}) {
  const links=tokenLinks(token),terms=tokenTerms(token),cacheKey=[key(token),...links,...terms].join('|');
  if(index?.relations&&!index.relations.has(cacheKey))index.relations.set(cacheKey,(index.documents||[])
    .flatMap(d=>{const binding=relation(d,token,links,terms);return binding?[{...d,binding}]:[];}));
  const related=[...(index?.relations?.get(cacheKey)||[])];
  const parsed=assessPaperNarrative({narrative,chain:token.chain,address:token.address,nowMs});
  for(const s of parsed.sources.filter(s=>!s.contentConflict))related.push({id:narrativeSourceKey(s.sourceUrl)||s.sourceId,url:s.sourceUrl,
    at:stamp(s.sourceAt),text:s.text,author:s.authorKey||s.authorLabel,binding:'direct_ca',frame:narrativeEventFrame(s.text)});
  if(validMonitorSignal(monitorSignal,token,nowMs)&&monitorSignal.authenticated===true)related.push({id:narrativeSourceKey(monitorSignal.sourceUrl),
    url:monitorSignal.sourceUrl,at:stamp(monitorSignal.sourceAt),text:monitorSignal.text,author:monitorSignal.theme?.author||monitorSignal.narrativeCandidate?.author||null,
    binding:monitorSignal.source==='kol_theme_hypothesis'||monitorSignal.source==='twitter_narrative_event'&&monitorSignal.narrativeCandidate?.binding!=='direct_ca'?'community_link':'direct_ca',eventCandidate:true,frame:narrativeEventFrame(monitorSignal.text)});
  if(validAlphaSignal(alphaSignal,token,nowMs))related.push({id:alphaSignal.id,url:alphaSignal.sourceUrl,
    at:alphaSignal.listingTime,text:`官方 Alpha 目录新增 ${token.symbol||'代币'} 的交易入口`,author:'binance_alpha_catalog',
    binding:'official_catalog',eventCandidate:true,frame:narrativeEventFrame('Alpha listing')});
  const byId=new Map(),conflicts=new Set(index?.conflictIds||[]);
  for(const d of related){if(!d.id||!fresh(d.at,nowMs,7*DAY))continue;const old=byId.get(d.id);
    if(old&&(clean(old.text)!==clean(d.text)||old.at!==d.at))conflicts.add(d.id);
    if(!old||d.eventCandidate||bindingRank[d.binding]>bindingRank[old.binding])byId.set(d.id,d);
  }
  const docs=[...byId.values()].filter(d=>!conflicts.has(d.id)).sort((a,b)=>Number(!!b.eventCandidate)-Number(!!a.eventCandidate)||bindingRank[b.binding]-bindingRank[a.binding]||b.at-a.at).slice(0,12);
  const lead=docs[0],frame=lead?.frame||narrativeEventFrame(''),binding=lead?.binding||'unverified',ageMs=lead?nowMs-lead.at:null;
  const repeated=lead&&docs.some(d=>d.id!==lead.id&&d.at<lead.at&&norm(d.text)===norm(lead.text));
  const catalystPhase=repeated?'repeated':phase(ageMs);
  // Distinct identities and non-copied text are only dissemination evidence,
  // never proof of independent information, coordinated wallets, or endorsement.
  const seenAuthors=new Set(),seenBodies=new Set();let authors=0;
  for(const d of docs.filter(d=>['direct_ca','community_link','official_catalog'].includes(d.binding)&&fresh(d.at,nowMs,6*HOUR))){
    const body=norm(d.text);if(d.author&&!seenAuthors.has(d.author)&&!seenBodies.has(body)){authors++;seenAuthors.add(d.author);seenBodies.add(body);}
  }
  let context;try{context=memeEntryContext(token,{flow},nowMs);}catch{context={cohortKnown:false,smartBuyers:[]};}
  const usable=context.cohortKnown===true,rows=usable?flow.wallets:[],smart=w=>w.highProfit===true||(w.tags||[]).some(t=>['smart_degen','smart_money','smartmoney'].includes(t));
  const recentBuyers=rows.filter(w=>smart(w)&&w.netBuyUsd>=100&&fresh(w.lastBuyAt,nowMs,90000)&&stamp(w.lastBuyAt)<=stamp(flow.observedAt)&&(!lead||stamp(w.lastBuyAt)>=lead.at));
  const sellers=rows.filter(w=>smart(w)&&w.netBuyUsd<=-100);
  const demand=usable?recentBuyers.length>=2&&flow.netBuyUsd>=300?'buying':sellers.length>=2&&flow.netBuyUsd<=-250?'selling':rows.length?'mixed':'no_activity':'unknown';
  const chart=analyzePaperChart({candles,klineStatus,nowMs});
  const relevantWarnings=docs.filter(d=>['direct_ca','community_link','official_catalog'].includes(d.binding)&&d.frame.warning&&fresh(d.at,nowMs,6*HOUR));
  const invalidation=relevantWarnings.length?'原文含否认或争议，停止以该叙事新增仓位，等待复核':demand==='selling'?'观察到多标签地址净卖出；交由既有连续卖盘 / 量价规则确认退出':'尚无已确认叙事失效；没有证伪不代表利好成立';
  const history=(index?.byAsset?.get(key(token))||[]).filter(e=>e.at<(lead?.at??nowMs)&&e.outcomes?.['24h']?.status==='observed'
    &&e.outcomes['24h'].at<=nowMs&&e.narratives?.some(n=>n.associatedAt<=nowMs&&narrativeEventFrame(n.text).kind===frame.kind
      &&(frame.kind!=='unclassified'||lead&&narrativeSourceKey(n.url)===lead.id)));
  const historyView={samples:history.length,medianReturn24h:median(history.map(e=>e.outcomes['24h'].returnRate)),
    note:'同 CA 同类事件的已完成观察，未扣成本，不推导胜率或目标价；事后补文案仅作参考'};
  const conclusion=relevantWarnings.length?'原文有争议，暂不新增叙事仓位':!lead?'没有原文，只能评估资金 / 量价动量':
    ['name_only','project_link'].includes(binding)?'代币关系未确认，仅研究':demand!=='buying'?'有叙事关联，买盘承接未确认':
      ['old','background','repeated'].includes(catalystPhase)?'已有买盘，但催化偏旧 / 重复，只作当前行情研究':'叙事关联与近期买盘同时可见，仍须完整开仓检查';
  return {version:NARRATIVE_THESIS_VERSION,chain:token.chain,address:token.address,symbol:token.symbol||'',observedAt:iso(nowMs),
    method:'规则辅助、证据约束；不声称通用语义理解或自动训练',researchOnly:true,authorEndorsement:false,
    event:{...frame,sourceUrl:lead?.url||null,sourceAt:lead?iso(lead.at):null,sourceId:lead?.id||null},
    relationship:{kind:binding,label:bindingLabels[binding],issuerIdentity:'未核实发行者身份或同一控制关系'},
    catalyst:{phase:catalystPhase,ageMs,label:phaseText[catalystPhase]},
    propagation:{distinctAuthors:authors,sourceCount:docs.length,summary:`本地候选相关来源 ${docs.length} 条（含弱关联），明确 / 社区 CA 关联近六小时去重作者 ${authors} 个；非完整传播量，转述不算独立事实核验`},
    demand:{status:demand,provider:flow.provider||null,observedAt:usable?flow.observedAt:null,netBuyUsd:usable?flow.netBuyUsd:null,
      recentNetBuyers:usable?recentBuyers.length:null,netSellers:usable?sellers.length:null,
      summary:usable?`可见窗口净流入 ${flow.netBuyUsd.toFixed(2)}U，事件后近期标签净买 ${recentBuyers.length} / 净卖 ${sellers.length} 个地址；非全链、不能证明独立控制`:'资金证据缺失 / 过期 / 不完整，不能认定聪明钱正在进入'},
    market:{ready:chart.ready,summary:chart.ready?`可用收盘结构，最近一根相对量 ${chart.relativeVolume===null?'未知':chart.relativeVolume.toFixed(2)} 倍；${chart.rising?'最近收盘走高':'最近收盘未走高'}，不是未来走势预测`:chart.reason},
    history:historyView,invalidation:{observed:invalidation,blockNewNarrativeEntry:relevantWarnings.length>0,
      conditions:['原帖否认或 CA 对应关系被推翻','重复旧消息且没有新增实质事件','连续新增卖盘 / 已收盘结构失效，由持仓规则确认','退出证据持续中断，按已授权断流规则处理，不编造卖价']},
    conclusion,summary:`${frame.label}；${bindingLabels[binding]}；${phaseText[catalystPhase]}。${conclusion}。`,
    sources:docs.slice(0,4).map(d=>({url:d.url,at:iso(d.at),text:d.text.slice(0,300),binding:d.binding})),
    gaps:[...(!lead?['缺少关联原文']:[]),...(['unverified','name_only','project_link'].includes(binding)?['事件与 CA 关系待核实']:[]),
      ...(demand!=='buying'?['新增真实买盘待确认']:[]),...(!chart.ready?['量价结构待补']:[]),...(!authors?['可用作者身份不足']:[])]};
}

export function attachNarrativeThesis(row,thesis) {
  const block=thesis.invalidation.blockNewNarrativeEntry;
  return {...row,decision:block&&row.decision!=='不买'?'观察':row.decision,
    reasons:block?unique([...row.reasons,'叙事原文含否认或争议，等待复核']):row.reasons,
    evidence:{...row.evidence,narrativeThesis:thesis,paperEligible:block?false:row.evidence.paperEligible}};
}

export function narrativeDeskReport(evaluations,index,stageReport,nowMs) {
  const rows=[...new Map(evaluations.filter(e=>e.evidence?.narrativeThesis).map(e=>[key(e.token),e.evidence.narrativeThesis])).values()];
  return {version:NARRATIVE_THESIS_VERSION,updatedAt:iso(nowMs),method:'证据链规则辅助研究，不是自动训练模型',
    candidates:rows.length,withSources:rows.filter(r=>r.sources.length).length,
    directCa:rows.filter(r=>['direct_ca','official_catalog'].includes(r.relationship.kind)).length,
    communityLinked:rows.filter(r=>r.relationship.kind==='community_link').length,
    sourceConflicts:index?.conflicts||0,stageReport,
    cases:rows.filter(r=>r.sources.length).sort((a,b)=>bindingRank[b.relationship.kind]-bindingRank[a.relationship.kind]
      ||stamp(b.event.sourceAt)-stamp(a.event.sourceAt)).slice(0,8),
    note:'只使用已采集原文；链接关联、明确 CA 提及与官方发行身份分开。无原文平台提醒不是已学会叙事。'};
}
