// For pure lexical work only. Never cache authentication, CA bindings, prices or
// time-sensitive decisions here. Callers must not expose mutable cached values.
export function createBoundedTextMemo(compute, { maxEntries = 256, maxLength = 8000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isSafeInteger(maxLength) || maxLength < 0)
    throw new TypeError('Invalid text memo bounds');
  const entries = new Map();
  let hits = 0, misses = 0, bypasses = 0;
  return {
    get(text) {
      if (typeof text !== 'string' || !maxEntries || text.length > maxLength) {
        bypasses++;
        return compute(text);
      }
      if (entries.has(text)) {
        const value = entries.get(text);
        entries.delete(text);
        entries.set(text, value);
        hits++;
        return value;
      }
      misses++;
      const value = compute(text);
      entries.set(text, value);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    },
    snapshot() { return { entries: entries.size, hits, misses, bypasses, maxEntries, maxLength }; },
  };
}
