import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicNarrativeSemantics, searchCorroboratedSemantics, setNarrativeLlmClassifier, narrativeSemantics, createNarrativeLlmClassifier } from '../src/paper-narrative-semantic.js';

const row = (a, text, extra = {}) => ({ authorKey: `x-id:${a}`, text, matchKind: 'ca', reputableAuthor: false, ...extra });

test('no key: multi-author CA corroboration upgrades chatter to narrative (search_rules, not llm)', () => {
  setNarrativeLlmClassifier(createNarrativeLlmClassifier({ env: {} }));
  const corpus = [row('a', '这只狗是币安人生社区新梗，大家都在聊'), row('b', 'the dog meme community is huge, cz replied to it'), row('c', '狗狗社区在发推整活')];
  const v = narrativeSemantics(corpus[0].text, { chain: 'bsc', symbol: 'DOG' }, { corpus });
  assert.equal(v.method, 'search_rules'); assert.equal(v.isNarrative, true);
  assert.ok(v.corroboration.independentAuthors >= 2); assert.match(v.note, /不是 LLM/);
});

test('copy-paste shill from many accounts is not corroboration', () => {
  const base = heuristicNarrativeSemantics('moon 100x pump', {});
  const corpus = ['x', 'y', 'z'].map(a => row(a, 'moon 100x pump'));
  const v = searchCorroboratedSemantics(base, corpus);
  assert.equal(v.isNarrative, false); assert.ok(v.corroboration.independentAuthors <= 1);
});

test('any scam/denial post in corpus vetoes', () => {
  const corpus = [row('a', 'cat meme community launch today'), row('b', 'this cat token is fake, not official', { reputableAuthor: true })];
  const v = searchCorroboratedSemantics(heuristicNarrativeSemantics(corpus[0].text), corpus);
  assert.equal(v.scam, true); assert.equal(v.isNarrative, false);
});

test('single anonymous author without event stays non-narrative', () => {
  const corpus = [row('a', '这个猫猫社区还行吧大家看看')];
  const v = searchCorroboratedSemantics(heuristicNarrativeSemantics(corpus[0].text), corpus);
  assert.equal(v.isNarrative, false);
});
