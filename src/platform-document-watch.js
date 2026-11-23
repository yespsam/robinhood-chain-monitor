// Bounded, read-only documentation observations. A changed document is NOT a
// verified platform deployment, token generation, or permission to trade.
import { createHash } from 'node:crypto';

export const PLATFORM_DOCUMENT_WATCH_VERSION = 'official_document_body_v1';
export const PLATFORM_DOCUMENT_MAX_PER_RUN = 4;
const MAX_PAGES = 128, MAX_CHANGES = 32, MAX_BODY_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 30 * 60_000, STALE_MS = 2 * 60 * 60_000;
const BODY_ERROR_CODES = new Set(['body_too_large', 'body_unavailable', 'source_not_allowed', 'redirect_rejected']);
const safeTransportCode = error => {
  const code = error?.cause?.code ?? error?.transportCode ?? error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,64}$/i.test(code) ? code : null;
};
const POLICIES = {
  flap: { origin: 'https://docs.flap.sh', sitemap: 'https://docs.flap.sh/sitemap.xml',
    path: /^\/flap\/(?:developers|skills|product-update)(?:\/|$)/i,
    seeds:['https://docs.flap.sh/flap/developers/deployed-contract-addresses',
      'https://docs.flap.sh/flap/developers/vault-developers/vault-and-vaultfactory-specification'] },
  fourmeme: { origin: 'https://four-meme.gitbook.io', sitemap: 'https://four-meme.gitbook.io/four.meme/sitemap.xml',
    path: /^\/four\.meme\/(?:product-update|brand\/protocol-integration|guide\/how-it-works)(?:\/|$)/i,
    seeds:['https://four-meme.gitbook.io/four.meme', 'https://four-meme.gitbook.io/four.meme/guide/how-it-works',
      'https://four-meme.gitbook.io/four.meme/brand/protocol-integration', 'https://four-meme.gitbook.io/four.meme/product-update'] },
  hyperevm: { origin: 'https://hyperliquid.gitbook.io', sitemap: 'https://hyperliquid.gitbook.io/hyperliquid-docs/sitemap.xml',
    path: /^\/hyperliquid-docs\/(?:for-developers\/hyperevm(?:\/|$)|onboarding\/how-to-use-the-hyperevm(?:\/|$)|builder-tools\/hyperevm-tools(?:\/|$))/i,
    seeds:['https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/raw-hyperevm-block-data',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-use-the-hyperevm',
      'https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools'] },
};
const stamp = value => Date.parse(value || '');
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const policyFor = platform => POLICIES[typeof platform === 'string' ? platform : platform?.id];
const cleanUrl = value => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url;
  } catch { return null; }
};
export function allowedPlatformDocumentUrl(platform, value) {
  const policy = policyFor(platform), url = cleanUrl(value);
  const configured = policy?.seeds.includes(url?.href);
  if (!policy || !url || url.origin !== policy.origin || !configured && !policy.path.test(url.pathname)
    || /(?:stock|equities|(?:^|[-_/])rwa(?:$|[-_/]))/i.test(url.pathname)
    || /\.(?:md|xml|json|js|css|png|jpe?g|svg|webp|pdf)$/i.test(url.pathname)
    || /%2f|%5c|%2e|\\/i.test(url.pathname)) return null;
  if (!configured && platform?.pagePattern instanceof RegExp) {
    const pattern = new RegExp(platform.pagePattern.source, platform.pagePattern.flags.replace(/[gy]/g, ''));
    if (!pattern.test(url.href)) return null;
  }
  return url.href;
}
function discovered(platform, entry) {
  const policy = policyFor(platform), raw = Array.isArray(entry?.capabilities?.pageMetadata) ? entry.capabilities.pageMetadata : [];
  const pages = new Map((policy?.seeds || []).map(url=>[url,{url,sourceKind:'configured_doc',sourceSitemap:null,sitemapLastmod:null}]));
  if (policy) for (const row of raw) {
    const url = allowedPlatformDocumentUrl(platform, row?.url);
    // A plain link/metadata record cannot promote itself into an official
    // document source. Require the configured official sitemap provenance.
    if (!url || row?.source?.kind !== 'sitemap' || cleanUrl(row.source.url)?.href !== policy.sitemap) continue;
    pages.set(url, { url, sourceKind:pages.has(url)?'configured_doc_and_sitemap':'sitemap',sourceSitemap: policy.sitemap, sitemapLastmod: row.lastmod || null });
  }
  return { total:new Set([...raw.map(row=>row?.url),...(policy?.seeds || [])]).size,
    configuredPages:policy?.seeds.length || 0,pages: [...pages.values()].sort((a, b) => a.url.localeCompare(b.url)) };
}
export function platformDocumentOriginCooldown(platform, entry) {
  const policy = policyFor(platform);
  if (!policy) return null;
  let until = stamp(entry?.documentWatch?.originNextAttemptAt);
  for (const source of Object.values(entry?.sources || {})) {
    let sameOrigin = false;
    try { sameOrigin = new URL(source?.url).origin === policy.origin; } catch {}
    if (sameOrigin && [403, 429].includes(source?.lastErrorStatus)) {
      const due = stamp(source.nextAttemptAt);
      if (Number.isFinite(due)) until = Number.isFinite(until) ? Math.max(until, due) : due;
    }
  }
  return Number.isFinite(until) ? until : null;
}
export function isPlatformDocumentOrigin(platform, value) {
  try { return new URL(value).origin === policyFor(platform)?.origin; } catch { return false; }
}

export function planPlatformDocumentWatch(platform, entry, nowMs, { limit = PLATFORM_DOCUMENT_MAX_PER_RUN } = {}) {
  const found = discovered(platform, entry), prior = entry?.documentWatch;
  const watch = prior?.version === PLATFORM_DOCUMENT_WATCH_VERSION ? structuredClone(prior)
    : { version: PLATFORM_DOCUMENT_WATCH_VERSION, pages: {}, changes: [], omittedChangeCount: 0 };
  watch.pages ||= {}; watch.changes ||= [];
  // Keep prior bounded evidence (including pages no longer in the sitemap),
  // never silently turn a previously observed document into a new baseline.
  watch.pages = Object.fromEntries(Object.entries(watch.pages).filter(([url]) => allowedPlatformDocumentUrl(platform, url)).slice(0, MAX_PAGES));
  for (const page of found.pages) {
    if (!watch.pages[page.url] && Object.keys(watch.pages).length >= MAX_PAGES) continue;
    watch.pages[page.url] = { ...page, discoveredAt: iso(nowMs), ...watch.pages[page.url],
      sourceKind:page.sourceKind,sourceSitemap: page.sourceSitemap, sitemapLastmod: page.sitemapLastmod };
  }
  watch.maxTrackedPages = MAX_PAGES;
  watch.refreshIntervalMs = REFRESH_MS;
  watch.staleAfterMs = STALE_MS;
  watch.observationOnly = true;
  const cooldown = platformDocumentOriginCooldown(platform, { ...entry, documentWatch: watch });
  const selected = cooldown !== null && cooldown > nowMs ? [] : found.pages.map(p => watch.pages[p.url]).filter(Boolean)
    .filter(p => !Number.isFinite(stamp(p.nextDueAt)) || stamp(p.nextDueAt) <= nowMs)
    .sort((a, b) => (stamp(a.lastAttemptAt) || 0) - (stamp(b.lastAttemptAt) || 0) || a.url.localeCompare(b.url))
    .slice(0, Math.max(0, Math.min(PLATFORM_DOCUMENT_MAX_PER_RUN, Number(limit) || 0)));
  return { watch, selected, discoveredPages: found.pages.length };
}

function decodeEntities(text) {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match, code) => {
    const value = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
  }).replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, entity => ({ '&nbsp;':' ', '&amp;':'&', '&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>' })[entity.toLowerCase()]);
}
export function platformDocumentSnapshot(input) {
  const html = String(input || '');
  if (Buffer.byteLength(html, 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error('document_body_too_large'), { code: 'body_too_large' });
  const body = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html;
  const text = decodeEntities(body.replace(/\r?\n/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|nav|header|footer|aside|svg|form|button|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|\/(?:p|div|li|h[1-6]|section|article|tr|pre))\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')).replace(/[\u200b-\u200d\ufeff]/g, '');
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter(line => !/^(?:last updated\b.{0,80}|was this helpful\??|powered by gitbook|edit (?:this )?page(?: on github)?)$/i.test(line));
  const normalized = lines.join('\n');
  if (normalized.length < 20 || /^(?:just a moment|access denied|checking your browser|attention required|please enable javascript)/i.test(normalized))
    throw Object.assign(new Error('document_body_unavailable'), { code: 'body_unavailable' });
  return { fingerprint: hash(normalized), contentLength: normalized.length,
    segments: lines.slice(0, 16).map(line => line.slice(0, 240)), summaryTruncated: lines.length > 16 || lines.some(line => line.length > 240) };
}
async function boundedResponseText(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw Object.assign(new Error('document_body_too_large'), { code:'body_too_large' });
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw Object.assign(new Error('document_body_too_large'), { code:'body_too_large' }); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function fetchPlatformDocument(platform, page, fetchImpl, { nowMs = Date.now(), timeoutMs = 10_000 } = {}) {
  const url = allowedPlatformDocumentUrl(platform, page?.url);
  if (!url) throw Object.assign(new Error('document_source_not_allowed'), { code:'source_not_allowed' });
  // This bounded, low-frequency lane shares the process with live RPC polling.
  // Request a fresh socket so stale keep-alive connections from the busy
  // monitor cannot poison a whole documentation batch.
  const headers = { accept:'text/html,text/markdown', 'accept-language':'en-US,en;q=0.9', connection:'close' };
  if (page.fingerprint && page.etag) headers['if-none-match'] = page.etag;
  if (page.fingerprint && page.lastModified) headers['if-modified-since'] = page.lastModified;
  let response;
  try {
    response = await fetchImpl(url, { headers, redirect:'manual', signal:AbortSignal.timeout(Math.max(1000, Math.min(20_000, Number(timeoutMs) || 10_000))) });
  } catch (error) {
    throw Object.assign(new Error('document_fetch_failed'), { code:'document_fetch_failed', transportCode:safeTransportCode(error) });
  }
  // Never follow an untrusted Location, nor accept a fetch adapter which has
  // already followed one and returned a body from another page/origin.
  if ((response.status >= 300 && response.status < 400 && response.status !== 304)
    || response.redirected === true || !response.url || allowedPlatformDocumentUrl(platform, response.url) !== url)
    throw Object.assign(new Error('document_redirect_rejected'), { code:'redirect_rejected' });
  if (response.status === 304 && page.fingerprint) return { notModified:true };
  if (!response.ok) {
    const retry = response.headers?.get?.('retry-after'), seconds = Number(retry);
    const retryAfterMs = retry ? Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, stamp(retry) - nowMs) || 0 : 0;
    throw Object.assign(new Error(`document_http_${response.status}`), { status:response.status, retryAfterMs });
  }
  let text;
  try { text = await boundedResponseText(response); }
  catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error('document_body_fetch_failed'), { code:'document_body_fetch_failed', transportCode:safeTransportCode(error) });
  }
  return { ...platformDocumentSnapshot(text), etag:response.headers?.get?.('etag') || null,
    lastModified:response.headers?.get?.('last-modified') || null };
}

export function applyPlatformDocumentResult(input, url, result, checkedAtMs, { retryBaseMs = 30_000, retryMaxMs = 120_000 } = {}) {
  const watch = structuredClone(input), prior = watch.pages[url];
  if (!prior || stamp(prior.lastAttemptAt) > checkedAtMs) return watch;
  const checkedAt = iso(checkedAtMs);
  if (result.error) {
    const failures = Number(prior.consecutiveFailures || 0) + 1;
    const status = result.error.status, httpCooldown = [403,429].includes(status);
    const delay = Math.max(Number(result.error.retryAfterMs) || 0, httpCooldown ? 15 * 60_000
      : Math.min(Math.max(1000, retryMaxMs), Math.max(1000, retryBaseMs) * 2 ** Math.min(20, failures - 1)));
    const due = iso(checkedAtMs + delay);
    watch.pages[url] = { ...prior, status:'failed', lastAttemptAt:checkedAt, lastErrorAt:checkedAt,
      lastError:BODY_ERROR_CODES.has(result.error.code) ? result.error.code
        : Number.isInteger(status) ? `document_http_${status}` : 'document_fetch_failed',
      lastTransportCode:safeTransportCode(result.error),
      lastErrorStatus:Number.isInteger(status) ? status : null, consecutiveFailures:failures, nextDueAt:due };
    if (httpCooldown) watch.originNextAttemptAt = iso(Math.max(stamp(watch.originNextAttemptAt) || 0, checkedAtMs + delay));
    return watch;
  }
  const changed = !result.notModified && !!prior.fingerprint && prior.fingerprint !== result.fingerprint;
  const page = { ...prior, ...(result.notModified ? {} : result), status:'healthy', lastAttemptAt:checkedAt,
    lastSuccessAt:checkedAt, nextDueAt:iso(checkedAtMs + REFRESH_MS), consecutiveFailures:0,
    lastError:null, lastErrorStatus:null, lastTransportCode:null, baselineAt:prior.baselineAt || checkedAt,
    lastContentChangedAt:changed ? checkedAt : prior.lastContentChangedAt || null };
  if (changed) {
    const before = prior.segments || [], after = result.segments || [];
    const change = { id:hash(`${url}:${prior.fingerprint}:${result.fingerprint}:${checkedAt}`), url, observedAt:checkedAt,
      status:'pending_verification', beforeFingerprint:prior.fingerprint, afterFingerprint:result.fingerprint,
      removed:before.filter(line => !after.includes(line)).slice(0,3), added:after.filter(line => !before.includes(line)).slice(0,3),
      summaryIncomplete:!!prior.summaryTruncated || !!result.summaryTruncated,
      meaning:'官方页面正文变化待核实；不代表新部署、新代次、具体 CA 或首三名交易资格' };
    page.latestChangeId = change.id;
    watch.changes.push(change);
    if (watch.changes.length > MAX_CHANGES) { watch.omittedChangeCount += watch.changes.length - MAX_CHANGES; watch.changes = watch.changes.slice(-MAX_CHANGES); }
  }
  watch.pages[url] = page;
  return watch;
}

export function platformDocumentCoverage(platform, entry, nowMs = Date.now()) {
  const found = discovered(platform, entry), watch = entry?.documentWatch?.version === PLATFORM_DOCUMENT_WATCH_VERSION ? entry.documentWatch : null;
  const result = { version:PLATFORM_DOCUMENT_WATCH_VERSION, observationOnly:true, totalDiscoveredPages:found.total,
    configuredPages:found.configuredPages,
    allowedPages:found.pages.length, excludedPages:found.total-found.pages.length, trackedPages:0,
    uncheckedPages:0, freshPages:0, stalePages:0, failedPages:0, nextDueAt:null,
    originNextAttemptAt:null, pendingChanges:watch?.changes?.filter(c=>c.status==='pending_verification').length || 0,
    omittedChangeCount:watch?.omittedChangeCount || 0, maxTrackedPages:MAX_PAGES, maxBodyRequestsPerRun:PLATFORM_DOCUMENT_MAX_PER_RUN,
    refreshIntervalMs:REFRESH_MS, staleAfterMs:STALE_MS, latestChanges:(watch?.changes || []).slice(-8), pages:[] };
  const cooldown = platformDocumentOriginCooldown(platform, entry);
  result.originNextAttemptAt = cooldown !== null && cooldown > nowMs ? iso(cooldown) : null;
  for (const item of found.pages) {
    const page = watch?.pages?.[item.url], last = stamp(page?.lastSuccessAt);
    if (page) result.trackedPages++;
    const status = page?.status === 'failed' ? 'failed' : !Number.isFinite(last) || last > nowMs + 5000 ? 'unchecked'
      : nowMs-last > STALE_MS ? 'stale' : 'fresh';
    result[`${status}Pages`]++;
    const due = Math.max(stamp(page?.nextDueAt) || nowMs, cooldown !== null && cooldown > nowMs ? cooldown : 0);
    if (!result.nextDueAt || due < stamp(result.nextDueAt)) result.nextDueAt = iso(due);
    if (result.pages.length < MAX_PAGES) result.pages.push({ url:item.url, status,
      lastAttemptAt:page?.lastAttemptAt || null, lastSuccessAt:page?.lastSuccessAt || null,
      lastContentChangedAt:page?.lastContentChangedAt || null, nextDueAt:iso(due), lastError:page?.lastError || null });
  }
  result.untrackedPages = result.allowedPages-result.trackedPages;
  result.rosterOverflowPages = Math.max(0,result.untrackedPages-Math.max(0,MAX_PAGES-Object.keys(watch?.pages || {}).length));
  return result;
}
