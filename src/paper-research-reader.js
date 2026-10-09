// Only concurrent reads are shared. There is deliberately no settled-value
// cache: the next dispatch must see changed files, failures and profile expiry.
export function createPaperResearchReader({ evidenceLoader, learningLoader, now = Date.now }) {
  const pending = new Map();
  let reads = 0, joinedReads = 0, isolatedReads = 0, lastRead = null;
  const load = ({ lane = 'scan', isolated = false } = {}) => {
    if (!['scan', 'events'].includes(lane)) throw new TypeError('invalid research lane');
    // Quotes must never join an older read, including another CA's quote.
    // Event discovery is likewise independent of a slow broad-scan read.
    const key = isolated ? Symbol('quote') : lane;
    if (pending.has(key)) { joinedReads++; return pending.get(key); }
    reads++;
    if (isolated) isolatedReads++;
    const startedAt = now();
    let evidenceMs = null, learningMs = null, evidenceFailed = false, learningFailed = false;
    const job = Promise.all([
      Promise.resolve().then(evidenceLoader).catch(() => { evidenceFailed = true; return {}; })
        .finally(() => { evidenceMs = Math.max(0, now() - startedAt); }),
      Promise.resolve().then(learningLoader).catch(() => { learningFailed = true; return { lastError: 'learning_unavailable', policies: [] }; })
        .finally(() => { learningMs = Math.max(0, now() - startedAt); }),
    ]).then(([loadedEvidence, learning]) => ({ loadedEvidence, learning })).finally(() => {
      lastRead = { startedAt: new Date(startedAt).toISOString(), durationMs: Math.max(0, now() - startedAt),
        evidenceMs, learningMs, evidenceFailed, learningFailed };
      pending.delete(key);
    });
    pending.set(key, job);
    return job;
  };
  return { load, snapshot: () => ({ version: 'lane_local_reads_v1', reads, joinedReads, isolatedReads,
    inFlight: pending.size > 0, inFlightReads: pending.size, lastRead: lastRead ? { ...lastRead } : null }) };
}
