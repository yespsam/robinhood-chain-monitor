import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGmgnFlowClient } from './gmgn-flow-client.js';
import { gmgnFlowAddress, gmgnFlowData, parseGmgnFlowProfile, gmgnFlowTags } from './gmgn-flow-signal.js';
import { LEARNING_SCHEMA, parseWalletActivity, mergeLearningActivity, buildLearningReport } from './wallet-learning.js';
import { LEARNING_CAPACITY, LEARNING_CHAINS, discoverLearningUniverse, balancedLearningSelection, mergeLearningProfiles, walletResearchRole } from './wallet-learning-universe.js';
import { validProfitLeaderboard, PROFIT_LEADERBOARD_SCHEMA } from './profit-leaderboard.js';
import { advanceWalletContext, walletContextReport, selectWalletChartTarget } from './wallet-trade-context.js';
import { admitLearningWallets, LEARNING_ARCHIVE_LIMIT } from './wallet-learning-roster.js';
import { tradingScanChains } from './trading-scan-scope.js';
import { createWalletAddressLibraryClient } from './wallet-address-library-client.js';

async function read(file, max = 96 * 1024 * 1024) {
  try { if ((await fs.stat(file)).size > max) throw new Error('learning_file_too_large'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function write(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`; let handle;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 96 * 1024 * 1024) throw new Error('learning_file_too_large');
  try { handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(json); await handle.sync(); await handle.close(); handle = null; await fs.rename(tmp, file); }
  finally { if (handle) await handle.close(); await fs.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

export function validateLearningState(state) {
  if (state?.schema !== LEARNING_SCHEMA || state.execution !== false || state.signing !== false || state.broadcast !== false
    || !state.wallets || Array.isArray(state.wallets) || Object.keys(state.wallets).length > LEARNING_CAPACITY.deepWallets
    || !Number.isFinite(state.nextAttemptAt) || state.nextAttemptAt < 0) throw new Error('learning_state_invalid');
  if (state.cycleCount != null && (!Number.isSafeInteger(state.cycleCount) || state.cycleCount < 0)) throw new Error('learning_cycle_invalid');
  if (state.statsBatchSizes != null && (typeof state.statsBatchSizes !== 'object' || Array.isArray(state.statsBatchSizes)
    || Object.entries(state.statsBatchSizes).some(([chain, size]) => !LEARNING_CHAINS.includes(chain) || ![1, LEARNING_CAPACITY.statsBatch].includes(size)))) throw new Error('learning_stats_mode_invalid');
  if (state.universe != null) {
    if (typeof state.universe !== 'object' || Array.isArray(state.universe) || Object.keys(state.universe).length > LEARNING_CAPACITY.candidates) throw new Error('learning_universe_invalid');
    for (const [key, w] of Object.entries(state.universe)) if (key !== w.key || key !== `${w.chain}:${w.wallet}` || gmgnFlowAddress(w.chain, w.wallet) !== w.wallet
      || !Array.isArray(w.tags) || w.tags.length > 100 || !Number.isSafeInteger(w.lastObservedAt) || !Number.isFinite(Date.parse(w.firstSeenAt))) throw new Error('learning_candidate_invalid');
    for (const w of Object.values(state.universe)) if (w.leaderboard && (w.leaderboard.key !== w.key
      || !validProfitLeaderboard({ schema: PROFIT_LEADERBOARD_SCHEMA, mode: 'readonly', updatedAt: w.firstSeenAt, entries: [w.leaderboard] }))) throw new Error('learning_leaderboard_invalid');
  }
  const validateStatsJob = (job, deferred=false) => {
    if (!LEARNING_CHAINS.includes(job.chain) || !['7d', '30d'].includes(job.period) || !Array.isArray(job.wallets) || !job.wallets.length || job.wallets.length > LEARNING_CAPACITY.statsBatch
      || job.wallets.some(w => gmgnFlowAddress(job.chain, w) !== w) || !Number.isSafeInteger(job.startedAt) || job.startedAt <= 0
      || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > 3) throw new Error('learning_stats_job_invalid');
    if (new Set(job.wallets).size !== job.wallets.length || !deferred && job.wallets.some(w => !state.wallets[`${job.chain}:${w}`] && !state.universe?.[`${job.chain}:${w}`]?.leaderboard?.researchEligible)) throw new Error('learning_stats_job_invalid');
  };
  if(state.statsJob!=null)validateStatsJob(state.statsJob);
  if(state.scopeDeferredStatsJobs!=null) {
    if(typeof state.scopeDeferredStatsJobs!=='object'||Array.isArray(state.scopeDeferredStatsJobs)
      ||Object.keys(state.scopeDeferredStatsJobs).some(c=>!LEARNING_CHAINS.includes(c)))throw new Error('learning_stats_job_invalid');
    for(const [chain,job] of Object.entries(state.scopeDeferredStatsJobs)) {
      if(!job||job.chain!==chain)throw new Error('learning_stats_job_invalid');validateStatsJob(job,true);
    }
  }
  if (state.walletArchive != null && (typeof state.walletArchive !== 'object' || Array.isArray(state.walletArchive)
    || Object.keys(state.walletArchive).length > LEARNING_ARCHIVE_LIMIT
    || Object.keys(state.walletArchive).some(key => state.wallets[key]))) throw new Error('learning_archive_invalid');
  for (const [key, w] of Object.entries({ ...state.walletArchive, ...state.wallets })) {
    if (key !== `${w.chain}:${w.wallet}` || key !== w.key || gmgnFlowAddress(w.chain, w.wallet) !== w.wallet
      || !Array.isArray(w.groups) || !w.groups.length || w.groups.some(g => !['gmgn_smartmoney', 'gmgn_fomo', 'research_observer'].includes(g))
      || !Array.isArray(w.rows) || w.rows.length > 2000 || !Number.isSafeInteger(w.pages) || w.pages < 0
      || !Number.isFinite(Date.parse(w.firstSeenAt)) || !w.profile || w.nextCursor != null && (typeof w.nextCursor !== 'string' || w.nextCursor.length > 2048)
      || w.gapCursor != null && (typeof w.gapCursor !== 'string' || w.gapCursor.length > 2048)
      || w.gapAnchorAt != null && (!Number.isSafeInteger(w.gapAnchorAt) || w.gapAnchorAt <= 0)
      || w.gapPages != null && (!Number.isSafeInteger(w.gapPages) || w.gapPages < 0 || w.gapPages > 30)
      || !Array.isArray(w.cursors) || w.cursors.length > 30 || w.cursors.some(c => typeof c !== 'string' || c.length > 2048)) throw new Error('learning_wallet_invalid');
    if (['statsAttemptedAt', 'statsErrorAt'].some(field => w[field] != null && (!Number.isSafeInteger(w[field]) || w[field] <= 0))) throw new Error('learning_wallet_stats_invalid');
    for (const r of w.rows) {
      if (r.chain !== w.chain || r.wallet !== w.wallet || gmgnFlowAddress(r.chain, r.token) !== r.token
        || !Number.isSafeInteger(r.at) || r.at <= 0 || typeof r.hash !== 'string' || !(r.chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[0-9a-f]{64}$/).test(r.hash)
        || !['buy', 'sell', 'unattributable'].includes(r.side)
        || r.side !== 'unattributable' && ![r.quantity, r.usd, r.price].every(n => Number.isFinite(n) && n > 0)) throw new Error('learning_row_invalid');
    }
  }
  return true;
}

// One public activity page or profile request per turn. Account-wide spacing and 429
// cooldowns are shared with live monitoring; never fetch private holdings.
export function createWalletLearningMonitor({ dataDir, client = createGmgnFlowClient({ dataDir }), now = Date.now, intervalMs = 120_000, researchContextLoader = null, researchChartLoader = null,
  sourceLoader = async () => { const [flow, fomo, leaderboard] = await Promise.all([read(path.join(dataDir, 'gmgn-flow-state.json')), read(path.join(dataDir, 'fomo-call-state.json')), read(path.join(dataDir, 'profit-leaderboard-candidates.json'), 16 * 1024 * 1024)]);
    if (leaderboard && !validProfitLeaderboard(leaderboard)) throw new Error('learning_leaderboard_invalid'); return { flow, fomo, leaderboard }; } } = {}) {
  if (!dataDir || !Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('learning_configuration');
  const scanChains=tradingScanChains(dataDir,LEARNING_CHAINS);
  const stateFile = path.join(dataDir, 'wallet-learning-state.json'), lock = `${stateFile}.lock`, owner = randomUUID();
  let state, active, timer, stopped = false, held = false, fault = null, reportCache, reportState, reportAt = 0;
  const habitCache = new Map();
  const addressLibrary = createWalletAddressLibraryClient({ dataDir });
  const libraryState = next => ({ universe: next.universe, wallets: next.wallets, walletArchive: next.walletArchive });
  async function initialize() {
    if (state) return;
    await fs.mkdir(dataDir, { recursive: true });
    try { await fs.writeFile(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const recovery = await fs.open(`${lock}.reclaim`, 'wx', 0o600);
      try {
        const prior = await read(lock, 4096);
        if (!Number.isSafeInteger(prior?.pid) || prior.pid <= 0) throw new Error('learning_lock_invalid');
        try { process.kill(prior.pid, 0); throw new Error('learning_already_running'); } catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        await fs.unlink(lock); await fs.writeFile(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
      } finally { await recovery.close(); await fs.unlink(`${lock}.reclaim`); }
    }
    held = true;
    const saved = await read(stateFile);
    const candidate = saved ?? { schema: LEARNING_SCHEMA, execution: false, signing: false, broadcast: false, wallets: {}, nextAttemptAt: 0 };
    // An existing JSON null is corrupt, not permission to clear history.
    if (saved === null && await fs.stat(stateFile).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('learning_state_invalid');
    validateLearningState(candidate); state = candidate;
  }
  async function cycle() {
    if (stopped) return;
    await initialize();
    if (now() < state.nextAttemptAt) {
      // Local learning may run while API pacing is waiting; no quota bypass.
      if(researchContextLoader&&(!state.behaviorMemory||now()-state.behaviorMemory.updatedAt>=intervalMs)) {
        const local=structuredClone(state);learnBehavior(local);await write(stateFile,local);state=local;
      }
      return snapshot();
    }
    const next = structuredClone(state), at = now();
    next.nextAttemptAt = at + intervalMs;
    next.cycleCount = (next.cycleCount || 0) + 1;
    let selected, chartTarget, activity, libraryGap = null;
    try {
      const source = await sourceLoader();
      // Persist public evidence before candidate capacity/retention can evict it.
      // Runs off the trading event loop; it does not spend a GMGN request slot.
      next.addressLibrary = await addressLibrary.capture({ state: libraryState(next), flow: source.flow,
        leaderboard: source.leaderboard, nowMs: at });
      if (next.addressLibrary?.status === 'error') libraryGap = next.addressLibrary;
      next.statsBatchSizes ||= {};
      // Reuse compatibility already discovered by the live monitor. Never retry
      // known-broken batches merely because the learning process restarted.
      for (const chain of LEARNING_CHAINS) if (source.flow?.chains?.[chain]?.profileBatchSize === 1) next.statsBatchSizes[chain] = 1;
      next.universe = discoverLearningUniverse({ flow: source.flow || {}, fomo: source.fomo || {}, leaderboard: source.leaderboard, previous: next.universe || {}, wallets: next.wallets, nowMs: at });
      if (next.statsJob && next.statsJob.wallets.some(wallet => !next.wallets[`${next.statsJob.chain}:${wallet}`] && !next.universe[`${next.statsJob.chain}:${wallet}`])) next.statsJob = null;
      admitLearningWallets(next, at);
      for (const w of Object.values(next.wallets)) {
        if (w.statsError && !w.statsErrorAt) w.statsErrorAt = Date.parse(state.updatedAt) || at;
        w.profile = mergeLearningProfiles(w.chain, w.wallet, w.profile, source.flow?.profiles?.[w.key], next.universe[w.key]?.profile);
        w.tags = gmgnFlowTags([...(w.tags || []), ...(w.profile?.['7d']?.tags || []), ...(w.profile?.['30d']?.tags || [])]);
        // Recover only from newer, complete dual-window observations. Neither a
        // successful HTTP response nor a missing batch item proves profitability.
        if (w.statsError && ['7d', '30d'].every(p => Date.parse(w.profile[p]?.checkedAt) > w.statsErrorAt)
          && walletResearchRole({ ...w, statsError: null }, at) !== 'unverified') { w.statsError = null; w.statsErrorAt = null; }
        if (w.profileIssue && ['7d', '30d'].every(p => Date.parse(w.profile[p]?.checkedAt) > (w.statsAttemptedAt || at))) w.profileIssue = null;
      }
      const available = Object.values(next.wallets).filter(w => scanChains.includes(w.chain) && walletResearchRole(w, at) !== 'excluded');
      const candidateOnly = Object.values(next.universe).filter(w => scanChains.includes(w.chain) && w.leaderboard?.researchEligible && !next.wallets[w.key] && walletResearchRole(w, at) !== 'excluded');
      // A pending profile pair is not permission to keep polling a deselected
      // chain. Retain the checkpoint; activity/history/profiles are untouched.
      if(next.statsJob&&!scanChains.includes(next.statsJob.chain)) {
        next.scopeDeferredStatsJobs={...next.scopeDeferredStatsJobs,[next.statsJob.chain]:next.statsJob};
        next.statsJob=null;
      }
      if(!next.statsJob) {
        const resume=scanChains.find(c=>next.scopeDeferredStatsJobs?.[c]?.wallets.every(w=>
          next.wallets[`${c}:${w}`]||next.universe[`${c}:${w}`]?.leaderboard?.researchEligible));
        if(resume){next.statsJob=next.scopeDeferredStatsJobs[resume];delete next.scopeDeferredStatsJobs[resume];}
      }
      const profileWallet = wallet => next.wallets[`${next.statsJob.chain}:${wallet}`] || next.universe[`${next.statsJob.chain}:${wallet}`];
      if (next.statsJob?.attempts >= 3) next.statsJob = null;
      if (!next.statsJob && next.cycleCount % 6 === 4 && typeof client.stats === 'function') {
        const oldest = w => Math.min(...['7d', '30d'].map(p => Date.parse(w.profile?.[p]?.checkedAt) || 0));
        // Half the profile pairs may validate leaderboard candidates even when
        // all 80 activity slots are occupied. Existing activity is never erased.
        const profileLane = candidateOnly.length && Math.floor(next.cycleCount / 6) % 2 === 0 ? candidateOnly : available;
        const stale = balancedLearningSelection(profileLane.filter(w => w.statsError || w.profileIssue || oldest(w) < at - 3600000), profileLane.length, at)
          .sort((a, b) => (a.statsAttemptedAt || 0) - (b.statsAttemptedAt || 0) || oldest(a) - oldest(b));
        if (stale.length) next.statsJob = { chain: stale[0].chain, wallets: stale.filter(w => w.chain === stale[0].chain)
          .slice(0, next.statsBatchSizes[stale[0].chain] || LEARNING_CAPACITY.statsBatch).map(w => w.wallet), period: '7d', attempts: 0, startedAt: at };
      }
      // One existing research slot, never an extra concurrent API request.
      // Both profile slots remain protected; normal chart learning uses 1/6.
      if(researchChartLoader&&researchContextLoader&&![4,5].includes(next.cycleCount%6)
        &&(!next.behaviorChartRequestedAt||next.cycleCount%6===3)) {
        learnBehavior(next);chartTarget=selectWalletChartTarget(next.behaviorMemory&&{...next.behaviorMemory,
          cases:next.behaviorMemory.cases.filter(c=>scanChains.includes(c.chain))},at);
      }
      if(chartTarget) {
        next.behaviorChartRequestedAt=at;
        for(const c of next.behaviorMemory.cases)if(c.chain===chartTarget.chain&&c.token===chartTarget.address
          &&Math.floor(c.at/60000)*60===chartTarget.to){c.chartAttemptAt=at;c.chartAttempts=Math.min(2,(c.chartAttempts||0)+1);}
        next.behaviorMemory.updatedAt=at;
        next.lastAction={kind:'learning_chart',chain:chartTarget.chain,address:chartTarget.address,at:new Date(at).toISOString(),status:'requested'};
        await write(stateFile,next);state=structuredClone(next);
        const result=await researchChartLoader(chartTarget);
        const valid=result?.status==='ok'&&result.source==='gmgn-cli'&&result.chain===chartTarget.chain&&result.address===chartTarget.address
          &&result.resolution==='1m'&&result.from===chartTarget.from&&result.to===chartTarget.to&&Array.isArray(result.candles)
          &&result.candles.length<=120;
        next.lastAction.status=valid?'received':'unavailable';
        if(valid)next.behaviorLastChart={chain:result.chain,address:result.address,resolution:'1m',status:'ok',
          fetchedAt:now(),closedThroughAtMs:chartTarget.to*1000,candles:result.candles};
      // Retries may use only the two profile slots, never all activity slots.
      } else if (next.statsJob && [4, 5].includes(next.cycleCount % 6) && typeof client.stats === 'function') {
        const job = next.statsJob; job.attempts++;
        if (next.statsBatchSizes[job.chain] === 1 && job.wallets.length > 1) job.wallets = job.wallets.slice(0, 1);
        for (const wallet of job.wallets) profileWallet(wallet).statsAttemptedAt = at;
        next.lastAction = { kind: 'profile', chain: job.chain, period: job.period, count: job.wallets.length, at: new Date(at).toISOString() };
        await write(stateFile, next); state = structuredClone(next);
        const payload = await client.stats(job.chain, job.wallets, job.period);
        const data = gmgnFlowData(payload), rows = Array.isArray(data) ? data : [data];
        const returned = new Set(rows.filter(r => !r?.chain || r.chain === job.chain).map(r => gmgnFlowAddress(job.chain, r?.wallet_address)));
        const missing = job.wallets.filter(wallet => !returned.has(wallet));
        if (job.wallets.length > 1 && missing.length && missing.length < job.wallets.length) next.statsBatchSizes[job.chain] = 1;
        next.lastAction.returned = job.wallets.length - missing.length; next.lastAction.missing = missing.length;
        const valid = [];
        for (const wallet of job.wallets) {
          const w = profileWallet(wallet), p = parseGmgnFlowProfile(payload, job.chain, wallet, job.period, now());
          if (!w) continue;
          if (!returned.has(wallet)) {
            // Preserve prior evidence until normal expiry; omitted wallets stay
            // queued for individual rechecks, not classified as failed traders.
            w.profileIssue = 'learning_profile_not_returned'; continue;
          }
          if (p) {
            valid.push(wallet); w.profile[job.period] = p; w.profileIssue = null;
            if (job.period === '30d' && Date.parse(w.profile['7d']?.checkedAt) >= job.startedAt) { w.statsError = null; w.statsErrorAt = null; }
          } else { w.statsError = 'learning_profile_incomplete'; w.statsErrorAt = now(); }
          if (next.universe[w.key]) next.universe[w.key].profile = w.profile;
        }
        next.statsJob = job.period === '7d' && valid.length ? { ...job, wallets: valid, period: '30d', attempts: 0 } : null;
      } else {
        const teachers = available.filter(w => walletResearchRole(w, at) === 'teacher');
        const lane = next.cycleCount % 6 === 0 && teachers.length ? teachers : available;
        selected = balancedLearningSelection(lane, lane.length, at).sort((a, b) => (Date.parse(a.attemptedAt) || 0) - (Date.parse(b.attemptedAt) || 0))[0];
      }
      if (selected) {
        // Alternate head refresh and bounded backfill, without losing the older cursor.
        const repairGap = selected.historyGap === true && !!selected.gapCursor && selected.gapPages < 30;
        const backfill = !repairGap && !!selected.nextCursor && selected.pages % 2 === 1 && selected.cursors.length < 30;
        const cursor = repairGap ? selected.gapCursor : backfill ? selected.nextCursor : null;
        selected.attemptedAt = new Date(at).toISOString();
        next.lastAction = { kind: 'activity', chain: selected.chain, wallet: selected.wallet, at: selected.attemptedAt };
        // Reserve this request durably before touching the network.
        await write(stateFile, next); state = structuredClone(next);
        const payload = await client.activity(selected.chain, selected.wallet, { cursor, limit: 100 });
        const parsed = parseWalletActivity(payload, selected.chain, selected.wallet, now());
        activity = { chain: selected.chain, wallet: selected.wallet, rows: parsed.rows };
        const known = new Set(selected.rows.map(r => `${r.hash}:${r.token}`));
        if (repairGap) {
          selected.gapPages++;
          const bridged = parsed.rows.some(r => r.at <= selected.gapAnchorAt && known.has(`${r.hash}:${r.token}`));
          selected.gapCursor = bridged || parsed.next === cursor ? null : parsed.next;
          if (bridged) { selected.historyGap = false; selected.gapAnchorAt = null; selected.gapPages = 0; }
        } else if (!backfill && selected.rows.length && parsed.rows.length) {
          // A non-overlapping new head can hide trades/transfers between pages.
          // Keep descriptive observations, but never train across that unknown gap.
          if (!parsed.rows.some(r => known.has(`${r.hash}:${r.token}`))) {
            if (!selected.historyGap) {
              selected.gapAnchorAt = Math.max(...selected.rows.map(r => r.at)); selected.gapCursor = parsed.next; selected.gapPages = 0;
            }
            selected.historyGap = true;
          }
        }
        selected.rows = mergeLearningActivity(selected.rows, parsed.rows, now());
        selected.pages++; selected.checkedAt = new Date(now()).toISOString(); selected.lastError = null;
        if (backfill) {
          selected.cursors.push(cursor);
          selected.nextCursor = parsed.next && !selected.cursors.includes(parsed.next) && parsed.rows.some(r => r.at >= now() - 30 * 86400_000) ? parsed.next : null;
          selected.backfillComplete = !selected.nextCursor;
        } else if (!repairGap && !selected.nextCursor && !selected.backfillComplete) { selected.nextCursor = parsed.next; if (!parsed.next) selected.backfillComplete = true; }
      }
      next.lastError = null;
    } catch (error) {
      const reason = /^GMGN_[A-Z_]+$/.test(error.code || '') ? error.code : /^learning_[a-z_]+$/.test(error.message || '') ? error.message : 'learning_source_unavailable';
      next.lastError = reason; if (selected) selected.lastError = reason;
      if(chartTarget)next.lastAction.status='failed';
      if (!selected && !chartTarget && next.statsJob) {
        for (const wallet of next.statsJob.wallets) {
          const w = next.wallets[`${next.statsJob.chain}:${wallet}`] || next.universe?.[`${next.statsJob.chain}:${wallet}`];
          if (w) { w.statsError = reason; w.statsErrorAt = now(); }
        }
        if (next.statsJob.attempts >= 3) next.statsJob = null;
      }
      next.nextAttemptAt = Math.max(next.nextAttemptAt, Date.parse(error.retryAt) || 0);
    }
    learnBehavior(next);
    next.addressLibrary = await addressLibrary.capture({ state: libraryState(next), activity, nowMs: now() });
    if (libraryGap) next.addressLibrary = { ...next.addressLibrary, status: 'error',
      lastError: libraryGap.lastError, note: '本轮归档覆盖不完整；保留已保存证据，下轮按来源重试。' };
    next.updatedAt = new Date(now()).toISOString();
    validateLearningState(next); await write(stateFile, next); state = next; fault = null;
    return snapshot();
  }
  function learnBehavior(next) {
    if(!researchContextLoader)return;
    try {
      const context=researchContextLoader();
      if(!context||context.readOnly!==true)return;
      next.behaviorMemory=advanceWalletContext(next.behaviorMemory,{wallets:Object.values(next.wallets),
        charts:[...(next.behaviorLastChart?[next.behaviorLastChart]:[]),...(context.charts||[])],documents:context.documents||[],nowMs:now()}).memory;
      next.behaviorError=null;
    }catch{next.behaviorError='钱包买卖情境学习异常，保留原记录；采集和模拟交易不重置';}
  }
  // Execution needs verified profiles, not the observational report/casebook.
  // Recheck qualification on every read; never extend a profile's checkedAt.
  function tradingEvidence() {
    const nowMs = now();
    const ranked = Object.values(state?.universe || {}).filter(w => w.leaderboard?.researchEligible);
    return { lastError: fault || state?.lastError || null,
      verifiedLeaderboardProfiles: Object.fromEntries(ranked.filter(w => walletResearchRole(w, nowMs) === 'teacher')
        .map(w => [w.key, structuredClone(w.profile)])),
      verifiedProfiles: Object.fromEntries(Object.values({...state?.universe,...state?.wallets})
        .filter(w => walletResearchRole(w, nowMs) === 'teacher')
        .map(w => [w.key, structuredClone(w.profile)])) };
  }
  function snapshot() {
    if (state !== reportState || !reportCache || now() - reportAt >= 15_000) {
      reportCache = {...buildLearningReport(state, now(), habitCache),behaviorLearning:walletContextReport(state?.behaviorMemory,state?.behaviorError)};
      reportState = state; reportAt = now();
    }
    const ranked = Object.values(state?.universe || {}).filter(w => w.leaderboard?.researchEligible);
    return { ...structuredClone(reportCache), ...tradingEvidence(), scanChains:[...scanChains],
      profitLeaderboard: { scope: '单币盈利榜抽样，非全链总榜', candidates: ranked.length,
        dualProfiles: ranked.filter(w => ['teacher', 'comparison'].includes(walletResearchRole(w, now()))).length,
        qualified: ranked.filter(w => walletResearchRole(w, now()) === 'teacher').length,
        waitingForActivitySlot: ranked.filter(w => !state.wallets[w.key]).length,
        byChain: LEARNING_CHAINS.map(chain => ({ chain, candidates: ranked.filter(w => w.chain === chain).length })) },
      nextAttemptAt: state?.nextAttemptAt ? new Date(state.nextAttemptAt).toISOString() : null,
      capacity: LEARNING_CAPACITY, lastAction: state?.lastAction || null,
      addressLibrary: state?.addressLibrary || addressLibrary.snapshot() || null,
      roster: { archiveLimit: LEARNING_ARCHIVE_LIMIT, archivedWallets: Object.keys(state?.walletArchive || {}).length,
        archivedRecords: Object.values(state?.walletArchive || {}).reduce((n,w) => n + w.rows.length, 0),
        waitingVerified: Object.values(state?.universe || {}).filter(w => !state.wallets[w.key] && walletResearchRole(w,now()) === 'teacher').length,
        lastRotation: state?.lastRosterRotation || null,
        note: '最多 80 个活动研究席位，每轮最多轮换 2 个已核验教师；旧记录保留，归档满后等待，不增加 API 频率、不直接跟单' },
      profileCollection: { singleWalletChains: LEARNING_CHAINS.filter(chain => state?.statsBatchSizes?.[chain] === 1),
        incompleteWallets: Object.values(state?.wallets || {}).filter(w => w.statsError).length,
        missingWallets: Object.values(state?.wallets || {}).filter(w => w.profileIssue === 'learning_profile_not_returned').length },
      collectionIntervalMs: intervalMs, running: !stopped && held, source: 'gmgn-cli portfolio activity + 7d/30d stats' };
  }
  function runOnce() {
    if (active) return active;
    active = cycle().catch(e => { fault = 'learning_state_or_lock_failure'; throw e; }).finally(() => { active = null; }); return active;
  }
  function schedule() { if (!stopped) { timer = setTimeout(() => { void runOnce().catch(() => {}).finally(schedule); }, intervalMs); timer.unref?.(); } }
  return { stateFile, runOnce, snapshot, tradingEvidence,
    start: async () => { if (held || stopped) return; try { await initialize(); } catch (e) { fault = 'learning_state_or_lock_failure'; throw e; } void runOnce().catch(() => {}).finally(schedule); },
    stop: async () => { stopped = true; clearTimeout(timer); await client.stop?.(); await active?.catch(() => {}); await addressLibrary.stop();
      if (held) { const prior = await read(lock, 4096); if (prior?.owner === owner) await fs.unlink(lock); held = false; } },
  };
}
