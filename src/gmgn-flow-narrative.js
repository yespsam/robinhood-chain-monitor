import { isMonitoringSourceEnabled } from "./source-controls.js";
import { gmgnFlowAddress } from "./gmgn-flow-signal.js";

export const GMGN_FLOW_NARRATIVE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CHAINS = new Map([["sol", "sol"], ["solana", "sol"], ["bsc", "bsc"], ["56", "bsc"], ["eth", "eth"], ["ethereum", "eth"], ["1", "eth"], ["base", "base"], ["8453", "base"], ["robinhood", "robinhood"], ["4663", "robinhood"]]);
const clean = (value) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
const chainSlug = (value) => CHAINS.get(clean(typeof value === "object" ? value?.gmgn || value?.slug || String(value?.id ?? "") : String(value ?? "")).toLowerCase()) || null;
const address = (value, chain) => gmgnFlowAddress(chain, clean(value));

function excerpt(value) {
  const original = clean(value);
  if (original.length <= 220) return original;
  let end = 219;
  for (const match of original.matchAll(/0x[0-9a-f]{40,64}\b|https:\/\/[^\s<>]+|@[A-Za-z0-9_]{1,15}\b|[1-9A-HJ-NP-Za-km-z]{32,44}/gu)) {
    if (match.index < end && match.index + match[0].length > end) end = match.index;
  }
  return `${original.slice(0, end).trim()}…`;
}

function https(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.toString() : null;
  } catch { return null; }
}

const sourceConfig = Object.freeze({
  monitorScope: "focus3", fomoCallEnabled: true, fomoXCallEnabled: true,
  fomoPublishedCallEnabled: true, fomoCallAllowGmgnObservedWallets: true,
});

// Per-scan lookup only; collection below still validates source, identity,
// timestamps, conflicts and text. Never cache a freshness decision here.
export function indexGmgnNarrativeEvents(events = []) {
  const index = new Map();
  for (const entry of Array.isArray(events) ? events : []) {
    const event = entry?.event || entry, slug = chainSlug(event?.chain);
    const token = slug && address(event?.token, slug);
    if (!slug || !token) continue;
    const key = `${slug}:${token}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }
  return index;
}

/** Authenticated source collection; source identity is not issuer endorsement. */
export function collectGmgnFlowNarratives({ chain, tokenAddress, events = [], nowMs = Date.now() } = {}) {
  const slug = chainSlug(chain);
  const token = slug && address(tokenAddress, slug);
  if (!slug || !token || !Number.isFinite(nowMs)) return [];
  const matched = (Array.isArray(events) ? events : []).flatMap((entry) => {
    const event = entry?.event || entry;
    if (event?.type !== "fomo_family_top_call" || !["fomo_x_call", "fomo_published_call"].includes(event?.signalKind)
      || chainSlug(event.chain) !== slug || address(event.token, slug) !== token
      || address(event.contractAddress || event.token, slug) !== token
      || !isMonitoringSourceEnabled(sourceConfig, event)) return [];
    const sourceAt = event.publishedAt || event.tweet?.createdAt || event.thesis?.createdAt;
    const published = Date.parse(sourceAt || "");
    if (!Number.isFinite(published) || published > nowMs) return [];
    const isX = event.signalKind === "fomo_x_call";
    const text = clean(isX ? event.tweet?.text : event.thesis?.text);
    if (!text || clean(event.thesis?.text) !== text || (event.body != null && clean(event.body) !== text)) return [];
    const sourceUrl = https(isX ? event.tweet?.url : event.fomoUrl || event.profileUrl || event.source?.url);
    if (!sourceUrl) return [];
    const url = new URL(sourceUrl);
    if (!isX && !["fomo.family", "api.fomoscan.sh", "prod-api.fomo.family"].includes(url.hostname)) return [];
    // The X source gate binds CA in thesis text; additionally require the
    // authenticated tweet text itself to carry the identical full address.
    if (isX && !(slug === 'sol' ? text.includes(token) : text.toLowerCase().includes(token.toLowerCase()))) return [];
    url.search = ''; url.hash = '';
    const author = clean(event.caller?.xProfileId || event.caller?.xUserId || event.tweet?.xUserId);
    const handle = clean(event.caller?.handle || event.tweet?.handle).toLowerCase();
    return [{ status: "sourced", text: excerpt(text), sourceText: text.slice(0, 4000), sourceUrl: url.toString(), sourceAt: new Date(published).toISOString(), chain: slug, tokenAddress: token,
      sourceKind: isX ? 'authenticated_x' : 'authenticated_call', sourceId: isX ? `x:${event.tweet.id}` : `fomo:${clean(event.callId || event.stableId)}`,
      authorKey: author ? `x-id:${author}` : handle ? `x-handle:${handle}` : null,
      authorLabel: handle || null, sourceAuthenticated: true }];
  }).sort((a, b) => Date.parse(b.sourceAt) - Date.parse(a.sourceAt));
  // Replays of one permalink cannot refresh its original age or count as extra evidence.
  const sources = new Map();
  for (const item of matched) {
    const key = item.sourceId || item.sourceUrl;
    const prior = sources.get(key);
    const conflict = prior?.contentConflict || prior && prior.sourceText !== item.sourceText;
    if (!prior || Date.parse(item.sourceAt) < Date.parse(prior.sourceAt)) sources.set(key, { ...item, contentConflict: !!conflict });
    else if (conflict) sources.set(key, { ...prior, contentConflict: true });
  }
  return [...sources.values()].filter(item => nowMs - Date.parse(item.sourceAt) <= GMGN_FLOW_NARRATIVE_MAX_AGE_MS).sort((a, b) => Date.parse(b.sourceAt) - Date.parse(a.sourceAt)).slice(0, 12);
}

/** Pure evidence selection. Matching a ticker never establishes a narrative. */
export function resolveGmgnFlowNarrative({ chain, tokenAddress, tokenInfo, events = [], nowMs = Date.now() } = {}) {
  const slug = chainSlug(chain);
  const token = slug && address(tokenAddress, slug);
  const fallback = { status: "unverified", text: "未找到可按链和 CA 绑定的叙事出处", sourceUrl: null, sourceAt: null, chain: slug, tokenAddress: token };
  if (!slug || !token || !Number.isFinite(nowMs)) return fallback;
  const matched = collectGmgnFlowNarratives({ chain, tokenAddress, events, nowMs });
  if (matched.length) return matched[0];
  const info = tokenInfo?.data && typeof tokenInfo.data === "object" ? tokenInfo.data : tokenInfo;
  const claims = [info?.chain, info?.chain_id, info?.chainId].filter(value => value != null);
  const infoAddress = address(info?.address || info?.token_address, slug);
  const description = clean(info?.link?.description);
  if (infoAddress === token && claims.length && claims.every(value => chainSlug(value) === slug) && description) {
    return { status: "project_claim", text: excerpt(description), sourceUrl: `https://gmgn.ai/${slug}/token/${token}`, sourceAt: new Date(nowMs).toISOString(), chain: slug, tokenAddress: token };
  }
  return fallback;
}
