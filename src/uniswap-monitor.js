import fs from "node:fs/promises";
import path from "node:path";
import { sendAlerts } from "./alerts.js";
import { extractChainSupportSignals } from "./chain-support.js";

export const UNISWAP_BLOG_SITEMAP_URL = "https://blog.uniswap.org/sitemap.xml";
export const UNISWAP_GOVERNANCE_POSTS_URL = "https://gov.uniswap.org/posts.json";
export const UNISWAP_GITHUB_RELEASE_FEEDS = [
  {
    repository: "Uniswap/liquidity-launcher",
    url: "https://github.com/Uniswap/liquidity-launcher/releases.atom",
  },
];

const DEFAULT_BLOG_INTERVAL_MS = 15_000;
const DEFAULT_GOVERNANCE_INTERVAL_MS = 30_000;
const DEFAULT_GITHUB_INTERVAL_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_SUMMARY_LENGTH = 280;
const MAX_BLOG_ENTRIES = 5_000;
const MAX_RELEASE_ENTRIES = 500;

const SIGNALS = [
  ["robinhood", /\brobinhood(?:\s+chain)?\b/i],
  ["launch", /\b(?:token\s+)?launch(?:es|ed|ing|er|ers|pad|pads)?\b|\blaunch\s+aggregator\b/i],
  ["pool", /\bpools?\b|\bliquidity\b/i],
  ["hook", /\bhooks?\b/i],
  ["protocol", /\bprotocol\b|\buniswap\s+v[234]\b|\bv[234]\b/i],
  ["fee", /\b(?:protocol\s+)?fees?\b|\bfee\s+switch\b/i],
  ["governance", /\bgovernance\b|\bproposal\b|\bvote\b|\bsnapshot\b|\btemperature\s+check\b/i],
  ["deployment", /\bdeploy(?:ment|ments|ed|ing)?\b|\bchain\s+(?:support|expansion|launch)\b/i],
  ["router", /\b(?:universal\s+)?router\b/i],
  ["uniswapx", /\buniswap[\s-]?x\b/i],
];

const GOVERNANCE_STAGE = /(?:\[(?:rfc|temp(?:erature)?\s*check|snapshot|on[ -]?chain)\]|\b(?:rfc|temperature\s+check|snapshot\s+(?:vote|proposal)|on[ -]?chain\s+(?:vote|proposal)|governance\s+proposal|proposal\s+#?\d+|vote\s+(?:is\s+)?live|executive\s+vote|timelock|quorum)\b)/i;
const GOVERNANCE_CORE = /\b(?:protocol\s+fees?|fee\s+switch|protocol\s+upgrade|new\s+(?:mechanism|version)|uniswap[\s-]?x|uniswap\s+v[234]|universal\s+router|liquidity\s+launcher|launchpad|token\s+launch|chain\s+deployment|deploy(?:ment|ing|ed)?\s+(?:uniswap|v[234]|protocol)|hooks?)\b/i;
const GOVERNANCE_ACTION = /\b(?:vote|voting|snapshot(?:\s+vote)?)\s+(?:is\s+)?(?:now\s+)?live\b|\bmov(?:e|ed|ing)\s+to\s+(?:snapshot|on[ -]?chain)\b|\badvanc(?:e|ed|ing)\s+to\s+(?:snapshot|on[ -]?chain|execution)\b|\bon[ -]?chain\s+proposal\b.{0,60}\b(?:submitted|live|created)\b|\bproposal\b.{0,60}\b(?:passed|approved|executed)\b|\bexecution\s+(?:is\s+)?complete\b|\b(?:deployment|protocol|feature)\s+(?:is\s+)?(?:now\s+)?live\b|\bhas\s+been\s+deployed\b/i;
const GOVERNANCE_NOISE = /\b(?:grants?|grant\s+application|applications?|apply|cohort|office\s+hours|community\s+call|weekly\s+(?:update|recap)|meetup|hackathon|job\s+(?:opening|posting)|delegate\s+platform|introducing\s+myself|feedback\s+request)\b/i;
const OFFICIAL_GOVERNANCE_USERS = new Set([
  "uniswap",
  "uniswaplabs",
  "uniswap_labs",
  "uniswapfoundation",
  "uniswap_foundation",
  "uniswapfoundationgov",
  "uf-governance",
  "govops",
]);

const nowMilliseconds = (now) => {
  const value = typeof now === "function" ? now() : now;
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Uniswap monitor now() returned an invalid timestamp");
  return milliseconds;
};

const iso = (milliseconds) => new Date(milliseconds).toISOString();

const decodeEntities = (value) => String(value || "")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, "\"")
  .replace(/&apos;|&#39;|&#x27;/gi, "'")
  .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)));

const visibleText = (value) => decodeEntities(value)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const truncate = (value, limit = MAX_SUMMARY_LENGTH) => {
  const text = visibleText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};

const canonicalUrl = (value) => {
  const url = new URL(String(value).trim());
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
};

const xmlBlocks = (xml, name) => [...String(xml).matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "gi"))]
  .map((match) => match[1]);

const xmlValue = (block, name) => {
  const match = String(block).match(new RegExp(`<${name}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, "i"));
  return match ? decodeEntities(match[1]).trim() : null;
};

const xmlAttribute = (block, element, attribute) => {
  for (const match of String(block).matchAll(new RegExp(`<${element}\\b([^>]*)\\/?\\s*>`, "gi"))) {
    const value = match[1].match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"))?.[1];
    if (value) return decodeEntities(value).trim();
  }
  return null;
};

const validDate = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

const precisePublishedDate = (value) => /T\d{2}:\d{2}/.test(String(value || "")) ? validDate(value) : null;

const slugTitle = (url) => {
  const pathname = new URL(url).pathname.replace(/^\/(?:en-US|es-ES|pt-BR)\//i, "/");
  const slug = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) || "Uniswap official update");
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\buniswapx\b/gi, "UniswapX")
    .replace(/\buniswap\b/gi, "Uniswap")
    .replace(/\brobinhood\b/gi, "Robinhood")
    .replace(/^./, (letter) => letter.toUpperCase())
    .trim();
};

export function signalLabels(value) {
  const text = visibleText(value);
  return SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export function parseUniswapBlogSitemap(xml) {
  if (!/<urlset\b/i.test(String(xml))) throw new Error("Uniswap blog sitemap schema missing urlset");
  const records = [];
  for (const block of xmlBlocks(xml, "url")) {
    const rawUrl = xmlValue(block, "loc");
    if (!rawUrl) continue;
    let url;
    try { url = canonicalUrl(rawUrl); }
    catch { continue; }
    const parsed = new URL(url);
    if (parsed.hostname !== "blog.uniswap.org" || parsed.pathname === "/" || /^\/(?:es-ES|pt-BR)(?:\/|$)/i.test(parsed.pathname)) continue;
    const lastmod = xmlValue(block, "lastmod");
    records.push({
      url,
      lastmod: lastmod && Number.isFinite(Date.parse(lastmod)) ? lastmod : null,
      title: slugTitle(url),
    });
  }
  return [...new Map(records.map((record) => [record.url, record])).values()]
    .sort((left, right) => `${left.lastmod || ""}:${left.url}`.localeCompare(`${right.lastmod || ""}:${right.url}`));
}

const metaContent = (html, key) => {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = match[1];
    const field = attributes.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1];
    if (!field || !new RegExp(`^${escaped}$`, "i").test(field)) continue;
    const content = attributes.match(/\bcontent=["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content).trim();
  }
  return null;
};

const articleJsonLdFields = (html) => {
  const fields = { headlines: [], descriptions: [], articleBodies: [] };
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = [value["@type"]].flat().map((item) => String(item || "").toLowerCase());
    if (types.some((type) => ["article", "blogposting", "newsarticle"].includes(type))) {
      if (typeof value.headline === "string") fields.headlines.push(value.headline);
      if (typeof value.description === "string") fields.descriptions.push(value.description);
      if (typeof value.articleBody === "string") fields.articleBodies.push(value.articleBody);
    }
    if (value["@graph"]) visit(value["@graph"]);
  };
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(decodeEntities(match[1]).trim())); } catch {}
  }
  return fields;
};

const readableFact = (value, title) => {
  const text = truncate(value);
  if (!text || text.length < 16 || text.toLowerCase() === visibleText(title).toLowerCase()) return null;
  if (/^(?:by\s+\S|written by\b|published\b|updated\b|\d+\s+min(?:ute)?\s+read\b|share\b|subscribe\b)/i.test(text)) return null;
  return text;
};

const firstReadableParagraph = (html, title) => {
  const articleHtml = String(html).match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || String(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || "";
  for (const match of articleHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const fact = readableFact(match[1], title);
    if (fact) return fact;
  }
  return null;
};

const explicitDeploymentConfirmation = (value) => {
  // "vote is live" describes a governance phase, not a deployed product.
  const text = visibleText(value).replace(/\b(?:governance\s+)?(?:vote|voting|proposal|snapshot|poll)\s+(?:is|are)\s+(?:now\s+)?live\b/gi, " ");
  return /\bdeployment\s+(?:is\s+)?complete\b|\b(?:uniswap(?:[\s-]?x|\s+v[234])?|liquidity[ -]?launcher|launchpad|launcher|protocol|feature|product|app|interface|router|hook|pool|service)\b[^.!?]{0,60}\b(?:(?:is|are)\s+(?:now\s+)?live|(?:is|are)\s+now\s+available|has\s+been\s+deployed)\b/i.test(text);
};

const blogPublicationStage = (entry) => {
  const text = `${entry.title || ""} ${entry.description || ""} ${entry.factSummary || ""} ${entry.content || ""}`;
  if (explicitDeploymentConfirmation(text)) {
    return { stage: "live", stageLabel: "官方原文明确已上线", deploymentConfirmed: true };
  }
  if (/\b(?:beta|testnet|preview|pilot)\b/i.test(text)) {
    return { stage: "preview", stageLabel: "测试/预览阶段", deploymentConfirmed: false };
  }
  return { stage: "official_publication", stageLabel: "官方发布（未确认上线）", deploymentConfirmed: false };
};

const governanceStage = (post) => {
  const text = visibleText(`${post.title || ""} ${post.body || ""}`);
  const deploymentConfirmed = explicitDeploymentConfirmation(text);
  if (deploymentConfirmed) return { stage: "live", stageLabel: "原文明示已上线/部署", deploymentConfirmed };
  if (/\b(?:executed|execution\s+(?:is\s+)?complete)\b/i.test(text)) return { stage: "executed", stageLabel: "治理已执行（不等于产品已上线）", deploymentConfirmed };
  if (/\b(?:passed|approved)\b/i.test(text)) return { stage: "passed", stageLabel: "治理已通过，待执行确认", deploymentConfirmed };
  if (/\btimelock\b/i.test(text)) return { stage: "timelock", stageLabel: "治理时间锁阶段", deploymentConfirmed };
  if (/\bon[ -]?chain\b/i.test(text)) return { stage: "onchain_vote", stageLabel: "链上投票/提案阶段", deploymentConfirmed };
  if (/\bsnapshot\b/i.test(text)) return { stage: "snapshot", stageLabel: "Snapshot 投票阶段", deploymentConfirmed };
  if (/\btemperature\s+check\b|\btemp\s*check\b/i.test(text)) return { stage: "temperature_check", stageLabel: "温度检查阶段", deploymentConfirmed };
  if (/\brfc\b/i.test(text)) return { stage: "rfc", stageLabel: "RFC 征求意见阶段", deploymentConfirmed };
  return { stage: "proposal", stageLabel: "治理提案/讨论阶段", deploymentConfirmed };
};

export function parseUniswapBlogPage(html, fallback = {}) {
  const title = metaContent(html, "og:title")
    || metaContent(html, "twitter:title")
    || visibleText(String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "")
    || visibleText(String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    || fallback.title
    || null;
  const description = metaContent(html, "description") || metaContent(html, "og:description") || null;
  const jsonLd = articleJsonLdFields(html);
  const article = visibleText(
    String(html).match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
      || String(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
      || "",
  );
  const factSummary = firstReadableParagraph(html, title)
    || jsonLd.descriptions.map((value) => readableFact(value, title)).find(Boolean)
    || jsonLd.articleBodies.map((value) => readableFact(value, title)).find(Boolean)
    || null;
  const content = [title, description, ...jsonLd.headlines, ...jsonLd.descriptions, ...jsonLd.articleBodies, article]
    .filter(Boolean)
    .join(" ")
    .slice(0, 30_000);
  return { ...fallback, title, description, factSummary, content };
}

export function classifyUniswapBlogEntry(entry) {
  const text = visibleText(`${entry.title || ""} ${entry.description || ""} ${entry.content || ""} ${entry.url || ""}`);
  const labels = signalLabels(text);
  const chainSupport = extractChainSupportSignals(text);
  if (chainSupport.length) labels.push("chain_support");
  const highSignal = chainSupport.length > 0 || /\b(?:liquidity[ -]?launcher|launchpad|launch\s+aggregator|(?:crowd|instant)\s+launch|token\s+auction|bonding\s+curve|dualpool|new\s+launch\s+(?:mode|strategy|mechanism)|(?:new\s+)?(?:pool|hook)\s+(?:mode|design|type|mechanism|strategy|template|module))\b|\brobinhood(?:\s+chain)?\b[^\n]{0,80}\b(?:pool|hook|launch|deploy(?:ment|ed|ing)?)\b|\b(?:pool|hook|launch|deploy(?:ment|ed|ing)?)\b[^\n]{0,80}\brobinhood(?:\s+chain)?\b/i.test(text);
  const summary = truncate(entry.description || entry.factSummary || entry.title || "");
  return {
    relevant: highSignal,
    labels: highSignal ? [...new Set(labels)] : [],
    strong: highSignal,
    summary: highSignal ? summary : null,
    ...(chainSupport.length ? { chainSupport } : {}),
  };
}

export function parseUniswapGovernancePosts(payload) {
  const posts = Array.isArray(payload?.latest_posts) ? payload.latest_posts : null;
  if (!posts) throw new Error("Uniswap governance response missing latest_posts");
  return posts.flatMap((post) => {
    const id = Number(post?.id);
    const topicId = Number(post?.topic_id);
    const postNumber = Number(post?.post_number);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(topicId) || !Number.isSafeInteger(postNumber)) return [];
    const slug = String(post.topic_slug || post.topic_url_slug || "topic").replace(/[^a-zA-Z0-9_-]+/g, "-");
    return [{
      id,
      topicId,
      postNumber,
      author: String(post.username || post.display_username || post.name || "unknown"),
      title: truncate(post.topic_title || post.topic_html_title || slug, 180),
      slug,
      body: truncate(post.cooked || post.raw || post.excerpt || "", 2_000),
      publishedAt: validDate(post.created_at || post.updated_at),
      url: `https://gov.uniswap.org/t/${slug}/${topicId}/${postNumber}`,
    }];
  }).sort((left, right) => left.id - right.id);
}

export function classifyUniswapGovernancePost(post) {
  const author = String(post.author || "").toLowerCase();
  const officialAuthor = OFFICIAL_GOVERNANCE_USERS.has(author);
  const title = visibleText(post.title || "");
  const body = visibleText(post.body || "");
  const combined = `${title} ${body}`;
  if (GOVERNANCE_NOISE.test(combined)) {
    return { relevant: false, labels: [], strong: false, officialAuthor, reason: "community_or_grant_noise" };
  }
  const signalText = Number(post.postNumber || 1) === 1 ? combined : body;
  const formalStage = GOVERNANCE_STAGE.test(signalText);
  const coreChange = GOVERNANCE_CORE.test(signalText);
  const action = GOVERNANCE_ACTION.test(body);
  const labels = signalLabels(signalText);
  const chainSupport = extractChainSupportSignals(signalText);
  if (chainSupport.length) labels.push("chain_support");
  if (formalStage && !labels.includes("governance")) labels.push("governance");
  const originalPost = Number(post.postNumber || 1) === 1;
  const stage = governanceStage(post);
  // Topic titles repeat on every Discourse reply. Alert the first proposal or
  // protocol-change post, then only an explicit phase/deployment transition;
  // this prevents a busy fee discussion from producing dozens of alerts.
  const relevant = originalPost
    ? ((formalStage && coreChange) || (officialAuthor && (coreChange || labels.length > 0)))
    : action && coreChange && (formalStage || officialAuthor);
  return {
    relevant,
    labels: relevant ? [...new Set(labels)] : [],
    strong: relevant,
    officialAuthor,
    ...stage,
    ...(chainSupport.length ? { chainSupport } : {}),
    reason: relevant ? (action && !originalPost ? "governance_transition" : formalStage ? "formal_governance_stage" : coreChange ? "protocol_change" : "official_core_update") : "chatter",
  };
}

export function parseGithubReleaseFeed(xml, repository) {
  if (!/<feed\b/i.test(String(xml))) throw new Error(`${repository} release feed schema missing feed`);
  return xmlBlocks(xml, "entry").flatMap((block) => {
    const id = xmlValue(block, "id");
    const title = truncate(xmlValue(block, "title") || "", 160);
    const url = xmlAttribute(block, "link", "href");
    if (!id || !title || !url) return [];
    const tag = (() => {
      try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) || title); }
      catch { return title; }
    })();
    return [{
      id,
      repository,
      tag,
      title,
      url,
      publishedAt: validDate(xmlValue(block, "published") || xmlValue(block, "updated")),
      summary: truncate(xmlValue(block, "content") || xmlValue(block, "summary") || title),
      author: truncate(xmlValue(block, "name") || "", 80) || null,
    }];
  }).sort((left, right) => `${left.publishedAt || ""}:${left.id}`.localeCompare(`${right.publishedAt || ""}:${right.id}`));
}

export async function atomicWriteUniswapState(file, value, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fsImpl.rename(temporary, file);
  } catch (error) {
    try { await fsImpl.unlink?.(temporary); } catch {}
    throw error;
  }
}

const emptyHealth = () => ({
  status: "idle",
  consecutiveFailures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  nextAttemptAt: null,
});

const emptyState = () => ({
  version: 1,
  blog: { initializedAt: null, entries: {} },
  governance: { initializedAt: null, lastPostId: null },
  githubReleases: { feeds: {} },
  _health: { blog: emptyHealth(), governance: emptyHealth(), githubReleases: {} },
});

const normalizeFeed = (feed) => typeof feed === "string"
  ? { repository: new URL(feed).pathname.split("/").filter(Boolean).slice(0, 2).join("/"), url: feed }
  : { repository: feed.repository, url: feed.url };

const responseText = async (url, fetchImpl, accept, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const response = await fetchImpl(url, {
    headers: { accept, "user-agent": "robinhood-chain-monitor/uniswap" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) throw new Error(`${response?.url || url} HTTP ${response?.status ?? "unknown"}`);
  return response.text();
};

const responseJson = async (url, fetchImpl, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "robinhood-chain-monitor/uniswap" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) throw new Error(`${response?.url || url} HTTP ${response?.status ?? "unknown"}`);
  if (typeof response.json === "function") return response.json();
  return JSON.parse(await response.text());
};

const due = (health, current) => !health?.nextAttemptAt || (Date.parse(health.nextAttemptAt) || 0) <= current;
const isTransportFailure = (error) => /fetch failed|network|timed?\s*out|timeout|aborted|eaddrnotavail|econn(?:reset|refused|aborted)|socket/i
  .test(String(error?.message || error || ""));

const markAttempt = (health, nowValue) => {
  health.status = "checking";
  health.lastAttemptAt = nowValue;
};

const markHealthy = (health, nowValue, intervalMs) => {
  const recovered = Number(health.consecutiveFailures || 0) > 0;
  health.status = "healthy";
  health.consecutiveFailures = 0;
  health.lastSuccessAt = nowValue;
  health.lastError = null;
  health.nextAttemptAt = new Date(Date.parse(nowValue) + intervalMs).toISOString();
  if (recovered) health.lastRecoveredAt = nowValue;
};

const markFailed = (health, error, nowValue, intervalMs, maximumBackoffMs) => {
  health.consecutiveFailures = Number(health.consecutiveFailures || 0) + 1;
  // A local/network transport outage should recover quickly once connectivity
  // returns. HTTP policy failures keep the longer configured backoff.
  const failureMaximumMs = isTransportFailure(error) ? Math.min(maximumBackoffMs, 60_000) : maximumBackoffMs;
  const backoffMs = Math.min(failureMaximumMs, intervalMs * (2 ** Math.max(0, health.consecutiveFailures - 1)));
  health.status = "backoff";
  health.lastErrorAt = nowValue;
  health.lastError = String(error?.message || error).slice(0, 1_000);
  health.nextAttemptAt = new Date(Date.parse(nowValue) + backoffMs).toISOString();
};

const pruneObject = (object, maximum, timestampKey = "lastmod") => {
  const entries = Object.entries(object);
  if (entries.length <= maximum) return object;
  entries.sort(([, left], [, right]) => String(right?.[timestampKey] || "").localeCompare(String(left?.[timestampKey] || "")));
  return Object.fromEntries(entries.slice(0, maximum));
};

export function createUniswapMonitor(config = {}, dependencies = {}) {
  if (!config.dataDir && !dependencies.stateFile) throw new Error("Uniswap monitor requires config.dataDir or dependencies.stateFile");
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const now = dependencies.now || Date.now;
  const logger = dependencies.logger || console;
  const fsImpl = dependencies.fsImpl || fs;
  const autoStart = dependencies.autoStart !== false;
  const blogUrl = dependencies.blogUrl || UNISWAP_BLOG_SITEMAP_URL;
  const governanceUrl = dependencies.governanceUrl || UNISWAP_GOVERNANCE_POSTS_URL;
  const releaseFeeds = (dependencies.githubReleaseFeeds || UNISWAP_GITHUB_RELEASE_FEEDS).map(normalizeFeed);
  const stateFile = dependencies.stateFile || path.join(config.dataDir, "uniswap-state.json");
  const blogIntervalMs = Math.max(1_000, Number(config.uniswapBlogPollIntervalMs) || DEFAULT_BLOG_INTERVAL_MS);
  const governanceIntervalMs = Math.max(1_000, Number(config.uniswapGovernancePollIntervalMs) || DEFAULT_GOVERNANCE_INTERVAL_MS);
  const githubIntervalMs = Math.max(1_000, Number(config.uniswapGithubPollIntervalMs) || DEFAULT_GITHUB_INTERVAL_MS);
  const maximumBackoffMs = Math.max(1_000, Number(config.uniswapMaxBackoffMs) || DEFAULT_MAX_BACKOFF_MS);
  const requestTimeoutMs = Math.max(1_000, Number(config.uniswapRequestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  let state = emptyState();
  let initialized = false;
  let running = false;
  let activeCheckPromise = null;
  let scheduledDrainPromise = null;
  let scheduledRerunRequested = false;
  let startupRecoveryProbePending = true;
  let stopped = false;
  let stopPromise = null;
  let timer = null;
  let writeQueue = Promise.resolve();

  const save = () => {
    writeQueue = writeQueue.catch(() => {}).then(() => atomicWriteUniswapState(stateFile, state, fsImpl));
    return writeQueue;
  };

  const initialize = async () => {
    if (initialized) return;
    try {
      const loaded = JSON.parse(await fsImpl.readFile(stateFile, "utf8"));
      state = {
        ...emptyState(),
        ...loaded,
        blog: { ...emptyState().blog, ...(loaded.blog || {}), entries: { ...(loaded.blog?.entries || {}) } },
        governance: { ...emptyState().governance, ...(loaded.governance || {}) },
        githubReleases: { feeds: { ...(loaded.githubReleases?.feeds || {}) } },
        _health: {
          ...emptyState()._health,
          ...(loaded._health || {}),
          blog: { ...emptyHealth(), ...(loaded._health?.blog || {}) },
          governance: { ...emptyHealth(), ...(loaded._health?.governance || {}) },
          githubReleases: { ...(loaded._health?.githubReleases || {}) },
        },
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const feed of releaseFeeds) {
      state.githubReleases.feeds[feed.url] ||= { repository: feed.repository, initializedAt: null, knownIds: {} };
      state._health.githubReleases[feed.url] = { ...emptyHealth(), ...(state._health.githubReleases[feed.url] || {}) };
    }
    initialized = true;
  };

  const checkBlog = async (current, nowValue, startupRecoveryProbe = false) => {
    const health = state._health.blog;
    if (!due(health, current) && !(startupRecoveryProbe && isTransportFailure(health.lastError))) return { skipped: true, reason: "backoff" };
    markAttempt(health, nowValue);
    try {
      const entries = parseUniswapBlogSitemap(await responseText(blogUrl, fetchImpl, "application/xml,text/xml", requestTimeoutMs));
      if (!state.blog.initializedAt) {
        state.blog.entries = Object.fromEntries(entries.map((entry) => [entry.url, { lastmod: entry.lastmod, title: entry.title }]));
        state.blog.initializedAt = nowValue;
      } else {
        for (const entry of entries) {
          const previous = state.blog.entries[entry.url];
          const changed = !previous || String(previous.lastmod || "") !== String(entry.lastmod || "");
          if (!changed) continue;
          let classifiedEntry = entry;
          // A sitemap slug can identify relevance but cannot explain what
          // changed. Fetch every genuinely new canonical URL exactly once so
          // the event carries the official description/body fact. Historical
          // entries and lastmod-only edits still never trigger a detail fetch.
          if (!previous) {
            const html = await responseText(entry.url, fetchImpl, "text/html,application/xhtml+xml", requestTimeoutMs);
            classifiedEntry = parseUniswapBlogPage(html, entry);
          }
          const signal = classifyUniswapBlogEntry(classifiedEntry);
          // Sitemap lastmod can change for metadata or formatting edits. Only a
          // genuinely new canonical URL is safe enough for a realtime alert.
          if (!previous && signal.relevant) {
            const changeType = "published";
            const publicationStage = blogPublicationStage(classifiedEntry);
            await alertSender(config, {
              type: "uniswap_official_update",
              kind: "blog",
              eventKey: `uniswap-blog:${changeType}:${entry.url}:${entry.lastmod || "no-lastmod"}`,
              title: classifiedEntry.title || entry.title,
              url: entry.url,
              publishedAt: precisePublishedDate(entry.lastmod),
              lastmod: entry.lastmod,
              summary: signal.summary,
              description: classifiedEntry.description || null,
              factSummary: classifiedEntry.factSummary || null,
              labels: signal.labels,
              ...(signal.chainSupport?.length ? { chainSupport: signal.chainSupport } : {}),
              strong: signal.strong,
              ...publicationStage,
              changeType,
              source: { id: "uniswap_blog", name: "Uniswap 官方博客", url: entry.url },
              observedAt: nowValue,
            });
          }
          state.blog.entries[entry.url] = { lastmod: entry.lastmod, title: classifiedEntry.title || entry.title, relevant: signal.relevant };
          await save();
        }
        state.blog.entries = pruneObject(state.blog.entries, MAX_BLOG_ENTRIES);
      }
      markHealthy(health, nowValue, blogIntervalMs);
      await save();
      return { ok: true, count: entries.length };
    } catch (error) {
      markFailed(health, error, nowValue, blogIntervalMs, maximumBackoffMs);
      await save();
      logger.error?.(`[uniswap][blog] ${error.message}`);
      return { ok: false, error: error.message };
    }
  };

  const checkGovernance = async (current, nowValue, startupRecoveryProbe = false) => {
    const health = state._health.governance;
    if (!due(health, current) && !(startupRecoveryProbe && isTransportFailure(health.lastError))) return { skipped: true, reason: "backoff" };
    markAttempt(health, nowValue);
    try {
      const posts = parseUniswapGovernancePosts(await responseJson(governanceUrl, fetchImpl, requestTimeoutMs));
      const maximumId = posts.reduce((maximum, post) => Math.max(maximum, post.id), Number(state.governance.lastPostId || 0));
      if (!state.governance.initializedAt) {
        state.governance.lastPostId = maximumId || null;
        state.governance.initializedAt = nowValue;
      } else {
        for (const post of posts.filter((item) => item.id > Number(state.governance.lastPostId || 0))) {
          const signal = classifyUniswapGovernancePost(post);
          if (signal.relevant) {
            await alertSender(config, {
              type: "uniswap_official_update",
              kind: "governance",
              eventKey: `uniswap-governance-post:${post.id}`,
              topicId: post.topicId,
              postId: post.id,
              postNumber: post.postNumber,
              author: post.author,
              title: post.title,
              url: post.url,
              publishedAt: post.publishedAt,
              summary: truncate(post.body),
              description: truncate(post.body),
              labels: signal.labels,
              ...(signal.chainSupport?.length ? { chainSupport: signal.chainSupport } : {}),
              strong: signal.strong,
              stage: signal.stage,
              stageLabel: signal.stageLabel,
              deploymentConfirmed: signal.deploymentConfirmed,
              changeType: "published",
              source: { id: "uniswap_governance", name: "Uniswap 官方治理论坛", url: post.url },
              observedAt: nowValue,
            });
          }
          state.governance.lastPostId = post.id;
          await save();
        }
      }
      markHealthy(health, nowValue, governanceIntervalMs);
      await save();
      return { ok: true, count: posts.length };
    } catch (error) {
      markFailed(health, error, nowValue, governanceIntervalMs, maximumBackoffMs);
      await save();
      logger.error?.(`[uniswap][governance] ${error.message}`);
      return { ok: false, error: error.message };
    }
  };

  const checkReleaseFeed = async (feed, current, nowValue, startupRecoveryProbe = false) => {
    const health = state._health.githubReleases[feed.url];
    if (!due(health, current) && !(startupRecoveryProbe && isTransportFailure(health.lastError))) return { skipped: true, reason: "backoff" };
    markAttempt(health, nowValue);
    const feedState = state.githubReleases.feeds[feed.url];
    try {
      const releases = parseGithubReleaseFeed(await responseText(feed.url, fetchImpl, "application/atom+xml,application/xml,text/xml", requestTimeoutMs), feed.repository);
      if (!feedState.initializedAt) {
        feedState.knownIds = Object.fromEntries(releases.map((release) => [release.id, { tag: release.tag, publishedAt: release.publishedAt }]));
        feedState.initializedAt = nowValue;
      } else {
        for (const release of releases.filter((item) => !feedState.knownIds[item.id])) {
          const chainSupport = extractChainSupportSignals(`${release.title} ${release.summary}`);
          await alertSender(config, {
            type: "uniswap_official_update",
            kind: "github_release",
            eventKey: `uniswap-github-release:${feed.repository}:${release.id}`,
            repository: feed.repository,
            releaseId: release.id,
            tag: release.tag,
            title: `${feed.repository} ${release.title}`,
            url: release.url,
            publishedAt: release.publishedAt,
            summary: release.summary,
            description: release.summary,
            labels: [...new Set(["github_release", ...signalLabels(`${release.title} ${release.summary}`)])],
            ...(chainSupport.length ? { chainSupport } : {}),
            strong: true,
            stage: "github_release",
            stageLabel: "GitHub 代码版本发布（未确认产品上线）",
            deploymentConfirmed: false,
            changeType: "published",
            source: { id: "uniswap_github_release", name: `Uniswap GitHub Release · ${feed.repository}`, url: release.url },
            observedAt: nowValue,
          });
          feedState.knownIds[release.id] = { tag: release.tag, publishedAt: release.publishedAt };
          await save();
        }
        feedState.knownIds = pruneObject(feedState.knownIds, MAX_RELEASE_ENTRIES, "publishedAt");
      }
      markHealthy(health, nowValue, githubIntervalMs);
      await save();
      return { ok: true, count: releases.length };
    } catch (error) {
      markFailed(health, error, nowValue, githubIntervalMs, maximumBackoffMs);
      await save();
      logger.error?.(`[uniswap][github-release][${feed.repository}] ${error.message}`);
      return { ok: false, error: error.message };
    }
  };

  const runCheckCycle = async () => {
    running = true;
    try {
      await initialize();
      const current = nowMilliseconds(now);
      const nowValue = iso(current);
      const startupRecoveryProbe = startupRecoveryProbePending;
      startupRecoveryProbePending = false;
      const [blog, governance, githubReleases] = await Promise.all([
        checkBlog(current, nowValue, startupRecoveryProbe),
        checkGovernance(current, nowValue, startupRecoveryProbe),
        Promise.all(releaseFeeds.map((feed) => checkReleaseFeed(feed, current, nowValue, startupRecoveryProbe))),
      ]);
      return { blog, governance, githubReleases };
    } finally {
      running = false;
    }
  };

  const check = () => {
    if (stopped) return activeCheckPromise || Promise.resolve({ skipped: true, reason: "stopped" });
    if (activeCheckPromise) return Promise.resolve({ skipped: true, reason: "running" });
    activeCheckPromise = runCheckCycle().finally(() => {
      activeCheckPromise = null;
      if (!stopped && scheduledRerunRequested && !scheduledDrainPromise) void requestScheduledCheck();
    });
    return activeCheckPromise;
  };

  function requestScheduledCheck() {
    if (stopped) return scheduledDrainPromise || activeCheckPromise || Promise.resolve();
    if (running || scheduledDrainPromise) {
      scheduledRerunRequested = true;
      return scheduledDrainPromise || activeCheckPromise;
    }
    scheduledDrainPromise = (async () => {
      for (let cycle = 0; cycle < 2 && !stopped; cycle += 1) {
        scheduledRerunRequested = false;
        try { await check(); }
        catch (error) { logger.error?.(`[uniswap] check: ${error.message}`); }
        if (!scheduledRerunRequested) break;
      }
      scheduledRerunRequested = false;
    })().finally(() => {
      scheduledDrainPromise = null;
    });
    return scheduledDrainPromise;
  }

  if (autoStart) {
    void requestScheduledCheck();
    timer = setInterval(requestScheduledCheck, Math.min(blogIntervalMs, governanceIntervalMs, githubIntervalMs));
    timer.unref?.();
  }

  return {
    check,
    state: () => state,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      scheduledRerunRequested = false;
      if (timer) clearInterval(timer);
      timer = null;
      const inFlight = [activeCheckPromise, scheduledDrainPromise, writeQueue].filter(Boolean);
      stopPromise = Promise.allSettled(inFlight).then(() => undefined);
      return stopPromise;
    },
  };
}
