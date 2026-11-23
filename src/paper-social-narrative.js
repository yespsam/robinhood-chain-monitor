// Feeds identity-verified social posts (twitter-narrative monitor, oEmbed-verified) into the
// paper narrative assessment. Matching policy:
//  - CA match (preferred): post text contains the exact contract address on the same chain → matchKind 'ca'.
//  - Ticker match: no CA in post, but a REPUTABLE allowlisted author (chain affinity checked) names the token
//    by $cashtag / whole-word symbol / name (Han ≥2 chars, latin ≥3, not a common word) → matchKind 'ticker'.
//    Non-allowlisted authors can never establish narrative by ticker alone (anti ticker spam).
//  - Replies/quotes allowed; duplicate bodies collapse; posts must be ≤24h old and not from the future.
import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { narrativeNameMatch, compileNarrativeName } from './narrative-name-match.js';

export const SOCIAL_NARRATIVE_VERSION = 'social_narrative_v1';
const ALL = ['bsc', 'sol', 'eth', 'base', 'robinhood'];
// author (lowercase handle) → chains where their mention can seed a meme narrative.
export const REPUTABLE_NARRATIVE_AUTHORS = Object.freeze({
  cz_binance: ['bsc'], heyibinance: ['bsc'], binance: ['bsc'], binancewallet: ['bsc'], bnbchain: ['bsc'],
  fourdotmemezh: ['bsc'], four_meme_: ['bsc'], flapdotsh: ['bsc'],
  elonmusk: ALL, beffjezos: ALL,
});
const HOUR = 3_600_000;
const stamp = v => typeof v === 'number' ? (v < 1e10 ? v * 1000 : v) : Date.parse(v || '');
const caIn = (text, chain, ca) => {
  if (!ca) return false;
  const found = chain === 'sol' ? text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) : text.match(/0x[\da-fA-F]{40}/g);
  return (found || []).some(x => gmgnFlowAddress(chain, x) === ca);
};
const nameUsable = name => { const s = String(name || '').trim(); return s.length >= 2 && s.length <= 40 && (/\p{Script=Han}/u.test(s) || s.replace(/^\$/, '').length >= 3) && !!compileNarrativeName(s); };

export function collectSocialNarrativeSources({ posts = [], chain, address, token = {}, nowMs = Date.now() } = {}) {
  const ca = gmgnFlowAddress(chain, address);
  if (!ca) return [];
  const symbol = String(token.symbol || '').replace(/^\$/, '').trim(), name = String(token.name || '').trim();
  const names = [...new Set([symbol && `$${symbol}`, nameUsable(symbol) && symbol, nameUsable(name) && name].filter(Boolean))];
  const out = [], bodies = new Set();
  for (const post of Array.isArray(posts) ? posts : []) {
    const text = String(post?.text || ''), at = stamp(post?.at);
    if (!text || !post.verifiedBy || !Number.isFinite(at) || at > nowMs + 60_000 || nowMs - at > 24 * HOUR) continue;
    const author = String(post.author || '').toLowerCase();
    let matchKind = null;
    if (caIn(text, chain, ca)) matchKind = 'ca';
    else if ((REPUTABLE_NARRATIVE_AUTHORS[author] || []).includes(chain) && names.some(n => narrativeNameMatch(text, n))) matchKind = 'ticker';
    if (!matchKind) continue;
    const body = text.replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (bodies.has(body)) continue; // scrape duplicate / retweet copy
    bodies.add(body);
    out.push({ sourceKind: 'authenticated_social', sourceAuthenticated: true, matchKind, reputableAuthor: !!REPUTABLE_NARRATIVE_AUTHORS[author],
      chain, tokenAddress: ca, sourceUrl: post.url, sourceId: String(post.id || ''), sourceAt: new Date(at).toISOString(),
      sourceText: text, authorKey: `x-id:${post.userId || author}`, authorLabel: `@${post.author}`, verifiedBy: post.verifiedBy,
      tokenSymbol: symbol || null, tokenName: name || null });
  }
  return out.sort((a, b) => stamp(b.sourceAt) - stamp(a.sourceAt)).slice(0, 8);
}
