import test from 'node:test';
import assert from 'node:assert/strict';
import {kolThemeCandidates} from '../src/paper-kol-theme.js';
import {buildPaperNewsWire} from '../src/paper-news-wire.js';
import {createCapitalKolEventSnapshot} from '../src/capital-kol-catalog.js';
import {loadPaperEvidence} from '../src/paper-strategy-evidence.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
const NOW=Date.parse('2026-09-25T15:00:00Z'),iso=n=>new Date(n).toISOString(),CA=`0x${'a'.repeat(40)}`,ID='2103489474403418595';
const text='中秋快乐 eat lots of Moon cakes!',url=`https://x.com/cz_binance/status/${ID}`;
const doc={id:url,url,text,at:NOW-10000,author:'cz_binance',kind:'reviewed_big_kol',authenticated:true};
const token={chain:'bsc',address:CA,symbol:'Mooncakes',name:'Moon cakes',price:1,liquidity:60000,volume:1000,buyTax:0,sellTax:0,
  twitterUsername:`i/status/${ID}`};
const item={token,marketStatus:'ok',observedAt:iso(NOW)};
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true};
const event=at=>({type:'kol_narrative_observation',tweet:{id:ID,text,url,handle:'cz_binance',xUserId:'902926941413453824',authorId:'902926941413453824',
  createdAt:iso(at),sourceVerifiedBy:'official_x_oembed',isReply:false,isQuote:false},
  caller:{handle:'cz_binance',xUserId:'902926941413453824',capitalKolSnapshot:createCapitalKolEventSnapshot('cz_binance'),
    capitalKolBinding:{handle:'cz_binance',xUserId:'902926941413453824',source:'fxtwitter_public_profile',observedAt:iso(NOW)}},observedAt:iso(NOW),simulationOnly:true});
const input=(at=NOW-10000)=>({...modes,token,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),requireFastQuote:true,
  nowMs:NOW,compoundingCash:100,fixedEntryUsd:10,candles:[],flow:{},quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}],
  monitorSignal:buildPaperNewsWire({events:[event(at)],candidates:[item],nowMs:NOW}).paperSignals[0]});
const evaluate=i=>evaluatePaperStrategies(i)[0];

test('CZ no-CA text maps to bilingual theme with project permalink, never inferred endorsement',()=>{
  const rows=kolThemeCandidates(doc,[item,{...item,token:{...token,address:`0x${'b'.repeat(40)}`,liquidity:.01}},
    {...item,token:{...token,address:`0x${'c'.repeat(40)}`,twitterUsername:'unknown'}}],NOW);
  assert.equal(rows.length,3);assert.equal(rows[0].address,CA);assert.equal(rows[0].selected,true);
  assert.equal(rows[0].authorEndorsement,false);assert.equal(rows[2].binding,'name_overlap_only');
  assert.equal(rows[2].selected,false);assert.deepEqual(rows[0].matchedTerms,['mooncake']);
  assert.equal(kolThemeCandidates({...doc,authenticated:false},[item],NOW).length,0);
  assert.equal(kolThemeCandidates({...doc,text:`不要买 月饼`},[item],NOW).length,0);
  assert.equal(kolThemeCandidates({...doc,text:`Moon cakes not affiliated with any token`},[item],NOW).length,0);
  assert.equal(kolThemeCandidates({...doc,at:NOW-3600001},[item],NOW).length,0);
  assert.equal(kolThemeCandidates(doc,[{...item,observedAt:iso(NOW-121000)}],NOW).length,0);
  const bait={...item,token:{...token,twitterUsername:`https://x.com.evil.test/i/status/${ID}`}};
  assert.equal(kolThemeCandidates(doc,[bait],NOW)[0].selected,false);
});

test('reviewed local news enters the live evidence loader without changing source time or bypassing identity',async()=>{
  const e=event(NOW-1200000);
  const load=async version=>loadPaperEvidence('/not-a-real-data-directory',async file=>file.endsWith('/paper-reviewed-news.json')?{version,events:[e]}:null);
  const evidence=await load('paper_reviewed_news_v1');
  const wire=buildPaperNewsWire({...evidence,candidates:[item],nowMs:NOW});
  assert.equal(wire.themeCandidates.length,1);assert.equal(wire.paperSignals.length,1);
  assert.equal(wire.paperSignals[0].sourceAt,iso(NOW-1200000));
  assert.equal(wire.themeCandidates[0].phase,'follow_through');
  assert.equal((await load('unknown')).events.length,0);
  e.caller.capitalKolBinding.xUserId='1';
  assert.equal(buildPaperNewsWire({...await load('paper_reviewed_news_v1'),candidates:[item],nowMs:NOW}).paperSignals.length,0);
});

test('first two minutes can paper buy; a delayed read is current follow-through, not a launch replay',()=>{
  const i=input(),r=evaluate(i);assert.equal(r.decision,'可模拟',JSON.stringify(r.missing));
  assert.equal(r.evidence.opportunity.event.source,'kol_theme_hypothesis');assert.match(r.entryLogic,/不是作者认领/);
  const delayed=input(NOW-1200000);assert.notEqual(evaluate(delayed).decision,'可模拟');
  delayed.quoteHistory.unshift({...token,price:.99,status:'ok',observedAt:iso(NOW-4000)});
  const row=evaluate(delayed);assert.equal(row.decision,'可模拟');
  const a=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,evaluations:[row],nowMs:NOW});
  assert.equal(a.trades.length,1);assert.equal(a.trades[0].atMs,NOW);assert.equal(a.cash,90);
  assert.equal(validatePaperStrategyAccount(a),true);
  delayed.quoteHistory[0].price=1.01;assert.notEqual(evaluate(delayed).decision,'可模拟');
  delayed.monitorSignal.theme.authorEndorsement=true;assert.notEqual(evaluate(delayed).decision,'可模拟');
});

test('current continuous main can open more than two distinct tokens in one cycle without cash creation',()=>{
  const rows=Array.from({length:4},(_,n)=>{
    const i=input(),address=`0x${String(n+1).repeat(40)}`;
    i.token={...i.token,address};i.quoteHistory=[{...i.token,status:'ok',observedAt:iso(NOW)}];
    i.monitorSignal=buildPaperNewsWire({events:[event(NOW-10000)],candidates:[{...item,token:i.token}],nowMs:NOW}).paperSignals[0];
    return evaluate(i);
  });
  const a=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,evaluations:rows,nowMs:NOW});
  assert.equal(a.trades.length,4);assert.equal(Object.keys(a.positions).length,4);assert.equal(a.cash,60);
  assert.equal(validatePaperStrategyAccount(a),true);
});
