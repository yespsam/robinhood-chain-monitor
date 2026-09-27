import test from 'node:test';
import assert from 'node:assert/strict';
import { readNarrativeLearningSource, narrativeLearningPermalink } from '../src/paper-narrative-learning-source.js';
const NOW=Date.parse('2026-09-23T06:00:00Z');
const id=String((BigInt(NOW-1000)-1288834974657n)<<22n),url=`https://x.com/example/status/${id}`;
const payload=()=>({author_url:'https://x.com/example',url,
  html:`<blockquote><p>robotaxi orbital starlight autonomous taxi fleet</p><a href="${url}">September 23, 2026</a></blockquote>`});
test('reads only exact public linked posts with bounded body, no redirects and authenticated oEmbed text',async()=>{
  let calls=0;
  const result=await readNarrativeLearningSource(url,{now:()=>NOW,fetchImpl:async(request,options)=>{
    calls++;assert.equal(new URL(request).hostname,'publish.x.com');assert.equal(new URL(request).searchParams.get('url'),url);
    assert.equal(options.redirect,'error');assert.ok(options.signal);assert.deepEqual(options.headers,{Accept:'application/json'});
    return new Response(JSON.stringify(payload()));
  }});
  assert.equal(calls,1);assert.equal(result.status,'ok');assert.equal(result.at,NOW-1000);
  assert.equal(result.sourceVerifiedBy,'official_x_oembed');assert.equal(result.replyQuoteStatus,'unknown');
  assert.equal(result.text,'robotaxi orbital starlight autonomous taxi fleet');
});
test('foreign URLs, profiles, credentials and ports never initiate requests',async()=>{
  for(const target of ['http://127.0.0.1/secret','https://x.com/example','https://x.com.evil.test/example/status/1',
    `https://user:secret@x.com/example/status/${id}`,`https://x.com:444/example/status/${id}`]) {
    assert.equal(narrativeLearningPermalink(target),null);
    let calls=0;const result=await readNarrativeLearningSource(target,{fetchImpl:async()=>{calls++;},now:()=>NOW});
    assert.equal(calls,0);assert.equal(result.status,'unavailable');
  }
});
test('wrong identity, changed canonical URL, oversized body, HTTP failure and future post fail without synthetic text',async()=>{
  const wrong=payload();wrong.author_url='https://x.com/imposter';
  const wrongLink=payload();wrongLink.url=url.replace(id,'1');
  for(const response of [new Response(JSON.stringify(wrong)),new Response(JSON.stringify(wrongLink)),
    new Response('x'.repeat(131073)),new Response('{}',{status:429}),new Response('{}',{headers:{'content-length':'999999'}})]) {
    const r=await readNarrativeLearningSource(url,{now:()=>NOW,fetchImpl:async()=>response});
    assert.equal(r.status,'unavailable');assert.equal(r.text,undefined);
  }
  const r=await readNarrativeLearningSource(url,{now:()=>NOW-2000,fetchImpl:async()=>new Response(JSON.stringify(payload()))});
  assert.equal(r.status,'unavailable');
});
