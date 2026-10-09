import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { createDashboardServer } from '../scripts/dashboard-server.js';
import { renderTradeCountReview } from '../dashboard/trade-count-review.js';
import { renderNewsWire } from '../dashboard/news-wire.js';
import { entryStatus } from '../dashboard/entry-status.js';

test('recovery lane budget shows current capped cash fraction, not the retired two-percent label',()=>{
  const app=fs.readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
  const start=app.indexOf('    const sizing = state.snapshot?.positionSizing;');
  const code=app.slice(start,app.indexOf('    const details =',start));
  const sizing={mode:'cash_fraction_cap',entryFraction:.1,maxEntryUsd:10,cashBasis:24.2615};
  const render=()=>vm.runInNewContext(code+'\nbudget;', {state:{snapshot:{positionSizing:sizing}},id:'external_trend',confirmed:true,num:v=>Number(v)||0,money:v=>v.toFixed(2)});
  assert.match(render(),/10%.*最高 10 U.*2.42/);sizing.cashBasis=500;assert.match(render(),/本轮≤10.00/);
});

test('dashboard shutdown cannot be held indefinitely by an unfinished read-only request', async () => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const app = createDashboardServer({ host:'127.0.0.1',port:0,
    market:{trending:()=>{started();return new Promise(()=>{});}} });
  const address = await app.listen();
  const request = http.get(`http://${address.address}:${address.port}/api/market`);
  request.on('error',()=>{});
  let closing, completed=false, deadline;
  try {
    await pending;
    closing=app.close().then(()=>{completed=true;});
    await Promise.race([closing,new Promise(resolve=>{deadline=setTimeout(resolve,6200);})]);
    assert.equal(completed,true,'HTTP drain is bounded; ledger writers are stopped independently');
  } finally {
    clearTimeout(deadline);request.destroy();app.server.closeAllConnections();
    await (closing||app.close());
  }
});

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
  assert.match(pageText, /看见判断如何变成行动/);
  assert.match(pageText, /id="brainDesk"/);
  assert.match(pageText, /brain-desk.css/);
  assert.match(pageText, /买入逻辑/);
  assert.match(pageText, /当前持仓/);
  assert.match(pageText, /多链模拟/);
  assert.match(pageText, /当前策略/);
  assert.match(pageText, /narrativeLearningNote/);
  assert.match(pageText, /起量叙事自动学习/);
  assert.match(pageText, /tradeReviewNote/);
  assert.match(pageText, /tradeCountReview/);
  const batchModule = await fetch(`${base}/trade-count-review.js`);
  assert.equal(batchModule.status,200); assert.match(await batchModule.text(),/不定时调用 AI/);
  assert.match(pageText, /traderReasoningNote/);
  assert.match(pageText, /逐币判断台/);
  assert.match(pageText, /data-ca-search/);
  const caDesk = await fetch(`${base}/ca-desk.js`);
  assert.equal(caDesk.status, 200);
  assert.match(await caDesk.text(), /export function buildCaDesk/);
  assert.match(pageText, /退出规则按入场时版本记录/);
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /--lime/);
  const state = await fetch(`${base}/api/paper-state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).execution, false);
  const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 400);
});

test('one-second dashboard polling is single-flight and labels true upstream ages separately', async () => {
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /setInterval\(refreshStrategyState, 1000\)/);
  const refresh = app.slice(app.indexOf('async function refreshStrategyState()'), app.indexOf('async function setEnabled('));
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const state = {}, context = { state, requestJson: () => { calls++; return pending; }, renderAll: () => {} };
  vm.runInNewContext(refresh, context);
  const first = context.refreshStrategyState(); await context.refreshStrategyState(); assert.equal(calls, 1);
  release({ mode: 'paper', status: 'ok' }); await first; assert.equal(state.fetching, false);
  const nodes = {}, render = app.slice(app.indexOf('function renderStatus()'), app.indexOf('function renderAccount()'));
  state.snapshot = { mode: 'paper', status: 'ok', updatedAt: new Date().toISOString(), enabled: true,
    cadence: { evaluationIntervalMs: 1000, actualTickGapMs: 1100, evaluationOverrunMs: 100,
      marketSourceAges: [{ chain: 'base', ageMs: 15000 }, { chain: 'bsc', ageMs: null }] } };
  Object.assign(context, { $: key => nodes[key] ||= { dataset: {} }, entryStatus, tradingDataHealth: () => ({ status: 'ok' }),
    clock: String, chainName: String, humanText: String, finite: n => typeof n === 'number' && Number.isFinite(n) });
  vm.runInNewContext(`${render}\nrenderStatus();`, context);
  assert.match(nodes['#cadenceNote'].textContent, /扫描目标 1 秒.*实测间隔 1.1 秒/);
  assert.match(nodes['#cadenceNote'].textContent, /base 15秒 \/ bsc 未取得/);
  assert.match(nodes['#cadenceNote'].textContent, /不等于上游价格更新频率/);
  state.snapshot.cadence.sharedReadonlyPolicy={plan:'plus'};
  context.renderStatus();
  assert.match(nodes['#cadenceNote'].textContent,/GMGN Plus 调度.*预留 1 个持仓名额.*不是每币刷新间隔/);
  state.snapshot.enabled=false;
  state.snapshot.lossGuards={enforced:true,triggered:true,newEntriesStop:true,reasons:['本轮亏损达到额度']};
  state.snapshot.entryGuard={allowed:true};
  context.renderStatus();
  assert.equal(nodes['#engineNotice'].hidden,false,'paused accounts remain visible even if candidate guard allows');
  assert.match(nodes['#engineNotice'].textContent,/亏损预算触发/);
  assert.match(nodes['#focusAutoLabel'].textContent,/新增仓位已暂停/);
  assert.equal(nodes['#focusAutoToggle'].disabled,true);
  state.status='error';context.renderStatus();
  assert.match(nodes['#focusAutoLabel'].textContent,/待同步/);
  assert.match(nodes['#engineNotice'].textContent,/上次记录/);
});

test('large one-second snapshots negotiate lossless gzip without dropping evidence or mutating the ledger', async t => {
  const snapshot = { mode: 'paper', status: 'ok', evidence: '原始证据'.repeat(4000) };
  const app = createDashboardServer({ host: '127.0.0.1', port: 0, strategyRuntime: { snapshot: () => snapshot } });
  const address = await app.listen(); t.after(() => app.close());
  for (const encoding of ['gzip', 'gzip;q=0', 'identity']) {
    const response = await new Promise((resolve, reject) => {
      http.get(`http://${address.address}:${address.port}/api/strategy-state`, { headers: { 'accept-encoding': encoding } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ headers: res.headers, data: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    const compressed = encoding === 'gzip';
    assert.equal(response.headers['content-encoding'], compressed ? 'gzip' : undefined);
    assert.equal(response.headers.vary, 'Accept-Encoding');
    if (compressed) assert.ok(response.data.length < Buffer.byteLength(JSON.stringify(snapshot)) / 10);
    assert.deepEqual(JSON.parse(compressed ? gunzipSync(response.data) : response.data), snapshot);
  }
});

test('confirmed-mode multi-chain coverage renders quote confirmation without a scope error', () => {
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function renderCoverage()'), app.indexOf('function renderTrades()'));
  const target = { innerHTML: '' };
  const context = { state: { snapshot: { entryMode: 'confirmed_pvp_v2', chains: ['base', 'bsc'],
    chainCoverage: { base: { funnel: { chartReady: 3 } }, bsc: {} } } },
    $: () => target, num: n => Number(n) || 0, chainName: s => s, escapeHtml: s => s,
    humanText: s => s, clock: s => s,
    marketCoverageStatus: () => ({ fresh: true, label: '测试行情' }),
    flowCoverageStatus: () => ({ fresh: true, label: '测试资金流' }) };
  vm.runInNewContext(`${source}\nrenderCoverage();`, context);
  assert.match(target.innerHTML, /连续报价确认 3/);
  assert.doesNotMatch(target.innerHTML, /形态免筛选|K 线齐全/);
});

test('evidence-hold strategy card has no fixed duration and accurately retains ten-dollar sizing and stops', () => {
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function renderStrategies()'), app.indexOf('function renderCoverage()'));
  const exitNote = { classList: { contains: () => true } }, nodes = {};
  const context = { state: { snapshot: { entryMode: 'confirmed_pvp_v2', exitPolicy: { mode: 'pvp', version: 'evidence_hold_v1' },
    positionSizing: { fixedEntryUsd: 10 }, strategies: [{ id: 'smart_money', stopLoss: .06, maxHoldMs: null,
      exitPolicy: { version: 'evidence_hold_v1' }, reasons: [] }] } },
    document: { querySelectorAll: () => [] }, $: key => nodes[key] ||= { nextElementSibling: exitNote, querySelectorAll:()=>[] },
    num: n => Number(n) || 0, finite: n => typeof n === 'number' && Number.isFinite(n),
    STRATEGY_LABELS: { smart_money: '聪明钱跟踪' }, statusLabel: String, humanText: String, money: String,
    escapeHtml: String, renderStrategyDetails: () => '', renderTradeCountReview, renderNewsWire, signedMoney: String, shortAddress: String };
  vm.runInNewContext(`${source}\nrenderStrategies();`, context);
  assert.match(nodes['#strategyLanes'].innerHTML, /按行情，无固定时限/);
  assert.match(nodes['#strategyLanes'].innerHTML, /固定单笔 10 U/);
  assert.match(exitNote.textContent, /不按分钟强制卖出/);
  assert.match(exitNote.textContent, /初始止损 6%/);
  assert.doesNotMatch(exitNote.textContent, /最长 5 分钟|最长 20 分钟/);
  assert.doesNotMatch(nodes['#strategyLanes'].innerHTML, /初始时限 0 分钟/);
  assert.match(nodes['#strategyObjective'].textContent, /每小时最多6次/);
  context.state.snapshot.operatingPolicy = { continuous: true };
  vm.runInNewContext(`${source}\nrenderStrategies();`, context);
  assert.match(nodes['#strategyObjective'].textContent, /无开仓次数、固定冷却或持仓个数上限/);
  assert.doesNotMatch(nodes['#strategyObjective'].textContent, /每小时最多|每日最多|日亏损和总亏损保护保持/);
  context.state.snapshot.lossGuards={enforced:true,triggered:true};
  context.state.snapshot.entryGuard={lossReview:{completedRounds:15},traderReview:{overall:{closedRounds:15}}};
  vm.runInNewContext(`${source}\nrenderStrategies();`, context);
  for(const key of ['#strategyObjective','#tradeReviewNote','#traderReasoningNote']){
    assert.match(nodes[key].textContent,/达到本金 10% 会暂停新仓/);
    assert.doesNotMatch(nodes[key].textContent,/亏损及次数只记录|不因日亏损或总亏损停机|连亏不暂停/);
  }
  context.state.snapshot.newsWire={};context.state.snapshot.narrativeDesk={cases:[{chain:'bsc',address:'0x1',symbol:'demo'}]};
  nodes['#newsWireContent'].querySelectorAll=selector=>{assert.equal(selector,'details[data-narrative-case][open]');return [{dataset:{narrativeCase:'bsc:0x1'}}];};
  vm.runInNewContext(`${source}\nrenderStrategies();`,context);
  assert.match(nodes['#newsWireContent'].innerHTML,/data-narrative-case="bsc:0x1" open/,'polling preserves the same CA expansion');
});

test('multi-setup dashboard shows independent Chinese routes, not six copies of the PVP rule', () => {
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function renderStrategies()'), app.indexOf('function renderCoverage()'));
  const exitNote = { classList: { contains: () => true } }, nodes = {};
  const context = { state: { snapshot: { opportunityMode:'multi_setup_v1',entryMode:'confirmed_pvp_v2',exitPolicy:{mode:'pvp',version:'evidence_hold_v1'},
    positionSizing:{fixedEntryUsd:10},opportunityRoutes:[{id:'external_breakout',label:'外盘放量突破',description:'真实收盘突破压力位',
      observedCount:3,eligibleCount:1,reasons:[],exitPolicy:{version:'evidence_hold_v1'},stopLoss:.06}] } },
    document:{querySelectorAll:()=>[]}, $:key=>nodes[key] ||= {nextElementSibling:exitNote,querySelectorAll:()=>[]},num:n=>Number(n)||0,
    finite:n=>typeof n==='number'&&Number.isFinite(n),STRATEGY_LABELS:{smart_money:'聪明钱跟踪'},statusLabel:String,humanText:String,
    money:String,escapeHtml:String,renderStrategyDetails:()=>'',renderTradeCountReview,renderNewsWire,signedMoney:String,shortAddress:String };
  vm.runInNewContext(`${source}\nrenderStrategies();`,context);
  assert.match(nodes['#strategyLanes'].innerHTML,/外盘放量突破/);
  assert.match(nodes['#strategyLanes'].innerHTML,/真实收盘突破压力位/);
  assert.doesNotMatch(nodes['#strategyLanes'].innerHTML,/近 90 秒至少两个净买家/);
  assert.match(nodes['#strategyObjective'].textContent,/不强制聪明钱标签/);
  assert.match(nodes['#strategyObjective'].textContent,/不能覆盖或获利于所有代币/);
  context.state.snapshot.opportunityMode='multi_setup_v2';
  context.state.snapshot.reviewComparison={main:{entries:2,closedRounds:1,newRoundPnl:-.2},control:{entries:3,closedRounds:2,newRoundPnl:-.9}};
  context.state.snapshot.researchPipeline={hotCandidates:[{}],discoveryCandidates:117};
  vm.runInNewContext(`${source}\nrenderStrategies();`,context);
  assert.match(nodes['#strategyObjective'].textContent,/前向对照/);
  assert.match(nodes['#strategyObjective'].textContent,/热点 1 个/);
  assert.match(exitNote.textContent,/连续两根入场后收盘线/);
  assert.doesNotMatch(exitNote.textContent,/上涨 15% 后启动/);
  context.state.snapshot.mainExitPolicy={version:'meme_evidence_exit_v1',text:'新仓叙事与资金行为退出，不设固定百分比'};
  context.state.snapshot.opportunityRoutes[0].memeExitPolicy=context.state.snapshot.mainExitPolicy;
  vm.runInNewContext(`${source}\nrenderStrategies();`,context);
  assert.match(nodes['#strategyObjective'].textContent,/取消固定价格、倍数和时间触发/);
  assert.match(nodes['#strategyLanes'].innerHTML,/不设固定百分比/);
  assert.doesNotMatch(nodes['#strategyLanes'].innerHTML,/止损上限 6%/);
  assert.equal(exitNote.textContent,context.state.snapshot.mainExitPolicy.text);
});

test('narrative learning UI distinguishes retained cases, pending horizons and capacity omissions', () => {
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('  const learner = state.snapshot?.narrativeLearning;'), app.indexOf('  if (recallNode)'));
  const node = {}, context = { state:{snapshot:{narrativeLearning:{sampleCount:501,
    completed24h:1,missed24h:0,retention:{pending24h:500,pendingLimit:500,resolved24h:1,resolvedLimit:1500,
      capacitySkippedEpisodes:2,evictedResolvedEpisodes:3}}}}, $:()=>node,num:n=>Number(n)||0 };
  vm.runInNewContext(source,context);
  assert.match(node.textContent,/当前留存 501 次起量/);
  assert.match(node.textContent,/待完成24小时观察 500 \/ 500/);
  assert.match(node.textContent,/满额跳过新波次 2/);
  assert.match(node.textContent,/按时间淘汰 3/);
  assert.doesNotMatch(node.textContent,/累计 501/);
});

test('empty holdings distinguish no current position from no historical trades', () => {
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function renderPositions()'), app.indexOf('function renderStrategies()'));
  const nodes = {}, context = { state: { snapshot: { enabled: true, account: { positions: {}, stats: { entries: 8 },
    trades: [{ side: 'sell', symbol: 'FIXTURE', atMs: 123 }] } } },
    document: { querySelectorAll: () => [] }, $: key => nodes[key] ||= {}, num: n => Number(n) || 0,
    escapeHtml: s => String(s), dateTime: () => '09-23 22:35' };
  vm.runInNewContext(`${source}\nrenderPositions();`, context);
  assert.match(nodes['#focusPositionsList'].innerHTML, /当前没有持仓/);
  assert.match(nodes['#focusPositionsList'].innerHTML, /已有 8 次买入/);
  assert.match(nodes['#focusPositionsList'].innerHTML, /09-23 22:35 FIXTURE 卖出/);
  assert.match(nodes['#focusPositionsList'].innerHTML, /href="#recentTrades"/);
});

test('trade table shows all-in ten-dollar spend and signed net proceeds, not pre-fee notional', () => {
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function renderTrades()'), app.indexOf('function renderResearchTeam()'));
  const nodes = {}, context = { state: { snapshot: { account: { trades: [
    { side: 'buy', atMs: 1, symbol: 'FIXTURE', grossUsd: 9.852, netUsd: -10, costsUsd: .148, realizedPnl: 0 },
    { side: 'sell', atMs: 2, symbol: 'FIXTURE', grossUsd: .01, netUsd: -.01, costsUsd: .02, realizedPnl: -10.01 }
  ] } } }, $: key => nodes[key] ||= {}, num: n => Number(n) || 0, escapeHtml: String, dateTime: String,
    recordLabel: () => '确认型 PVP', humanText: String, money: String, signedMoney: String };
  vm.runInNewContext(`${source}\nrenderTrades();`, context);
  assert.match(nodes['#tradeRows'].innerHTML, /<td>10<small>总支出，含成本/);
  assert.match(nodes['#tradeRows'].innerHTML, /<td>-0.01<small>净回款，已扣成本/);
  assert.doesNotMatch(nodes['#tradeRows'].innerHTML, /9.852|待平仓/);
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

test('strategy reads never advance the ledger and control rejects cross-site or invalid mutations', async t => {
  let enabled = true, changes = 0;
  const snapshot = () => ({ status: 'ok', mode: 'paper', execution: false, signing: false, broadcast: false, enabled, account: { cash: 100 } });
  const app = createDashboardServer({ port: 0, strategyRuntime: { snapshot, setEnabled: async value => { enabled = value; changes++; return snapshot(); } } });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://${address.address}:${address.port}`;
  for (let i = 0; i < 3; i++) assert.equal((await (await fetch(`${base}/api/strategy-state`)).json()).account.cash, 100);
  assert.equal(changes, 0);
  const url = `${base}/api/strategy-control`;
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"enabled":false}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"enabled":false}' })).status, 415);
  for (const body of ['{}', '{"enabled":"false"}', '{"enabled":false,"signing":true}', '{broken']) {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body })).status, 400);
  }
  assert.equal(changes, 0);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"enabled":false}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).enabled, false); assert.equal(changes, 1);
  assert.equal((await fetch(`${base}/api/market`, { method: 'POST' })).status, 405);
  // Node fetch replaces Host; use the HTTP client to exercise DNS-rebinding protection.
  const reboundStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/strategy-state`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).once('error', reject);
  });
  assert.equal(reboundStatus, 403);
});

test('repair maintenance exposes an explicit 409 when order-level accounting is unavailable', async t => {
  const snapshot=()=>({status:'ok',mode:'paper',execution:false,signing:false,broadcast:false,enabled:false});
  const app=createDashboardServer({port:0,strategyRuntime:{snapshot,setEnabled:async value=>{
    if(value)throw Object.assign(new Error('不能恢复主盘新仓：订单级路由费用尚未接通'),{code:'PAPER_ORDER_FEES_UNAVAILABLE'});
    return snapshot();
  }}});
  const address=await app.listen();t.after(()=>app.close());const base=`http://${address.address}:${address.port}`;
  const response=await fetch(`${base}/api/strategy-control`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({enabled:true})});
  assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,'PAPER_ORDER_FEES_UNAVAILABLE');assert.match(body.error,/订单级/);
  assert.equal((await(await fetch(`${base}/api/strategy-state`)).json()).enabled,false);
});

test('retained original main is a separate read-only view, never a second writer',async t=>{
  const main={mode:'paper',enabled:false,account:{cash:34.75}},estimated={mode:'paper',enabled:true,account:{cash:100}};
  const app=createDashboardServer({port:0,strategyRuntime:{snapshot:()=>estimated},mainPaperSnapshot:async()=>main});
  const address=await app.listen();t.after(()=>app.close());const base=`http://${address.address}:${address.port}`;
  assert.deepEqual(await(await fetch(base+'/api/main-paper-state')).json(),main);
  assert.deepEqual(await(await fetch(base+'/api/strategy-state')).json(),estimated);
  assert.equal((await fetch(base+'/api/main-paper-state',{method:'POST'})).status,405);
});
