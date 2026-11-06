// Durable record of a narrative hotspot and the tokens later matched to it.
// A hotspot is a verified post (source, keywords, time). Matching is lexical:
// it does not claim the author issued the token.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { narrativeNameMatch, normalizeNarrativeText } from "./narrative-name-match.js";

export const HOT_NARRATIVE_VERSION = 1;
export const HOT_NARRATIVE_FILE = "hot-narratives.json";
export const HOT_NARRATIVE_MATCH_FILE = "hot-narrative-matches.jsonl";
export const HEYI_HANDLE = "heyibinance";
export const CZ_HANDLE = "cz_binance";
export const CZ_SHORT_REPLY_MAX_CHARS = 140;

const FUNCTION_WORDS = new Set("a an the of to and or you your do does is are was were which what this that with for from on in it we our their they choose choose? just very really about into over after before".split(" "));
const STATUS_URL = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").replace(/https?:\/\/\S+/gu, " ").replace(/\s+/gu, " ").trim();
}

function pushKeyword(found, text, kind) {
  const term = String(text ?? "").normalize("NFKC").trim().toLowerCase();
  if (term.length < 2 || term.length > 40) return;
  if (found.some((item) => item.text === term && item.kind === kind)) return;
  found.push({ text: term, kind });
}

export function extractHotKeywords(text) {
  const stripped = cleanText(text);
  if (!stripped || stripped.length > 4000) return [];
  const found = [];
  for (const match of stripped.matchAll(/[#$]([A-Za-z][A-Za-z0-9]{1,15})/g)) pushKeyword(found, match[1], "phrase");
  for (const match of stripped.matchAll(/\p{Script=Han}{2,12}/gu)) pushKeyword(found, match[0], "phrase");
  const words = stripped.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter(Boolean);
  const content = words.filter((word) => word.length >= 3 && !FUNCTION_WORDS.has(word));
  if (content.length >= 2) {
    const phrase = content.slice(0, 4).join(" ");
    pushKeyword(found, phrase, "phrase");
    pushKeyword(found, phrase.replace(/\s+/gu, ""), "phrase");
    for (let i = 0; i < content.length - 1 && found.length < 12; i += 1) {
      const pair = `${content[i]} ${content[i + 1]}`;
      pushKeyword(found, pair, "phrase");
      pushKeyword(found, pair.replace(/\s+/gu, ""), "phrase");
    }
  }
  const exactWords = content.length === 1 ? content : content.filter((word) => word.length >= 4);
  for (const word of exactWords) pushKeyword(found, word, content.length === 1 ? "phrase" : "exact");
  return found.slice(0, 12);
}

export function classifyNarrativeHook(post = {}) {
  const author = String(post.author || "").toLowerCase();
  const text = String(post.text || "");
  if (author === HEYI_HANDLE && post.isQuote === true) return { priority: true, hook: "heyi_quote" };
  if (author === CZ_HANDLE && post.isReply === true && text.length > 0 && text.length <= CZ_SHORT_REPLY_MAX_CHARS) {
    return { priority: true, hook: "cz_reply" };
  }
  if (author === HEYI_HANDLE || author === CZ_HANDLE) return { priority: false, hook: "binance_person" };
  return { priority: false, hook: "watched_account" };
}

export function hotspotFromPost(post, nowMs = Date.now()) {
  const url = String(post?.url || "");
  const parsed = STATUS_URL.exec(url);
  if (!parsed) return null;
  const author = parsed[1];
  if (post.author && String(post.author).toLowerCase() !== author.toLowerCase()) return null;
  const publishedAt = Number(post.at ?? post.publishedAt);
  const observedAt = Number(post.observedAt ?? nowMs);
  if (!Number.isFinite(publishedAt) || !Number.isFinite(observedAt)) return null;
  if (publishedAt > observedAt || observedAt > nowMs + 60_000) return null;
  const text = cleanText(post.text).slice(0, 4000);
  const keywords = extractHotKeywords(text);
  if (!keywords.length) return null;
  const hook = classifyNarrativeHook({ ...post, author, text });
  const authorId = typeof post.userId === "string" ? post.userId : (typeof post.authorId === "string" ? post.authorId : null);
  return {
    id: `${author.toLowerCase()}:${parsed[2]}`,
    author,
    authorId,
    url,
    postId: parsed[2],
    text,
    keywords,
    publishedAt,
    observedAt,
    isQuote: post.isQuote === true,
    isReply: post.isReply === true,
    hook: hook.hook,
    priority: hook.priority,
  };
}

function keywordList(hotspot) {
  const raw = Array.isArray(hotspot?.keywords) ? hotspot.keywords : [];
  return raw.map((item) => (typeof item === "string" ? { text: item, kind: "phrase" } : item))
    .filter((item) => item && typeof item.text === "string" && (item.kind === "phrase" || item.kind === "exact"));
}

function sameTerm(value, keyword) {
  return normalizeNarrativeText(value).trim() === keyword;
}

export function tokenMatchesHotspot(hotspot, token = {}) {
  const name = String(token.name || "");
  const symbol = String(token.symbol || "");
  const matched = [];
  for (const keyword of keywordList(hotspot)) {
    const hit = keyword.kind === "exact"
      ? sameTerm(name, keyword.text) || sameTerm(symbol, keyword.text)
      : narrativeNameMatch(name, keyword.text) || narrativeNameMatch(symbol, keyword.text);
    if (hit) matched.push(keyword.text);
  }
  return matched;
}

async function writeJson(file, value, fsImpl) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fsImpl.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync?.();
  } finally {
    await handle.close();
  }
  await fsImpl.rename(temp, file);
}

function emptyState() {
  return { version: HOT_NARRATIVE_VERSION, hotspots: [] };
}

export function createHotNarrativeStore({ dataDir, fs: fsImpl = fs, now = Date.now, maxHotspots = 400 } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const file = path.join(dataDir, HOT_NARRATIVE_FILE);
  const matchFile = path.join(dataDir, HOT_NARRATIVE_MATCH_FILE);
  let state = null;
  let matches = null;

  async function load() {
    try {
      const parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
      state = parsed?.version === HOT_NARRATIVE_VERSION && Array.isArray(parsed.hotspots) ? parsed : emptyState();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state = emptyState();
    }
    matches = [];
    try {
      const raw = await fsImpl.readFile(matchFile, "utf8");
      if (raw.length > 4_000_000) throw new Error("hot narrative match log is too large");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row.hotspotId === "string" && typeof row.address === "string") matches.push(row);
        } catch {
          // A torn last line must not hide the earlier matches.
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return state;
  }

  function prune(nowMs) {
    const floor = nowMs - WEEK_MS;
    state.hotspots = state.hotspots.filter((item) => item.publishedAt >= floor).slice(-maxHotspots);
    const ids = new Set(state.hotspots.map((item) => item.id));
    matches = matches.filter((item) => ids.has(item.hotspotId)).slice(-5_000);
  }

  async function recordPost(post) {
    await load();
    const nowMs = now();
    const hotspot = hotspotFromPost(post, nowMs);
    if (!hotspot) return { status: "ignored", reason: "no_hotspot" };
    const existing = state.hotspots.find((item) => item.id === hotspot.id);
    if (existing) return { status: "duplicate", hotspot: existing };
    state.hotspots.push(hotspot);
    prune(nowMs);
    await writeJson(file, state, fsImpl);
    return { status: "recorded", hotspot };
  }

  function findMatch(token, _nowMs, windowMs) {
    const window = Number(windowMs);
    const hits = [];
    for (const hotspot of state?.hotspots || []) {
      const keywords = tokenMatchesHotspot(hotspot, token);
      if (!keywords.length) continue;
      const launchAt = Number(token.launchedAt);
      // Association uses the launch lag, not the time we happened to see it.
      // A late reader can still file the dev wallet; the buy gate applies now.
      if (!Number.isFinite(hotspot.publishedAt) || !Number.isFinite(launchAt) || !Number.isFinite(window)) continue;
      if (launchAt < hotspot.publishedAt || launchAt - hotspot.publishedAt > window) continue;
      hits.push({ hotspot, keywords });
    }
    hits.sort((a, b) => Number(b.hotspot.priority) - Number(a.hotspot.priority) || b.hotspot.publishedAt - a.hotspot.publishedAt);
    return hits[0] || null;
  }

  async function recordMatch(row) {
    await load();
    const chain = String(row.chain || "").toLowerCase();
    const address = chain === "sol" ? String(row.address || "") : String(row.address || "").toLowerCase();
    const key = `${row.hotspotId}:${chain}:${address}`;
    if (matches.some((item) => {
      const itemChain = String(item.chain || "").toLowerCase();
      const itemAddress = itemChain === "sol" ? String(item.address || "") : String(item.address || "").toLowerCase();
      return `${item.hotspotId}:${itemChain}:${itemAddress}` === key;
    })) {
      return { status: "duplicate" };
    }
    matches.push(row);
    await fsImpl.mkdir(dataDir, { recursive: true });
    await fsImpl.appendFile(matchFile, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    return { status: "recorded" };
  }

  async function snapshot() {
    await load();
    const grouped = new Map();
    for (const row of matches) {
      const list = grouped.get(row.hotspotId) || [];
      list.push(row);
      grouped.set(row.hotspotId, list);
    }
    return {
      version: HOT_NARRATIVE_VERSION,
      hotspots: state.hotspots.map((hotspot) => ({
        ...hotspot,
        matches: grouped.get(hotspot.id) || [],
      })),
    };
  }

  return { load, recordPost, findMatch, recordMatch, snapshot, file, matchFile };
}
