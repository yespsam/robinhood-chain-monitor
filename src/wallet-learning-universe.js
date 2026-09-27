import { gmgnFlowAddress, gmgnFlowTags } from './gmgn-flow-signal.js';
import { selectLearningTeachers, learningWalletRole } from './wallet-learning.js';
import { validProfitLeaderboard } from './profit-leaderboard.js';

export const LEARNING_CAPACITY = Object.freeze({ candidates: 500, deepWallets: 80, rowsPerWallet: 2000, statsBatch: 10 });
export const LEARNING_CHAINS = Object.freeze(['robinhood', 'sol', 'bsc', 'base', 'eth']);
const negative = /wash|arbitrag|sandwich|(?:^|_)mev|router|exchange|contract/i;
const relevant = tags => tags.some(t => ['smart_degen', 'smart_money', 'smartmoney', 'fomo'].includes(t));
const stamp = value => Date.parse(value || '') || 0;

export function mergeLearningProfiles(chain, wallet, ...sources) {
  const result = {};
  for (const source of sources) for (const period of ['7d', '30d']) {
    const p = source?.[period];
    if (p?.chain !== chain || p.wallet !== wallet || p.period !== period || !stamp(p.checkedAt)) continue;
    if (!result[period] || stamp(p.checkedAt) > stamp(result[period].checkedAt)) result[period] = p;
  }
  return result;
}

export const walletResearchRole = learningWalletRole;

export function balancedLearningSelection(values, limit, nowMs) {
  const priority = w => ({ teacher: 0, comparison: 1, unverified: 2, excluded: 3 })[walletResearchRole(w, nowMs)];
  const lists = LEARNING_CHAINS.map(chain => values.filter(w => w.chain === chain).sort((a, b) => priority(a) - priority(b)
    || Number(!!b.leaderboard?.researchEligible) - Number(!!a.leaderboard?.researchEligible)
    || Number(b.tags?.includes('fomo')) - Number(a.tags?.includes('fomo')) || (b.lastObservedAt || 0) - (a.lastObservedAt || 0) || a.key.localeCompare(b.key)));
  const result = [];
  while (result.length < limit && lists.some(list => list.length)) for (const list of lists) { if (list.length && result.length < limit) result.push(list.shift()); }
  return result;
}

// Discovery reuses the public feeds already collected by the monitor. The
// research pool is deliberately broader than the strict profitable teachers.
export function discoverLearningUniverse({ flow = {}, fomo = {}, leaderboard = null, previous = {}, wallets = {}, nowMs = Date.now() } = {}) {
  const found = new Map();
  const rankings = new Map((validProfitLeaderboard(leaderboard) ? leaderboard.entries : []).map(w => [w.key, w]));
  const add = (chain, wallet, tags, profile, observedAt, source, ranking = null) => {
    if (gmgnFlowAddress(chain, wallet) !== wallet || !Number.isFinite(observedAt) || observedAt > nowMs + 30000 || observedAt < nowMs - 7 * 86400000) return;
    const key = `${chain}:${wallet}`, old = found.get(key) || previous[key], combined = gmgnFlowTags([...(old?.tags || []), ...gmgnFlowTags(tags), ...(profile?.['7d']?.tags || []), ...(profile?.['30d']?.tags || [])]);
    const provenance = rankings.get(key) || ranking || old?.leaderboard;
    if ((!relevant(combined) && !provenance?.researchEligible) || combined.some(t => negative.test(t))) { found.delete(key); return; }
    found.set(key, { ...old, key, chain, wallet, tags: combined.slice(0, 100), profile: mergeLearningProfiles(chain, wallet, old?.profile, wallets[key]?.profile, profile),
      ...(provenance ? { leaderboard: provenance } : {}),
      firstSeenAt: old?.firstSeenAt || new Date(nowMs).toISOString(), lastObservedAt: Math.max(old?.lastObservedAt || 0, observedAt),
      source: old?.source || source, groups: [combined.some(t => ['smart_degen', 'smart_money', 'smartmoney'].includes(t)) ? 'gmgn_smartmoney' : 'research_observer', ...(combined.includes('fomo') ? ['gmgn_fomo'] : [])], fomoOfficial: false });
  };
  for (const w of Object.values(previous)) add(w.chain, w.wallet, w.tags, w.profile, w.lastObservedAt, w.source);
  for (const w of rankings.values()) {
    add(w.chain, w.wallet, w.tags, {}, w.lastObservedAt, w.source, w);
  }
  for (const [key, profile] of Object.entries(flow.profiles || {})) {
    const [chain, wallet] = key.split(':'), p = profile?.['7d'] || profile?.['30d'];
    add(chain, wallet, [...(profile?.['7d']?.tags || []), ...(profile?.['30d']?.tags || [])], profile, Number(p?.lastTradeAt) * 1000, 'gmgn_profile');
  }
  for (const rows of Object.values(flow.trades || {})) for (const r of rows) add(r.chain, r.wallet, r.tags, flow.profiles?.[`${r.chain}:${r.wallet}`], r.at, 'gmgn_public_feed');
  for (const w of selectLearningTeachers(flow, fomo, nowMs)) add(w.chain, w.wallet, w.tags, w.profile,
    Math.max(...['7d', '30d'].map(period => Number(w.profile?.[period]?.lastTradeAt) * 1000).filter(Number.isFinite)), 'gmgn_qualified_roster');
  // Existing deep records never disappear when discovery capacity is reached.
  for (const w of Object.values(wallets)) add(w.chain, w.wallet, w.tags || w.profile?.['7d']?.tags || [], w.profile,
    Math.max(...['7d', '30d'].map(period => Number(w.profile?.[period]?.lastTradeAt) * 1000).filter(Number.isFinite), stamp(w.firstSeenAt)), 'existing_learning');
  return Object.fromEntries(balancedLearningSelection([...found.values()], LEARNING_CAPACITY.candidates, nowMs).map(w => [w.key, w]));
}
