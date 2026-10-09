// Deterministic, cached PUBLIC evidence only. No RPC, model, signing or orders.
import {createHash} from 'node:crypto';
import {gmgnFlowAddress, qualifiesGmgnFlowWallet, mergeGmgnFlowTrade} from './gmgn-flow-signal.js';
import {flowWindowCoverage} from './gmgn-flow-coverage.js';
import {normalizeInnerTradeWindow} from './bsc-inner-trade-events.js';

export const COLLECTIVE_SIGNAL_VERSION='bsc_collective_profit_v1';
export const PREQUALIFIED_WALLET_VERSION='bsc_prequalified_wallet_v1';
export const INTERNAL_BURST_VERSION='bsc_internal_burst_v1';
export const ONCHAIN_BURST_VERSION='bsc_onchain_internal_burst_v1';
export const isWalletSignalVersion=v=>[COLLECTIVE_SIGNAL_VERSION,PREQUALIFIED_WALLET_VERSION,INTERNAL_BURST_VERSION,ONCHAIN_BURST_VERSION].includes(v);
export const internalOnlySignal=v=>[PREQUALIFIED_WALLET_VERSION,INTERNAL_BURST_VERSION,ONCHAIN_BURST_VERSION].includes(v);
export const walletSignalRoute=s=>s?.version===ONCHAIN_BURST_VERSION?'onchain_internal_burst':s?.version===INTERNAL_BURST_VERSION?'internal_burst':s?.version===PREQUALIFIED_WALLET_VERSION?'prequalified_wallet':'collective_smart_money';
export const COLLECTIVE_THESIS_VERSION='entry_bound_wallet_cohort_v1';
export const COLLECTIVE_POLICY=Object.freeze({version:COLLECTIVE_SIGNAL_VERSION,mode:'paper',chain:'bsc',
  windowsMs:Object.freeze([10000,30000,60000]),minGroups:3,minWalletNetUsd:100,minNetUsd:300,
  maxSourceAgeMs:30000,maxBuyAgeMs:30000,quoteMaxAgeMs:5000,
  internalRequiresChart:false,externalRequiresChart:true});
export const PREQUALIFIED_WALLET_POLICY=Object.freeze({...COLLECTIVE_POLICY,version:PREQUALIFIED_WALLET_VERSION,
  minGroups:1,minNetUsd:100,internalOnly:true,profileBeforeBuy:true,
  note:'仅预先核验的盈利地址真实净买；非已确认庄家，研究参考名册不授予资格。未知阶段仅补证，已核实内盘才可模拟。'});
export const INTERNAL_BURST_POLICY=Object.freeze({version:INTERNAL_BURST_VERSION,mode:'paper',chain:'bsc',internalOnly:true,
  windowMs:30000,baselineMs:60000,minBaselineUsd:100,minBaselineTrades:2,minVolumeUsd:1000,minAcceleration:2,
  minNetUsd:300,minGroups:3,minWalletNetUsd:50,minBuyShare:.65,maxGroupBuyShare:.6,
  maxSourceAgeMs:30000,quoteMaxAgeMs:5000,internalRequiresChart:false,
  note:'仅已覆盖的 GMGN 公共逐笔子集放量，不是全链成交量；不要求盈利画像，不认定庄家或叙事。'});
export const ONCHAIN_BURST_POLICY=Object.freeze({...INTERNAL_BURST_POLICY,version:ONCHAIN_BURST_VERSION,
  note:'固定 Four V2/Flap 已核区间内指定 CA 的普通钱包买卖日志；当前仅原生 BNB 底池。不是全 BSC 覆盖，接收地址不等于独立控制人或盈利教师。'});
const iso=n=>new Date(n).toISOString(),at=v=>typeof v==='number'?v:Date.parse(v||'');
const excluded=/(?:^|[_-])(?:wash(?:[_-]?trader)?|arbitrager|arbitrage|mev(?:[_-]?bot)?|sandwich|router|cex|exchange|contract)(?:$|[_-])/i;
const fresh=(v,now,age)=>Number.isFinite(at(v))&&at(v)<=now&&now-at(v)<=age;
const key=t=>`${t?.chain}:${t?.address}`;
const fields=(value,names)=>Object.fromEntries(names.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));

function analyze(proof,nowMs) {
  const fail=reason=>({ready:false,reason,signal:null});
  if(!isWalletSignalVersion(proof?.version)||proof.chain!=='bsc'||gmgnFlowAddress('bsc',proof.address)!==proof.address)
    return fail('信号 CA 或版本未核实');
  if(proof.version===ONCHAIN_BURST_VERSION) {
    if(proof.window?.tokenAddress!==proof.address)return fail('链上成交证明 CA 不匹配');
    const result=normalizeInnerTradeWindow(proof.window,nowMs);
    if(!result.ready)return fail(result.reason||'链上成交区间未核实');
    return analyzeBurst(proof,result.trades,result.coverage,nowMs);
  }
  const single=proof.version===PREQUALIFIED_WALLET_VERSION,policy=single?PREQUALIFIED_WALLET_POLICY:COLLECTIVE_POLICY;
  const coverage=flowWindowCoverage(proof.snapshot,nowMs);
  if(!coverage.complete||!fresh(coverage.endAt,nowMs,COLLECTIVE_POLICY.maxSourceAgeMs)
    ||Object.values(proof.snapshot.feedCoverage||{}).some(v=>at(v.observedAt)>nowMs||v.endAt>nowMs))
    return fail('双路公共资金流覆盖不完整或超过 30 秒');
  // Chain-level "partial" may describe profile research, not this CA's feed.
  // Use its proven interval and CA quarantine, just like the existing flow adapter.
  if(at(proof.snapshot.quarantinedTokens?.[proof.address])>nowMs||at(proof.snapshot.tokenRebuildUntil?.[proof.address])>nowMs)
    return fail('此 CA 资金流冲突隔离或窗口重建中');
  if(!Array.isArray(proof.trades)||proof.trades.length>400||!proof.profiles)return fail('原始交易证明缺失或超出有界容量');
  const seen=new Map();
  for(const raw of proof.trades) {
    const t={...raw,hash:typeof raw?.hash==='string'?raw.hash.toLowerCase():raw?.hash};
    if(t.chain!=='bsc'||t.tokenAddress!==proof.address||gmgnFlowAddress('bsc',t.wallet)!==t.wallet
      ||!/^0x[\da-f]{64}$/.test(t.hash||'')||!['buy','sell'].includes(t.side)
      ||!Number.isFinite(t.amountUsd)||t.amountUsd<=0||!Number.isSafeInteger(t.at)
      ||t.at>coverage.endAt||t.at<coverage.startAt||!Array.isArray(t.tags)||t.tags.some(s=>excluded.test(s)))
      return fail('原始交易身份、方向、时间或金额不一致');
    const id=`${t.hash}:${t.wallet}:${t.tokenAddress}`;
    try{seen.set(id,mergeGmgnFlowTrade(seen.get(id),t));}catch{return fail('同一交易记录冲突');}
  }
  const trades=[...seen.values()].sort((a,b)=>a.at-b.at||a.hash.localeCompare(b.hash)||a.wallet.localeCompare(b.wallet));
  if(proof.version===INTERNAL_BURST_VERSION)return analyzeBurst(proof,trades,coverage,nowMs);
  const allNet=new Map();
  for(const t of trades)allNet.set(t.wallet,(allNet.get(t.wallet)||0)+(t.side==='buy'?1:-1)*t.amountUsd);
  const qualified=wallet=>['7d','30d'].every(period=>fresh(proof.profiles[wallet]?.[period]?.checkedAt,nowMs,7200000)
      &&proof.profiles[wallet][period].lastTradeAt*1000<=nowMs
      &&(!single||at(proof.profiles[wallet][period].checkedAt)<Math.min(...trades.filter(t=>t.wallet===wallet&&t.side==='buy').map(t=>t.at))
        &&proof.profiles[wallet][period].lastTradeAt*1000<=at(proof.profiles[wallet][period].checkedAt)))
    &&qualifiesGmgnFlowWallet(proof.profiles[wallet],'bsc',wallet,nowMs);
  const recentWallets=[...new Set(trades.filter(t=>t.side==='buy'&&t.at>=coverage.endAt-60000).map(t=>t.wallet))];
  const profileQualifiedCount=recentWallets.filter(qualified).length;
  const profileMissingCount=recentWallets.filter(w=>['7d','30d'].some(p=>!fresh(proof.profiles[w]?.[p]?.checkedAt,nowMs,7200000))).length;
  let bestGroups=0;
  for(const windowMs of COLLECTIVE_POLICY.windowsMs) {
    const rows=trades.filter(t=>t.at>=coverage.endAt-windowMs),wallets=new Map(),parents=new Map(),txOwners=new Map();
    const root=w=>{while(parents.has(w)&&parents.get(w)!==w)w=parents.get(w);return w;};
    for(const t of rows) {
      const w=wallets.get(t.wallet)||{wallet:t.wallet,buyUsd:0,sellUsd:0,lastBuyAt:0};
      w[t.side==='buy'?'buyUsd':'sellUsd']+=t.amountUsd;
      if(t.side==='buy')w.lastBuyAt=Math.max(w.lastBuyAt,t.at);
      wallets.set(t.wallet,w);
      if(!parents.has(t.wallet))parents.set(t.wallet,t.wallet);
      const other=txOwners.get(t.hash);if(other)parents.set(root(t.wallet),root(other));else txOwners.set(t.hash,t.wallet);
    }
    const buyers=[...wallets.values()].filter(w=>w.buyUsd-w.sellUsd>=COLLECTIVE_POLICY.minWalletNetUsd
      &&allNet.get(w.wallet)>=COLLECTIVE_POLICY.minWalletNetUsd&&qualified(w.wallet))
      .map(w=>({...w,netBuyUsd:w.buyUsd-w.sellUsd,group:root(w.wallet)})).sort((a,b)=>a.wallet.localeCompare(b.wallet));
    const groups=new Set(buyers.map(w=>w.group)),netUsd=rows.reduce((n,t)=>n+(t.side==='buy'?1:-1)*t.amountUsd,0);
    bestGroups=Math.max(bestGroups,groups.size);
    const lastBuyAt=Math.max(0,...buyers.map(w=>w.lastBuyAt));
    if(groups.size<policy.minGroups||netUsd<policy.minNetUsd
      ||!fresh(lastBuyAt,nowMs,COLLECTIVE_POLICY.maxBuyAgeMs))continue;
    // Receipt time/window movement/profile refresh cannot manufacture a new ID.
    const buyerSet=new Set(buyers.map(w=>w.wallet));
    const buyIds=trades.filter(t=>buyerSet.has(t.wallet)&&t.side==='buy'&&t.at>=coverage.endAt-windowMs)
      .map(t=>`${t.hash}:${t.wallet}`).sort();
    const id=`${proof.chain}:${proof.address}:${policy.version}:${createHash('sha256').update(buyIds.join('|')).digest('hex').slice(0,24)}`;
    return {ready:true,reason:null,signal:{version:policy.version,paperOnly:true,id,chain:'bsc',address:proof.address,
      source:single?'prequalified_wallet':'collective_smart_money',provider:'gmgn',sourceAt:iso(lastBuyAt),sourceObservedAt:iso(coverage.endAt),windowMs,
      groupCount:groups.size,netBuyUsd:netUsd,buyers,proof,
      scope:'GMGN 已采集公共流；重复交易及同交易地址合并，控制人独立性和完整库存未核实；不是叙事或盈利保证'}};
  }
  return {ready:false,reason:`近一分钟 ${recentWallets.length} 个买入地址，${profileQualifiedCount} 个${single?'事前核验':''}盈利画像合格、${profileMissingCount} 个画像缺失或过期；短窗最多 ${bestGroups} 组合格净买，${single?'未形成有效事前核验地址净买':'尚未形成三组共振'}`,signal:null};
}

// Adjacent, non-overlapping windows; a missing/zero baseline is NOT an
// infinite acceleration signal. Hash-linked wallets count as one group.
function analyzeBurst(proof,trades,coverage,nowMs) {
  const onchain=proof.version===ONCHAIN_BURST_VERSION;
  const p=onchain?ONCHAIN_BURST_POLICY:INTERNAL_BURST_POLICY,fail=reason=>({ready:false,reason,signal:null});
  if(!fresh(coverage.endAt,nowMs,p.maxSourceAgeMs))return fail('逐笔成交窗口已过期');
  const boundary=coverage.endAt-p.windowMs,start=boundary-p.baselineMs;
  if(coverage.startAt>start)return fail('内盘放量缺少完整的相邻 90 秒逐笔覆盖');
  const baseline=trades.filter(t=>t.at>start&&t.at<=boundary),rows=trades.filter(t=>t.at>boundary);
  const baselineUsd=baseline.reduce((n,t)=>n+t.amountUsd,0),volumeUsd=rows.reduce((n,t)=>n+t.amountUsd,0);
  if(baselineUsd<p.minBaselineUsd||new Set(baseline.map(t=>t.hash)).size<p.minBaselineTrades)
    return fail('内盘放量缺少有效前窗基线，不能将零基线当作起量');
  const acceleration=(volumeUsd/p.windowMs)/(baselineUsd/p.baselineMs);
  const parents=new Map(),owners=new Map(),wallets=new Map();
  const root=w=>{while(parents.get(w)!==w)w=parents.get(w);return w;};
  for(const t of trades.filter(t=>t.at>start)) {
    if(!parents.has(t.wallet))parents.set(t.wallet,t.wallet);
    if(owners.has(t.hash))parents.set(root(t.wallet),root(owners.get(t.hash)));else owners.set(t.hash,t.wallet);
  }
  for(const t of rows) {
    const w=wallets.get(t.wallet)||{wallet:t.wallet,buyUsd:0,sellUsd:0,lastBuyAt:0};
    w[t.side==='buy'?'buyUsd':'sellUsd']+=t.amountUsd;
    if(t.side==='buy')w.lastBuyAt=Math.max(w.lastBuyAt,t.at);
    wallets.set(t.wallet,w);
  }
  const groups=new Map();
  for(const w of wallets.values()) {const id=root(w.wallet),g=groups.get(id)||{buyUsd:0,sellUsd:0};g.buyUsd+=w.buyUsd;g.sellUsd+=w.sellUsd;groups.set(id,g);}
  const buyers=[...wallets.values()].filter(w=>w.buyUsd-w.sellUsd>=p.minWalletNetUsd&&groups.get(root(w.wallet)).buyUsd-groups.get(root(w.wallet)).sellUsd>=p.minWalletNetUsd)
    .map(w=>({...w,netBuyUsd:w.buyUsd-w.sellUsd,group:root(w.wallet)})).sort((a,b)=>a.wallet.localeCompare(b.wallet));
  const groupCount=new Set(buyers.map(w=>w.group)).size,buyUsd=rows.filter(t=>t.side==='buy').reduce((n,t)=>n+t.amountUsd,0);
  const netBuyUsd=2*buyUsd-volumeUsd,buyShare=volumeUsd?buyUsd/volumeUsd:0;
  const largestGroupShare=buyUsd?Math.max(0,...[...groups.values()].map(g=>g.buyUsd))/buyUsd:1;
  if(volumeUsd<p.minVolumeUsd||acceleration<p.minAcceleration||netBuyUsd<p.minNetUsd||groupCount<p.minGroups
    ||buyShare<p.minBuyShare||largestGroupShare>p.maxGroupBuyShare)
    return fail(`内盘逐笔放量尚未成立：30秒成交 ${Math.round(volumeUsd)}U，速度 ${acceleration.toFixed(2)} 倍，净买 ${Math.round(netBuyUsd)}U，${groupCount} 组，最大组占比 ${Math.round(largestGroupShare*100)}%`);
  const lastBuyAt=Math.max(0,...buyers.map(w=>w.lastBuyAt));
  if(!fresh(lastBuyAt,nowMs,p.maxSourceAgeMs))return fail('内盘放量买入交易已过期');
  const buyerSet=new Set(buyers.map(w=>w.wallet));
  const ids=rows.filter(t=>t.side==='buy'&&buyerSet.has(t.wallet)).map(t=>`${t.hash}:${t.wallet}${onchain?':'+t.logIndex:''}`).sort();
  const id=`bsc:${proof.address}:${p.version}:${createHash('sha256').update(ids.join('|')).digest('hex').slice(0,24)}`;
  return {ready:true,reason:null,signal:{version:p.version,paperOnly:true,id,chain:'bsc',address:proof.address,
    source:onchain?'onchain_internal_burst':'internal_burst',provider:onchain?'bsc_portal_logs':'gmgn',sourceAt:iso(lastBuyAt),sourceObservedAt:iso(coverage.endAt),windowMs:p.windowMs,
    groupCount,netBuyUsd,buyers,volumeUsd,baselineUsd,acceleration,buyShare,largestGroupShare,proof,scope:p.note}};
}

export function buildCollectiveWire({state={},onchainState=null,nowMs,account,allowPrequalified=false,allowBurst=false}={}) {
  const snapshot=state.chains?.bsc,all=state.trades?.bsc||[];
  const addresses=[...new Set(all.filter(t=>t.chain==='bsc'&&t.side==='buy'&&fresh(t.at,nowMs,60000))
    .sort((a,b)=>b.at-a.at).map(t=>t.tokenAddress))].slice(0,64);
  const coverage=flowWindowCoverage(snapshot,nowMs),signals=[],checks=[];
  for(const address of addresses) {
    const trades=all.filter(t=>t.chain==='bsc'&&t.tokenAddress===address&&t.at>=coverage.startAt&&t.at<=coverage.endAt);
    const profiles=Object.fromEntries([...new Set(trades.map(t=>t.wallet))].map(wallet=>[wallet,state.profiles?.[`bsc:${wallet}`]||{}]));
    const proof={version:COLLECTIVE_SIGNAL_VERSION,chain:'bsc',address,
      snapshot:{...fields(snapshot,['status','discardedThroughAt']),
        feedCoverage:Object.fromEntries(['smartmoney','kol'].map(k=>[k,fields(snapshot?.feedCoverage?.[k],['valid','startAt','endAt','observedAt'])])),
        quarantinedTokens:fields(snapshot?.quarantinedTokens,[address]),tokenRebuildUntil:fields(snapshot?.tokenRebuildUntil,[address])},
      trades:structuredClone(trades.map(t=>fields(t,['chain','tokenAddress','wallet','side','hash','at','amountUsd','baseAmount','quoteAmount','tags']))),
      profiles:structuredClone(profiles)};
    let result=analyze(proof,nowMs);
    if(!result.ready&&allowPrequalified)result=analyze({...proof,version:PREQUALIFIED_WALLET_VERSION},nowMs);
    if(!result.ready&&allowBurst)result=analyze({...proof,version:INTERNAL_BURST_VERSION,profiles:{}},nowMs);
    const signal=result.signal;
    const consumed=signal&&account?.trades?.some(t=>t.side==='buy'&&t.entryEvidence?.collectiveSignal?.id===signal.id);
    const held=!!account?.positions?.[`bsc:${address}`];
    checks.push({chain:'bsc',address,signalId:signal?.id||null,sourceAt:signal?.sourceAt||null,
      status:held?'holding':consumed?'consumed':result.ready?'triggered':'observing',reason:held?'已有持仓':consumed?'此信号已成交':result.reason,
      groupCount:signal?.groupCount??null,windowMs:signal?.windowMs??null,netBuyUsd:signal?.netBuyUsd??null});
    if(signal&&!consumed&&!held)signals.push(signal);
  }
  // A separate proof and source scope: ordinary chain logs never become
  // GMGN-tagged smart money or inherit its coverage/profit qualifications.
  const windows=allowBurst&&Array.isArray(onchainState?.windows)?onchainState.windows.slice(0,4):[];
  const seen=new Set();
  for(const window of windows) {
    const address=window?.tokenAddress;
    if(!gmgnFlowAddress('bsc',address)||seen.has(address))continue;
    seen.add(address);
    const proof={version:ONCHAIN_BURST_VERSION,chain:'bsc',address,window};
    const result=analyze(proof,nowMs),signal=result.signal;
    const held=!!account?.positions?.[`bsc:${address}`];
    const consumed=signal&&account?.trades?.some(t=>t.side==='buy'&&t.entryEvidence?.collectiveSignal?.id===signal.id);
    checks.push({chain:'bsc',address,provider:'bsc_portal_logs',signalId:signal?.id||null,sourceAt:signal?.sourceAt||null,
      status:held?'holding':consumed?'consumed':result.ready?'triggered':'observing',reason:held?'已有持仓':consumed?'此信号已成交':result.reason,
      groupCount:signal?.groupCount??null,windowMs:signal?.windowMs??null,netBuyUsd:signal?.netBuyUsd??null});
    // A CA can have only one contemporaneous entry signal. Keep a valid
    // prequalified/collective route first, without adding both feeds' volume.
    if(signal&&!held&&!consumed&&!signals.some(s=>s.address===address))signals.push(signal);
  }
  return {version:COLLECTIVE_SIGNAL_VERSION,policy:COLLECTIVE_POLICY,signals,checks,
    sourceStatus:coverage.complete&&fresh(coverage.endAt,nowMs,30000)?'covered':'unavailable_or_stale',
    observedAt:coverage.endAt?iso(coverage.endAt):null};
}

export function validCollectiveSignal(signal,token,nowMs) {
  if(!signal||key(signal)!==key(token)||signal.paperOnly!==true)return false;
  const expected=analyze(signal.proof,nowMs).signal;
  return !!expected&&JSON.stringify(expected)===JSON.stringify(signal);
}

export function collectiveQuote(history,token,signal,nowMs) {
  const fail=()=>({ready:false,reason:'连续新鲜报价确认',rows:[]});
  if(!validCollectiveSignal(signal,token,nowMs))return fail();
  const rows=(history||[]).filter(q=>key(q)===key(token)&&q.status==='ok'&&Number.isFinite(q.price)&&q.price>0
    &&fresh(q.observedAt,nowMs,5000)&&at(q.observedAt)>=at(signal.sourceAt)).sort((a,b)=>at(a.observedAt)-at(b.observedAt));
  const times=new Map();for(const q of rows){const time=at(q.observedAt);if(times.has(time)&&times.get(time)!==q.price)return fail();times.set(time,q.price);}
  const last=rows.at(-1);if(!last||last.price!==token.price)return fail();
  return {ready:true,count:1,confirmedAt:last.observedAt,reason:null,rows:[fields(last,['chain','address','status','price','observedAt'])]};
}

export function collectiveWalletThesis(row,nowMs) {
  const e=row.evidence||{},signal=e.collectiveSignal;
  if(!['internal','near_completion'].includes(e.marketStage)||e.opportunity?.id!==walletSignalRoute(signal)
    ||!validCollectiveSignal(signal,row.token,nowMs)||!(row.token.price>0))return null;
  return {version:COLLECTIVE_THESIS_VERSION,chain:row.token.chain,address:row.token.address,
    createdAt:iso(nowMs),entryPrice:row.token.price,signalId:signal.id,sourceAt:signal.sourceAt,
    buyers:signal.buyers.map(w=>w.wallet),kind:signal.version===ONCHAIN_BURST_VERSION?'已核内盘链上逐笔加速与分散净买':signal.version===INTERNAL_BURST_VERSION?'公共逐笔子集加速放量与分散净买':signal.version===PREQUALIFIED_WALLET_VERSION?'事前核验盈利地址的新鲜净买':'已核实历史盈利地址的短窗净买共振',
    meaning:'冻结入场地址群；观察同源新增卖出和后续结构，不虚构价格止损、不认定同控或叙事'};
}
export function validCollectiveThesis(thesis,position) {
  const expected=collectiveWalletThesis({token:{...position,price:position.entryPrice},evidence:position.entryEvidence},at(position.openedAt));
  return !!expected&&JSON.stringify(expected)===JSON.stringify(thesis);
}
