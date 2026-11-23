import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWindow, patternAtLimits, evaluateRecord, analyzeArchivedAudits } from '../scripts/audit-entry-policy.js';
import { opportunityChart, structurePattern } from '../src/paper-opportunity-policy.js';

const now=1800000000000,minute=60000;
const candles=n=>Array.from({length:n},(_,i)=>({time:now-(n-i)*minute,open:1,high:1.01,low:.99,close:1,volume:100}));

test('offline baseline follows production integrity and freshness without mutating inputs',()=>{
  const rows=candles(30),gap=rows.filter((_,i)=>i!==10),duplicate=[...rows.slice(0,-1),rows.at(-2)];
  const invalid=structuredClone(rows);invalid[0].high=.5;
  for(const [data,status,at] of [[rows,'ok',now],[rows,'unavailable',now],[rows,'ok',now+91000],[gap,'ok',now],[duplicate,'ok',now],[invalid,'ok',now]]) {
    const before=JSON.stringify(data),live=opportunityChart(data,status,at,{contiguousTail:true}),offline=inspectWindow(data,status,at);
    assert.equal(offline.ready,live.ready);assert.equal(offline.code,live.diagnostics.code);assert.equal(JSON.stringify(data),before);
  }
});

test('age and post-gap counterfactuals preserve source clocks and still exclude unfinished candles',()=>{
  const rows=candles(30).filter((_,i)=>i!==10),before=JSON.stringify(rows);
  assert.equal(inspectWindow(rows,'ok',now).code,'insufficient_contiguous_tail');
  const relaxed=inspectWindow(rows,'ok',now,{postGapMin:13});
  assert.equal(relaxed.rows.length,19);assert.equal(relaxed.rows.at(-1).time,now-minute);
  assert.equal(inspectWindow(candles(30),'ok',now+91000).ready,false);
  assert.equal(inspectWindow(candles(30),'ok',now+91000,{maxAgeMs:120000}).ready,true);
  assert.equal(inspectWindow([...candles(30),{...candles(1)[0],time:now}],'ok',now).rows.length,30);
  assert.equal(JSON.stringify(rows),before);
});

test('volume sensitivity changes only the selected breakout predicate and never supplies a quote',()=>{
  const rows=candles(30);rows.at(-1).open=1.01;rows.at(-1).close=1.02;rows.at(-1).high=1.02;rows.at(-1).volume=130;
  const chart=opportunityChart(rows,'ok',now,{contiguousTail:true});
  assert.equal(patternAtLimits('external_breakout',chart,1.02).ready,structurePattern({id:'external_breakout'},chart,1.02,true).ready);
  assert.equal(patternAtLimits('external_breakout',chart,1.02).ready,false);
  assert.equal(patternAtLimits('external_breakout',chart,1.02,{breakoutVolume:1.2}).ready,true);
  assert.equal(patternAtLimits('external_breakout',chart,.99,{breakoutVolume:1.2}).ready,false);
  const record=evaluateRecord({candles:rows,status:'ok',nowMs:now,price:1.02},{breakoutVolume:1.2});
  assert.equal(record.shapeAndEconomics,false);assert.equal(record.routes[0].economicsReady,null);
});

test('archived audit uses source request boundary even when response arrives after unfinished candle closes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-audit-test-')),file=path.join(dir,'source.json');
  const raw={status:'ok',chain:'bsc',address:'0x'+'1'.repeat(40),from:(now-3600000)/1000,to:now/1000,
    receivedAt:new Date(now+61000).toISOString(),candles:[...candles(12),{...candles(1)[0],time:now}]};
  fs.writeFileSync(file,JSON.stringify({results:[{chain:raw.chain,address:raw.address,identityBound:true,receivedAt:raw.receivedAt,
    validation:{sourceWindow:{valid:true}},rawResponse:raw}]}));
  try {const result=analyzeArchivedAudits([file]);assert.equal(result.uniqueSourceObservations,1);assert.equal(result.sensitivity[0].windowReady,0);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
