// Process-local object reuse, never a durable classification or trade signal.
// Callers must validate a freshly read canonical block on every cache hit and
// re-run receipt classification against the current activation state.
export function createBscReceiptProofCache({ now = Date.now, maxEntries = 256, ttlMs = 120_000 } = {}) {
  const entries = new Map();
  const counters = { hits: 0, misses: 0, evictions: 0, invalidations: 0 };
  const key = (entry) => {
    const hash = String(entry?.transactionHash || "").toLowerCase();
    const blockHash = String(entry?.blockHash || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash) || !/^0x[0-9a-f]{64}$/.test(blockHash)
      || !Number.isSafeInteger(entry?.blockNumber) || !Number.isSafeInteger(entry?.transactionIndex)) return null;
    return `${hash}:${blockHash}:${entry.blockNumber}:${entry.transactionIndex}`;
  };
  const limit = Math.max(1, Math.min(512, Math.floor(maxEntries) || 256));
  return {
    get(entry) {
      const id = key(entry), value = id && entries.get(id);
      if (!value || value.expires <= now()) {
        if (value) entries.delete(id);
        counters.misses++;
        return null;
      }
      entries.delete(id); entries.set(id, value);
      counters.hits++;
      return value.proof;
    },
    putValidated(entry, proof) {
      const id = key(entry);
      if (!id || !proof?.transaction || !proof?.receipt) return;
      entries.delete(id); entries.set(id, { proof, expires: now() + ttlMs });
      while (entries.size > limit) { entries.delete(entries.keys().next().value); counters.evictions++; }
    },
    invalidate(entry) { const id = key(entry); if (id && entries.delete(id)) counters.invalidations++; },
    remove(entry) { const id = key(entry); if (id) entries.delete(id); },
    stats: () => ({ ...counters, size: entries.size, limit, ttlMs }),
  };
}
