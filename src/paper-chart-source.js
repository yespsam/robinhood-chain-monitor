// Source integrity only. Chart freshness, structure, quote and entry thresholds
// remain the responsibility of the existing opportunity/recovery policies.
import { createHash } from 'node:crypto';

export const CHART_SOURCE_VERSION = 'chart_source_provenance_v1';
const MINUTE = 60000;
const NETWORKS = Object.freeze({ bsc:'bsc', sol:'solana', robinhood:'robinhood', base:'base', eth:'eth' });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const stamp = value => typeof value === 'number' ? (value < 1e10 ? value * 1000 : value)
  : typeof value === 'string' ? Date.parse(value) : NaN;
const address = (chain, value) => typeof value === 'string' && (chain === 'sol'
  ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) : /^0x[0-9a-f]{40}$/i.test(value))
  ? chain === 'sol' ? value : value.toLowerCase() : null;
const pool = (chain, value) => typeof value === 'string' && (chain === 'sol'
  ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) : /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value))
  ? chain === 'sol' ? value : value.toLowerCase() : null;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => new Date(value).toISOString();
const fail = reasonCode => ({ ready:false, reasonCode, candles:[], provenance:null });
const candleKeys = new Set(['time','open','high','low','close','volume','source','sourcePoolId']);
const candleValues = rows => rows.map(c => [stamp(c.time),c.open,c.high,c.low,c.close,c.volume]);
const syntheticFlags = ['synthetic','isSynthetic','inferred','forwardFilled','gapFilled','noTrade','noTrades'];
const synthetic = value => syntheticFlags.some(key => value?.[key] != null && value[key] !== false);

export function validateChartSource(chart, token, { nowMs = Date.now() } = {}) {
  if (!finite(nowMs) || chart?.status !== 'ok') return fail('CHART_SOURCE_UNAVAILABLE');
  if (!['gmgn-cli','geckoterminal'].includes(chart.source)) return fail('CHART_SOURCE_UNSUPPORTED');
  const alternative = chart.source === 'geckoterminal';
  if (synthetic(chart) || chart.emptyIntervals === true || chart.inferredBars != null && chart.inferredBars !== 0)
    return fail('CHART_SOURCE_SYNTHETIC');
  const target = address(token?.chain,token?.address);
  if (!NETWORKS[token?.chain] || !target || chart.chain !== token.chain
    || address(token.chain,chart.address ?? chart.tokenAddress) !== target
    || chart.tokenAddress != null && address(token.chain,chart.tokenAddress) !== target)
    return fail('CHART_SOURCE_IDENTITY_MISMATCH');
  const requestedAt = stamp(chart.requestedAt), receivedAt = stamp(chart.receivedAt);
  if (![requestedAt,receivedAt].every(Number.isSafeInteger) || requestedAt < 0
    || receivedAt < requestedAt || receivedAt > nowMs) return fail('CHART_SOURCE_CLOCK_INVALID');
  if (chart.resolution !== '1m' || !Number.isSafeInteger(chart.from) || !Number.isSafeInteger(chart.to)
    || chart.from < 0 || chart.from % 60 || chart.to % 60 || chart.to - chart.from !== 3600
    || !['latest_closed_at_dispatch','fixed_historical'].includes(chart.requestWindow)
    || chart.to * 1000 > requestedAt
    || chart.requestWindow === 'latest_closed_at_dispatch' && chart.to * 1000 !== Math.floor(requestedAt / MINUTE) * MINUTE)
    return fail('CHART_SOURCE_WINDOW_INVALID');
  let identity = {};
  if (alternative) {
    if (chart.emptyIntervals !== false || chart.inferredBars !== 0 || synthetic(chart)) return fail('CHART_SOURCE_SYNTHETIC');
    const binding = chart.binding, poolId = pool(token.chain,chart.poolId);
    if (chart.network !== NETWORKS[token.chain] || !poolId || chart.currency !== 'usd'
      || !['base','quote'].includes(chart.tokenSide) || typeof chart.dexId !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(chart.dexId)
      || binding?.network !== chart.network || pool(token.chain,binding?.poolId) !== poolId)
      return fail('CHART_SOURCE_IDENTITY_MISMATCH');
    const boundTokens = {};
    for (const side of ['base','quote']) {
      const bound = binding[`${side}Token`], tokenAddress = address(token.chain,bound?.address);
      // The OHLCV endpoint supplies USD values, not raw token quantities. The
      // counter-token precision is allowed to remain explicitly unknown; never
      // infer it or use it to rescale these USD prices/volumes.
      const precisionKnown=Number.isSafeInteger(bound?.decimals) && bound.decimals>=0 && bound.decimals<=255;
      if (!tokenAddress || !(precisionKnown || side!==chart.tokenSide && bound?.decimals===null)
        || address(token.chain,chart.ohlcvMeta?.[side]?.address) !== tokenAddress)
        return fail('CHART_SOURCE_IDENTITY_MISMATCH');
      boundTokens[`${side}Token`] = {address:tokenAddress,decimals:bound.decimals};
    }
    if (boundTokens.baseToken.address === boundTokens.quoteToken.address
      || boundTokens[`${chart.tokenSide}Token`].address !== target)
      return fail('CHART_SOURCE_IDENTITY_MISMATCH');
    const metadataRequestedAt = stamp(binding.metadataRequestedAt), metadataReceivedAt = stamp(binding.metadataReceivedAt);
    if (![metadataRequestedAt,metadataReceivedAt].every(Number.isSafeInteger) || metadataRequestedAt < 0
      || metadataReceivedAt < metadataRequestedAt || metadataReceivedAt > requestedAt)
      return fail('CHART_SOURCE_CLOCK_INVALID');
    identity = {network:chart.network,tokenAddress:target,poolId,dexId:chart.dexId,
      tokenSide:chart.tokenSide,currency:'usd',emptyIntervals:false,inferredBars:0,
      binding:{network:chart.network,poolId,...boundTokens,
        metadataRequestedAt:iso(metadataRequestedAt),metadataReceivedAt:iso(metadataReceivedAt)},
      ohlcvMeta:{base:{address:boundTokens.baseToken.address},quote:{address:boundTokens.quoteToken.address}}};
  }
  if (!Array.isArray(chart.candles) || !chart.candles.length || chart.candles.length > 1000)
    return fail('CHART_SOURCE_EMPTY');
  const times = new Set(), rows = [];
  let excludedUnclosedBars = 0, excludedOutOfWindowBars = 0;
  for (const candle of chart.candles) {
    if (!candle || typeof candle !== 'object' || Array.isArray(candle)) return fail('CHART_SOURCE_INVALID_CANDLE');
    if (synthetic(candle)) return fail('CHART_SOURCE_SYNTHETIC');
    if (alternative) {
      if (Object.keys(candle).some(key => !candleKeys.has(key))) return fail('CHART_SOURCE_INVALID_CANDLE');
      if (candle.source != null && candle.source !== 'geckoterminal'
        || candle.sourcePoolId != null && pool(token.chain,candle.sourcePoolId) !== identity.poolId)
        return fail('CHART_SOURCE_MIXED');
    } else if (candle.sourcePoolId != null || candle.source != null && !['','gmgn-cli'].includes(candle.source))
      return fail('CHART_SOURCE_MIXED');
    const at = stamp(candle.time);
    if (!Number.isSafeInteger(at) || at < 0 || at % MINUTE
      || ![candle.open,candle.high,candle.low,candle.close].every(value => finite(value) && value > 0)
      || !finite(candle.volume) || candle.volume < 0
      || candle.high < Math.max(candle.open,candle.close,candle.low) || candle.low > Math.min(candle.open,candle.close))
      return fail('CHART_SOURCE_INVALID_CANDLE');
    if (times.has(at)) return fail('CHART_SOURCE_DUPLICATE_TIME');
    times.add(at);
    if (at + MINUTE > chart.to * 1000) { excludedUnclosedBars++; continue; }
    if (at < chart.from * 1000) { excludedOutOfWindowBars++; continue; }
    if (alternative && candle.volume === 0) return fail('CHART_SOURCE_NO_TRADE_BAR');
    rows.push({time:at,open:candle.open,high:candle.high,low:candle.low,close:candle.close,volume:candle.volume,
      ...(alternative ? {source:'geckoterminal',sourcePoolId:identity.poolId} : {})});
  }
  rows.sort((a,b) => a.time - b.time);
  if (!rows.length) return fail('CHART_SOURCE_EMPTY');
  const provenance = {version:CHART_SOURCE_VERSION,source:chart.source,chain:token.chain,address:target,
    resolution:'1m',from:chart.from,to:chart.to,requestWindow:chart.requestWindow,
    requestedAt:iso(requestedAt),receivedAt:iso(receivedAt),...identity,
    barCount:rows.length,candleDigest:digest(candleValues(rows))};
  provenance.sourceDigest = digest(provenance);
  return {ready:true,reasonCode:null,candles:rows,provenance,excludedUnclosedBars,excludedOutOfWindowBars};
}

// Legacy GMGN proofs carry no provider envelope. Preserve those proofs while
// requiring any newly marked alternative-source series to retain its binding.
export function validateChartProvenance(provenance, token, candles, {nowMs = Date.now()} = {}) {
  if (provenance == null) {
    if (Array.isArray(candles) && candles.some(synthetic)) return fail('CHART_SOURCE_SYNTHETIC');
    return Array.isArray(candles) && candles.some(c => c?.source === 'geckoterminal' || c?.sourcePoolId != null)
      ? fail('CHART_PROVENANCE_REQUIRED') : {ready:true,reasonCode:null,legacy:true,provenance:null};
  }
  if (provenance.version !== CHART_SOURCE_VERSION) return fail('CHART_PROVENANCE_MISMATCH');
  const checked = validateChartSource({...provenance,status:'ok',candles},token,{nowMs});
  if (!checked.ready) return checked;
  if (provenance.barCount !== checked.provenance.barCount || provenance.candleDigest !== checked.provenance.candleDigest
    || provenance.sourceDigest !== checked.provenance.sourceDigest
    || checked.excludedUnclosedBars || checked.excludedOutOfWindowBars)
    return fail('CHART_PROVENANCE_MISMATCH');
  return {ready:true,reasonCode:null,legacy:false,provenance:checked.provenance};
}
