#!/usr/bin/env node
// Finite read-only audit. Uses the dashboard's existing GMGN client and gate;
// it never writes the strategy chart cache, account, settings or order ledger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { opportunityChart } from '../src/paper-opportunity-policy.js';
import { gmgnFlowAddress } from '../src/gmgn-flow-signal.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iso = at => new Date(at).toISOString();
const key = target => `${target.chain}:${gmgnFlowAddress(target.chain,target.address)}`;
const candleTime = value => typeof value === 'number' ? (value < 1e10 ? value * 1000 : value) : Date.parse(value || '');

export async function auditChartBacklog({ inputPath, outputPath, filter = 'excluded', port = 4173,
  timeoutMs = 120000, fetchImpl = fetch, now = Date.now, onProgress = console.log,
  selectTargets = null, transport = 'local_dashboard' } = {}) {
  if (!inputPath || !outputPath || !['excluded','allowed','all'].includes(filter)) throw new Error('Input, output and a valid filter are required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid localhost port');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Timeout must be 1–120000 ms');
  const input = path.resolve(inputPath), output = path.resolve(outputPath);
  const protectedData = path.join(project,'data');
  if (output === input || output === protectedData || output.startsWith(protectedData + path.sep)) throw new Error('Output must be a separate audit artifact outside strategy data');
  // Load once before the first request. Candidate churn cannot grow this run.
  const text = await fs.readFile(input,'utf8'), snapshot = JSON.parse(text);
  if (selectTargets !== null && typeof selectTargets !== 'function') throw new Error('Invalid target selector');
  if (!['local_dashboard','shared_readonly_candidate','shared_readonly_operator'].includes(transport)) throw new Error('Invalid audit transport');
  if (!selectTargets && !Array.isArray(snapshot.candidates)) throw new Error('Input must contain a frozen candidates array');
  const selected = selectTargets ? selectTargets(snapshot)
    : snapshot.candidates.filter(t => filter === 'all' || t.allowed === (filter === 'allowed'));
  if (!Array.isArray(selected)) throw new Error('Invalid frozen targets');
  const seen = new Set(), targets = [];
  for (const target of selected) {
    if (!['bsc','sol','robinhood','base','eth'].includes(target.chain) || !gmgnFlowAddress(target.chain,target.address)) throw new Error('Invalid frozen target identity');
    if (!seen.has(key(target))) { seen.add(key(target)); targets.push(structuredClone(target)); }
  }
  const report = { version:'finite_local_chart_audit_v1', input, inputSha256:createHash('sha256').update(text).digest('hex'),
    snapshotAt:snapshot.updatedAt || snapshot.snapshotAt || null, filter, startedAt:iso(now()), completedAt:null, status:'running',
    policy:{concurrency:1,maxAttemptsPerTarget:1,timeoutMs,resolution:'1m',hours:1,automaticRetries:false,
      transport,auditPass:transport==='shared_readonly_candidate'?2:1,
      ...(transport==='shared_readonly_candidate'?{selection:'explicitly_undispatched_queue_failures',maxTargets:100,priority:1,latestClosed:true}:{}),
      ...(transport==='shared_readonly_operator'?{selection:'operator_requested_source_audit',maxTargets:100,priority:1,latestClosed:true}:{}),
      injectedIntoStrategyCache:false,orderExecution:false}, targets, results:[],
    note:'Audit-only source snapshots. Raw chart availability and valid bars do not establish a trading signal or admission.' };
  await fs.mkdir(path.dirname(output),{recursive:true});
  // Never overwrite an existing operator artifact on starting a new run.
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  const save = async () => {
    const temp = `${output}.${process.pid}.tmp`;
    await fs.writeFile(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    await fs.rename(temp,output);
  };
  for (const [index,target] of targets.entries()) {
    const startedAt = now(), url = new URL(`http://127.0.0.1:${port}/api/kline`);
    for (const [name,value] of Object.entries({chain:target.chain,address:target.address,resolution:'1m',hours:'1'})) url.searchParams.set(name,value);
    const row = {chain:target.chain,address:target.address,symbol:target.symbol || '',originalCode:target.code,
      originalAllowed:target.allowed,attempt:1,startedAt:iso(startedAt),receivedAt:null,httpStatus:null,
      sourceStatus:'unavailable',rawResponse:null,identityBound:false,validation:null,error:null};
    let stopReason = null;
    try {
      const response = await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs),cache:'no-store',headers:{'accept-encoding':'identity'}});
      row.httpStatus = response.status;
      const raw = await response.json(), receivedAt = now();
      row.rawResponse = raw;
      row.receivedAt = iso(receivedAt);
      row.sourceStatus = raw?.status || 'unavailable';
      row.identityBound = raw?.chain === target.chain && gmgnFlowAddress(raw.chain,raw.address) === gmgnFlowAddress(target.chain,target.address);
      const sourceErrorCode = raw?.status !== 'ok' && typeof raw?.reasonCode === 'string'
        && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw.reasonCode) ? raw.reasonCode : null;
      // A provider may include its currently open candle. Network/queue delay
      // must not turn that partial bar into a closed source observation.
      const sourceWindowValid = raw?.resolution === '1m' && Number.isSafeInteger(raw.from) && Number.isSafeInteger(raw.to)
        && raw.from >= 0 && raw.from % 60 === 0 && raw.to % 60 === 0 && raw.to - raw.from === 3600
        && raw.to * 1000 <= receivedAt;
      const rawCandles = Array.isArray(raw?.candles) ? raw.candles : [];
      const closedCandles = sourceWindowValid ? rawCandles.filter(candle => {
        const at = candleTime(candle.time);
        return !Number.isFinite(at) || at >= raw.from * 1000 && at + 60000 <= raw.to * 1000;
      }) : [];
      const checked = opportunityChart(closedCandles,row.identityBound && sourceWindowValid && response.ok ? raw?.status : 'unavailable',receivedAt,{contiguousTail:true});
      row.validation = {checkedAt:iso(receivedAt),ready:checked.ready,
        reason:raw?.status !== 'ok' ? sourceErrorCode || raw?.reason || checked.reason || null : checked.reason || null,
        sourceWindow:{valid:sourceWindowValid,from:raw?.from ?? null,to:raw?.to ?? null,
          excludedBars:sourceWindowValid ? rawCandles.length - closedCandles.length : null},
        diagnostics:raw?.status !== 'ok' ? {...checked.diagnostics,code:sourceErrorCode || 'source_unavailable'}
          : sourceWindowValid ? checked.diagnostics : {...checked.diagnostics,code:'invalid_source_window'},
        entryThesisBarsReady:checked.ready && checked.rows.length >= 24,
        validatedBars:checked.rows.length};
      if (sourceErrorCode) row.error = sourceErrorCode;
      else if (!response.ok) row.error = `local_http_${response.status}`;
      else if (!row.identityBound) row.error = 'response_identity_mismatch';
      else if (raw?.status === 'ok' && !sourceWindowValid) row.error = 'invalid_source_window';
      if (response.status === 429 || response.status >= 500 || response.status === 404) stopReason = row.error;
      if (/RATE_LIMIT|COOLDOWN/.test(String(raw?.reasonCode || ''))) stopReason = String(raw.reasonCode);
    } catch (error) {
      row.receivedAt = iso(now());
      row.error = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'local_request_timeout' : 'local_request_failed';
      // An aborted client cannot prove the server's queued request was canceled.
      // Stop rather than issue a second request while that work may still exist.
      stopReason = row.error;
    }
    row.durationMs = Math.max(0,now()-startedAt);
    report.results.push(row);
    if (stopReason) { report.status='stopped'; report.stopReason=stopReason; }
    await save();
    onProgress(`[${index+1}/${targets.length}] ${target.chain} ${target.symbol || target.address} ${row.validation?.diagnostics?.code || row.error || row.sourceStatus} bars=${row.validation?.diagnostics?.closedBars ?? 0} ${row.durationMs}ms`);
    if (stopReason) break;
  }
  if (report.status === 'running') report.status='complete';
  report.completedAt=iso(now());
  report.summary={selected:targets.length,attempted:report.results.length,unattempted:targets.length-report.results.length,
    sourceOk:report.results.filter(r=>r.sourceStatus==='ok' && r.identityBound).length,
    chartReady:report.results.filter(r=>r.validation?.ready).length,
    entryThesisBarsReady:report.results.filter(r=>r.validation?.entryThesisBarsReady).length,
    byResult:Object.fromEntries([...new Set(report.results.map(r=>r.validation?.diagnostics?.code || r.error || r.sourceStatus))]
      .map(code=>[code,report.results.filter(r=>(r.validation?.diagnostics?.code || r.error || r.sourceStatus)===code).length]))};
  await save();
  return report;
}

const help = `Read-only finite chart audit through the existing local dashboard\n\nnode scripts/audit-chart-backlog.js --input /tmp/frozen-targets.json --output /tmp/chart-audit.json [--filter excluded|allowed|all] [--port 4173] [--timeout-ms 120000]\n\nDefault filter: excluded. One attempt per CA, serial requests, no retry. Existing output files are refused. A timeout stops the run. No orders or strategy-cache writes.\n`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) console.log(help);
  else {
    try {
      const options = {}, names={'--input':'inputPath','--output':'outputPath','--filter':'filter','--port':'port','--timeout-ms':'timeoutMs'};
      for (let i=2;i<process.argv.length;i+=2) {
        const name=names[process.argv[i]],value=process.argv[i+1];
        if (!name || !value || value.startsWith('--')) throw new Error('Invalid argument; use --help');
        options[name]=['port','timeoutMs'].includes(name)?Number(value):value;
      }
      const report=await auditChartBacklog(options);
      console.log(JSON.stringify({status:report.status,output:path.resolve(options.outputPath),...report.summary}));
      if (report.status !== 'complete') process.exitCode=1;
    } catch(error) { console.error(error.message); process.exitCode=1; }
  }
}
