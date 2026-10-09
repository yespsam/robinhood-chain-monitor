import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {strictFlapTrackedPoolTokenEvent} from './fixtures/paper-pool-event.js';
import {fourPoolEvents} from './fixtures/four-pool-event.js';
import {isStrictFourRegistryTrackedTokenUpdate} from '../src/source-controls.js';
import {createPaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {createConfirmedPaperSession,createEstimatedPaperSession,LEGACY_PAPER_FILE} from '../src/paper-account-session.js';
import {GMGN_THREE_LISTS} from '../src/paper-discovery-scope.js';

const NOW=Date.parse('2026-09-30T06:00:00Z'),iso=v=>new Date(v).toISOString();
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,evidenceGapExitMode:false};
function event(ordinal=1) {
  const raw=strictFlapTrackedPoolTokenEvent({ordinal,blockTimestamp:iso(NOW-4000+ordinal*1000),observedAt:iso(NOW)});
  const e=JSON.parse(JSON.stringify(raw).replaceAll('0x'+'4'.repeat(40),'0x'+String(ordinal+5).repeat(40))
    .replaceAll('0x'+'11'.repeat(32),'0x'+String(ordinal+3).repeat(64)));
  e.blockNumber+=ordinal;e.featureTokenProof.blockNumber=e.blockNumber;
  return e;
}
function token(e) {
  return {chain:'bsc',address:e.tokens[0].token,symbol:'OFFLIST',price:1,marketStage:'external',liquidity:60000,
    volume:10000,buyTax:0,sellTax:0,isHoneypot:false,isWashTrading:false,rugRatio:.01,
    top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01};
}
const turn=()=>new Promise(resolve=>setTimeout(resolve,10));
async function harness(t,{events=[],modifyToken=()=>{},quoteImpl,evidenceLoaderImpl}={}) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-pool-focused-'));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,
    account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-focused-pool-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-focused-pool',nowMs:NOW});
  const legacy=await fs.readFile(path.join(dataDir,session.legacy.file),'utf8');
  let clock=NOW,currentEvents=events,runtime;
  const tokenEvents=[...[1,2,3,4].map(event),...events.filter(e=>e.tokens?.[0]?.token)];
  const details=[],quotes=[],tokens=new Map(tokenEvents.map(e=>{const row=token(e);modifyToken(row);return [row.address,row];}));
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),interval:'5m',tokens:[]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    details:async request=>{details.push(request);return {status:'ok',observedAt:iso(clock),token:tokens.get(request.address)};},
    quote:async request=>{quotes.push(request);return quoteImpl?quoteImpl(request,clock):{...tokens.get(request.address),status:'ok',observedAt:iso(clock)};},
    kline:async()=>({status:'unavailable',candles:[]})};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>clock,discoveryMode:GMGN_THREE_LISTS,
    evidenceLoader:()=>evidenceLoaderImpl?evidenceLoaderImpl({events:currentEvents}):{events:currentEvents},
    intervalMs:60000,marketIntervalMs:60000};
  runtime=createPaperStrategyRuntime(options);
  t.after(async()=>{await runtime.stop();await fs.rm(dataDir,{recursive:true,force:true});});
  return {get runtime(){return runtime;},details,quotes,tokens,dataDir,session,
    setEvents:value=>{currentEvents=value;},setClock:value=>{clock=value;},
    async start(){await runtime.runOnce();await runtime.setEnabled(true);await runtime.start();await runtime.fastOnce();},
    async pump(expected=1){for(let n=0;n<100&&runtime.snapshot().account.trades.length<expected;n++){
      await runtime.fastOnce();await runtime.refreshDetails();await runtime.refreshQuote();await turn();clock+=250;
    }},
    async restart(){await runtime.stop();runtime=createPaperStrategyRuntime(options);await runtime.runOnce();},
    async unchangedLegacy(){assert.equal(await fs.readFile(path.join(dataDir,session.legacy.file),'utf8'),legacy);}};
}

test('focused discovery admits three current off-list pool CAs, not a fourth, and preserves consumption on restart',async t=>{
  const h=await harness(t,{events:[event(3),event(2),event(1),event(4)]});
  await h.start();await h.pump(3);
  const s=h.runtime.snapshot();
  assert.equal(s.account.trades.length,3,JSON.stringify({e:s.evaluations,c:s.cadence.eventDispatch}));
  assert.deepEqual(s.account.trades.map(trade=>trade.entryEvidence.newLaunch.pool.ordinal).sort(),[1,2,3]);
  assert.equal(s.discoveryScope.uniqueCandidates,0,'the exception does not fabricate ranking membership');
  assert.equal(s.discoveryScope.poolSignalDiscovery.maxCandidates,64);
  assert.equal(s.discoveryScope.poolSignalDiscovery.currentCandidates,0,'consumption removes discovery permission immediately');
  assert.equal(h.details.some(row=>row.address===event(4).tokens[0].token),false);
  assert.equal(validatePaperStrategyAccount(s.account),true);
  for(const key of ['execution','signing','broadcast'])assert.equal(s[key],false);
  await h.restart();
  assert.equal(h.runtime.snapshot().account.trades.length,3);
  assert.equal(h.runtime.snapshot().discoveryScope.poolSignalDiscovery.currentCandidates,0);
  await h.runtime.refreshEvents();await h.runtime.fastOnce();
  assert.equal(h.runtime.snapshot().account.trades.length,3);
  await h.unchangedLegacy();
});

test('focused event dispatch installs a new pool wire before list filtering and fills without another broad scan',async t=>{
  const h=await harness(t);
  await h.start();const ticks=h.runtime.snapshot().cadence.tickCount;
  h.setEvents([event()]);await h.runtime.refreshEvents();
  for(let n=0;n<100&&!h.runtime.snapshot().account.trades.length;n++)await turn();
  const s=h.runtime.snapshot();
  assert.equal(s.account.trades.length,1,JSON.stringify(s.cadence.eventDispatch));
  assert.equal(s.cadence.tickCount,ticks);
  assert.equal(h.details.length,1);assert.equal(h.quotes.length,1);
  assert.equal(s.account.trades[0].entryEvidence.opportunity.event.source,'new_pool_first_three');
  for(let n=0;n<3;n++)await h.runtime.refreshEvents();
  assert.equal(h.quotes.length,1);assert.equal(s.discoveryScope.uniqueCandidates,0);
  await h.unchangedLegacy();
});

for(const invalid of ['forged','expired','future','fourth'])test(`focused pool exception rejects ${invalid} source before off-list research`,async t=>{
  let e=event();
  if(invalid==='forged')e.featureTokenProof.canonical=false;
  if(invalid==='expired')e.blockTimestamp=iso(NOW-120001);
  if(invalid==='future')e.blockTimestamp=iso(NOW+1);
  if(invalid==='fourth')e=event(4);
  const h=await harness(t,{events:[e]});await h.start();await h.runtime.refreshEvents();
  for(let n=0;n<3;n++){await h.runtime.fastOnce();await h.runtime.refreshDetails();await h.runtime.refreshQuote();await turn();}
  assert.equal(h.details.length,0);assert.equal(h.quotes.length,0);
  assert.equal(h.runtime.snapshot().account.trades.length,0);
});

for(const invalid of ['unsafe','missing-safety','zero-liquidity'])test(`focused pool signal never bypasses ${invalid}`,async t=>{
  const h=await harness(t,{events:[event()],modifyToken:row=>{
    if(invalid==='unsafe')row.isHoneypot=true;
    if(invalid==='missing-safety')delete row.isHoneypot;
    if(invalid==='zero-liquidity')row.liquidity=0;
  }});
  await h.start();await h.runtime.refreshDetails();await h.runtime.fastOnce();await h.runtime.refreshEvents();
  for(let n=0;n<5;n++){await h.runtime.refreshQuote();await turn();}
  assert.ok(h.details.length>=1);assert.equal(h.runtime.snapshot().account.trades.length,0);
});

for(const invalid of ['expired','removed'])test(`focused pool evidence ${invalid} while quote is in flight cannot fill or retain off-list permission`,async t=>{
  let resolveQuote;
  const h=await harness(t,{events:[event()],quoteImpl:()=>new Promise(resolve=>{resolveQuote=resolve;})});
  await h.start();
  for(let n=0;n<80&&!resolveQuote;n++){await h.runtime.fastOnce();await h.runtime.refreshDetails();await turn();}
  assert.ok(resolveQuote,'eligible proof should request one real quote');
  if(invalid==='expired')h.setClock(NOW+120001);else h.setEvents([]);
  await h.runtime.refreshEvents();
  resolveQuote({...token(event()),status:'ok',observedAt:iso(invalid==='expired'?NOW+120001:NOW)});
  for(let n=0;n<5;n++){await turn();await h.runtime.fastOnce();}
  const s=h.runtime.snapshot();assert.equal(s.account.trades.length,0);
  assert.equal(s.discoveryScope.poolSignalDiscovery.currentCandidates,0);
  await h.unchangedLegacy();
});

test('an older broad evidence read cannot restore a pool permission removed by the newer event reader',async t=>{
  let resolveQuote,resolveEvidence,pauseEvidence=false;
  const h=await harness(t,{events:[event()],quoteImpl:()=>new Promise(resolve=>{resolveQuote=resolve;}),
    evidenceLoaderImpl:evidence=>{
      if(!pauseEvidence)return evidence;
      pauseEvidence=false;
      return new Promise(resolve=>{resolveEvidence=()=>resolve(evidence);});
    }});
  await h.start();
  for(let n=0;n<80&&!resolveQuote;n++){await h.runtime.fastOnce();await h.runtime.refreshDetails();await turn();}
  assert.ok(resolveQuote);
  pauseEvidence=true;const olderRead=h.runtime.fastOnce();
  for(let n=0;n<50&&!resolveEvidence;n++)await turn();
  assert.ok(resolveEvidence);
  h.setEvents([]);await h.runtime.refreshEvents();
  assert.equal(h.runtime.snapshot().discoveryScope.poolSignalDiscovery.currentCandidates,0);
  resolveEvidence();await olderRead;
  assert.equal(h.runtime.snapshot().discoveryScope.poolSignalDiscovery.currentCandidates,0,'older queued evidence cannot re-authorize the CA');
  resolveQuote({...token(event()),status:'ok',observedAt:iso(NOW)});
  for(let n=0;n<5;n++)await turn();
  assert.equal(h.runtime.snapshot().account.trades.length,0);
});

test('focused Four producer proofs research and simulate exactly three off-list CAs without changing read-only source authority',async t=>{
  const produced=await fourPoolEvents(t,{nowMs:NOW,count:4});
  assert.equal(produced.tokenEvents.length,3,'the real producer never substitutes a fourth CA');
  assert.ok(produced.tokenEvents.every(isStrictFourRegistryTrackedTokenUpdate));
  const original=structuredClone(produced.events);
  const h=await harness(t,{events:produced.events});
  await h.start();await h.pump(3);
  const s=h.runtime.snapshot(),trades=s.account.trades;
  assert.equal(trades.length,3,JSON.stringify({events:s.algorithmSignals,rows:s.evaluations}));
  assert.deepEqual(trades.map(trade=>trade.entryEvidence.newLaunch.pool.ordinal).sort(),[1,2,3]);
  assert.deepEqual(new Set(trades.map(trade=>trade.address)),new Set(produced.tokenEvents.map(e=>e.tokens[0].token)));
  assert.ok(trades.every(trade=>trade.entryEvidence.newLaunch.pool.platform==='fourmeme'));
  for(const trade of trades) {
    const e=trade.entryEvidence.opportunity.event;
    assert.equal(e.source,'new_pool_first_three');assert.equal(e.paperOnly,true);
    assert.equal(e.poolEvent.informationalOnly,true);
    assert.equal(e.poolEvent.autoTradeEligible,false);assert.equal(e.poolEvent.automaticExecution,false);
  }
  assert.deepEqual(produced.events,original,'paper consumption cannot mutate producer permissions or proof');
  assert.equal(s.discoveryScope.uniqueCandidates,0);
  for(const object of [s,s.account])for(const key of ['execution','signing','broadcast'])assert.equal(object[key],false);
  assert.equal(validatePaperStrategyAccount(s.account),true);
  await h.restart();await h.runtime.refreshEvents();await h.runtime.fastOnce();
  assert.equal(h.runtime.snapshot().account.trades.length,3);
  assert.equal(h.runtime.snapshot().discoveryScope.poolSignalDiscovery.currentCandidates,0);
  await h.unchangedLegacy();
});

for(const mutation of ['autoTradeEligible','automaticExecution','informationalOnly','expired']) {
  test(`focused Four proof cannot grant off-list research after ${mutation} invalidation`,async t=>{
    const produced=await fourPoolEvents(t,{nowMs:NOW,count:1}),events=structuredClone(produced.events);
    const source=events.find(e=>e.featureTrackedToken===true);
    if(mutation!=='expired')source[mutation]=mutation!=='informationalOnly';
    const h=await harness(t,{events});
    if(mutation==='expired')h.setClock(NOW+120001);
    await h.start();await h.runtime.refreshEvents();
    for(let n=0;n<3;n++){await h.runtime.fastOnce();await h.runtime.refreshDetails();await h.runtime.refreshQuote();await turn();}
    assert.equal(h.details.length,0);assert.equal(h.quotes.length,0);
    assert.equal(h.runtime.snapshot().account.trades.length,0);
    assert.equal(h.runtime.snapshot().discoveryScope.poolSignalDiscovery.currentCandidates,0);
    await h.unchangedLegacy();
  });
}

test('focused Four proof expiring during a real quote request cannot use that fresh quote to renew its source clock',async t=>{
  const produced=await fourPoolEvents(t,{nowMs:NOW,count:1});let resolveQuote;
  const h=await harness(t,{events:produced.events,quoteImpl:()=>new Promise(resolve=>{resolveQuote=resolve;})});
  await h.start();
  for(let n=0;n<80&&!resolveQuote;n++){await h.runtime.fastOnce();await h.runtime.refreshDetails();await turn();}
  assert.ok(resolveQuote);
  h.setClock(NOW+120001);await h.runtime.refreshEvents();
  resolveQuote({...token(produced.tokenEvents[0]),status:'ok',observedAt:iso(NOW+120001)});
  for(let n=0;n<5;n++){await turn();await h.runtime.fastOnce();}
  const s=h.runtime.snapshot();assert.equal(s.account.trades.length,0);
  assert.equal(s.discoveryScope.poolSignalDiscovery.currentCandidates,0);
  await h.unchangedLegacy();
});
