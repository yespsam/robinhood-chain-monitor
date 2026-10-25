import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KOL_TEACHER_POLICY_VERSION, assessKolLearningTeacher, loadKolTeacherReviews, validKolTeacherSelection } from '../src/kol-learning-teachers.js';
import { NOW, teacher, reviewedTeacherRegistry, reviewedTeacherSelection, address } from './fixtures/wallet-learning.js';

const day = 86400000, iso = n => new Date(n).toISOString();
function setup() {
  const wallet = teacher(1, 'bsc'), reviews = reviewedTeacherRegistry([wallet]);
  return { wallet, reviews, review: reviews.entries[wallet.key] };
}
test('KOL teacher requires explicit audited identity and net performance, not provider tags alone', () => {
  const { wallet, reviews } = setup();
  assert.equal(assessKolLearningTeacher(wallet, reviews, NOW).eligible, true);
  wallet.tags = ['kol']; wallet.is_blue_verified = true;
  assert.equal(assessKolLearningTeacher(wallet, {}, NOW).eligible, false);
  assert.equal(assessKolLearningTeacher(wallet, reviews, NaN).eligible, false);
});

const invalidReviews = {
  'wrong wallet': r => { r.wallet = address(99); },
  'wrong chain': r => { r.chain = 'sol'; },
  'expired review': r => { r.validUntil = iso(NOW); },
  'future review': r => { r.reviewedAt = iso(NOW + 1); },
  'excessive review lifetime': r => { r.validUntil = iso(NOW + day + 1); },
  'missing numeric X identity': r => { delete r.identity.subjectId; },
  'noncanonical identity': r => { r.identity.subjectId = '0100000'; },
  'unreviewed person': r => { r.identity.publicPersonReviewed = false; },
  'missing provider KOL label': r => { r.identity.gmgn.kol = false; },
  'missing X verification': r => { r.identity.gmgn.xVerified = false; },
  'different provider handle': r => { r.identity.gmgn.handle = 'someone_else'; },
  'numeric handle': r => { r.identity.gmgn.handle = 17; },
  'missing public ownership claim': r => { delete r.identity.firstParty; },
  'different ownership wallet': r => { r.identity.firstParty.wallet = address(99); },
  'untrusted binding domain': r => { r.identity.firstParty.url = 'https://example.com/fixturekol1/status/123'; },
  'profile link is not ownership evidence': r => { r.identity.firstParty.url = 'https://x.com/fixturekol1'; },
  'different public claimant': r => { r.identity.firstParty.url = 'https://x.com/other/status/123'; },
  'unsafe evidence reference': r => { r.stability.evidenceRef = 'docs/../secrets.json'; },
  'stale inventory review': r => { r.stability.checkedAt = iso(NOW - day - 1); },
  'overlapping weeks': r => { r.stability.weeks[1].startAt = r.stability.weeks[0].startAt; },
  'rolling windows are not four weeks': r => { r.stability.weeks.pop(); },
  'only two profitable weeks': r => { r.stability.weeks[0].grossRealizedPnlUsd = 0; r.stability.weeks[1].grossRealizedPnlUsd = 0; },
  'negative aggregate net': r => { r.stability.weeks[0].grossRealizedPnlUsd = -1000; },
  'unknown costs': r => { r.stability.weeks[0].costsVerified = false; },
  'string costs': r => { r.stability.weeks[0].costsUsd = '10'; },
  'coverage gap': r => { r.stability.weeks[0].coverageComplete = false; },
  'unmatched inventory': r => { r.stability.weeks[0].inventoryReconciled = false; },
  'insufficient closed positions': r => { r.stability.weeks.forEach(w => { w.closedPositions = 1; }); },
  'overflowed position count': r => { r.stability.weeks.forEach(w => { w.closedPositions = Number.MAX_SAFE_INTEGER; }); },
  'insufficient distinct tokens': r => { r.stability.weeks.forEach(w => { w.tokens = [address(100)]; }); },
  'invalid null token': r => { r.stability.weeks[0].tokens[0] = null; },
  'excessive drawdown': r => { r.stability.maxDrawdownRate = .31; },
  'single-token lucky win concentration': r => { r.stability.largestWinningTokenShare = .51; },
  'transfers not reconciled': r => { r.stability.transfersReconciled = false; },
  'missing floating PnL': r => { r.stability.unrealizedPnlUsd = null; },
  'unrealized losses overwhelm wins': r => { r.stability.openPositionCount = 1; r.stability.unrealizedPnlUsd = -361; },
  'unvalued open positions': r => { delete r.stability.openPositionsValuedAt; },
  'nonzero floating PnL without positions': r => { r.stability.unrealizedPnlUsd = 10; },
  'missing failed example': r => { r.stability.lossExamples = []; },
  'invalid failed transaction': r => { r.stability.lossExamples = ['unknown']; }
};
for (const [name, change] of Object.entries(invalidReviews)) test(`KOL evidence rejects ${name}`, () => {
  const { wallet, reviews, review } = setup(); change(review);
  assert.equal(assessKolLearningTeacher(wallet, reviews, NOW).eligible, false);
});

test('KOL teacher rejects stale/future profiles and excluded behavior without mutating samples', () => {
  for (const change of [w => { w.profile['7d'].checkedAt = iso(NOW - 7200001); },
    w => { w.profile['30d'].checkedAt = iso(NOW + 1); }, w => { w.tags = ['sandwich']; }, w => { w.statsError = 'busy'; }]) {
    const { wallet, reviews } = setup(); change(wallet); const before = structuredClone(wallet);
    assert.equal(assessKolLearningTeacher(wallet, reviews, NOW).eligible, false);
    assert.deepEqual(wallet, before);
  }
});
test('malformed evidence fails closed without exceptions', () => {
  for (const bad of [null, [], 10, 'bad', {}, { identity: null }, { identity: { gmgn: 5 } }]) {
    const { wallet, reviews } = setup(); reviews.entries[wallet.key] = bad;
    assert.equal(assessKolLearningTeacher(wallet, reviews, NOW).eligible, false);
  }
});
test('policy needs three independent, same-chain, unexpired identities with evidence digests', () => {
  const valid = reviewedTeacherSelection('bsc');
  assert.equal(validKolTeacherSelection(valid, 'bsc', NOW), true);
  assert.equal(validKolTeacherSelection(valid, 'sol', NOW), false);
  assert.equal(validKolTeacherSelection(valid, 'bsc', NaN), false);
  for (const change of [s => { s.teachers.pop(); }, s => { s.teachers[1].identityId = s.teachers[0].identityId; },
    s => { s.teachers[1].key = s.teachers[0].key; }, s => { delete s.teachers[0].evidenceDigest; },
    s => { s.teachers[0].validUntil = iso(NOW); }, s => { s.teachers[0].identityId = 'x:0100000'; }]) {
    const s = structuredClone(valid); change(s); assert.equal(validKolTeacherSelection(s, 'bsc', NOW), false);
  }
});
test('bounded local review loader rejects missing, corrupt, oversized and symlink registries', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-review-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'kol-learning-teacher-reviews.json');
  assert.equal(loadKolTeacherReviews(dir).error, 'kol_reviews_pending');
  fs.writeFileSync(file, '{'); assert.equal(loadKolTeacherReviews(dir).error, 'kol_review_read_failed');
  fs.writeFileSync(file, JSON.stringify({ version: KOL_TEACHER_POLICY_VERSION, entries: [] }));
  assert.equal(loadKolTeacherReviews(dir).error, 'kol_review_schema_invalid');
  fs.writeFileSync(file, ' '.repeat(256 * 1024 + 1)); assert.equal(loadKolTeacherReviews(dir).error, 'kol_review_file_invalid');
  fs.unlinkSync(file); fs.writeFileSync(path.join(dir, 'target.json'), '{}'); fs.symlinkSync(path.join(dir, 'target.json'), file);
  assert.equal(loadKolTeacherReviews(dir).error, 'kol_review_file_invalid'); fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify({ version: KOL_TEACHER_POLICY_VERSION, entries: {} }));
  assert.deepEqual(loadKolTeacherReviews(dir).entries, {});
});
