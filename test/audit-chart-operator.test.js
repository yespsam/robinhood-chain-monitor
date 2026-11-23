import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { auditOperatorCharts, selectOperatorAuditTargets } from '../scripts/audit-chart-operator.js';
import { selectUndispatchedAuditTargets } from '../scripts/audit-chart-backlog-second-pass.js';

const NOW=Date.parse('2026-11-10T00:00:00Z');
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=n=>({chain:'bsc',address:'0x'+n.toString(16).padStart(40,'0'),symbol:`T${n}`,allowed:false});
const candles=Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:1,high:1.1,low:0.9,close:1,volume:20}));
async function fixture(t,targets) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chart-audit-operator-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const inputPath=path.join(dir,'input.json'),outputPath=path.join(dir,'output.json');
  await fs.writeFile(inputPath,JSON.stringify({updatedAt:new Date(NOW).toISOString(),candidates:targets}));
  return {inputPath,outputPath,now:()=>NOW,onProgress:()=>{}};
}

test('operator audit freezes unique targets and records an independent priority-1 source audit',async t=>{
  const options=await fixture(t,[target(1),target(2),target(1)]);
  let active=0,maxActive=0,created=0,closed=0;const calls=[];
  const report=await auditOperatorCharts({...options,createClient:config=>{
    created++;assert.deepEqual(config,{dataDir:path.join(project,'data'),isolated:true,ttlMs:0,timeoutMs:12000});
    return {kline:async request=>{
      calls.push(request);active++;maxActive=Math.max(maxActive,active);
      assert.equal(request.purpose,'candidate');assert.equal(request.latestClosed,true);
      assert.equal(request.resolution,'1m');assert.equal(request.to-request.from,3600);
      await fs.writeFile(options.inputPath,JSON.stringify({candidates:[target(99)]}));active--;
      return {...request,status:'ok',candles};
    },close:async()=>{closed++;}};
  }});
  assert.equal(created,1);assert.equal(closed,1);assert.equal(maxActive,1);
  assert.deepEqual(calls.map(r=>r.address),[target(1).address,target(2).address]);
  assert.equal(report.policy.transport,'shared_readonly_operator');
  assert.equal(report.policy.selection,'operator_requested_source_audit');
  assert.equal(report.policy.priority,1);assert.equal(report.policy.auditPass,1);
  assert.equal(report.policy.maxAttemptsPerTarget,1);assert.equal(report.policy.automaticRetries,false);
  assert.equal(report.policy.orderExecution,false);assert.equal(report.policy.injectedIntoStrategyCache,false);
  assert.equal(report.summary.chartReady,2);
  assert.equal(report.targets[0].retryFromReason,undefined);
  assert.throws(()=>selectUndispatchedAuditTargets(report),/cannot be retried automatically/);
});

test('100-target bound, identity and output validation happen before creating a client',async t=>{
  assert.throws(()=>selectOperatorAuditTargets({results:[]}),/frozen candidates/);
  assert.equal(selectOperatorAuditTargets({candidates:Array.from({length:100},(_,i)=>target(i+1))}).length,100);
  const tooMany=await fixture(t,Array.from({length:101},(_,i)=>target(i+1)));
  await assert.rejects(auditOperatorCharts({...tooMany,createClient:()=>assert.fail('no client')}),/limit is 100/);
  const invalid=await fixture(t,[{chain:'sol',address:'invalid'}]);
  await assert.rejects(auditOperatorCharts({...invalid,createClient:()=>assert.fail('no client')}),/Invalid frozen target/);
  const existing=await fixture(t,[target(1)]);await fs.writeFile(existing.outputPath,'preserved');
  await assert.rejects(auditOperatorCharts({...existing,createClient:()=>assert.fail('no client')}),{code:'EEXIST'});
  assert.equal(await fs.readFile(existing.outputPath,'utf8'),'preserved');
});

test('operator timeout stops after one dispatch and awaits the shared client drain',async t=>{
  const options=await fixture(t,[target(1),target(2)]);let calls=0,closed=0,drained=false,hold;
  t.after(()=>clearTimeout(hold));
  const report=await auditOperatorCharts({...options,timeoutMs:5,createClient:()=>({
    kline:()=>{calls++;return new Promise(resolve=>{hold=setTimeout(resolve,500);});},
    close:async()=>{closed++;clearTimeout(hold);await new Promise(resolve=>setTimeout(resolve,10));drained=true;}
  })});
  assert.equal(calls,1);assert.equal(closed,1);assert.equal(drained,true);
  assert.equal(report.status,'stopped');assert.equal(report.stopReason,'local_request_timeout');
  assert.equal(report.summary.unattempted,1);
});

test('operator audit records queue failure once and performs no automatic retry',async t=>{
  const options=await fixture(t,[target(1)]);let calls=0;
  const report=await auditOperatorCharts({...options,createClient:()=>({
    kline:async request=>{calls++;return {chain:request.chain,address:request.address,status:'unavailable',
      reasonCode:'GMGN_REQUEST_BUSY',lastAttempt:{requestedAt:null,receivedAt:null,from:null,to:null}};},close:async()=>{}
  })});
  assert.equal(calls,1);assert.equal(report.status,'complete');
  assert.equal(report.results[0].validation.diagnostics.code,'GMGN_REQUEST_BUSY');
  assert.throws(()=>selectUndispatchedAuditTargets(report),/cannot be retried automatically/);
});
