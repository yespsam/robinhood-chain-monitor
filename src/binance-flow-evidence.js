import { gmgnFlowAddress, qualifiesGmgnFlowWallet } from './gmgn-flow-signal.js';
import { paperFlowPulse } from './paper-flow-pulse.js';

export const BINANCE_FLOW_CHAINS = Object.freeze({ robinhood: '4663', sol: 'CT_501', bsc: '56', base: '8453', eth: '1' });
export const BINANCE_FLOW_KINDS = Object.freeze(['smartmoney', 'kol']);
export const BINANCE_FLOW_SCHEMA = 'yesp_binance_readonly_flow_v1';
const WINDOW = 300_000, MAX_ROWS = 4000, MAX_GAP = 90_000;
const finite = v => ['string', 'number'].includes(typeof v) && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const hashValid = (chain, hash) => typeof hash === 'string' && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[\da-fA-F]{64}$/).test(hash);
const label = kind => kind === 'smartmoney' ? '币安聪明钱' : '币安 KOL';
export const binanceFlowProvider = kind => `binance_${kind}`;
const id = row => `${row.chain}:${row.hash}:${row.logId}`;

export function normalizeBinanceFlowRow(row, chain, kind, nowMs) {
  const wallet = gmgnFlowAddress(chain, row?.address), tokenAddress = gmgnFlowAddress(chain, row?.ca);
  const seconds = finite(row?.ts), amountUsd = finite(row?.txUsdValue);
  if (!BINANCE_FLOW_KINDS.includes(kind) || !wallet || !tokenAddress || String(row?.chainId) !== BINANCE_FLOW_CHAINS[chain]
    || !hashValid(chain, row?.txHash) || typeof row.logId !== 'string' || !/^\d{1,40}$/.test(row.logId)
    || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1000 > nowMs + 30_000) throw new Error('binance_record_invalid');
  const side = [11, 19].includes(row.tradeSideCategory) ? 'buy' : [21, 29].includes(row.tradeSideCategory) ? 'sell' : 'unknown';
  return { chain, wallet, tokenAddress, hash: chain === 'sol' ? row.txHash : row.txHash.toLowerCase(), logId: row.logId,
    at: seconds * 1000, side: amountUsd === null || amountUsd <= 0 ? 'unknown' : side, amountUsd: amountUsd !== null && amountUsd > 0 ? amountUsd : null,
    tags: kind === 'smartmoney' ? ['binance_smart_money'] : ['binance_kol'], symbol: typeof row.tokenName === 'string' ? row.tokenName.slice(0, 60) : '' };
}

// A source snapshot is not a full-chain ledger. Require a local five-minute
// continuous capture session, and preserve the provider/cohort as its scope.
export function advanceBinanceFlowFeed(previous, payload, chain, kind, requestedAt, receivedAt) {
  if (payload?.code !== '000000' || payload?.success === false || !Array.isArray(payload.data) || payload.data.length > 1000) throw new Error('binance_response_invalid');
  const incoming = payload.data.map(row => normalizeBinanceFlowRow(row, chain, kind, receivedAt));
  const keys = incoming.map(id), times = incoming.map(row => row.at), oldest = times.length ? Math.min(...times) : null;
  const prior = previous?.coverage;
  const contiguous = prior?.valid === true && requestedAt >= prior.receivedAt && requestedAt - prior.receivedAt <= MAX_GAP
    && (keys.some(key => prior.keys.includes(key)) || oldest !== null && oldest < prior.endAt || !keys.length && !prior.keys.length);
  // Restart, long gap or disjoint page must warm. A failed poll is unusable
  // until a successful page proves continuity against the last good page.
  // Do not backdate coverage based only on the oldest returned trade.
  const startAt = contiguous ? prior.startAt : requestedAt;
  const coverage = { valid: true, startAt, endAt: requestedAt - 10_000, receivedAt,
    keys, count: incoming.length, seenNonempty: incoming.length > 0 || contiguous && prior.seenNonempty === true,
    samples: contiguous ? (prior.samples || 1) + 1 : 1 };
  const issues = Object.fromEntries(Object.entries(previous?.issues || {}).filter(([, until]) => until >= receivedAt));
  const map = new Map((previous?.rows || []).filter(row => row.at >= receivedAt - 2 * WINDOW).map(row => [id(row), row]));
  for (const row of incoming) {
    if (row.at < receivedAt - 2 * WINDOW) continue;
    const priorRow = map.get(id(row));
    if (row.side === 'unknown') issues[row.tokenAddress] = Math.max(issues[row.tokenAddress] || 0, row.at + WINDOW + MAX_GAP);
    if (priorRow && ['wallet', 'tokenAddress', 'side', 'at'].some(key => row[key] !== priorRow[key])) {
      for (const token of [row.tokenAddress, priorRow.tokenAddress]) issues[token] = receivedAt + WINDOW + MAX_GAP;
      map.delete(id(row)); continue;
    }
    // Same chain/hash/logId is one event even when USD valuations are revised.
    // Retain the conservative bound; never sum copies or dynamic prices.
    if (priorRow && row.side !== 'unknown') {
      row.amountUsd = row.side === 'buy' ? Math.min(priorRow.amountUsd, row.amountUsd) : Math.max(priorRow.amountUsd, row.amountUsd);
    }
    map.set(id(row), row);
  }
  const ordered = [...map.values()].sort((a, b) => a.at - b.at), discarded = ordered.slice(0, Math.max(0, ordered.length - MAX_ROWS));
  const discardedThroughAt = Math.max(previous?.discardedThroughAt || 0, ...discarded.map(row => row.at));
  return { status: 'ok', checkedAt: receivedAt, lastError: null, coverage, rows: ordered.slice(-MAX_ROWS), issues, discardedThroughAt };
}

export function binanceFeedCoverage(feed, nowMs = Date.now()) {
  const c = feed?.coverage;
  const fresh = feed?.status === 'ok' && c?.valid === true && Number.isFinite(c.receivedAt) && c.receivedAt <= nowMs + 30_000
    && c.receivedAt >= nowMs - MAX_GAP && Number.isFinite(c.endAt) && c.endAt <= c.receivedAt && c.endAt >= nowMs - 120_000;
  const startAt = fresh ? c.endAt - WINDOW : null, endAt = fresh ? c.endAt : null;
  const complete = fresh && c.seenNonempty === true && c.samples >= 2 && Number.isFinite(c.startAt) && c.startAt <= startAt
    && !(Number(feed.discardedThroughAt || 0) >= startAt);
  const coverageGap = complete ? null : feed?.lastError || (!fresh ? 'binance_flow_stale' : !c.seenNonempty ? 'binance_no_verified_feed' : 'binance_window_warming_or_gap');
  return { fresh, complete, startAt, endAt, coverageGap };
}

export function validBinanceFlowState(state) {
  if (state?.schema !== BINANCE_FLOW_SCHEMA || state.mode !== 'readonly' || !state.chains || typeof state.chains !== 'object' || Array.isArray(state.chains)
    || !Number.isFinite(state.updatedAt) || !Number.isSafeInteger(state.nextChainIndex) || state.nextChainIndex < 0 || state.nextChainIndex >= 5
    || !Number.isFinite(state.cooldownUntil) || state.cooldownUntil < 0
    || state.focusChainIndex!==undefined&&(!Number.isSafeInteger(state.focusChainIndex)||state.focusChainIndex<0||state.focusChainIndex>=9)) return false;
  return Object.entries(state.chains).every(([chain, value]) => Object.hasOwn(BINANCE_FLOW_CHAINS, chain) && value?.feeds
    && Object.entries(value.feeds).every(([kind, feed]) => BINANCE_FLOW_KINDS.includes(kind) && Array.isArray(feed?.rows) && feed.rows.length <= MAX_ROWS
      && ['ok', 'warming', 'backoff'].includes(feed.status) && Number.isFinite(feed.checkedAt)
      && (feed.nextAttemptAt === undefined || Number.isFinite(feed.nextAttemptAt))
      && (feed.discardedThroughAt === undefined || Number.isFinite(feed.discardedThroughAt) && feed.discardedThroughAt >= 0)
      && new Set(feed.rows.map(id)).size === feed.rows.length
      && feed.rows.every(row => row.chain === chain && gmgnFlowAddress(chain, row.wallet) === row.wallet && gmgnFlowAddress(chain, row.tokenAddress) === row.tokenAddress
        && hashValid(chain, row.hash) && /^\d{1,40}$/.test(row.logId) && Number.isSafeInteger(row.at) && row.at > 0
        && ['buy', 'sell', 'unknown'].includes(row.side) && (row.side === 'unknown' || Number.isFinite(row.amountUsd) && row.amountUsd > 0))
      && feed.issues && Object.keys(feed.issues).length <= 8000 && Object.entries(feed.issues).every(([token, until]) => gmgnFlowAddress(chain, token) === token && Number.isFinite(until))
      && (!feed.coverage || feed.coverage.valid === true && Number.isFinite(feed.coverage.startAt) && feed.coverage.startAt > 0
        && Number.isFinite(feed.coverage.endAt) && Number.isFinite(feed.coverage.receivedAt) && feed.coverage.endAt <= feed.coverage.receivedAt
        && Number.isSafeInteger(feed.coverage.samples) && feed.coverage.samples > 0 && typeof feed.coverage.seenNonempty === 'boolean'
        && Array.isArray(feed.coverage.keys) && feed.coverage.keys.length <= 1000 && feed.coverage.keys.every(key => typeof key === 'string' && key.length <= 250))));
}

export function buildBinanceFlowEvidence({ state, gmgnState, chain, address, kind, nowMs = Date.now(), indexedRows }) {
  const token = gmgnFlowAddress(chain, address), provider = binanceFlowProvider(kind);
  const feed = state?.schema === BINANCE_FLOW_SCHEMA && state.mode === 'readonly' ? state.chains?.[chain]?.feeds?.[kind] : null;
  const coverage = binanceFeedCoverage(feed, nowMs), wallets = new Map(), tokenRows = [];
  const issue = token && feed?.issues?.[token] >= (coverage.startAt ?? nowMs);
  for (const row of indexedRows ?? feed?.rows ?? []) {
    if (!coverage.fresh || issue || row.chain !== chain || row.tokenAddress !== token || !['buy', 'sell'].includes(row.side)
      || row.at < Math.max(coverage.startAt, nowMs - WINDOW) || row.at > coverage.endAt) continue;
    const item = wallets.get(row.wallet) || { wallet: row.wallet, buyUsd: 0, sellUsd: 0 };
    tokenRows.push(row);
    item[row.side === 'buy' ? 'buyUsd' : 'sellUsd'] += row.amountUsd;
    const timeField=row.side==='buy'?'lastBuyAt':'lastSellAt';
    item[timeField]=Math.max(item[timeField]||0,row.at);wallets.set(row.wallet, item);
  }
  const values = [...wallets.values()].map(row => ({ ...row, netBuyUsd: row.buyUsd - row.sellUsd,
    highProfit: qualifiesGmgnFlowWallet(gmgnState?.profiles?.[`${chain}:${row.wallet}`], chain, row.wallet, nowMs) }));
  const buyers = values.filter(row => row.netBuyUsd >= 100), sellers = values.filter(row => row.netBuyUsd <= -100);
  const smart = row => kind === 'smartmoney' || row.highProfit;
  const usable = coverage.fresh && !issue, complete = usable && coverage.complete;
  return { chain, address: token, provider, providerLabel: label(kind), fresh: usable, complete, status: complete ? 'healthy' : coverage.fresh ? 'partial' : 'unavailable',
    observedAt: coverage.endAt === null ? null : new Date(coverage.endAt).toISOString(),
    coverageGap: issue ? 'binance_token_record_unverified' : coverage.coverageGap,
    scope: `${label(kind)}公开逐笔流近五分钟；GMGN 盈利画像；非全链统计`, evidenceScope: `${provider}_5m`,
    windowStartAt: coverage.startAt === null ? null : new Date(coverage.startAt).toISOString(), windowEndAt: coverage.endAt === null ? null : new Date(coverage.endAt).toISOString(),
    highProfitCount: usable ? buyers.filter(row => row.highProfit).length : null,
    profileCheckedCount: usable ? buyers.filter(row => ['7d', '30d'].every(period => {
      const profile = gmgnState?.profiles?.[`${chain}:${row.wallet}`]?.[period], at = Date.parse(profile?.checkedAt || '');
      return profile?.chain === chain && profile.wallet === row.wallet && Number.isFinite(at) && at <= nowMs + 30_000 && at >= nowMs - 7_200_000;
    })).length : null,
    fomoCount: null, fomoSupported: false,
    uniqueBuyerCount: usable ? buyers.length : null, netBuyUsd: usable ? values.reduce((sum, row) => sum + row.netBuyUsd, 0) : null,
    smartMoneyCount: usable ? buyers.filter(smart).length : null, smartMoneySellerCount: usable ? sellers.filter(smart).length : null,
    highProfitSellerCount: usable ? sellers.filter(row => row.highProfit).length : null,
    pulse: complete ? paperFlowPulse(tokenRows, nowMs) : null,
    count: feed?.rows?.length || 0, wallets: usable ? values : [] };
}

// Research queue only: these records never alter GMGN flow counts or alerts.
export function binanceProfileCandidates(state, chain, nowMs = Date.now()) {
  if (!validBinanceFlowState(state)) return [];
  const groups = [];
  for (const kind of BINANCE_FLOW_KINDS) {
    const feed = state.chains[chain]?.feeds?.[kind];
    if (!binanceFeedCoverage(feed, nowMs).fresh) continue;
    const tokens = new Set(feed.rows.filter(row => row.at >= nowMs - WINDOW).map(row => row.tokenAddress));
    for (const address of tokens) {
      const evidence = buildBinanceFlowEvidence({ state, chain, address, kind, nowMs });
      if (evidence.fresh && evidence.uniqueBuyerCount >= 4 && evidence.netBuyUsd >= 1000) groups.push(evidence);
    }
  }
  return [...new Set(groups.sort((a, b) => b.uniqueBuyerCount - a.uniqueBuyerCount).flatMap(group => group.wallets.filter(row => row.netBuyUsd >= 100).map(row => row.wallet)))].slice(0, 80);
}
