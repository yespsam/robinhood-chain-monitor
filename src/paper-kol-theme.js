// Explainable lexical hypotheses, not claimed endorsements or general AI
// semantic understanding. Market metadata supplies the CA; a KOL post does not.
export const KOL_THEME_VERSION='kol_theme_hypothesis_v1';
export const KOL_THEME_TTL_MS=3600000;
const clean=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const themes=s=>clean(s).replace(/mooncakes?|月饼|中秋(?:快乐|节)?/gu,'mooncake');
const generic=new Set(['moon','cake','token','crypto','binance','blockchain','happy','coin','bnb','btc','eth','sol','ai','web3']);
function linkedPostId(value){
  try {
    const raw=String(value||'').trim();
    const u=new URL(/^https?:\/\//.test(raw)?raw:`https://x.com/${raw}`);
    if(u.protocol!=='https:'||!['x.com','twitter.com'].includes(u.hostname)||u.port||u.username||u.password)return null;
    return u.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)\/?$/)?.[1]||null;
  }catch{return null;}
}
export function kolThemeCandidates(doc,candidates,nowMs){
  if(!doc?.authenticated||!['reviewed_big_kol','official_x'].includes(doc.kind)||!Number.isFinite(doc.at)
    ||doc.at>nowMs||nowMs-doc.at>KOL_THEME_TTL_MS||/0x[\da-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(doc.text||'')
    ||/\b(?:scam|rugged|honeypot|fake|avoid|not affiliated|do not buy|don't buy|sold|selling|dump|exit)\b|骗局|假冒|诈骗|辟谣|不要买|别买|清仓|卖出|止损|未发行|无关|不是官方/iu.test(doc.text||''))return [];
  const text=themes(doc.text),postId=linkedPostId(doc.url),seen=new Set(),rows=[];
  for(const item of candidates){
    const t=item.token||item,k=`${t.chain}:${t.address}`,at=Date.parse(item.observedAt);
    if(seen.has(k)||!t.address||item.marketStatus!=='ok'||!Number.isFinite(at)||at>nowMs||nowMs-at>120000)continue;
    const terms=[...new Set([t.name,t.symbol].map(themes))].filter(s=>s.length>=4&&!generic.has(s)&&text.includes(s));
    if(!terms.length)continue;seen.add(k);
    const links=[t.twitterUsername,t.website,t.raw?.twitter,t.raw?.twitter_username,t.raw?.link?.twitter_username,t.raw?.link?.website];
    const linked=!!postId&&links.some(url=>linkedPostId(url)===postId);
    rows.push({version:KOL_THEME_VERSION,chain:t.chain,address:t.address,symbol:t.symbol,name:t.name,
      matchedTerms:terms,sourceUrl:doc.url,sourceId:doc.id,sourceAt:new Date(doc.at).toISOString(),author:doc.author,
      sourceText:doc.text,observedAt:new Date(nowMs).toISOString(),marketObservedAt:item.observedAt,
      liquidity:Number.isFinite(t.liquidity)?t.liquidity:null,volume:t.volume??t.volume1h??t.volume24h??null,
      binding:linked?'provider_project_permalink_and_theme':'name_overlap_only',authorEndorsement:false,
      phase:nowMs-doc.at<=120000?'launch':'follow_through',selected:false,
      explanation:linked?'名称主题相符，项目资料引用同一原帖；是社区题材关联，不是作者认领 CA。':'仅名称主题相符，未核实项目与原帖关联；只研究、不据此买入。'});
  }
  rows.sort((a,b)=>Number(b.binding==='provider_project_permalink_and_theme')-Number(a.binding==='provider_project_permalink_and_theme')
    ||(b.liquidity??-1)-(a.liquidity??-1)||a.address.localeCompare(b.address));
  if(rows[0]?.binding==='provider_project_permalink_and_theme')rows[0].selected=true;
  return rows.slice(0,12).map((r,i)=>({...r,rank:i+1}));
}
