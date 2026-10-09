import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInnerTradeFixture,buildInnerTradeLog,innerTradeTestHash as h,INNER_TRADE_TEST_NOW as NOW,INNER_TRADE_TEST_CA as CA} from './helpers/inner-trade-fixture.js';
import {buildCollectiveWire,ONCHAIN_BURST_VERSION} from '../src/paper-collective-signal.js';
import {buildOnchainTradeFlow} from '../src/paper-onchain-flow.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {memeEntryContext,memeExitEvaluation} from '../src/paper-meme-exit.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';
import {paperLossLearning} from '../src/paper-loss-learning.js';
import {compareConfirmedCandidates} from '../src/paper-trader-reasoning.js';
import {depthFixture} from './helpers/internal-depth-fixture.js';

const iso=n=>new Date(n).toISOString(),address=n=>'0x'+n.toString(16).padStart(40,'0');
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true,evidenceGapExitMode:false};
function input() {
  const window=buildInnerTradeFixture('four_v2',NOW),baseline={number:150,hash:h(150),parentHash:h(149),timestamp:NOW/1000-70};
  window.blocks.push(baseline);
  window.logs=[...Array.from({length:2},(_,i)=>buildInnerTradeLog(window,'buy',baseline,i,CA,500+i,{wallet:address(i+1),quoteAmount:.1,transactionIndex:i})),
    ...Array.from({length:3},(_,i)=>buildInnerTradeLog(window,'buy',window.blocks[1],i,CA,510+i,{wallet:address(i+1),quoteAmount:.4,transactionIndex:i}))];
  const innerTradeState={windows:[window]};
  const token={chain:'bsc',address:CA,symbol:'OFFLINE',price:1,marketStage:'internal',creationTimestamp:NOW-120000,
    liquidity:60000,volume:10000,buyTax:0,sellTax:0,isHoneypot:false,isWashTrading:false,
    rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01};
  const collectiveSignal=buildCollectiveWire({onchainState:innerTradeState,allowBurst:true,nowMs:NOW}).signals[0];
  assert.equal(collectiveSignal?.version,ONCHAIN_BURST_VERSION);
  return {...modes,token,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),nowMs:NOW,
    compoundingCash:100,requireFastQuote:true,candles:[],klineStatus:'unavailable',collectiveSignal,
    flow:buildOnchainTradeFlow({state:innerTradeState,token,nowMs:NOW}),quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}]};
}
function evaluate(i=input()) {
  const row=evaluatePaperStrategies(i)[0];
  return memeExitEvaluation(row,memeEntryContext(row.token,i,NOW));
}
const account=()=>({...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION});
const advance=row=>advancePaperStrategyAccount(account(),{...modes,evaluations:[row],nowMs:NOW});

test('ordinary onchain burst enters only its own paper route and freezes restart-valid source/cohort',()=>{
  const row=evaluate();assert.equal(row.decision,'可模拟',JSON.stringify({m:row.missing,r:row.reasons}));
  assert.equal(row.evidence.entryPlan.entryPolicyVersion,ONCHAIN_BURST_VERSION);
  assert.equal(row.evidence.opportunity.id,'onchain_internal_burst');
  assert.equal(row.evidence.lossRepair.group,'onchain_internal_burst');
  assert.equal(row.evidence.recoveryCheck.requiresChart,false);
  assert.match(row.label,/普通地址/);assert.match(row.entryLogic,/不等待GMGN盈利标签或K线/);
  const a=advance(row),p=Object.values(a.positions)[0];assert.equal(a.trades.length,1);
  assert.deepEqual(p.entryEvidence.memeExitContext.smartBuyers,[]);
  assert.deepEqual(p.entryEvidence.memeExitContext.cohortBuyers,p.entryEvidence.collectiveSignal.buyers.map(w=>w.wallet));
  assert.equal(p.entryEvidence.flowDiagnostics.provider,'bsc_portal_logs');
  assert.ok(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))));
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
  assert.ok(paperLossLearning(a,NOW).routePerformance.groups.some(g=>g.id==='onchain_internal_burst'&&g.label.includes('普通地址')));
  const older=structuredClone(row);older.evidence.opportunity.signalAt--;
  assert.ok(compareConfirmedCandidates(row,older)<0,'eligible ordinary burst uses its explicit catalyst-recency lane');
});

for(const liquidity of [null,.0025,50,999])test(`ordinary onchain burst with liquidity ${liquidity} waits for exact-order proof, then persists no-chart paper entry`,()=>{
  const i=input();i.token.liquidity=liquidity;
  const waiting=evaluate(i);assert.equal(waiting.entryUsd,10);assert.equal(advance(waiting).trades.length,0);
  i.internalDepth=depthFixture(i.token,waiting.entryUsd,waiting.evidence.costAssumptions.notionalUsd,NOW);
  const row=evaluate(i),a=advance(row);assert.equal(a.trades.length,1,JSON.stringify({m:row.missing,r:row.reasons}));
  assert.equal(row.evidence.recoveryCheck.requiresChart,false);
  assert.ok(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))));
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
});

test('engine rejects missing/mislabeled/truncated or corrupted ordinary exit cohorts without creating a fill',()=>{
  const row=evaluate();
  for(const mutate of [r=>delete r.evidence.memeExitContext,r=>r.evidence.memeExitContext.provider='gmgn',
    r=>r.evidence.flowDiagnostics.provider='gmgn',r=>r.evidence.memeExitContext.smartBuyers=[address(1)],
    r=>r.evidence.memeExitContext.cohortBuyers=[],r=>r.evidence.memeExitContext.cohortBuyers[0]=address(99),
    r=>r.evidence.memeExitContext.cohortBuyers.push(address(1)),r=>r.evidence.memeExitContext.cohortTruncated=true]) {
    const r=structuredClone(row);mutate(r);assert.equal(advance(r).trades.length,0,mutate.toString());
  }
  const a=advance(row),p=Object.values(a.positions)[0];p.entryEvidence.memeExitContext.cohortBuyers[0]=address(99);
  assert.throws(()=>validatePaperStrategyAccount(a),/onchain entry cohort/);
});

test('ordinary burst does not bypass safety, phase, native-quote proof or stale actual price checks',()=>{
  for(const mutate of [i=>i.token.marketStage='external',i=>i.token.stageConflict=true,i=>i.token.isHoneypot=true,
    i=>i.token.sellTax=.07,i=>i.quoteHistory=[],i=>i.priceObservedAt=iso(NOW-6000),
    i=>i.collectiveSignal.proof.window.range.complete=false]) {
    const i=input();mutate(i);assert.equal(advance(evaluate(i)).trades.length,0,mutate.toString());
  }
});

test('learning separates only entry-time verified ordinary bursts; corrupt proofs and route labels never become evidence',()=>{
  const a=advance(evaluate()),buy=a.trades[0];
  a.trades.push({id:'offline-close',side:'sell',chain:'bsc',address:CA,quantity:buy.quantity,atMs:NOW+1000,costsUsd:.1,realizedPnl:-1});
  const before=structuredClone(a),r=paperLossLearning(a,NOW+1000);
  assert.equal(r.lessons.find(x=>x.id==='entry_evidence').closedRounds,0);
  assert.equal(r.lessons.find(x=>x.id==='onchain_burst_context').closedRounds,1);
  assert.match(r.lessons.find(x=>x.id==='onchain_burst_context').action,/无已核叙事\/盈利画像/);
  assert.equal(r.routePerformance.groups.find(g=>g.id==='verified_wallet').closedRounds,0);
  assert.deepEqual(a,before);
  for(const mutate of [e=>e.collectiveSignal.proof.window.range.complete=false,e=>delete e.collectiveSignal,
    e=>e.collectiveSignal.proof.window.toBlock.timestamp+=100]) {
    const b=structuredClone(a);mutate(b.trades[0].entryEvidence);
    const invalid=paperLossLearning(b,NOW+1000);
    assert.equal(invalid.lessons.find(x=>x.id==='entry_evidence').closedRounds,1);
    assert.equal(invalid.lessons.some(x=>x.id==='onchain_burst_context'),false);
  }
});
