import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isTerminalAlertSuppression, sendAlerts } from "./alerts.js";

export const X_API_CHANGELOG_RSS_URL = "https://docs.x.com/changelog/rss.xml";
export const XAI_RELEASE_NOTES_URL = "https://docs.x.ai/developers/release-notes.md";
export const XAI_NEWS_JINA_URL = "https://r.jina.ai/https://x.ai/news";

const DEFAULT_INTERVALS = Object.freeze({
  x_api_changelog: 15_000,
  xai_release_notes: 30_000,
  xai_news: 30_000,
});
const DEFAULT_BACKOFF_BASE_MS = 15_000;
const DEFAULT_BACKOFF_MAX_MS = 15 * 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_RETENTION = 2_000;

const MONTHS = new Map([
  ["january", 0], ["february", 1], ["march", 2], ["april", 3],
  ["may", 4], ["june", 5], ["july", 6], ["august", 7],
  ["september", 8], ["october", 9], ["november", 10], ["december", 11],
]);

const ACTION_SIGNAL = /\b(?:introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|rolls?\s+out|ship(?:s|ped|ping)?|deploy(?:s|ed|ing)?|add(?:s|ed|ing)?|support(?:s|ed|ing)?|enabl(?:e|es|ed|ing)|available|can\s+now|now\s+accepts?|new|creat(?:e|es|ed|ing)|improv(?:e|es|ed|ing)|expand(?:s|ed|ing)|upgrad(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|migrat(?:e|es|ed|ing|ion)|integrat(?:e|es|ed|ing|ion)|open[- ]sourc(?:e|es|ed|ing)|deprecat(?:e|es|ed|ing|ion)|sunset|retir(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|break(?:ing)?)\b/i;
const PRODUCT_SIGNAL = /\b(?:grok(?:\s+\d+(?:\.\d+)*)?|model|api|sdk|endpoint|webhook|stream(?:ing)?|x\s+activity\s+api|agent|tool(?:ing)?|connector|plugin|bot|imagine|video|voice|search|deepsearch|think(?:ing)?|code|build|enterprise|console|authentication|oauth|rate\s+limit|pricing|subscription|security|safety|open\s+source)\b/i;
const BREAKING_OR_SECURITY = /\b(?:breaking\s+change|deprecat(?:e|es|ed|ing|ion)|sunset|retir(?:e|es|ed|ing)|remov(?:e|es|ed|ing)\s+(?:an?\s+)?(?:api|endpoint|field)|mandatory\s+migration|security\s+(?:incident|update|fix|advisory)|vulnerab(?:ility|ilities)|exploit|breach|oauth|authentication|pricing|rate\s+limit)\b/i;
const MODEL_VERSION = /\b(?:grok(?:[-\s]+[a-z][a-z0-9]*){0,5}|imagine(?:[-\s]+(?:image|video))?)[-\s]+\d+(?:[.\s]\d+){0,2}\b/i;
const CORPORATE_NOISE = /\b(?:acquir(?:e|es|ed|ing|ed\s+by)|merg(?:e|es|ed|ing)|funding|fundrais(?:e|es|ed|ing)|rais(?:e|es|ed|ing)\s+\$?\d|valuation|partnership|partner(?:s|ed|ing)?\s+with|government\s+contract|data\s+center|supercomputer|compute\s+cluster|hiring|career|job\s+opening)\b/i;
const LOW_SIGNAL = /\b(?:case\s+study|customer\s+story|webinar|podcast|conference|event\s+recap|giveaway|contest|sweepstakes|merch|hiring|job\s+opening|office\s+tour|holiday|campaign|advertis(?:e|ing|ement)|tutorial|how\s+to|documentation\s+(?:typo|fix|cleanup)|minor\s+documentation|formatting\s+only)\b/i;
const DOCS_ONLY = /\b(?:documentation|docs?|example|sample|typo|formatting|wording|clarif(?:y|ies|ied|ication))\b/i;
const IDENTIFIER_SIGNAL = /\b(?:grok[-\s]+\d+(?:\.\d+)*(?:[-\s]+(?:fast|mini|heavy|preview|beta))?|grok[-\s]+(?:bot|build|imagine|voice|code)(?:[-\s]+(?:image|video|fast|mini|preview|beta|\d+(?:\.\d+)*)){0,3}|imagine[-\s]+(?:image|video)[-\s]+\d+(?:\.\d+)*|x\s+activity\s+api|responses\s+api|batch\s+api|files\s+api|xdk|mcp|websocket|webhook|oauth\s*2(?:\.0)?|[a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})\b/gi;

function digest(value, length = 20) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, length);
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value ?? Date.now());
}

function iso(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  return new Date(milliseconds).toISOString();
}

function normalizeSpace(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'");
}

function stripHtml(value) {
  return normalizeSpace(decodeEntities(String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|li|h\d)>/gi, ". ")
    .replace(/<[^>]*>/g, " ")));
}

function stripMarkdown(value) {
  return normalizeSpace(String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#{1,6}\s*/g, " ")
    .replace(/[`*_~>|]/g, " "));
}

function truncate(value, maximum = 700) {
  const text = normalizeSpace(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function tagValue(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml || "").match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeEntities(match[1]).trim() : "";
}

function safePublishedAt(value) {
  const raw = String(value || "").trim();
  const hasTimezone = /(?:z|gmt|utc|[+-]\d{2}:?\d{2})$/i.test(raw);
  const milliseconds = Date.parse(hasTimezone || !raw ? raw : `${raw} UTC`);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function slugify(value) {
  return String(value || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

function canonicalNewsUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "x.ai" && url.hostname.toLowerCase() !== "www.x.ai") return null;
    const match = url.pathname.match(/^\/news\/([a-z0-9][a-z0-9-]*)\/?$/i);
    return match ? `https://x.ai/news/${match[1].toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function entry(sourceKey, identity, fields) {
  const stableId = `${sourceKey}:${digest(identity)}`;
  const { fingerprintContent, ...publicFields } = fields;
  const contentHash = digest({
    title: normalizeSpace(fields.title).toLowerCase(),
    summary: normalizeSpace(fingerprintContent ?? fields.summary),
    url: fields.url,
  });
  return { ...publicFields, id: stableId, stableId, contentHash, sourceKey };
}

export function parseXApiChangelogRss(xml, options = {}) {
  const sourceUrl = options.sourceUrl || X_API_CHANGELOG_RSS_URL;
  const items = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map((itemXml) => {
    const encoded = tagValue(itemXml, "content:encoded") || tagValue(itemXml, "description");
    const heading = encoded.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1];
    const fallbackTitle = tagValue(itemXml, "title");
    const title = stripHtml(heading || fallbackTitle) || "X API changelog update";
    const url = tagValue(itemXml, "link") || sourceUrl;
    const guid = tagValue(itemXml, "guid") || url || `${fallbackTitle}|${tagValue(itemXml, "pubDate")}`;
    return entry("x_api_changelog", guid, {
      title,
      summary: truncate(stripHtml(encoded) || fallbackTitle),
      fingerprintContent: stripHtml(encoded) || fallbackTitle,
      url,
      publishedAt: safePublishedAt(tagValue(itemXml, "pubDate")),
      externalId: guid,
    });
  });
}

function markdownLink(value) {
  const match = String(value || "").match(/\[[^\]]+\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/i);
  if (!match) return null;
  try { return new URL(match[1], "https://docs.x.ai").toString(); }
  catch { return null; }
}

export function parseXaiReleaseNotesMarkdown(markdown, options = {}) {
  const sourceUrl = options.sourceUrl || XAI_RELEASE_NOTES_URL;
  const referenceDate = options.observedAt || new Date().toISOString();
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const results = [];
  let section = "Release Notes";
  const reference = new Date(referenceDate);
  let inferredYear = reference.getUTCFullYear();
  let previousMonth = reference.getUTCMonth();
  let sawMonth = false;
  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      const rawSection = stripMarkdown(sectionMatch[1]);
      const explicitYear = rawSection.match(/\b(20\d{2})\b/)?.[1];
      const monthName = rawSection.replace(/\b20\d{2}\b/g, "").trim();
      const month = MONTHS.get(monthName.toLowerCase());
      if (month != null) {
        if (explicitYear) inferredYear = Number(explicitYear);
        else if ((!sawMonth && month > reference.getUTCMonth()) || (sawMonth && month > previousMonth)) inferredYear -= 1;
        section = `${monthName} ${inferredYear}`;
        previousMonth = month;
        sawMonth = true;
      } else {
        section = rawSection;
      }
      continue;
    }
    const titleMatch = lines[index].match(/^###\s+(.+?)\s*$/);
    if (!titleMatch) continue;
    const title = stripMarkdown(titleMatch[1]);
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length && !/^#{2,3}\s+/.test(lines[cursor])) {
      body.push(lines[cursor]);
      cursor += 1;
    }
    index = cursor - 1;
    if (!title) continue;
    const rawBody = body.join("\n").trim();
    const linkedUrl = markdownLink(rawBody);
    const anchor = slugify(title);
    results.push(entry("xai_release_notes", `${section.toLowerCase()}|${title.toLowerCase()}`, {
      title,
      summary: truncate(stripMarkdown(rawBody) || title),
      fingerprintContent: stripMarkdown(rawBody) || title,
      url: linkedUrl || `${sourceUrl}${anchor ? `#${anchor}` : ""}`,
      publishedAt: null,
      section,
    }));
  }
  return results;
}

function titleFromNewsSlug(slug) {
  const casing = new Map([
    ["grok", "Grok"], ["xai", "xAI"], ["ai", "AI"], ["api", "API"],
    ["sdk", "SDK"], ["github", "GitHub"], ["ios", "iOS"], ["gpu", "GPU"],
  ]);
  return slug.split("-").filter(Boolean).map((word) => casing.get(word) || `${word[0]?.toUpperCase() || ""}${word.slice(1)}`).join(" ");
}

export function parseXaiNewsJina(markdown, options = {}) {
  const text = String(markdown || "");
  const target = /\]\((https?:\/\/(?:www\.)?x\.ai\/news\/([a-z0-9][a-z0-9-]*)(?:[?#][^)]*)?)\)/gi;
  const byUrl = new Map();
  let match;
  while ((match = target.exec(text))) {
    const url = canonicalNewsUrl(match[1]);
    if (!url) continue;
    const slug = url.slice(url.lastIndexOf("/") + 1);
    const headingStart = text.lastIndexOf("### [", match.index);
    const cardStart = text.lastIndexOf("[![", match.index);
    const nearest = Math.max(headingStart, cardStart, match.index - 900);
    const rawContext = text.slice(Math.max(0, nearest), match.index);
    const publishedMatch = rawContext.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i);
    const parsed = entry("xai_news", url, {
      title: titleFromNewsSlug(slug),
      summary: truncate(stripMarkdown(rawContext).replace(/^(?:All posts\s+)?/i, "")),
      fingerprintContent: stripMarkdown(rawContext).replace(/^(?:All posts\s+)?/i, ""),
      url,
      publishedAt: safePublishedAt(publishedMatch?.[0]),
      externalId: slug,
    });
    const existing = byUrl.get(url);
    if (!existing || parsed.summary.length > existing.summary.length) byUrl.set(url, parsed);
  }
  return [...byUrl.values()];
}

export function classifyAiOfficialUpdate(candidate = {}) {
  const sourceKey = String(candidate.sourceKey || "");
  const text = normalizeSpace(`${candidate.title || ""} ${candidate.summary || ""}`);
  if (!text) return { relevant: false, strong: false, category: "其他", labels: [], reason: "empty" };
  const breaking = BREAKING_OR_SECURITY.test(text);
  const versionedModel = MODEL_VERSION.test(text);
  const lowSignal = LOW_SIGNAL.test(text);
  const corporateNoise = CORPORATE_NOISE.test(text);
  const identifiers = [...new Set([...text.matchAll(IDENTIFIER_SIGNAL)]
    .map((match) => normalizeSpace(match[0]).toLowerCase()))].slice(0, 6);
  const stage = breaking && /\b(?:deprecat|sunset|retir)\b/i.test(text) ? "deprecated"
    : breaking && /\bremov(?:e|es|ed|ing)\b/i.test(text) ? "removed"
      : /\b(?:security\s+(?:incident|update|fix|advisory)|vulnerab|exploit|breach)\b/i.test(text) ? "security"
        : /\b(?:pricing|price\s+(?:cut|drop|change))\b/i.test(text) ? "pricing"
          : /\b(?:preview|early\s+access)\b/i.test(text) ? "preview"
            : /\bbeta\b/i.test(text) ? "beta" : "available";
  let relevant;
  let category;
  if (corporateNoise && !breaking) {
    relevant = false;
    category = "公司动态";
  } else if (sourceKey === "x_api_changelog") {
    relevant = breaking || (!lowSignal && PRODUCT_SIGNAL.test(text) && (ACTION_SIGNAL.test(text) || /\b(?:endpoint|event|field|webhook|stream|api)\b/i.test(text)));
    if (DOCS_ONLY.test(text) && !breaking && !/\b(?:api|endpoint|event|field|webhook|stream)\b/i.test(text)) relevant = false;
    category = breaking ? "X API 重大变更" : "X API 功能更新";
  } else if (sourceKey === "xai_release_notes") {
    // Each H3 in this official document is a shipped capability, not a blog post.
    relevant = !lowSignal && (!DOCS_ONLY.test(text) || breaking || PRODUCT_SIGNAL.test(text));
    category = breaking ? "安全/兼容性更新"
      : versionedModel || /\bmodel\b/i.test(text) ? "模型更新"
        : /\b(?:api|sdk|endpoint|developer|console)\b/i.test(text) ? "开发者更新" : "Grok 产品更新";
  } else {
    relevant = breaking || versionedModel || (!lowSignal && ACTION_SIGNAL.test(text) && PRODUCT_SIGNAL.test(text));
    if (lowSignal && !breaking && !versionedModel) relevant = false;
    category = breaking ? "安全/兼容性更新"
      : versionedModel || /\bmodel\b/i.test(text) ? "模型更新"
        : /\b(?:api|sdk|endpoint|developer|console)\b/i.test(text) ? "开发者更新"
          : "Grok 产品更新";
  }
  const labels = [];
  if (versionedModel || /\bmodel\b/i.test(text)) labels.push("模型");
  if (/\b(?:api|sdk|endpoint|webhook|stream)\b/i.test(text)) labels.push("API");
  if (/\b(?:grok|bot|imagine|voice|search|agent|tool|build)\b/i.test(text)) labels.push("Grok 功能");
  if (breaking) labels.push("重大变更");
  return {
    relevant,
    strong: Boolean(relevant),
    category,
    labels: [...new Set(labels)],
    identifiers,
    stage,
    reason: relevant ? "material_official_update" : corporateNoise ? "corporate_noise" : lowSignal ? "low_signal_content" : "no_material_product_change",
  };
}

function aiDisplaySnapshot(item = {}, signal = {}) {
  const identifiers = [...new Set((signal.identifiers || item.identifiers || [])
    .map((value) => normalizeSpace(value))
    .filter(Boolean))].slice(0, 6);
  return {
    title: truncate(item.title, 180),
    summary: truncate(item.summary, 360),
    stage: normalizeSpace(signal.stage || item.stage || "available"),
    identifiers,
  };
}

function aiSnapshotFromRecord(record = {}) {
  if (record.displaySnapshot && typeof record.displaySnapshot === "object") return record.displaySnapshot;
  return {
    ...(record.title ? { title: truncate(record.title, 180) } : {}),
    ...(record.summary ? { summary: truncate(record.summary, 360) } : {}),
    ...(record.stage ? { stage: normalizeSpace(record.stage) } : {}),
    identifiers: Array.isArray(record.identifiers) ? record.identifiers.slice(0, 6) : [],
    ...(!record.title && !record.summary && record.contentHash ? { contentFingerprint: record.contentHash } : {}),
  };
}

function changedSnapshotFields(previousSnapshot, currentSnapshot) {
  const previous = previousSnapshot && typeof previousSnapshot === "object" ? previousSnapshot : {};
  const current = currentSnapshot && typeof currentSnapshot === "object" ? currentSnapshot : {};
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(current[field] ?? null));
}

function aiStateEntry(item, signal, observedAt) {
  const displaySnapshot = aiDisplaySnapshot(item, signal);
  return {
    contentHash: item.contentHash,
    seenAt: observedAt,
    publishedAt: item.publishedAt || null,
    title: displaySnapshot.title,
    summary: displaySnapshot.summary,
    stage: displaySnapshot.stage,
    identifiers: displaySnapshot.identifiers,
    displaySnapshot,
  };
}

function defaultHealth() {
  return {
    status: "initializing",
    checkedAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
  };
}

function emptyState(sources) {
  return {
    version: 1,
    sources: Object.fromEntries(sources.map((source) => [source.key, { initialized: false, entries: {} }])),
    health: {
      status: "initializing",
      checkedAt: null,
      sources: Object.fromEntries(sources.map((source) => [source.key, defaultHealth()])),
    },
  };
}

function normalizeState(parsed, sources) {
  const baseline = emptyState(sources);
  if (!parsed || typeof parsed !== "object") return baseline;
  for (const source of sources) {
    const previousSource = parsed.sources?.[source.key];
    if (previousSource && typeof previousSource === "object") {
      baseline.sources[source.key] = {
        initialized: previousSource.initialized === true,
        entries: previousSource.entries && typeof previousSource.entries === "object" ? previousSource.entries : {},
      };
    }
    const previousHealth = parsed.health?.sources?.[source.key];
    if (previousHealth && typeof previousHealth === "object") {
      baseline.health.sources[source.key] = { ...defaultHealth(), ...previousHealth };
    }
  }
  baseline.health.status = parsed.health?.status || baseline.health.status;
  baseline.health.checkedAt = parsed.health?.checkedAt || null;
  return baseline;
}

async function readState(file, sources, fsImpl) {
  try {
    return normalizeState(JSON.parse(await fsImpl.readFile(file, "utf8")), sources);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState(sources);
    throw error;
  }
}

export async function atomicWriteXaiOfficialState(file, state, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await fsImpl.rename(temporary, file);
  } catch (error) {
    if (typeof fsImpl.rm === "function") await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function sourceDefinitions(config, dependencies) {
  const defaults = [
    {
      key: "x_api_changelog",
      name: "X API Changelog",
      project: { id: "x", name: "X", website: "https://x.com", twitter: "https://x.com/X" },
      url: config.xApiChangelogRssUrl || X_API_CHANGELOG_RSS_URL,
      accept: "application/rss+xml, application/xml, text/xml, */*",
      parser: parseXApiChangelogRss,
      intervalMs: config.xApiChangelogPollIntervalMs ?? DEFAULT_INTERVALS.x_api_changelog,
    },
    {
      key: "xai_release_notes",
      name: "xAI Developer Release Notes",
      project: { id: "xai", name: "xAI / Grok", website: "https://x.ai", twitter: "https://x.com/SpaceXAI", socials: ["https://x.com/SpaceXAI", "https://x.com/grok"] },
      url: config.xaiReleaseNotesUrl || XAI_RELEASE_NOTES_URL,
      // docs.x.ai currently returns 404 when text/markdown appears in Accept.
      accept: "text/plain, */*",
      parser: parseXaiReleaseNotesMarkdown,
      intervalMs: config.xaiReleaseNotesPollIntervalMs ?? DEFAULT_INTERVALS.xai_release_notes,
    },
    {
      key: "xai_news",
      name: "xAI News",
      project: { id: "xai", name: "xAI / Grok", website: "https://x.ai", twitter: "https://x.com/SpaceXAI", socials: ["https://x.com/SpaceXAI", "https://x.com/grok"] },
      url: config.xaiNewsJinaUrl || XAI_NEWS_JINA_URL,
      accept: "text/plain, */*",
      parser: parseXaiNewsJina,
      intervalMs: config.xaiNewsPollIntervalMs ?? DEFAULT_INTERVALS.xai_news,
    },
  ];
  const replacements = dependencies.sourceDefinitions;
  if (!Array.isArray(replacements)) return defaults;
  const byKey = new Map(defaults.map((source) => [source.key, source]));
  return replacements.map((source) => ({ ...byKey.get(source.key), ...source }));
}

function responseHeader(response, name) {
  return typeof response?.headers?.get === "function" ? response.headers.get(name) : null;
}

function pruneEntries(entries, retention) {
  const records = Object.entries(entries);
  if (records.length <= retention) return entries;
  records.sort(([, left], [, right]) => Date.parse(right?.seenAt || 0) - Date.parse(left?.seenAt || 0));
  return Object.fromEntries(records.slice(0, retention));
}

function acceptedDelivery(result) {
  if (result === false) return false;
  const status = String(result?.status || "").toLowerCase();
  if (status === "suppressed") return isTerminalAlertSuppression(result);
  if (["failed", "error", "rejected", "dropped"].includes(status)) return false;
  return true;
}

function normalizeParsedEntries(rawEntries, sourceKey) {
  const unique = new Map();
  for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
    if (!raw || typeof raw !== "object") continue;
    const identity = raw.stableId || raw.id || raw.externalId || raw.url || `${raw.title}|${raw.publishedAt || ""}`;
    if (!identity) continue;
    const normalized = {
      ...raw,
      sourceKey,
      stableId: raw.stableId || raw.id || `${sourceKey}:${digest(identity)}`,
    };
    normalized.id = normalized.stableId;
    normalized.contentHash ||= digest({ title: normalized.title, summary: normalized.summary, url: normalized.url });
    unique.set(normalized.stableId, normalized);
  }
  return [...unique.values()];
}

export function createXaiOfficialMonitor(config = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const fsImpl = dependencies.fsImpl || fs;
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const autoStart = dependencies.autoStart !== false;
  const enabled = config.xaiOfficialMonitorEnabled !== false && config.xaiOfficialEnabled !== false;
  const sources = sourceDefinitions(config, dependencies).map((source) => ({
    ...source,
    intervalMs: Math.max(0, Number(source.intervalMs) || 0),
  }));
  const backoffBaseMs = Math.max(1, Number(config.xaiOfficialBackoffBaseMs) || DEFAULT_BACKOFF_BASE_MS);
  const backoffMaxMs = Math.max(backoffBaseMs, Number(config.xaiOfficialMaxBackoffMs ?? config.xaiOfficialBackoffMaxMs) || DEFAULT_BACKOFF_MAX_MS);
  const timeoutMs = Math.max(1, Number(config.xaiOfficialRequestTimeoutMs ?? config.xaiOfficialFetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS);
  const retention = Math.max(10, Number(config.xaiOfficialStateRetention) || DEFAULT_RETENTION);
  const stateFile = config.xaiOfficialStateFile || path.join(config.dataDir || ".data", "xai-official-state.json");
  let activeCheck = null;
  let rerunRequested = false;
  let startupRecoveryProbePending = true;
  let stopped = false;

  async function persist(state) {
    await atomicWriteXaiOfficialState(stateFile, state, fsImpl);
  }

  async function deliver(event) {
    const result = await alertSender(config, event);
    if (!acceptedDelivery(result)) {
      const error = new Error(`AI official alert was not durably queued${result?.reason ? `: ${result.reason}` : ""}`);
      error.code = "AI_OFFICIAL_ALERT_NOT_QUEUED";
      throw error;
    }
    return result;
  }

  async function fetchSource(source, health, observedAt) {
    const headers = {
      "user-agent": "Mozilla/5.0 (compatible; robinhood-launchpad-monitor/0.1)",
      accept: source.accept || "text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
    };
    if (health.etag) headers["if-none-match"] = health.etag;
    if (health.lastModified) headers["if-modified-since"] = health.lastModified;
    const request = { headers };
    if (typeof dependencies.createAbortSignal === "function") request.signal = dependencies.createAbortSignal(timeoutMs);
    else if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") request.signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(source.url, request);
    if (response?.status === 304) return { notModified: true, entries: [] };
    if (!response?.ok) throw new Error(`${source.name} returned HTTP ${response?.status ?? "unknown"}`);
    const body = await response.text();
    if (!normalizeSpace(body)) throw new Error(`${source.name} returned an empty response`);
    const rawEntries = await source.parser(body, { sourceUrl: source.url, observedAt });
    const entries = normalizeParsedEntries(rawEntries, source.key);
    if (!entries.length) throw new Error(`${source.name} schema produced no entries`);
    return {
      notModified: false,
      entries,
      etag: responseHeader(response, "etag"),
      lastModified: responseHeader(response, "last-modified"),
    };
  }

  function markHealthy(health, current, source, response = {}) {
    const stamp = iso(current);
    health.status = "healthy";
    health.checkedAt = stamp;
    health.lastSuccessAt = stamp;
    health.consecutiveFailures = 0;
    health.nextAttemptAt = iso(current + source.intervalMs);
    if (response.etag) health.etag = response.etag;
    if (response.lastModified) health.lastModified = response.lastModified;
    delete health.lastError;
    delete health.lastErrorAt;
  }

  function markFailed(health, current, error) {
    const failures = Number(health.consecutiveFailures || 0) + 1;
    const delay = Math.min(backoffMaxMs, backoffBaseMs * (2 ** Math.min(20, failures - 1)));
    health.status = "backoff";
    health.checkedAt = iso(current);
    health.lastErrorAt = iso(current);
    health.lastError = String(error?.message || error).slice(0, 1_000);
    health.consecutiveFailures = failures;
    health.nextAttemptAt = iso(current + delay);
  }

  async function runCheck(startupRecoveryProbe = false) {
    if (!enabled || stopped) return { status: enabled ? "stopped" : "disabled", checked: [], skipped: sources.map((source) => source.key), delivered: 0 };
    const state = await readState(stateFile, sources, fsImpl);
    const current = nowMs(now);
    const observedAt = iso(current);
    const result = { status: "healthy", checked: [], skipped: [], failed: [], delivered: 0 };
    for (const source of sources) {
      const sourceState = state.sources[source.key];
      const health = state.health.sources[source.key];
      const nextAttempt = Date.parse(health.nextAttemptAt || 0);
      const legacyDeliveryBackoff = /^AI official alert was not durably queued\b/i.test(String(health.lastError || ""));
      const eligibilityCheckedAt = nowMs(now);
      if (Number.isFinite(nextAttempt) && nextAttempt > eligibilityCheckedAt && !(startupRecoveryProbe && legacyDeliveryBackoff)) {
        result.skipped.push(source.key);
        continue;
      }
      const requestStartedAt = nowMs(now);
      const sourceObservedAt = iso(requestStartedAt);
      result.checked.push(source.key);
      try {
        const response = await fetchSource(source, health, sourceObservedAt);
        if (response.notModified) {
          if (!sourceState.initialized) throw new Error(`${source.name} returned 304 before its baseline existed`);
          markHealthy(health, requestStartedAt, source, response);
          await persist(state);
          continue;
        }
        if (!sourceState.initialized) {
          for (const item of response.entries) {
            sourceState.entries[item.stableId] = aiStateEntry(item, classifyAiOfficialUpdate(item), sourceObservedAt);
          }
          sourceState.initialized = true;
          sourceState.entries = pruneEntries(sourceState.entries, retention);
          markHealthy(health, requestStartedAt, source, response);
          await persist(state);
          continue;
        }
        for (const item of response.entries) {
          const previous = sourceState.entries[item.stableId];
          const signal = classifyAiOfficialUpdate(item);
          if (previous?.contentHash === item.contentHash) {
            // Backfill display fields for pre-snapshot state without emitting a false update.
            if (!previous.displaySnapshot || !previous.title || !previous.summary || !previous.stage || !Array.isArray(previous.identifiers)) {
              sourceState.entries[item.stableId] = {
                ...aiStateEntry(item, signal, sourceObservedAt),
                seenAt: previous.seenAt || sourceObservedAt,
              };
            }
            continue;
          }
          const previousSnapshot = previous ? aiSnapshotFromRecord(previous) : null;
          const currentSnapshot = aiDisplaySnapshot(item, signal);
          if (signal.relevant) {
            await deliver({
              type: "ai_official_update",
              kind: source.key,
              eventKey: `ai-official:${source.key}:${item.stableId}:${item.contentHash}`,
              project: source.project,
              product: source.key === "x_api_changelog"
                ? { id: "x-api", name: "X API" }
                : { id: "grok", name: "xAI / Grok" },
              signal,
              source: { id: source.key, name: source.name, url: source.url, official: true, trust: "official_verified" },
              title: item.title,
              summary: item.summary,
              url: item.url || source.url,
              publishedAt: item.publishedAt || null,
              observedAt: sourceObservedAt,
              changeType: previous ? "revised" : "published",
              comparisonBasis: previous ? "exact_snapshot" : "monitoring_baseline",
              ...(!previous ? { baselineStatus: "not_recorded" } : { previousSnapshot }),
              currentSnapshot,
              changedFields: changedSnapshotFields(previousSnapshot, currentSnapshot),
              strong: signal.strong,
              stage: signal.stage,
              category: signal.category,
              labels: signal.labels,
              identifiers: signal.identifiers,
              entryId: item.stableId,
              stableEntryId: item.stableId,
            });
            result.delivered += 1;
          }
          sourceState.entries[item.stableId] = aiStateEntry(item, signal, sourceObservedAt);
          sourceState.entries = pruneEntries(sourceState.entries, retention);
          await persist(state);
        }
        markHealthy(health, requestStartedAt, source, response);
        await persist(state);
      } catch (error) {
        markFailed(health, nowMs(now), error);
        result.failed.push({ source: source.key, error: error.message });
        result.status = "degraded";
        logger.error?.(`[xai-official][${source.key}] ${error.message}`);
        await persist(state);
      }
    }
    const statuses = Object.values(state.health.sources).map((health) => health.status);
    state.health.status = statuses.every((status) => status === "healthy") ? "healthy" : statuses.some((status) => status === "healthy") ? "degraded" : "error";
    state.health.checkedAt = observedAt;
    result.status = state.health.status;
    await persist(state);
    return result;
  }

  const check = () => {
    if (activeCheck) {
      rerunRequested = true;
      return activeCheck;
    }
    activeCheck = (async () => {
      let result;
      // Coalesce overlap into at most one immediate catch-up. Without this
      // bound, a timer shorter than a degraded request can keep the monitor in
      // a permanent zero-delay loop.
      for (let cycle = 0; cycle < 2 && !stopped; cycle += 1) {
        rerunRequested = false;
        const startupRecoveryProbe = startupRecoveryProbePending;
        startupRecoveryProbePending = false;
        result = await runCheck(startupRecoveryProbe);
        if (!rerunRequested) break;
      }
      rerunRequested = false;
      return result;
    })().finally(() => { activeCheck = null; });
    return activeCheck;
  };

  const schedulerInterval = Math.max(1_000, Math.min(...sources.map((source) => source.intervalMs || 1_000)));
  if (autoStart && enabled) void check();
  const timer = autoStart && enabled ? setInterval(check, schedulerInterval) : null;
  timer?.unref();

  return {
    check,
    stateFile,
    sources: sources.map(({ parser, ...source }) => source),
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (activeCheck) await activeCheck;
    },
  };
}
