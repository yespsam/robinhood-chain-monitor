import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { platformDocumentCoverage } from './platform-document-watch.js';

const stamp = value => { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : null; };
const at = value => { const n = stamp(value); return n === null ? null : new Date(n).toISOString(); };
const ERROR_CODES = new Set(['FLAP_QUOTE_PORTAL_IDENTITY_UNAVAILABLE', 'FLAP_QUOTE_HEAD_UNAVAILABLE',
  'FLAP_QUOTE_GET_LOGS_FAILED', 'FLAP_QUOTE_PORTAL_IDENTITY_CHANGED', 'FLAP_QUOTE_CHAIN_ID_MISMATCH',
  'FLAP_QUOTE_PORTAL_VERSION_MISMATCH', 'FLAP_QUOTE_PORTAL_RUNTIME_MISMATCH', 'FLAP_QUOTE_REORG_CHECK_FAILED']);
const code = value => ERROR_CODES.has(value) ? value : null;
function health(value, now, maxAgeMs) {
  const checked = stamp(value?.lastSuccessAt), ageMs = checked === null ? null : now - checked;
  const errorAt = stamp(value?.lastErrorAt);
  // Producers retain the last error for diagnostics after a later success.
  // Only an ordered, non-future success clears that historical error here;
  // missing/error timestamps cannot establish recovery. Explicit unhealthy
  // source status remains authoritative even if its timestamps disagree.
  const unresolvedError = value?.lastError && (errorAt === null || checked === null
    || errorAt >= checked || errorAt > now || checked > now);
  const status = ageMs === null || ageMs < -5000 ? 'unverified'
    : ageMs > maxAgeMs ? 'stale'
      : value?.slaStatus === 'source_limited' ? 'source_limited'
        : ['error', 'degraded', 'failed', 'unavailable'].includes(value?.status) || unresolvedError ? 'degraded' : 'fresh';
  return { status, lastAttemptAt: at(value?.lastAttemptAt), lastSuccessAt: at(value?.lastSuccessAt),
    nextAttemptAt: at(value?.nextAttemptAt), ageMs, lastErrorAt: at(value?.lastErrorAt), lastErrorCode: code(value?.lastErrorCode) };
}
function aggregate(items) {
  const counts = Object.fromEntries(['fresh', 'unverified', 'stale', 'source_limited', 'degraded', 'metadata_only'].map(k => [k, items.filter(x => x.status === k).length]));
  return { status: !items.length ? 'unverified' : items.every(x => x.status === 'fresh') ? 'fresh' : 'partial', total: items.length, ...counts };
}

const blockNumber = value => Number.isSafeInteger(value) && value >= 0;
const blockHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const validCursor = (cursor, producer) => cursor && blockNumber(cursor.nextBlock) && cursor.nextBlock > 0
  && blockNumber(cursor.anchorBlock) && blockHash(cursor.anchorBlockHash)
  && (producer === 'fourmeme' ? cursor.nextBlock === cursor.anchorBlock + 1
    : Number.isSafeInteger(cursor.afterLogIndex) && cursor.afterLogIndex >= -1
      && cursor.nextBlock === cursor.anchorBlock + (cursor.afterLogIndex === -1 ? 1 : 0));

// This evidence is display-only. A common RPC head is an observed bound, not
// a guarantee of the global tip, ancestry, complete event coverage or entry.
export function projectChainHead(observation, producer, chainState, now) {
  const result = { headVerificationStatus:'unverified', headLagBlocks:null, scanBacklogBlocks:null,
    liveHeadVerified:false, headBlock:null, confirmedHeadBlock:null, confirmationDepth:null,
    headSpreadBlocks:null, headVerifiedAt:null, headAgeMs:null, observationNextBlock:null,
    observedHeadLagBlocks:null, observedScanBacklogBlocks:null };
  const proof=observation?.lastSuccess;
  const start=stamp(proof?.startedAt), verified=stamp(proof?.verifiedAt), captured=stamp(proof?.cursorObservedAt);
  if (observation?.version !== 'chain_head_observation_v1' || observation.displayOnly !== true
    || observation.producer !== producer || observation.chainId !== 56 || !proof
    || !blockNumber(proof.headNumber) || !blockHash(proof.headHash)
    || !blockNumber(proof.confirmations) || proof.safeHead !== proof.headNumber-proof.confirmations || proof.safeHead < 0
    || !Array.isArray(proof.sourceIds) || proof.sourceIds.length !== 2
    || proof.sourceIds.some(id=>typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) || new Set(proof.sourceIds).size !== 2
    || !Array.isArray(proof.sourceTips) || proof.sourceTips.length !== 2 || !proof.sourceTips.every(blockNumber)
    || Math.min(...proof.sourceTips) !== proof.headNumber || Math.max(...proof.sourceTips)-proof.headNumber !== proof.headSpread
    || !blockNumber(proof.blockTimestamp) || start === null || verified === null || captured === null
    || start > verified || verified > captured || captured > now || proof.blockTimestamp*1000 > now
    || !validCursor(proof.cursor,producer) || proof.cursor.anchorBlock > proof.headNumber
    || (proof.cursor.anchorBlock === proof.headNumber && proof.cursor.anchorBlockHash.toLowerCase() !== proof.headHash.toLowerCase())) return result;
  Object.assign(result, {headBlock:proof.headNumber,confirmedHeadBlock:proof.safeHead,confirmationDepth:proof.confirmations,
    headSpreadBlocks:proof.headSpread,headVerifiedAt:proof.verifiedAt,headAgeMs:now-start,
    observationNextBlock:proof.cursor.nextBlock,observedHeadLagBlocks:proof.headNumber-(proof.cursor.nextBlock-1),
    observedScanBacklogBlocks:Math.max(0,proof.safeHead-(proof.cursor.nextBlock-1))});
  if(observation.status !== 'verified') return {...result,headVerificationStatus:'error'};
  if(now-start>120000 || now-proof.blockTimestamp*1000>120000) return {...result,headVerificationStatus:'stale'};
  const cursor=chainState.cursor, checkpoint=stamp(producer==='flap'?chainState.checkedAt:chainState.updatedAt);
  if(chainState.initialized !== true || (producer==='flap'?chainState.identity?.chainId:chainState.chainId)!==56
    || !validCursor(cursor,producer) || checkpoint===null || checkpoint>now || now-checkpoint>120000
    || cursor.nextBlock<proof.cursor.nextBlock
    || (cursor.anchorBlock===proof.cursor.anchorBlock && cursor.anchorBlockHash.toLowerCase()!==proof.cursor.anchorBlockHash.toLowerCase())
    || (cursor.anchorBlock===proof.headNumber && cursor.anchorBlockHash.toLowerCase()!==proof.headHash.toLowerCase())) {
    return {...result,headVerificationStatus:'cursor_unverified'};
  }
  if(cursor.anchorBlock>proof.headNumber) return {...result,headVerificationStatus:'cursor_ahead_of_observation'};
  return {...result,headVerificationStatus:'verified',liveHeadVerified:true,
    headLagBlocks:proof.headNumber-(cursor.nextBlock-1),scanBacklogBlocks:Math.max(0,proof.safeHead-(cursor.nextBlock-1))};
}

// A read-only projection. Website health or a recent local checkpoint does not
// certify a live chain head, arbitrary new ABIs, or successful paper execution.
export function buildLaunchUpdateCoverage({ platform = {}, twitter = {}, github = {}, four = {}, flap = {}, fourHead = {}, flapHead = {}, readErrors = [] } = {}, now = Date.now()) {
  const platforms = {};
  for (const [id, handle, orgs] of [['flap', 'flapdotsh', ['flap-sh']], ['fourmeme', 'fourdotmemezh', ['four-meme-community', 'four-meme']]]) {
    const entry = platform[id] || {};
    const docs = platformDocumentCoverage(id, entry, now);
    const documentBodies = Object.fromEntries(['version', 'allowedPages', 'uncheckedPages', 'freshPages', 'stalePages', 'failedPages', 'untrackedPages', 'rosterOverflowPages', 'pendingChanges', 'omittedChangeCount', 'nextDueAt', 'originNextAttemptAt'].map(k => [k, docs[k] ?? null]));
    documentBodies.rosterDiscovery = aggregate(Object.values(entry.sourceHealth || {}).filter(h => h.kind === 'docs' && /sitemap\.xml$/.test(h.url || '')).map(h => health(h, now, 10 * 60000)));
    documentBodies.status = !docs.allowedPages ? 'unverified' : docs.freshPages === docs.allowedPages && documentBodies.rosterDiscovery.status === 'fresh' ? 'fresh' : 'partial';
    const repos = Object.entries(github._repositories || {}).filter(([name]) => orgs.includes(name.split('/')[0].toLowerCase()));
    const repositories = repos.filter(([, meta]) => meta.sourceTrust === 'official_verified').map(([name]) => {
      const h = github._health?.repositories?.[name.toLowerCase()];
      const commit = health({ ...h, lastSuccessAt:h?.lastCommitReadAt }, now, 15 * 60000);
      const metadataOnly = h?.organizationPushGate === 'pushed_at_unchanged';
      return { repository:name, ...commit, status:metadataOnly && commit.status === 'stale' ? 'metadata_only' : commit.status,
        metadataHealth:health(h, now, 15 * 60000), lastCommitReadAt:at(h?.lastCommitReadAt),
        observationBasis:metadataOnly ? 'organization_metadata_unchanged' : h?.lastCommitReadAt ? 'commit_poll' : 'legacy_unverified' };
    });
    const organizations = orgs.map(name => ({ organization:name,
      ...health(Object.entries(github._organizations || {}).find(([key])=>key.toLowerCase()===name)?.[1], now, 20 * 60000) }));
    const chainState = id === 'flap' ? flap : four;
    const adapterHealth = id === 'flap' ? health(chainState._health, now, 120000) : null;
    const checkpointAt = at(id === 'flap' ? chainState.checkedAt : chainState.updatedAt);
    const nextBlock = Number.isSafeInteger(chainState.cursor?.nextBlock) && chainState.cursor.nextBlock >= 0 ? chainState.cursor.nextBlock : null;
    const onchain = { ...(adapterHealth || {}), adapterHealth,
      status:id === 'flap' ? adapterHealth.status === 'fresh' ? 'adapter_observed_head_unverified' : adapterHealth.status
        : checkpointAt && nextBlock !== null ? 'checkpoint_only_unverified' : 'unverified',
      checkpointAt, nextBlock,
      headLagBlocks: null, liveHeadVerified: false, scope: id === 'flap' ? 'BSC pinned Portal quote adapter' : 'BSC pinned OpenFour registry adapter' };
    Object.assign(onchain,projectChainHead(id==='flap'?flapHead:fourHead,id,chainState,now));
    if(onchain.liveHeadVerified) onchain.status=adapterHealth && adapterHealth.status!=='fresh' ? adapterHealth.status
      : onchain.scanBacklogBlocks>0 ? 'verified_backlog' : 'verified_confirmed_head';
    platforms[id] = { officialX: { handle, ...health(twitter._health?.[handle], now, 120000) },
      officialWeb: aggregate(Object.values(entry.sourceHealth || {}).map(h => health(h, now, 10 * 60000))),
      documentBodies, github: { ...aggregate([...repositories,...organizations]), repositories, organizations, repositoryCount:repositories.length, candidateRepositories: repos.length - repositories.length }, onchain,
      coverageStatus: 'bounded_sources_not_all_future_schemas' };
  }
  return { version: 'launch_update_coverage_v1', checkedAt: new Date(now).toISOString(), readOnly: true,
    status: readErrors.length === 5 ? 'unavailable' : readErrors.length ? 'degraded' : 'coverage_limited', platforms, readErrors,
    executionBoundary: '更新正文仅作待核实观察；仅已绑定受支持链上版本且顺序核实的最早三个不同 CA 进入模拟评估，不补第四名，仍须通过时效、可卖性及仓位检查。',
    remainingGaps: ['未知合约地址、事件 ABI 和同地址 Hook 新版本仍需核实适配', '链上检查点不等于已追平链头；网站正常不等于狙击完整覆盖', 'X 上游来源受限或电脑离线时不保证连续覆盖'] };
}

const DEFAULT_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// Four retains 64 canonical checkpoints, including preset state. A valid
// producer snapshot can exceed the general 8 MiB display-reader budget.
// This is a local file budget only, not an RPC or trading-policy limit.
const FOUR_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const invalid = coverageCode => Object.assign(new Error('Invalid coverage snapshot'), { coverageCode });

export async function readCoverageSnapshot(file, maxBytes, { open = fs.open } = {}) {
  let handle, info, bytes = null;
  try {
    // One descriptor pins a complete version across the producer's atomic
    // rename. NONBLOCK also lets us reject FIFOs without hanging on open().
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    info = await handle.stat();
    bytes = info.size;
    if (!info.isFile()) throw invalid('not_regular_file');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) throw invalid('size_limit');
    const buffer = Buffer.alloc(bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await handle.stat();
    // Replacing the path may unlink this pinned inode and change only ctime;
    // that is still a coherent old snapshot, not an in-place content update.
    const replaced = info.nlink > 0 && after.nlink === 0;
    if (length !== bytes || after.size !== info.size || after.mtimeMs !== info.mtimeMs || (!replaced && after.ctimeMs !== info.ctimeMs)) {
      throw invalid('snapshot_changed');
    }
    const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw invalid('invalid_state');
    return { value, diagnostic: { status: 'ok', bytes, maxBytes, modifiedAt: new Date(info.mtimeMs).toISOString() } };
  } catch (error) {
    const errorCode = error.coverageCode || (error instanceof SyntaxError ? 'invalid_json' : error.code === 'ENOENT' ? 'missing' : 'io_error');
    // No raw error/path/JSON contents may enter the public panel.
    throw Object.assign(new Error('Coverage snapshot unavailable'), { diagnostic: { status: 'error', errorCode, bytes, maxBytes } });
  } finally {
    await handle?.close();
  }
}

export function createLaunchUpdateCoverageReader({ dataDir, now = Date.now, ttlMs = 15000 } = {}) {
  let cached, expires = 0, pending;
  return async () => {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const names = { platform: 'platform-capability-state.json', twitter: 'twitter-state.json', github: 'github-state.json', four: 'four-registry-state.json', flap: 'flap-quote-state.json', fourHead:'four-chain-head-observation.json', flapHead:'flap-chain-head-observation.json' };
      const readErrors = [], readDiagnostics = {};
      const headReadErrors=[];
      const pairs = await Promise.all(Object.entries(names).map(async ([key, file]) => {
        try {
          const { value, diagnostic } = await readCoverageSnapshot(path.join(dataDir, file), key.endsWith('Head') ? 64*1024 : key === 'four' ? FOUR_SNAPSHOT_BYTES : DEFAULT_SNAPSHOT_BYTES);
          readDiagnostics[key] = diagnostic;
          // Retain only the display projection, not Four's checkpoint graph.
          return [key, key === 'four' ? { updatedAt: value.updatedAt, initialized:value.initialized, chainId:value.chainId, cursor:value.cursor } : value];
        } catch (error) {
          readDiagnostics[key] = error.diagnostic || { status: 'error', errorCode: 'io_error' };
          (key.endsWith('Head')?headReadErrors:readErrors).push(key); return [key, {}];
        }
      }));
      cached = { ...buildLaunchUpdateCoverage({ ...Object.fromEntries(pairs), readErrors: readErrors.sort() }, now()), readDiagnostics, headReadErrors:headReadErrors.sort() };
      expires = now() + ttlMs;
      return cached;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
