import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceNarrativeRecall, narrativeTerms, narrativeOverlap, readRecallDocument, freshNarrativeRecall, validNarrativeMemory } from '../src/paper-narrative-recall.js';
import { confirmedAccountGate } from '../src/paper-confirmed-policy.js';
import { createPaperStrategyAccount, evaluatePaperStrategies, advancePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { NOW,DAY,CA,TEXT,kolEvent,candidate,historyEvent } from './fixtures/paper-narrative-recall.js';
const seed=()=>advanceNarrativeRecall(null,{events:[historyEvent()],candidates:[candidate(NOW-DAY+1000)],nowMs:NOW-DAY+1000}).memory;
const recall=(extra={})=>advanceNarrativeRecall(seed(),{events:[kolEvent()],candidates:[candidate()],nowMs:NOW,...extra});
test('no-CA text recalls a played seven-day exact-CA OG; preserves provenance and historical room uncertainty',()=>{
  const s=recall(),m=s.matches[0];assert.equal(m.address,CA);assert.equal(m.chain,'base');assert.equal(m.ready,true);
  assert.equal(m.similarity,1);assert.equal(m.referenceRoom,5);assert.equal(m.ourPriorEntries,0);
  assert.match(m.ogBasis,/不等于全网/);assert.match(m.roomNote,/不是未来/);assert.equal(validNarrativeMemory(s.memory),true);
  assert.equal(s.report.completeSevenDayHistory,false);assert.equal(freshNarrativeRecall(m,{chain:'base',address:CA},NOW),true);
  assert.equal(freshNarrativeRecall(m,{chain:'bsc',address:CA},NOW),false);
  assert.equal(freshNarrativeRecall(m,{chain:'base',address:CA},NOW+120000),false);
  const restart=advanceNarrativeRecall(JSON.parse(JSON.stringify(s.memory)),{events:[kolEvent()],candidates:[candidate()],nowMs:NOW+1000});
  assert.equal(restart.matches.length,1);assert.equal(restart.matches[0].sourceAt,m.sourceAt);
});
test('generic words, negation, reply, quote, stale/future posts and forged KOL identity cannot trigger',()=>{
  assert.equal(narrativeOverlap(narrativeTerms('AI token crypto launch today'),narrativeTerms('AI token crypto launch today')).high,false);
  for(const change of [e=>e.tweet.isReply=true,e=>e.tweet.isQuote=true,e=>e.tweet.xUserId='123',
    e=>e.tweet.sourceVerifiedBy='mirror',e=>e.tweet.url=e.tweet.url.replace('elonmusk','fake'),
    e=>e.caller.capitalKolBinding.xUserId='123',e=>e.tweet.textTruncated=true,e=>e.caller.capitalKolSnapshot.catalogHash='fake']) {
    const e=structuredClone(kolEvent());change(e);assert.equal(readRecallDocument(e,NOW),null);assert.equal(recall({events:[e]}).matches.length,0);
  }
  for(const e of [kolEvent(`do not buy ${TEXT}`),kolEvent(TEXT,NOW-120001),kolEvent(TEXT,NOW+1000),kolEvent('AI token crypto launch today')])assert.equal(recall({events:[e]}).matches.length,0);
});
test('same symbol, unobserved historical activity, chain ambiguity and old history cannot invent an OG',()=>{
  const fake=candidate(NOW,{address:`0x${'b'.repeat(40)}`});
  const r=advanceNarrativeRecall(null,{events:[historyEvent(),kolEvent()],candidates:[fake],nowMs:NOW});assert.equal(r.matches.length,0);
  const unplayed=advanceNarrativeRecall(null,{events:[historyEvent(),kolEvent()],candidates:[candidate()],nowMs:NOW});assert.equal(unplayed.matches.length,0);
  const noChain=historyEvent();delete noChain.chain;
  const ambiguous=advanceNarrativeRecall(null,{events:[noChain],candidates:[candidate(NOW-DAY+1000),candidate(NOW-DAY+1000,{chain:'bsc'})],nowMs:NOW-DAY+1000});
  assert.equal(Object.keys(ambiguous.memory.assets).length,0);
  const transaction=historyEvent();transaction.tweet.text=`${TEXT} ${CA}${'a'.repeat(24)}`;
  assert.equal(Object.keys(advanceNarrativeRecall(null,{events:[transaction],candidates:[candidate(NOW-DAY+1000)],nowMs:NOW-DAY+1000}).memory.assets).length,0);
  assert.equal(advanceNarrativeRecall(seed(),{events:[kolEvent(TEXT,NOW+7*DAY)],candidates:[candidate(NOW+7*DAY+1000)],nowMs:NOW+7*DAY+1000}).matches.length,0);
});
test('missing room, conflicting replay, ambiguous earliest CA and repeated catalyst stay observational',()=>{
  for(const token of [{historyHighestMarketCap:null},{marketCap:null},{historyHighestMarketCap:2000000}])assert.equal(recall({candidates:[candidate(NOW,token)]}).matches[0].ready,false);
  const conflict=historyEvent();conflict.tweet.text=`edited ${TEXT} ${CA}`;
  const r=recall({events:[conflict,kolEvent()]});assert.equal(r.matches.length,0);assert.equal(r.report.conflicts,1);
  const otherCA=`0x${'b'.repeat(40)}`,other={...historyEvent(),tweet:{...historyEvent().tweet,id:'2102563652285145888',url:'https://x.com/elonmusk/status/2102563652285145888',text:`${TEXT} ${otherCA}`}};
  const tied=advanceNarrativeRecall(null,{events:[historyEvent(),other],candidates:[candidate(NOW-DAY+1000),candidate(NOW-DAY+1000,{address:otherCA})],nowMs:NOW-DAY+1000});
  const tie=advanceNarrativeRecall(tied.memory,{events:[kolEvent()],candidates:[candidate(),candidate(NOW,{address:otherCA})],nowMs:NOW});
  assert.equal(tie.matches[0].ready,false);assert.match(tie.matches[0].reasons.join(' '),/不能唯一选择/);
  const m=recall().matches[0],a=createPaperStrategyAccount({nowMs:NOW});
  a.trades.push({side:'buy',chain:'base',address:CA,atMs:NOW-10000,quantity:1,realizedPnl:0,entryEvidence:{narrativeRecall:m}});
  assert.ok(confirmedAccountGate(a,NOW,candidate().token,{lastBuyAt:NOW-100},m).reasons.some(r=>r.includes('催化已经交易')));
  assert.equal(recall({trades:a.trades}).matches.length,0);
});
test('OG trigger may replace smart tag, never real buyer counts, safety, pricing, costs or account stop',()=>{
  const token={...candidate().token,price:1.01,isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
  const input={token,nowMs:NOW,observedAt:new Date(NOW).toISOString(),priceObservedAt:new Date(NOW).toISOString(),marketStatus:'ok',
    allowExploratory:true,pvpMode:true,confirmedMode:true,compoundingCash:100,narrativeRecall:recall().matches[0],
    flow:{fresh:true,complete:true,status:'healthy',observedAt:new Date(NOW).toISOString(),uniqueBuyerCount:2,smartMoneyCount:0,highProfitCount:0,fomoCount:0,netBuyUsd:600,
      pulse:{recentBuyerCount:2,recentNetBuyUsd:600,lastBuyAt:NOW-1000}},
    quoteHistory:[1,1.006,1.01].map((price,i)=>({...token,price,status:'ok',observedAt:new Date(NOW-(2-i)*6000).toISOString()}))};
  const row=evaluatePaperStrategies(input)[0];assert.equal(row.decision,'可模拟');assert.equal(row.label,'OG 回流狙击');
  assert.equal(row.evidence.flow.smartMoneyCount,0);assert.equal(row.evidence.entryThresholds.minSmartMoney,0);
  const opened=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{evaluations:[row],confirmedMode:true,nowMs:NOW});
  assert.equal(opened.trades.length,1);assert.equal(Object.values(opened.positions)[0].strategyLabel,'OG 回流狙击');
  for(const mutate of [x=>x.narrativeRecall=null,x=>x.flow.uniqueBuyerCount=1,x=>x.flow.pulse.recentBuyerCount=1,
    x=>x.token.isHoneypot=true,x=>x.token.rugRatio=null,x=>x.quoteHistory=[],x=>x.compoundingCash=6.26,x=>x.narrativeRecall.sourceAt=NOW-120001]) {
    const x=structuredClone(input);mutate(x);assert.notEqual(evaluatePaperStrategies(x)[0].decision,'可模拟',String(mutate));
  }
  const stopped=createPaperStrategyAccount({nowMs:NOW});stopped.cash=89;stopped.realizedPnl=-11;
  assert.equal(advancePaperStrategyAccount(stopped,{evaluations:[row],confirmedMode:true,nowMs:NOW}).trades.length,0);
});
