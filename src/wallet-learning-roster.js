import { LEARNING_CAPACITY, balancedLearningSelection, mergeLearningProfiles, walletResearchRole } from './wallet-learning-universe.js';

export const LEARNING_ARCHIVE_LIMIT = 40;
const stamp = value => Date.parse(value || '') || 0;

// Rotate research seats, not trade authority. Evicted samples/cursors remain
// intact and can be restored; a full archive stops admission, never deletes data.
export function admitLearningWallets(state, nowMs) {
  state.walletArchive ||= {};
  let rotations = 0;
  const pending = new Set((state.statsJob?.wallets || []).map(w => `${state.statsJob.chain}:${w}`));
  const ordered = balancedLearningSelection(Object.values(state.universe || {}), LEARNING_CAPACITY.candidates, nowMs);
  // Update incumbents before selecting victims: an old profile must not cause a
  // currently verified teacher to lose its seat merely due to iteration order.
  const merge = (candidate, prior) => ({ ...prior, ...candidate,
    profile: mergeLearningProfiles(candidate.chain, candidate.wallet, prior?.profile, candidate.profile),
    firstSeenAt: prior?.firstSeenAt || candidate.firstSeenAt || new Date(nowMs).toISOString(),
    rows: prior?.rows || [], pages: prior?.pages || 0, nextCursor: prior?.nextCursor || null, cursors: prior?.cursors || [] });
  for (const candidate of ordered) if (state.wallets[candidate.key]) state.wallets[candidate.key] = merge(candidate, state.wallets[candidate.key]);
  for (const candidate of ordered) {
    if (state.wallets[candidate.key]) continue;
    const restored = state.walletArchive[candidate.key];
    const incoming = merge(candidate, restored);
    if (Object.keys(state.wallets).length >= LEARNING_CAPACITY.deepWallets) {
      if (rotations >= 2 || walletResearchRole(incoming, nowMs) !== 'teacher') continue;
      if (!restored && Object.keys(state.walletArchive).length >= LEARNING_ARCHIVE_LIMIT) continue;
      const victim = Object.values(state.wallets).filter(w => !pending.has(w.key) && walletResearchRole(w, nowMs) !== 'teacher')
        .sort((a, b) => Number(walletResearchRole(b, nowMs) === 'excluded') - Number(walletResearchRole(a, nowMs) === 'excluded')
          || Number(b.chain === incoming.chain) - Number(a.chain === incoming.chain)
          || (a.lastObservedAt || 0) - (b.lastObservedAt || 0) || stamp(a.checkedAt) - stamp(b.checkedAt) || a.key.localeCompare(b.key))[0];
      if (!victim) continue;
      if (restored) delete state.walletArchive[candidate.key];
      state.walletArchive[victim.key] = victim;
      delete state.wallets[victim.key];
      rotations++;
      state.lastRosterRotation = { at: new Date(nowMs).toISOString(), admitted: incoming.key, archived: victim.key,
        reason: '双周期盈利核验通过的钱包进入深采样；旧样本完整归档，不直接跟单' };
    }
    delete state.walletArchive[candidate.key];
    state.wallets[candidate.key] = incoming;
  }
}
