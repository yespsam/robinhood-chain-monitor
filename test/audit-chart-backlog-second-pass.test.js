import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { auditUndispatchedCharts, selectUndispatchedAuditTargets } from '../scripts/audit-chart-backlog-second-pass.js';

const NOW=Date.parse('2026-11-10T00:00:00Z'),stamp=new Date(NOW).toISOString();
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=n=>({chain:'bsc',address:'0x'+n.toString(16).padStart(40,'0'),symbol:`T${n}`,allowed:false,code:'chart_missing'});
const queued=(n,reasonCode='GMGN_REQUEST_BUSY')=>({...target(n),startedAt:stamp,rawResponse:{...target(n),
  status:'unavailable',reasonCode,candles:[],lastAttempt:{queuedAt:stamp,requestedAt:null,receivedAt:null,
    completedAt:stamp,from:null,to:null,requestWindow:null}}});
const snapshot=rows=>({version:'finite_local_chart_audit_v1',status:'complete',startedAt:stamp,completedAt:stamp,
  policy:{concurrency:1,maxAttemptsPerTarget:1},targets:rows.map(r=>target(Number.parseInt(r.address,16))),results:rows});
const candles=Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:1,high:1.1,low:0.9,close:1,volume:20}));
const source=(request,extra={})=>({status:'ok',chain:request.chain,address:request.address,resolution:'1m',
  from:NOW/1000-3600,to:NOW/1000,candles,...extra});
async function fixture(t,rows) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chart-audit-second-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const inputPath=path.join(dir,'first.json'),outputPath=path.join(dir,'second.json');
  await fs.writeFile(inputPath,JSON.stringify(snapshot(rows)));
  return {inputPath,outputPath,now:()=>NOW,onProgress:()=>{}};
}

test('only explicit never-dispatched queue failures can enter the finite second pass',()=>{
  const good=[queued(1),queued(2,'GMGN_QUEUE_EXPIRED')];
  const bad=[queued(3),queued(4),queued(5),queued(6),queued(7),queued(8),queued(9),queued(10),queued(11)];
  bad[0].rawResponse.status='ok';
  bad[1].rawResponse.lastAttempt.requestedAt=stamp;
  delete bad[2].rawResponse.lastAttempt;
  bad[3].rawResponse.reasonCode='GMGN_RATE_LIMIT';
  bad[4].rawResponse.status='stale';
  bad[5].rawResponse=null;
  bad[6].rawResponse.address=target(99).address;
  bad[7].rawResponse.from=NOW/1000-3600;
  delete bad[8].rawResponse.lastAttempt.receivedAt;
  const mixed=queued(12),dispatched=queued(12);
  dispatched.rawResponse.lastAttempt.requestedAt=stamp;
  const unbound=queued(13),input=snapshot([...good,...bad,mixed,dispatched,unbound,queued(1)]);
  input.targets=input.targets.filter(t=>t.address!==unbound.address);
  const chosen=selectUndispatchedAuditTargets(input);
  assert.deepEqual(chosen.map(t=>t.address),good.map(t=>t.address));
  assert.deepEqual(chosen.map(t=>t.retryFromReason),['GMGN_REQUEST_BUSY','GMGN_QUEUE_EXPIRED']);
  assert.equal(chosen[0].previousAuditStartedAt,stamp);
  chosen[0].symbol='mutated';assert.equal(input.targets[0].symbol,'T1');
});

test('running audits, second passes and more than 100 targets are refused',()=>{
  for(const patch of [{status:'running'},{completedAt:null},{version:'other'},
    {policy:{auditPass:2}},{policy:{transport:'shared_readonly_candidate'}}]) {
    assert.throws(()=>selectUndispatchedAuditTargets({...snapshot([queued(1)]),...patch}));
  }
  assert.equal(selectUndispatchedAuditTargets(snapshot(Array.from({length:100},(_,i)=>queued(i+1)))).length,100);
  assert.throws(()=>selectUndispatchedAuditTargets(snapshot(Array.from({length:101},(_,i)=>queued(i+1)))),/limit is 100/);
});

test('explicitly interrupted first pass selects only recorded proven queue failures',()=>{
  const input={...snapshot([queued(1)]),status:'interrupted'};
  input.targets.push(target(2),target(3));
  input.results.push({...target(2),error:'local_request_failed',rawResponse:null});
  assert.deepEqual(selectUndispatchedAuditTargets(input).map(t=>t.address),[target(1).address]);
});

test('shared candidate transport freezes input, stays serial and reuses source-boundary validation',async t=>{
  const options=await fixture(t,[queued(1),queued(2,'GMGN_QUEUE_EXPIRED'),queued(1)]);
  let active=0,maxActive=0,created=0,closed=0,clock=NOW;const calls=[];
  const report=await auditUndispatchedCharts({...options,now:()=>clock,createClient:config=>{
    created++;assert.deepEqual(config,{dataDir:path.join(project,'data'),isolated:true,ttlMs:0,timeoutMs:12000});
    return {kline:async request=>{
      active++;maxActive=Math.max(maxActive,active);calls.push(request);
      assert.equal(request.purpose,'candidate');assert.equal(request.latestClosed,true);
      assert.equal(request.resolution,'1m');assert.equal(request.to-request.from,3600);
      await fs.writeFile(options.inputPath,JSON.stringify(snapshot([queued(99)])));
      await Promise.resolve();active--;
      if(calls.length===1){clock=NOW+61000;return source(request,{candles:[...candles.slice(-12),
        {time:NOW,open:1,high:1.1,low:0.9,close:1,volume:20}]});}
      return source(request);
    },close:async()=>{closed++;}};
  }});
  assert.equal(created,1);assert.equal(closed,1);assert.equal(maxActive,1);
  assert.deepEqual(calls.map(c=>c.address),[target(1).address,target(2).address]);
  assert.equal(report.policy.auditPass,2);assert.equal(report.policy.priority,1);
  assert.equal(report.policy.injectedIntoStrategyCache,false);assert.equal(report.policy.orderExecution,false);
  assert.equal(report.targets.length,2);assert.equal(report.summary.attempted,2);
  assert.equal(report.results[0].rawResponse.candles.length,13);
  assert.equal(report.results[0].validation.sourceWindow.excludedBars,1);
  assert.equal(report.results[0].validation.diagnostics.closedBars,12);
  assert.equal(report.results[0].validation.ready,false);
  assert.equal(report.status,'complete');
  assert.throws(()=>selectUndispatchedAuditTargets(report),/cannot be retried/);
  const saved=JSON.parse(await fs.readFile(options.outputPath,'utf8'));
  assert.equal(saved.results.length,2);assert.equal(saved.inputSha256.length,64);
});

test('existing output is refused before creating a client and zero targets make no requests',async t=>{
  const options=await fixture(t,[queued(1)]);
  await fs.writeFile(options.outputPath,'operator artifact');
  await assert.rejects(auditUndispatchedCharts({...options,createClient:()=>assert.fail('must not create client')}),{code:'EEXIST'});
  assert.equal(await fs.readFile(options.outputPath,'utf8'),'operator artifact');
  const emptyOptions=await fixture(t,[]);
  const report=await auditUndispatchedCharts({...emptyOptions,createClient:()=>assert.fail('must not create client')});
  assert.equal(report.status,'complete');assert.equal(report.summary.selected,0);
});

test('one timeout closes the client and stops without a second dispatch',async t=>{
  const options=await fixture(t,[queued(1),queued(2)]);let calls=0,closed=0,hold;
  t.after(()=>clearTimeout(hold));
  const report=await auditUndispatchedCharts({...options,timeoutMs:5,createClient:()=>({
    kline:()=>{calls++;return new Promise(resolve=>{hold=setTimeout(()=>resolve(source(target(1))),500);});},
    close:async()=>{closed++;clearTimeout(hold);}
  })});
  assert.equal(calls,1);assert.equal(closed,1);assert.equal(report.status,'stopped');
  assert.equal(report.stopReason,'local_request_timeout');assert.equal(report.summary.unattempted,1);
});
