import test from 'node:test';
import assert from 'node:assert/strict';
import {PULLBACK_TARGET_SELECTION_VERSION,pullbackTargetSelection,reviewStructurePattern,structureEconomics} from '../src/paper-opportunity-review.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
import {estimatedPaperCosts} from '../src/paper-estimated-cost.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';

const NOW=Date.parse('2026-10-10T10:00:00Z'),iso=ms=>new Date(ms).toISOString(),CA='0x'+'a'.repeat(40);
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true};
function candles({nearby=false}={}) {
  const values=[...Array.from({length:15},(_,i)=>{const p=.7+i*.035;return [p-.01,p+.01,p-.02,p,100];}),
    [1.2,1.3,1.19,1.29,200],[1.29,1.3,1.15,1.16,150],[1.16,1.3,1.02,1.04,110],
    ...Array.from({length:12},()=>[1.04,1.05,1.02,1.04,100]),
    [1.04,1.05,1.015,1.03,100],[1.03,1.035,1.02,1.025,90],[1.025,1.055,1.025,1.05,160]];
  // This passing fixture has no observed overhead price between 1.05525 and
  // 1.3. The negative variant adds a PRE-entry observed high of 1.06.
  values.slice(0,15).forEach(r=>{if(r[1]>1.05525)r[1]=1.3;});
  if(nearby)values[20][1]=1.06;
  return values.map(([open,high,low,close,volume],i)=>({time:NOW-(values.length-i)*60000,open,high,low,close,volume}));
}
function input(options) {
  const token={chain:'base',address:CA,symbol:'OFFLINE_ONLY',price:1.05,marketStage:'external',liquidity:60000,volume:5000,
    isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
  return {...modes,nowMs:NOW,token,observedAt:iso(NOW),priceObservedAt:iso(NOW),marketStatus:'ok',requireFastQuote:true,
    compoundingCash:100,candles:candles(options),klineStatus:'ok',flow:{},
    quoteHistory:[-4000,0].map(d=>({...token,price:d?1.048:1.05,status:'ok',observedAt:iso(NOW+d)}))};
}
const evaluate=i=>evaluatePaperStrategies(i)[0];
const fill=row=>advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,evaluations:[row],nowMs:NOW});

test('main pullback checks the nearer observed level, keeping the old peak as a separate upside scenario',()=>{
  const chart=opportunityChart(candles({nearby:true}),'ok',NOW),pattern={ready:true,reason:null,peak:1.3};
  const before=structuredClone({chart,pattern});
  const old=reviewStructurePattern({id:'external_pullback'},chart,1.05,pattern);
  const current=reviewStructurePattern({id:'external_pullback'},chart,1.05,pattern,{evidenceExit:true});
  const costs=estimatedPaperCosts('bsc',0,0,10);
  assert.equal(old.targetPrice,1.3,'comparison policy is unchanged');
  assert.equal(old.targetSelectionVersion,undefined);
  assert.equal(current.targetSelectionVersion,PULLBACK_TARGET_SELECTION_VERSION);
  assert.equal(current.targetPrice,1.06);assert.equal(current.nearbyObservedLevel,1.06);
  assert.equal(current.peak,1.3);assert.equal(current.upsideScenarioTargetPrice,1.3);
  assert.match(current.targetKind,/非确认强阻力/);
  assert.equal(structureEconomics(old,1.05,costs,10).ready,true);
  const economics=structureEconomics(current,1.05,costs,10);
  assert.ok(economics.netReferenceGainUsd<0);assert.equal(economics.ready,false);
  assert.deepEqual({chart,pattern},before,'selection does not rewrite source evidence');
});

test('without an intervening observed level the historical peak remains the scenario; other setups retain their targets',()=>{
  const chart=opportunityChart(candles(),'ok',NOW),pattern={ready:true,reason:null,peak:1.3,resistance:1,
    ema8:1.04,ema21:1.02,priorEma8:1.039,volumeMultiple:1.6};
  const target=pullbackTargetSelection(chart.rows,1.05);
  assert.equal(target.targetPrice,1.3);assert.equal(target.upsideScenarioTargetPrice,1.3);
  assert.equal(pullbackTargetSelection([],1.05).targetPrice,null,'no invented peak');
  for(const id of ['external_breakout','external_trend']) {
    const old=reviewStructurePattern({id},chart,1.05,pattern),current=reviewStructurePattern({id},chart,1.05,pattern,{evidenceExit:true});
    assert.equal(current.targetPrice,old.targetPrice,id);assert.equal(current.targetSelectionVersion,undefined,id);
  }
});

test('evaluation rejects insufficient local net space while a separately valid main pullback still fills',()=>{
  const good=evaluate(input()),before=structuredClone(good);
  assert.equal(good.decision,'可模拟',JSON.stringify({missing:good.missing,reasons:good.reasons,routes:good.evidence.opportunityRoutes}));
  assert.equal(good.evidence.opportunity.id,'external_pullback');
  assert.equal(fill(good).trades.length,1);assert.deepEqual(good,before);
  const bad=evaluate(input({nearby:true})),route=bad.evidence.opportunityRoutes.find(r=>r.id==='external_pullback');
  assert.equal(route.decision,'观察');assert.equal(route.signalReady,false);
  assert.match(route.reasons.join(' '),/结构空间不足/);
  assert.ok(fill(bad).trades.every(t=>t.entryEvidence.opportunity.id!=='external_pullback'));
});

test('writer reconstructs target from fresh identity-bound pre-entry candles, never accepting a forged distant peak or ready flags',()=>{
  const row=evaluate(input());assert.equal(fill(row).trades.length,1);
  for(const mutate of [
    r=>{r.evidence.entryPlan.targetPrice=1.4;},
    r=>{r.evidence.opportunity.pattern.targetPrice=1.4;r.evidence.entryPlan.targetPrice=1.4;},
    r=>{delete r.evidence.opportunity.pattern.targetSelectionVersion;},
    r=>{r.evidence.opportunity.pattern.upsideScenarioTargetPrice=1.4;},
    r=>{r.evidence.recoveryEntry.candles[20].high=1.06;},
    r=>{r.evidence.recoveryEntry.address='0x'+'b'.repeat(40);},
    r=>{r.evidence.recoveryEntry.observedAt=iso(NOW-120001);},
    r=>{r.evidence.recoveryEntry.candles.forEach(c=>c.time+=3600000);},
    r=>{r.evidence.recoveryEntry.candles.splice(22,1);},
  ]) {
    const forged=structuredClone(row);mutate(forged);
    assert.equal(fill(forged).trades.length,0,mutate.toString());
  }
  const rounded=structuredClone(row);rounded.evidence.entryPlan.targetPrice*=1+1e-12;
  assert.equal(fill(rounded).trades.length,1,'negligible serialization rounding is tolerated');
});

test('old frozen pullback positions without the new target version still load and exit under their recorded evidence policy',()=>{
  const main=fill(evaluate(input())),position=main.positions[`base:${CA}`];
  for(const evidence of [position.entryEvidence,main.trades[0].entryEvidence]) {
    delete evidence.opportunity.pattern.targetSelectionVersion;
    delete evidence.opportunity.pattern.nearbyObservedLevel;
    delete evidence.opportunity.pattern.upsideScenarioTargetPrice;
  }
  assert.equal(validatePaperStrategyAccount(main),true);
  const originalBuy=structuredClone(main.trades[0]),now=NOW+180000;
  const rows=Array.from({length:30},(_,i)=>({time:now-(30-i)*60000,open:1.04,high:1.05,low:1.03,close:1.04,volume:100}));
  [.99,.98,.96].forEach((close,i)=>{rows[27+i]={...rows[27+i],open:close+.01,high:close+.015,low:close-.01,close,volume:i===2?200:100};});
  const mark={chain:'base',address:CA,status:'ok',price:.96,observedAt:iso(now),
    structureChart:{...opportunityChart(rows,'ok',now),chain:'base',address:CA}};
  const closed=advancePaperStrategyAccount(main,{...modes,marks:[mark],nowMs:now,enabled:false});
  assert.equal(closed.trades.length,2);assert.equal(closed.trades[1].side,'sell');
  assert.deepEqual(closed.trades[0],originalBuy);assert.equal(validatePaperStrategyAccount(closed),true);
});
