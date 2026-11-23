#!/usr/bin/env node
// One operator-requested source audit. Never constructs retry provenance.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditChartBacklog } from './audit-chart-backlog.js';
import { createSharedReadonlyChartTransport } from './audit-chart-transport.js';
import { gmgnFlowAddress } from '../src/gmgn-flow-signal.js';

export function selectOperatorAuditTargets(snapshot) {
  if(!Array.isArray(snapshot?.candidates))throw new Error('A frozen candidates array is required');
  const unique=new Set(snapshot.candidates.map(t=>`${t.chain}:${gmgnFlowAddress(t.chain,t.address)}`));
  if(unique.size>100)throw new Error('Operator audit target limit is 100');
  return snapshot.candidates;
}

export async function auditOperatorCharts({inputPath,outputPath,timeoutMs=120000,now=Date.now,
  onProgress=console.log,createClient}={}) {
  const {fetchImpl,close}=createSharedReadonlyChartTransport({now,createClient});
  try {
    return await auditChartBacklog({inputPath,outputPath,timeoutMs,now,onProgress,filter:'all',
      selectTargets:selectOperatorAuditTargets,transport:'shared_readonly_operator',fetchImpl});
  } finally {await close();}
}

const help=`Operator-requested finite source audit (read-only)\n\nnode scripts/audit-chart-operator.js --input /path/frozen-targets.json --output /path/new-audit.json [--timeout-ms 120000]\n\nAt most 100 frozen CAs, one serial attempt each, priority 1 through the existing shared account gate. No automatic retry, orders, strategy-cache writes or overwrite. This is an independent audit, not a second pass.\n`;
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--help')||process.argv.includes('-h'))console.log(help);
  else try {
    const args={},names={'--input':'inputPath','--output':'outputPath','--timeout-ms':'timeoutMs'};
    for(let i=2;i<process.argv.length;i+=2){const name=names[process.argv[i]],value=process.argv[i+1];
      if(!name||!value||value.startsWith('--'))throw new Error('Invalid argument; use --help');
      args[name]=name==='timeoutMs'?Number(value):value;
    }
    const report=await auditOperatorCharts(args);
    console.log(JSON.stringify({status:report.status,output:path.resolve(args.outputPath),...report.summary}));
    if(report.status!=='complete')process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
