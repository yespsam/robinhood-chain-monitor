import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { auditChartBacklog } from '../scripts/audit-chart-backlog.js';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const target = (digit,allowed=false) => ({chain:'bsc',address:'0x'+digit.repeat(40),symbol:digit,allowed,code:'chart_missing'});
const candles = Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:1,high:1.1,low:0.9,close:1,volume:20}));
const sourceWindow={resolution:'1m',from:NOW/1000-3600,to:NOW/1000};
async function fixture(t,targets) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chart-audit-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const inputPath=path.join(dir,'input.json'),outputPath=path.join(dir,'output.json');
  await fs.writeFile(inputPath,JSON.stringify({updatedAt:new Date(NOW).toISOString(),candidates:targets}));
  return {inputPath,outputPath,now:()=>NOW,onProgress:()=>{}};
}

test('excluded audit freezes targets, runs serial once per CA and preserves raw evidence',async t=>{
  const options=await fixture(t,[target('1'),target('2',true),target('3')]);
  let active=0,maxActive=0; const called=[];
  const report=await auditChartBacklog({...options,fetchImpl:async(url,init)=>{
    called.push(url.searchParams.get('address')); active++;maxActive=Math.max(maxActive,active);
    assert.equal(url.origin,'http://127.0.0.1:4173');assert.equal(url.pathname,'/api/kline');
    assert.equal(url.searchParams.get('hours'),'1');assert.equal(url.searchParams.get('resolution'),'1m');
    assert.equal(init.headers['accept-encoding'],'identity');
    await fs.writeFile(options.inputPath,JSON.stringify({candidates:[target('4')]}));
    await Promise.resolve();active--;
    return {ok:true,status:200,json:async()=>({status:'ok',chain:'bsc',address:url.searchParams.get('address'),...sourceWindow,candles})};
  }});
  assert.deepEqual(called,[target('1').address,target('3').address]);
  assert.equal(maxActive,1);assert.equal(report.summary.attempted,2);assert.equal(report.summary.chartReady,2);
  assert.equal(report.summary.entryThesisBarsReady,2);assert.equal(report.results[0].rawResponse.candles.length,30);
  assert.equal(report.status,'complete');
  const saved=JSON.parse(await fs.readFile(options.outputPath,'utf8'));assert.equal(saved.results.length,2);
  await assert.rejects(auditChartBacklog({...options,fetchImpl:()=>assert.fail('must not fetch')}),{code:'EEXIST'});
});

test('mismatched response cannot pass independent validation',async t=>{
  const options=await fixture(t,[target('1')]);
  const report=await auditChartBacklog({...options,filter:'all',fetchImpl:async()=>({ok:true,status:200,
    json:async()=>({status:'ok',chain:'bsc',address:target('2').address,...sourceWindow,candles})})});
  assert.equal(report.results[0].identityBound,false);assert.equal(report.summary.chartReady,0);
  assert.equal(report.results[0].error,'response_identity_mismatch');
});

test('late response cannot age the source unfinished candle into a closed bar',async t=>{
  const options=await fixture(t,[target('1')]);let clock=NOW;
  const rawCandles=[...candles.slice(-12),{time:NOW,open:1,high:1.1,low:0.9,close:1,volume:20}];
  const report=await auditChartBacklog({...options,now:()=>clock,fetchImpl:async()=>{
    clock=NOW+61000;
    return {ok:true,status:200,json:async()=>({status:'ok',chain:'bsc',address:target('1').address,...sourceWindow,candles:rawCandles})};
  }});
  const r=report.results[0];
  assert.equal(r.rawResponse.candles.length,13,'raw provider response is preserved');
  assert.equal(r.validation.sourceWindow.excludedBars,1);
  assert.equal(r.validation.diagnostics.closedBars,12);
  assert.equal(r.validation.diagnostics.code,'insufficient_closed_bars');
  assert.equal(r.validation.ready,false);
});

test('missing, future, unaligned or wrong-duration source windows fail closed',async t=>{
  for (const patch of [{to:undefined},{to:sourceWindow.to+60,from:sourceWindow.from+60},
    {to:sourceWindow.to-1,from:sourceWindow.from-1},{from:sourceWindow.from-60},{resolution:'5m'}]) {
    const options=await fixture(t,[target('1')]);
    const report=await auditChartBacklog({...options,fetchImpl:async()=>({ok:true,status:200,
      json:async()=>({status:'ok',chain:'bsc',address:target('1').address,...sourceWindow,...patch,candles})})});
    assert.equal(report.results[0].validation.ready,false);
    assert.equal(report.results[0].validation.diagnostics.code,'invalid_source_window');
    assert.equal(report.results[0].error,'invalid_source_window');
    assert.equal(report.results[0].rawResponse.candles.length,30);
  }
});

test('timeout stops the frozen run without retrying or moving to another CA',async t=>{
  const options=await fixture(t,[target('1'),target('2')]);let calls=0;
  const report=await auditChartBacklog({...options,timeoutMs:5,fetchImpl:async(_url,{signal})=>{
    calls++;await new Promise((resolve,reject)=>{
      const hold=setTimeout(resolve,500);
      signal.addEventListener('abort',()=>{clearTimeout(hold);reject(signal.reason);},{once:true});
    });
  }});
  assert.equal(calls,1);assert.equal(report.status,'stopped');assert.equal(report.stopReason,'local_request_timeout');
  assert.equal(report.summary.unattempted,1);assert.equal(report.summary.attempted,1);
});

test('queue rejection without a source window retains its actual reason',async t=>{
  for(const reasonCode of ['GMGN_REQUEST_BUSY','GMGN_QUEUE_EXPIRED']) {
    const options=await fixture(t,[target('1')]);
    const report=await auditChartBacklog({...options,fetchImpl:async()=>({ok:true,status:200,
      json:async()=>({status:'unavailable',chain:'bsc',address:target('1').address,reasonCode,
        reason:'gmgn_unavailable',lastAttempt:{queuedAt:new Date(NOW).toISOString(),requestedAt:null,from:null,to:null}})})});
    const r=report.results[0];
    assert.equal(r.validation.ready,false);
    assert.equal(r.validation.diagnostics.code,reasonCode);
    assert.equal(r.error,reasonCode);
    assert.equal(r.validation.sourceWindow.valid,false);
    assert.equal(report.summary.byResult[reasonCode],1);
  }
});
