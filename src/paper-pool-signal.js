// Read-only bridge from the existing canonical, ordered launchpad producer.
// It does not change that producer's monitor-only / no-execution permissions.
import {createHash} from 'node:crypto';
import {isStrictFlapTrackedPoolTokenUpdate,isStrictFlapPortalQuoteAssetUpdate,
  isStrictFourRegistryTrackedTokenUpdate,fourRegistryEventSupersedesTrackedToken} from './source-controls.js';
import {flapLifecycleVeto} from './paper-launch-lifecycle.js';
import {poolEventProofIdentity} from './launch-event-identity.js';
export {poolEventProofIdentity} from './launch-event-identity.js';

export const POOL_FIRST_THREE_VERSION='paper_quote_asset_first_three_v1';
export const LAUNCH_GENERATION_VERSION='paper_launch_generation_first_three_v2';
export const POOL_FIRST_THREE_POLICY=Object.freeze({version:POOL_FIRST_THREE_VERSION,mode:'paper',maxUniqueCA:3,
  generationPolicyVersion:LAUNCH_GENERATION_VERSION,supportedSources:['bsc:flap','bsc:fourmeme'],maxEventAgeMs:120000,requiresChart:false,
  orderBasis:'链上 TokenCreated 的区块号、交易序号、日志序号；不是发现顺序或热门榜',
  coverageNote:'仅接入严格链上证明的 BSC Flap 底池配置与 OpenFour 模板代次；网页模板、无关联 Hook 或缺排序证据仍观察；其他发射台未覆盖，不推测排名'});
const source='new_pool_first_three',version='monitored_event_entry_v1';
const at=v=>Date.parse(v||'');
const group=s=>s.pool.mechanismKey?`${s.chain}:${s.pool.platform}:${s.pool.mechanismKey}`:`${s.chain}:flap:${s.pool.quoteAddress}`;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const order=e=>[e.blockNumber,e.transactionIndex,e.logIndex];
const compare=(a,b)=>{for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};

const fourEvent=isStrictFourRegistryTrackedTokenUpdate;
const supported=e=>isStrictFlapTrackedPoolTokenUpdate(e)||fourEvent(e);
const configurationKey=c=>createHash('sha256').update(JSON.stringify(
  ['defaultCurve','alternativeCurve','nativeToQuoteSwapType','dexId'].map(k=>c?.[k]))).digest('hex');
function descriptor(e) {
  if(fourEvent(e))return {version:LAUNCH_GENERATION_VERSION,platform:'fourmeme',
    quoteAddress:e.tokens[0].quoteAsset,quoteSymbol:e.tokens[0].quoteAsset==='0x'+'0'.repeat(40)?'BNB':'已核实报价资产',
    presetId:e.presetId,mechanismKey:e.featureGenerationKey,generationKey:e.featureGenerationKey,
    mechanismLabel:e.preset?.name||'OpenFour 模板',ordinal:e.featureTokenOrdinal,poolAddress:null,
    creationOrder:order(e),createdAt:e.blockTimestamp};
  const p={version:POOL_FIRST_THREE_VERSION,platform:'flap',quoteAddress:e.mode.quoteAsset,
    quoteSymbol:e.mode.quoteSymbol,generationKey:e.featureGenerationKey,ordinal:e.featureTokenOrdinal,
    poolAddress:e.pools[0].pool,creationOrder:order(e),createdAt:e.blockTimestamp};
  if(e.featureActivationProof?.type==='verified_configuration_change')Object.assign(p,{
    version:LAUNCH_GENERATION_VERSION,mechanismKey:`quote:${p.quoteAddress}:configuration:${configurationKey(e.featureActivationProof.after)}`,
    mechanismLabel:`Flap ${p.quoteSymbol} 底池新配置`});
  return p;
}
function eventFailure(event,nowMs) {
  if(!supported(event))return 'invalid_proof';
  if(event.canonicalRevision)return 'canonical_revision';
  if(event.delayedRecovery)return 'delayed_recovery';
  if(!Number.isFinite(at(event.blockTimestamp))||!Number.isFinite(at(event.observedAt))
    ||at(event.blockTimestamp)>nowMs||at(event.observedAt)>nowMs||at(event.observedAt)<at(event.blockTimestamp))return 'invalid_timestamp';
  if(nowMs-at(event.blockTimestamp)>POOL_FIRST_THREE_POLICY.maxEventAgeMs)return 'expired';
  return null;
}

function fields(event,nowMs) {
  if(eventFailure(event,nowMs))return null;
  const pool=descriptor(event);
  return {chain:'bsc',address:event.tokens[0].token,source,sourceId:event.eventKey,sourceUrl:event.sourceUrl,
    sourceAt:event.blockTimestamp,authenticated:true,
    text:pool.version===POOL_FIRST_THREE_VERSION
      ?`Flap 新底池 ${event.mode.quoteSymbol}（${event.mode.quoteAsset}）的第 ${event.featureTokenOrdinal}/3 个 CA；链上创建和底池关系已核对，不代表发行者背书或未来收益。`
      :`${pool.mechanismLabel} 本次已核实机制的第 ${pool.ordinal}/3 个不同 CA；链上模板/底池归属与创建顺序已核对，不代表安全、发行者背书或未来收益。`,
    pool,
    poolEvent:structuredClone(event)};
}

export function validPoolSignal(s,token,nowMs) {
  const f=fields(s?.poolEvent,nowMs);
  return !!f&&s.version===version&&s.paperOnly===true&&token?.chain===f.chain&&token.address===f.address
    &&Object.entries(f).every(([k,v])=>same(s[k],v))
    &&s.id===`${version}:${source}:${f.sourceId}:${f.chain}:${f.address}`
    &&Number.isFinite(at(s.observedAt))&&at(s.observedAt)>=at(f.poolEvent.observedAt)
    &&at(s.observedAt)<=nowMs&&nowMs-at(s.observedAt)<=30000;
}

export function poolEntryAllowed(signal,account,nowMs) {
  if(!validPoolSignal(signal,signal,nowMs))return false;
  const buys=(account?.trades||[]).filter(t=>t.side==='buy');
  // CA-wide and quote-asset-wide dedupe survives exits, restarts and cash top-ups.
  if(buys.some(t=>t.chain===signal.chain&&t.address===signal.address))return false;
  const prior=buys.map(t=>t.entryEvidence?.opportunity?.event).filter(s=>s?.source===source&&s.pool&&group(s)===group(signal));
  return new Set(prior.map(s=>s.address)).size<3&&!prior.some(s=>s.pool.ordinal===signal.pool.ordinal
    ||s.pool.generationKey!==signal.pool.generationKey);
}

export function buildPoolFirstThreeWire({events=[],account,sourceHealth,launchSourceHealth,nowMs=Date.now()}={}) {
  const raw=events.map(r=>r?.event||r),seen=new Map(),conflicts=new Set();
  const accepted=raw.filter(supported);
  for(const e of accepted){
    const g=group({chain:'bsc',pool:descriptor(e)}),slot=`${g}:${e.featureTokenOrdinal}`;
    const old=seen.get(slot);
    if(old&&poolEventProofIdentity(old)!==poolEventProofIdentity(e))conflicts.add(g);
    // Preserve first verification time on an otherwise identical retry.
    if(!old||at(e.observedAt)<at(old.observedAt))seen.set(slot,e);
  }
  const unique=[...seen.values()],byAsset=new Map();
  for(const e of unique){const k=group({chain:'bsc',pool:descriptor(e)});if(!byAsset.has(k))byAsset.set(k,[]);byAsset.get(k).push(e);}
  // At most three rows per asset; do not scan unrelated quote assets pairwise.
  for(const [g,rows] of byAsset)for(const a of rows)for(const b of rows)if(a.featureTokenOrdinal<b.featureTokenOrdinal
    &&(a.tokens[0].token===b.tokens[0].token||compare(order(a),order(b))>=0))conflicts.add(g);
  const disabled=new Set(raw.filter(e=>e?.kind==='flap_quote_asset_disabled'&&isStrictFlapPortalQuoteAssetUpdate(e)
    &&at(e.blockTimestamp)<=nowMs).flatMap(e=>(e.changes?.removedFlapPools||[]).map(p=>`bsc:${p.quoteAddress}`)));
  const inactive=e=>e.featurePlatform==='fourmeme'?raw.some(c=>fourRegistryEventSupersedesTrackedToken(c,e))
    :disabled.has(`bsc:${e.mode.quoteAsset}`)||flapLifecycleVeto(raw,e,nowMs);
  const signals=unique.flatMap(e=>{
    const f=fields(e,nowMs);if(!f||conflicts.has(group(f))||inactive(e))return [];
    const s={version,paperOnly:true,...f,observedAt:new Date(nowMs).toISOString()};
    s.id=`${version}:${source}:${s.sourceId}:${s.chain}:${s.address}`;
    return poolEntryAllowed(s,account,nowMs)?[s]:[];
  }).sort((a,b)=>compare(a.pool.creationOrder,b.pool.creationOrder));
  const readyIds=new Set(signals.map(s=>s.sourceId)),rejectionReasons={};
  const diagnostics=unique.map(e=>{
    const p=descriptor(e),asset=group({chain:'bsc',pool:p}),lag=at(e.observedAt)-at(e.blockTimestamp);
    const reason=eventFailure(e,nowMs)||(conflicts.has(asset)?'conflicting_asset':inactive(e)?'superseded_or_disabled_generation'
      :readyIds.has(e.eventKey)?null:'already_consumed');
    if(reason)rejectionReasons[reason]=(rejectionReasons[reason]||0)+1;
    return {chain:'bsc',platform:p.platform,address:e.tokens[0].token,quoteAddress:p.quoteAddress,generationKey:p.generationKey,ordinal:e.featureTokenOrdinal,
      sourceAt:e.blockTimestamp,verifiedAt:e.observedAt,verificationLagMs:Number.isFinite(lag)&&lag>=0?lag:null,
      expiredOnArrival:Number.isFinite(lag)&&lag>POOL_FIRST_THREE_POLICY.maxEventAgeMs,
      status:reason?'rejected':'signal_ready',reason};
  });
  const lags=diagnostics.map(d=>d.verificationLagMs).filter(Number.isFinite).sort((a,b)=>a-b);
  const percentile=q=>lags.length?lags[Math.ceil(lags.length*q)-1]:null;
  return {signals,seeds:signals.map(s=>({chain:s.chain,address:s.address,
    symbol:s.poolEvent.tokens[0].metadata?.symbol||s.poolEvent.tokens[0].symbol,
    name:s.poolEvent.tokens[0].metadata?.name||s.poolEvent.tokens[0].name})),
    report:{...POOL_FIRST_THREE_POLICY,updatedAt:new Date(nowMs).toISOString(),verifiedEvents:accepted.length,
      launchSourceHealth:launchSourceHealth||null,
      uniqueEvents:unique.length,expiredOnArrivalEvents:diagnostics.filter(d=>d.expiredOnArrival).length,rejectionReasons,
      latency:{sampleCount:lags.length,p50Ms:percentile(.5),p95Ms:percentile(.95),basis:'chain_creation_to_verified_event; retained unique events, not a live SLO'},
      diagnostics:diagnostics.sort((a,b)=>at(b.verifiedAt)-at(a.verifiedAt)).slice(0,24),
      conflictingAssets:conflicts.size,disabledAssets:disabled.size,readySignals:signals.length,
      lastVerifiedEventAt:accepted.map(e=>e.blockTimestamp).sort().at(-1)||null,
      sourceHealth:{status:sourceHealth?.status||'unknown',checkedAt:sourceHealth?.checkedAt||null,
        pendingBlocks:Number.isSafeInteger(sourceHealth?.pendingBlocks)?sourceHealth.pendingBlocks:null,
        lastSuccessAt:sourceHealth?.lastSuccessAt||null,lastErrorCode:sourceHealth?.lastErrorCode||null,
        note:sourceHealth?.status==='catching_up'?`来源已恢复，正在补扫历史区块${Number.isSafeInteger(sourceHealth.pendingBlocks)?`（剩余 ${sourceHealth.pendingBlocks} 块）`:''}；尚未追上实时`
          :sourceHealth?.status==='healthy'&&nowMs-at(sourceHealth.lastSuccessAt)>=0&&nowMs-at(sourceHealth.lastSuccessAt)<=120000
          ?'来源近期校验成功；不代表全链或其他发射台覆盖':'来源未证明近期健康；零信号不能解释为市场没有新底池或机会'},
      candidates:signals.map(s=>({chain:s.chain,address:s.address,...s.pool,sourceUrl:s.sourceUrl}))}};
}
