import test from 'node:test';
import assert from 'node:assert/strict';
import {createNarrativeResearchIndex,buildNarrativeThesis,narrativeEventFrame,narrativeSourceKey,
  classifyNarrativeCase,narrativeStageReport,attachNarrativeThesis,narrativeDeskReport,NARRATIVE_THESIS_VERSION} from '../src/paper-narrative-thesis.js';
import {renderNarrativeThesis,renderNarrativeDesk} from '../dashboard/narrative-thesis.js';
import {evaluatePaperStrategies,advancePaperStrategyAccount,createPaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {normalizePlatformCall,GMGN_SOCIAL_VERSION} from '../src/gmgn-social-monitor.js';
import {buildPaperNewsWire} from '../src/paper-news-wire.js';
import {monitorSignalId,validMonitorSignal} from '../src/paper-monitor-signal.js';

// Offline fixtures only: never queries a provider or writes a live ledger.
const NOW=Date.parse('2026-09-26T06:00:00Z'),HOUR=3600000,DAY=24*HOUR,CA=`0x${'a'.repeat(40)}`,OTHER=`0x${'b'.repeat(40)}`;
const iso=n=>new Date(n).toISOString(),url=id=>`https://x.com/example/status/${id}`;
const token={chain:'bsc',address:CA,symbol:'Mooncake',name:'Mooncake',price:1,liquidity:60000,volume:10000,buyTax:0,sellTax:0};
const doc=(extra={})=>({id:url('101'),url:url('101'),text:'中秋快乐 eat lots of Moon cakes!',at:NOW-10000,author:'example',authenticated:true,...extra});
const index=(documents=[],episodes=[])=>createNarrativeResearchIndex({documents,episodes,nowMs:NOW});
const thesis=(options={})=>buildNarrativeThesis({token,index:index(),nowMs:NOW,...options});
const flow=()=>({...token,provider:'gmgn',status:'healthy',fresh:true,complete:true,observedAt:iso(NOW),netBuyUsd:600,
  wallets:[1,2].map(n=>({wallet:`0x${String(n).repeat(40)}`,tags:['smart_money'],buyUsd:300,sellUsd:0,netBuyUsd:300,lastBuyAt:NOW-1000}))});

test('event frames distinguish attention, promised delivery and value claims without predictions',()=>{
  assert.equal(narrativeEventFrame(doc().text).kind,'attention_culture');
  const release=narrativeEventFrame('We plan to launch an open-source AI agent next month');
  assert.equal(release.kind,'product_delivery');assert.match(release.claimStatus,/计划/);
  assert.match(release.verification,/代币关系/);
  assert.equal(narrativeEventFrame('Token buyback and fee rewards').kind,'token_value');
  assert.equal(narrativeEventFrame('No token, not affiliated with Mooncake').warning,true);
  assert.equal(narrativeEventFrame('gm').kind,'unclassified');
  assert.match(narrativeEventFrame('').mechanism,/不按币名补故事/);
});

test('explicit CA, community permalink and name-only hypotheses remain distinct, across chains too',()=>{
  const d=doc(),research=index([d]);
  const community=thesis({token:{...token,twitterUsername:'i/status/101'},index:research});
  assert.equal(community.relationship.kind,'community_link');assert.equal(community.authorEndorsement,false);
  assert.equal(community.researchOnly,true);assert.equal(community.demand.status,'unknown');
  assert.equal(thesis({index:research}).relationship.kind,'name_only');
  assert.equal(thesis({token:{...token,symbol:'Elsewhere',name:'Elsewhere',twitterUsername:d.url},index:research}).relationship.kind,'project_link');
  assert.equal(thesis({token:{...token,twitterUsername:'https://x.com.evil.test/example/status/101'},index:research}).relationship.kind,'name_only');
  const direct=index([doc({chain:'bsc',text:`Mooncake launch CA ${CA}`})]);
  assert.equal(thesis({index:direct}).relationship.kind,'direct_ca');
  assert.notEqual(thesis({token:{...token,chain:'base'},index:direct}).relationship.kind,'direct_ca');
  assert.notEqual(thesis({index:index([doc({text:`Mooncake launch CA ${CA}`})])}).relationship.kind,'direct_ca','EVM chain is not guessed');
  assert.equal(narrativeSourceKey('https://twitter.com/example/status/101?s=20'),'x:101');
  assert.equal(narrativeSourceKey('javascript:alert(1)'),null);
});

test('unverified, future, conflicted and too-old sources cannot become current research facts',()=>{
  for(const d of [doc({authenticated:false}),doc({at:NOW+1}),doc({at:NOW-8*DAY})])assert.equal(thesis({index:index([d])}).sources.length,0);
  const conflict=index([doc(),doc({text:'Mooncake is cancelled.'})]);assert.equal(conflict.conflicts,1);
  assert.equal(thesis({index:conflict}).sources.length,0);
  const punctuation=index([doc(),doc({text:doc().text+'?'})]);assert.equal(punctuation.conflicts,1,'questions are not normalized into statements');
});

test('copied posts are not independent propagation or a new substantive catalyst',()=>{
  const research=index([doc(),doc({id:url('102'),url:url('102'),at:NOW-1000,author:'copy'})]);
  const t=thesis({index:research,token:{...token,twitterUsername:url('102')}});
  // The old post must be associated to the same CA before treating a copy as recycled.
  const direct=index([doc({chain:'bsc',text:`Mooncake ${CA}`}),doc({id:url('102'),url:url('102'),chain:'bsc',text:`Mooncake ${CA}`,at:NOW-1000,author:'copy'})]);
  const r=thesis({index:direct});assert.equal(r.catalyst.phase,'repeated');assert.equal(r.propagation.distinctAuthors,1);
  assert.equal(t.catalyst.phase,'repeated');assert.equal(t.propagation.distinctAuthors,1);
  assert.equal(thesis({index:index([doc({at:NOW-2*HOUR})])}).catalyst.phase,'background');
  assert.equal(thesis({index:index([doc({at:NOW-2*DAY})])}).catalyst.phase,'old');
});

test('a fresh feed is not buying: net amounts, tags, event timing and coverage are checked',()=>{
  const base={token:{...token,twitterUsername:url('101')},index:index([doc()])};
  const good=thesis({...base,flow:flow()});assert.equal(good.demand.status,'buying');assert.equal(good.demand.recentNetBuyers,2);
  const changes=[f=>f.netBuyUsd=0,f=>f.wallets=[],f=>f.complete=false,f=>f.address=OTHER,
    f=>f.observedAt=iso(NOW-121000),f=>f.wallets[0].lastBuyAt=NOW-20000,
    f=>f.wallets[0].lastBuyAt=NOW+1,f=>f.wallets.push(f.wallets[0]),f=>f.wallets=[null]];
  for(const change of changes){const f=flow();change(f);assert.notEqual(thesis({...base,flow:f}).demand.status,'buying',String(change));}
  const sell=flow();sell.netBuyUsd=-600;sell.wallets.forEach(w=>{w.buyUsd=0;w.sellUsd=300;w.netBuyUsd=-300;});
  assert.equal(thesis({...base,flow:sell}).demand.status,'selling');
});

test('negative post blocks only linked/direct new entries, never manufactures a sell or approval',()=>{
  const research=index([doc({text:'Mooncake is not affiliated. Do not buy this token.'})]);
  const nameOnly=thesis({index:research});assert.equal(nameOnly.invalidation.blockNewNarrativeEntry,false);
  const linked=thesis({index:research,token:{...token,twitterUsername:url('101')}});
  assert.equal(linked.invalidation.blockNewNarrativeEntry,true);assert.equal(linked.exit,undefined);
  const row={token,decision:'可模拟',reasons:[],evidence:{paperEligible:true}};
  const blocked=attachNarrativeThesis(row,linked);assert.equal(blocked.decision,'观察');assert.equal(blocked.evidence.paperEligible,false);
  assert.equal(row.decision,'可模拟','input is unchanged');
  assert.equal(attachNarrativeThesis({...row,decision:'观察',evidence:{paperEligible:false}},thesis({flow:flow()})).decision,'观察');
});

function episode(extra={}) {return {...token,id:'case',at:NOW-2*DAY,price:1,narratives:[{text:'We launched Mooncake, a community meme',
  url:url('103'),at:NOW-2*DAY-10000,associatedAt:NOW-2*DAY+1000,binding:'provider_permalink',author:'example'}],
  outcomes:{'24h':{status:'observed',at:NOW-DAY,price:.5,returnRate:-.5}},...extra};}

test('learning profiles freeze discovery time; future results, wrong CA and late text do not become entry evidence',()=>{
  const e=episode(),before=JSON.stringify(e),profile=classifyNarrativeCase(e,NOW);
  assert.equal(profile.knowledge,'retrospective_association');assert.equal(profile.phase,'fresh');assert.equal(profile.recordedAt,NOW);
  assert.equal(JSON.stringify(e),before);
  const second=episode({id:'second',at:NOW-1.5*DAY,narratives:[{...e.narratives[0]}],outcomes:{'24h':{status:'observed',at:NOW-DAY/2,price:2,returnRate:1}}});
  const report=narrativeStageReport([e,second],NOW);assert.equal(report.groups.length,2,'fresh and background phases must not merge');
  assert.equal(report.autoTradingChanges,false);assert.equal(report.associated,2);
  const future=episode({id:'future',outcomes:{'24h':{status:'observed',at:NOW+1,price:100,returnRate:99}}});
  const research=index([doc({text:'We launched Mooncake, a community meme'})],[e,future,episode({address:OTHER})]);
  const result=thesis({index:research});assert.equal(result.history.samples,1);assert.equal(result.history.medianReturn24h,-.5);
  assert.equal(narrativeStageReport([future],NOW).groups[0].completed24h,0);
  assert.equal(classifyNarrativeCase({...e,narratives:[{...e.narratives[0],at:e.at+1}]},NOW),null);
});

test('verified public linked text is reusable but retains uncertain CA association',()=>{
  const e=episode(),research=index([],[e]);
  const t=thesis({index:research,token:{...token,twitterUsername:url('103')}});
  assert.equal(t.relationship.kind,'community_link');assert.equal(t.authorEndorsement,false);
  assert.equal(thesis({index:index([],[episode({narratives:[{...e.narratives[0],associatedAt:NOW+1}]})])}).sources.length,0);
});

test('unclassified stories are not treated as a shared narrative unless the original post matches',()=>{
  const e=episode({narratives:[{...episode().narratives[0],text:'Plain hello world'}]});
  const t=thesis({token:{...token,symbol:'Plain',name:'Plain'},index:index([doc({text:'Plain hello world'})],[e])});
  assert.equal(t.event.kind,'unclassified');assert.equal(t.history.samples,0);
  assert.match(t.propagation.summary,/含弱关联/);
});

test('production evaluator freezes research in new paper buys and rechecks a contradictory thesis at commit',()=>{
  const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true};
  const e=normalizePlatformCall({id:'offline',signal_type:13,token_address:CA,trigger_at:(NOW-10000)/1000,data:{...token}},'bsc',NOW);
  const signal=buildPaperNewsWire({gmgn:{version:GMGN_SOCIAL_VERSION,chains:{bsc:{status:'healthy',lastSuccessAt:iso(NOW)}},events:[e]},nowMs:NOW}).paperSignals[0];
  const q=at=>({...token,status:'ok',observedAt:iso(at),price:at===NOW?1:.99});
  const input={...modes,token,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),nowMs:NOW,
    requireFastQuote:true,compoundingCash:100,fixedEntryUsd:10,monitorSignal:signal,flow:flow(),quoteHistory:[q(NOW-4000),q(NOW)],narrativeResearchIndex:index()};
  const row=evaluatePaperStrategies(input)[0];assert.equal(row.decision,'可模拟');
  assert.match(row.evidence.narrativeThesis.conclusion,/没有原文/);
  const a=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,evaluations:[row],nowMs:NOW});
  assert.equal(a.trades.length,1);assert.equal(a.trades[0].entryEvidence.narrativeThesis.version,NARRATIVE_THESIS_VERSION);
  const bad=evaluatePaperStrategies({...input,narrativeResearchIndex:index([doc({chain:'bsc',text:`Do not buy Mooncake ${CA}`})])})[0];
  assert.equal(bad.decision,'观察');bad.decision='可模拟';bad.evidence.paperEligible=true;
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,evaluations:[bad],nowMs:NOW}).trades.length,0);
  // A trusted monitor channel cannot reintroduce a post quarantined by another
  // authenticated source channel. Verify this fixture passes signal validation.
  const authenticated={...signal,source:'own_verified',authenticated:true,sourceUrl:url('101'),text:doc().text};
  authenticated.id=monitorSignalId(authenticated);assert.equal(validMonitorSignal(authenticated,token,NOW),true);
  assert.equal(thesis({monitorSignal:authenticated}).sources.length,1);
  const conflicts=index([doc(),doc({text:'Mooncake cancelled'})]);
  assert.equal(thesis({monitorSignal:authenticated,index:conflicts}).sources.length,0);
});

test('Chinese research views escape source text, label late associations and make no trade request',()=>{
  const t=thesis({index:index([doc({text:'Mooncake <img src=x onerror=alert(1)>'})])});
  const html=renderNarrativeThesis(t);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);
  assert.match(html,/买盘承接/);assert.match(html,/CA 对应关系/);
  const desk=narrativeDeskReport([{token,evidence:{narrativeThesis:t}}],index(),narrativeStageReport([episode()],NOW),NOW);
  assert.equal(desk.candidates,1);assert.match(renderNarrativeDesk(desk),/事后关联/);
  assert.match(renderNarrativeDesk(desk,new Set([`bsc:${CA}`])),new RegExp(`data-narrative-case="bsc:${CA}" open`));
  assert.doesNotMatch(renderNarrativeDesk(desk,new Set([`base:${CA}`])),/ open>/,'same address on another chain does not open this case');
  assert.match(renderNarrativeThesis({...t,sources:[{url:'javascript:alert(1)'}]}),/出处待核实/);
  assert.equal(renderNarrativeThesis(null),'');
});
