import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildInnerTradeFixture,buildInnerTradeLog,innerTradeTestHash as hash,INNER_TRADE_TEST_CA as CA,INNER_TRADE_TEST_NOW as NOW} from './helpers/inner-trade-fixture.js';
import {buildCollectiveWire,ONCHAIN_BURST_VERSION,validCollectiveSignal} from '../src/paper-collective-signal.js';
import {buildOnchainTradeFlow} from '../src/paper-onchain-flow.js';
import {paperEventTriggers} from '../src/paper-event-triggers.js';
import {createPaperStrategyRuntime,selectInnerTradeTargets} from '../src/paper-strategy-runtime.js';
import {createPaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createConfirmedPaperSession,createEstimatedPaperSession,LEGACY_PAPER_FILE} from '../src/paper-account-session.js';
import {GMGN_THREE_LISTS} from '../src/paper-discovery-scope.js';

const iso=n=>new Date(n).toISOString(),address=n=>'0x'+n.toString(16).padStart(40,'0');
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true,evidenceGapExitMode:false};
const token={chain:'bsc',address:CA,symbol:'RAW',price:1,marketStage:'internal',platform:'four_v2',creationTimestamp:NOW-150000,
  liquidity:60000,volume:10000,buyTax:0,sellTax:0,isHoneypot:false,isWashTrading:false,
  rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01};
function burst() {
  const p=buildInnerTradeFixture();
  const baseline={number:140,hash:hash(140),parentHash:hash(139),timestamp:NOW/1000-60};p.blocks.push(baseline);
  p.logs=[1,2].map(n=>buildInnerTradeLog(p,'buy',baseline,n,CA,400+n,{wallet:address(n),quoteAmount:.1}));
  p.logs.push(...[1,2,3].map(n=>buildInnerTradeLog(p,'buy',p.toBlock,n,CA,500+n,{wallet:address(n),quoteAmount:.4})));
  return p;
}
test('ranking does not evict up to four watched fresh internal CAs below the discovery cap',()=>{
  const rows=Array.from({length:40},(_,n)=>({token:{...token,address:address(n+100),volume:1000-n},observedAt:iso(NOW)}));
  const watchedTargets=rows.slice(30,35).map(r=>r.token);
  const select=()=>selectInnerTradeTargets(rows,{nowMs:NOW,listedForEntry:t=>t.address!==rows[31].token.address,watchedTargets});
  let selected=select();assert.equal(selected.length,27);
  assert.ok(selected.some(t=>t.address===rows[30].token.address));
  assert.ok(!selected.some(t=>t.address===rows[31].token.address),'no longer listed is not retained');
  assert.ok(!selected.some(t=>t.address===rows[34].token.address),'watch retention capped at four');
  rows[30].observedAt=iso(NOW-120001);rows[32].token.marketStage='external';rows[33].observedAt=iso(NOW+1);
  selected=select();assert.equal(selected.length,24,'stale, migrated, or future evidence cannot extend a lease');
});
test('raw ordinary-wallet proof makes its own signal/flow without GMGN tags; tampering and gaps never fill from tagged data',()=>{
  const proof=burst(),state={windows:[proof]},signal=buildCollectiveWire({onchainState:state,nowMs:NOW,allowBurst:true}).signals[0];
  assert.equal(signal?.version,ONCHAIN_BURST_VERSION);assert.equal(signal.groupCount,3);assert.equal(signal.volumeUsd,1200);
  assert.equal(signal.acceleration,12);assert.equal(signal.provider,'bsc_portal_logs');assert.ok(validCollectiveSignal(signal,token,NOW));
  const flow=buildOnchainTradeFlow({state,token,nowMs:NOW});assert.equal(flow.complete,true);assert.equal(flow.netBuyUsd,1400);
  assert.equal(flow.wallets.length,3);assert.ok(flow.wallets.every(w=>!w.highProfit&&!w.tags.length));
  const event=paperEventTriggers({evidence:{innerTradeState:state},chains:['bsc'],nowMs:NOW,allowBurst:true})[0];
  assert.equal(event.id,signal.id);assert.equal(event.source,'onchain_internal_burst');
  const duplicated=structuredClone(proof);duplicated.logs.push(structuredClone(proof.logs[2]));
  assert.equal(buildCollectiveWire({onchainState:{windows:[duplicated]},nowMs:NOW,allowBurst:true}).signals[0].id,signal.id);
  for(const mutate of [p=>p.range.complete=false,p=>p.metadata.tokenAddress=address(99),p=>p.logs=p.logs.slice(2),
    p=>p.logs[2].removed=true,p=>p.logs[2].blockHash=hash(888),p=>p.toBlock.timestamp+=100,
    p=>{p.logs[3].transactionHash=p.logs[2].transactionHash;p.logs[3].transactionIndex=p.logs[2].transactionIndex;}]) {
    const p=structuredClone(proof);mutate(p);
    assert.equal(buildCollectiveWire({onchainState:{windows:[p]},nowMs:NOW,allowBurst:true}).signals.length,0,mutate.toString());
  }
  assert.equal(buildOnchainTradeFlow({state,token,nowMs:NOW+31000}).complete,false);
  assert.equal(buildOnchainTradeFlow({state:{windows:[]},token,nowMs:NOW}).complete,false);
});

test('runtime routes raw logs through no-chart simulated entry, frozen ordinary cohort, telemetry and restart dedup',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-onchain-runtime-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-onchain-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-onchain-test',nowMs:NOW});
  let clock=NOW,charts=0,quotes=0,stops=0,refreshArgs=null,holdRefresh=false,finishRefresh;
  const internalTradeMonitor={snapshot:()=>({status:'ready',windows:[burst()],checks:[],lastRound:{rpcItems:0}}),
    refresh:async args=>{refreshArgs=args;if(holdRefresh)await new Promise(resolve=>{finishRefresh=resolve;});},stop:async()=>{finishRefresh?.();stops++;}};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],now:()=>clock,discoveryMode:GMGN_THREE_LISTS,
    evidenceLoader:()=>({flowState:{},events:[]}),internalTradeMonitor,intervalMs:60000,marketIntervalMs:60000,
    market:{trending:async()=>({status:'ok',observedAt:iso(clock),interval:'5m',tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[token]}),
      details:async()=>({status:'ok',observedAt:iso(clock),token}),quote:async()=>{quotes++;return {...token,status:'ok',observedAt:iso(clock)};},
      kline:async()=>{charts++;return {status:'unavailable',candles:[]};}}};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();await r.setEnabled(true);await r.fastOnce();await r.refreshDetails();await r.fastOnce();
    await r.refreshQuote();await r.fastOnce();
    const s=r.snapshot();assert.equal(charts,0);assert.equal(quotes,1);
    assert.equal(s.account.trades.length,1,JSON.stringify({a:s.algorithmSignals,e:s.evaluations.map(x=>({d:x.decision,m:x.missing,r:x.reasons}))}));
    const p=Object.values(s.account.positions)[0];assert.equal(p.entryEvidence.collectiveSignal.version,ONCHAIN_BURST_VERSION);
    assert.equal(p.entryEvidence.flowDiagnostics.provider,'bsc_portal_logs');assert.equal(p.entryEvidence.memeExitContext.provider,'bsc_portal_logs');
    assert.deepEqual(p.entryEvidence.memeExitContext.smartBuyers,[]);assert.deepEqual(p.entryEvidence.memeExitContext.cohortBuyers,[1,2,3].map(address));
    assert.equal(s.algorithmSignals.filled,1);assert.equal(s.algorithmSignals.onchainCoverage.windows,undefined);
    assert.equal(s.account.execution,false);assert.equal(s.account.broadcast,false);assert.equal(s.account.signing,false);
    assert.ok(validatePaperStrategyAccount(s.account));holdRefresh=true;
    await Promise.race([r.refreshEvents(),new Promise((_,reject)=>setTimeout(()=>reject(Error('RPC blocked local event pump')),500))]);
    assert.ok(refreshArgs.tokens.some(x=>x.address===CA&&x.held===true),'held onchain cohort stays in collection even if lists change');
    finishRefresh();holdRefresh=false;
    await r.stop();assert.equal(stops,1);clock+=1000;r=createPaperStrategyRuntime(options);await r.runOnce();
    assert.equal(r.snapshot().account.trades.length,1);assert.ok(validatePaperStrategyAccount(r.snapshot().account));
  }finally{await r.stop();}
});
