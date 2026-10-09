import test from 'node:test';
import assert from 'node:assert/strict';
import {detailGapRetry, waitsForChartTurn,reserveHotChartTurn} from '../src/paper-research-budget.js';
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

test('hot deadlines may reserve only two chart turns, never raising priority or keeping obsolete demand',()=>{
  const p={demand:{selectedAt:100000,closedAtMs:40000,token:{researchLane:'hot'}},nowMs:100001,listed:true,due:true,chartsSinceDetail:1};
  const before=structuredClone(p);assert.equal(reserveHotChartTurn(p),true);assert.deepEqual(p,before);
  for(const patch of [{chartsSinceDetail:2},{listed:false},{due:false},{nowMs:110001},{nowMs:99999},{demand:null},
    {demand:{...p.demand,closedAtMs:50000}},{demand:{...p.demand,closedAtMs:null}},
    {demand:{...p.demand,token:{researchLane:'discovery'}}}])assert.equal(reserveHotChartTurn({...p,...patch}),false);
});
