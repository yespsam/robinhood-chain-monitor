import {gmgnFlowAddress} from './gmgn-flow-signal.js';

export const TWITTER_EVENT_VERSION='twitter_event_candidate_v1';
export const TWITTER_EVENT_TTL_MS=3600000;
const DAY=86400000;
const norm=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const time=v=>typeof v==='number'?v:Date.parse(v||'');
const fresh=(v,now,ttl)=>Number.isFinite(time(v))&&time(v)<=now&&now-time(v)<=ttl;
const generic=new Set(['token','coin','crypto','blockchain','binance','bitcoin','ethereum','solana','bnb','btc','eth','sol','ai','web3','agent','agents','news','community','代币','社区','智能体','人工智能']);
const warning=/\b(?:not affiliated|unaffiliated|no token|do not buy|don't buy|fake token|scam|rugged|sold|selling)\b|未发行|没有发行|不要买|别买|假币|诈骗|辟谣|清仓|与.{0,8}无关/iu;
// Explicit, inspectable aliases only. Broad AI/crypto labels are not catalysts.
const concepts=[
  {id:'eacc',label:'e/acc · 有效加速主义',pattern:/\be[\s/]acc\b|\beacc\b|effective acceleration(?:ism)?|有效加速主义/iu},
  {id:'mooncake',label:'中秋 / 月饼',pattern:/\bmoon\s*cakes?\b|中秋|月饼/iu},
];
export function twitterPostKey(value){
  try {const raw=String(value||''),u=new URL(/^https?:\/\//.test(raw)?raw:`https://x.com/${raw}`);
    if(u.protocol!=='https:'||!['x.com','twitter.com'].includes(u.hostname)||u.port||u.username||u.password)return null;
    const m=u.pathname.match(/^\/(?:[a-z\d_]{1,15}\/status|i\/(?:web\/)?status)\/(\d+)\/?$/i);
    return m?`x:${m[1]}`:null;
  }catch{return null;}
}
const allowedDoc=d=>d?.authenticated===true&&['reviewed_big_kol','official_x','independent_x_research'].includes(d.kind)
  &&typeof d.text==='string'&&d.text.trim()&&typeof d.author==='string'&&twitterPostKey(d.url);
const topicIds=text=>concepts.filter(c=>c.pattern.test(text)).map(c=>c.id);
const terms=t=>[...new Set([t.name,t.symbol].filter(v=>typeof v==='string'&&v.length<=120))]
  .filter(v=>norm(v).length>=(/\p{Script=Han}/u.test(v)?2:3)&&!generic.has(norm(v)));
const matchingTerm=(body,term)=>{
  if(/\p{Script=Han}/u.test(term))return body.includes(term);
  const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,'iu').test(body);
};
const tags=t=>[...(Array.isArray(t.narrativeTags)?t.narrativeTags:[]),...(Array.isArray(t.raw?.tags)?t.raw.tags:[])]
  .filter(v=>typeof v==='string'&&v.length<=120).slice(0,40);
const links=t=>[t.twitterUsername,t.website,t.raw?.twitter,t.raw?.twitter_username,t.raw?.link?.twitter_username,t.raw?.link?.website]
  .map(twitterPostKey).filter(Boolean);
function eventFrame(text){
  const fee=/\b(?:fees?|claimed|claim|proceeds|donations?|funding)\b|认领|手续费|捐款|资助/iu.test(text);
  const planned=/\b(?:will|might|may|plans?|would|could)\b|计划|可能|拟|即将/iu.test(text);
  return {kind:fee?'celebrity_funding':'culture_attention',label:fee?'人物 / 资助收益叙事':'人物 / 社区题材传播',
    claim:fee?'原文提及认领、收益或资助；受益对象和执行情况须另行核实':'原文传播题材；不代表发行、认领或背书某个 CA',
    status:planned?'计划 / 条件性主张':'原文主张，非独立事实认证',
    mechanism:fee?'人物参与和资金用途可能带来关注；代币是否承接需求仍看对应关系与新增买盘':'题材传播可能聚集注意力；名称和标签只用于找候选，不证明资金会进入'};
}

// Event first: source -> concepts -> names/tags -> CA link -> paper checks.
// Provider metadata is a community association, never celebrity endorsement.
export function historicalTwitterAnchors(episodes,nowMs){
  return (episodes||[]).slice(-2000).flatMap(e=>(e.narratives||[]).filter(n=>['provider_permalink','verified_ca'].includes(n.binding)
    &&fresh(n.at,nowMs,7*DAY)&&n.at<=e.at&&Number.isFinite(n.associatedAt)&&n.associatedAt<=nowMs
    &&typeof n.author==='string'&&typeof n.text==='string'&&twitterPostKey(n.url))
    .map(n=>({url:n.url,text:n.text,at:n.at,author:n.author,authenticated:true,kind:'historical_project_source'})));
}
export function buildTwitterEventCandidates({documents=[],anchorDocuments=[],candidates=[],nowMs=Date.now()}={}){
  const docs=documents.filter(d=>allowedDoc(d)&&fresh(d.at,nowMs,7*DAY));
  const docMap=new Map(),conflicts=new Set();
  for(const d of [...docs,...anchorDocuments.filter(d=>d?.kind==='historical_project_source'&&d.authenticated===true
    &&fresh(d.at,nowMs,7*DAY)&&typeof d.text==='string'&&typeof d.author==='string'&&twitterPostKey(d.url))]){
    const id=twitterPostKey(d.url),old=docMap.get(id);
    if(old&&(old.text.replace(/\s+/g,' ').trim()!==d.text.replace(/\s+/g,' ').trim()||old.at!==d.at||old.author.toLowerCase()!==d.author.toLowerCase()))conflicts.add(id);
    else docMap.set(id,d);
  }
  for(const id of conflicts)docMap.delete(id);
  const tokens=[...new Map(candidates.map(item=>{const t=item.token||item;return [`${t.chain}:${t.address}`,{
    item,t,terms:terms(t),tags:tags(t),links:links(t)}];})).values()]
    .filter(({t})=>gmgnFlowAddress(t.chain,t.address)===t.address);
  const reports=[];
  for(const d of docs.filter(d=>fresh(d.at,nowMs,DAY)&&!conflicts.has(twitterPostKey(d.url))).sort((a,b)=>b.at-a.at).slice(0,24)){
    const id=twitterPostKey(d.url),eventConcepts=topicIds(d.text),negative=warning.test(d.text),frame=eventFrame(d.text);
    const repeated=docs.some(p=>p.at<d.at&&p.author.toLowerCase()===d.author.toLowerCase()&&norm(p.text)===norm(d.text));
    const rows=[];
    for(const f of tokens){
      const {t,item}=f,matchedNames=f.terms.filter(term=>matchingTerm(d.text,term));
      const matchedConcepts=eventConcepts.filter(c=>topicIds(`${t.name||''} ${t.symbol||''}`).includes(c));
      const matchedTags=f.tags.filter(tag=>!generic.has(norm(tag))&&(eventConcepts.some(c=>topicIds(tag).includes(c))||matchingTerm(d.text,tag)));
      const mentioned=t.chain==='sol'?d.text.includes(t.address):d.chain===t.chain&&d.text.toLowerCase().includes(t.address);
      if(!mentioned&&!matchedNames.length&&!matchedConcepts.length&&!matchedTags.length)continue;
      const exact=f.links.includes(id);
      const anchor=f.links.map(k=>docMap.get(k)).find(p=>p&&p.at<d.at&&p.author.toLowerCase()===d.author.toLowerCase()
        &&!warning.test(p.text)&&eventConcepts.some(c=>topicIds(p.text).includes(c)&&[...matchedConcepts,...topicIds(matchedTags.join(' '))].includes(c)));
      const binding=mentioned?'direct_ca':exact?'project_permalink':anchor?'historical_topic_permalink':'name_tag_only';
      const strength={direct_ca:3,project_permalink:2,historical_topic_permalink:1,name_tag_only:0}[binding];
      const blocks=[];
      if(negative)blocks.push('原文含否认或卖出信号，不能当买入催化');
      if(repeated)blocks.push('重复文案，没有新增事件');
      if(!fresh(d.at,nowMs,TWITTER_EVENT_TTL_MS))blocks.push('事件超过一小时，仅作背景研究，不补造首发买点');
      if(item.marketStatus!=='ok'||!fresh(item.observedAt,nowMs,120000))blocks.push('等待刷新此 CA 的真实行情');
      if(!strength)blocks.push('只有名称 / 标签关联，尚无原帖到 CA 的出处');
      rows.push({version:TWITTER_EVENT_VERSION,chain:t.chain,address:t.address,symbol:t.symbol,name:t.name,
        sourceId:id,sourceUrl:d.url,sourceAt:new Date(d.at).toISOString(),sourceText:d.text,author:d.author,
        observedAt:new Date(nowMs).toISOString(),marketObservedAt:item.observedAt||null,
        event:frame,concepts:eventConcepts.map(c=>concepts.find(x=>x.id===c).label),matchedNames,matchedTags,matchedConcepts,
        binding,strength,anchor:anchor?{url:anchor.url,at:new Date(anchor.at).toISOString(),text:anchor.text.slice(0,400)}:null,
        authorEndorsement:false,selected:false,blocks,liquidity:t.liquidity??null,
        phase:fresh(d.at,nowMs,120000)?'launch':fresh(d.at,nowMs,TWITTER_EVENT_TTL_MS)?'follow_through':'background'});
    }
    rows.sort((a,b)=>b.strength-a.strength||(b.liquidity||0)-(a.liquidity||0)||a.address.localeCompare(b.address));
    const best=rows[0]?.strength||0,leaders=rows.filter(r=>r.strength===best&&best>0);
    // Liquidity never resolves an ambiguous identity. Compare all matched CAs,
    // including stale ones, before deciding whether the association is unique.
    if(leaders.length>1)for(const r of leaders)r.blocks.push('多个 CA 具有同等级出处，不能凭流动性猜正统币');
    if(leaders.length===1&&!leaders[0].blocks.length)leaders[0].selected=true;
    reports.push({sourceId:id,sourceUrl:d.url,sourceAt:new Date(d.at).toISOString(),author:d.author,text:d.text.slice(0,600),
      event:frame,negative,repeated,concepts:eventConcepts.map(c=>concepts.find(x=>x.id===c).label),
      candidateCount:rows.length,candidates:rows.slice(0,12),decision:rows.some(r=>r.selected)?'进入行情与资金检查':rows.length?'研究 / 等待证据':'未找到有依据的 CA 候选'});
  }
  return {version:TWITTER_EVENT_VERSION,method:'规则辅助事件与显式别名映射，非通用语义模型',reports,
    candidates:reports.flatMap(r=>r.candidates),paperOnly:true};
}

export function validTwitterEventCandidate(m,s,nowMs){
  return m?.version===TWITTER_EVENT_VERSION&&m.chain===s.chain&&m.address===s.address&&m.sourceId===s.sourceId
    &&m.sourceUrl===s.sourceUrl&&m.sourceText===s.text&&m.sourceAt===s.sourceAt&&twitterPostKey(s.sourceUrl)===s.sourceId
    &&m.selected===true&&m.authorEndorsement===false&&Array.isArray(m.blocks)&&m.blocks.length===0
    &&['direct_ca','project_permalink','historical_topic_permalink'].includes(m.binding)
    &&fresh(m.sourceAt,nowMs,TWITTER_EVENT_TTL_MS)&&fresh(m.marketObservedAt,nowMs,120000)
    &&(!warning.test(s.text))&&(!m.anchor||fresh(m.anchor.at,nowMs,7*DAY)&&time(m.anchor.at)<time(s.sourceAt)&&!!twitterPostKey(m.anchor.url))
    &&(m.binding!=='historical_topic_permalink'||!!m.anchor&&m.matchedConcepts?.length>0);
}
