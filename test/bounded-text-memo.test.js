import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedTextMemo } from '../src/bounded-text-memo.js';
import { compileNarrativeName, normalizeNarrativeText, narrativeNameMatch } from '../src/narrative-name-match.js';
import { narrativeTerms } from '../src/paper-narrative-recall.js';

test('text memo is bounded LRU, preserves falsy values and keys by full content', () => {
  const calls = [], memo = createBoundedTextMemo(s => { calls.push(s); return s === 'no' ? null : s.toUpperCase(); }, { maxEntries: 2, maxLength: 8 });
  assert.equal(memo.get('no'), null);
  assert.equal(memo.get('no'), null);
  assert.equal(memo.get('yes'), 'YES');
  memo.get('no'); // Keep no, evict yes.
  memo.get('new');
  memo.get('no');
  memo.get('yes');
  assert.deepEqual(calls, ['no', 'yes', 'new', 'yes']);
  assert.deepEqual(memo.snapshot(), { entries: 2, hits: 3, misses: 4, bypasses: 0, maxEntries: 2, maxLength: 8 });
});

test('oversize and mutable inputs bypass the cache without truncation; failures are not cached', () => {
  let calls = 0;
  const memo = createBoundedTextMemo(x => { calls++; if (x === 'bad') throw new Error('bad'); return String(x); }, { maxEntries: 2, maxLength: 3 });
  const input = { value: 'one', toString() { return this.value; } };
  assert.equal(memo.get(input), 'one'); input.value = 'two'; assert.equal(memo.get(input), 'two');
  assert.equal(memo.get('long text'), 'long text'); memo.get('long text');
  assert.throws(() => memo.get('bad')); assert.throws(() => memo.get('bad'));
  assert.equal(calls, 6); assert.equal(memo.snapshot().entries, 0);
  const disabled = createBoundedTextMemo(() => ++calls, { maxEntries: 0 });
  assert.notEqual(disabled.get('same'), disabled.get('same'));
  for (const options of [{ maxEntries: -1 }, { maxEntries: Infinity }, { maxLength: 1.1 }])
    assert.throws(() => createBoundedTextMemo(x => x, options), TypeError);
});

test('cached matching has identical Unicode, word boundary, alias and URL semantics', () => {
  const names = ['躺赢', '中秋', 'mooncake', 'moon cake', 'foo', 'test', 'new', 'ＡＢＣ', 'a+b', '[dog]', '牛', '', null, false, 123, 'x'.repeat(121)];
  const bodies = ['中秋快乐，月饼来了', 'moon cakes mooncake', 'FOO food foo2', '$test #NEW testing', 'test new',
    'ABC ＡＢＣ', 'a+b [dog]', '牛来了', 'https://example.com/foo https://example.com/躺赢', '躺赢', '', null, 123,
    'z'.repeat(9000) + ' foo'];
  for (let pass = 0; pass < 3; pass++) for (const name of names) for (const body of bodies)
    assert.equal(narrativeNameMatch(body, name), compileNarrativeName(name)?.test(normalizeNarrativeText(body)) || false);
  assert.equal(narrativeNameMatch('same post now says DOG', 'DOG'), true);
  assert.equal(narrativeNameMatch('same post now says CAT', 'DOG'), false);
  const external = compileNarrativeName('DOG'); external.compile('CAT');
  assert.equal(narrativeNameMatch('DOG', 'DOG'), true);
});

test('segmentation cache preserves aliases, excludes URLs and returns independent term arrays', () => {
  const text = '无人驾驶出租车 robot taxi 回购销毁 buyback and burn 人工智能代理 AI agents 永续合约 perpetuals https://example.com/FAKEKEYWORD';
  const first = narrativeTerms(text);
  assert.deepEqual(first, ['robotaxi', 'buybackburn', 'aiagent', 'perpetual']);
  first.push('poison'); first[0] = 'changed';
  assert.deepEqual(narrativeTerms(text), ['robotaxi', 'buybackburn', 'aiagent', 'perpetual']);
  assert.notDeepEqual(narrativeTerms(text + ' rainbow'), narrativeTerms(text));
  assert.deepEqual(narrativeTerms(null), []);
  assert.deepEqual(narrativeTerms('x'.repeat(5000) + ' rainbow'), ['x'.repeat(5000), 'rainbow']);
});
