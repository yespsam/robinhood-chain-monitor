import test from 'node:test';
import assert from 'node:assert/strict';
import {detailGapRetry, waitsForChartTurn,reserveHotChartTurn,chartPullBudget,quoteBlocksChartBudget} from '../src/paper-research-budget.js';
import {missingRequestedDetailFields} from '../src/paper-candidate-research.js';

test('unchanged missing response fields use bounded backoff and progress resets it without mutating evidence',()=>{
  let state=null,at=100000;
  for(const delay of [60000,120000,240000,480000,600000,600000]) {
    const before=structuredClone(state);const next=detailGapRetry(state,['洗量检测','撤池风险比','洗量检测'],at);
    assert.equal(next.nextAttemptAt-at,delay);assert.deepEqual(state,before);state=next;at=next.nextAttemptAt;
  }
  assert.equal(detailGapRetry(state,['撤池风险比'],at).attempts,1);
  assert.equal(detailGapRetry(state,[],at),null);
  const token={isWashTrading:false,rugRatio:0,buyTax:0,sellTax:null,marketStage:'internal'};
  const before=structuredClone(token);
  assert.deepEqual(missingRequestedDetailFields(token,['洗量检测','撤池风险比','买入税','卖出税','已核实内外盘阶段','两分钟内的真实行情']),['卖出税']);
  assert.deepEqual(token,before);
});

test('reserved chart turn is queue-free and released for delisted, fresh, expired or future demand',()=>{
  const p={lastKind:'details',demand:{selectedAt:1000},nowMs:1001,listed:true,due:true};
  assert.equal(waitsForChartTurn(p),true);
  for(const patch of [{lastKind:'chart'},{listed:false},{due:false},{nowMs:11001},{nowMs:999},{demand:null}])
    assert.equal(waitsForChartTurn({...p,...patch}),false);
});

test('chart budget raises hot pulls on Plus and yields during an admitted quote without accepting unsafe env',()=>{
  const plus={plan:'plus',normalConcurrency:2},free={plan:'free',normalConcurrency:1};
  const hot=chartPullBudget({policy:plus,higherFrequency:true});
  assert.equal(hot.concurrency,3);assert.equal(hot.perRound,3);assert.equal(hot.dispatchIntervalMs,1500);
  assert.equal(hot.focusedExploratory,3);assert.equal(hot.maxChartsBeforeDetail,4);assert.equal(hot.cacheLimit,240);
  const quiet=chartPullBudget({policy:free});
  assert.equal(quiet.concurrency,1);assert.equal(quiet.perRound,1);assert.equal(quiet.dispatchIntervalMs,5000);
  assert.equal(quiet.maxChartsBeforeDetail,2);assert.equal(quiet.cacheLimit,160);
  const plusQuiet=chartPullBudget({policy:plus});
  assert.equal(plusQuiet.concurrency,2);assert.equal(plusQuiet.perRound,2);assert.equal(plusQuiet.dispatchIntervalMs,2500);
  const yielded=chartPullBudget({policy:plus,higherFrequency:true,entryFocused:true,candidateQuoteInFlight:true});
  assert.equal(yielded.concurrency,1);assert.equal(yielded.perRound,1);assert.equal(yielded.yielded,true);
  const tuned=chartPullBudget({policy:plus,higherFrequency:true,env:{PAPER_CHART_CONCURRENCY:'4',PAPER_CHART_PER_ROUND:'5',PAPER_CHART_CACHE_LIMIT:'400'}});
  assert.equal(tuned.concurrency,4);assert.equal(tuned.perRound,5);assert.equal(tuned.cacheLimit,400);
  const ignored=chartPullBudget({policy:free,env:{PAPER_CHART_CONCURRENCY:'0',PAPER_CHART_PER_ROUND:'99',PAPER_CHART_DISPATCH_INTERVAL_MS:'fast'}});
  assert.equal(ignored.concurrency,quiet.concurrency);assert.equal(ignored.perRound,quiet.perRound);
  assert.equal(ignored.dispatchIntervalMs,quiet.dispatchIntervalMs);
});

test('research-only hot quotes do not collapse the chart budget',()=>{
  assert.equal(quoteBlocksChartBudget({purpose:'candidate',token:{researchOnly:true}}),false);
  assert.equal(quoteBlocksChartBudget({purpose:'candidate',token:{researchOnly:false}}),true);
  assert.equal(quoteBlocksChartBudget({purpose:'exit',token:{}}),false);
  assert.equal(quoteBlocksChartBudget({purpose:'candidate'}),true);
});

test('hot deadlines may reserve only two chart turns, never raising priority or keeping obsolete demand',()=>{
  const p={demand:{selectedAt:100000,closedAtMs:40000,token:{researchLane:'hot'}},nowMs:100001,listed:true,due:true,chartsSinceDetail:1};
  const before=structuredClone(p);assert.equal(reserveHotChartTurn(p),true);assert.deepEqual(p,before);
  for(const patch of [{chartsSinceDetail:2},{listed:false},{due:false},{nowMs:110001},{nowMs:99999},{demand:null},
    {demand:{...p.demand,closedAtMs:50000}},{demand:{...p.demand,closedAtMs:null}},
    {demand:{...p.demand,token:{researchLane:'discovery'}}}])assert.equal(reserveHotChartTurn({...p,...patch}),false);
  assert.equal(reserveHotChartTurn({...p,chartsSinceDetail:3,maxCharts:4}),true);
  assert.equal(reserveHotChartTurn({...p,chartsSinceDetail:4,maxCharts:4}),false);
});
