import fs from 'node:fs/promises';
import path from 'node:path';
import { gmgnFlowAddress, qualifiesGmgnFlowWallet, mergeGmgnFlowTrade } from './gmgn-flow-signal.js';
import { flowWindowCoverage } from './gmgn-flow-coverage.js';
import { collectGmgnFlowNarratives, resolveGmgnFlowNarrative, indexGmgnNarrativeEvents } from './gmgn-flow-narrative.js';
import { BINANCE_FLOW_KINDS, buildBinanceFlowEvidence, validBinanceFlowState } from './binance-flow-evidence.js';
import { paperFlowPulse } from './paper-flow-pulse.js';
import {LAUNCH_EVIDENCE_FILE,LAUNCH_EVIDENCE_VERSION,LAUNCH_EVIDENCE_MAX_BYTES} from './paper-launch-evidence.js';
import {isStrictFourRegistryTrackedTokenUpdate,isStrictFlapTrackedPoolTokenUpdate} from './source-controls.js';
import {FOUR_REGISTRY_STATE_VERSION,FOUR_REGISTRY_ADDRESS,FOUR_CORE_ADDRESS} from './four-registry-monitor.js';
import {poolEventProofIdentity} from './paper-pool-signal.js';
import {launchEventDigest} from './launch-event-identity.js';

const blockedTag = /(?:^|[_-])(?:wash(?:[_-]?trader)?|arbitrager|arbitrage|mev(?:[_-]?bot)?|sandwich|router|cex|exchange|contract)(?:$|[_-])/i;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value || '');

const objectRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fourOwnerKey=event=>`${event?.eventKey}:${event?.blockHash}:${event?.payloadDigest}`;
const fourTracked=event=>isStrictFourRegistryTrackedTokenUpdate(event)
  ||event?.featurePlatform==='fourmeme'&&event?.featureTrackedToken===true;
function canonicalFlapProjection(state) {
  const available=state?.schema==='paper_flap_canonical_v1'&&state.version===1
    &&state.source==='bsc-launchpad-monitor'&&state.status==='ready'
    &&objectRecord(state.windows)&&Object.keys(state.windows).length<=256;
  return {available,allowed:row=>{
    const event=row?.event||row;
    if(!isStrictFlapTrackedPoolTokenUpdate(event))return true;
    const window=available?state.windows[event.featureGenerationKey]:null;
    if(!window||window.active!==true||window.generationKey!==event.featureGenerationKey
      ||window.quoteAddress!==event.mode.quoteAsset||!Array.isArray(window.slots)||window.slots.length>3)return false;
    const slots=window.slots.filter(s=>s.ordinal===event.featureTokenOrdinal);
    if(slots.length!==1)return false;
    const slot=slots[0];
    return slot.eventKey===event.eventKey&&slot.tokenAddress===event.tokens[0].token
      &&['transactionHash','blockHash','blockNumber','transactionIndex','logIndex'].every(k=>slot[k]===event[k])
      &&slot.proofDigest===launchEventDigest(event);
  }};
}
function canonicalFourProjection(state, externalRows) {
  // A TG envelope proves delivery, not current canonical ownership. Missing or
  // corrupt producer state must not fall back to its historical notification.
  const available=state?.version===FOUR_REGISTRY_STATE_VERSION&&state.initialized===true
    &&state.chainId===56&&state.registry===FOUR_REGISTRY_ADDRESS&&state.core===FOUR_CORE_ADDRESS
    &&objectRecord(state.processedEvents)&&Array.isArray(state.outbox)&&objectRecord(state.orphanedDeliveredEvents);
  const blocked=new Set(),owners=new Map(),conflicts=new Set();
  for(const row of externalRows){
    const event=row?.event||row;
    if(row?.fourRegistryCancellation||Object.values(row?.destinations||{}).some(d=>d?.disabledReason==='four_registry_canonical_reorg'))
      blocked.add(fourOwnerKey(event));
  }
  for(const orphan of Object.values(state?.orphanedDeliveredEvents||{}))
    blocked.add(fourOwnerKey(orphan?.processedEvent?.event||orphan?.processedEvent));
  const records=[...Object.values(state?.processedEvents||{}),...(Array.isArray(state?.outbox)?state.outbox:[])];
  if(available)for(const row of records){
    const event=row?.event;
    if(!isStrictFourRegistryTrackedTokenUpdate(event)||row.eventKey!==event.eventKey
      ||row.lifecycleKey!==event.lifecycleKey||blocked.has(fourOwnerKey(event)))continue;
    // Processed records bind these fields independently; queued records carry
    // the closed event directly and have no separate block/payload fields.
    if(['blockHash','payloadDigest','transactionHash','transactionIndex','logIndex','blockNumber']
      .some(key=>Object.hasOwn(row,key)&&row[key]!==event[key]))continue;
    const identity=poolEventProofIdentity(event),old=owners.get(event.eventKey);
    if(old&&old.identity!==identity)conflicts.add(event.eventKey);
    owners.set(event.eventKey,{identity,event});
  }
  const allowed=row=>{
    const event=row?.event||row;if(!fourTracked(event))return true;
    const owner=owners.get(event.eventKey);
    return !!owner&&!conflicts.has(event.eventKey)&&!blocked.has(fourOwnerKey(event))
      &&isStrictFourRegistryTrackedTokenUpdate(event)&&poolEventProofIdentity(event)===owner.identity;
  };
  return {available,allowed,records:records.slice(-512).filter(allowed)};
}

export async function readBoundedJson(file, maximumBytes = 24 * 1024 * 1024) {
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > maximumBytes) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

// Read once per evaluation cycle, never once per candidate. No API or wallet calls.
export async function loadPaperEvidence(dataDir, read = readBoundedJson) {
  const [flowState, fomo, main, secondary, social, gmgnSocial, alphaCatalog, reviewedNews, flapQuote, fourRegistry, launchEvidence,flapCanonical] = await Promise.all([
    read(path.join(dataDir, 'gmgn-flow-state.json')),
    read(path.join(dataDir, 'fomo-alerts', 'alert-outbox.json'), 16 * 1024 * 1024),
    read(path.join(dataDir, 'alert-outbox.json'), 16 * 1024 * 1024),
    read(path.join(dataDir, 'binance-flow-state.json')),
    read(path.join(dataDir, 'fomo-x-call-state.json')),
    read(path.join(dataDir, 'gmgn-social-state.json'), 2 * 1024 * 1024),
    read(path.join(dataDir, 'binance-alpha-catalog.json'), 3 * 1024 * 1024),
    read(path.join(dataDir, 'paper-reviewed-news.json'), 256 * 1024),
    read(path.join(dataDir, 'flap-quote-state.json'), 2 * 1024 * 1024),
    read(path.join(dataDir, 'four-registry-state.json'), 8 * 1024 * 1024),
    read(path.join(dataDir, LAUNCH_EVIDENCE_FILE), LAUNCH_EVIDENCE_MAX_BYTES),
    read(path.join(dataDir,'paper-flap-canonical-state.json'),2*1024*1024),
  ]);
  const pendingPoolBlocks=Number.isSafeInteger(flapQuote?.identity?.verifiedBlock)&&Number.isSafeInteger(flapQuote?.cursor?.nextBlock)
    ? Math.max(0,flapQuote.identity.verifiedBlock-flapQuote.cursor.nextBlock+1):null;
  const externalRows=[...Object.values(fomo?.events||{}),...Object.values(main?.events||{})];
  const fourProjection=canonicalFourProjection(fourRegistry,externalRows);
  const flapOwnership=canonicalFlapProjection(flapCanonical);
  return { flowState, binanceState: validBinanceFlowState(secondary) ? secondary : null,
    gmgnSocial, alphaCatalog,
    poolSourceHealth:flapQuote?{status:flapQuote._health?.status==='healthy'&&pendingPoolBlocks>0?'catching_up':flapQuote._health?.status||'unknown',
      pendingBlocks:pendingPoolBlocks,checkedAt:flapQuote.checkedAt||null,
      lastSuccessAt:flapQuote._health?.lastSuccessAt||null,lastErrorCode:flapQuote._health?.lastErrorCode||null}:null,
    launchSourceHealth:{fourmeme:fourProjection.available?{status:'local_checkpoint',checkedAt:fourRegistry.updatedAt||null,
      lastSuccessAt:fourRegistry.updatedAt||null,note:'本地canonical检查点，不代表全天或实时链头覆盖'}:{status:'unavailable'},
      flapProjection:launchEvidence?.version===LAUNCH_EVIDENCE_VERSION?{status:launchEvidence.coverage?.complete?'available':'partial',
        checkedAt:launchEvidence.updatedAt,dropped:launchEvidence.coverage?.dropped||0}:{status:'unavailable'},
      flapCanonical:{status:flapOwnership.available?'available':flapCanonical?.status==='updating'?'updating':'unavailable',
        checkedAt:flapCanonical?.generatedAt||null},
      mainOutbox:{status:main?'available':'unavailable_or_oversized'}},
    narrativeSourceHealth: social?.health || null,
    events: [...Object.values(fomo?.events || {}).slice(-2000), ...Object.values(main?.events || {}).slice(-3000),
      ...Object.values(social?.narrativeObservations || {}).slice(-2000),
      // Producer-owned canonical records survive TG retry/oversized outboxes.
      // Orphan history is intentionally excluded; every event is validated
      // again by the narrow pool adapter before research or ledger admission.
      ...fourProjection.records,
      ...(launchEvidence?.version===LAUNCH_EVIDENCE_VERSION&&Array.isArray(launchEvidence.events)?launchEvidence.events:[]),
      ...(reviewedNews?.version==='paper_reviewed_news_v1'&&Array.isArray(reviewedNews.events)?reviewedNews.events.slice(-20):[])]
      .filter(fourProjection.allowed).filter(flapOwnership.allowed) };
}

// Fast local ticks stat unchanged files instead of reparsing large outboxes.
// A missing, corrupt or concurrently replaced file invalidates its cached value.
export function createPaperEvidenceLoader(dataDir) {
  const cache = new Map();
  const read = async (file, maximumBytes = 24 * 1024 * 1024) => {
    const identity = s => `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    try {
      const before = await fs.stat(file), key = identity(before);
      if (!before.isFile() || before.size > maximumBytes) throw new Error('invalid evidence file');
      if (cache.get(file)?.key === key) return cache.get(file).value;
      const raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > maximumBytes || identity(await fs.stat(file)) !== key) throw new Error('evidence changed');
      const value = JSON.parse(raw); cache.set(file, { key, value }); return value;
    } catch { cache.delete(file); return null; }
  };
  return () => loadPaperEvidence(dataDir, read);
}

export function buildPaperFlowEvidence({ state, chain, address, nowMs = Date.now(), indexedRows } = {}) {
  const token = gmgnFlowAddress(chain, address), snapshot = state?.chains?.[chain];
  const window = flowWindowCoverage(snapshot, nowMs);
  const observedMs = window.endAt ?? timestamp(snapshot?.lastFeedSuccessAt || snapshot?.lastSuccessAt);
  const recent = Number.isFinite(observedMs) && observedMs <= nowMs + 30_000 && observedMs >= nowMs - 120_000;
  const fresh = recent && (snapshot?.feedCoverage ? window.endAt !== null : ['healthy', 'partial'].includes(snapshot?.status));
  const quarantined = timestamp(snapshot?.quarantinedTokens?.[token]) > nowMs;
  const rebuilding = timestamp(snapshot?.tokenRebuildUntil?.[token]) > nowMs;
  const complete = fresh && window.complete && !quarantined && !rebuilding;
  const rows = indexedRows ?? (Array.isArray(state?.trades?.[chain]) ? state.trades[chain] : []);
  const seen = new Map(), wallets = new Map();
  let conflict = false;
  for (const row of rows) {
    if (!token || row?.chain !== chain || gmgnFlowAddress(chain, row.tokenAddress) !== token) continue;
    const wallet = gmgnFlowAddress(chain, row.wallet), at = timestamp(row.at), amount = row.amountUsd;
    const tags = Array.isArray(row.tags) ? row.tags.filter(x => typeof x === 'string').map(x => x.toLowerCase()) : [];
    if (!wallet || !['buy', 'sell'].includes(row.side) || !Number.isFinite(amount) || amount <= 0
      || !Number.isFinite(at) || at < Math.max(window.startAt ?? 0, nowMs - 300_000) || at > (window.endAt ?? nowMs + 30_000) || tags.some(t => blockedTag.test(t))) continue;
    const hash = typeof row.hash === 'string' ? row.hash : '';
    if (!(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[\da-fA-F]{64}$/).test(hash)) continue;
    const key = `${chain === 'sol' ? hash : hash.toLowerCase()}:${wallet}:${token}`;
    const prior = seen.get(key);
    // Different legs for the same wallet/token/transaction are ambiguous, not extra conviction.
    try { seen.set(key, mergeGmgnFlowTrade(prior, { ...row, wallet, tokenAddress: token, amountUsd: amount, at, tags })); }
    catch { conflict = true; }
  }
  for (const row of seen.values()) {
    const {wallet,tags,amountUsd:amount}=row;
    const item = wallets.get(wallet) || { wallet, buyUsd: 0, sellUsd: 0, tags: new Set() };
    item[row.side === 'buy' ? 'buyUsd' : 'sellUsd'] += amount;
    const timeField=row.side==='buy'?'lastBuyAt':'lastSellAt';
    item[timeField]=Math.max(item[timeField]||0,row.at);
    tags.forEach(tag => item.tags.add(tag)); wallets.set(wallet, item);
  }
  const values = [...wallets.values()].map(item => ({ wallet: item.wallet, buyUsd: item.buyUsd, sellUsd: item.sellUsd,
    lastBuyAt:item.lastBuyAt||null,lastSellAt:item.lastSellAt||null,
    netBuyUsd: item.buyUsd - item.sellUsd, tags: [...item.tags],
    highProfit: qualifiesGmgnFlowWallet(state?.profiles?.[`${chain}:${item.wallet}`], chain, item.wallet, nowMs) }));
  const buyers = values.filter(item => item.netBuyUsd >= 100);
  const sellers = values.filter(item => item.netBuyUsd <= -100);
  const smart = item => item.highProfit || item.tags.some(tag => ['smart_degen', 'smart_money', 'smartmoney'].includes(tag));
  const usable = fresh && !conflict && !quarantined;
  return { chain, address: token, provider: 'gmgn', providerLabel: 'GMGN 聪明钱 / KOL', fomoSupported: true,
    fresh: usable, complete: complete && !conflict, status: usable && complete ? 'healthy' : fresh ? 'partial' : snapshot?.status || 'unavailable',
    observedAt: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : null,
    coverageGap: quarantined ? 'token_quarantined' : conflict ? 'ambiguous_trade_legs' : rebuilding ? 'token_window_rebuilding' : complete ? null : snapshot?.feedCoverage ? window.reason : 'feed_window_unverified',
    sourceStatus: snapshot?.status || 'unavailable', sourceIssue: snapshot?.coverageGap || null,
    walletResearch: snapshot?.walletResearch || null,
    // Scoped normalized proof, separate from chain-wide research warnings.
    // Coverage is still only this public feed window, never the whole chain.
    tokenEvidence: {version:'ca_flow_window_v1',chain,address:token,scope:window.scope,
      status:usable&&complete?'healthy':'unavailable',complete:usable&&complete,
      observedAt:Number.isFinite(observedMs)?new Date(observedMs).toISOString():null},
    evidenceScope: window.scope, windowStartAt: window.startAt === null ? null : new Date(window.startAt).toISOString(),
    windowEndAt: window.endAt === null ? null : new Date(window.endAt).toISOString(),
    highProfitCount: usable ? buyers.filter(item => item.highProfit).length : null,
    profileCheckedCount: usable ? buyers.filter(item => ['7d','30d'].every(period => {
      const at=timestamp(state?.profiles?.[`${chain}:${item.wallet}`]?.[period]?.checkedAt);
      return Number.isFinite(at)&&at<=nowMs+30000&&at>=nowMs-2*3600000;
    })).length : null,
    fomoCount: usable ? buyers.filter(item => item.tags.includes('fomo')).length : null,
    smartMoneyCount: usable ? buyers.filter(smart).length : null,
    smartMoneySellerCount: usable ? sellers.filter(smart).length : null,
    highProfitSellerCount: usable ? sellers.filter(item => item.highProfit).length : null,
    uniqueBuyerCount: usable ? buyers.length : null,
    netBuyUsd: usable ? values.reduce((sum, item) => sum + item.netBuyUsd, 0) : null,
    pulse: usable && complete ? paperFlowPulse([...seen.values()], nowMs) : null,
    scope: 'GMGN 公开聪明钱/KOL 来源流近五分钟；非全链统计', wallets: usable ? values : [] };
}

function paperFlowSources({ state, binanceState, chain, address, nowMs = Date.now(), indexedRows } = {}) {
  return [buildPaperFlowEvidence({ state, chain, address, nowMs, indexedRows: indexedRows?.gmgn }),
    ...BINANCE_FLOW_KINDS.map(kind => buildBinanceFlowEvidence({ state: binanceState, gmgnState: state, chain, address, kind, nowMs, indexedRows: indexedRows?.[kind] }))];
}

export function buildPaperDualFlowEvidence(options = {}) {
  const { address, nowMs = Date.now(), preferredProvider } = options;
  const sources = paperFlowSources({...options, nowMs});
  // Fixed precedence, never choose the highest inflow/profit count or sum
  // providers. A holding stays with its entry cohort for reversal confirmation.
  const usable = source => source.fresh && source.complete && !source.coverageGap;
  const selected = preferredProvider ? sources.find(source => source.provider === preferredProvider) || sources[0]
    : sources.find(source => usable(source) && (!address || source.wallets.length)) || sources.find(usable)
      || sources.find(source => source.fresh && source.wallets.length) || sources.find(source => source.fresh) || sources[0];
  return { ...selected, sources: sources.map(source => ({ provider: source.provider, label: source.providerLabel, status: source.status,
    observedAt: source.observedAt, ageMs: Number.isFinite(timestamp(source.observedAt)) ? nowMs-timestamp(source.observedAt) : null,
    fresh: source.fresh, complete: source.complete, coverageGap: source.coverageGap,
    sourceIssue: source.sourceIssue || null, count: source.count, walletResearch: source.walletResearch || null,
    highProfitCount: source.highProfitCount, profileCheckedCount: source.profileCheckedCount, uniqueBuyerCount: source.uniqueBuyerCount, netBuyUsd: source.netBuyUsd })) };
}

// Rebuilt from each immutable scan input. Avoid N candidates × every feed row
// on both preliminary/final passes, while evaluating all time gates anew.
export function createPaperEvidenceIndex(evidence = {}) {
  const feeds = new Map(), narratives = indexGmgnNarrativeEvents(evidence.events);
  const add = (provider, chain, token, row) => {
    if (!token) return;
    const key = `${chain}:${token}`;
    if (!feeds.has(key)) feeds.set(key, { gmgn: [], smartmoney: [], kol: [] });
    feeds.get(key)[provider].push(row);
  };
  for (const [chain, rows] of Object.entries(evidence.flowState?.trades || {})) {
    for (const row of Array.isArray(rows) ? rows : []) add('gmgn', chain, gmgnFlowAddress(chain, row?.tokenAddress), row);
  }
  for (const [chain, entry] of Object.entries(evidence.binanceState?.chains || {})) {
    for (const kind of BINANCE_FLOW_KINDS) for (const row of entry?.feeds?.[kind]?.rows || [])
      add(kind, chain, row?.tokenAddress, row);
  }
  const empty = { gmgn: [], smartmoney: [], kol: [] };
  const key = ({chain,address}) => `${chain}:${gmgnFlowAddress(chain,address)}`;
  return {
    flow: options => buildPaperDualFlowEvidence({ state:evidence.flowState, binanceState:evidence.binanceState,
      ...options, indexedRows:feeds.get(key(options)) || empty }),
    // Event discovery may inspect independent cohorts without changing the
    // entry/holding provider selection above or adding their amounts together.
    flowSources: options => paperFlowSources({ state:evidence.flowState, binanceState:evidence.binanceState,
      ...options, indexedRows:feeds.get(key(options)) || empty }),
    narrative: options => buildPaperNarrativeEvidence({ ...options, events:narratives.get(key(options)) || [] }),
  };
}

export function buildPaperNarrativeEvidence({ chain, address, token, events = [], nowMs = Date.now() } = {}) {
  const sources = collectGmgnFlowNarratives({ chain, tokenAddress: address, events, nowMs });
  const result = sources[0] || resolveGmgnFlowNarrative({ chain, tokenAddress: address, tokenInfo: token?.raw || token, nowMs });
  const ca = gmgnFlowAddress(chain, address);
  return { ...result, sources, caBound: !!ca && result.status === 'sourced' && result.chain === chain && result.tokenAddress === ca };
}
