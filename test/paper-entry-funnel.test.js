import test from 'node:test';
import assert from 'node:assert/strict';
import { paperEntryFunnel, paperEntryDiagnostics, summarizeChartHealth } from '../src/paper-entry-funnel.js';
const ready = () => ({ token: { chain: 'sol', address: 'example' }, decision: '可模拟', evidence: {
  marketFresh: true, flowFresh: true, flow: { uniqueBuyerCount: 1, highProfitCount: 0, smartMoneyCount: 1, netBuyUsd: 200 },
  entryThresholds: { minBuyers: 1, minHighProfit: 0, minSmartMoney: 1, minNetBuy: 200 },
  safety: { missing: [], blocked: [] }, chart: { ready: true }, priceFresh: true, paperEligible: true,
} });
test('diagnostics distinguish missing, stale, short and invalid charts from a genuinely unmet structure',()=>{
  const samples=[['source_unavailable','chart_missing'],['stale_closed_bars','chart_stale'],
    ['insufficient_contiguous_tail','chart_incomplete'],['invalid_price','chart_invalid'],['ready','structure']];
  for(const [code,expected] of samples){
    const row={token:{chain:'bsc',address:'0xabc'},decision:'观察',reasons:['等待结构'],missing:['新鲜且足够的 K 线'],
      evidence:{marketFresh:true,safety:{missing:[],blocked:[]},opportunity:{basis:'ohlcv',chartWindow:{code}},
        lossRepair:{entryPath:'external_structure',entryPathAllowed:true,reentry:{ready:true},fee:{ready:true},thesis:null}}};
    const before=structuredClone(row);assert.equal(paperEntryDiagnostics([row]).blockers[0].code,expected);assert.deepEqual(row,before);
  }
});
test('chart health separates never-requested names from empty fetches and does not treat quote confirmation as candles', () => {
  const row = (address, patch) => ({ token: { chain: 'bsc', address }, evidence: patch });
  const missing = row('0x1', { chart: { ready: false }, recoveryEntry: { klineStatus: 'unavailable' }, opportunity: { chartWindow: { code: 'source_unavailable' } } });
  const stale = row('0x2', { chart: { ready: false }, recoveryEntry: { klineStatus: 'ok' }, opportunity: { chartWindow: { code: 'stale_closed_bars' } } });
  const readyChart = row('0x3', { chart: { ready: true }, recoveryEntry: { klineStatus: 'ok' }, opportunity: { chartWindow: { code: 'ready' } } });
  const untouched = Array.from({ length: 17 }, (_, i) => row(`0x${i + 10}`, { chart: { ready: false }, recoveryEntry: { klineStatus: 'unavailable' }, opportunity: { chartWindow: { code: 'source_unavailable' } } }));
  const evaluations = [missing, stale, readyChart, ...untouched];
  const chartRows = [
    { chartKey: 'bsc:0x1', status: 'unavailable', queuedAt: '2026-11-07T00:00:00.000Z', receivedAt: '2026-11-07T00:00:02.000Z' },
    { chartKey: 'bsc:0x2', status: 'ok' },
    { chartKey: 'bsc:0x3', status: 'ok', queuedAt: '2026-11-07T00:00:00.000Z', receivedAt: '2026-11-07T00:00:01.000Z' },
  ];
  const warmup = summarizeChartHealth({ evaluations, chartRows, hotKeys: ['bsc:0x3', 'bsc:0x4'], chartDispatchCount: 1 });
  assert.equal(warmup.warmup, true); assert.equal(warmup.alert, false); assert.equal(warmup.notRequested, 17);
  assert.equal(warmup.fetchedUnavailable, 1); assert.equal(warmup.staleClosedBars, 1); assert.equal(warmup.chartReady, 1);
  const starved = summarizeChartHealth({ evaluations, chartRows, hotKeys: ['bsc:0x3', 'bsc:0x4', 'bsc:0x5'], chartDispatchCount: 6 });
  assert.equal(starved.warmup, false); assert.equal(starved.alert, true); assert.match(starved.note, /第一次 K 线/);
  const empty = summarizeChartHealth({
    evaluations: Array.from({ length: 8 }, (_, i) => row(`0x${i + 1}`, missing.evidence)),
    chartRows: Array.from({ length: 8 }, (_, i) => ({ chartKey: `bsc:0x${i + 1}`, status: 'unavailable', queuedAt: '2026-11-07T00:00:00.000Z', receivedAt: '2026-11-07T00:00:26.000Z' })),
    queueRecent: [{ kind: 'market:kline', localQueueMs: 27000 }, { kind: 'address:notes', localQueueMs: 1 }],
    funnels: [{ chartReady: 0, ohlcvReady: 3 }],
  });
  assert.equal(empty.alert, true);
  assert.equal(empty.notRequested, 0);
  assert.equal(empty.fetchedUnavailableRatio, 1);
  assert.equal(empty.funnelChartReady, 0);
  assert.equal(empty.funnelOhlcvReady, 3);
  assert.ok(empty.queueWaitMedianMs >= 20000);
  assert.match(empty.note, /不补造 K 线|买卖条件未放宽/);
  const funnel = paperEntryFunnel(evaluations.map(item => ({ ...item, decision: '观察', evidence: { ...item.evidence, marketFresh: false } })));
  assert.equal(funnel.eligible, 0);
  assert.equal(funnel.chartReady, 0);
  assert.equal(funnel.ohlcvReady, 1);
  assert.equal(funnel.confirmationReady, 0);
});

test('entry funnel deduplicates strategy lanes and counts nested evidence gates without approving anything', () => {
  const good = ready(), old = ready(), unknown = ready(), small = ready();
  old.token.address = 'old'; old.evidence.marketFresh = false;
  unknown.token.address = 'unknown'; unknown.evidence.safety.missing = ['sell tax'];
  small.token.address = 'small'; small.evidence.flow.netBuyUsd = 199;
  assert.deepEqual(paperEntryFunnel([good, structuredClone(good), old, unknown, small]), {
    detected: 4, marketFresh: 3, flowReady: 2, safetyReady: 1, chartReady: 1, quoteFresh: 1, eligible: 1,
    ohlcvReady: 4, confirmationReady: 1,
  });
  assert.equal(paperEntryFunnel([{ token: good.token }]).eligible, 0);
  assert.equal(paperEntryFunnel([]).detected, 0);
});

test('primary entry diagnostics distinguish absent catalysts, missing fields, scheduled quotes and actual eligibility',()=>{
  const make=(address,patch={})=>({token:{chain:'bsc',address},decision:'观察',reasons:[],missing:['五秒内的独立报价'],
    evidence:{marketFresh:true,safety:{missing:[],blocked:[]},...patch}});
  const repair={catalystReady:true,reentry:{ready:true},thesis:null,fee:{ready:true}};
  const noSource=make('0xaa',{lossRepair:{...repair,catalystReady:false}});
  const data=make('0xbb',{marketFresh:false,lossRepair:repair});
  data.missing=['两分钟内的真实行情'];
  const quote=make('0xcc',{lossRepair:repair,opportunityRoutes:[{basis:'flow',signalReady:true,decision:'观察',reasons:[],missing:['五秒内的独立报价']}]});
  const good={...make('0xdd'),decision:'可模拟'};good.evidence.paperEligible=true;
  const before=structuredClone([noSource,data,quote,good]);
  const out=paperEntryDiagnostics([...before,{...noSource,token:{chain:'bsc',address:'0xAA'}}],{quoteTargets:[{chain:'bsc',address:'0xcc',purpose:'candidate',candidateBook:'main'}]});
  assert.equal(out.detected,4);assert.equal(out.verifiedCatalyst,2);assert.equal(out.quoteResearchReady,2);assert.equal(out.quoteScheduled,1);assert.equal(out.eligible,1);
  assert.deepEqual(Object.fromEntries(out.blockers.map(b=>[b.code,b.count])),{market_data:1,catalyst:1,quote_scheduled:1,eligible:1});
  assert.equal(out.blockers.reduce((n,b)=>n+b.count,0),out.detected);
  assert.deepEqual([noSource,data,quote,good],before);
  const control=paperEntryDiagnostics([quote],{quoteTargets:[{chain:'bsc',address:'0xcc',purpose:'candidate',candidateBook:'comparison'}]});
  assert.equal(control.quoteScheduled,0);assert.equal(control.blockers[0].code,'quote_wait');
  assert.equal(paperEntryDiagnostics([{token:{chain:'sol',address:'a'}}]).blockers[0].code,'market_data');
  assert.equal(paperEntryDiagnostics([]).detected,0);
});
