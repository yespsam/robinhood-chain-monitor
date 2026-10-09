import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceNarrativeAcademy,validNarrativeAcademy} from '../src/paper-narrative-academy.js';
import {narrativeNameMatch} from '../src/narrative-name-match.js';
const NOW=Date.parse('2026-09-28T06:00:00Z'),DAY=86400000,CA=`0x${'a'.repeat(40)}`,OTHER=`0x${'b'.repeat(40)}`;
const doc=(extra={})=>({url:'https://x.com/example/status/100',at:NOW-1000,text:'My Mooncake cat mascot',author:'example',authenticated:true,...extra});
const candidate=(extra={},at=NOW)=>({token:{chain:'bsc',address:CA,symbol:'MOONCAKE',name:'Mooncake',price:1,marketCap:5000,...extra},marketStatus:'ok',observedAt:new Date(at).toISOString()});
const run=(prior=null,args={})=>advanceNarrativeAcademy(prior,{documents:[doc()],candidates:[candidate()],nowMs:NOW,...args});

test('ordinary words and URL/substring accidents are not narrative matches; explicit cashtags remain hypotheses',()=>{
  for(const [body,term] of [['This is a test','THIS'],['This is a test','TEST'],['starting again','ART'],['https://example.com/Mooncake','Mooncake']])assert.equal(narrativeNameMatch(body,term),false);
  for(const [body,term] of [['I mean $THIS','this'],['Discuss #TEST','test'],['Moon cakes for 中秋','月饼'],['An art meme','ART'],['笑笑牛吉祥物','笑笑牛']])assert.equal(narrativeNameMatch(body,term),true);
  const result=run(null,{documents:[doc({text:'This is a test'})],candidates:[candidate({name:'This',symbol:'TEST'})]});
  assert.equal(result.report.candidateObservations,0);
});
test('events are learned before a surge, not only winners; no CA or price is manufactured',()=>{
  const result=run();assert.equal(result.report.caseCount,1);assert.equal(result.report.candidateObservations,1);
  assert.equal(result.memory.cases[0].candidates[0].binding,'name_tag_hypothesis');
  assert.equal(result.memory.cases[0].candidates[0].authorEndorsement,false);
  assert.equal(result.report.autoTradingChanges,false);assert.equal(result.report.researchOnly,true);
  assert.equal(result.report.curriculum.length,7);assert.equal(result.report.curriculum.find(c=>c.id==='animal_visual').cases,1);
  const none=run(null,{candidates:[]});assert.equal(none.report.caseCount,1);assert.equal(none.report.candidateObservations,0);
  assert.match(none.report.recent[0].gaps.join(' '),/原图.*未.*解析/);
});
test('authentication, timestamp conflicts and future/old sources never become valid cases',()=>{
  for(const d of [doc({authenticated:false}),doc({at:NOW+1}),doc({at:NOW-8*DAY}),doc({url:'javascript:bad'})])assert.equal(run(null,{documents:[d]}).report.caseCount,0);
  const first=run(),again=run(first.memory,{documents:[doc({url:'https://twitter.com/example/status/100?s=20'})],nowMs:NOW+15000});
  assert.equal(again.report.caseCount,1);assert.equal(again.memory.cases[0].firstSeenAt,NOW);
  const conflict=run(first.memory,{documents:[doc({text:'Mooncake is fake'})]});assert.equal(conflict.report.caseCount,0);assert.equal(conflict.report.conflicted,1);
  assert.equal(run(conflict.memory).report.caseCount,0,'conflict remains sticky after original reappears');
  const flagged=run(first.memory,{documents:[],conflictIds:['x:100']});assert.equal(flagged.report.conflicted,1);
});
test('direct CA requires matching chain; competing CAs and cross-chain names remain separate',()=>{
  const r=run(null,{documents:[doc({text:`Mooncake ${CA}`,chain:'bsc'})],candidates:[candidate(),candidate({address:OTHER}),candidate({chain:'eth'})]});
  assert.equal(r.report.candidateObservations,3);assert.equal(r.report.linkedObservations,1);
  const rows=r.memory.cases[0].candidates;assert.equal(rows.find(c=>c.chain==='eth').binding,'name_tag_hypothesis');
  assert.equal(rows.find(c=>c.address===OTHER).binding,'name_tag_hypothesis');
  assert.ok(rows.every(c=>c.ogStatus==='unverified'));assert.equal(r.report.selected,undefined);
});
test('duplicate copy is not a second wave; substantive follow-up is only a candidate, not auto-confirmed',()=>{
  const first=doc({text:`Mooncake ${CA}`,chain:'bsc'}),second=doc({url:'https://x.com/example/status/101',at:NOW-500,text:`Mooncake claimed rewards ${CA}`,chain:'bsc'});
  const r=run(null,{documents:[first,second]});assert.equal(r.report.followupCandidates,1);
  assert.equal(r.report.recent.find(c=>c.id==='x:101').continuation.kind,'followup_candidate');
  const copy=run(null,{documents:[first,{...second,text:first.text,author:'another'}]});
  assert.equal(copy.report.followupCandidates,0);assert.equal(copy.report.recent.find(c=>c.id==='x:101').continuation.kind,'duplicate');
  const different=run(null,{documents:[first,{...second,author:'another'}]});assert.equal(different.report.followupCandidates,0);
  const onlyName=run(null,{documents:[doc(),{...second,text:'Mooncake is back',chain:null}]});assert.equal(onlyName.report.followupCandidates,0);
});
test('account incident and pool concepts are separate hypotheses; not issuer legitimacy or proven mechanism',()=>{
  const r=run(null,{documents:[doc({text:`Account hacked. Stock tokens 币股 底池 Mooncake ${CA}`,chain:'bsc'})]});
  const c=r.report.recent[0];assert.match(c.labels.join(' '),/盗号/);assert.match(c.labels.join(' '),/底池/);
  assert.match(c.gaps.join(' '),/不是正常背书/);assert.match(c.gaps.join(' '),/独立核验/);
});
test('outcomes use forward same-CA fresh prices, keep losses, never source-time/lookahead backfills',()=>{
  const d=doc({at:NOW-DAY}),a=run(null,{documents:[d]}),before=JSON.stringify(a.memory);
  assert.equal(a.memory.cases[0].firstSeenAt,NOW);assert.deepEqual(a.memory.cases[0].candidates[0].outcomes,{});
  const five=run(a.memory,{documents:[d],nowMs:NOW+300000,candidates:[candidate({price:.5},NOW+300000)]});
  const outcome=five.memory.cases[0].candidates[0].outcomes['5m'];assert.equal(outcome.returnRate,-.5);
  assert.equal(five.report.outcomes['5m'].losses,1);assert.equal(JSON.stringify(a.memory),before,'input not mutated');
  const hour=run(five.memory,{documents:[d],nowMs:NOW+3600000,candidates:[candidate({price:2},NOW+3600000)]});
  assert.equal(hour.report.outcomes['1h'].gains,1);assert.equal(hour.report.outcomes['5m'].losses,1);
  const day=run(hour.memory,{documents:[d],nowMs:NOW+DAY,candidates:[candidate({price:4},NOW+DAY)]});
  assert.equal(day.report.outcomes['24h'].gains,1);assert.equal(validNarrativeAcademy(day.memory),true);
  const missed=run(a.memory,{documents:[d],nowMs:NOW+600000,candidates:[candidate({price:20},NOW+600000)]});
  assert.equal(missed.report.outcomes['5m'].missing,1);assert.equal(missed.report.outcomes['5m'].observed,0);
});
test('stale/future/wrong-chain prices cannot fill an observation window, restart preserves cohort',()=>{
  const initial=run();
  for(const input of [candidate({price:20},NOW),candidate({price:20},NOW+300001),candidate({chain:'eth',price:20},NOW+300000)]){
    const next=run(JSON.parse(JSON.stringify(initial.memory)),{nowMs:NOW+300000,candidates:[input]});
    assert.equal(next.memory.cases[0].candidates.find(c=>c.chain==='bsc').outcomes['5m'],undefined);
  }
  const noPrice=run(null,{candidates:[candidate({price:0})]});assert.equal(noPrice.memory.cases[0].candidates[0].baseline,null);
  const recover=run(noPrice.memory,{nowMs:NOW+600000,candidates:[candidate({price:2},NOW+600000)]});
  assert.equal(recover.memory.cases[0].candidates[0].baseline.sampledAt,NOW+600000);
  assert.deepEqual(recover.memory.cases[0].candidates[0].outcomes,{});
});
test('corrupt memory stops learning rather than resetting, and history bounds disclose truncation',()=>{
  assert.throws(()=>run({version:'broken'}),/异常/);
  const broken=run().memory;broken.cases[0].candidates=[null];assert.equal(validNarrativeAcademy(broken),false);
  assert.throws(()=>run(broken),/异常/);
  let state=null;
  for(let batch=0;batch<3;batch++)state=run(state?.memory,{documents:Array.from({length:200},(_,i)=>doc({url:`https://x.com/example/status/${1000+batch*200+i}`})),candidates:[]});
  assert.equal(state.memory.cases.length,400);assert.equal(state.report.retention.capacitySkippedThisPass,200);
  const many=run(null,{candidates:Array.from({length:20},(_,i)=>candidate({address:`0x${(i+1).toString(16).padStart(40,'0')}`}))});
  assert.equal(many.memory.cases[0].candidates.length,12);assert.equal(many.report.recent[0].totalMatched,20);
  const expired=run(state.memory,{nowMs:NOW+8*DAY,documents:[],candidates:[]});assert.equal(expired.report.caseCount,0);
});
