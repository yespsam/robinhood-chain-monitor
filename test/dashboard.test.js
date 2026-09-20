import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardServer } from '../scripts/dashboard-server.js';

test('dashboard serves the paper terminal, local paper bridge, and rejects path traversal', async t => {
  const app = createDashboardServer({ host: '127.0.0.1', port: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://${address.address}:${address.port}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /仅模拟盘/);
  assert.match(pageText, /yesp atm/);
  assert.match(pageText, /自动模拟交易/);
  assert.match(pageText, /只看持仓和买入逻辑/);
  assert.match(pageText, /买入逻辑/);
  assert.match(pageText, /当前持仓/);
  assert.match(pageText, /追踪回撤/);
  assert.match(pageText, /分段回收/);
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /--lime/);
  const state = await fetch(`${base}/api/paper-state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).execution, false);
  const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 400);
});

test('dashboard exposes read-only GMGN market and kline routes without trade execution', async t => {
  const calls = [];
  const app = createDashboardServer({
    host: '127.0.0.1',
    port: 0,
    market: {
      trending: async query => { calls.push(['trending', query]); return { status: 'ok', source: 'gmgn-cli', tokens: [] }; },
      kline: async query => { calls.push(['kline', query]); return { status: 'ok', source: 'gmgn-cli', candles: [] }; },
    },
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://${address.address}:${address.port}`;
  const market = await fetch(`${base}/api/market?chain=bsc&interval=1m&limit=7`);
  assert.equal(market.status, 200);
  assert.equal((await market.json()).source, 'gmgn-cli');
  const kline = await fetch(`${base}/api/kline?chain=bsc&address=0xabc12345&resolution=1m&hours=2`);
  assert.equal(kline.status, 200);
  assert.equal((await kline.json()).source, 'gmgn-cli');
  assert.equal(calls[0][0], 'trending');
  assert.deepEqual(calls[0][1], { chain: 'bsc', interval: '1m', limit: 7 });
  assert.equal(calls[1][0], 'kline');
  assert.equal(calls[1][1].chain, 'bsc');
  assert.equal(calls[1][1].resolution, '1m');
  assert.equal(calls[1][1].address, '0xabc12345');
});
