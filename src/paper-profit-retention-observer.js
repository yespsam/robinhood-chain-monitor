import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROFIT_RETENTION_MULTIARM_VERSION, createProfitRetentionMultiarm, advanceProfitRetentionMultiarm,
  validateProfitRetentionMultiarm, profitRetentionMultiarmSummary } from './paper-profit-retention-multiarm.js';

const OBSERVER_VERSION = 'profit_retention_multiarm_observer_v3';
const copy = value => structuredClone(value);
const checkpoint = (account, shadow = null) => ({ tradeCount: account.trades.length,
  lastTradeId: account.trades.at(-1)?.id ?? null,
  ...(shadow ? {tradePrefixHash:shadow.cursor.tradePrefixHash} : {}),
  accountUpdatedAt: account.updatedAt });
// Full-prefix integrity is owned and checked by the pure core. Reuse its
// cursor; hashing the large main trade history a second time per mark would
// add unnecessary work to the main writer's commit boundary.
const sameTrades = (a, b) => a.tradeCount === b.tradeCount && a.lastTradeId === b.lastTradeId;
const COVERAGE_VERSION = 'profit_retention_observer_coverage_v1';
const emptyCoverage = () => ({ version: COVERAGE_VERSION, interruptionCount: 0, interruptions: [] });
function loadCoverage(value) {
  if (value === undefined) return emptyCoverage();
  if (value?.version !== COVERAGE_VERSION || !Number.isSafeInteger(value.interruptionCount)
    || !Array.isArray(value.interruptions) || value.interruptions.length > 50 || value.interruptionCount < value.interruptions.length
    || value.interruptions.some(x => x.reason !== 'no_active_pairs_mark_only_gap'
      || !Number.isFinite(Date.parse(x.fromAccountUpdatedAt)) || !Number.isFinite(Date.parse(x.toAccountUpdatedAt))
      || Date.parse(x.toAccountUpdatedAt) < Date.parse(x.fromAccountUpdatedAt)
      || !Number.isFinite(x.detectedAtMs) || x.detectedAtMs < Date.parse(x.toAccountUpdatedAt)
      || !Number.isSafeInteger(x.tradeCount) || x.tradeCount < 0 || typeof x.tradePrefixHash !== 'string'))
    throw new TypeError('invalid observer coverage');
  return copy(value);
}

async function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Passive sidecar: it receives only successfully committed main-book changes.
// It owns neither main cash nor quote targets and never replays missed history.
export function createProfitRetentionObserver({ dataDir, sessionId, sourceLedgerName, now = Date.now,
  writeSnapshot = writeAtomic, ...legacyOptions } = {}) {
  if (!dataDir || !/^confirmed-pvp-v2-[a-z0-9-]{1,40}$/.test(sessionId || '')
    || sourceLedgerName !== `yesp-atm-${sessionId}.json`) throw new TypeError('invalid profit retention observer identity');
  if (['triggerPriceMultiple','triggerPriceMultiples','profitRetentionPriceMultiple','profitRetentionPriceMultiples'].some(key=>Object.hasOwn(legacyOptions,key)))
    throw new TypeError('profit retention multiarm has fixed multiples 2, 3 and 5; single-multiple options are retired');
  // This three-arm study establishes a new forward baseline. Never migrate
  // or overwrite v1/v2 evidence or select an arm using an old configuration.
  const stateFile = path.join(dataDir, `paper-profit-retention-multiarm-v3-${sessionId}.json`);
  let status = 'not_loaded', error = null, state = null, cursor = null, pending = null, writing = null;
  let initialized = false, persistedAt = null, lastCommitPath = null;
  let observerCoverage = emptyCoverage();
  const fail = code => { status = 'error'; error = code; pending = null; };
  const envelope = () => ({ version: OBSERVER_VERSION, studyVersion: PROFIT_RETENTION_MULTIARM_VERSION,
    sessionId, sourceLedgerName, checkpoint: copy(cursor), shadow: copy(state), observerCoverage: copy(observerCoverage),
    savedAt: new Date(now()).toISOString() });
  const pump = () => {
    if (writing || !pending || status === 'error') return;
    const value = pending; pending = null;
    writing = Promise.resolve().then(() => writeSnapshot(stateFile, value))
      .then(() => { persistedAt = value.savedAt; })
      .catch(() => fail('PROFIT_RETENTION_PERSIST_FAILED'))
      .finally(() => { writing = null; pump(); });
  };
  const scheduleSave = () => { pending = envelope(); pump(); };
  const flush = async () => { while (writing) await writing; };

  return {
    stateFile,
    async initialize({ account, persistedAccount = account }) {
      if (initialized) return; initialized = true;
      try {
        let saved;
        try {
          const info = await fs.stat(stateFile);
          if (info.size > 16 * 1024 * 1024) throw new Error('oversized observer');
          saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
        const current = checkpoint(persistedAccount);
        if (saved) {
          if (saved.version !== OBSERVER_VERSION || saved.studyVersion !== PROFIT_RETENTION_MULTIARM_VERSION
            || saved.sessionId !== sessionId || saved.sourceLedgerName !== sourceLedgerName)
            throw new Error('identity mismatch');
          validateProfitRetentionMultiarm(saved.shadow);
          observerCoverage = loadCoverage(saved.observerCoverage);
          if (!sameTrades(saved.checkpoint || {}, current)
            || saved.checkpoint.tradePrefixHash !== saved.shadow.cursor.tradePrefixHash) {
            fail('PROFIT_RETENTION_COVERAGE_GAP'); return;
          }
          const checkedAtMs = now(), markOnlyGap = saved.checkpoint.accountUpdatedAt !== current.accountUpdatedAt;
          // Recovery cannot reconstruct missed entries, exits or quotes. The
          // sole safe case is an unchanged FULL trade prefix with no active
          // study pair in any arm: no hypothetical position existed to value.
          if (markOnlyGap && (saved.shadow.arms.some(arm => arm.study.pairs.some(pair => pair.status === 'active'))
            || !Number.isFinite(Date.parse(saved.checkpoint.accountUpdatedAt)) || !Number.isFinite(Date.parse(current.accountUpdatedAt))
            || Date.parse(current.accountUpdatedAt) < Date.parse(saved.checkpoint.accountUpdatedAt)
            || !Number.isFinite(checkedAtMs) || checkedAtMs < Date.parse(current.accountUpdatedAt))) {
            fail('PROFIT_RETENTION_COVERAGE_GAP'); return;
          }
          // Validate the core's independent full-prefix proof without consuming
          // marks or changing its durable state on restart.
          advanceProfitRetentionMultiarm(copy(saved.shadow), { beforeAccount: account, afterAccount: account, marks: [], nowMs: checkedAtMs });
          if (persistedAccount !== account) advanceProfitRetentionMultiarm(copy(saved.shadow), {
            beforeAccount: persistedAccount, afterAccount: persistedAccount, marks: [], nowMs: checkedAtMs });
          state = saved.shadow; cursor = checkpoint(persistedAccount,state); persistedAt = saved.savedAt ?? null; status = 'observing';
          if (markOnlyGap) {
            observerCoverage.interruptionCount++;
            observerCoverage.interruptions.push({ reason: 'no_active_pairs_mark_only_gap',
              fromAccountUpdatedAt: saved.checkpoint.accountUpdatedAt, toAccountUpdatedAt: current.accountUpdatedAt,
              detectedAtMs: checkedAtMs, tradeCount: cursor.tradeCount, tradePrefixHash: cursor.tradePrefixHash });
            observerCoverage.interruptions = observerCoverage.interruptions.slice(-50);
            // Only the verified observer checkpoint/coverage changes. Preserve
            // the baseline, arm state and prior quote gaps byte-for-byte as data.
            scheduleSave(); await flush();
          }
        } else {
          state = createProfitRetentionMultiarm(account, { sessionId, nowMs: now() });
          cursor = checkpoint(persistedAccount,state); status = 'observing'; scheduleSave(); await flush();
        }
      } catch { fail('PROFIT_RETENTION_LOAD_FAILED'); }
    },
    observeCommitted({ beforeAccount, afterAccount, marks = [], nowMs, path: commitPath }) {
      if (status !== 'observing') return;
      try {
        if (!sameTrades(cursor, checkpoint(beforeAccount))) { fail('PROFIT_RETENTION_COVERAGE_GAP'); return; }
        state = advanceProfitRetentionMultiarm(state, { beforeAccount, afterAccount, marks, nowMs });
        cursor = checkpoint(afterAccount,state); lastCommitPath = commitPath;
        // One active write plus one latest snapshot is bounded. All intervening
        // observations have already advanced the pure state; none are replayed.
        scheduleSave();
      } catch { fail('PROFIT_RETENTION_OBSERVATION_FAILED'); }
    },
    snapshot() {
      let summary = null, summaryError = null;
      try {
        if (state) {
          const checkedAtMs = now();
          if (!Number.isFinite(checkedAtMs) || checkedAtMs < state.updatedAtMs) {
            // A read-only display with an invalid/rewound clock must not clear
            // queued durable evidence or permanently stop future observation.
            // Do not clamp the time: that could make an expired mark look fresh.
            summaryError = { code: 'PROFIT_RETENTION_SUMMARY_CLOCK_INVALID',
              reason: Number.isFinite(checkedAtMs) ? 'clock_before_last_commit' : 'clock_not_finite',
              checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : null, lastCommitAtMs: state.updatedAtMs };
          } else summary = profitRetentionMultiarmSummary(state, { nowMs: checkedAtMs });
        }
      } catch { fail('PROFIT_RETENTION_SUMMARY_FAILED'); }
      return { ...summary, version: PROFIT_RETENTION_MULTIARM_VERSION, enabled: true,
        status: summaryError && status !== 'error' ? 'error' : status,
        error: error ?? summaryError?.code ?? null, summaryError,
        configuredPriceMultiples: [2,3,5],
        sessionId, mode: 'multiarm_paired_observation_only', execution: false, signing: false, broadcast: false,
        checkpoint: cursor && copy(cursor), persistedAt, pendingWrite: !!writing || !!pending, lastCommitPath,
        observerCoverage: copy(observerCoverage),
        note: '仅观察启用后的主盘实际新入场，固定 2/3/5 倍三组共享同一入场与退出；独立文件、不回填、不加入旧仓、不影响主盘。完整性或持久化故障冻结研究；快照时钟异常仅隐藏本次汇总；零活动配对的纯标记中断仅在完整交易前缀核验后记录并恢复。' };
    },
    flush,
  };
}
