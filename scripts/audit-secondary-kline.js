#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createGeckoTerminalMarketClient,GECKO_NETWORKS} from '../src/geckoterminal-market.js';
import {gmgnFlowAddress} from '../src/gmgn-flow-signal.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
import {validateChartSource} from '../src/paper-chart-source.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const iso=at=>new Date(at).toISOString();
const key=t=>`${t.chain}:${gmgnFlowAddress(t.chain,t.address)}`;
const stopCodes=new Set(['GT_RATE_LIMITED','GT_COOLDOWN','GT_REQUEST_TIMEOUT','GT_NETWORK_FAILED','GT_STOPPED','GT_STATE_INVALID','GT_UPSTREAM_FAILED']);

export async function auditSecondaryKline({inputPath,outputPath,now=Date.now,onProgress=console.log,
  createClient=createGeckoTerminalMarketClient}={}) {
  if(!inputPath||!outputPath)throw new Error('Input and new output paths are required');
  const input=path.resolve(inputPath),output=path.resolve(outputPath),dataDir=path.join(project,'data');
  if(input===output||output===dataDir||output.startsWith(dataDir+path.sep))throw new Error('Audit output must be separate from input and strategy data');
  const inputText=await fs.readFile(input,'utf8'),snapshot=JSON.parse(inputText);
  if(!Array.isArray(snapshot.candidates))throw new Error('Frozen candidates are required');
  const targets=[],seen=new Set();
  for(const t of snapshot.candidates) {
    if(!GECKO_NETWORKS[t.chain]||!gmgnFlowAddress(t.chain,t.address)||![t.historicalFrom,t.historicalTo].every(Number.isSafeInteger)
      ||t.historicalFrom<0||t.historicalFrom%60||t.historicalTo%60||t.historicalTo-t.historicalFrom!==3600
      ||t.historicalTo*1000>now()||typeof t.historicalWindowProvenance!=='string'||!t.historicalWindowProvenance)
      throw new Error('Invalid frozen identity or explicit historical window');
    if(!seen.has(key(t))){seen.add(key(t));targets.push(structuredClone(t));}
  }
  if(targets.length>100)throw new Error('Finite audit limit is100 CAs');
  const report={version:'finite_secondary_kline_audit_v1',input,inputSha256:createHash('sha256').update(inputText).digest('hex'),
    frozenAt:snapshot.frozenAt||null,startedAt:iso(now()),completedAt:null,status:'running',
    policy:{provider:'geckoterminal',concurrency:1,minIntervalMs:30000,maxTargets:100,maxPoolsPerTarget:1,maxOhlcvAttemptsPerTarget:1,
      metadataBatchSize:30,historicalOnly:true,automaticRetries:false,includeEmptyIntervals:false,inferredBars:0,
      injectedIntoStrategyCache:false,orderExecution:false},targets,metadata:null,results:[],
    note:'Historical source comparison at each frozen window boundary. Readiness here is not current readiness or trading admission.'};
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  const save=async()=>{const temp=`${output}.${process.pid}.tmp`;await fs.writeFile(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});await fs.rename(temp,output);};
  let client;
  try {
    if(targets.length) {
      client=createClient({dataDir,metadataTtlMs:3600000});
      report.metadata=await client.prefetchPools({targets,includeInactiveSource:true});
      await save();
      onProgress(`[metadata] ${report.metadata.status} bound=${report.metadata.results?.filter(r=>r.status==='ok').length||0}/${targets.length}`);
      if(report.metadata.status!=='ok'){report.status='stopped';report.stopReason=report.metadata.reasonCode;}
    }
    const bindings=new Map((report.metadata?.results||[]).map(t=>[key(t),t]));
    if(report.status==='running')for(const [index,target] of targets.entries()) {
      const startedAt=now(),binding=bindings.get(key(target));
      const raw=binding?.status==='ok'?await client.kline({chain:target.chain,address:target.address,resolution:'1m',
        from:target.historicalFrom,to:target.historicalTo,latestClosed:false,waitForSlot:true,frozenPoolId:binding.poolId})
        :binding||{status:'unavailable',source:'geckoterminal',reasonCode:'GT_METADATA_MISSING',candles:[]};
      const receivedAt=now(),bound=raw.chain===target.chain&&gmgnFlowAddress(raw.chain,raw.address)===gmgnFlowAddress(target.chain,target.address);
      const windowMatches=raw.from===target.historicalFrom&&raw.to===target.historicalTo;
      const trusted=validateChartSource(raw,target,{nowMs:receivedAt});
      const checked=opportunityChart(trusted.candles,trusted.ready&&windowMatches?'ok':'unavailable',target.historicalTo*1000,{contiguousTail:true});
      const reasonCode=raw.status!=='ok'?raw.reasonCode||'GT_UNAVAILABLE':!trusted.ready?trusted.reasonCode:!windowMatches?'GT_WINDOW_MISMATCH':null;
      const primary=target.latestSuccessfulObservation||{};
      const row={chain:target.chain,address:target.address,symbol:target.symbol||'',from:target.historicalFrom,to:target.historicalTo,
        windowProvenance:target.historicalWindowProvenance,startedAt:iso(startedAt),receivedAt:iso(receivedAt),durationMs:receivedAt-startedAt,
        sourceStatus:raw.status,reasonCode,identityBound:bound,windowMatches,rawResponse:raw,
        sourceValidation:{valid:trusted.ready,reasonCode:trusted.reasonCode,provenance:trusted.provenance},
        validation:{asOfHistoricalWindowTo:iso(target.historicalTo*1000),ready:checked.ready,diagnostics:checked.diagnostics,
          validatedBars:checked.rows.length,entryThesisBarsReady:checked.ready&&checked.rows.length>=24},
        qualityComparison:{primaryDiagnostic:primary.diagnostic||null,primaryClosedBars:primary.closedBars??null,
          primaryObservedAt:primary.at||null,secondaryDiagnostic:reasonCode||checked.diagnostics?.code,
          secondaryClosedBars:checked.diagnostics?.closedBars??0,readinessChanged:typeof primary.ready==='boolean'?checked.ready!==primary.ready:null,
          comparisonLimit:'Different provider and potentially different pool; no proof of token-wide no-trade intervals.'}};
      report.results.push(row);
      if(stopCodes.has(reasonCode)){report.status='stopped';report.stopReason=reasonCode;}
      await save();onProgress(`[${index+1}/${targets.length}] ${target.chain} ${target.symbol||target.address} ${reasonCode||checked.diagnostics?.code} bars=${checked.diagnostics?.closedBars||0}`);
      if(report.status==='stopped')break;
    }
  } finally {await client?.close();}
  if(report.status==='running')report.status='complete';
  report.completedAt=iso(now());
  report.summary={selected:targets.length,recorded:report.results.length,unrecorded:targets.length-report.results.length,
    sourceResponsesOk:report.results.filter(r=>r.sourceStatus==='ok').length,
    trustedSourceValid:report.results.filter(r=>r.sourceValidation.valid&&r.windowMatches).length,
    historicalChartReady:report.results.filter(r=>r.validation.ready).length,
    historicalThesisBarsReady:report.results.filter(r=>r.validation.entryThesisBarsReady).length,
    byResult:Object.fromEntries([...new Set(report.results.map(r=>r.reasonCode||r.validation.diagnostics?.code))]
      .map(c=>[c,report.results.filter(r=>(r.reasonCode||r.validation.diagnostics?.code)===c).length]))};
  await save();return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--help'))console.log('node scripts/audit-secondary-kline.js --input frozen-historical-targets.json --output new-audit.json\nOne frozen historical window and one pool per CA; sparse data only,30s shared pacing, no automatic retry.');
  else try {
    const args={},names={'--input':'inputPath','--output':'outputPath'};
    for(let i=2;i<process.argv.length;i+=2){const name=names[process.argv[i]],value=process.argv[i+1];if(!name||!value||value.startsWith('--'))throw new Error('Invalid arguments');args[name]=value;}
    const report=await auditSecondaryKline(args);console.log(JSON.stringify({status:report.status,...report.summary}));if(report.status!=='complete')process.exitCode=1;
  }catch(e){console.error(e.message);process.exitCode=1;}
}
