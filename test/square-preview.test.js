import assert from 'node:assert/strict';
import test from 'node:test';
import { createSquarePreview, renderSquareBuyPreview } from '../src/square-preview.js';
import { createPaperStrategyAccount, evaluatePaperStrategies, advancePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { createDashboardServer } from '../scripts/dashboard-server.js';
import { breakoutCandles } from './fixtures/paper-strategy-v2.js';

const NOW = Date.parse('2026-09-22T00:00:00Z');
const CA = `0x${'b'.repeat(40)}`;
const iso = time => new Date(time).toISOString();
const snapshot = (account = createPaperStrategyAccount({ nowMs: NOW }), nowMs = NOW) => ({ status: 'ok', mode: 'paper', execution: false, signing: false, broadcast: false, enabled: true, updatedAt: iso(nowMs), account });
function buy() {
  const evaluations = evaluatePaperStrategies({
    nowMs: NOW, marketStatus: 'ok', observedAt: iso(NOW), klineStatus: 'ok',
    token: { chain: 'robinhood', address: CA, symbol: '测试币', marketStage: 'internal', price: 1, liquidity: 60_000, volume: 10_000, volumeWindow: '1m', isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0 },
    flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(NOW), highProfitCount: 6, fomoCount: 3, uniqueBuyerCount: 10, smartMoneyCount: 4, netBuyUsd: 6_000 },
    narrative: { status: 'sourced', caBound: true, chain: 'robinhood', address: CA, sourceAt: iso(NOW), sourceUrl: 'https://example.org/announcement', text: '测试来源宣布该合约对应的新功能。' },
    candles: breakoutCandles(NOW),
  });
  return advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: evaluations.filter(row => row.strategyId === 'internal'), nowMs: NOW });
}

test('zero buys produces an honest system test, never a buy inferred from a candidate', () => {
  const state = snapshot();
  state.strategies = [{ candidate: { symbol: 'SHOULD_NOT_APPEAR', address: CA }, entryLogic: 'invented buy' }];
  const original = structuredClone(state);
  const result = createSquarePreview(state, { nowMs: NOW });
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'preview_only');
  assert.equal(result.publishingEnabled, false);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].kind, 'system_test');
  assert.match(result.drafts[0].text, /模拟盘运行测试（非实盘）/);
  assert.match(result.drafts[0].text, /初始资金：\$100\.00/);
  assert.match(result.drafts[0].text, /累计模拟成交：0 笔/);
  assert.doesNotMatch(result.drafts[0].text, /SHOULD_NOT_APPEAR|invented buy|连接成功|实盘盈利/);
  assert.deepEqual(state, original);
});

test('a genuine paper entry snapshots exact evidence and renders a Chinese fact-based buy draft', () => {
  const account = buy();
  assert.equal(account.trades.length, 1);
  const trade = account.trades[0];
  assert.equal(trade.entryEvidence.liquidity, 60000);
  const draft = createSquarePreview(snapshot(account), { nowMs: NOW }).drafts[0];
  assert.equal(draft.kind, 'paper_buy');
  assert.equal(draft.tradeId, trade.id);
  assert.equal(draft.evidenceComplete, true);
  for (const literal of [CA, '模拟投入：$5.00', '盈利新买地址 6 个', '聪明钱 4 个', 'FOMO 地址 3 个', '独立买家 10 个', '净流入 $6,000.00', '流动性 $60,000.00', 'https://example.org/announcement', '硬止损上限 18%', '2026/09/22 08:00:00', '非实盘']) assert.ok(draft.text.includes(literal), literal);
  assert.ok(draft.text.length < 3600);
  assert.match(draft.digest, /^[a-f0-9]{64}$/);
  Object.values(account.positions)[0].entryEvidence.narrativeText = '后来变化不得改写原始记录';
  assert.equal(renderSquareBuyPreview(trade).text, draft.text);
});

test('closing a position and later observations never change the saved buy wording or identity', () => {
  const account = buy();
  const first = renderSquareBuyPreview(account.trades[0]);
  const closed = advancePaperStrategyAccount(account, { nowMs: NOW + 1000, enabled: false,
    marks: [{ chain: 'robinhood', address: CA, price: .7, observedAt: iso(NOW + 1000), status: 'ok' }] });
  assert.equal(Object.keys(closed.positions).length, 0);
  assert.equal(closed.trades.length, 2);
  const result = createSquarePreview(snapshot(closed, NOW + 1000), { nowMs: NOW + 1000 });
  assert.equal(result.buyCount, 1);
  assert.deepEqual(result.drafts[0], first);
});

test('legacy buys do not borrow narrative, wallet counts, or exit rules from current positions', () => {
  const account = buy();
  delete account.trades[0].entryEvidence;
  delete account.trades[0].exitLogic;
  const text = createSquarePreview(snapshot(account), { nowMs: NOW }).drafts[0].text;
  assert.match(text, /未保存完整资金流证据/);
  assert.match(text, /不按币名猜测/);
  assert.match(text, /不套用当前策略参数/);
  assert.doesNotMatch(text, /6,000|example.org|18%/);
});

test('unknown fields stay unknown, Solana CA case is preserved, unsafe source URLs are omitted', () => {
  const trade = buy().trades[0];
  trade.chain = 'sol'; trade.address = 'So11111111111111111111111111111111111111112';
  trade.entryEvidence.flow.highProfitCount = null;
  trade.entryEvidence.flow.fomoCount = 0;
  trade.entryEvidence.flow.netBuyUsd = null;
  trade.entryEvidence.liquidity = null;
  trade.entryEvidence.narrativeSource = 'https://user:password@example.org/private';
  const text = renderSquareBuyPreview(trade).text;
  assert.ok(text.includes(trade.address));
  assert.match(text, /盈利新买地址 未记录/);
  assert.match(text, /FOMO 地址 0 个/);
  assert.match(text, /净流入 未记录/);
  assert.match(text, /流动性 未记录/);
  assert.doesNotMatch(text, /user:password|example.org/);
});

test('stale, future, non-paper, invalid or future-trade snapshots produce no draft', () => {
  const cases = [null, { ...snapshot(), status: 'error' }, { ...snapshot(), updatedAt: iso(NOW - 120001) }, { ...snapshot(), updatedAt: iso(NOW + 1) }, { ...snapshot(), mode: 'live' }, { ...snapshot(), execution: true }, { ...snapshot(), signing: true }, { ...snapshot(), broadcast: true }];
  const badAccount = snapshot(); badAccount.account.cash = 99; cases.push(badAccount);
  const futureTrade = snapshot(buy()); futureTrade.account.trades[0].atMs = NOW + 1; cases.push(futureTrade);
  const badAddress = snapshot(buy()); badAddress.account.trades[0].address = '0xbad'; cases.push(badAddress);
  const duplicate = snapshot(buy()); duplicate.account.trades.push(structuredClone(duplicate.account.trades[0])); cases.push(duplicate);
  for (const state of cases) {
    const result = createSquarePreview(state, { nowMs: NOW });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.drafts, []);
    assert.equal(result.publishingEnabled, false);
  }
});

test('long or markup-like narrative remains bounded plain text and retains full CA and source', () => {
  const trade = buy().trades[0];
  trade.entryEvidence.narrativeText = '<img src=x onerror=alert(1)>\n' + '测试'.repeat(4000);
  trade.entryLogic = '依据'.repeat(4000);
  trade.exitLogic = '退出'.repeat(4000);
  const draft = renderSquareBuyPreview(trade);
  assert.ok(draft.text.length <= 3600);
  assert.ok(draft.text.includes(CA));
  assert.ok(draft.text.includes('https://example.org/announcement'));
  assert.equal(draft.text.split('\n').length, 13);
});

test('preview route is read-only, does not load credentials, and never advances the account', async t => {
  let snapshots = 0;
  const state = snapshot(createPaperStrategyAccount({ nowMs: Date.now() }), Date.now());
  const app = createDashboardServer({ port: 0,
    strategyRuntime: { snapshot: () => { snapshots++; return state; }, runOnce: () => { throw new Error('must not trade'); } },
    squareKeyStore: { status: () => { throw new Error('must not read key'); }, save: () => { throw new Error('must not save key'); } },
  });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const url = `${base}/api/square-preview`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).drafts[0].kind, 'system_test');
  }
  assert.equal(snapshots, 2);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${url}?publish=true`)).status, 403);
  assert.equal(snapshots, 2);
  const script = await (await fetch(`${base}/square-settings.js`)).text();
  assert.match(script, /\$\('#squarePreviewText'\)\.textContent = draft\?\.text/);
  assert.doesNotMatch(script, /innerHTML|\/api\/square-publish/);
});
