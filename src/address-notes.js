// Self-maintained on-chain address notes (备注). Read-only metadata; never signs or trades.
import fs from "node:fs";
import path from "node:path";

export const ADDRESS_NOTE_CATEGORIES = Object.freeze(["kol", "smart", "dev", "sniper", "whale", "official", "avoid"]);
export const ADDRESS_NOTE_FOLLOWS = Object.freeze(["watch", "boost", "avoid"]);
let cache = { file: null, mtimeMs: -1, notes: [], map: new Map() };

export function normalizeAddress(value) {
  const a = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}
export function addressNotesFile(dataDir = "data") { return path.resolve(dataDir, "address-notes.json"); }

export function loadAddressNotes(dataDir = "data") {
  const file = addressNotesFile(dataDir);
  let st; try { st = fs.statSync(file); } catch { cache = { file, mtimeMs: -1, notes: [], map: new Map() }; return cache.notes; }
  if (cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.notes;
  let notes = [];
  try { notes = JSON.parse(fs.readFileSync(file, "utf8")).notes || []; } catch { return cache.notes; }
  const map = new Map();
  for (const n of notes) {
    const address = normalizeAddress(n?.address);
    if (!address) continue;
    const note = { ...n, address, follow: ADDRESS_NOTE_FOLLOWS.includes(n.follow) ? n.follow : "watch",
      category: ADDRESS_NOTE_CATEGORIES.includes(n.category) ? n.category : "smart" };
    map.set(address, note);
  }
  cache = { file, mtimeMs: st.mtimeMs, notes: [...map.values()], map };
  return cache.notes;
}
export function getNote(addr, dataDir = "data") { loadAddressNotes(dataDir); return cache.map.get(normalizeAddress(addr)) || null; }
export function isNoted(addr, dataDir = "data") { return !!getNote(addr, dataDir); }
export function listNotes({ follow = null, category = null, dataDir = "data" } = {}) {
  return loadAddressNotes(dataDir).filter((n) => (!follow || n.follow === follow) && (!category || n.category === category));
}

/** Evidence for a token: which noted wallets bought/sold it recently (from address-notes-activity.json). */
export function notedWalletEvidenceForTokens(tokens = [], { dataDir = "data", lookbackMs = 24 * 3600_000, now = Date.now() } = {}) {
  const want = new Set(tokens.map(normalizeAddress).filter(Boolean));
  if (!want.size) return null;
  let acts = [];
  try { acts = JSON.parse(fs.readFileSync(path.resolve(dataDir, "address-notes-activity.json"), "utf8")).activities || []; } catch { return null; }
  const hits = acts.filter((a) => want.has(normalizeAddress(a.token)) && now - a.at <= lookbackMs);
  if (!hits.length) return null;
  const boostBuys = hits.filter((h) => h.follow === "boost" && h.side === "buy").length;
  const avoid = hits.filter((h) => h.follow === "avoid" || h.category === "avoid").length;
  return { hits: hits.slice(-20).map((h) => ({ wallet: h.wallet, label: h.label, follow: h.follow, side: h.side, usd: h.usd, at: h.at, hash: h.hash })),
    boostBuys, avoid, bias: avoid ? "avoid" : boostBuys ? "boost" : "watch", shadowOnly: true };
}
