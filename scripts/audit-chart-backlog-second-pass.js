#!/usr/bin/env node
// One finite retry of first-pass requests proven never dispatched upstream.
// All real reads still use the project's account gate and existing CLI config.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditChartBacklog } from './audit-chart-backlog.js';
import { createSharedReadonlyChartTransport } from './audit-chart-transport.js';
import { gmgnFlowAddress } from '../src/gmgn-flow-signal.js';

const identity=t=>`${t?.chain}:${gmgnFlowAddress(t?.chain,t?.address)}`;
const queueReasons=new Set(['GMGN_REQUEST_BUSY','GMGN_QUEUE_EXPIRED']);

export function selectUndispatchedAuditTargets(snapshot) {
  if (snapshot?.version !== 'finite_local_chart_audit_v1' || !['complete','stopped','interrupted'].includes(snapshot.status)
    || !snapshot.completedAt || !Number.isFinite(Date.parse(snapshot.completedAt))
    || !Array.isArray(snapshot.results) || !Array.isArray(snapshot.targets)) throw new Error('A completed, stopped or interrupted first-pass audit is required');
  if (snapshot.policy?.auditPass === 2 || snapshot.policy?.transport === 'shared_readonly_candidate') throw new Error('Second-pass audits cannot be retried again');
  if (snapshot.policy?.transport === 'shared_readonly_operator') throw new Error('Operator-requested audits cannot be retried automatically');
  const frozen=new Map(snapshot.targets.map(t=>[identity(t),t])),groups=new Map();
  for(const row of snapshot.results) {
    const id=identity(row);
    if(!groups.has(id))groups.set(id,[]);
    groups.get(id).push(row);
  }
  const targets=[];
  const undispatched=row=>{
    const raw=row.rawResponse,last=raw?.lastAttempt;
    return raw?.status==='unavailable' && queueReasons.has(raw.reasonCode)
      && identity(raw)===identity(row) && gmgnFlowAddress(row.chain,row.address)
      && last && last.requestedAt===null && last.from===null && last.to===null && last.receivedAt===null
      && raw.requestedAt==null && raw.from==null && raw.to==null && raw.receivedAt==null;
  };
  for(const [id,rows] of groups) {
    if(!frozen.has(id) || !rows.every(undispatched))continue;
    const prior=rows.at(-1);
    targets.push({...structuredClone(frozen.get(id)),retryFromReason:prior.rawResponse.reasonCode,
      previousAttemptStartedAt:prior.startedAt,previousAuditStartedAt:snapshot.startedAt});
  }
  if(targets.length>100)throw new Error('Second-pass target limit is 100; supply a smaller first-pass audit');
  return targets;
}

export async function auditUndispatchedCharts({inputPath,outputPath,timeoutMs=120000,now=Date.now,
  onProgress=console.log,createClient}={}) {
  const {fetchImpl,close}=createSharedReadonlyChartTransport({now,createClient});
  try {
    return await auditChartBacklog({inputPath,outputPath,timeoutMs,now,onProgress,filter:'all',
      selectTargets:selectUndispatchedAuditTargets,transport:'shared_readonly_candidate',fetchImpl});
  } finally {await close();}
}

const help=`Finite second-pass chart audit (read-only)\n\nnode scripts/audit-chart-backlog-second-pass.js --input /path/finished-first-pass.json --output /path/new-second-pass.json [--timeout-ms 120000]\n\nSelects only explicit BUSY/QUEUE_EXPIRED failures with no upstream dispatch. At most 100 frozen CAs, one serial attempt each, candidate priority through the existing shared account gate. No third pass, orders, strategy-cache writes or overwrite.\n`;
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--help')||process.argv.includes('-h'))console.log(help);
  else try {
    const args={},names={'--input':'inputPath','--output':'outputPath','--timeout-ms':'timeoutMs'};
    for(let i=2;i<process.argv.length;i+=2){const name=names[process.argv[i]],value=process.argv[i+1];
      if(!name||!value||value.startsWith('--'))throw new Error('Invalid argument; use --help');
      args[name]=name==='timeoutMs'?Number(value):value;
    }
    const report=await auditUndispatchedCharts(args);
    console.log(JSON.stringify({status:report.status,output:path.resolve(args.outputPath),...report.summary}));
    if(report.status!=='complete')process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
