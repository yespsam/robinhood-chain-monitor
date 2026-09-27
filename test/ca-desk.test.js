import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaDesk, caKey, filterCaItems, pickCaSelection, recordCaChanges, renderCaDetail } from '../dashboard/ca-desk.js';

const now = Date.parse('2026-09-24T13:00:10Z');
const iso = offset => new Date(now + offset).toISOString();
function row(address = '0xabc', chain = 'bsc') {
  return { token: { chain, address, symbol: '同名币', price: .01 }, decision: '观察', missing: ['连续新鲜报价确认'], reasons: [], entryUsd: 10,
    exitLogic: '跌破结构失效位退出，无固定持仓期限',
    evidence: { marketFresh: true, marketObservedAt: iso(-1000), priceFresh: false, priceObservedAt: null,
      marketStage: 'external', paperEligible: false, chart: { ready: true },
      opportunity: { id: 'external_breakout', label: '外盘放量突破', basis: 'ohlcv', signalReady: true,
        pattern: { closedAt: now - 10000, close: .009, ready: true, volumeMultiple: 1.8 } },
      opportunityRoutes: [{ id: 'external_breakout', label: '外盘放量突破', decision: '观察', missing: ['连续新鲜报价确认'], reasons: [] }] } };
}
function snapshot(rows = [row()]) {
  return { status: 'ok', mode: 'paper', enabled: true, execution: false, signing: false, broadcast: false,
    updatedAt: iso(0), evaluations: rows, account: { positions: {} }, entryGuard: { allowed: true },
    opportunityRoutes: [{ id: 'external_breakout', description: '收盘突破前 12 根压力位，成交额至少为基线 1.5 倍。' }] };
}

test('deduplicates chain plus exact CA, never ticker or cross-chain symbols', () => {
  const a = row(), b = row('0xdef'), c = row('0xabc', 'eth');
  const result = buildCaDesk(snapshot([a, b, c, a]), now);
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map(x => x.key)).size, 3);
  assert.notEqual(caKey(row('Abc', 'sol').token), caKey(row('abc', 'sol').token));
});

test('quote-only wait is separate from unconfirmed economics or buying flow', () => {
  const s = snapshot();
  assert.equal(buildCaDesk(s, now)[0].state, 'confirm');
  s.evaluations[0].reasons.push('预计往返成本超过 5%');
  assert.equal(buildCaDesk(s, now)[0].state, 'watch');
  s.evaluations[0].reasons = [];
  s.evaluations[0].missing.push('九十秒内新增的双地址买盘');
  assert.equal(buildCaDesk(s, now)[0].state, 'watch');
});

test('engine permission, evidence, timestamps and account enablement all gate ready display', () => {
  const s = snapshot(), r = s.evaluations[0];
  r.decision = '可模拟'; r.missing = []; r.evidence.paperEligible = true;
  r.evidence.priceFresh = true; r.evidence.priceObservedAt = iso(-1000);
  assert.equal(buildCaDesk(s, now)[0].state, 'ready');
  assert.match(buildCaDesk(s, now)[0].lead, /不等于已经买入/);
  r.evidence.opportunity.pattern.closedAt = now - 90001;
  assert.equal(buildCaDesk(s, now)[0].state, 'data');
  r.evidence.opportunity.pattern.closedAt = now - 10000;
  assert.notEqual(buildCaDesk(s, now + 6000)[0].state, 'ready');
  r.evidence.priceObservedAt = iso(1000);
  assert.notEqual(buildCaDesk(s, now)[0].state, 'ready');
  r.evidence.priceObservedAt = iso(-1000); r.evidence.paperEligible = false;
  assert.notEqual(buildCaDesk(s, now)[0].state, 'ready');
  s.enabled = false;
  assert.equal(buildCaDesk(s, now)[0].state, 'paused');
  s.enabled = true; s.entryGuard = { allowed: false, reasons: ['可用余额不足'] };
  assert.equal(buildCaDesk(s, now)[0].state, 'paused');
});

test('disconnect, stale and future snapshot never present a live entry', () => {
  const s = snapshot();
  assert.equal(buildCaDesk(s, now, false)[0].state, 'data');
  s.updatedAt = iso(-120001);
  assert.equal(buildCaDesk(s, now)[0].state, 'data');
  s.updatedAt = iso(1000);
  assert.equal(buildCaDesk(s, now)[0].state, 'data');
});

test('route chart timestamps take precedence over generic ready chart', () => {
  const s = snapshot();
  s.evaluations[0].evidence.opportunity.pattern = { missing: true, reason: '新鲜且足够的 K 线' };
  const item = buildCaDesk(s, now)[0];
  assert.equal(item.chartFresh, false);
  assert.equal(item.state, 'data');
  assert.match(renderCaDetail(item), /尚无这条路线可用的收盘线/);
});

test('evidence includes measured route, trigger and unknown narrative without predictions', () => {
  const item = buildCaDesk(snapshot(), now)[0], html = renderCaDetail(item);
  assert.match(html, /1.80 倍/);
  assert.match(html, /前 12 根压力位/);
  assert.match(html, /叙事尚未核实/);
  assert.match(html, /FOMO 地址 未覆盖/);
  assert.match(html, /本轮没有完整的结构成本测算/);
  assert.match(html, /其他路线也在检查/);
  assert.match(html, /21:00:09/);
});

test('zero flow is known zero but absent flow is never filled with zero', () => {
  const s = snapshot();
  s.evaluations[0].evidence.flow = { uniqueBuyerCount: 0, netBuyUsd: 0 };
  let html = renderCaDetail(buildCaDesk(s, now)[0]);
  assert.match(html, /净买家 0/); assert.match(html, /净流入 \$0/);
  delete s.evaluations[0].evidence.flow;
  html = renderCaDetail(buildCaDesk(s, now)[0]);
  assert.match(html, /净买家 未知/); assert.match(html, /净流入 未采集/);
});

test('a chosen flow route does not hide other routes closed-candle evidence', () => {
  const s = snapshot(), e = s.evaluations[0].evidence;
  e.opportunityRoutes[0].pattern = { ...e.opportunity.pattern };
  e.opportunity = { id: 'flow_momentum', basis: 'flow' };
  const html = renderCaDetail(buildCaDesk(s, now)[0]);
  assert.match(html, /本轮选用买盘路线；外盘数据见下方/);
  assert.match(html, /可见收盘 09\/24 21:00:00/);
  assert.match(html, /相对量 1.80 倍/);
});

test('main holdings survive missing candidate data, preserve frozen rules and exclude control holdings', () => {
  const s = snapshot([]);
  s.account.positions = { main: { chain: 'bsc', address: '0xheld', symbol: '持有币', markAt: iso(-1000), markStatus: 'ok',
    activeStopPrice: .1, openedAt: iso(-20000), entryLogic: '买入时的理由', exitLogic: '旧仓原有退出条件',
    entryEvidence: { opportunity: { version: 'old_entry' } }, pvpPolicy: { version: 'old_exit' } } };
  s.reviewComparison = { control: { positions: { other: { chain: 'eth', address: '0xcontrol' } } } };
  const items = buildCaDesk(s, now);
  assert.equal(items.length, 1); assert.equal(items[0].state, 'holding');
  const html = renderCaDetail(items[0]);
  assert.match(html, /买入时的理由/); assert.match(html, /old_entry/); assert.match(html, /old_exit/);
  assert.match(html, /旧仓原有退出条件/); assert.doesNotMatch(html, /0xcontrol/);
  s.account.positions.main.markAt = iso(-16000);
  assert.match(buildCaDesk(s, now)[0].lead, /持仓报价待刷新/);
});

test('search by full CA and filters retain selected identity when rankings reorder', () => {
  const items = buildCaDesk(snapshot([row('0xabc'), row('0xdef', 'eth')]), now);
  assert.equal(filterCaItems(items, { query: '0xdef', chain: 'eth' }).length, 1);
  assert.equal(filterCaItems(items, { query: 'unseen' }).length, 0);
  assert.equal(filterCaItems(items, { state: 'holding' }).length, 0);
  const selected = items[1].key;
  assert.equal(pickCaSelection([...items].reverse(), selected), selected);
  assert.equal(pickCaSelection([], selected), null);
});

test('change trail ignores unchanged polling, remains bounded, never backfills absent history', () => {
  const history = new Map(), s = snapshot();
  recordCaChanges(history, buildCaDesk(s, now));
  recordCaChanges(history, buildCaDesk(s, now));
  const key = caKey(s.evaluations[0].token);
  assert.equal(history.get(key).events.length, 1);
  assert.match(history.get(key).events[0].text, /本页首次看到/);
  for (let n = 0; n < 10; n++) {
    s.evaluations[0].reasons = [`结构变动 ${n}`];
    recordCaChanges(history, buildCaDesk(s, now));
  }
  assert.equal(history.get(key).events.length, 5);
  recordCaChanges(history, []);
  assert.equal(history.size, 0);
});

test('all untrusted fields escape HTML and sources require safe HTTPS URLs', () => {
  const s = snapshot(), payload = '<img src=x onerror=alert(1)>';
  Object.assign(s.evaluations[0].token, { symbol: payload, address: payload });
  s.evaluations[0].reasons = [payload];
  s.evaluations[0].evidence.narrativeAssessment = { eligible: true, theme: payload, sources: [
    { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'https://name:secret@example.com' },
    { sourceUrl: 'https://example.com/source', authorLabel: payload } ] };
  const html = renderCaDetail(buildCaDesk(s, now)[0], [{ at: iso(0), text: payload }]);
  assert.doesNotMatch(html, /<img|javascript:|name:secret/);
  assert.match(html, /&lt;img/); assert.match(html, /https:\/\/example.com\/source/);
});

test('rendering explanations is pure and does not alter ledger or evidence', () => {
  const s = snapshot(), before = JSON.stringify(s);
  buildCaDesk(s, now).forEach(item => renderCaDetail(item));
  assert.equal(JSON.stringify(s), before);
});
