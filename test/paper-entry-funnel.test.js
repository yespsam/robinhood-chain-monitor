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

test('external K-line research exclusions do not masquerade as source gaps or change prior gates',()=>{
  const row={token:{chain:'bsc',address:'0xabc'},decision:'观察',reasons:['等待结构'],missing:['新鲜且足够的 K 线'],
    evidence:{marketFresh:true,marketStage:'external',liquidity:19999,volume:{value:100,window:'5m'},
      safety:{missing:[],blocked:[]},opportunity:{basis:'ohlcv',chartWindow:{code:'source_unavailable'}},
      lossRepair:{entryPath:'external_structure',entryPathAllowed:true,reentry:{ready:true},fee:{ready:true},thesis:null}}};
  const diagnose=value=>paperEntryDiagnostics([value]).blockers[0].code;
  const before=structuredClone(row);
  assert.equal(diagnose(row),'research_excluded');
  const admitted=structuredClone(row);admitted.evidence.liquidity=20000;
  assert.equal(diagnose(admitted),'chart_missing','boundary is the existing research admission threshold');
  for(const code of ['stale_closed_bars','insufficient_closed_bars']){
    const excluded=structuredClone(row);excluded.evidence.opportunity.chartWindow.code=code;
    assert.equal(diagnose(excluded),'research_excluded','an old cached graph does not imply refresh admission');
  }
  const noVolume=structuredClone(admitted);noVolume.evidence.volume.value=0;
  assert.equal(diagnose(noVolume),'research_excluded');
  const internal=structuredClone(admitted);internal.evidence.marketStage='internal';
  assert.equal(diagnose(internal),'research_excluded');
  const incomplete=structuredClone(row);delete incomplete.evidence.liquidity;
  assert.equal(diagnose(incomplete),'chart_missing','missing admission telemetry is not proof of intentional exclusion');
  for(const [mutate,expected] of [
    [r=>r.evidence.safety.blocked=['honeypot'],'safety_blocked'],
    [r=>r.evidence.marketFresh=false,'market_data'],
    [r=>r.evidence.lossRepair.entryPathAllowed=false,'catalyst'],
    [r=>r.evidence.lossRepair.reentry.ready=false,'reentry'],
    [r=>r.evidence.safety.missing=['tax'],'safety_data'],
    [r=>r.evidence.lossRepair.fee.ready=false,'fees'],
  ]){const changed=structuredClone(row);mutate(changed);assert.equal(diagnose(changed),expected);}
  assert.deepEqual(row,before,'telemetry does not mutate admission or evidence');
});

test('chart health keeps legacy chart readiness separate from external entry window readiness',()=>{
  const rows=[
    {token:{chain:'bsc',address:'legacy'},evidence:{chart:{ready:true},opportunity:{chartWindow:{code:'insufficient_closed_bars'}}}},
    {token:{chain:'bsc',address:'external'},evidence:{chart:{ready:false},opportunity:{chartWindow:{code:'ready'}}}},
    {token:{chain:'bsc',address:'both'},evidence:{chart:{ready:true},opportunity:{chartWindow:{code:'ready'}}}},
  ];
  const result=summarizeChartHealth({evaluations:[...rows,structuredClone(rows[2])],hotKeys:['bsc:legacy','bsc:external']});
  assert.equal(result.chartReady,3,'retain compatible union of the old readiness meanings');
  assert.equal(result.legacyChartReady,2);assert.equal(result.externalWindowReady,2);
  assert.equal(result.hotChartReady,2);assert.equal(result.hotLegacyChartReady,1);assert.equal(result.hotExternalWindowReady,1);
  assert.match(result.chartReadinessNote,/仍不代表形态或买入条件通过/);
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
  assert.equal(warmup.hotFetched,1);assert.equal(warmup.hotNotRequested,1);assert.equal(warmup.hotRequestCoverageRate,.5);
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

test('hot K-line health uses the last fully closed minute, not an ok cache status', () => {
  const nowMs = Date.parse('2026-11-07T10:03:30.000Z');
  const openAt = value => Date.parse(value) / 1000;
  const keys = ['bsc:fresh', 'bsc:stale', 'bsc:forming'];
  const evaluations = keys.map((key, index) => ({
    token: { chain: 'bsc', address: key.slice(4) },
    evidence: { recoveryEntry: { klineStatus: 'ok' }, chart: { ready: index === 0 } },
  }));
  const chartRows = [
    { chartKey: keys[0], status: 'ok', closedThroughAtMs: Date.parse('2026-11-07T10:03:00.000Z'), candles: [{ time: openAt('2026-11-07T10:02:00.000Z') }] },
    { chartKey: keys[1], status: 'stale', closedThroughAtMs: Date.parse('2026-11-07T10:01:00.000Z'), candles: [{ time: openAt('2026-11-07T10:00:00.000Z') }] },
    { chartKey: keys[2], status: 'ok', closedThroughAtMs: Date.parse('2026-11-07T10:03:00.000Z'), candles: [{ time: openAt('2026-11-07T10:03:00.000Z') }] },
  ];
  const health = summarizeChartHealth({ evaluations, chartRows, hotKeys: keys, chartDispatchCount: 9, nowMs });
  assert.equal(health.hotKlineOk, 3, 'legacy status count remains distinct from freshness');
  assert.equal(health.hotKlineFresh, 1);
  assert.equal(health.hotKlineStale, 1);
  assert.equal(health.hotKlineUnknown, 1, 'the forming candle is not accepted as closed');
  assert.equal(health.hotKlineMaxClosedAgeMs, 150_000);
  assert.equal(health.alert, true);
  assert.match(health.note, /超过 120 秒/);
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
