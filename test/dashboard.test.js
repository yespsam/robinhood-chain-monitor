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
  assert.match(pageText, /Robinhood/);
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
  const defaultMarket = await fetch(`${base}/api/market`);
  assert.equal(defaultMarket.status, 200);
  assert.equal(calls[2][0], 'trending');
  assert.equal(calls[2][1].chain, 'robinhood');
});

test('dashboard exposes a read-only AI research team report', async t => {
  const calls = [];
  const now = new Date().toISOString();
  const token = {
    address: '0x1111111111111111111111111111111111111111', symbol: 'ALPHA', chain: 'bsc', price: 1,
    change: 12, liquidity: 100_000, volume: 150_000, holders: 1_000, smartDegenCount: 5,
    renownedCount: 2, rugRatio: .05, isHoneypot: false, isWashTrading: false, buyTax: .01,
    sellTax: .01, creatorClose: true, isOpenSource: true, isRenounced: true, top10HolderRate: .3,
    buys: 100, sells: 50,
  };
  const app = createDashboardServer({
    host: '127.0.0.1', port: 0,
    market: {
      trending: async query => { calls.push(['trending', query]); return { status: 'ok', source: 'gmgn-cli', chain: 'bsc', observedAt: now, tokens: [token] }; },
      kline: async query => { calls.push(['kline', query]); return { status: 'ok', source: 'gmgn-cli', candles: [{ close: .9 }, { close: 1 }] }; },
    },
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://${address.address}:${address.port}`;
  const response = await fetch(`${base}/api/research-team?chain=bsc&address=${token.address}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'gmgn-cli');
  assert.equal(body.report.schema, 'yesp_atm_research_team_v1');
  assert.equal(body.report.executable, false);
  assert.equal(body.report.signing, false);
  assert.equal(body.report.broadcast, false);
  assert.equal(body.report.token.symbol, 'ALPHA');
  assert.match(body.brief, /结论：/);
  assert.equal(calls[0][0], 'trending');
  assert.equal(calls[1][0], 'kline');
});
