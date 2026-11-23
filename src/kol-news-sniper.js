// KOL news-trading lane (CZ / 何一). PAPER ONLY: this module never signs,
// never routes to live-gmgn-trader, and only writes its own paper ledger.
// Unlike the generic narrative lane, "binance" is NOT a generic word here:
// the lane exists precisely to trade Binance-family names after CZ/何一 posts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const KOL_TWEET_SOURCE_TYPE = 'kol_tweet';
export const KOL_NEWS_HANDLES = Object.freeze({
  cz_binance: { id: '902926941413453824', label: 'CZ' },
  heyibinance: { id: '1003840309166366721', label: '何一' },
});
// Dedicated name list for this lane only.
export const KOL_NAME_TERMS = Object.freeze(['cz', '赵长鹏', '币安', 'binance', 'bnb', 'safu', '何一', 'heyi', '一姐', '信任', 'trust', '兄弟', 'brother']);
export const KOL_POLICY = Object.freeze({
  windowMs: 25 * 60_000, sizeUsd: 5, maxPerTweet: 2, maxPerDay: 4, minLiquidityUsd: 3_000,
  smartMinWallets: 2, smartMinUsd5m: 300, smartWindowMs: 5 * 60_000,
  takeProfitMultiple: 1.6, takeProfitMaxMultiple: 2.0, principalSellFraction: 0.55,
  trailFromPeak: 0.35, remainderMaxHoldMs: 30 * 60_000, hardStop: -0.30, softStop: -0.20, softStopNoSellMs: 3 * 60_000,
});

export function kolNewsSniperEnabled(env = process.env) {
  // Default ON for the paper path; set KOL_NEWS_SNIPER_ENABLED=false to disable.
  return String(env.KOL_NEWS_SNIPER_ENABLED ?? 'true').toLowerCase() !== 'false';
}

const lc = (v) => String(v || '').toLowerCase();
// Asset identity = chain + canonical address. Only EVM (0x…) addresses are case-insensitive;
// Solana base58 is case-sensitive and must never be lowercased.
export const normKolChain = (c) => { const s = lc(c || 'bsc'); return s === 'solana' ? 'sol' : s; };
export const canonAddr = (addr) => { const a = String(addr || '').trim(); return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a; };
export const assetKey = (chain, addr) => `${normKolChain(chain)}:${canonAddr(addr)}`;
const sameAsset = (a, b) => assetKey(a.chain, a.address) === assetKey(b.chain, b.address);
const norm = (v) => lc(v).normalize('NFKC').replace(/[\s$#_\-·.]/g, '');

export function nameTermsIn(text) {
  const t = norm(text);
  // Short latin terms need word boundaries (no "czech", "bnbx"); CJK terms are substring matches.
  return KOL_NAME_TERMS.filter((term) => /^[a-z]{2,5}$/.test(term)
    ? new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, 'i').test(lc(text).normalize('NFKC'))
    : t.includes(norm(term)));
}

/** Tweet (incl. quotes/replies) → usable narrative record of source type kol_tweet. */
export function tweetToKolRecord(post) {
  const handle = lc(post?.author);
  const who = Object.entries(KOL_NEWS_HANDLES).find(([h]) => h === handle);
  if (!who || String(post.userId) !== who[1].id || !/^\d{1,25}$/.test(String(post.id)) || !Number.isFinite(post.at)) return null;
  const text = String(post.text || '').slice(0, 4000);
  return Object.freeze({
    sourceType: KOL_TWEET_SOURCE_TYPE, id: `kol_tweet:${handle}:${post.id}`, tweetId: String(post.id), handle,
    label: who[1].label, url: `https://x.com/${post.author}/status/${post.id}`, text, at: post.at,
    observedAt: post.observedAt ?? post.at, isQuote: post.isQuote === true, isReply: post.isReply === true,
    keywords: nameTermsIn(text), verifiedBy: post.verifiedBy || null, simulationOnly: true,
  });
}

/** Does the token name relate to the KOL lane / the tweet? */
export function matchTokenToTweet(token, record) {
  const name = `${token?.symbol || ''} ${token?.name || ''}`;
  const tokenTerms = nameTermsIn(name);
  if (!tokenTerms.length) return { matched: false, tokenTerms };
  const overlap = tokenTerms.filter((t) => record.keywords.includes(t));
  return { matched: true, tokenTerms, overlap, strength: overlap.length ? 'tweet_keyword' : 'lane_name' };
}

export function smartMoneyConfirm(trades, sinceMs, untilMs, policy = KOL_POLICY) {
  const buys = (trades || []).filter((t) => t.side === 'buy' && t.at >= sinceMs && t.at <= untilMs);
  const wallets = new Set(buys.map((t) => lc(t.wallet)));
  let best = 0;
  for (const b of buys) best = Math.max(best, buys.filter((x) => x.at >= b.at && x.at - b.at <= policy.smartWindowMs).reduce((s, x) => s + (x.amountUsd || 0), 0));
  return { wallets: wallets.size, usd5m: Math.round(best), ok: wallets.size >= policy.smartMinWallets || best > policy.smartMinUsd5m, available: Array.isArray(trades) };
}

/**
 * Entry decision for one (tweet, token) pair at time nowMs.
 * token: {address, chain, symbol, createdAt?, liquidityUsd?, trades?[{wallet,side,amountUsd,at}]}
 */
export function evaluateKolEntry({ record, token, nowMs, favorites = [], ledger = { positions: [] }, policy = KOL_POLICY, allowUnknownLiquidity = false }) {
  const reasons = [];
  if (!record || record.sourceType !== KOL_TWEET_SOURCE_TYPE) return { enter: false, reasons: ['not_kol_tweet'] };
  const age = nowMs - record.at;
  if (age < 0 || age > policy.windowMs) reasons.push('outside_25m_window');
  const match = matchTokenToTweet(token, record);
  if (!match.matched) reasons.push('name_not_in_kol_lane');
  const fav = favorites.find((f) => sameAsset(f, token));
  const isNewLaunch = Number.isFinite(token.createdAt) && token.createdAt >= record.at - 60_000 && token.createdAt <= record.at + policy.windowMs;
  const lastActive = fav ? Date.parse(fav.lastActiveAt) : NaN;
  const favReactivated = Boolean(fav) && (token.trades || []).some((t) => t.side === 'buy' && t.at >= record.at && t.at <= nowMs)
    && (!Number.isFinite(lastActive) || lastActive < record.at);
  if (!isNewLaunch && !favReactivated) reasons.push('not_new_launch_or_favorite_reactivation');
  const sm = smartMoneyConfirm(token.trades, Math.max(record.at, token.createdAt || 0), nowMs, policy);
  if (sm.available && !sm.ok) reasons.push('smart_money_unconfirmed');
  if (Number.isFinite(token.liquidityUsd) && token.liquidityUsd < policy.minLiquidityUsd) reasons.push('liquidity_below_3k');
  if (!Number.isFinite(token.liquidityUsd) && !allowUnknownLiquidity) reasons.push('liquidity_unknown');
  const day = new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
  const open = ledger.positions || [];
  // Limits count immutable open history (open + closed), not just currently-open positions.
  const history = [...open, ...(ledger.closed || [])];
  if (open.some((p) => sameAsset(p, token))) reasons.push('already_holding');
  if (history.some((p) => p.tweetId === record.tweetId && sameAsset(p, token))) reasons.push('tweet_token_already_consumed');
  if (history.filter((p) => p.tweetId === record.tweetId).length >= policy.maxPerTweet) reasons.push('max_2_per_tweet');
  if (history.filter((p) => p.day === day).length >= policy.maxPerDay) reasons.push('max_4_per_day');
  return { enter: reasons.length === 0, reasons, match, smartMoney: sm, liquidityUnverified: !Number.isFinite(token.liquidityUsd), trigger: isNewLaunch ? 'new_launch' : favReactivated ? 'favorite_reactivation' : null, day, sizeUsd: policy.sizeUsd };
}

/** Exit decision. position: {entryPrice, peakMultiple, principalTaken, openedAt, principalTakenAt}; price is current. */
export function evaluateKolExit(position, { price, nowMs, lastSellAt = null }, policy = KOL_POLICY) {
  const m = price / position.entryPrice, peak = Math.max(position.peakMultiple || 1, m);
  if (!position.principalTaken) {
    // "出本" = recover the full principal (+2% fee buffer): sell max(policy fraction, 1.02/m), capped at 100%.
    if (m >= policy.takeProfitMultiple) { const fraction = Math.min(1, Math.max(policy.principalSellFraction, 1.02 / m)); return { action: fraction >= 1 ? 'stop_all' : 'sell_principal', reason: fraction >= 1 ? 'principal_needs_full_exit' : undefined, fraction, multiple: m, peak }; }
    if (m - 1 <= policy.hardStop) return { action: 'stop_all', reason: 'hard_stop_-30%', multiple: m, peak };
    const quiet = lastSellAt == null ? nowMs - position.openedAt : nowMs - lastSellAt;
    if (m - 1 <= policy.softStop && quiet >= policy.softStopNoSellMs && nowMs - position.openedAt >= policy.softStopNoSellMs)
      return { action: 'stop_all', reason: 'soft_stop_-20%_no_sell_3m', multiple: m, peak };
    return { action: 'hold', multiple: m, peak };
  }
  if (m <= peak * (1 - policy.trailFromPeak)) return { action: 'sell_rest', reason: 'trail_35%_off_peak', multiple: m, peak };
  if (nowMs - (position.principalTakenAt || position.openedAt) >= policy.remainderMaxHoldMs) return { action: 'sell_rest', reason: 'remainder_30m', multiple: m, peak };
  return { action: 'hold', multiple: m, peak };
}

export async function loadKolFavorites(dataDir) {
  try { const d = JSON.parse(await fs.readFile(path.join(dataDir, 'kol-news-favorites.json'), 'utf8')); return Array.isArray(d.favorites) ? d.favorites : []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

/** Paper-only ledger at data/kol-news-paper-ledger.json. */
export function createKolNewsPaperLedger({ dataDir, now = Date.now }) {
  const file = path.join(dataDir, 'kol-news-paper-ledger.json');
  async function read() { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 'kol_news_paper_v1', mode: 'paper', positions: [], closed: [], decisions: [] }; throw e; } }
  async function write(state) { const tmp = `${file}.${randomUUID()}.tmp`; await fs.writeFile(tmp, JSON.stringify(state, null, 1)); await fs.rename(tmp, file); }
  return {
    read, write,
    async open({ record, token, decision, price }) {
      const s = await read();
      s.positions.push({ address: token.address, chain: token.chain, symbol: token.symbol, tweetId: record.tweetId, handle: record.handle,
        day: decision.day, sizeUsd: decision.sizeUsd, entryPrice: price, peakMultiple: 1, principalTaken: false, openedAt: now(), trigger: decision.trigger, mode: 'paper' });
      s.decisions.push({ at: now(), kind: 'open', address: token.address, tweetId: record.tweetId, trigger: decision.trigger });
      await write(s); return s;
    },
  };
}
