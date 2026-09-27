import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGmgnSocialMonitor,normalizePlatformCall,GMGN_SOCIAL_VERSION} from '../src/gmgn-social-monitor.js';
import {buildPaperNewsWire} from '../src/paper-news-wire.js';
import {renderNewsWire} from '../dashboard/news-wire.js';
import {planHotResearch} from '../src/paper-research-scheduler.js';
const NOW=Date.parse('2026-09-25T08:00:00Z');
const CA='0x1234567890abcdef1234567890abcdef12345678';
const raw=(overrides={})=>({id:'test-call',signal_type:13,token_address:CA,trigger_at:(NOW-10000)/1000,
  data:{chain:'bsc',address:CA,symbol:'TEST',call_details:[{platform_type:'x',account:'test',url:'https://x.com/test'}]},...overrides});
const wireState=(overrides={})=>({version:GMGN_SOCIAL_VERSION,events:[normalizePlatformCall(raw(),'bsc',NOW)],
  chains:{bsc:{status:'healthy',lastSuccessAt:new Date(NOW).toISOString()}},...overrides});

test('platform signals validate chain, CA, time and type; profiles never imply a tweet',()=>{
  const e=normalizePlatformCall(raw(),'bsc',NOW);
  assert.equal(e.tweetText,null);assert.equal(e.sourceAuthenticated,false);assert.equal(e.contacts[0].kind,'profile_only');
  for(const r of [raw({signal_type:12}),raw({token_address:'--evil'}),raw({trigger_at:(NOW+1)/1000}),raw({trigger_at:1}),raw({data:{chain:'sol',address:CA}})])assert.equal(normalizePlatformCall(r,'bsc',NOW),null);
  const spoof=raw();spoof.data.call_details=[{platform_type:'x',account:'test',url:'https://x.com.evil.test/test'},{platform_type:'x',account:'other',url:'https://x.com/test'}];
  assert.deepEqual(normalizePlatformCall(spoof,'bsc',NOW).contacts,[]);
});
test('first-arrival research does not wait for own source or grant narrative evidence',()=>{
  const w=buildPaperNewsWire({gmgn:wireState(),nowMs:NOW});
  assert.equal(w.freshHints,1);assert.equal(w.fullTwitterConnected,false);assert.equal(w.waitForBothSources,false);
  assert.deepEqual(w.seeds,[{chain:'bsc',address:CA,symbol:'TEST',name:''}]);
  assert.equal(w.latest[0].authenticated,false);assert.equal(w.hints[0].researchOnly,true);
  assert.equal(w.dualSourceHints,0);
});
test('old, future, conflicted or unavailable feeds cannot keep renewing urgency',()=>{
  const state=wireState();state.events[0].lastObservedAt=new Date(NOW+180000).toISOString();
  state.chains.bsc.lastSuccessAt=new Date(NOW+180000).toISOString();
  assert.equal(buildPaperNewsWire({gmgn:state,nowMs:NOW+180000}).freshHints,0);
  for(const e of [{...wireState().events[0],conflict:true},{...wireState().events[0],sourceAt:new Date(NOW+1).toISOString()}])
    assert.equal(buildPaperNewsWire({gmgn:wireState({events:[e]}),nowMs:NOW}).freshHints,0);
  assert.equal(buildPaperNewsWire({gmgn:wireState({chains:{}}),nowMs:NOW}).freshHints,0);
});
test('public TG prose without CA stays an angle, never a token match',()=>{
  const event={type:'telegram_news_update',source:{id:'telegram_public_channel'},username:'maxguruai',messageUrl:'https://t.me/maxguruai/123',sourceOccurredAt:new Date(NOW).toISOString(),news:{headline:'机器人项目正式上线',summary:'一个新的公开新闻线索'}};
  const w=buildPaperNewsWire({events:[event,event],nowMs:NOW});
  assert.equal(w.latest.length,1);assert.equal(w.freshHints,0);assert.equal(w.latest[0].authenticated,false);
  const conflict=structuredClone(event);conflict.news.headline='另一个标题';
  assert.equal(buildPaperNewsWire({events:[event,conflict],nowMs:NOW}).latest.length,0);
});
test('news priority expires and never displaces ready setups or known safety failures',()=>{
  const a={input:{token:{chain:'bsc',address:CA},newsResearch:{researchOnly:true,sourceAt:new Date(NOW).toISOString()}},decisions:[{evidence:{}}]};
  const b={input:{token:{chain:'bsc',address:'cold'},flow:{pulse:{recentBuyerCount:1}}},decisions:[{evidence:{}}]};
  assert.equal(planHotResearch([a,b],['bsc'],new Map(),NOW)[0],a);
  assert.equal(planHotResearch([a,b],['bsc'],new Map(),NOW+120001)[0],b);
  b.decisions[0].evidence.opportunityRoutes=[{basis:'ohlcv',signalReady:true}];
  assert.equal(planHotResearch([a,b],['bsc'],new Map(),NOW)[0],b);
  a.decisions[0].evidence.safety={blocked:['unsafe']};
  assert.equal(planHotResearch([a,b],['bsc'],new Map(),NOW)[0],b);
});
test('monitor persists first arrival, coalesces polls, backs off and preserves restart history',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gmgn-social-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW,calls=0,fail=false;
  const client={platformCalls:async chain=>{calls++;if(fail)throw Object.assign(new Error('secret'),{code:'GMGN_RATE_LIMITED',retryAt:new Date(now+300000).toISOString()});return chain==='bsc'?[raw()]:[];},stop:async()=>{}};
  const m=createGmgnSocialMonitor({dataDir,client,now:()=>now});
  await Promise.all([m.pollOnce(),m.pollOnce()]);assert.equal(calls,1);
  await m.pollOnce();const first=m.snapshot().events[0].firstObservedAt;await m.stop();
  now+=10000;const restarted=createGmgnSocialMonitor({dataDir,client,now:()=>now});
  await restarted.pollOnce();await restarted.pollOnce();assert.equal(restarted.snapshot().events[0].firstObservedAt,first);
  now+=10000;fail=true;await restarted.pollOnce();assert.equal(restarted.snapshot().chains.sol.status,'backoff');
  assert.equal(restarted.snapshot().chains.sol.error,'GMGN_RATE_LIMITED');assert.equal(JSON.stringify(restarted.snapshot()).includes('secret'),false);
  const before=calls;await restarted.pollOnce();await restarted.pollOnce();assert.equal(calls,before+1,'sol remains in cooldown');
  await restarted.stop();await restarted.pollOnce();assert.equal(calls,before+1);
});
test('UI labels incomplete coverage and escapes untrusted content',()=>{
  const w=buildPaperNewsWire({gmgn:wireState(),nowMs:NOW});w.latest[0].text='<img src=x onerror=alert(1)>';
  w.latest[0].url='javascript:alert(1)';
  const html=renderNewsWire(w);assert.match(html,/完整推特流尚未接通/);assert.match(html,/&lt;img/);
  assert.doesNotMatch(html,/<img|href="javascript/);assert.match(html,/主页/);
});
