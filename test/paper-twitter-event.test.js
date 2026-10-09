import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildTwitterEventCandidates,historicalTwitterAnchors} from '../src/paper-twitter-event.js';
import {buildPaperNewsWire} from '../src/paper-news-wire.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {renderNewsWire} from '../dashboard/news-wire.js';
import {selectResearchChart} from '../src/paper-research-scheduler.js';
import {createReadonlyMarketClient} from '../src/gmgn-readonly-market.js';

// Offline fixtures only, never copied into the live collector or ledger.
const NOW=Date.parse('2026-09-26T12:00:00Z'),CA=`0x${'a'.repeat(40)}`,OTHER=`0x${'b'.repeat(40)}`,iso=n=>new Date(n).toISOString();
const doc=(id='2',at=NOW-10000,text='e/acc proceeds will fund research')=>({id:`https://x.com/beffjezos/status/${id}`,
  url:`https://x.com/beffjezos/status/${id}`,text,at,observedAt:NOW,author:'beffjezos',authorId:'1556550048862928898',
  verifiedBy:'official_x_oembed',isReply:false,isQuote:false,authenticated:true,kind:'independent_x_research'});
const anchor=doc('1',NOW-1800000,'We are building effective accelerationism together');
const token={chain:'bsc',address:CA,symbol:'e/acc',name:'Effective accelerationism',price:1,liquidity:60000,volume:10000,
  buyTax:0,sellTax:0,twitterUsername:anchor.url,narrativeTags:['e/acc','AI'],marketStage:'unknown'};
const item=(t=token)=>({token:t,marketStatus:'ok',observedAt:iso(NOW)});
const build=(documents=[anchor,doc()],candidates=[item()])=>buildTwitterEventCandidates({documents,candidates,nowMs:NOW});
const newest=r=>r.reports.find(d=>d.sourceId==='x:2');
const wire=(docs=[anchor,doc()],candidates=[item()])=>buildPaperNewsWire({twitterDocuments:docs,candidates,nowMs:NOW});
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true};
test('an exact project post discovers image/short-text narratives without a name match, but not endorsement',()=>{
  const post=doc('2',NOW-1000,'Look at this 🐶');
  const linked=item({...token,name:'Different dog',symbol:'DOGGO',narrativeTags:[],twitterUsername:post.url});
  const c=newest(build([post],[linked])).candidates[0];
  assert.equal(c.binding,'project_permalink');assert.equal(c.selected,true);
  assert.deepEqual(c.matchedNames,[]);assert.equal(c.authorEndorsement,false);
  assert.equal(wire([post],[linked]).paperSignals[0].source,'twitter_narrative_event');
  assert.equal(newest(build([post],[item({...linked.token,twitterUsername:'https://x.com/beffjezos'})])).candidateCount,0);
  assert.equal(newest(build([post],[{...linked,observedAt:iso(NOW-120001)}])).candidates[0].selected,false);
  const ambiguous=newest(build([post],[linked,item({...linked.token,address:OTHER})]));
  assert.ok(ambiguous.candidates.every(c=>!c.selected));
  assert.equal(wire([{...post,text:'Do not buy, fake token'}],[linked]).paperSignals.length,0);
});
function input(){return {...modes,token,nowMs:NOW,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),requireFastQuote:true,
  compoundingCash:100,monitorSignal:wire().paperSignals[0],flow:{chain:'bsc',address:CA,provider:'gmgn',status:'healthy',fresh:true,complete:true,
    observedAt:iso(NOW),netBuyUsd:600,uniqueBuyerCount:2,smartMoneyCount:2,
    wallets:[1,2].map(n=>({wallet:`0x${String(n).repeat(40)}`,buyUsd:300,sellUsd:0,netBuyUsd:300,tags:['smart_money'],lastBuyAt:NOW-1000}))},
  quoteHistory:[{...token,price:.99,status:'ok',observedAt:iso(NOW-4000)},{...token,status:'ok',observedAt:iso(NOW)}]};}

test('event -> concepts -> names/tags -> historical project CA, without inventing a celebrity claim',()=>{
  const r=newest(build()),c=r.candidates[0];
  assert.equal(c.selected,true);assert.equal(c.binding,'historical_topic_permalink');assert.equal(c.anchor.url,anchor.url);
  assert.deepEqual(c.matchedNames,['e/acc']);assert.deepEqual(c.matchedTags,['e/acc']);assert.deepEqual(c.matchedConcepts,['eacc']);
  assert.equal(c.authorEndorsement,false);assert.match(c.event.status,/计划/);assert.match(c.event.claim,/须另行核实/);
  const s=wire().paperSignals[0];assert.equal(s.source,'twitter_narrative_event');assert.equal(s.sourceAt,iso(NOW-10000));
  assert.equal(s.paperOnly,true);
  assert.equal(wire([{...anchor,at:NOW-6*86400000},doc()]).paperSignals[0].narrativeCandidate.binding,'historical_topic_permalink','up to seven days of authenticated original text can anchor current research');
});
test('names, specific tags and Chinese short names discover candidates, but never authenticate a CA',()=>{
  const unlinked={...token,twitterUsername:''};assert.equal(newest(build(undefined,[item(unlinked)])).candidates[0].selected,false);
  const tagged={...unlinked,symbol:'Other',name:'Other',narrativeTags:['e/acc']};
  assert.equal(newest(build(undefined,[item(tagged)])).candidates[0].binding,'name_tag_only');
  const generic={...tagged,narrativeTags:['AI']};assert.equal(newest(build(undefined,[item(generic)])).candidateCount,0);
  const chinese={...unlinked,name:'月饼',symbol:'Mooncake'};
  assert.equal(newest(build([doc('2',NOW-1000,'中秋 月饼!')],[item(chinese)])).candidateCount,1);
  assert.equal(newest(build([doc('2',NOW-1000,'unpaid funding')],[item({...unlinked,name:'Paid',symbol:'PAID'})])).candidateCount,0,'short symbols need word boundaries');
});
test('previously verified learning text anchors a new event without promoting old learning cases to fresh catalysts',()=>{
  const episodes=[{chain:'bsc',address:CA,at:NOW-1000000,narratives:[{...anchor,binding:'provider_permalink',associatedAt:NOW-20000}]}];
  const anchorDocuments=historicalTwitterAnchors(episodes,NOW);
  const r=buildTwitterEventCandidates({documents:[doc()],anchorDocuments,candidates:[item()],nowMs:NOW});
  assert.equal(r.reports.length,1);assert.equal(r.reports[0].candidates[0].binding,'historical_topic_permalink');
  assert.equal(r.reports[0].candidates[0].selected,true);
  assert.equal(historicalTwitterAnchors([{...episodes[0],narratives:[{...episodes[0].narratives[0],associatedAt:NOW+1}]}],NOW).length,0);
  const conflict=buildTwitterEventCandidates({documents:[anchor,doc()],anchorDocuments:[{...anchorDocuments[0],text:'conflicting e/acc text'}],candidates:[item()],nowMs:NOW});
  assert.equal(newest(conflict).candidates[0].selected,false);
});
test('homonyms, different author, stale market and old/repeated/negative events cannot become a paper signal',()=>{
  const ambiguous=newest(build(undefined,[item(),item({...token,address:OTHER})]));
  assert.ok(ambiguous.candidates.every(c=>!c.selected&&c.blocks.some(x=>x.includes('多个 CA'))));
  assert.equal(newest(build([{...anchor,author:'different'},doc()])).candidates[0].binding,'name_tag_only');
  assert.equal(newest(build(undefined,[{...item(),observedAt:iso(NOW-120001)}])).candidates[0].selected,false);
  assert.equal(newest(build([doc('2',NOW-3600001)])).candidates[0].selected,false);
  const repeated=newest(build([doc('1',NOW-20000),doc()]));assert.equal(repeated.repeated,true);assert.equal(repeated.candidates[0].selected,false);
  assert.equal(wire([anchor,doc('2',NOW-1000,'I am not affiliated with any token')]).paperSignals.length,0,'new denial also invalidates an older positive event');
  for(const changed of [{authorId:'bad'},{verifiedBy:'fxtwitter'},{isReply:true},{isQuote:true},{observedAt:NOW+1},{url:'https://x.com.evil.test/beffjezos/status/2'}])
    assert.equal(wire([{...doc(),...changed}]).paperSignals.length,0);
  assert.equal(buildPaperNewsWire({events:[{independentDocument:doc()}],candidates:[item()],nowMs:NOW}).paperSignals.length,0,'event files cannot bypass independent-source validation');
});
test('complete event pipeline reaches an isolated paper fill; bad quotes, flow and >6% tax still fail',()=>{
  const i=input(),row=evaluatePaperStrategies(i)[0];assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.match(row.entryLogic,/推特事件驱动/);assert.equal(row.evidence.recoveryCheck.exitObservable,true);
  const a=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,evaluations:[row],nowMs:NOW});
  assert.equal(a.trades.length,1);assert.equal(a.cash,90);assert.equal(validatePaperStrategyAccount(a),true);
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
  for(const mutate of [i=>i.flow={},i=>i.quoteHistory.splice(0,1),i=>i.token.buyTax=.061,
    i=>i.monitorSignal.narrativeCandidate.address=OTHER,i=>i.monitorSignal.narrativeCandidate.authorEndorsement=true]){
    const bad=structuredClone(i);mutate(bad);assert.notEqual(evaluatePaperStrategies(bad)[0].decision,'可模拟',mutate.toString());
  }
});
test('runtime consumes independent Twitter documents as entry candidates, not only narrative display',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'twitter-entry-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const snapshot={status:'ok',observedAt:iso(NOW),tokens:[token]};
  const runtime=createPaperStrategyRuntime({...modes,fixedEntryUsd:10,dataDir,chain:'bsc',chains:['bsc'],now:()=>NOW,evidenceLoader:()=>({}),
    market:{trending:async()=>snapshot,trenches:async()=>snapshot,kline:async()=>({status:'unavailable',candles:[]}),quote:async()=>({status:'unavailable'})},
    twitterNarrativeSnapshot:()=>({documents:[anchor,doc()]})});
  try {await runtime.runOnce();const s=runtime.snapshot();
    assert.ok(s.newsWire.unconsumedPaperSignals>0);assert.equal(s.newsWire.twitterEvents.reports[0].candidates[0].selected,true);
    assert.ok(s.evaluations.some(r=>r.evidence.opportunity?.event?.source==='twitter_narrative_event'));
    assert.equal(s.account.trades.length,0,'no fabricated flow or price confirmation');
    const html=renderNewsWire(s.newsWire);assert.match(html,/推特事件 → 叙事 → CA/);assert.match(html,/恢复期监控事件需要/);
  }finally{await runtime.stop();}
});
test('shadow chart backlog leaves main candidates three of four slots, and main exits always win',()=>{
  const c={input:{token},decisions:[]},held={chain:'bsc',address:OTHER,holdingTier:'comparison',requiresStructureChart:true};
  const params={holdings:[held],hot:[c],broad:[c],charts:new Map(),nowMs:NOW,chains:['bsc']};
  assert.deepEqual([0,1,2,3].map(dispatch=>selectResearchChart({...params,dispatch}).purpose),['candidate','candidate','candidate','comparison']);
  assert.equal(selectResearchChart({...params,dispatch:3,focus:token}).purpose,'candidate');
  assert.equal(selectResearchChart({...params,dispatch:0,holdings:[{...held,holdingTier:'main'}]}).purpose,'exit');
});
test('documented nested project links and string tags survive token normalization without assuming meaning',async()=>{
  const client=createReadonlyMarketClient({now:()=>NOW,runner:async args=>JSON.stringify({data:args[1]==='info'
    ?{address:CA,price:{price:1},link:{twitter_username:anchor.url,website:'https://example.test'},tags:['e/acc',{name:'unverified'}]}
    :{address:CA,buy_tax:0,sell_tax:0}})});
  const result=await client.details({chain:'bsc',address:CA});assert.equal(result.token.twitterUsername,anchor.url);
  assert.equal(result.token.website,'https://example.test');assert.deepEqual(result.token.narrativeTags,['e/acc']);
});
