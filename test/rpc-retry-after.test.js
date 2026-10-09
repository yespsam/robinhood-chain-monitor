import test from 'node:test';
import assert from 'node:assert/strict';
import {rpcRetryAfterUntil} from '../src/rpc-retry-after.js';

const NOW=Date.parse('2026-10-08T07:00:00Z');

test('RPC Retry-After respects numeric seconds without a lower floor or upper cutoff',()=>{
  for(const [value,delay] of [['600',600000],['86400',86400000],['45',45000],['1.25',1250],['0.0001',1],['0',0],[0,0],[600,600000],[' 600 ',600000]]) {
    const actual=rpcRetryAfterUntil(value,NOW);
    assert.equal(actual,NOW+delay,String(value));assert.ok(Number.isSafeInteger(actual));
  }
});

test('RPC Retry-After resolves HTTP-date against the supplied clock without shortening its deadline',()=>{
  const future=NOW+600000;
  assert.equal(rpcRetryAfterUntil(new Date(future).toUTCString(),NOW),future);
  assert.equal(rpcRetryAfterUntil('Thursday, 08-Oct-26 07:10:00 GMT',NOW),future);
  assert.equal(rpcRetryAfterUntil('Thu Oct  8 07:10:00 2026',NOW),future);
  assert.equal(rpcRetryAfterUntil(new Date(NOW-1000).toUTCString(),NOW),NOW,'a past valid server deadline has already expired');
  assert.equal(rpcRetryAfterUntil(new Date(NOW).toUTCString(),NOW),NOW);
});

test('only missing, malformed or unrepresentable Retry-After values receive the 30-second fallback',()=>{
  for(const value of [undefined,null,'','   ','no date','-1',-1,'NaN',NaN,'Infinity',Infinity,'1e309','0x10','1e3',{},[],true,'9'.repeat(400),String(Number.MAX_SAFE_INTEGER)]) {
    const actual=rpcRetryAfterUntil(value,NOW);
    assert.equal(actual,NOW+30000,String(value));assert.ok(Number.isSafeInteger(actual));
  }
  for(const now of [NaN,Infinity,undefined,-1,Number.MAX_SAFE_INTEGER])assert.throws(()=>rpcRetryAfterUntil('600',now),TypeError);
});
