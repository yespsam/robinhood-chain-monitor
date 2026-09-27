import fs from 'node:fs/promises';
import path from 'node:path';
import { gmgnFlowAddress, qualifiesGmgnFlowWallet, mergeGmgnFlowTrade } from './gmgn-flow-signal.js';
import { flowWindowCoverage } from './gmgn-flow-coverage.js';
import { collectGmgnFlowNarratives, resolveGmgnFlowNarrative, indexGmgnNarrativeEvents } from './gmgn-flow-narrative.js';
import { BINANCE_FLOW_KINDS, buildBinanceFlowEvidence, validBinanceFlowState } from './binance-flow-evidence.js';
import { paperFlowPulse } from './paper-flow-pulse.js';

const blockedTag = /(?:^|[_-])(?:wash(?:[_-]?trader)?|arbitrager|arbitrage|mev(?:[_-]?bot)?|sandwich|router|cex|exchange|contract)(?:$|[_-])/i;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value || '');

export async function readBoundedJson(file, maximumBytes = 24 * 1024 * 1024) {
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > maximumBytes) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

// Read once per evaluation cycle, never once per candidate. No API or wallet calls.
export async function loadPaperEvidence(dataDir, read = readBoundedJson) {
  const [flowState, fomo, main, secondary, social, gmgnSocial, alphaCatalog, reviewedNews] = await Promise.all([
    read(path.join(dataDir, 'gmgn-flow-state.json')),
    read(path.join(dataDir, 'fomo-alerts', 'alert-outbox.json'), 16 * 1024 * 1024),
    read(path.join(dataDir, 'alert-outbox.json'), 16 * 1024 * 1024),
    read(path.join(dataDir, 'binance-flow-state.json')),
    read(path.join(dataDir, 'fomo-x-call-state.json')),
    read(path.join(dataDir, 'gmgn-social-state.json'), 2 * 1024 * 1024),
    read(path.join(dataDir, 'binance-alpha-catalog.json'), 3 * 1024 * 1024),
    read(path.join(dataDir, 'paper-reviewed-news.json'), 256 * 1024),
  ]);
  return { flowState, binanceState: validBinanceFlowState(secondary) ? secondary : null,
    gmgnSocial, alphaCatalog,
    narrativeSourceHealth: social?.health || null,
    events: [...Object.values(fomo?.events || {}).slice(-2000), ...Object.values(main?.events || {}).slice(-3000),
      ...Object.values(social?.narrativeObservations || {}).slice(-2000),
      ...(reviewedNews?.version==='paper_reviewed_news_v1'&&Array.isArray(reviewedNews.events)?reviewedNews.events.slice(-20):[])] };
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

export function buildPaperDualFlowEvidence({ state, binanceState, chain, address, nowMs = Date.now(), preferredProvider, indexedRows } = {}) {
  const sources = [buildPaperFlowEvidence({ state, chain, address, nowMs, indexedRows: indexedRows?.gmgn }),
    ...BINANCE_FLOW_KINDS.map(kind => buildBinanceFlowEvidence({ state: binanceState, gmgnState: state, chain, address, kind, nowMs, indexedRows: indexedRows?.[kind] }))];
  // Fixed precedence, never choose the highest inflow/profit count or sum
  // providers. A holding stays with its entry cohort for reversal confirmation.
  const usable = source => source.fresh && source.complete && !source.coverageGap;
  const selected = preferredProvider ? sources.find(source => source.provider === preferredProvider) || sources[0]
    : sources.find(source => usable(source) && (!address || source.wallets.length)) || sources.find(usable)
      || sources.find(source => source.fresh && source.wallets.length) || sources.find(source => source.fresh) || sources[0];
  return { ...selected, sources: sources.map(source => ({ provider: source.provider, label: source.providerLabel, status: source.status,
    observedAt: source.observedAt, ageMs: Number.isFinite(timestamp(source.observedAt)) ? nowMs-timestamp(source.observedAt) : null,
    fresh: source.fresh, complete: source.complete, coverageGap: source.coverageGap,
    sourceIssue: source.sourceIssue || null, count: source.count,
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
    narrative: options => buildPaperNarrativeEvidence({ ...options, events:narratives.get(key(options)) || [] }),
  };
}

export function buildPaperNarrativeEvidence({ chain, address, token, events = [], nowMs = Date.now() } = {}) {
  const sources = collectGmgnFlowNarratives({ chain, tokenAddress: address, events, nowMs });
  const result = sources[0] || resolveGmgnFlowNarrative({ chain, tokenAddress: address, tokenInfo: token?.raw || token, nowMs });
  const ca = gmgnFlowAddress(chain, address);
  return { ...result, sources, caBound: !!ca && result.status === 'sourced' && result.chain === chain && result.tokenAddress === ca };
}
