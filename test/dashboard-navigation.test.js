import test from 'node:test';
import assert from 'node:assert/strict';
import { revealHashSection } from '../dashboard/navigation.js';

test('hash navigation reveals a section and containing details without opening unrelated sections', () => {
  const outer={tagName:'DETAILS',open:false}, target={tagName:'DETAILS',open:false,parentElement:outer};
  const unrelated={tagName:'DETAILS',open:false};
  const document={getElementById:id=>id==='exitComparison'?target:null};
  assert.equal(revealHashSection(document,'#exitComparison'),true);
  assert.equal(target.open,true);assert.equal(outer.open,true);assert.equal(unrelated.open,false);
  assert.equal(revealHashSection(document,'#%E0%A4%A'),false);
  assert.equal(revealHashSection(document,'#missing'),false);
  assert.equal(revealHashSection(document,''),false);
});
