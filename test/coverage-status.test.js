import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageAge, marketCoverageStatus, flowCoverageStatus, tradingDataHealth } from '../dashboard/coverage-status.js';
const now = Date.parse('2026-09-22T08:30:00Z'), iso = ms => new Date(ms).toISOString();
const quote = age => ({ status: 'ok', observedAt: iso(now - age) });
test('a connected engine cannot show healthy while all upstream data is stale', () => {
  const feed = { market: quote(1000), trenches: quote(1000), flow: { ...quote(1000), complete: true, fresh: true } };
  const state = { status: 'ok', chains: ['sol', 'base'], chainCoverage: { sol: feed, base: structuredClone(feed) } };
  assert.equal(tradingDataHealth(state, now).status, 'ok');
  state.chainCoverage.base.flow.complete = false;
  assert.equal(tradingDataHealth(state, now).status, 'degraded');
  state.chainCoverage.sol.market = quote(120001); state.chainCoverage.sol.trenches = quote(120001);
  const health = tradingDataHealth(state, now);
  assert.equal(health.status, 'blocked'); assert.equal(health.ready, 0); assert.match(health.label, /暂不能开仓/);
  assert.equal(tradingDataHealth(null, now).status, 'blocked');
});
test('market coverage follows actual evidence time even if cached upstream status remains ok', () => {
  assert.equal(marketCoverageStatus(quote(120000), now).fresh, true);
  const old = marketCoverageStatus(quote(120001), now);
  assert.equal(old.fresh, false); assert.match(old.label, /已过期/);
  assert.equal(marketCoverageStatus({ ...quote(1000), status: 'stale' }, now).fresh, false);
});
test('fresh external evidence cannot make an expired internal snapshot look current, or vice versa', () => {
  const external = marketCoverageStatus(quote(1000), now), internal = marketCoverageStatus(quote(160000), now);
  assert.match(external.label, /新鲜/); assert.match(internal.label, /已过期/);
  assert.equal(external.fresh && internal.fresh, false);
});
test('missing, malformed and future timestamps never appear fresh', () => {
  for (const observedAt of [null, '', 'not-a-date', iso(now + 1)]) {
    assert.equal(coverageAge({ observedAt }, now), null);
    assert.equal(marketCoverageStatus({ status: 'ok', observedAt }, now).fresh, false);
    assert.equal(flowCoverageStatus({ status: 'healthy', complete: true, observedAt }, now).fresh, false);
  }
});
test('flow coverage requires a fresh healthy complete source, not just a persisted complete flag', () => {
  const feed = { ...quote(1000), status: 'healthy', complete: true, fresh: true };
  assert.equal(flowCoverageStatus(feed, now).fresh, true);
  assert.match(flowCoverageStatus(feed, now).label, /非全链/);
  for (const changes of [{ status: 'partial' }, { fresh: false }, { complete: false }, { coverageGap: 'gap' }, { observedAt: iso(now - 120001) }]) {
    assert.equal(flowCoverageStatus({ ...feed, ...changes }, now).fresh, false);
  }
});
