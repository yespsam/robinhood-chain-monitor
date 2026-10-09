// Event-first observational casebook. Never produces orders or trading gates.
import {createHash} from 'node:crypto';
import {gmgnFlowAddress} from './gmgn-flow-signal.js';
import {narrativeSourceKey} from './paper-narrative-thesis.js';
import {compileNarrativeName,normalizeNarrativeText} from './narrative-name-match.js';

export const NARRATIVE_ACADEMY_VERSION='event_casebook_v1';
const MINUTE=60000,DAY=86400000,MAX_CASES=400,MAX_CANDIDATES=12;
const windows=[['5m',5*MINUTE,2*MINUTE],['1h',60*MINUTE,5*MINUTE],['24h',DAY,15*MINUTE]];
const stamp=v=>typeof v==='number'?v:Date.parse(v||'');
const clean=v=>typeof v==='string'?v.normalize('NFKC').replace(/\s+/gu,' ').trim():'';
const digest=v=>createHash('sha256').update(v).digest('hex');
const fresh=(at,now,age)=>Number.isFinite(at)&&at>0&&at<=now&&now-at<=age;
const key=t=>`${t.chain}:${gmgnFlowAddress(t.chain,t.address)}`;
const positive=v=>Number.isFinite(v)&&v>0;
const generic=new Set(['token','coin','crypto','binance','bitcoin','ethereum','solana','blockchain','community','news','web3','agent','agents','代币','社区','币安','人工智能','智能体']);
const curriculum=[
  ['account_incident','账号异常 / 盗号事件',/\b(?:hack(?:ed)?|compromised|stolen account)\b|盗号|账号被盗|账户被盗/iu,'核对当事人澄清和原帖；事件成立不等于合法发行或可卖出'],
  ['animal_visual','动物 / 图片符号',/\b(?:dog|cat|frog|bull|mascot|pet|animal|puppy|kitten)\b|动物|小狗|小猫|青蛙|吉祥物|宠物|🐶|🐱|🐸|🐂/iu,'核对原图、上下文、命名和同题材 CA；文字命中不是看懂图片'],
  ['celebrity_participation','人物参与 / 认领',/\b(?:claim(?:ed)?|donat\w*|recipient|royalt\w*)\b|认领|捐赠|捐款|收益接收|名人币/iu,'核对人物身份、认领交易和受益地址；到账不等于主动背书'],
  ['equity_pool','币股 / 底池机制',/\b(?:tokenized (?:stocks?|equities)|stock tokens?|equity|paired (?:pool|liquidity))\b|币股|底池|股票代币|代币化股票/iu,'核对池地址、两侧资产、价值归属与机制执行；名称不能证明底池关系'],
  ['platform_event','平台 / 项目催化',/\b(?:launch(?:ed)?|listing|listed|mainnet|testnet|upgrade|alpha)\b|发布|上线|升级|主网|测试网|上币/iu,'区分计划、正式落地和社区借题材；核对时间与精确 CA'],
  ['technology_culture','Web2 / 技术文化',/\b(?:ai|agents?|llm|gpt\w*|e[ /]?acc|research|app|robot)\b|人工智能|智能体|研究|机器人|互联网/iu,'核对事件主体和传播圈层；技术进展不自动等于代币需求'],
  ['meme_culture','Meme / 社区文化',/\b(?:meme|viral|birthday|holiday|moon\s*cakes?)\b|新梗|表情包|月饼|中秋|社区文化|爆火/iu,'比较原梗、OG 证据和新承接币；继续观察新受众与新增买家'],
];
const categories=text=>curriculum.filter(([, ,pattern])=>pattern.test(text)).map(([id])=>id);
const label=id=>curriculum.find(c=>c[0]===id)?.[1]||'事件含义待核实';
const terms=t=>[...new Set([t.name,t.symbol,...(Array.isArray(t.narrativeTags)?t.narrativeTags:[]),...(Array.isArray(t.raw?.tags)?t.raw.tags:[])])]
  .filter(v=>typeof v==='string'&&v.length<=120&&v.length>=(/\p{Script=Han}/u.test(v)?2:3)&&!generic.has(v.toLowerCase())).slice(0,20);
const links=t=>[t.twitterUsername,t.website,t.raw?.twitter,t.raw?.twitter_username,t.raw?.link?.twitter_username,t.raw?.link?.website]
  .map(v=>typeof v==='string'&&/^(?:i\/|[a-z\d_]{1,15}\/status\/)/i.test(v)?`https://x.com/${v}`:v).map(narrativeSourceKey).filter(Boolean);
function match(doc, item) {
  const t=item.token,ca=gmgnFlowAddress(t.chain,t.address);
  const addresses=t.chain==='sol'?doc.solAddresses:doc.evmAddresses;
  const direct=doc.assetKey===key(t)||(t.chain==='sol'||doc.chain===t.chain)&&addresses.includes(ca);
  const linked=item.researchLinks.includes(doc.id),named=item.researchMatchers.filter(([,pattern])=>pattern?.test(doc.normalizedText)).map(([name])=>name);
  return direct?{binding:'direct_ca',rank:3,terms:named}:linked?{binding:'project_permalink',rank:2,terms:named}:
    named.length?{binding:'name_tag_hypothesis',rank:1,terms:named}:null;
}
const validPoint=p=>p&&positive(p.price)&&positive(p.at)&&positive(p.sampledAt)&&p.at<=p.sampledAt;
export function validNarrativeAcademy(s) {
  try {return !!s&&s.version===NARRATIVE_ACADEMY_VERSION&&positive(s.updatedAt)&&Array.isArray(s.cases)&&s.cases.length<=MAX_CASES
    &&new Set(s.cases.map(c=>c?.id)).size===s.cases.length&&s.cases.every(c=>c&&narrativeSourceKey(c.url)===c.id
      &&typeof c.text==='string'&&c.text.length<=4000&&typeof c.fingerprint==='string'&&typeof c.contentHash==='string'
      &&positive(c.sourceAt)&&positive(c.firstSeenAt)&&c.sourceAt<=c.firstSeenAt&&positive(c.updatedAt)&&c.updatedAt<=s.updatedAt&&c.firstSeenAt<=c.updatedAt
      &&typeof c.conflicted==='boolean'
      &&typeof c.author==='string'&&Array.isArray(c.categories)&&c.categories.every(id=>curriculum.some(x=>x[0]===id))
      &&Array.isArray(c.candidates)&&c.candidates.length<=MAX_CANDIDATES&&new Set(c.candidates.map(t=>key(t))).size===c.candidates.length
      &&c.candidates.every(t=>gmgnFlowAddress(t.chain,t.address)===t.address&&positive(t.firstSeenAt)&&t.firstSeenAt>=c.firstSeenAt&&t.firstSeenAt<=s.updatedAt
        &&['direct_ca','project_permalink','name_tag_hypothesis'].includes(t.binding)&&Array.isArray(t.terms)&&t.terms.length<=20&&t.terms.every(n=>typeof n==='string'&&n.length<=120)
        &&(!t.baseline||validPoint(t.baseline)&&t.baseline.sampledAt>=t.firstSeenAt&&t.baseline.sampledAt<=s.updatedAt)&&t.outcomes&&typeof t.outcomes==='object'
        &&Object.entries(t.outcomes).every(([w,o])=>windows.some(x=>x[0]===w)&&o&&['observed','missing'].includes(o.status)
          &&!!t.baseline&&(o.status==='missing'?positive(o.checkedAt)&&o.checkedAt<=s.updatedAt
            :validPoint(o)&&Number.isFinite(o.returnRate)&&o.at>t.baseline.at&&o.sampledAt<=s.updatedAt
              &&o.at>=t.baseline.sampledAt+windows.find(x=>x[0]===w)[1]
              &&o.at<=t.baseline.sampledAt+windows.find(x=>x[0]===w)[1]+windows.find(x=>x[0]===w)[2]))));
  }catch{return false;}
}
function relation(caseRow, all) {
  const prior=all.filter(p=>p.id!==caseRow.id&&!p.conflicted&&p.sourceAt<caseRow.sourceAt);
  const copied=prior.find(p=>p.contentHash===caseRow.contentHash);
  if(copied)return {kind:'duplicate',previousId:copied.id,note:'相同文案再传播，不计二次发酵'};
  // Strict associations: same author AND shared linked CA. Generic animal/topic
  // categories alone never merge unrelated posts into one story.
  const previous=prior.filter(p=>p.author&&p.author.toLowerCase()===caseRow.author.toLowerCase()
    &&p.candidates.some(t=>t.binding!=='name_tag_hypothesis'&&caseRow.candidates.some(n=>n.binding!=='name_tag_hypothesis'&&key(n)===key(t))))
    .sort((a,b)=>b.sourceAt-a.sourceAt)[0];
  if(previous)return {kind:'followup_candidate',previousId:previous.id,note:'同作者、同 CA 的不同文案；待确认实质发展，未自动认定二次 / 三次发酵'};
  return {kind:'first_observed',previousId:null,note:'本系统首次关联，不代表全网首发或 OG 认证'};
}
function pricePoint(item, nowMs) {
  const at=stamp(item?.observedAt),price=item?.token?.price;
  return item?.marketStatus==='ok'&&fresh(at,nowMs,120000)&&positive(price)?{at,price,sampledAt:nowMs}:null;
}
export function advanceNarrativeAcademy(prior,{documents=[],conflictIds=[],candidates=[],marks=[],evaluations=[],nowMs=Date.now()}={}) {
  if(prior&&!validNarrativeAcademy(prior))throw new Error('叙事案例记忆异常，未重建');
  if(!positive(nowMs)||prior&&nowMs<prior.updatedAt)throw new Error('叙事学习时钟异常');
  const s=prior?structuredClone(prior):{version:NARRATIVE_ACADEMY_VERSION,updatedAt:nowMs,cases:[]};
  s.cases=s.cases.filter(c=>nowMs-c.firstSeenAt<=7*DAY);
  const byId=new Map(s.cases.map(c=>[c.id,c])),conflicts=new Set(conflictIds);
  let skipped=0;
  for(const raw of documents.slice(0,200)) {
    const id=narrativeSourceKey(raw?.url),sourceAt=stamp(raw?.at),text=clean(raw?.text).slice(0,4000),author=clean(raw?.author);
    if(!id||raw.authenticated!==true||!text||!fresh(sourceAt,nowMs,7*DAY))continue;
    const fingerprint=digest(JSON.stringify([text,sourceAt,author.toLowerCase(),raw.chain||null,raw.assetKey||null]));
    let c=byId.get(id);
    if(c&&c.fingerprint!==fingerprint){conflicts.add(id);continue;}
    if(!c){
      if(s.cases.length>=MAX_CASES){skipped++;continue;}
      c={id,url:raw.url,sourceAt,firstSeenAt:nowMs,updatedAt:nowMs,text,author,chain:raw.chain||null,assetKey:raw.assetKey||null,
        fingerprint,contentHash:digest(text.replace(/https?:\/\/\S+/gu,'').toLowerCase()),categories:categories(text),candidates:[],conflicted:false};
      s.cases.push(c);byId.set(id,c);
    }
  }
  for(const id of conflicts)if(byId.has(id)){const c=byId.get(id);if(!c.conflicted)c.updatedAt=nowMs;c.conflicted=true;}
  const assets=new Map();
  for(const item of candidates.slice(0,1500))if(item?.token&&gmgnFlowAddress(item.token.chain,item.token.address)) {
    const normalized={...item,token:{...item.token,address:gmgnFlowAddress(item.token.chain,item.token.address)},
      researchMatchers:terms(item.token).map(n=>[n,compileNarrativeName(n)]),researchLinks:links(item.token)};
    const old=assets.get(key(normalized.token));
    if(!old||stamp(item.observedAt)>stamp(old.observedAt))assets.set(key(normalized.token),normalized);
  }
  const prices=new Map();
  for(const [id,item] of assets){const p=pricePoint(item,nowMs);if(p)prices.set(id,p);}
  for(const m of marks.slice(0,1500)){
    if(!m||!gmgnFlowAddress(m.chain,m.address))continue;
    const p=pricePoint({token:m,observedAt:m.observedAt,marketStatus:m.status},nowMs),old=prices.get(key(m));
    if(p&&(!old||p.at>old.at))prices.set(key(m),p);
  }
  const evidence=new Map(evaluations.filter(e=>e?.token).map(e=>[key(e.token),e.evidence?.narrativeThesis]));
  for(const c of s.cases) {
    if(c.conflicted)continue;
    const matches=[];
    const prepared={...c,normalizedText:normalizeNarrativeText(c.text),solAddresses:c.text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[],
      evmAddresses:(c.text.match(/(?<![\da-f])0x[\da-f]{40}(?![\da-f])/ig)||[]).map(a=>a.toLowerCase())};
    for(const item of assets.values()){const found=match(prepared,item);if(found)matches.push({item,...found});}
    matches.sort((a,b)=>b.rank-a.rank||key(a.item.token).localeCompare(key(b.item.token)));
    c.matchCount=matches.length;
    for(const m of matches){
      const t=m.item.token;let record=c.candidates.find(r=>key(r)===key(t));
      if(!record&&c.candidates.length<MAX_CANDIDATES){
        record={chain:t.chain,address:t.address,symbol:clean(t.symbol).slice(0,120),name:clean(t.name).slice(0,120),firstSeenAt:nowMs,
          binding:m.binding,terms:m.terms,baseline:null,outcomes:{},authorEndorsement:false,ogStatus:'unverified'};
        c.candidates.push(record);c.updatedAt=nowMs;
      }
      // Freeze the original association for unbiased cohort follow-up. Later
      // metadata must not rewrite what was known at the first observation.
      if(record){record.latestBinding=m.binding;record.bindingObservedAt=nowMs;}
    }
    for(const record of c.candidates) {
      const point=prices.get(key(record)),before=JSON.stringify([record.baseline,record.outcomes]);
      if(!record.baseline&&point)record.baseline=point;
      if(record.baseline)for(const [window,delay,tolerance] of windows) {
        if(record.outcomes[window])continue;
        const target=record.baseline.sampledAt+delay;
        if(point&&point.at>=target&&point.at<=target+tolerance&&point.at>record.baseline.at){
          const rate=point.price/record.baseline.price-1;
          if(Number.isFinite(rate))record.outcomes[window]={status:'observed',...point,returnRate:rate};
        }else if(nowMs>target+tolerance)record.outcomes[window]={status:'missing',checkedAt:nowMs};
      }
      if(before!==JSON.stringify([record.baseline,record.outcomes]))c.updatedAt=nowMs;
      const thesis=evidence.get(key(record));
      record.currentEvidence=thesis?{at:thesis.observedAt,demand:thesis.demand?.status||'unknown',
        sourceId:thesis.event?.sourceId||null,controllerIdentity:'未核实'}:null;
    }
  }
  s.updatedAt=nowMs;
  return {memory:s,report:narrativeAcademyReport(s,{nowMs,skipped})};
}
export function narrativeAcademyReport(s,{nowMs=s.updatedAt,skipped=0}={}) {
  const cases=s.cases.filter(c=>!c.conflicted),cohort=cases.flatMap(c=>c.candidates);
  const outcomes=rows=>Object.fromEntries(windows.map(([w])=>{
    const observed=rows.map(r=>r.outcomes[w]).filter(o=>o?.status==='observed'),gains=observed.filter(o=>o.returnRate>0).length;
    return [w,{observed:observed.length,gains,losses:observed.filter(o=>o.returnRate<0).length,
      missing:rows.filter(r=>r.outcomes[w]?.status==='missing').length}];
  }));
  const recent=cases.toSorted((a,b)=>b.updatedAt-a.updatedAt||b.sourceAt-a.sourceAt).slice(0,16).map(c=>{
    const continuation=relation(c,cases),gaps=['原图 / 视频尚未解析；文本之外的含义待核实','发行者、OG 身份与同控钱包未核实'];
    if(c.categories.includes('equity_pool'))gaps.push('底池与权益机制缺链上独立核验');
    if(c.categories.includes('account_incident'))gaps.push('账号异常需当事人澄清；不是正常背书');
    if(!c.candidates.length)gaps.push('尚未关联到有市场资料的 CA');
    return {id:c.id,url:c.url,sourceAt:c.sourceAt,firstSeenAt:c.firstSeenAt,updatedAt:c.updatedAt,author:c.author,
      excerpt:c.text.slice(0,300),labels:c.categories.length?c.categories.map(label):[label('unknown')],continuation,gaps,
      phase:nowMs-c.sourceAt<=2*MINUTE?'新消息':nowMs-c.sourceAt<=60*MINUTE?'跟随研究':'历史背景',
      totalMatched:c.matchCount,retainedCandidates:c.candidates.length,candidates:c.candidates.map(t=>({...t})),
      note:'无买入许可；候选价格变化非账户收益，未扣费用'};
  });
  return {version:s.version,updatedAt:new Date(s.updatedAt).toISOString(),status:'collecting',researchOnly:true,autoTradingChanges:false,
    caseCount:cases.length,conflicted:s.cases.length-cases.length,candidateObservations:cohort.length,
    linkedObservations:cohort.filter(t=>t.binding!=='name_tag_hypothesis').length,outcomes:outcomes(cohort),
    followupCandidates:cases.filter(c=>relation(c,cases).kind==='followup_candidate').length,
    curriculum:curriculum.map(([id,name,,verification])=>{const relevant=cases.filter(c=>c.categories.includes(id));
      return {id,label:name,cases:relevant.length,verification,outcomes:outcomes(relevant.flatMap(c=>c.candidates))};}),recent,
    retention:{days:7,maxCases:MAX_CASES,maxCandidatesPerCase:MAX_CANDIDATES,capacitySkippedThisPass:skipped},
    limitations:['规则辅助分类与前瞻观察，不是模型训练或盈利验证','只覆盖已接入且取得原文的来源，非全量推特',
      '多 CA 并列比较，不凭名字或最高市值选正统；统计以事件–CA 观察计，非独立交易样本',
      '不额外抓图、补全量历史或产生付费调用；缺失观察窗口不补造价格']};
}
