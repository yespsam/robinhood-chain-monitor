#!/usr/bin/env node
// Offline artifact comparison only: no network, runtime cache or ledger writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
import {validateChartSource} from '../src/paper-chart-source.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const minute=60000,iso=at=>new Date(at).toISOString();
const stamp=v=>typeof v==='number'?(v<1e10?v*1000:v):Date.parse(v||'');
const key=t=>`${t?.chain}:${t?.chain==='sol'?t?.address:String(t?.address||'').toLowerCase()}`;
const read=async file=>JSON.parse(await fs.readFile(path.isAbsolute(file)?file:path.join(project,file),'utf8'));
const validWindow=(from,to)=>Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&from>=0
  &&from%60===0&&to%60===0&&to-from===3600;

export function analyzeCandleWindow(candles,{from,to,observedAt=null}={}) {
  const fail=code=>({available:false,reasonCode:code});
  if(!validWindow(from,to)||!Array.isArray(candles))return fail('INVALID_WINDOW_OR_CANDLES');
  const rows=[],seen=new Set();let excludedUnclosedBars=0,excludedBeforeWindowBars=0;
  for(const c of candles) {
    const at=stamp(c?.time);
    if(!Number.isSafeInteger(at)||at%minute||![c?.open,c?.high,c?.low,c?.close].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)
      ||typeof c?.volume!=='number'||!Number.isFinite(c.volume)||c.volume<0
      ||c.high<Math.max(c.open,c.close,c.low)||c.low>Math.min(c.open,c.close))return fail('INVALID_CANDLE');
    if(seen.has(at))return fail('DUPLICATE_CANDLE');seen.add(at);
    if(at+minute>to*1000){excludedUnclosedBars++;continue;}
    if(at<from*1000){excludedBeforeWindowBars++;continue;}
    rows.push({...c,time:at});
  }
  rows.sort((a,b)=>a.time-b.time);
  let tail=rows.length?1:0;
  for(let i=rows.length-1;i>0&&rows[i].time-rows[i-1].time===minute;i--)tail++;
  const starts=new Set(rows.map(r=>r.time)),missing=[];
  for(let at=from*1000;at<to*1000;at+=minute)if(!starts.has(at))missing.push(iso(at));
  const atBoundary=opportunityChart(rows,'ok',to*1000,{contiguousTail:true});
  const observed=stamp(observedAt),atObservation=Number.isFinite(observed)&&observed>=to*1000
    ?opportunityChart(rows,'ok',observed,{contiguousTail:true}):null;
  return {available:true,rows,from,to,closedBars:rows.length,contiguousTailBars:tail,
    minuteStarts:rows.map(r=>iso(r.time)),missingMinuteStarts:missing,excludedUnclosedBars,excludedBeforeWindowBars,
    lastActualClosedAt:rows.length?iso(rows.at(-1).time+minute):null,
    lastBarBehindBoundaryMs:rows.length?to*1000-rows.at(-1).time-minute:null,
    zeroVolumeBars:rows.filter(r=>r.volume===0).length,
    atHistoricalBoundary:{ready:atBoundary.ready,diagnostic:atBoundary.diagnostics.code,usedBars:atBoundary.rows.length,
      entryThesisBarsReady:atBoundary.ready&&atBoundary.rows.length>=24},
    atOriginalObservation:atObservation?{asOf:iso(observed),ready:atObservation.ready,diagnostic:atObservation.diagnostics.code,
      usedBars:atObservation.rows.length,entryThesisBarsReady:atObservation.ready&&atObservation.rows.length>=24}:null};
}

const publicMetrics=({rows,...metrics})=>metrics;
export function compareChartWindows(primary,secondary) {
  if(!primary?.available)return {comparable:false,reasonCode:'PRIMARY_RAW_UNAVAILABLE'};
  if(!secondary?.available)return {comparable:false,reasonCode:'SECONDARY_RAW_UNAVAILABLE'};
  if(primary.from!==secondary.from||primary.to!==secondary.to)return {comparable:false,reasonCode:'UTC_WINDOW_MISMATCH'};
  const p=new Map(primary.rows.map(r=>[r.time,r])),s=new Map(secondary.rows.map(r=>[r.time,r]));
  const common=[...p.keys()].filter(at=>s.has(at));
  const difference=common.map(at=>Math.abs(s.get(at).close/p.get(at).close-1));
  return {comparable:true,from:primary.from,to:primary.to,
    addedMinuteStarts:[...s.keys()].filter(at=>!p.has(at)).map(iso),
    absentFromSecondaryMinuteStarts:[...p.keys()].filter(at=>!s.has(at)).map(iso),
    overlappingMinutes:common.length,maxRelativeCloseDifference:difference.length?Math.max(...difference):null,
    primaryClosedBars:primary.closedBars,secondaryClosedBars:secondary.closedBars,
    primaryContiguousTailBars:primary.contiguousTailBars,secondaryContiguousTailBars:secondary.contiguousTailBars,
    primaryReadyAtBoundary:primary.atHistoricalBoundary.ready,secondaryReadyAtBoundary:secondary.atHistoricalBoundary.ready,
    samePoolVerified:false,
    scopeNote:'Same chain/CA and UTC window only. GMGN pool scope was not saved; a single secondary pool is not proven to have identical venue coverage. No candles are combined.'};
}

export async function reviewChartSourceBacklog({targetsPath,secondaryPath=null,currentPath=null,outputPath=null,now=Date.now}={}) {
  const frozen=await read(targetsPath);
  if(!Array.isArray(frozen.candidates)||frozen.candidates.length>100)throw Error('Expected at most 100 frozen candidates');
  const secondary=secondaryPath?await read(secondaryPath):null,current=currentPath?await read(currentPath):null;
  const secondaryRows=secondary?.results||[],currentStatus=current?.items?current:current?.catchup;
  const artifacts=new Map(),seen=new Set(),candidates=[];
  for(const target of frozen.candidates) {
    const targetKey=key(target),from=target.historicalFrom,to=target.historicalTo;
    if(seen.has(targetKey))throw Error('Duplicate frozen chain/CA');seen.add(targetKey);
    if(!validWindow(from,to))throw Error('Invalid frozen historical window');
    const observation=target.latestSuccessfulObservation||{},artifact=observation.artifact;
    let original=null,artifactError=null;
    if(artifact) {
      if(!artifacts.has(artifact)){try{artifacts.set(artifact,await read(artifact));}catch{artifacts.set(artifact,null);}}
      const doc=artifacts.get(artifact);if(!doc)artifactError='SOURCE_ARTIFACT_UNAVAILABLE';
      const matches=(doc?.results||[]).filter(r=>key(r)===targetKey&&r.sourceStatus==='ok'&&r.rawResponse?.status==='ok');
      original=matches.find(r=>r.receivedAt===observation.at)
        ||matches.find(r=>r.rawResponse.from===from&&r.rawResponse.to===to)||null;
    }
    const raw=original?.rawResponse;
    const identityMatches=raw&&key(raw)===targetKey;
    const windowMatches=raw&&raw.from===from&&raw.to===to;
    const primary=raw&&identityMatches&&windowMatches
      ?analyzeCandleWindow(raw.candles,{from,to,observedAt:observation.at})
      :{available:false,reasonCode:raw?!identityMatches?'PRIMARY_IDENTITY_MISMATCH':'PRIMARY_WINDOW_MISMATCH':artifactError||'PRIMARY_RAW_NOT_RETAINED'};
    const selected=secondaryRows.filter(r=>key(r)===targetKey&&r.from===from&&r.to===to).at(-1);
    const other=selected?.rawResponse;
    const recordedOther=secondaryRows.filter(r=>key(r)===targetKey).at(-1);
    let sourceValidation=null,backup={available:false,reasonCode:selected?.reasonCode||(!selected&&recordedOther?'SECONDARY_WINDOW_MISMATCH':'SECONDARY_NOT_RECORDED')};
    if(other?.status==='ok') {
      sourceValidation=validateChartSource(other,target,{nowMs:now()});
      backup=sourceValidation.ready&&other.from===from&&other.to===to
        ?analyzeCandleWindow(sourceValidation.candles,{from,to,observedAt:observation.at})
        :{available:false,reasonCode:sourceValidation.reasonCode||'SECONDARY_WINDOW_MISMATCH'};
    }
    const poolCreatedAt=stamp(other?.poolCreatedAt),poolCreationKnown=Number.isFinite(poolCreatedAt);
    const poolHistory={createdAt:poolCreationKnown?iso(poolCreatedAt):null,
      predatesWholeWindow:poolCreationKnown?poolCreatedAt<=from*1000:null,
      createdDuringWindow:poolCreationKnown&&poolCreatedAt>from*1000&&poolCreatedAt<to*1000,
      createdAtOrAfterWindowEnd:poolCreationKnown&&poolCreatedAt>=to*1000,
      returnedBarsEndingBeforePoolCreation:poolCreationKnown&&backup.available?backup.rows.filter(c=>c.time+minute<=poolCreatedAt).length:null};
    const comparison=compareChartWindows(primary,backup);
    comparison.secondaryPoolHistory=poolHistory;
    if(poolHistory.predatesWholeWindow===false)comparison.historyLimit='Selected pool was created after the requested historical window began. Its bars only describe that newer pool; they cannot establish complete original history.';
    const active=currentStatus?.items?.find(r=>key(r)===targetKey);
    candidates.push({chain:target.chain,address:target.address,symbol:target.symbol||'',
      historicalWindow:{from,to,fromUtc:iso(from*1000),toUtc:iso(to*1000),provenance:target.historicalWindowProvenance},
      primaryHistorical:{artifact:artifact||null,observedAt:observation.at||null,reportedDiagnostic:observation.diagnostic||null,
        reportedClosedBars:observation.closedBars??null,rawIdentityMatches:raw?!!identityMatches:null,
        rawWindowMatches:raw?!!windowMatches:null,...publicMetrics(primary)},
      secondaryHistorical:{artifact:secondaryPath,sourceStatus:selected?.sourceStatus||'not_recorded',
        reasonCode:backup.reasonCode||null,requestedAt:other?.requestedAt||null,receivedAt:other?.receivedAt||selected?.receivedAt||null,
        identityVerified:sourceValidation?.ready===true,source:other?.source||null,network:other?.network||null,
        poolId:other?.poolId||null,dexId:other?.dexId||null,tokenSide:other?.tokenSide||null,
        poolHistory,
        binding:sourceValidation?.ready?sourceValidation.provenance.binding:null,...publicMetrics(backup)},
      historicalComparison:comparison,
      currentRuntime:active?{jobId:currentStatus.id,status:active.status,attempts:active.attempts,
        completedAt:active.completedAt||null,sourceStatus:active.chartStatus||null,reasonCode:active.reasonCode||null,
        source:active.source||null,poolId:active.poolId||null,sourceDigest:active.sourceDigest||null,
        diagnostic:active.chartDiagnostic||null,ready:active.ready===true,closedBars:active.closedBars??null,
        closedThroughAt:active.closedThroughAt||null,
        scopeNote:'Current runtime observation only; no raw minutes retained here and never substituted for the historical UTC window.'}:null});
  }
  const report={version:'offline_exact_window_source_comparison_v1',generatedAt:iso(now()),targets:targetsPath,
    secondaryArtifact:secondaryPath,secondaryAuditStatus:secondary?.status||null,secondaryStopReason:secondary?.stopReason||null,
    currentArtifact:currentPath,currentJobStatus:currentStatus?.status||null,
    summary:{targets:candidates.length,primaryRawAvailable:candidates.filter(c=>c.primaryHistorical.available).length,
      secondaryRecords:secondaryRows.length,secondaryMetadataBound:secondary?.metadata?.results?.filter(r=>r.status==='ok').length||0,
      secondaryHistoricalSourceValidated:candidates.filter(c=>c.secondaryHistorical.identityVerified).length,
      exactWindowComparisons:candidates.filter(c=>c.historicalComparison.comparable).length,
      historicalSecondaryReady:candidates.filter(c=>c.secondaryHistorical.atHistoricalBoundary?.ready).length,
      secondaryPoolsCreatedAfterWindowStart:candidates.filter(c=>c.secondaryHistorical.poolHistory?.predatesWholeWindow===false).length,
      secondaryPoolHistoryContradictions:candidates.filter(c=>c.secondaryHistorical.poolHistory?.returnedBarsEndingBeforePoolCreation>0).length,
      currentRecorded:candidates.filter(c=>c.currentRuntime).length,
      currentReady:candidates.filter(c=>c.currentRuntime?.ready).length},candidates,
    limitations:['Historical readiness is retrospective and does not authorize a current trade.',
      'Missing minute sets are unknown when original raw candles were not retained; summary bar counts cannot reconstruct them.',
      'A successful source read, a chart-ready window and trade eligibility are distinct.',
      'Different pool/venue scope can explain minute and price differences; no merged series is produced.',
      'The finite secondary provider budget/rate limits can leave explicit incomplete coverage.',
      'Separate operator probes of RobinFinite registry and DexPaprika network lists returned HTTP 403; they were not bypassed.']};
  if(outputPath) {
    const out=path.resolve(outputPath),protectedData=path.join(project,'data');
    if(out===protectedData||out.startsWith(protectedData+path.sep)||[targetsPath,secondaryPath,currentPath].filter(Boolean).some(p=>path.resolve(p)===out))
      throw Error('Output must be a separate artifact outside runtime data');
    await fs.mkdir(path.dirname(out),{recursive:true});
    const temp=`${out}.${process.pid}.tmp`;
    await fs.writeFile(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});await fs.rename(temp,out);
  }
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const options={},names={'--targets':'targetsPath','--secondary':'secondaryPath','--current':'currentPath','--output':'outputPath'};
    for(let i=2;i<process.argv.length;i+=2){const name=names[process.argv[i]],value=process.argv[i+1];
      if(!name||!value||value.startsWith('--'))throw Error('Use --targets FILE [--secondary FILE] [--current FILE] --output FILE');options[name]=value;}
    if(!options.targetsPath||!options.outputPath)throw Error('--targets and --output are required');
    const report=await reviewChartSourceBacklog(options);console.log(JSON.stringify(report.summary));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
