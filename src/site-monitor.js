import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { monitoredLaunchpads } from "./launchpad-catalog.js";
import { BSC_LAUNCHPAD_CATALOG } from "./bsc-launchpad-monitor.js";
import { sendAlerts } from "./alerts.js";
import { extractGithubRepositories } from "./github-monitor.js";
import { isMonitoringSourceEnabled } from "./source-controls.js";
import { extractChainSupportSignals, mergeChainSupportSignals } from "./chain-support.js";

const SOCIAL = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|github\.com|t\.me|discord\.gg)\/[A-Za-z0-9_./?=-]+/gi;
const SIGNAL = /\b(factory|launcher|bonding|curve|graduation|router|liquidity|upgrade|proxy|v[2-9]|github|twitter|x\.com)\b/gi;
const STRUCTURAL_SIGNAL = new Set(["factory", "launcher", "bonding", "curve", "graduation", "upgrade", "proxy", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"]);
const SITE_SIGNAL_SCHEMA_VERSION = 6;
const FEATURE_SIGNALS = new Map([
  ["ai_launching", /\bAI\b[^\n.]{0,40}\blaunch(?:ing)?\b/i],
  ["anonymous_launching", /\banonymous\s+launch(?:ing)?\b/i],
  ["squads", /\bsquads?\b/i],
  ["weekly_airdrops", /\bweekly\s+airdrops?\b/i],
  ["tokenomics", /\btokenomics\b/i],
  ["fair_launch", /\bfair\s+launch\b/i],
  ["presale", /\bpre[- ]?sale\b/i],
  ["liquidity_lock", /\bliquidity\s+lock(?:er|ing)?\b/i],
  ["vesting", /\bvesting\b/i],
  ["anti_bot", /\banti[- ]?(?:bot|sniper)\b/i],
  ["revenue_share", /\b(?:revenue|fee)\s+shar(?:e|ing)\b/i],
  ["bonding_curve", /\bbonding\s+curve\b/i],
]);
const FLYPAD_DOC_LINK = /https:\/\/docs\.flypad\.app\/[A-Za-z0-9_./-]+(?:\.md)?/gi;
const PLATFORM_ADDRESS_KEY = /"(?:factoryAddress|launcherAddress|portalAddress|vaultPortalAddress|routerAddress|hookAddress|vaultFactoryAddress|managerAddress|deployerAddress|implementationAddress|proxyAddress|tokenCreatorAddress|tokenCreatorTaxAddress|tokenCreatorRushAddress|tokenManager\d*Address)"\s*:\s*"(0x[a-fA-F0-9]{40})"/gi;
const PLATFORM_ADDRESS_LABEL = /\b(?:factory|launcher|portal|vault\s*portal|router|hook|vault\s*factory|manager|deployer|implementation|proxy|token\s*creator|token\s*manager|platform\s*contract|contract\s*address)\b[\s\S]{0,80}?(0x[a-fA-F0-9]{40})/gi;
const STRUCTURAL_ASSET = /\b(?:ai|launch|factory|bonding|curve|tax|reflect|dividend)[A-Za-z0-9_.?=&/-]*\.(?:js|css)(?:\?[^"'<>\s]*)?/i;
const SITE_HEALTH_SCHEMA_VERSION = 1;
const SITE_SIGNAL_FIELDS = ["socials", "contracts", "keywords", "features", "pages", "assets", "chains"];

function copySiteSignalValues(values) {
  return (Array.isArray(values) ? values : []).map((value) => (
    value && typeof value === "object" ? { ...value } : value
  ));
}

function compactSiteSignalSnapshot(signals, fields) {
  return Object.fromEntries(fields.map((field) => [field, copySiteSignalValues(signals?.[field])]));
}

function siteAdditionDelta(additions) {
  const changedFields = SITE_SIGNAL_FIELDS.filter((field) => additions[field]?.length);
  return {
    changeType: "added",
    comparisonMode: "addition_only",
    changedFields,
    added: Object.fromEntries(changedFields.map((field) => [field, copySiteSignalValues(additions[field])])),
    // A single HTML observation is not sufficient evidence that an official
    // capability was removed. Preserve both snapshots for comparison, but do
    // not turn transient rendering/fetch variation into a removal claim.
    removalsConfirmed: false,
  };
}

function isStructuredBscOfficialEndpoint(entry, value) {
  if (!["fourmeme", "openfour"].includes(String(entry?.id || "").toLowerCase())) return false;
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase().replace(/^www\./, "") === "four.meme"
      && url.pathname.replace(/\/+$/, "") === "/meme-api/v1/public/address";
  } catch {
    return false;
  }
}

const bscSourceTargets = BSC_LAUNCHPAD_CATALOG
  .filter((entry) => entry.website && entry.siteMonitor !== false && !["flap", "fourmeme"].includes(entry.id))
  .flatMap((entry) => {
    const base = {
      name: entry.name,
      platformId: entry.id,
      chainId: 56,
      sourceTrust: "official_verified",
      twitter: entry.twitter || null,
      docs: entry.evidenceUrl || null,
      model: "BSC launchpad official-source discovery",
      trackAssets: entry.trackAssets === true,
    };
    const targets = [{ ...base, id: `bsc-${entry.id}`, website: entry.website }];
    if (/^https:\/\//i.test(entry.evidenceUrl || "")
      && !/^https:\/\/github\.com\//i.test(entry.evidenceUrl)
      && entry.evidenceUrl !== entry.website
      // `/public/address` is already consumed by the BSC monitor's guarded,
      // structured official parser. Treating the JSON API as a generic HTML
      // site adds a duplicate request and recurring schema/transport noise.
      && !isStructuredBscOfficialEndpoint(entry, entry.evidenceUrl)) {
      targets.push({ ...base, id: `bsc-${entry.id}-docs`, website: entry.evidenceUrl });
    }
    return targets;
  });

export const BSC_DISCOVERY_SITE_TARGETS = [
  ...bscSourceTargets,
  {
    id: "bsc-flypad-index",
    name: "FlyPad",
    platformId: "flypad",
    chainId: 56,
    sourceTrust: "official_verified",
    website: "https://docs.flypad.app/llms.txt",
    twitter: "https://x.com/flypad_app",
    docs: "https://docs.flypad.app",
    model: "BSC launchpad machine-readable documentation index",
  },
  {
    id: "bsc-flypad-features",
    name: "FlyPad",
    platformId: "flypad",
    chainId: 56,
    sourceTrust: "official_verified",
    website: "https://docs.flypad.app/technical/detailed-feature-list.md",
    twitter: "https://x.com/flypad_app",
    docs: "https://docs.flypad.app",
    model: "BSC launchpad official technical modes",
  },
  {
    id: "bsc-flypad-ai-anonymous",
    name: "FlyPad",
    platformId: "flypad",
    chainId: 56,
    sourceTrust: "official_verified",
    website: "https://docs.flypad.app/technical/ai-and-anonymous-launching.md",
    twitter: "https://x.com/flypad_app",
    docs: "https://docs.flypad.app",
    model: "BSC launchpad official AI/anonymous modes",
  },
];

function normalizeSocialUrl(value) {
  try {
    const url = new URL(value.replace(/[)'"<>]+$/, ""));
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    if (hostname === "x.com" || hostname === "twitter.com") {
      const handle = parts[0];
      if (parts.length !== 1 || !/^[A-Za-z0-9_]{1,15}$/.test(handle || "")) return null;
      if (["home", "share", "intent", "search", "i", "you", "settings", "messages", "notifications", "explore"].includes(handle.toLowerCase())) return null;
      return `https://x.com/${handle}`;
    }
    if (hostname === "t.me") {
      const channel = parts[0] === "s" ? parts[1] : parts[0];
      return channel ? `https://t.me/${channel}` : null;
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2f;|&#47;/gi, "/");
}

function trustedSocialContextRanges(html) {
  const ranges = [];
  const patterns = [
    /<(footer|header|nav)\b[^>]*>[\s\S]*?<\/\1>/gi,
    /<(div|section|ul)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:social(?:-links?)?|follow-us)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of String(html).matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function extractTrustedXProfiles(html) {
  const source = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (match) => " ".repeat(match.length))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (match) => " ".repeat(match.length))
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (match) => " ".repeat(match.length))
    .replace(/<blockquote\b[^>]*(?:twitter-tweet|tweet|embed)[^>]*>[\s\S]*?<\/blockquote>/gi, (match) => " ".repeat(match.length));
  const trustedRanges = trustedSocialContextRanges(source);
  const profiles = [];
  for (const match of source.matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)) {
    const anchor = match[0];
    const openingTag = anchor.match(/^<a\b[^>]*>/i)?.[0] || "";
    const hrefMatch = openingTag.match(/\bhref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
    if (!hrefMatch) continue;
    const href = decodeHtmlAttribute(hrefMatch[2] || hrefMatch[3]);
    const profile = normalizeSocialUrl(href);
    if (!profile || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(profile)) continue;

    const body = anchor.slice(openingTag.length).replace(/<\/a\s*>$/i, "");
    const text = body.replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|amp|quot|#39);/gi, " ").replace(/\s+/g, " ").trim();
    const attributesWithoutHref = openingTag.replace(hrefMatch[0], "");
    const isSitewide = trustedRanges.some(([start, end]) => match.index >= start && match.index < end);
    const hasSocialLabel = /^(?:x|twitter|x\s*\(twitter\)|follow(?:\s+us)?(?:\s+on)?\s+(?:x|twitter))$/i.test(text)
      || /(?:aria-label|title)\s*=\s*["'][^"']*\b(?:twitter|follow(?:\s+us)?\s+on\s+x|x\s+profile)\b[^"']*["']/i.test(attributesWithoutHref)
      || /(?:class|id)\s*=\s*["'][^"']*(?:twitter|social(?:-link)?|x-(?:logo|icon)|icon-x)[^"']*["']/i.test(attributesWithoutHref)
      || /(?:aria-label|title|data-icon|class)\s*=\s*["'][^"']*(?:twitter|x-(?:twitter|logo|icon)|icon-x)[^"']*["']/i.test(body);
    if (isSitewide || hasSocialLabel) profiles.push(profile);
  }
  return [...new Set(profiles)];
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
}

async function runBounded(items, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index]);
    }
  });
  await Promise.allSettled(workers);
}

function isTimeoutError(error) {
  return error?.name === "TimeoutError" || /(?:timed?\s*out|timeout)/i.test(error?.message || "");
}

function responseRetryAfterMs(response, currentTimeMs) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - currentTimeMs) : null;
}

function taggedError(error, failureKind, pendingRecovery = null) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.monitorFailureKind = failureKind;
  if (pendingRecovery) tagged.pendingRecovery = pendingRecovery;
  return tagged;
}

export function extractSiteSignals(html, { trackAssets = false } = {}) {
  const nonXSocials = (String(html).match(SOCIAL) || [])
    .filter((value) => !/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(value))
    .map(normalizeSocialUrl)
    .filter(Boolean);
  const socials = [...new Set([...nonXSocials, ...extractTrustedXProfiles(html)])].sort();
  const visible = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|#39);/g, " ");
  const keywords = [...new Set((visible.match(SIGNAL) || []).map((word) => word.toLowerCase()))].sort();
  const features = [...FEATURE_SIGNALS.entries()].filter(([, pattern]) => pattern.test(visible)).map(([name]) => name).sort();
  const pages = [...new Set((String(html).match(FLYPAD_DOC_LINK) || []).map((url) => url.replace(/\.md$/i, "")))].sort();
  const decoded = String(html).replace(/\\{1,2}"/g, "\"");
  const contracts = [];
  for (const match of decoded.matchAll(PLATFORM_ADDRESS_KEY)) contracts.push(match[1].toLowerCase());
  for (const objectMatch of decoded.matchAll(/\{[^{}]{0,1600}\}/g)) {
    const objectText = objectMatch[0];
    if (!/"contractName"\s*:\s*"[A-Za-z][A-Za-z0-9_-]{1,100}"/i.test(objectText)) continue;
    const address = objectText.match(/"contractAddress"\s*:\s*"(0x[a-fA-F0-9]{40})"/i)?.[1];
    if (address) contracts.push(address.toLowerCase());
  }
  for (const match of visible.matchAll(PLATFORM_ADDRESS_LABEL)) contracts.push(match[1].toLowerCase());
  contracts.sort();
  const assets = trackAssets ? [...new Set([...String(html).matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi)]
    .map((match) => match[1])
    .filter((asset) => STRUCTURAL_ASSET.test(asset)))].sort() : [];
  const scriptSchemas = [...String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join("\n")
    .replace(/\\{1,2}"/g, "\"");
  const chains = mergeChainSupportSignals([
    ...extractChainSupportSignals(visible, { allowNetworkList: true }),
    ...extractChainSupportSignals(scriptSchemas, { allowNetworkList: true, structuredOnly: true }),
  ]);
  return { socials, keywords, contracts: [...new Set(contracts)], features, pages, assets, chains };
}

function normalizePublicWebsite(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const candidate = /^https:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname.includes(".") || url.hostname === "localhost" || /^\d+(?:\.\d+){3}$/.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

function canonicalSiteTargetUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    url.search = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function focus3SitePlatformFamily(target) {
  const identities = [target?.platformId, target?.id, target?.name]
    .map((value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (identities.some((value) => value === "flap" || value === "flapsh" || value === "flapdotsh")) return "flap";
  if (identities.some((value) => value.includes("fourmeme") || value.includes("openfour"))) return "fourmeme";
  try {
    const host = new URL(target.website).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "flap.sh" || host.endsWith(".flap.sh")) return "flap";
    if (host === "four.meme" || host.endsWith(".four.meme") || host === "four-meme.gitbook.io") return "fourmeme";
  } catch { /* Invalid URLs were already excluded by the caller. */ }
  return null;
}

function dedupeFocus3SiteTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    const family = focus3SitePlatformFamily(target);
    if (!family) return true;
    const canonical = canonicalSiteTargetUrl(target.website);
    const key = `${family}:${canonical}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function startSiteMonitor(config, dependencies = {}) {
  const stateFile = path.join(config.dataDir, "site-state.json");
  const watchlistFile = path.join(config.dataDir, "site-watchlist.json");
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const now = dependencies.now || (() => new Date());
  const random = dependencies.random || Math.random;
  const concurrency = Math.max(1, Number(config.siteCheckConcurrency) || 6);
  const requestTimeoutMs = Math.max(1_000, Number(config.siteRequestTimeoutMs) || 10_000);
  const retryBaseMs = Math.max(1_000, Number(config.siteRetryBaseMs) || 120_000);
  const retryMaxMs = Math.max(retryBaseMs, Number(config.siteRetryMaxMs) || 3_600_000);
  const blockedRetryMs = Math.max(retryBaseMs, Number(config.siteBlockedRetryMs) || 1_800_000);
  const notFoundRetryMs = Math.max(blockedRetryMs, Number(config.siteNotFoundRetryMs) || 21_600_000);
  const recoveryAlertWindowMs = Math.max(0, Number(config.siteRecoveryAlertWindowMs) || 600_000);
  let running = false;
  let activeCheckPromise = null;
  let scheduledDrainPromise = null;
  let scheduledRerunRequested = false;
  let schedulerStopped = false;
  let stopPromise = null;
  let watchQueue = Promise.resolve();

  function healthFor(state, id) {
    return state._health.targets[id] || null;
  }

  function canAttempt(state, id) {
    const nextAttemptAt = Date.parse(healthFor(state, id)?.nextAttemptAt || "");
    return !Number.isFinite(nextAttemptAt) || now().getTime() >= nextAttemptAt;
  }

  function markSuccess(state, launchpad, recovery = null) {
    const previous = healthFor(state, launchpad.id) || {};
    const timestamp = now().toISOString();
    state._health.targets[launchpad.id] = {
      ...previous,
      name: launchpad.name,
      website: launchpad.website,
      status: "healthy",
      lastAttemptAt: timestamp,
      lastSuccessAt: timestamp,
      ...(previous.consecutiveFailures > 0 ? { lastRecoveredAt: timestamp } : {}),
      ...(recovery ? { lastRecovery: recovery } : {}),
      consecutiveFailures: 0,
      nextAttemptAt: null,
      backoffMs: 0,
      failureKind: null,
      pendingRecovery: null,
      lastErrorAt: null,
      lastError: null,
      lastErrorStatus: null,
    };
  }

  function markFailure(state, launchpad, error) {
    const previous = healthFor(state, launchpad.id) || {};
    const timestamp = now();
    const consecutiveFailures = Math.max(0, Number(previous.consecutiveFailures) || 0) + 1;
    const exponential = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(20, consecutiveFailures - 1)));
    const status = Number.isInteger(error?.status) ? error.status : null;
    const categoryDelay = status === 404
      ? notFoundRetryMs
      : [403, 429].includes(status)
        ? blockedRetryMs
        : exponential;
    const jittered = Math.max(1_000, Math.round(categoryDelay * (0.8 + (Math.max(0, Math.min(1, random())) * 0.4))));
    const requestedDelay = Number(error?.retryAfterMs);
    const backoffMs = Number.isFinite(requestedDelay) && requestedDelay > 0
      ? Math.max(jittered, requestedDelay)
      : jittered;
    state._health.targets[launchpad.id] = {
      ...previous,
      name: launchpad.name,
      website: launchpad.website,
      status: "degraded",
      failureKind: error?.monitorFailureKind || (status ? `http_${status}` : isTimeoutError(error) ? "timeout" : "network_or_parse"),
      lastAttemptAt: timestamp.toISOString(),
      firstFailureAt: previous.consecutiveFailures > 0 ? previous.firstFailureAt : timestamp.toISOString(),
      lastErrorAt: timestamp.toISOString(),
      lastError: error?.message || String(error),
      lastErrorStatus: status,
      consecutiveFailures,
      backoffMs,
      nextAttemptAt: new Date(timestamp.getTime() + backoffMs).toISOString(),
      pendingRecovery: error?.pendingRecovery || previous.pendingRecovery || null,
    };
  }

  const runCheckCycle = async () => {
    if (running) return;
    running = true;
    try {
      let state = {};
      try { state = JSON.parse(await fs.readFile(stateFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      state._health ||= {};
      state._health.schemaVersion = SITE_HEALTH_SCHEMA_VERSION;
      state._health.targets ||= {};
      let dynamic = [];
      try { dynamic = JSON.parse(await fs.readFile(watchlistFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const configuredTargets = dependencies.targets || [...monitoredLaunchpads(), ...BSC_DISCOVERY_SITE_TARGETS];
      const eligibleTargets = [...configuredTargets, ...dynamic]
        .filter((item) => item.website && isMonitoringSourceEnabled(config, item));
      // Persisted auto-discovery entries are factory keyed, so the same Flap or
      // Four.Meme homepage can otherwise be fetched once per historical factory.
      // In focus3 the configured official target comes first and wins by stable
      // platform family + canonical URL; structured BSC lanes remain untouched.
      const scopedTargets = String(config.monitorScope || "").toLowerCase() === "focus3"
        ? dedupeFocus3SiteTargets(eligibleTargets)
        : eligibleTargets;
      const targets = new Map(scopedTargets.map((item) => [item.id, item]));
      const inspect = async (launchpad) => {
        if (!canAttempt(state, launchpad.id)) return;
        try {
          const wantsMarkdown = /(?:\.md|llms\.txt)$/i.test(launchpad.website);
          const response = await fetchImpl(launchpad.website, { headers: { "user-agent": "robinhood-launchpad-monitor", accept: wantsMarkdown ? "text/markdown,text/plain;q=0.9" : "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(requestTimeoutMs) });
          if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.retryAfterMs = responseRetryAfterMs(response, now().getTime());
            throw error;
          }
          const html = await response.text();
          const signals = extractSiteSignals(html, { trackAssets: launchpad.trackAssets === true });
          const fingerprint = createHash("sha256").update(JSON.stringify(signals)).digest("hex");
          const previous = state[launchpad.id];
          const previousHealth = healthFor(state, launchpad.id) || {};
          const recovering = Number(previousHealth.consecutiveFailures || 0) > 0;
          const recoveredAt = now();
          const pendingRecovery = previousHealth.pendingRecovery;
          const outageStartedAt = pendingRecovery?.outageStartedAt || previousHealth.firstFailureAt || previousHealth.lastErrorAt || null;
          const outageStartedMs = Date.parse(outageStartedAt || "");
          const outageMs = recovering && Number.isFinite(outageStartedMs)
            ? Math.max(0, recoveredAt.getTime() - outageStartedMs)
            : 0;
          const driftDetected = previous?.schemaVersion === SITE_SIGNAL_SCHEMA_VERSION && previous.fingerprint !== fingerprint;
          const sourceOutage = Boolean(pendingRecovery?.driftSuppressed)
            || /^(?:http_\d+|timeout|network_or_parse)$/.test(previousHealth.failureKind || "");
          const suppressRecoveryDrift = driftDetected
            && sourceOutage
            && (Boolean(pendingRecovery?.driftSuppressed) || outageMs > recoveryAlertWindowMs);
          const recovery = recovering ? {
            recoveredAt: recoveredAt.toISOString(),
            outageStartedAt,
            outageMs,
            failureKind: previousHealth.failureKind || null,
            sourceOutage,
            driftDetected,
            driftSuppressed: suppressRecoveryDrift,
            ...(driftDetected ? {
              fromFingerprint: previous?.fingerprint || null,
              toFingerprint: fingerprint,
            } : {}),
          } : null;
          if (previous?.schemaVersion === SITE_SIGNAL_SCHEMA_VERSION && previous.fingerprint !== fingerprint) {
            const newSocials = signals.socials.filter((x) => !previous.signals.socials.includes(x));
            const newContracts = signals.contracts.filter((x) => !previous.signals.contracts.includes(x));
            const newKeywords = signals.keywords.filter((x) => !previous.signals.keywords.includes(x) && STRUCTURAL_SIGNAL.has(x));
            const newFeatures = signals.features.filter((x) => !(previous.signals.features || []).includes(x));
            const newPages = launchpad.id === "bsc-flypad-index"
              ? signals.pages.filter((x) => !(previous.signals.pages || []).includes(x))
              : [];
            const newAssets = signals.assets.filter((x) => !(previous.signals.assets || []).includes(x));
            const previousChains = new Set((previous.signals.chains || []).map((item) => `${item.id}:${item.environment}`));
            const newChains = signals.chains.filter((item) => !previousChains.has(`${item.id}:${item.environment}`));
            if (newSocials.length || newContracts.length || newKeywords.length || newFeatures.length || newPages.length || newAssets.length || newChains.length) {
              const observedAt = recoveredAt.toISOString();
              const additions = {
                socials: newSocials,
                contracts: newContracts,
                keywords: newKeywords,
                features: newFeatures,
                pages: newPages,
                assets: newAssets,
                chains: newChains,
              };
              const signalDelta = siteAdditionDelta(additions);
              if (!suppressRecoveryDrift) {
                try {
                  await alertSender(config, {
                    type: "launchpad_site_update",
                    launchpad,
                    newSocials,
                    newContracts,
                    newKeywords,
                    newFeatures,
                    newPages,
                    newAssets,
                    newChains,
                    previousSignals: compactSiteSignalSnapshot(previous.signals, signalDelta.changedFields),
                    currentSignals: compactSiteSignalSnapshot(signals, signalDelta.changedFields),
                    signalDelta,
                    ...(newChains.length ? { chainSupport: newChains } : {}),
                    url: launchpad.website,
                    observedAt,
                    ...(recovery ? { recovery } : {}),
                  });
                } catch (error) {
                  throw taggedError(error, "alert_delivery");
                }
              }
              if (dependencies.onOfficialRepository) {
                const repositories = extractGithubRepositories(newSocials.join("\n"));
                for (const repository of repositories) {
                  try {
                    await Promise.resolve(dependencies.onOfficialRepository(repository, {
                      source: "official_site",
                      url: launchpad.website,
                      observedAt,
                      launchpad: launchpad.platformId || launchpad.id,
                      launchpadName: launchpad.name,
                      ...(recovery ? { recovery } : {}),
                      ...(suppressRecoveryDrift ? { suppressAlert: true } : {}),
                    }));
                  } catch (error) {
                    throw taggedError(error, "official_repository_callback", suppressRecoveryDrift ? recovery : null);
                  }
                }
              }
              if (launchpad.chainId === 56 && newContracts.length && dependencies.onContractDiscovery) {
                try {
                  await Promise.resolve(dependencies.onContractDiscovery({
                    addresses: newContracts,
                    chainId: launchpad.chainId,
                    platformId: launchpad.platformId,
                    platformName: launchpad.name,
                    sourceTrust: launchpad.sourceTrust,
                    sourceId: `official-site:${launchpad.id}`,
                    sourceUrl: launchpad.website,
                    observedAt,
                    ...(recovery ? { recovery } : {}),
                    ...(suppressRecoveryDrift ? { suppressAlert: true } : {}),
                  }));
                } catch (error) {
                  throw taggedError(error, "contract_discovery_callback", suppressRecoveryDrift ? recovery : null);
                }
              }
            }
          }
          state[launchpad.id] = { schemaVersion: SITE_SIGNAL_SCHEMA_VERSION, fingerprint, signals, checkedAt: now().toISOString() };
          markSuccess(state, launchpad, recovery);
        } catch (error) {
          markFailure(state, launchpad, error);
          console.error(`[site] ${launchpad.id}: ${error.message}`);
        }
      };
      await runBounded([...targets.values()], concurrency, inspect);
      await writeJsonAtomic(stateFile, state);
    } finally {
      running = false;
    }
  };

  const check = () => {
    if (schedulerStopped) return activeCheckPromise || Promise.resolve();
    // Preserve the historical manual-overlap contract: callers that invoke
    // check while one is active receive undefined rather than starting work.
    if (activeCheckPromise) return undefined;
    activeCheckPromise = runCheckCycle().finally(() => {
      activeCheckPromise = null;
      if (!schedulerStopped && scheduledRerunRequested && !scheduledDrainPromise) void requestScheduledCheck();
    });
    return activeCheckPromise;
  };

  function requestScheduledCheck() {
    if (schedulerStopped) return scheduledDrainPromise || activeCheckPromise || Promise.resolve();
    if (running || scheduledDrainPromise) {
      scheduledRerunRequested = true;
      return scheduledDrainPromise || activeCheckPromise;
    }
    scheduledDrainPromise = (async () => {
      for (let cycle = 0; cycle < 2 && !schedulerStopped; cycle += 1) {
        scheduledRerunRequested = false;
        try { await check(); }
        catch (error) { console.error(`[site] check: ${error.message}`); }
        if (!scheduledRerunRequested) break;
      }
      scheduledRerunRequested = false;
    })().finally(() => {
      scheduledDrainPromise = null;
    });
    return scheduledDrainPromise;
  }

  let timer = null;
  if (dependencies.autoStart !== false) {
    void requestScheduledCheck();
    timer = setInterval(requestScheduledCheck, config.sitePollIntervalMs);
    timer.unref();
  }
  const watch = async ({ factory, website, name, twitter, telegram, discord }) => {
    if (schedulerStopped) return false;
    if (!isMonitoringSourceEnabled(config, { factory, website, name, twitter })) return false;
    const normalized = normalizePublicWebsite(website);
    if (!factory || !normalized) return false;
    const operation = watchQueue.catch(() => {}).then(async () => {
      let dynamic = [];
      try { dynamic = JSON.parse(await fs.readFile(watchlistFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const id = `auto-${factory.toLowerCase()}`;
      const item = { id, name: name || "未知早期发射台", factories: [factory.toLowerCase()], website: normalized, twitter: twitter || null, telegram: telegram || null, discord: discord || null, model: "auto-discovered early launchpad", match: "token_metadata" };
      const index = dynamic.findIndex((entry) => entry.id === id);
      if (index >= 0) dynamic[index] = item; else dynamic.push(item);
      await writeJsonAtomic(watchlistFile, dynamic);
      return true;
    });
    watchQueue = operation;
    return operation;
  };
  return {
    check,
    watch,
    stop: () => {
      if (stopPromise) return stopPromise;
      schedulerStopped = true;
      scheduledRerunRequested = false;
      if (timer) clearInterval(timer);
      timer = null;
      const inFlight = [activeCheckPromise, scheduledDrainPromise, watchQueue].filter(Boolean);
      stopPromise = Promise.allSettled(inFlight).then(() => undefined);
      return stopPromise;
    },
  };
}
