// Presentation only: never renew timestamps or change trading eligibility.
const MAX_FEED_AGE_MS = 120000;
export function coverageAge(snapshot, now = Date.now()) {
  const at = Date.parse(snapshot?.observedAt || '');
  return Number.isFinite(at) && Number.isFinite(now) && at <= now ? now - at : null;
}

export function marketCoverageStatus(snapshot, now = Date.now()) {
  const ageMs = coverageAge(snapshot, now);
  const parsedAt = Date.parse(snapshot?.observedAt || '');
  const timestampPresent = Boolean(snapshot?.observedAt);
  const fresh = snapshot?.status === 'ok' && ageMs !== null && ageMs <= MAX_FEED_AGE_MS;
  const status = fresh ? 'fresh'
    : snapshot?.status === 'loading' && !timestampPresent ? 'waiting'
      : !timestampPresent ? 'unverified'
        : !Number.isFinite(parsedAt) || parsedAt > now ? 'invalid_timestamp'
          : ageMs > MAX_FEED_AGE_MS || snapshot?.status === 'stale' ? 'stale'
            : 'degraded';
  const age = ageMs === null ? '' : `（${Math.floor(ageMs / 1000)} 秒前）`;
  const label = status === 'waiting' ? '启动后等待首次采集' : fresh ? `新鲜${age}` : status === 'stale' ? `已过期${age}`
    : snapshot?.observedAt && ageMs === null ? '时间戳异常'
      : snapshot?.status === 'stale' ? `上次快照${age}` : '等待新鲜数据';
  return { status, fresh, ageMs, observedAt: Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : null, label };
}

export function flowCoverageStatus(snapshot, now = Date.now()) {
  const ageMs = coverageAge(snapshot, now);
  const parsedAt = Date.parse(snapshot?.observedAt || '');
  const timestampPresent = Boolean(snapshot?.observedAt);
  const timestampValid = Number.isFinite(parsedAt) && parsedAt <= now;
  const complete = ['ok', 'healthy'].includes(snapshot?.status) && snapshot?.fresh !== false && snapshot?.complete === true && !snapshot?.coverageGap;
  const fresh = complete && ageMs !== null && ageMs <= MAX_FEED_AGE_MS;
  const status = fresh ? 'fresh'
    : !timestampPresent ? 'unverified'
      : !timestampValid ? 'invalid_timestamp'
        : ageMs > MAX_FEED_AGE_MS ? 'stale'
          : !['ok', 'healthy'].includes(snapshot?.status) ? 'degraded'
            : 'partial';
  const label = fresh ? '来源窗口已接齐（非全链）' : status === 'stale' ? '资金流已过期'
    : status === 'invalid_timestamp' ? '资金流时间戳异常' : status === 'partial' ? '资金流窗口不完整' : null;
  return { status, fresh, ageMs, observedAt: Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : null, label };
}

function marketStatusForChain(feed, now) {
  const sources = [marketCoverageStatus(feed?.market, now), marketCoverageStatus(feed?.trenches, now)];
  const freshest = sources.filter(source => source.fresh).sort((a, b) => a.ageMs - b.ageMs)[0];
  if (freshest) return freshest;
  const priority = ['stale', 'degraded', 'invalid_timestamp', 'waiting', 'unverified'];
  return sources.find(source => priority.includes(source.status)) || sources[0];
}

function aggregateFreshness(rows, statusKey, ageKey) {
  const counts = Object.fromEntries(['fresh', 'stale', 'degraded', 'partial', 'waiting', 'invalid_timestamp', 'unverified']
    .map(status => [status, rows.filter(row => row[statusKey] === status).length]));
  const status = rows.length === 0 ? 'unverified'
    : counts.fresh === rows.length ? 'fresh'
      : counts.fresh > 0 ? 'partial'
        : counts.stale === rows.length ? 'stale'
          : counts.degraded > 0 || counts.invalid_timestamp > 0 ? 'degraded'
            : counts.partial > 0 ? 'partial'
              : counts.waiting > 0 ? 'waiting' : 'unverified';
  const ages = rows.map(row => row[ageKey]).filter(Number.isFinite);
  return { status, total: rows.length, ...counts, oldestAgeMs: ages.length ? Math.max(...ages) : null };
}

// A healthy local process is not evidence that its upstream feeds are usable.
export function tradingDataHealth(state, now = Date.now()) {
  const chains = state?.scanScope?.scanChains || state?.chains || [];
  const rows = chains.map(chain => {
    const feed = state.chainCoverage?.[chain] || {};
    const market = marketStatusForChain(feed, now);
    const flow = flowCoverageStatus(feed.flow, now);
    return { chain, marketFresh: market.fresh, marketStatus: market.status, marketAgeMs: market.ageMs,
      marketObservedAt: market.observedAt, flowFresh: flow.fresh, flowStatus: flow.status, flowAgeMs: flow.ageMs,
      flowObservedAt: flow.observedAt, ready: market.fresh && flow.fresh };
  });
  const ready = rows.filter(row => row.ready).length;
  const marketData = aggregateFreshness(rows, 'marketStatus', 'marketAgeMs');
  const flowData = aggregateFreshness(rows, 'flowStatus', 'flowAgeMs');
  return { status: ready === 0 ? 'blocked' : ready < chains.length ? 'degraded' : 'ok', ready, total: chains.length,
    marketData, flowData, chains: rows,
    label: ready === 0 ? '上游数据未就绪 · 暂不能开仓' : `${ready}/${chains.length} 链数据就绪`,
    summary: `${marketData.fresh}/${chains.length} 链有新鲜行情（${marketData.status}），${flowData.fresh}/${chains.length} 链资金流窗口完整（${flowData.status}）。此项只反映数据覆盖，不判断有没有交易机会；数据就绪也不等于满足买点。采集和持仓退出检查持续运行。` };
}
