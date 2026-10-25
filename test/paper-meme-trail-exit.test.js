import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPaperNewsWire} from '../src/paper-news-wire.js';
import {kolEvent} from './fixtures/paper-narrative-recall.js';
import {createNarrativeResearchIndex} from '../src/paper-narrative-thesis.js';
import {buildCollectiveWire} from '../src/paper-collective-signal.js';
import {buildPaperFlowEvidence} from '../src/paper-strategy-evidence.js';
import {evaluatePaperStrategies,advancePaperStrategyAccount,createPaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
import {assessMemeExit,LEGACY_MEME_EXIT_POLICY,MEME_EXIT_STRUCTURE_OBSERVATION_VERSION} from '../src/paper-meme-exit.js';

const NOW=Date.parse('2026-10-10T10:00:00Z'),iso=n=>new Date(n).toISOString(),CA='0x'+'a'.repeat(40);
const wallet=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true,evidenceGapExitMode:false};
const token={chain:'bsc',address:CA,symbol:'OFFLINE_ONLY',price:1,marketStage:'internal',creationTimestamp:NOW-840000,
  liquidity:60000,volume:10000,buyTax:0,sellTax:0,isHoneypot:false,isWashTrading:false,
  rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01};

function account(route='launch') {
  let proof;
  if(route==='launch') {
    const signal=buildPaperNewsWire({events:[{...kolEvent(`BSC OFFLINE launch ${CA}`,NOW-1500),chain:'bsc'}],nowMs:NOW}).paperSignals[0];
    proof={flow:{},monitorSignal:signal,narrativeResearchIndex:createNarrativeResearchIndex({nowMs:NOW})};
  } else {
    const profiles={};
    for(let i=1;i<=3;i++)profiles[`bsc:${wallet(i)}`]=Object.fromEntries(['7d','30d'].map(period=>[period,{
      chain:'bsc',wallet:wallet(i),period,checkedAt:iso(NOW-5000),realizedProfitUsd:20000,realizedRoi:.1,winRate:.7,
      tokenCount:150,buyCount:200,sellCount:150,tags:['smart_money'],createdAt:Math.floor(NOW/1000)-90*86400,
      lastTradeAt:Math.floor(NOW/1000)-10,createdTokenCount:0}]));
    const feedCoverage=Object.fromEntries(['smartmoney','kol'].map(k=>[k,{valid:true,startAt:NOW-360000,endAt:NOW,observedAt:NOW,keys:[]}]));
    const state={chains:{bsc:{status:'healthy',feedCoverage}},profiles,trades:{bsc:[1,2,3].map(n=>({chain:'bsc',tokenAddress:CA,wallet:wallet(n),
      side:'buy',amountUsd:200,at:NOW-(4-n)*1000,hash:hash(n),tags:['smart_money']}))}};
    proof={flow:buildPaperFlowEvidence({state,chain:'bsc',address:CA,nowMs:NOW}),collectiveSignal:buildCollectiveWire({state,nowMs:NOW}).signals[0]};
  }
  const row=evaluatePaperStrategies({...modes,token:structuredClone(token),marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),
    nowMs:NOW,compoundingCash:100,requireFastQuote:true,candles:[],klineStatus:'unavailable',...proof,
    quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}]})[0];
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  const initial={...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION};
  const a=advancePaperStrategyAccount(initial,{...modes,evaluations:[row],nowMs:NOW});
  assert.equal(a.trades.length,1);assert.equal(validatePaperStrategyAccount(a),true);
  return a;
}

function brokenTrail() {
  // All candles postdate creation; the pivot and both right-side confirmation
  // bars are wholly post-entry. The final two are below 1.30, not three bars.
  const rows=Array.from({length:24},(_,i)=>({time:NOW+(i-14)*60000,open:1.5,close:1.5,high:1.55,low:1.45,volume:100}));
  rows[18]={...rows[18],open:1.38,close:1.37,high:1.4,low:1.3};
  rows[19]={...rows[19],open:1.4,close:1.5,high:1.53,low:1.36};
  rows[20]={...rows[20],open:1.5,close:1.55,high:1.6,low:1.45};
  rows[21]={...rows[21],open:1.55,close:1.6,high:1.65,low:1.5};
  rows[22]={...rows[22],open:1.32,close:1.29,high:1.33,low:1.28};
  rows[23]={...rows[23],open:1.29,close:1.27,high:1.3,low:1.26};
  return {...token,status:'ok',observedAt:iso(NOW+600000),price:1.27,
    structureChart:{...opportunityChart(rows,'ok',NOW+600000),chain:token.chain,address:CA}};
}
function absorption(mark) {
  const at=Date.parse(mark.observedAt);
  return {...token,provider:'gmgn',status:'healthy',fresh:true,complete:true,observedAt:mark.observedAt,netBuyUsd:600,
    wallets:[1,2].map(n=>({wallet:wallet(n),buyUsd:300,sellUsd:0,netBuyUsd:300,tags:['smart_money'],lastBuyAt:at,lastSellAt:null}))};
}

for(const route of ['launch','collective'])test(`legal ${route} lot exits on independently confirmed trail below EMA, preserving frozen entry and V1`,()=>{
  const a=JSON.parse(JSON.stringify(account(route))),before=structuredClone(a),p=Object.values(a.positions)[0],m=brokenTrail();
  assert.ok(p.launchThesis||p.collectiveThesis);assert.equal(p.tradeThesis,undefined);
  assert.notEqual(p.entryEvidence.opportunity.basis,'ohlcv');
  const d=assessMemeExit(p,m,NOW+600000);
  assert.equal(d.structureObservationVersion,MEME_EXIT_STRUCTURE_OBSERVATION_VERSION);
  assert.equal(d.trailStructure.referenceLevel,1.3);assert.ok(d.baseStructure.referenceLevel>1.3);
  assert.equal(d.structure.referenceLevel,1.3,'actual exit/re-entry evidence uses the independently broken level, not EMA');
  assert.equal(d.trailStructure.twoBelow,true);assert.equal(d.trailStructure.threeBelow,false);
  assert.equal(d.structure.heavyBreak,false);assert.equal(d.structure.distribution,false);
  assert.equal(d.flow.absorption,false);assert.equal(d.exit,true);assert.match(d.reason,/抬高低点/);
  assert.equal(d.comparison.exit,false,'V1 still has no independent confirmed-trail branch');
  const legacy=assessMemeExit({...p,memeExitPolicy:LEGACY_MEME_EXIT_POLICY},m,NOW+600000);
  assert.equal(legacy.exit,false);assert.equal(legacy.trailStructure,undefined);
  const next=advancePaperStrategyAccount(a,{...modes,marks:[m],nowMs:NOW+600000,enabled:false});
  assert.equal(next.trades.length,2);assert.equal(next.trades[1].price,m.price);
  assert.ok(next.trades[1].costsUsd>0);assert.equal(next.trades[1].exitEvidence.activeStopPrice,null);
  assert.equal(next.trades[1].exitEvidence.thesisDecision.structureObservationVersion,MEME_EXIT_STRUCTURE_OBSERVATION_VERSION);
  assert.equal(next.trades[1].exitEvidence.thesisDecision.structure.referenceLevel,1.3);
  assert.deepEqual(next.trades[0],a.trades[0]);assert.deepEqual(a,before);assert.equal(validatePaperStrategyAccount(next),true);
});

test('trail evidence does not manufacture exits from foreign, stale, future, repeated, gapped or single-bar observations',()=>{
  const p=Object.values(account().positions)[0];
  for(const change of [
    m=>m.address=wallet(99),m=>m.structureChart.address=wallet(99),m=>m.structureChart.chain='sol',
    m=>m.observedAt=iso(NOW+600001),m=>m.observedAt=iso(NOW+584999),
    m=>m.structureChart.rows.push({...m.structureChart.rows[5]}),m=>m.structureChart.rows.splice(5,1),
    m=>m.structureChart.rows[5].time+=1000,m=>m.structureChart.rows.at(-1).time=NOW+600000,
    m=>Object.assign(m.structureChart.rows[22],{open:1.36,high:1.37,low:1.33,close:1.34}),
    m=>m.price=1.31,m=>m.structureChart.ready=false,
  ]) {
    const m=brokenTrail();change(m);const d=assessMemeExit(p,m,NOW+600000);
    assert.equal(d.exit,false,change.toString());assert.equal(d.structureObservationVersion,MEME_EXIT_STRUCTURE_OBSERVATION_VERSION);
  }
});

test('real fresh absorption may defer quiet trail breaks, but original EMA heavy breaks remain independent',()=>{
  const p=Object.values(account().positions)[0],m=brokenTrail();m.flow=absorption(m);
  const supported=assessMemeExit(p,m,NOW+600000);
  assert.equal(supported.flow.absorption,true);assert.equal(supported.exit,false);assert.equal(supported.status,'supported_pullback');
  Object.assign(m.structureChart.rows[22],{open:1.44,close:1.42,high:1.45,low:1.41});
  Object.assign(m.structureChart.rows[23],{open:1.43,close:1.41,high:1.44,low:1.40,volume:200});m.price=1.41;
  const broken=assessMemeExit(p,m,NOW+600000);
  assert.equal(broken.trailStructure.twoBelow,false,'price is still above the confirmed low');
  assert.equal(broken.structure.heavyBreak,true);assert.equal(broken.flow.absorption,true);
  assert.deepEqual(broken.structure,broken.baseStructure,'the stronger base exit keeps its actual reference for later re-entry checks');
  assert.equal(broken.exit,true);assert.match(broken.reason,/下跌放量/);
});
