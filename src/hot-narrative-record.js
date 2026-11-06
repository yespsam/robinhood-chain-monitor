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
export const MEME_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const FUNCTION_WORDS = new Set("a an the of to and or you your do does is are was were which what this that with for from on in it we our their they choose choose? just very really about into over after before".split(" "));
const MEME_POST_MAX_CHARS = 32;
const STATUS_URL = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").replace(/https?:\/\/\S+/gu, " ").replace(/\s+/gu, " ").trim();
}

function contentWords(text) {
  return cleanText(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter(Boolean);
}

// A whole short post is the meme. "gm" is a ticker even though it is only two letters.
export function memeTickers(text) {
  const stripped = cleanText(text);
  const words = contentWords(stripped).filter((word) => !FUNCTION_WORDS.has(word));
  if (!stripped || stripped.length > MEME_POST_MAX_CHARS || words.length < 1 || words.length > 3) return [];
  return words.filter((word) => word.length >= 1 && word.length <= 12);
}

export function extractHotKeywords(text) {
  const stripped = cleanText(text);
  if (!stripped || stripped.length > 4000) return [];
  const found = [];
  for (const ticker of memeTickers(stripped)) pushKeyword(found, ticker, "phrase", { meme: true });
  for (const match of stripped.matchAll(/[#$]([A-Za-z][A-Za-z0-9]{1,15})/g)) pushKeyword(found, match[1], "phrase", { meme: true });
  if (found.some((item) => item.meme === true)) return found.slice(0, 12);
  for (const match of stripped.matchAll(/\p{Script=Han}{2,12}/gu)) pushKeyword(found, match[0], "phrase");
  const content = contentWords(stripped).filter((word) => word.length >= 3 && !FUNCTION_WORDS.has(word));
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

function pushKeyword(found, text, kind, extra = {}) {
  const term = String(text ?? "").normalize("NFKC").trim().toLowerCase();
  if (term.length < 1 || term.length > 40) return;
  if (found.some((item) => item.text === term && item.kind === kind)) return;
  found.push({ text: term, kind, ...extra });
}

export function classifyNarrativeHook(post = {}) {
  const author = String(post.author || "").toLowerCase();
  const quote = post.isQuote === true;
  const reply = post.isReply === true;
  if (author === HEYI_HANDLE) return { priority: true, hook: quote ? "heyi_quote" : reply ? "heyi_reply" : "heyi_post" };
  if (author === CZ_HANDLE) return { priority: true, hook: quote ? "cz_quote" : reply ? "cz_reply" : "cz_post" };
  return { priority: false, hook: "watched_account" };
}

function memeKeywordTexts(hotspot) {
  return keywordList(hotspot).filter((item) => item.meme === true).map((item) => item.text);
}

function quotedBits(post) {
  const quotedText = post?.quotedText || post?.quote?.text || "";
  const quotedAuthor = post?.quotedAuthor || post?.quote?.author || post?.quote?.author?.screen_name || "";
  return { quotedText: String(quotedText), quotedAuthor: String(quotedAuthor) };
}

// 何一 quoting a picture often has no ticker of her own. The tradeable meme is
// CZ's earlier short post ("gm"), unless her quote text names a specific one.
export function linkCzMeme(post, prior = []) {
  if (String(post?.author || "").toLowerCase() !== HEYI_HANDLE || post?.isQuote !== true) return null;
  const at = Number(post.at ?? post.publishedAt);
  if (!Number.isFinite(at)) return null;
  const { quotedText, quotedAuthor } = quotedBits(post);
  const haystack = `${post.text || ""} ${quotedText} ${quotedAuthor}`.toLowerCase();
  const candidates = (Array.isArray(prior) ? prior : []).filter((item) => {
    return String(item?.author || "").toLowerCase() === CZ_HANDLE
      && Number.isFinite(item.publishedAt)
      && item.publishedAt < at
      && at - item.publishedAt <= MEME_LOOKBACK_MS
      && memeKeywordTexts(item).length > 0;
  });
  let best = null;
  let bestScore = 0;
  for (const item of candidates) {
    let score = 0;
    for (const keyword of memeKeywordTexts(item)) {
      if (haystack.includes(keyword)) score += 5;
    }
    if (quotedAuthor.toLowerCase() === CZ_HANDLE) score += 10;
    if (score > bestScore || (score > 0 && score === bestScore && item.publishedAt > best.publishedAt)) {
      best = item;
      bestScore = score;
    }
  }
  const ownMeme = memeTickers(post.text).length > 0 || /[#$][A-Za-z]/u.test(String(post.text || ""));
  if (!best && !ownMeme) {
    best = candidates.sort((left, right) => right.publishedAt - left.publishedAt)[0] || null;
  }
  if (!best) return null;
  const keyword = memeKeywordTexts(best)[0];
  if (!keyword) return null;
  return { hotspotId: best.id, keyword, author: CZ_HANDLE };
}

function binancePerson(author) {
  const name = String(author || "").toLowerCase();
  return name === HEYI_HANDLE || name === CZ_HANDLE;
}

export function hotspotFromPost(post, nowMs = Date.now(), prior = []) {
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
  const captionKeywords = extractHotKeywords(text);
  const link = linkCzMeme({ ...post, author, text, at: publishedAt }, prior);
  const keywords = link
    ? [{ text: link.keyword, kind: "phrase", meme: true, source: "cz_link" }]
    : captionKeywords;
  if (!keywords.length && !binancePerson(author)) return null;
  const hook = classifyNarrativeHook({ ...post, author, text });
  const { quotedText, quotedAuthor } = quotedBits(post);
  const authorId = typeof post.userId === "string" ? post.userId : (typeof post.authorId === "string" ? post.authorId : null);
  return {
    id: `${author.toLowerCase()}:${parsed[2]}`,
    author,
    authorId,
    url,
    postId: parsed[2],
    text,
    keywords,
    captionKeywords,
    linkedHotspotId: link?.hotspotId || null,
    linkedKeyword: link?.keyword || null,
    quotedText: quotedText || null,
    quotedAuthor: quotedAuthor || null,
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
    const hotspot = hotspotFromPost(post, nowMs, state.hotspots);
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
