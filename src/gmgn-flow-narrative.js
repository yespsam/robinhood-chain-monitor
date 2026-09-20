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

/** Pure evidence selection. Matching a ticker never establishes a narrative. */
export function resolveGmgnFlowNarrative({ chain, tokenAddress, tokenInfo, events = [], nowMs = Date.now() } = {}) {
  const slug = chainSlug(chain);
  const token = slug && address(tokenAddress, slug);
  const fallback = { status: "unverified", text: "未找到可按链和 CA 绑定的叙事出处", sourceUrl: null, sourceAt: null, chain: slug, tokenAddress: token };
  if (!slug || !token || !Number.isFinite(nowMs)) return fallback;
  const matched = (Array.isArray(events) ? events : []).flatMap((entry) => {
    const event = entry?.event || entry;
    if (event?.type !== "fomo_family_top_call" || !["fomo_x_call", "fomo_published_call"].includes(event?.signalKind)
      || chainSlug(event.chain) !== slug || address(event.token, slug) !== token
      || address(event.contractAddress || event.token, slug) !== token
      || !isMonitoringSourceEnabled(sourceConfig, event)) return [];
    const sourceAt = event.publishedAt || event.tweet?.createdAt || event.thesis?.createdAt;
    const published = Date.parse(sourceAt || "");
    if (!Number.isFinite(published) || published > nowMs + 60_000 || nowMs - published > GMGN_FLOW_NARRATIVE_MAX_AGE_MS) return [];
    const isX = event.signalKind === "fomo_x_call";
    const text = clean(isX ? event.tweet?.text : event.thesis?.text);
    if (!text || clean(event.thesis?.text) !== text || (event.body != null && clean(event.body) !== text)) return [];
    const sourceUrl = https(isX ? event.tweet?.url : event.fomoUrl || event.profileUrl || event.source?.url);
    if (!sourceUrl) return [];
    const url = new URL(sourceUrl);
    if (!isX && !["fomo.family", "api.fomoscan.sh", "prod-api.fomo.family"].includes(url.hostname)) return [];
    // The X source gate binds CA in thesis text; additionally require the
    // authenticated tweet text itself to carry the identical full address.
    if (isX && !text.toLowerCase().includes(token.toLowerCase())) return [];
    return [{ status: "sourced", text: excerpt(text), sourceUrl, sourceAt: new Date(published).toISOString(), chain: slug, tokenAddress: token }];
  }).sort((a, b) => Date.parse(b.sourceAt) - Date.parse(a.sourceAt));
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
