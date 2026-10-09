import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ALPHA_LIST_URL,ALPHA_ENTRY_VERSION,normalizeAlphaCatalog,advanceAlphaCatalog,alphaListingSignals,createAlphaCatalogMonitor} from '../src/binance-alpha-catalog.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {confirmedAccountGate} from '../src/paper-confirmed-policy.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {renderNewsWire} from '../dashboard/news-wire.js';
import {gasFixture} from './helpers/paper-gas-fixture.js';

// Offline fixtures only; no test token is written to running data/.
const NOW=Date.parse('2026-09-25T13:00:00Z'),CA=`0x${'a'.repeat(40)}`,iso=n=>new Date(n).toISOString();
const raw={alphaId:'ALPHA_1234',tokenId:'offline_fixture',chainId:'56',contractAddress:CA,name:'Offline Fixture',symbol:'OFFLINE',
  listingTime:NOW-60000,offline:false,offsell:false};
const payload=rows=>({code:'000000',success:true,data:rows});
const catalog=(at=NOW,listingTime=NOW-60000)=>advanceAlphaCatalog(null,normalizeAlphaCatalog(payload([{...raw,listingTime}])),at);
const token={chain:'bsc',address:CA,symbol:'OFFLINE',price:1,liquidity:60000,volume:10000,marketStage:'unknown',
  isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true};
const input=(listingTime=NOW-60000)=>({...modes,token,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),requireFastQuote:true,
  nowMs:NOW,compoundingCash:100,fixedEntryUsd:10,candles:[],klineStatus:'unavailable',flow:{},
  alphaSignal:alphaListingSignals(catalog(NOW,listingTime),NOW)[0],quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}]});
const evaluate=i=>evaluatePaperStrategies(i)[0];
const advance=(a,rows,extra={})=>advancePaperStrategyAccount(a,{...modes,evaluations:rows,nowMs:NOW,...extra});

test('Alpha admits high gas on the main only and uses refreshed receipt samples for exit fees',()=>{
  const i={...input(),chainGasAccounting:true,gasEstimate:gasFixture('bsc',NOW,2)},row=evaluate(i);
  assert.equal(row.decision,'可模拟');assert.ok(row.evidence.costAssumptions.estimatedRoundTripCostRate>.4);
  const a=advance(createPaperStrategyAccount({nowMs:NOW}),[row],{chainGasAccounting:true});
  assert.equal(a.trades.length,1);const at=NOW+180000;
  const rows=Array.from({length:24},(_,j)=>({time:at-(24-j)*60000,open:j===23?.9:1,close:j===23?.8:j===22?.9:1,high:1.01,low:j===23?.79:j===22?.89:.99,volume:j===23?200:100}));
  const mark={...token,status:'ok',price:.8,observedAt:iso(at),structureChart:{...token,ready:true,rows}};
  assert.equal(advance(a,[],{nowMs:at,marks:[mark]}).trades.length,1,'missing live exit gas cannot fabricate an exit fee');
  const next=advance(a,[],{nowMs:at,marks:[{...mark,gasEstimate:gasFixture('bsc',at,.3)}]});
  assert.equal(next.trades.length,2);const sale=next.trades[1];
  assert.ok(Math.abs(sale.costsUsd-sale.grossUsd*.02-.3)<1e-10);
  assert.equal(sale.exitEvidence.gasUsd,.3);assert.equal(validatePaperStrategyAccount(next),true);
});

test('official Alpha route also filters either tax strictly above 6%',()=>{
  for(const field of ['buyTax','sellTax']) {
    const i=input();i.token={...token,[field]:.060001};
    const row=evaluate(i);assert.equal(row.decision,'不买');
    assert.ok(row.evidence.safety.blocked.some(r=>r.includes('税超过 6%')));
    assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[row]).trades.length,0);
  }
});

test('official listing enters main with one independent quote, no invented bars, flow, price target or stop',()=>{
  const i=input(),row=evaluate(i);assert.equal(row.decision,'可模拟',JSON.stringify({m:row.missing,r:row.reasons}));
  assert.equal(row.evidence.opportunity.id,'alpha_listing');assert.equal(row.evidence.opportunity.phase,'launch');
  assert.equal(row.evidence.entryPlan.stopPrice,null);assert.equal(row.evidence.entryPlan.targetPrice,null);
  assert.equal(row.evidence.flowFresh,false);assert.equal(row.evidence.flow.uniqueBuyerCount,null);
  const account=advance(createPaperStrategyAccount({nowMs:NOW}),[row]);
  assert.equal(account.trades.length,1);assert.equal(account.cash,90);assert.equal(validatePaperStrategyAccount(account),true);
  const position=account.positions[`bsc:${CA}`];assert.equal(position.activeStopPrice,null);
  assert.equal(position.memeExitPolicy.fixedStop,false);assert.equal(position.memeExitPolicy.fixedProfitTiers,false);
  assert.match(position.entryEvidence.traderDecision.questions[0].text,/官方目录/);
  assert.equal(position.entryEvidence.traderDecision.sourceUrl,ALPHA_LIST_URL);
  assert.equal(account.execution,false);assert.equal(account.signing,false);assert.equal(account.broadcast,false);
  assert.equal(advance(account,[row]).trades.length,1);
  assert.equal(confirmedAccountGate(account,NOW,token,null,null,{continuousPaperMode:true,opportunity:row.evidence.opportunity}).allowed,false);
  assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[row],{memeExitMode:false}).trades.length,0);
  assert.equal(advance(account,[],{nowMs:NOW+3600000}).trades.length,1,'frozen official evidence validates after its observation expires');
});

test('follow-through needs current rising independent quotes, not a backdated launch fill',()=>{
  const i=input(NOW-7200000);assert.notEqual(evaluate(i).decision,'可模拟');
  i.quoteHistory.unshift({...token,price:.99,status:'ok',observedAt:iso(NOW-4000)});
  const row=evaluate(i);assert.equal(row.decision,'可模拟');assert.equal(row.evidence.opportunity.phase,'follow_through');
  const a=advance(createPaperStrategyAccount({nowMs:NOW}),[row]);assert.equal(a.trades[0].atMs,NOW);
  assert.equal(a.trades[0].price,1);assert.equal(a.trades[0].entryEvidence.entryPlan.entryPolicyVersion,ALPHA_ENTRY_VERSION);
  i.quoteHistory[0].price=1.01;assert.notEqual(evaluate(i).decision,'可模拟');
});

test('Alpha lots retain evidence exits: no percentage stop, but fresh heavy breakdown can close and cannot recycle the event',()=>{
  const opened=advance(createPaperStrategyAccount({nowMs:NOW}),[evaluate(input())]);
  let a=advance(opened,[],{nowMs:NOW+1000,marks:[{...token,status:'ok',price:.8,observedAt:iso(NOW+1000)}]});
  assert.equal(a.trades.length,1,'a 20% fall alone is not a configured exit');
  const at=NOW+180000;
  const rows=Array.from({length:24},(_,i)=>({time:at-(24-i)*60000,open:i===23?.9:1,
    close:i===23?.8:i===22?.9:1,high:1.01,low:i===23?.79:i===22?.89:.99,volume:i===23?200:100}));
  a=advance(a,[],{nowMs:at,marks:[{...token,status:'ok',price:.8,observedAt:iso(at),structureChart:{...token,ready:true,rows}}]});
  assert.equal(a.trades.length,2);assert.equal(a.trades[1].side,'sell');assert.match(a.trades[1].reason,/放量/);
  assert.equal(validatePaperStrategyAccount(a),true);
  const i=input();i.alphaSignal.observedAt=iso(at);i.nowMs=at;i.observedAt=iso(at);i.priceObservedAt=iso(at);
  i.quoteHistory=[{...token,status:'ok',observedAt:iso(at)}];
  assert.equal(advance(a,[evaluate(i)],{nowMs:at}).trades.length,2,'closed positions cannot consume the same Alpha event again');
});

test('event lane keeps real data, safety, cash, costs, binding, expiry and mode boundaries',()=>{
  for(const mutate of [i=>i.priceObservedAt=iso(NOW-6000),i=>i.observedAt=iso(NOW-121000),i=>i.compoundingCash=9,
    i=>i.token.isHoneypot=true,i=>i.token.sellTax=null,i=>i.token.liquidity=0,i=>i.token.volume=0,
    i=>i.alphaSignal.address=`0x${'b'.repeat(40)}`,i=>i.alphaSignal.sourceUrl='https://example.com',
    i=>i.alphaSignal.observedAt=iso(NOW-31000),i=>i.alphaSignal.listingTime=NOW+1,
    i=>i.alphaSignal.listingTime=NOW-86400001,i=>i.quoteHistory=[],i=>i.quoteHistory[0].address=`0x${'b'.repeat(40)}`,
    i=>i.alphaSignal.offline=true,i=>i.alphaSignal.offsell=true,i=>i.token.cannotSell=true,i=>i.token.canMint=true,
    i=>i.token.canFreeze=true,i=>i.token.canPause=true,i=>i.token.fakePool=true,i=>i.token.stageConflict=true]){
    const i=structuredClone(input());mutate(i);assert.notEqual(evaluate(i).decision,'可模拟',mutate.toString());
  }
  assert.notEqual(evaluate({...input(),memeExitMode:false}).decision,'可模拟');
  assert.notEqual(evaluate({...input(),memeExitMode:false,opportunityReviewMode:false}).decision,'可模拟');
  const row=evaluate(input()),bad=structuredClone(row);bad.evidence.confirmedPolicy.confirmation.rows=[];
  assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[bad]).trades.length,0);
});

test('only official event experiment records high bundling as a warning; sellability remains blocking',()=>{
  const i=structuredClone(input());i.token.bundlerRate=.4242;
  const row=evaluate(i);assert.equal(row.decision,'可模拟');assert.equal(row.evidence.safety.metrics.bundlerRate,.4242);
  assert.deepEqual(row.evidence.safety.warnings,['打包买入占比超过筛选线']);
  assert.deepEqual(row.evidence.safety.sourceBlocked,['打包买入占比超过筛选线']);
  assert.match(row.entryLogic,/42.42%/);
  assert.notEqual(evaluate({...i,memeExitMode:false}).decision,'可模拟');
  i.token.isHoneypot=true;assert.equal(evaluate(i).decision,'不买');
});

test('official event also retains absent audits as unknown instead of waiting for full audit coverage',()=>{
  const i=structuredClone(input());
  for(const k of ['isHoneypot','isWashTrading','rugRatio','top10HolderRate','devTeamHoldRate','bundlerRate'])delete i.token[k];
  const row=evaluate(i);assert.equal(row.decision,'可模拟');assert.equal(row.evidence.safety.auditComplete,false);
  assert.ok(row.evidence.safety.auditMissing.includes('可卖出检测'));assert.equal(row.evidence.safety.sellabilityVerified,false);
  assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[row]).trades.length,1);
  assert.notEqual(evaluate({...i,memeExitMode:false}).decision,'可模拟');
});

test('catalog validates exact identity, original listing clock and health; refresh never revives old news',()=>{
  assert.throws(()=>normalizeAlphaCatalog(payload([raw,raw])));
  assert.throws(()=>normalizeAlphaCatalog(payload([{...raw,listingTime:null}])));
  assert.throws(()=>normalizeAlphaCatalog({code:'000000',data:[raw]}));
  let state=catalog();assert.equal(alphaListingSignals(state,NOW).length,1);
  assert.equal(alphaListingSignals(state,NOW+31000).length,0);
  state=advanceAlphaCatalog(state,normalizeAlphaCatalog(payload([raw])),NOW+86400000);
  assert.equal(alphaListingSignals(state,NOW+86400000).length,0);
  assert.equal(state.tokens[0].firstObservedAt,iso(NOW));assert.equal(state.tokens[0].listingTime,raw.listingTime);
  state=advanceAlphaCatalog(catalog(),normalizeAlphaCatalog(payload([{...raw,contractAddress:`0x${'b'.repeat(40)}`} ])),NOW+1000);
  assert.equal(alphaListingSignals(state,NOW+1000).length,0);
  state=advanceAlphaCatalog(state,normalizeAlphaCatalog(payload([raw])),NOW+2000);
  assert.equal(alphaListingSignals(state,NOW+2000).length,0,'identity conflict remains quarantined');
});

test('bounded monitor persists state and honors 429 backoff across restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'alpha-entry-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let at=NOW,calls=0;
  const monitor=createAlphaCatalogMonitor({dataDir:dir,now:()=>at,fetchImpl:async url=>{
    assert.equal(url,ALPHA_LIST_URL);calls++;
    return calls===1?{ok:true,text:async()=>JSON.stringify(payload([raw]))}:{ok:false,status:429,headers:new Headers({'retry-after':'90'})};
  }});
  await Promise.all([monitor.pollOnce(),monitor.pollOnce()]);assert.equal(calls,1);
  at+=5000;await monitor.pollOnce();assert.equal(calls,2);assert.equal(monitor.snapshot().health.status,'backoff');
  await monitor.pollOnce();assert.equal(calls,2);await monitor.stop();
  const restarted=createAlphaCatalogMonitor({dataDir:dir,now:()=>at,fetchImpl:()=>{throw new Error('must not request');}});
  await restarted.pollOnce();assert.equal(restarted.snapshot().health.status,'backoff');await restarted.stop();
});

test('off-ranking official token gets details, independent quote and main fill without waiting for a chart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'alpha-runtime-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let at=NOW,detailCalls=0,quoteCalls=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(at),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(at),tokens:[]}),
    details:async()=>{detailCalls++;return {status:'ok',observedAt:iso(at),token};},
    quote:async()=>{quoteCalls++;return {...token,status:'ok',observedAt:iso(at)};},kline:async()=>({status:'unavailable',candles:[]})};
  const runtime=createPaperStrategyRuntime({...modes,market,dataDir:dir,chains:['bsc'],chain:'bsc',fixedEntryUsd:10,now:()=>at,
    evidenceLoader:()=>({events:[],alphaCatalog:catalog(at)}),tradeReviewEvery:100});
  try{
    await runtime.runOnce();assert.equal(runtime.snapshot().cadence.detailTargets,1);
    await runtime.refreshDetails();assert.equal(detailCalls,1);at+=1000;await runtime.fastOnce();
    await runtime.refreshQuote();at+=100;await runtime.fastOnce();
    const s=runtime.snapshot();assert.ok(quoteCalls>0);assert.equal(s.account.trades.length,1,JSON.stringify(s.opportunityRoutes.at(-1)));
    assert.equal(s.account.trades[0].entryEvidence.opportunity.id,'alpha_listing');
    assert.equal(s.newsWire.alphaCatalog.activeSignals,1);assert.equal(s.account.cash,90);
    assert.match(renderNewsWire(s.newsWire),/币安 Alpha 官方上新/);
  }finally{await runtime.stop();}
});
