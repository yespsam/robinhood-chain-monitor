import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPaperNarrative } from '../src/paper-strategy-analysis.js';
import { buildPaperNarrativeEvidence } from '../src/paper-strategy-evidence.js';
import { collectSocialNarrativeSources } from '../src/paper-social-narrative.js';
import { heuristicNarrativeSemantics, createNarrativeLlmClassifier, setNarrativeLlmClassifier, narrativeSemantics } from '../src/paper-narrative-semantic.js';
import { paperChaseGate } from '../src/paper-chase-gate.js';
import { sourcedNarrative } from './fixtures/paper-strategy-v2.js';

const NOW = Date.parse('2026-10-31T06:00:00Z'), CA = `0x${'c'.repeat(40)}`;
const token = { chain: 'bsc', address: CA, symbol: 'BUILD', name: 'Build Dog' };
const post = (o = {}) => ({ id: '1', userId: '902926941413453824', author: 'cz_binance', url: 'https://x.com/cz_binance/status/1',
  text: 'Just build. $BUILD is what the BNB community keeps doing every day.', at: NOW - 20 * 60_000, verifiedBy: 'official_x_oembed', ...o });
const evalFor = (posts, t = token) => {
  const narrative = buildPaperNarrativeEvidence({ chain: 'bsc', address: CA, token: t, events: [], socialPosts: posts, nowMs: NOW });
  return assessPaperNarrative({ narrative, chain: 'bsc', address: CA, token: t, nowMs: NOW });
};
setNarrativeLlmClassifier(null);

test('CA-bound Fomo narrative still qualifies', () => {
  const n = sourcedNarrative(NOW, 'bsc', CA);
  assert.equal(assessPaperNarrative({ narrative: n, chain: 'bsc', address: CA, nowMs: NOW }).eligible, true);
});

test('social post containing exact CA is matched by CA', () => {
  const r = evalFor([post({ author: 'someone', text: `New AI agent launched on BNB mainnet today, contract ${CA}` })]);
  assert.equal(r.matchKind, 'ca'); assert.equal(r.eligible, true);
});

test('reputable author naming the ticker becomes eligible narrative and reaches main-book tier', () => {
  const r = evalFor([post()]);
  assert.equal(r.matchKind, 'ticker'); assert.equal(r.eligible, true, r.gaps.join(';'));
  assert.ok(r.evidenceScore >= 50);
  const gate = paperChaseGate({ narrativeAssessment: r }, { chain: 'bsc', costRate: .05 });
  assert.notEqual(gate.tier, 'shadow_only');
});

test('ticker spam from non-reputable author or wrong chain never establishes narrative', () => {
  assert.equal(evalFor([post({ author: 'shill123' })]).eligible, false);
  assert.equal(collectSocialNarrativeSources({ posts: [post({ author: 'shill123' })], chain: 'bsc', address: CA, token, nowMs: NOW }).length, 0);
  assert.equal(collectSocialNarrativeSources({ posts: [post({ author: 'heyibinance' })], chain: 'sol', address: 'So11111111111111111111111111111111111111112', token: { ...token, chain: 'sol' }, nowMs: NOW }).length, 0);
  assert.equal(evalFor([post({ verifiedBy: null })]).eligible, false);
});

test('scam, denial and short slogans are rejected', () => {
  assert.equal(evalFor([post({ text: '$BUILD is a fake scam, not official. Be careful.' })]).eligible, false);
  assert.equal(evalFor([post({ author: 'x', text: `$BUILD moon 100x ${CA}` })]).eligible, false);
  assert.equal(heuristicNarrativeSemantics('moon pump 1000x lfg').isNarrative, false);
  assert.equal(heuristicNarrativeSemantics('LFG 🚀🚀').noise, true);
});

test('duplicate scraped bodies collapse; stale social narrative expires', () => {
  const rows = collectSocialNarrativeSources({ posts: [post(), post({ id: '2', url: 'https://x.com/cz_binance/status/2' })], chain: 'bsc', address: CA, token, nowMs: NOW });
  assert.equal(rows.length, 1);
  assert.equal(evalFor([post({ at: NOW - 13 * 3600_000 })]).eligible, false);
});

test('no narrative stays shadow-only', () => {
  const r = evalFor([]);
  assert.equal(r.eligible, false);
  assert.equal(paperChaseGate({ narrativeAssessment: r }, { chain: 'bsc', costRate: .01 }).tier, 'shadow_only');
});

test('LLM verdict is cached and can veto; missing key reports unavailable', async () => {
  const none = createNarrativeLlmClassifier({ env: {} });
  assert.equal(none.health().status, 'search_rules_no_key'); assert.equal(none.enabled, false);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ isNarrative: false, noise: true, scam: false, themes: [], stage: 'event', score: 5, reason: '纯喊单' }) } }] }) });
  const llm = createNarrativeLlmClassifier({ env: { XAI_API_KEY: 'k' }, fetchImpl });
  setNarrativeLlmClassifier(llm);
  const p = post();
  narrativeSemantics(p.text, token, { reputableAuthor: true, nameMatched: true });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(llm.health().status, 'ok');
  assert.equal(evalFor([p]).eligible, false);
  setNarrativeLlmClassifier(null);
});
