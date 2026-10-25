import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gmgnFlowAddress, qualifiesGmgnFlowWallet } from './gmgn-flow-signal.js';

export const KOL_TEACHER_POLICY_VERSION = 'verified_kol_stability_v1';
const DAY = 86400_000;
export const KOL_TEACHER_MINIMUMS = Object.freeze({ weeks: 4, profitableWeeks: 3, closedPositions: 30,
  tokens: 10, maxDrawdownRate: .3, largestWinningTokenShare: .5, reviewTtlMs: DAY });
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const stamp = x => typeof x === 'string' ? Date.parse(x) : NaN;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const safeText = (x, max = 128) => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\x00-\x1f]/.test(x);
const hashOk = (chain, x) => typeof x === 'string' && (chain === 'sol'
  ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(x) : /^0x[\da-f]{64}$/.test(x));
const evidenceRef = x => typeof x === 'string' && /^docs\/[A-Za-z0-9_./-]+\.(?:json|md)$/.test(x)
  && !x.split('/').some(part => !part || part === '..' || part === '.');
const recent = (value, nowMs, ttl, ceiling = nowMs) => Number.isFinite(stamp(value))
  && stamp(value) <= ceiling && stamp(value) >= nowMs - ttl;
const sameIdentity = (x, w) => x?.chain === w.chain && x.wallet === w.wallet;
const excluded = /wash|arbitrag|sandwich|(?:^|_)mev|router|exchange|contract|bundler|rat_trader|(?:^|_)dev(?:$|_)/i;

function firstPartyUrl(url, handle) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['x.com', 'twitter.com'].includes(u.hostname)
      && !u.username && !u.password && !u.port && !u.search && !u.hash
      && new RegExp(`^/${handle}/status/[0-9]+/?$`, 'i').test(u.pathname);
  } catch { return false; }
}

// This is a local evidence-review register, NOT a provider response. A reviewer
// must verify and archive the public sources before adding an entry. Labels and
// signatures of data structure alone never establish a human's identity.
export function loadKolTeacherReviews(dataDir) {
  const empty = error => ({ version: KOL_TEACHER_POLICY_VERSION, entries: {}, ...(error ? { error } : {}) });
  try {
    const file = path.join(dataDir, 'kol-learning-teacher-reviews.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return empty('kol_review_file_invalid');
    const raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 256 * 1024) return empty('kol_review_file_invalid');
    const value = JSON.parse(raw);
    if (value?.version !== KOL_TEACHER_POLICY_VERSION || !plain(value.entries) || Object.keys(value.entries).length > 100)
      return empty('kol_review_schema_invalid');
    return value;
  } catch (e) { return empty(e.code === 'ENOENT' ? 'kol_reviews_pending' : 'kol_review_read_failed'); }
}

export function assessKolLearningTeacher(w, reviews, nowMs = Date.now()) {
  const reasons = [], out = { version: KOL_TEACHER_POLICY_VERSION, eligible: false, status: 'pending_evidence', reasons };
  if (!Number.isFinite(nowMs)) { reasons.push('review_clock_invalid'); return out; }
  if (!plain(w) || !['bsc', 'sol', 'base', 'eth', 'robinhood'].includes(w.chain) || typeof w.wallet !== 'string'
    || gmgnFlowAddress(w.chain, w.wallet) !== w.wallet || w.key !== `${w.chain}:${w.wallet}`) {
    reasons.push('wallet_identity_invalid'); return out;
  }
  if (w.statsError || !qualifiesGmgnFlowWallet(w.profile, w.chain, w.wallet, nowMs)
    || ['7d', '30d'].some(p => !recent(w.profile?.[p]?.checkedAt, nowMs, 2 * 3600_000))) reasons.push('fresh_dual_profit_profile_required');
  const tags = [w.tags, w.profile?.['7d']?.tags, w.profile?.['30d']?.tags].flatMap(x => Array.isArray(x) ? x : []);
  if (tags.some(t => typeof t === 'string' && excluded.test(t))) reasons.push('excluded_wallet_behavior');
  const review = reviews?.version === KOL_TEACHER_POLICY_VERSION && !reviews.error && plain(reviews.entries)
    ? reviews.entries[w.key] : null;
  if (!plain(review)) { reasons.push('review_missing'); return out; }
  const reviewed = stamp(review.reviewedAt), until = stamp(review.validUntil);
  if (review.version !== KOL_TEACHER_POLICY_VERSION || !sameIdentity(review, w) || !safeText(review.reviewId)
    || !recent(review.reviewedAt, nowMs, DAY) || !Number.isFinite(until) || until <= nowMs || until <= reviewed || until > reviewed + DAY)
    reasons.push('review_identity_or_expiry_invalid');

  const identity = review.identity, gmgn = identity?.gmgn, claim = identity?.firstParty;
  const handle = identity?.handle;
  if (!plain(identity) || typeof identity.subjectId !== 'string' || !/^[1-9][0-9]{0,24}$/.test(identity.subjectId)
    || typeof handle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || identity.publicPersonReviewed !== true
    || !sameIdentity(gmgn, w) || gmgn.source !== 'gmgn_portfolio_stats' || typeof gmgn.handle !== 'string' || gmgn.handle.toLowerCase() !== handle.toLowerCase()
    || gmgn.kol !== true || gmgn.xVerified !== true || !recent(gmgn.checkedAt, nowMs, 30 * DAY, reviewed) || !evidenceRef(gmgn.evidenceRef)
    || !sameIdentity(claim, w) || typeof claim.handle !== 'string' || claim.handle.toLowerCase() !== handle.toLowerCase() || claim.claim !== 'wallet_ownership'
    || !firstPartyUrl(claim.url, handle) || !recent(claim.checkedAt, nowMs, 30 * DAY, reviewed) || !evidenceRef(claim.evidenceRef))
    reasons.push('verified_public_kol_binding_required');

  const s = review.stability;
  if (!plain(s) || s.source !== 'audited_public_trade_inventory' || !evidenceRef(s.evidenceRef)
    || !recent(s.checkedAt, nowMs, DAY, reviewed) || !Array.isArray(s.weeks) || s.weeks.length !== 4) {
    reasons.push('nonoverlapping_net_performance_required');
  } else {
    const tokens = new Set(); let priorEnd, profitableWeeks = 0, net = 0, positions = 0, valid = true;
    for (const week of s.weeks) {
      if (!plain(week)) { valid = false; break; }
      const start = stamp(week.startAt), end = stamp(week.endAt);
      if (!Number.isFinite(start) || start <= 0 || end - start !== 7 * DAY || end > reviewed || end > stamp(s.checkedAt)
        || (priorEnd !== undefined && start !== priorEnd) || !finite(week.grossRealizedPnlUsd)
        || !finite(week.costsUsd) || week.costsUsd < 0 || !integer(week.closedPositions) || week.closedPositions < 1
        || week.coverageComplete !== true || week.inventoryReconciled !== true || week.costsVerified !== true
        || !Array.isArray(week.tokens) || !week.tokens.length || week.tokens.length > 2000
        || week.tokens.some(t => typeof t !== 'string' || gmgnFlowAddress(w.chain, t) !== t)) { valid = false; break; }
      priorEnd = end; const weekNet = week.grossRealizedPnlUsd - week.costsUsd;
      net += weekNet; positions += week.closedPositions; profitableWeeks += Number(weekNet > 0);
      week.tokens.forEach(t => tokens.add(t));
    }
    if (!valid || !Number.isFinite(net) || !integer(positions) || priorEnd < nowMs - DAY || profitableWeeks < 3 || net <= 0 || positions < 30 || tokens.size < 10)
      reasons.push('stable_four_week_net_results_required');
    if (!finite(s.maxDrawdownRate) || s.maxDrawdownRate < 0 || s.maxDrawdownRate > .3
      || !finite(s.largestWinningTokenShare) || s.largestWinningTokenShare <= 0 || s.largestWinningTokenShare > .5)
      reasons.push('drawdown_or_profit_concentration_not_qualified');
    if (s.transfersReconciled !== true || !integer(s.openPositionCount) || !finite(s.unrealizedPnlUsd)
      || (s.openPositionCount === 0 && s.unrealizedPnlUsd !== 0)
      || !recent(s.openPositionsValuedAt, nowMs, DAY, reviewed) || net + s.unrealizedPnlUsd <= 0
      || !Array.isArray(s.lossExamples) || !s.lossExamples.length || s.lossExamples.length > 100
      || s.lossExamples.some(h => !hashOk(w.chain, h))) reasons.push('open_risk_costs_and_loss_samples_required');
  }
  if (reasons.length) return out;
  return { ...out, eligible: true, status: 'reviewed_for_research', identityId: `x:${identity.subjectId}`,
    reviewId: review.reviewId, reviewedAt: review.reviewedAt, validUntil: review.validUntil,
    evidenceDigest: createHash('sha256').update(JSON.stringify(review)).digest('hex') };
}

// Admission only: old positions retain their frozen historical policy/exits.
export function validKolTeacherSelection(selection, chain, nowMs = Date.now()) {
  if (!Number.isFinite(nowMs) || !['bsc', 'sol', 'base', 'eth', 'robinhood'].includes(chain)
    || selection?.version !== KOL_TEACHER_POLICY_VERSION || !Array.isArray(selection.teachers)
    || selection.teachers.length < 3 || selection.teachers.length > 80) return false;
  const ids = new Set(), wallets = new Set();
  for (const t of selection.teachers) {
    if (!plain(t) || typeof t.key !== 'string') return false;
    const [c, wallet, extra] = t.key.split(':');
    if (extra !== undefined || c !== chain || gmgnFlowAddress(c, wallet) !== wallet || wallets.has(t.key)
      || typeof t.identityId !== 'string' || !/^x:[1-9][0-9]{0,24}$/.test(t.identityId) || ids.has(t.identityId)
      || !safeText(t.reviewId) || !recent(t.reviewedAt, nowMs, DAY) || stamp(t.validUntil) <= nowMs
      || !Number.isFinite(stamp(t.validUntil)) || stamp(t.validUntil) <= stamp(t.reviewedAt)
      || stamp(t.validUntil) > stamp(t.reviewedAt) + DAY || !/^[\da-f]{64}$/.test(t.evidenceDigest || '')) return false;
    ids.add(t.identityId); wallets.add(t.key);
  }
  return true;
}
