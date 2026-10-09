import { createHash } from 'node:crypto';
import { readAuthenticatedNarrativeDocument } from './narrative-source-adapter.js';
import { verifyCapitalKolEventSnapshot, capitalKolCatalogFreshness } from './capital-kol-catalog.js';
import { collectGmgnFlowNarratives } from './gmgn-flow-narrative.js';
import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { createBoundedTextMemo } from './bounded-text-memo.js';

export const NARRATIVE_RECALL_VERSION = 'og_recall_v1';
const DAY = 86400000, WEEK = 7 * DAY, TRIGGER_TTL = 120000;
const clean = s => typeof s === 'string' ? s.normalize('NFKC').trim() : '';
const hash = s => createHash('sha256').update(s).digest('hex');
const keyOf = t => `${t.chain}:${gmgnFlowAddress(t.chain,t.address)}`;
const at = v => typeof v === 'number' ? v < 1e10 ? v*1000 : v : Date.parse(v || '');
const positive = v => Number.isFinite(v) && v > 0;
const chainOf = v => ({'56':'bsc','8453':'base','4663':'robinhood','1':'eth',solana:'sol',ethereum:'eth',sol:'sol',base:'base',bsc:'bsc',robinhood:'robinhood',eth:'eth'})[String(typeof v === 'object' ? v?.gmgn || v?.slug || v?.id : v).toLowerCase()];
function declaredChain(text) {
  const matches=[['bsc',/\b(?:bsc|bnb chain|bnb smart chain)\b|币安链/iu],['sol',/\bsolana\b/iu],
    ['base',/\bon base\b|base链|base chain/iu],['eth',/\b(?:on ethereum|ethereum mainnet)\b|以太坊/iu],['robinhood',/\brobinhood chain\b|robinhood链/iu]]
    .filter(([,re])=>re.test(text)).map(([chain])=>chain);
  return matches.length===1?matches[0]:null;
}
const negative = /\b(?:scam|rugged|honeypot|fake|avoid|not affiliated|do not buy|don't buy|sold|selling|dump|exit)\b|骗局|假冒|诈骗|辟谣|不要买|别买|清仓|卖出|止损|未发行|无关|不是官方/iu;
const stop = new Set('the a an and or of on in to for is are was be with this that it its as at by from we i you our my your they have has now new today live token coin meme crypto blockchain market buy buying launch launched official project community soon again back more not ai web3 defi solana bsc ethereum base gmgn com https http www us all will can may just about into here there one first launchpad 的 了 是 在 和 与 一个 这个 那个 我 我们 你 他们 已经 今天 现在 发布 上线 代币 项目 社区 官方 买入 加密 叙事 机会 可以 再次 关注'.split(/\s+/));
const segmenter = new Intl.Segmenter('zh', {granularity:'word'});
// Explainable lexical recall, not an LLM claim of semantic equivalence.
function extractNarrativeTerms(text) {
  let s = clean(text).toLowerCase().replace(/https?:\/\/\S+|0x[\da-f]{40,64}|\b[1-9A-HJ-NP-Za-km-z]{32,100}\b/gu,' ');
  for(const [re,word] of [[/无人驾驶出租车|自动驾驶出租车|robot\s+taxi/gu,'robotaxi'],[/回购销毁|buyback\s+and\s+burn/gu,'buybackburn'],[/人工智能代理|ai\s+agents?/gu,'aiagent'],[/永续合约|perpetuals?/gu,'perpetual']])s=s.replace(re,word);
  return [...new Set([...segmenter.segment(s)].filter(x=>x.isWordLike).map(x=>x.segment)
    .filter(x=>x.length>=2 && !stop.has(x) && !/^\d+$/.test(x)))].slice(0,64);
}
// Cache text segmentation only. readRecallDocument still authenticates every
// event and rechecks its clock, content conflicts and exact-CA binding.
const termMemo = createBoundedTextMemo(extractNarrativeTerms, { maxEntries: 2048, maxLength: 4000 });
export function narrativeTerms(text) { return [...termMemo.get(text)]; }
export function narrativeOverlap(a,b) {
  const left=new Set(a),right=new Set(b),matched=[...left].filter(x=>right.has(x));
  const score=matched.length/(left.size+right.size-matched.length || 1);
  return {score,matched,high:matched.length>=3 && score>=.72};
}

export function readRecallDocument(raw, nowMs) {
  const event=raw?.event || raw;
  if(!event)return null;
  const tweet=event.tweet;
  if(event.type==='kol_narrative_observation') {
    const identity=verifyCapitalKolEventSnapshot(event),binding=event.caller?.capitalKolBinding;
    const match=clean(tweet?.url).match(/^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/);
    const published=at(tweet?.createdAt),observed=at(event.observedAt),bound=at(binding?.observedAt);
    if(!identity.valid || !capitalKolCatalogFreshness({nowMs}).valid || !match
      || match[1].toLowerCase()!==identity.entry.handle.toLowerCase() || match[2]!==String(tweet.id)
      || tweet.sourceVerifiedBy!=='official_x_oembed' || tweet.isReply!==false || tweet.isQuote!==false || tweet.textTruncated
      || binding?.xUserId!==identity.entry.expectedXUserId || clean(binding?.handle).toLowerCase()!==identity.entry.handle.toLowerCase()
      || !['fxtwitter_public_profile','official_x_api_v2_user'].includes(binding?.source)
      || !Number.isFinite(bound) || !Number.isFinite(observed) || bound>observed || observed-bound>DAY
      || !Number.isFinite(published) || published>observed || observed>nowMs || nowMs-published>WEEK || !clean(tweet.text))return null;
    return {id:tweet.url,url:tweet.url,text:clean(tweet.text).slice(0,4000),at:published,kind:'reviewed_big_kol',
      author:identity.entry.handle,authenticated:true,chain:chainOf(event.chain)||declaredChain(tweet.text)};
  }
  if(event.type==='fomo_family_top_call') {
    const chain=chainOf(event.chain),address=gmgnFlowAddress(chain,event.token);
    const source=collectGmgnFlowNarratives({chain,tokenAddress:address,events:[event],nowMs:Math.max(at(event.publishedAt),nowMs-WEEK)})[0];
    if(source && !source.contentConflict)return {id:source.sourceUrl,url:source.sourceUrl,text:source.sourceText,at:at(source.sourceAt),
      kind:'authenticated_call',author:source.authorLabel,authenticated:true,chain,boundAddress:address};
    return null;
  }
  const source=readAuthenticatedNarrativeDocument(event);
  return source ? {...source,chain:chainOf(event.chain || event.chainId)||declaredChain(source.text)} : null;
}
export function emptyNarrativeMemory(nowMs) {
  return {version:NARRATIVE_RECALL_VERSION,startedAt:nowMs,documents:[],assets:{},conflicts:[]};
}
export function validNarrativeMemory(m) {
  return !!m && m.version===NARRATIVE_RECALL_VERSION && Number.isFinite(m.startedAt) && Array.isArray(m.documents)
    && m.documents.length<=2000 && m.assets && typeof m.assets==='object' && !Array.isArray(m.assets) && Object.keys(m.assets).length<=1000
    && Array.isArray(m.conflicts) && m.conflicts.length<=2000
    && m.documents.every(d=>typeof d.id==='string'&&typeof d.url==='string'&&typeof d.text==='string'&&d.text.length<=4000
      &&Number.isFinite(d.at)&&d.authenticated===true&&Array.isArray(d.terms)&&d.terms.length<=64&&d.terms.every(x=>typeof x==='string'))
    && Object.entries(m.assets).every(([key,a])=>key===keyOf(a)&&gmgnFlowAddress(a.chain,a.address)&&Array.isArray(a.activity)
      && a.activity.every(Number.isFinite) && Number.isFinite(a.firstBoundAt));
}
function bindDocument(doc,tokens) {
  if(doc.assetKey)return doc.assetKey;
  if(!doc.chain)return null;
  const evm=[...new Set(doc.text.match(/(?<![\da-fA-F])0x[\da-fA-F]{40}(?![\da-fA-F])/g)?.map(x=>x.toLowerCase()) || [])];
  const sol=new Set(doc.text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || []);
  const matches=tokens.filter(t=> (!doc.chain || doc.chain===t.chain) &&
    (t.chain==='sol' ? sol.has(t.address) : evm.includes(t.address.toLowerCase())));
  const keys=[...new Set(matches.map(keyOf))];
  return keys.length===1 && evm.length<=1 ? keys[0] : null;
}

export function advanceNarrativeRecall(prior,{events=[],candidates=[],trades=[],nowMs=Date.now()}={}) {
  if(prior && !validNarrativeMemory(prior))throw new Error('叙事记忆格式异常，停止叙事入场，未修改账户');
  const memory=structuredClone(prior || emptyNarrativeMemory(nowMs));
  const items=candidates.filter(x=>x.marketStatus==='ok' && at(x.observedAt)<=nowMs && nowMs-at(x.observedAt)<=120000
    && gmgnFlowAddress(x.token?.chain,x.token?.address));
  const tokens=items.map(x=>({...x.token,address:gmgnFlowAddress(x.token.chain,x.token.address)}));
  const documents=new Map(memory.documents.filter(d=>d.at<=nowMs&&nowMs-d.at<=WEEK).map(d=>[d.id,d]));
  const conflicts=new Set(memory.conflicts);
  let rejectedSources=0;
  for(const event of events) {
    const doc=readRecallDocument(event,nowMs);
    if(!doc || !Number.isFinite(doc.at) || doc.at>nowMs || nowMs-doc.at>WEEK){rejectedSources++;continue;}
    doc.text=clean(doc.text);doc.terms=narrativeTerms(doc.text);doc.negative=negative.test(doc.text);
    const old=documents.get(doc.id);
    if(old && (old.text!==doc.text || old.at!==doc.at || old.chain && doc.chain && old.chain!==doc.chain)) {conflicts.add(doc.id);continue;}
    if(!old)documents.set(doc.id,doc);
  }
  // Bind only the precise historical address, never a ticker or website name.
  for(const doc of documents.values()) {
    if(conflicts.has(doc.id)||doc.negative)continue;
    doc.assetKey=bindDocument(doc,tokens);
    if(!doc.assetKey)continue;
    const token=tokens.find(t=>keyOf(t)===doc.assetKey),existing=memory.assets[doc.assetKey];
    if(!existing && token)memory.assets[doc.assetKey]={chain:token.chain,address:token.address,symbol:token.symbol,
      firstBoundAt:doc.at,lastSeenAt:nowMs,activity:[]};
    if(memory.assets[doc.assetKey])memory.assets[doc.assetKey].firstBoundAt=Math.min(memory.assets[doc.assetKey].firstBoundAt,doc.at);
  }
  for(const item of items) {
    const token=item.token,key=keyOf(token),a=memory.assets[key];if(!a)continue;
    a.lastSeenAt=nowMs;a.symbol=token.symbol;
    a.activity=a.activity.filter(t=>t<=nowMs&&nowMs-t<=WEEK);
    const observed=at(item.observedAt),volume=token.volume??token.volume1h??token.volume24h;
    if(positive(volume)&&positive(token.liquidity)&&(!a.activity.length||observed-a.activity.at(-1)>=3600000))a.activity.push(observed);
    for(const trade of trades)if(trade.side==='buy'&&keyOf(trade)===key&&trade.atMs<=nowMs&&nowMs-trade.atMs<=WEEK)a.activity.push(trade.atMs);
    a.activity=[...new Set(a.activity)].sort((x,y)=>x-y).slice(-168);
  }
  const usable=[...documents.values()].filter(d=>!conflicts.has(d.id)&&!d.negative);
  const consumed=new Set(trades.filter(t=>t.side==='buy').map(t=>t.entryEvidence?.narrativeRecall?.triggerId).filter(Boolean));
  const matches=[],observations=[];
  for(const trigger of usable.filter(d=>nowMs-d.at<=TRIGGER_TTL && ['reviewed_big_kol','official_x','official_release','official_github'].includes(d.kind))) {
    // A direct CA post belongs to the existing call lane; recall is for prose without a CA.
    if(/0x[\da-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(trigger.text))continue;
    const triggerId=hash(trigger.id);if(consumed.has(triggerId))continue;
    const histories=usable.filter(d=>d.assetKey && d.at<trigger.at && trigger.at-d.at<=WEEK).flatMap(d=>{
      const overlap=narrativeOverlap(trigger.terms,d.terms),asset=memory.assets[d.assetKey];
      const activity=asset?.activity.filter(t=>t<trigger.at&&trigger.at-t<=WEEK) || [];
      return overlap.high&&activity.length ? [{doc:d,asset,overlap}] : [];
    }).sort((a,b)=>a.asset.firstBoundAt-b.asset.firstBoundAt || b.overlap.score-a.overlap.score || a.doc.id.localeCompare(b.doc.id));
    const best=histories[0];
    if(!best){observations.push({sourceUrl:trigger.url,author:trigger.author,reason:'没有已绑定 CA 且曾观察到交易的近七天高重合样本'});continue;}
    const ambiguous=histories.some(x=>x.doc.assetKey!==best.doc.assetKey && x.asset.firstBoundAt===best.asset.firstBoundAt);
    const token=tokens.find(t=>keyOf(t)===best.doc.assetKey);
    const current=token?.marketCap,reference=token?.historyHighestMarketCap;
    const room=positive(current)&&positive(reference)&&reference>=current ? reference/current : null;
    const ready=!ambiguous&&room!==null&&room>=3;
    const reasons=[...(ambiguous?['最早绑定记录对应多个 CA，不能唯一选择 OG']:[]),...(!token?['需要刷新历史 OG 的行情与安全字段']:[]),
      ...(room===null?['历史最高市值或当前市值缺失，空间未知']:room<3?['距历史市值参考不足三倍']:[])];
    matches.push({version:NARRATIVE_RECALL_VERSION,triggerId,sourceUrl:trigger.url,sourceAt:trigger.at,author:trigger.author,
      triggerText:trigger.text.slice(0,700),kind:trigger.kind,chain:best.asset.chain,address:best.asset.address,symbol:best.asset.symbol,
      historicalSourceUrl:best.doc.url,historicalAt:best.doc.at,historicalText:best.doc.text.slice(0,700),
      ourPriorEntries:trades.filter(t=>t.side==='buy'&&keyOf(t)===best.doc.assetKey&&t.atMs<trigger.at&&trigger.at-t.atMs<=WEEK).length,
      matchedTerms:best.overlap.matched,similarity:best.overlap.score,ogBasis:'本地历史中最早的已绑定 CA 候选，不等于全网首发认证',
      referenceMarketCap:reference??null,currentMarketCap:current??null,referenceRoom:room,
      roomNote:'GMGN 历史最高市值参考，不限于七天；不是未来上限或预期收益',
      ready,reasons,summary:`${trigger.author || '已核实来源'} 文案与七天内旧叙事重合 ${Math.round(best.overlap.score*100)}%；匹配 ${best.overlap.matched.join('、')}；优先复查历史 OG 候选 ${best.asset.symbol || best.asset.address}。`});
  }
  memory.documents=[...documents.values()].sort((a,b)=>a.at-b.at).slice(-2000);
  memory.conflicts=[...conflicts].slice(-2000);
  const needed=new Set(memory.documents.map(d=>d.assetKey).filter(Boolean));
  memory.assets=Object.fromEntries(Object.entries(memory.assets).filter(([key,a])=>needed.has(key)&&nowMs-a.lastSeenAt<=WEEK)
    .sort((a,b)=>b[1].lastSeenAt-a[1].lastSeenAt).slice(0,1000));
  return {memory,matches:matches.sort((a,b)=>b.sourceAt-a.sourceAt).slice(0,20),
    report:{version:NARRATIVE_RECALL_VERSION,windowDays:7,sourceCount:usable.length,knownTokens:Object.keys(memory.assets).length,
      startedAt:memory.startedAt,earliestSourceAt:usable.length?Math.min(...usable.map(d=>d.at)):null,
      completeSevenDayHistory:false,rejectedSources,conflicts:conflicts.size,observations:observations.slice(0,5),
      note:'仅检索已采集的真实文案与绑定记录；不是全网完整七天。关键词/短语重合不证明作者推荐该币。'}};
}

export function freshNarrativeRecall(match,token,nowMs) {
  return match?.version===NARRATIVE_RECALL_VERSION && match.ready===true && match.chain===token.chain
    && match.address===gmgnFlowAddress(token.chain,token.address) && match.sourceAt<=nowMs && nowMs-match.sourceAt<=TRIGGER_TTL
    && Number.isFinite(match.similarity)&&match.similarity>=.72 && match.matchedTerms?.length>=3
    && positive(match.referenceRoom)&&match.referenceRoom>=3 && match.historicalAt<match.sourceAt && match.sourceAt-match.historicalAt<=WEEK;
}
