// Presentation only: never renew timestamps or change trading eligibility.
export function coverageAge(snapshot, now = Date.now()) {
  const at = Date.parse(snapshot?.observedAt || '');
  return Number.isFinite(at) && Number.isFinite(now) && at <= now ? now - at : null;
}

export function marketCoverageStatus(snapshot, now = Date.now()) {
  const ageMs = coverageAge(snapshot, now);
  const fresh = snapshot?.status === 'ok' && ageMs !== null && ageMs <= 120000;
  const age = ageMs === null ? '' : `（${Math.floor(ageMs / 1000)} 秒前）`;
  const label = fresh ? `新鲜${age}` : ageMs > 120000 ? `已过期${age}`
    : snapshot?.observedAt && ageMs === null ? '时间戳异常'
      : snapshot?.status === 'stale' ? `上次快照${age}` : '等待新鲜数据';
  return { fresh, ageMs, label };
}

export function flowCoverageStatus(snapshot, now = Date.now()) {
  const ageMs = coverageAge(snapshot, now);
  const fresh = ['ok', 'healthy'].includes(snapshot?.status) && snapshot?.fresh !== false && snapshot?.complete === true
    && !snapshot?.coverageGap && ageMs !== null && ageMs <= 120000;
  return { fresh, ageMs, label: fresh ? '来源窗口已接齐（非全链）' : ageMs > 120000 ? '资金流已过期'
    : snapshot?.observedAt && ageMs === null ? '资金流时间戳异常' : null };
}

// A healthy local process is not evidence that its upstream feeds are usable.
export function tradingDataHealth(state, now = Date.now()) {
  const chains = state?.chains || [];
  const rows = chains.map(chain => {
    const feed = state.chainCoverage?.[chain] || {};
    const marketFresh = marketCoverageStatus(feed.market, now).fresh || marketCoverageStatus(feed.trenches, now).fresh;
    const flowFresh = flowCoverageStatus(feed.flow, now).fresh;
    return { chain, marketFresh, flowFresh, ready: marketFresh && flowFresh };
  });
  const ready = rows.filter(row => row.ready).length;
  return { status: ready === 0 ? 'blocked' : ready < chains.length ? 'degraded' : 'ok', ready, total: chains.length,
    label: ready === 0 ? '上游数据未就绪 · 暂不能开仓' : `${ready}/${chains.length} 链数据就绪`,
    summary: `${rows.filter(row => row.marketFresh).length}/${chains.length} 链有新鲜行情，${rows.filter(row => row.flowFresh).length}/${chains.length} 链资金流窗口完整。数据就绪不等于满足买点；采集和持仓退出检查持续运行。` };
}
