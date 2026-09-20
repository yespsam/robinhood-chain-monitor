import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sendAlerts, isTerminalAlertSuppression } from "./alerts.js";
import { parseFxTwitterTimeline, parseOfficialXOembed } from "./twitter-monitor.js";
import { createGeniusChainReader, GENIUS_FACTORY, GENIUS_FACTORY_CODE_HASH, GENIUS_START_BLOCK } from "./genius-chain-reader.js";
import { isStrictGeniusEvent, geniusDocumentChangesHash } from "./genius-source-policy.js";
import { hasGeniusBusinessChanges } from "./genius-summary.js";

export const GENIUS_DOCUMENTS = Object.freeze([
  { key: "genius_manifest", url: "https://genius.fun/contracts/manifest.json", kind: "manifest_update" },
  { key: "genius_about", url: "https://genius.fun/about", kind: "docs_update" },
  { key: "genius_integrate", url: "https://genius.fun/docs/integrate", kind: "docs_update" },
]);
export const GENIUS_X_ACCOUNTS = Object.freeze([
  { key: "genius_x_terminal", handle: "GeniusTerminal", userId: "1236460732486692864" },
  { key: "genius_x_foundation", handle: "GeniusFDN", userId: "1882130308918804480" },
]);
const SOURCE_KEYS = [...GENIUS_DOCUMENTS.map(x => x.key), ...GENIUS_X_ACCOUNTS.map(x => x.key), "genius_chain"];
const OFFICIAL_ROLES = new Set([
  "0xe7c7b7ee71db0f1b4f0ff25d7cec191268e7fd98", // Manifest owner/controller.
  "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed", // Manifest deployment wallet, not the public CREATE2 contract.
]);
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const own = (o, k) => Object.hasOwn(o, k);
const digest = value => createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
const iso = value => new Date(value).toISOString();
const plain = v => v && typeof v === "object" && !Array.isArray(v);

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

function decode(value) {
  return value.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => {
    const n = Number.parseInt(hex || decimal, hex ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  }).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function parseGeniusDocument(source, text) {
  if (source.key === "genius_manifest") {
    const m = JSON.parse(text);
    if (m.schemaVersion !== "1.0" || m.environment !== "prod" || m.chainId !== 56
        || typeof m.release?.name !== "string" || !Array.isArray(m.stacks) || !m.stacks.length
        || !m.stacks.every(s => typeof s.stackId === "string" && ADDRESS.test(s.contracts?.factory?.address)
          && HASH.test(s.contracts?.factory?.bytecodeHash) && Number.isSafeInteger(s.startBlock))) {
      throw new Error("GENIUS_MANIFEST_SCHEMA_INVALID");
    }
    // Discovery of a different official deployment is an alert, not authority
    // to replace the audited on-chain pin automatically.
    return m;
  }
  if (!/<title>[^<]*Genius\.fun/i.test(text) || !text.includes('https://genius.fun')) {
    throw new Error("GENIUS_DOCUMENT_IDENTITY_INVALID");
  }
  const lines = decode(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|pre)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")).split("\n").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.join(" ").length < 300 || lines.some(s => /^(?:Access denied|Just a moment|Verify you are human)$/i.test(s))) {
    throw new Error("GENIUS_DOCUMENT_INCOMPLETE");
  }
  return { lines };
}

export function geniusDocumentChanges(before, after, prefix = "") {
  if (stableJson(before) === stableJson(after)) return [];
  if (plain(before) && plain(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(k =>
      geniusDocumentChanges(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after) && prefix === "lines") {
    const old = new Set(before), next = new Set(after);
    return [
      ...before.filter(v => !next.has(v)).map(v => ({ field: "document", before: v, after: null })),
      ...after.filter(v => !old.has(v)).map(v => ({ field: "document", before: null, after: v })),
    ];
  }
  // Large arrays (e.g. 465 quote assets) are diffed by identity, not rendered
  // as a huge JSON blob or silently discarded when they pass the display cap.
  if (Array.isArray(before) && Array.isArray(after)) {
    let key = [...before, ...after].every(v => plain(v) && (v.pairToken || v.stackId || v.id !== undefined))
      ? v => String(v.pairToken || v.stackId || v.id).toLowerCase() : null;
    // Duplicate identities are ambiguous, not permission to overwrite an
    // earlier entry and silently lose its address/configuration change.
    if (key && [before, after].some(values => new Set(values.map(key)).size !== values.length)) key = null;
    const left = Object.fromEntries(before.map((v, i) => [key ? key(v) : String(i), v]));
    const right = Object.fromEntries(after.map((v, i) => [key ? key(v) : String(i), v]));
    return geniusDocumentChanges(left, right, prefix);
  }
  return [{ field: prefix || "document", before: before ?? null, after: after ?? null }];
}

export function classifyGeniusAnnouncement(text, handle) {
  const related = ["GeniusFDN", "GeniusTerminal"].includes(handle);
  return { related, addresses: [...new Set(text.match(/0x[a-fA-F0-9]{40}\b/g) || [])],
    // These describe claims, never trading permission or proved ownership.
    mentionsTesting: /\btest(?:ing|net)?\b|测试/i.test(text),
    disclaimsAffiliation: /not\s+(?:affiliated|associated|our|official)|unaffiliated|不是官方|无关|非官方/i.test(text) };
}

export function parseGeniusOembed(input, handle, id) {
  try { return { text: parseOfficialXOembed(input, handle, id), mediaOnly: false }; }
  catch (e) {
    // The shared verifier has already checked author + exact status link when
    // this specific error occurs. A media-only official post is not a broken
    // identity and must not prevent initialization or subsequent announcements.
    if (!String(e.message).startsWith("official X oEmbed text missing for ")) throw e;
    const payload = typeof input === "string" ? JSON.parse(input) : input;
    const paragraph = String(payload.html || "").match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    const text = decode(paragraph.replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
    if (!/pic\.(?:twitter|x)\.com\//i.test(text)) throw e;
    return { text, mediaOnly: true };
  }
}

function emptyHealth() { return { status: "initializing", checkedAt: null, lastSuccessAt: null, nextAttemptAt: null, consecutiveFailures: 0 }; }
function emptyState() {
  return { version: 1, identity: { chainId: 56, factory: GENIUS_FACTORY, factoryCodeHash: GENIUS_FACTORY_CODE_HASH },
    sources: Object.fromEntries(SOURCE_KEYS.map(k => [k, { initialized: false }])),
    health: { status: "initializing", checkedAt: null, sources: Object.fromEntries(SOURCE_KEYS.map(k => [k, emptyHealth()])) },
    chain: { initialized: false, startBlock: GENIUS_START_BLOCK, baselineBlock: null, realtimeNextBlock: null,
      historicalNextBlock: GENIUS_START_BLOCK, latestFinalizedBlock: null, historyComplete: false, anchors: {} },
    officialTokens: {}, mentionedTokens: {}, tokenOwners: {}, tokenResolutionFailures: {}, unresolvedTokenEvents: [], processedEvents: {}, pendingEvents: [] };
}

export function validateGeniusState(s) {
  if (s?.version !== 1 || s.identity?.chainId !== 56 || s.identity?.factory?.toLowerCase() !== GENIUS_FACTORY.toLowerCase()
      || s.identity?.factoryCodeHash !== GENIUS_FACTORY_CODE_HASH || !plain(s.sources) || !plain(s.health?.sources)
      || !plain(s.chain) || !plain(s.officialTokens) || !plain(s.mentionedTokens) || !plain(s.processedEvents)
      || !plain(s.tokenOwners) || !plain(s.tokenResolutionFailures) || !Array.isArray(s.unresolvedTokenEvents) || s.unresolvedTokenEvents.length > 5000
      || !Array.isArray(s.pendingEvents) || s.pendingEvents.length > 2000
      || SOURCE_KEYS.some(k => !plain(s.sources[k]) || typeof s.sources[k].initialized !== "boolean" || !plain(s.health.sources[k]))) {
    throw new Error("GENIUS_STATE_INVALID");
  }
  if (s.chain.startBlock !== GENIUS_START_BLOCK || !Number.isSafeInteger(s.chain.historicalNextBlock)
      || s.chain.historicalNextBlock < GENIUS_START_BLOCK || typeof s.chain.initialized !== "boolean"
      || !plain(s.chain.anchors) || (s.chain.initialized && (!Number.isSafeInteger(s.chain.realtimeNextBlock)
        || !Number.isSafeInteger(s.chain.baselineBlock) || s.chain.realtimeNextBlock < s.chain.baselineBlock + 1))) {
    throw new Error("GENIUS_CURSOR_INVALID");
  }
  for (const [address, token] of Object.entries(s.officialTokens)) {
    if (!ADDRESS.test(address) || token.address?.toLowerCase() !== address || !OFFICIAL_ROLES.has(token.deployer?.toLowerCase())) {
      throw new Error("GENIUS_TOKEN_IDENTITY_INVALID");
    }
  }
  for (const source of GENIUS_DOCUMENTS) {
    const v = s.sources[source.key];
    if (v.initialized && (!plain(v.snapshot) || v.hash !== digest(v.snapshot))) throw new Error("GENIUS_DOCUMENT_STATE_INVALID");
    if (v.pendingObservation && (!plain(v.pendingObservation.snapshot) || v.pendingObservation.hash !== digest(v.pendingObservation.snapshot)
      || !Array.isArray(v.pendingObservation.events) || v.pendingObservation.events.length > 2000
      || v.pendingObservation.events.some(e => !isStrictGeniusEvent(e) || e.sourceId !== source.key
        || e.evidence.beforeHash !== v.hash || e.evidence.afterHash !== v.pendingObservation.hash))) {
      throw new Error("GENIUS_DOCUMENT_OBSERVATION_INVALID");
    }
    if (v.pendingObservation) {
      const expected = geniusDocumentChanges(v.snapshot, v.pendingObservation.snapshot);
      const events = v.pendingObservation.events;
      if (!expected.length || !events.length) throw new Error("GENIUS_DOCUMENT_OBSERVATION_INCOMPLETE");
      if (events.some(e => e.aggregation === "complete_transition")) {
        if (!geniusDocumentChangesHash(expected) || events.length !== 1 || stableJson(events[0].changes) !== stableJson(expected)) {
          throw new Error("GENIUS_DOCUMENT_OBSERVATION_INCOMPLETE");
        }
      } else if (events.length !== Math.ceil(expected.length / 2)
        || events.some((e, index) => e.partIndex !== index || e.changeCount !== expected.length
          || stableJson(e.changes) !== stableJson(expected.slice(index * 2, index * 2 + 2)))) {
        throw new Error("GENIUS_DOCUMENT_OBSERVATION_INCOMPLETE");
      }
    }
  }
  for (const a of GENIUS_X_ACCOUNTS) {
    if (s.sources[a.key].initialized && !/^[1-9]\d{0,20}$/.test(s.sources[a.key].cursor || "")) throw new Error("GENIUS_X_CURSOR_INVALID");
  }
  for (const h of Object.values(s.health.sources)) {
    if (!Number.isSafeInteger(h.consecutiveFailures) || h.consecutiveFailures < 0) throw new Error("GENIUS_HEALTH_STATE_INVALID");
  }
  if (Object.keys(s.tokenOwners).length > 50000 || Object.entries(s.tokenOwners).some(([a,d]) => !ADDRESS.test(a) || !ADDRESS.test(d))
      || Object.keys(s.officialTokens).length > 5000 || Object.keys(s.mentionedTokens).length > 5000
      || Object.keys(s.processedEvents).length > 10000 || s.pendingEvents.some(e => !isStrictGeniusEvent(e))) {
    throw new Error("GENIUS_DURABLE_EVENT_STATE_INVALID");
  }
  for (const [lane, anchor] of Object.entries(s.chain.anchors)) {
    if (!["realtime", "historical"].includes(lane) || !plain(anchor) || !Number.isSafeInteger(anchor.number)
        || anchor.number !== s.chain[`${lane}NextBlock`] - 1 || !HASH.test(anchor.hash || "")
        || !Number.isSafeInteger(anchor.timestamp) || anchor.timestamp <= 0) throw new Error("GENIUS_ANCHOR_STATE_INVALID");
  }
  for (const entry of s.unresolvedTokenEvents) {
    const log = entry?.log;
    if (!["realtime", "historical"].includes(entry.lane) || !plain(log) || !plain(log.args)
        || !ADDRESS.test(log.args.token || "") || !HASH.test(log.transactionHash || "") || !HASH.test(log.blockHash || "")
        || !Number.isSafeInteger(log.blockNumber) || log.blockNumber < GENIUS_START_BLOCK
        || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0
        || !Number.isSafeInteger(log.blockTimestamp) || log.blockTimestamp <= 0
        || !/^[A-Za-z][A-Za-z0-9]+$/.test(log.name || "")
        || entry.key !== `${log.transactionHash}:${log.logIndex}:${log.blockHash}`
        || !Array.isArray(entry.providers) || entry.providers.length < 2
        || entry.providers.some(p => { try { const u = new URL(p); return u.protocol !== "https:" || u.origin !== p; } catch { return true; } })
        || new Set(entry.providers.map(p => new URL(p).hostname)).size < 2) throw new Error("GENIUS_UNRESOLVED_STATE_INVALID");
  }
  return s;
}

export async function atomicWriteGeniusState(file, state, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fsImpl.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await fsImpl.rename(temporary, file);
}

function deliveryAccepted(result) {
  return ["queued", "delivered", "duplicate", "already_queued"].includes(result?.status)
    || (result?.status === "suppressed" && isTerminalAlertSuppression(result));
}
function bound(value, fallback, min, max) { return Math.max(min, Math.min(max, Number(value) || fallback)); }

export function createGeniusMonitor(config = {}, dependencies = {}) {
  const enabled = config.geniusMonitorEnabled === true;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const fsImpl = dependencies.fsImpl || fs;
  const now = dependencies.now || Date.now;
  const logger = dependencies.logger || console;
  const sender = dependencies.sendAlertsImpl || sendAlerts;
  const reader = dependencies.chainReader || (enabled ? createGeniusChainReader({ rpcUrls: config.geniusRpcUrls,
    logRpcUrls: config.geniusLogRpcUrls,
    timeoutMs: bound(config.geniusRequestTimeoutMs, 6000, 500, 15000), confirmations: 15 }) : null);
  const stateFile = path.join(config.dataDir || "data", "genius-state.json");
  const timeoutMs = bound(config.geniusRequestTimeoutMs, 10000, 500, 15000);
  const intervals = { documents: bound(config.geniusDocsPollIntervalMs, 60000, 1000, 300000),
    x: bound(config.geniusXPollIntervalMs, 30000, 1000, 300000), chain: bound(config.geniusPollIntervalMs, 10000, 1000, 60000) };
  const maxRange = bound(config.geniusBlockRange, 512, 1, 2048);
  let state = emptyState(), loaded = false, stopped = false, active = null, saving = Promise.resolve(), writeFault = null;
  const controllers = new Set();
  async function initialize() {
    if (loaded) return;
    try { state = validateGeniusState(JSON.parse(await fsImpl.readFile(stateFile, "utf8"))); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    loaded = true;
  }
  async function persist() {
    if (writeFault) throw writeFault;
    const operation = saving.then(() => atomicWriteGeniusState(stateFile, structuredClone(state), fsImpl));
    saving = operation.catch(e => { writeFault = e; });
    return operation;
  }
  async function request(url, { json = true, etag = null } = {}) {
    if (stopped) throw new Error("GENIUS_STOPPED");
    const controller = new AbortController(); controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const r = await fetchImpl(url, { redirect: "error", signal,
        headers: { accept: json ? "application/json" : "text/html", "user-agent": "Genius-read-only-monitor/1", ...(etag ? { "if-none-match": etag } : {}) } });
      if (r.url && new URL(r.url).origin !== new URL(url).origin) throw new Error("GENIUS_RESPONSE_ORIGIN_MISMATCH");
      if (r.status === 304) return { notModified: true };
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
        const retry = r.headers.get("retry-after");
        const ms = /^\d+(?:\.\d+)?$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry || "") - now();
        e.retryMs = Number.isFinite(ms) ? Math.max(0, Math.min(900000, ms)) : 0;
        if ([403, 429].includes(r.status)) e.retryMs = Math.max(60000, e.retryMs);
        throw e;
      }
      const mime = r.headers.get("content-type") || "";
      if (json ? !/application\/(?:[\w.+-]*\+)?json/i.test(mime) : !/text\/html/i.test(mime)) throw new Error("GENIUS_CONTENT_TYPE_INVALID");
      const length = Number(r.headers.get("content-length"));
      if (length > 1_048_576) throw new Error("GENIUS_RESPONSE_TOO_LARGE");
      const chunks = []; let bytes = 0;
      const stream = r.body.getReader();
      try {
        while (true) { const { done, value } = await stream.read(); if (done) break;
          bytes += value.byteLength; if (bytes > 1_048_576) throw new Error("GENIUS_RESPONSE_TOO_LARGE"); chunks.push(value); }
      } finally { Promise.resolve(stream.cancel()).catch(() => {}); }
      return { text: Buffer.concat(chunks).toString("utf8"), etag: r.headers.get("etag") };
    } finally { controllers.delete(controller); }
  }
  function baseEvent(fields) {
    return { type: "genius_fun_update", platform: "geniusfun", chainId: 56, sourceTrust: "official_verified",
      observedAt: iso(now()), ...fields };
  }
  async function queue(event, { chainVerified = false } = {}) {
    if (own(state.processedEvents, event.eventKey)) return;
    if (stopped) throw new Error("GENIUS_STOPPED");
    if (!isStrictGeniusEvent(event)) throw new Error("GENIUS_EVENT_INVALID");
    if (!state.pendingEvents.some(e => e.eventKey === event.eventKey)) {
      if (state.pendingEvents.length >= 2000) throw new Error("GENIUS_PENDING_CAPACITY");
      state.pendingEvents.push(event);
      await persist();
    }
    // A durable reservation is not fresh canonical evidence. Re-check delayed
    // chain deliveries after restarts/identity recovery; a live range already
    // verified in this operation can use its existing proof.
    if (event.sourceId === "genius_chain" && !chainVerified) {
      const checked = await reader.readRange(event.blockNumber, event.blockNumber);
      const current = checked.events.find(log => log.transactionHash === event.transactionHash
        && log.logIndex === event.logIndex && log.blockHash === event.blockHash
        && log.blockNumber === event.blockNumber && log.name === event.evidence.eventName
        && iso(Number(log.blockTimestamp) * 1000) === event.sourceOccurredAt
        && stableJson(log.args) === stableJson(event.evidence.args));
      if (checked.anchor.hash !== event.blockHash || !current) {
        throw Object.assign(new Error("GENIUS_REORG: reserved event is no longer canonical"), { code: "GENIUS_REORG" });
      }
    }
    const documentNoise = ["manifest_update", "docs_update"].includes(event.kind) && !hasGeniusBusinessChanges(event.changes);
    if (!documentNoise) {
      if (stopped) throw new Error("GENIUS_STOPPED");
      const result = await sender(config, event);
      if (!deliveryAccepted(result)) throw new Error(`GENIUS_DELIVERY_NOT_DURABLE:${result?.status || "unknown"}`);
    }
    state.processedEvents[event.eventKey] = iso(now());
    state.pendingEvents = state.pendingEvents.filter(e => e.eventKey !== event.eventKey);
    const keys = Object.keys(state.processedEvents);
    if (keys.length > 10000) for (const k of keys.slice(0, keys.length - 10000)) delete state.processedEvents[k];
    await persist();
  }
  async function reserveEvents(events) {
    const added = events.filter(event => !own(state.processedEvents, event.eventKey)
      && !state.pendingEvents.some(e => e.eventKey === event.eventKey));
    if (state.pendingEvents.length + added.length > 2000) throw new Error("GENIUS_PENDING_CAPACITY");
    state.pendingEvents.push(...added);
    await persist();
  }
  async function finishDocumentObservation(source) {
    const pending = state.sources[source.key].pendingObservation;
    if (!pending) return;
    for (const event of pending.events) await queue(event);
    const old = state.sources[source.key];
    state.sources[source.key] = { initialized: true, snapshot: pending.snapshot, hash: pending.hash,
      etag: pending.etag, baselineAt: old.baselineAt };
    await persist();
  }
  async function document(source) {
    await finishDocumentObservation(source);
    const old = state.sources[source.key];
    const response = await request(source.url, { json: source.key === "genius_manifest", etag: old.etag });
    if (response.notModified) {
      if (!old.initialized || !old.snapshot) throw new Error("GENIUS_304_WITHOUT_BASELINE");
      return;
    }
    const snapshot = parseGeniusDocument(source, response.text), hash = digest(snapshot);
    if (old.initialized && hash !== old.hash) {
      const changes = geniusDocumentChanges(old.snapshot, snapshot);
      const changesHash = changes.length ? geniusDocumentChangesHash(changes) : null;
      if (changes.length && !changesHash) throw new Error("GENIUS_DOCUMENT_CHANGES_INVALID_OR_TOO_LARGE");
      if (hasGeniusBusinessChanges(changes)) {
        const events = [baseEvent({ kind: source.kind, sourceId: source.key, sourceUrl: source.url,
          eventKey: `genius:${source.key}:${old.hash}:${hash}`, sourceOccurredAt: iso(now()),
          aggregation: "complete_transition", changes, changeCount: changes.length, observationOnly: true,
          evidence: { sourceUrl: source.url, beforeHash: old.hash, afterHash: hash, changesHash } })];
        // Persist the whole observed transition before the first delivery. If
        // B reverts to A while delivery is down, neither B's changes nor the
        // B→A transition may disappear just because the web page changed again.
        old.pendingObservation = { snapshot, hash, etag: response.etag, events };
        await reserveEvents(events);
        await finishDocumentObservation(source);
      }
    }
    state.sources[source.key] = { initialized: true, snapshot, hash, etag: response.etag, baselineAt: old.baselineAt || iso(now()) };
  }
  async function xSource(account) {
    const old = state.sources[account.key];
    const response = await request(`https://api.fxtwitter.com/2/profile/id:${account.userId}/statuses?count=40`);
    const tweets = parseFxTwitterTimeline(response.text, account.handle, account.userId).sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    if (!tweets.length) throw new Error("GENIUS_X_EMPTY_TIMELINE_UNPROVEN");
    const latest = tweets.at(-1).id;
    if (!old.initialized) {
      const last = tweets.at(-1);
      const proof = await request(`https://publish.x.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(last.url)}`);
      parseGeniusOembed(proof.text, account.handle, last.id);
      state.sources[account.key] = { initialized: true, cursor: latest, baselineAt: iso(now()), continuityGap: null };
      return;
    }
    const newer = tweets.filter(t => BigInt(t.id) > BigInt(old.cursor));
    const gap = newer.length && !tweets.some(t => t.id === old.cursor);
    // A capped timeline cannot prove missing history. Process what is visible,
    // but keep the durable cursor and expose the gap instead of silently skipping.
    const failures = { ...(old.verificationFailures || {}) };
    let probes = 0;
    for (const tweet of newer) {
      const key = `genius:x:${account.userId}:${tweet.id}`;
      if (own(state.processedEvents, key)) continue;
      if (Date.parse(failures[tweet.id]?.nextAttemptAt || "") > now() || probes >= 4) continue;
      probes += 1;
      let text, mediaOnly = false;
      try {
        const proof = await request(`https://publish.x.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(tweet.url)}`);
        ({ text, mediaOnly } = parseGeniusOembed(proof.text, account.handle, tweet.id));
        delete failures[tweet.id];
      } catch(e) {
        failures[tweet.id] = { lastError: String(e.message).slice(0,300), checkedAt: iso(now()),
          nextAttemptAt: iso(now() + Math.min(900000, Math.max(60000,e.retryMs || 0))) };
        continue;
      }
      const analysis = classifyGeniusAnnouncement(text, account.handle);
      if (!analysis.related) continue;
      const event = baseEvent({ kind: "official_announcement", sourceId: "genius_x", sourceUrl: tweet.url,
        sourceOccurredAt: tweet.createdAt, historical: now() - Date.parse(tweet.createdAt) > 600000,
        eventKey: key, identity: { handle: account.handle, userId: account.userId, verified: true,
          verification: "fxtwitter_numeric_id+official_x_oembed" },
        tweet: { id: tweet.id, text, createdAt: tweet.createdAt, author: { id: account.userId, screen_name: account.handle } },
        mentionsTesting: analysis.mentionsTesting, disclaimsAffiliation: analysis.disclaimsAffiliation,
        mediaOnly,
        mentionedAddresses: analysis.addresses, evidence: { sourceUrl: tweet.url, verification: "fxtwitter_numeric_id+official_x_oembed" } });
      await queue(event);
      for (const address of analysis.addresses) {
        if (Object.keys(state.mentionedTokens).length >= 5000 && !own(state.mentionedTokens, address.toLowerCase())) throw new Error("GENIUS_MENTIONED_TOKEN_CAPACITY");
        state.mentionedTokens[address.toLowerCase()] = { address, sourceUrl: tweet.url, observedAt: iso(now()),
          classification: analysis.disclaimsAffiliation ? "officially_disclaimed" : "official_mentioned", mentionsTesting: analysis.mentionsTesting };
      }
    }
    const unprocessed = newer.some(t => !own(state.processedEvents, `genius:x:${account.userId}:${t.id}`));
    const continuityGap = gap ? "durable_cursor_not_in_numeric_timeline" : unprocessed ? "tweet_verification_or_delivery_pending" : null;
    state.sources[account.key] = { ...old, cursor: continuityGap ? old.cursor : latest, continuityGap,
      verificationFailures: Object.fromEntries(Object.entries(failures).slice(-200)) };
    if (continuityGap) state.health.sources[account.key].coverageGap = continuityGap;
    else delete state.health.sources[account.key].coverageGap;
  }
  function rememberToken(token) {
    const key = token.address.toLowerCase();
    if (Object.keys(state.officialTokens).length >= 5000 && !own(state.officialTokens, key)) throw new Error("GENIUS_OFFICIAL_TOKEN_CAPACITY");
    state.officialTokens[key] = { ...state.officialTokens[key], ...token };
  }
  async function consumeChainEvent(lane, log, providers, chainVerified = false) {
      const token = String(log.args.token || "").toLowerCase();
      const tokenRelated = Boolean(log.args.token);
      const historical = lane === "historical" || now() - Number(log.blockTimestamp) * 1000 > 600000;
      const event = baseEvent({ kind: log.name === "TokenLaunched" ? "official_token_launch" : tokenRelated ? "official_token_lifecycle" : "factory_config",
        sourceId: "genius_chain", sourceUrl: `https://bscscan.com/tx/${log.transactionHash}`,
        eventKey: `genius:chain:${log.transactionHash}:${log.logIndex}:${log.blockHash}`,
        factory: GENIUS_FACTORY, transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex,
        historical, sourceOccurredAt: iso(Number(log.blockTimestamp) * 1000),
        ...(tokenRelated ? { token: structuredClone(state.officialTokens[token]) } : {}),
        evidence: { chainId: 56, factory: GENIUS_FACTORY, runtimeCodeHash: GENIUS_FACTORY_CODE_HASH,
          providers, eventName: log.name, args: log.args } });
      if (lane !== "historical") await queue(event, { chainVerified });
      if (tokenRelated) {
        const previous = state.officialTokens[token].lastEvent;
        if (!previous || log.blockNumber > previous.blockNumber || (log.blockNumber === previous.blockNumber && log.logIndex > previous.logIndex)) {
          state.officialTokens[token].lastEvent = { name: log.name, blockNumber: log.blockNumber, logIndex: log.logIndex, args: log.args };
        }
      }
  }
  async function applyChainRange(lane, range) {
    for (const log of range.events) {
      const token = String(log.args.token || "").toLowerCase();
      if (log.name === "TokenLaunched" && OFFICIAL_ROLES.has(String(log.args.deployer).toLowerCase())) {
        rememberToken({ address: log.args.token, deployer: log.args.deployer, curve: log.args.curve,
          classification: "official_wallet_associated", launchBlock: log.blockNumber, transactionHash: log.transactionHash });
      }
      const tokenRelated = Boolean(log.args.token);
      if (log.name === "TokenLaunched") {
        if (Object.keys(state.tokenOwners).length >= 50000 && !own(state.tokenOwners, token)) throw new Error("GENIUS_TOKEN_OWNER_CAPACITY");
        state.tokenOwners[token] = log.args.deployer.toLowerCase();
      }
      if (tokenRelated && !own(state.officialTokens, token)) {
        if (!own(state.tokenOwners, token)) {
          const key = `${log.transactionHash}:${log.logIndex}:${log.blockHash}`;
          if (!state.unresolvedTokenEvents.some(e => e.key === key)) {
            if (state.unresolvedTokenEvents.length >= 5000) throw new Error("GENIUS_UNRESOLVED_CAPACITY");
            state.unresolvedTokenEvents.push({ key, lane, log, providers: range.providers });
          }
        }
        continue;
      }
      await consumeChainEvent(lane, log, range.providers, true);
    }
    state.chain[`${lane}NextBlock`] = range.toBlock + 1;
    state.chain.anchors[lane] = range.anchor;
  }
  async function resolveTokenEvents() {
    const due = [...new Set(state.unresolvedTokenEvents.map(e => e.log.args.token.toLowerCase()))]
      .filter(a => !(Date.parse(state.tokenResolutionFailures[a]?.nextAttemptAt || "") > now())).slice(0,2);
    for (const address of due) {
      try {
      if (!own(state.tokenOwners, address)) {
        const record = await reader.readToken(address);
        if (!record.exists || record.token.toLowerCase() !== address) throw new Error("GENIUS_LAUNCH_RECORD_MISMATCH");
        if (Object.keys(state.tokenOwners).length >= 50000) throw new Error("GENIUS_TOKEN_OWNER_CAPACITY");
        state.tokenOwners[address] = record.deployer.toLowerCase();
        if (OFFICIAL_ROLES.has(record.deployer.toLowerCase())) rememberToken({ address: record.token, curve: record.curve,
          deployer: record.deployer, classification: "official_wallet_associated" });
      }
      for (const entry of state.unresolvedTokenEvents.filter(e => e.log.args.token.toLowerCase() === address)) {
        if (own(state.officialTokens, address)) await consumeChainEvent(entry.lane, entry.log, entry.providers);
        state.unresolvedTokenEvents = state.unresolvedTokenEvents.filter(e => e.key !== entry.key);
      }
      delete state.tokenResolutionFailures[address];
      } catch (e) {
        const failures = (state.tokenResolutionFailures[address]?.consecutiveFailures || 0) + 1;
        state.tokenResolutionFailures[address] = { consecutiveFailures: failures, lastError: String(e.message).slice(0,300),
          lastErrorCode: e.code || /^GENIUS_[A-Z_]+/.exec(e.message)?.[0] || "GENIUS_TOKEN_SOURCE_FAILED",
          nextAttemptAt: iso(now() + Math.min(900000,60000 * 2 ** Math.min(failures - 1,4))) };
      }
      await persist();
    }
  }
  async function chainSource() {
    // Keep chain retries within this source's durable backoff. HTTP-source
    // polls must not replay an orphan or repeatedly hammer a limited RPC.
    for (const event of [...state.pendingEvents].filter(e => e.sourceId === "genius_chain")) await queue(event);
    // Drain existing identity work before admitting more ranges. Full or
    // temporarily failing scans must not deadlock the recovery queue.
    await resolveTokenEvents();
    const head = await reader.head();
    state.chain.latestFinalizedBlock = head.number;
    if (!state.chain.initialized) {
      state.chain.initialized = true;
      state.chain.baselineBlock = head.number;
      state.chain.realtimeNextBlock = head.number + 1;
      state.chain.anchors.realtime = head;
      await persist();
    }
    for (const lane of ["realtime", "historical"]) {
      const from = state.chain[`${lane}NextBlock`];
      const target = lane === "historical" ? state.chain.baselineBlock : head.number;
      if (from > target) continue;
      const previousAnchor = state.chain.anchors[lane];
      // Re-read the prior anchor before extending a durable range. On mismatch
      // preserve both cursors; never silently rewind and replay delivered cards.
      if (previousAnchor) {
        const check = await reader.readRange(previousAnchor.number, previousAnchor.number);
        if (check.anchor.hash !== previousAnchor.hash) throw new Error("GENIUS_CANONICAL_ANCHOR_CHANGED");
      }
      let size = maxRange, range;
      while (true) {
        try { range = await reader.readRange(from, Math.min(target, from + size - 1)); break; }
        catch (e) {
          if (size > 1 && /TOO_DENSE|RESPONSE_TOO_LARGE|range|too many/i.test(`${e.code} ${e.message}`)) { size = Math.max(1, Math.floor(size / 2)); continue; }
          throw e;
        }
      }
      await applyChainRange(lane, range);
      await persist();
    }
    state.chain.historyComplete = state.chain.historicalNextBlock > state.chain.baselineBlock;
    state.sources.genius_chain.initialized = true;
    state.health.sources.genius_chain.coverageGap = state.unresolvedTokenEvents.length ? "token_identity_resolution_pending"
      : state.chain.historyComplete ? null : "historical_backfill_pending";
  }
  async function runSource(key, interval, fn, force) {
    const h = state.health.sources[key];
    if (!force && Date.parse(h.nextAttemptAt || "") > now()) return;
    h.checkedAt = iso(now());
    try {
      await fn();
      h.status = h.coverageGap ? "partial" : "healthy";
      h.lastSuccessAt = iso(now()); h.lastError = null; h.lastErrorCode = null; h.consecutiveFailures = 0;
      h.providerOrigin = null;
      h.nextAttemptAt = iso(now() + interval);
    } catch (e) {
      h.status = "backoff"; h.consecutiveFailures += 1;
      h.lastError = String(e.message).slice(0, 600);
      h.lastErrorCode = e.code || /^GENIUS_[A-Z_]+/.exec(e.message)?.[0] || "GENIUS_SOURCE_FAILED";
      const after = String(e.retryAfter || "");
      const rpcRetryMs = /^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - now()) || 0;
      const rateLimitFloor = [403,429].includes(e.status) ? 60000 : 0;
      h.nextAttemptAt = iso(now() + Math.min(900000, Math.max(e.retryMs || 0, rpcRetryMs, rateLimitFloor, interval, 5000 * 2 ** Math.min(h.consecutiveFailures - 1, 8))));
      h.providerOrigin = e.providerOrigin || null;
      logger.error?.(`[genius.fun][${key}] ${h.lastError}`);
    }
    h.checkedAt = iso(now());
    await persist();
  }
  async function run(force) {
    await initialize();
    if (writeFault) throw writeFault;
    // Delivery recovery never drops a reservation even if the remote document
    // changes again. Failed deliveries retain the source baseline as well.
    for (const event of [...state.pendingEvents].filter(e => e.sourceId !== "genius_chain")) {
      try { await queue(event); } catch (e) { logger.error?.(`[genius.fun][delivery] ${e.message}`); break; }
    }
    await Promise.allSettled([
      ...GENIUS_DOCUMENTS.map(s => runSource(s.key, intervals.documents, () => document(s), force)),
      ...GENIUS_X_ACCOUNTS.map(a => runSource(a.key, intervals.x, () => xSource(a), force)),
      runSource("genius_chain", intervals.chain, chainSource, force),
    ]);
    if (writeFault) throw writeFault;
    state.health.checkedAt = iso(now());
    state.health.status = SOURCE_KEYS.every(k => state.health.sources[k].status === "healthy") ? "healthy" : "degraded";
    await persist();
    return structuredClone(state.health);
  }
  function check({ force = false } = {}) {
    if (!enabled || stopped) return Promise.resolve({ status: enabled ? "stopped" : "disabled" });
    if (!active) active = run(force).finally(() => { active = null; });
    return active;
  }
  const timer = enabled && dependencies.autoStart !== false ? setInterval(() => {
    void check().catch(e => logger.error?.(`[genius.fun] ${e.message}`));
  }, Math.min(intervals.chain, intervals.x, intervals.documents)) : null;
  timer?.unref();
  if (timer) void check().catch(e => logger.error?.(`[genius.fun] ${e.message}`));
  return { check, state: () => structuredClone(state), stateFile, stop: async () => {
    stopped = true; clearInterval(timer); for (const controller of controllers) controller.abort();
    await reader?.stop?.(); await active; await saving;
  } };
}
