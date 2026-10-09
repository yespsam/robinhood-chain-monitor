import { createBoundedTextMemo } from './bounded-text-memo.js';
// Lexical discovery only: even an exact name/cashtag is not a CA or endorsement.
const ordinary = new Set(['this','that','these','those','test','testing','the','and','with','from','have','has','you','your','they','their','our','are','was','will','just','more','new','now','today','tomorrow','good','great','one','all','can','could','would','should','first','last','here','there']);
const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/moon\s*cakes?|月饼|中秋(?:快乐|节)?/gu,'mooncake');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export const normalizeNarrativeText=body=>normalize(body).replace(/https?:\/\/\S+/gu,'');
export function compileNarrativeName(name) {
  const term=normalize(name).trim();
  if(!term || term.length>120)return null;
  if(ordinary.has(term))return new RegExp(`(?<![\\p{L}\\p{N}])[$#]${escape(term)}(?![\\p{L}\\p{N}])`,'u');
  if(/\p{Script=Han}/u.test(term))return term.length>=2 ? new RegExp(escape(term),'u'):null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`,'u');
}
const textMemo = createBoundedTextMemo(normalizeNarrativeText, { maxEntries: 512, maxLength: 8000 });
const nameMemo = createBoundedTextMemo(compileNarrativeName, { maxEntries: 512, maxLength: 256 });
export function narrativeNameMatch(body, name) {
  // Key by complete content, not URL/name identity. RegExp has no g/y state and
  // stays private; compileNarrativeName still returns a fresh public RegExp.
  return nameMemo.get(name)?.test(textMemo.get(body))||false;
}
