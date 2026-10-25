import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';

// Offline evidence only. No fixture is imported by a running monitor.
const MINUTE=60000,T0=Date.parse('2026-10-10T10:00:00Z'),NOW=T0+15000,iso=t=>new Date(t).toISOString();
const CA='0x'+'a'.repeat(40),SOL_CA='8jY86w2GVQQ79TW8EnU9CVswUyk6x66FJnWcVADCDuwj';
const VERSION='reconstructed_ohlcv_entry_v1';
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true};
function bars(route,now=NOW) {
  let rows;
  if(route==='external_breakout')rows=Array.from({length:30},(_,i)=>{
    const p=i<8?.8+i*.025:1;return i===29?[1,1.035,.999,1.03,180]:[p,p+.01,p-.005,p,100];
  });
  if(route==='external_trend')rows=Array.from({length:30},(_,i)=>{
    const p=1+i*.006;return [p-.001,p+.002,p-.002,p,i===29?130:100];
  });
  if(route==='external_pullback') {
    rows=[...Array.from({length:15},(_,i)=>{const p=.7+i*.035;return [p-.01,p+.01,p-.02,p,100];}),
      [1.2,1.3,1.19,1.29,200],[1.29,1.3,1.15,1.16,150],[1.16,1.3,1.02,1.04,110],
      ...Array.from({length:12},()=>[1.04,1.05,1.02,1.04,100]),
      [1.04,1.05,1.015,1.03,100],[1.03,1.035,1.02,1.025,90],[1.025,1.055,1.025,1.05,160]];
    rows.slice(0,15).forEach(r=>{if(r[1]>1.05525)r[1]=1.3;});
  }
  const closedAt=Math.floor(now/MINUTE)*MINUTE;
  return rows.map(([open,high,low,close,volume],i)=>({time:closedAt-(rows.length-i)*MINUTE,open,high,low,close,volume}));
}
function input(route='external_breakout',chain='bsc',now=NOW) {
  const candles=bars(route,now),price=candles.at(-1).close,address=chain==='sol'?SOL_CA:CA;
  const token={chain,address,symbol:'OFFLINE_ONLY',price,marketStage:'external',liquidity:60000,volume:5000,
    isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0,
    ...(chain==='sol'?{renouncedMint:true,renouncedFreezeAccount:true}:{})};
  return {...modes,token,nowMs:now,observedAt:iso(now),priceObservedAt:iso(now),marketStatus:'ok',requireFastQuote:true,
    compoundingCash:100,klineStatus:'ok',candles,flow:{},
    quoteHistory:[-4000,0].map(d=>({...token,status:'ok',price:d?price*.998:price,observedAt:iso(now+d)}))};
}
const evaluate=i=>evaluatePaperStrategies(i)[0];
const account=now=>({...createPaperStrategyAccount({nowMs:now}),estimatedCostModel:ESTIMATED_COST_VERSION});
const fill=(row,now=NOW)=>advancePaperStrategyAccount(account(Date.parse(row.observedAt)),{...modes,evaluations:[row],nowMs:now});
const mutateQuotes=(row,mutate)=>{
  mutate(row.evidence.recoveryEntry.quotes);
  row.evidence.confirmedPolicy.confirmation.rows=row.evidence.recoveryEntry.quotes.map(({price,observedAt})=>({price,observedAt}));
};

for(const chain of ['bsc','sol','robinhood'])for(const route of ['external_breakout','external_trend','external_pullback']) {
  test(`reconstructed ${chain} ${route} remains eligible in the actual estimated recovery mode without changing inputs`,()=>{
    const i=input(route,chain),original=structuredClone(i),row=evaluate(i),before=structuredClone(row);
    assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons,routes:row.evidence.opportunityRoutes}));
    assert.equal(row.evidence.opportunity.id,route);assert.deepEqual(i,original);
    const next=fill(row),buy=next.trades[0];
    assert.equal(next.trades.length,1);assert.equal(buy.side,'buy');assert.equal(buy.chain,chain);
    assert.equal(buy.entryEvidence.structureValidation.version,VERSION);
    assert.equal(next.positions[`${chain}:${i.token.address}`].entryEvidence.structureValidation.version,VERSION);
    assert.equal(buy.entryEvidence.costAssumptions.version,ESTIMATED_COST_VERSION);
    assert.equal(validatePaperStrategyAccount(next),true);assert.deepEqual(row,before);
    assert.equal(next.execution,false);assert.equal(next.signing,false);assert.equal(next.broadcast,false);
  });
}

for(const route of ['external_breakout','external_trend','external_pullback']) {
  test(`${route} writer rechecks the raw source quotes instead of trusting ready flags`,()=>{
    const row=evaluate(input(route));assert.equal(fill(row).trades.length,1);
    const cases=[
      ['empty',q=>q.splice(0)],
      ['duplicate_time',q=>{q[0].observedAt=q[1].observedAt;}],
      ['duplicate_identical_quote',q=>{q[0]={...q[1]};}],
      ['falling',q=>{q[0].price=q[1].price*1.01;}],
      ['one_second_apart',q=>{q[0].observedAt=iso(NOW-1000);}],
      ['wrong_ca',q=>q.forEach(x=>{x.address='0x'+'b'.repeat(40);})],
      ['wrong_chain',q=>q.forEach(x=>{x.chain='robinhood';})],
      ['stale',q=>q.forEach((x,j)=>{x.observedAt=iso(NOW-20000+j*4000);})],
      ['future',q=>{q[1].observedAt=iso(NOW+1);}],
      ['price_disagrees_with_token',q=>q.forEach(x=>{x.price*=1.001;})],
    ];
    for(const [label,mutate] of cases) {
      const forged=structuredClone(row);mutateQuotes(forged,mutate);
      assert.equal(forged.decision,'可模拟');assert.equal(forged.evidence.paperEligible,true);
      assert.equal(fill(forged).trades.length,0,label);
    }
    for(const [label,mutate] of [
      ['missing_confirmation_copy',r=>{r.evidence.confirmedPolicy.confirmation.rows=[];}],
      ['reordered_confirmation_copy',r=>{r.evidence.confirmedPolicy.confirmation.rows.reverse();}],
      ['conflicting_confirmation_copy',r=>{r.evidence.confirmedPolicy.confirmation.rows[0].price*=1.001;}],
      ['forged_confirmation_count',r=>{r.evidence.confirmedPolicy.confirmation.count=999;}],
      ['forged_confirmation_time',r=>{r.evidence.confirmedPolicy.confirmation.confirmedAt=iso(NOW-1);}],
      ['forged_success_stamp',r=>{r.evidence.structureValidation={version:VERSION,ready:true};r.evidence.recoveryEntry.quotes=[];}],
    ]) {
      const forged=structuredClone(row);mutate(forged);assert.equal(fill(forged).trades.length,0,label);
    }
    const i=input(route);i.quoteHistory=[];
    assert.notEqual(evaluate(i).decision,'可模拟','normal evaluator already fails without quote evidence');
  });

  test(`${route} rejects invented target/support or candles even when proposed net economics still look attractive`,()=>{
    const row=evaluate(input(route));
    const cases=[
      ['plan_target',r=>{r.evidence.entryPlan.targetPrice*=1.05;}],
      ['pattern_and_plan_target',r=>{r.evidence.entryPlan.targetPrice*=1.05;r.evidence.opportunity.pattern.targetPrice=r.evidence.entryPlan.targetPrice;}],
      ['plan_support',r=>{r.evidence.entryPlan.stopPrice=r.token.price*.999;}],
      ['pattern_and_plan_support',r=>{r.evidence.entryPlan.stopPrice=r.token.price*.999;r.evidence.opportunity.pattern.support=r.evidence.entryPlan.stopPrice;}],
      ['signal_close',r=>{r.evidence.opportunity.pattern.close*=.99;}],
      ['malformed_last_candle',r=>{r.evidence.recoveryEntry.candles.at(-1).high=0;}],
      ['recent_candle_gap',r=>{r.evidence.recoveryEntry.candles.splice(-5,1);}],
      ['source_shape_changed',r=>{const c=r.evidence.recoveryEntry.candles.at(-1);c.open=c.close*.9;c.close*=.9;c.low=c.close*.99;}],
      ['source_identity_changed',r=>{r.evidence.recoveryEntry.address='0x'+'b'.repeat(40);}],
      ['closed_candle_copy_conflict',r=>{r.evidence.opportunity.closedCandles.at(-1).volume+=1;}],
      ['missing_evaluation_clock',r=>{delete r.evidence.opportunity.evaluatedAt;}],
      ['future_evaluation_clock',r=>{r.evidence.opportunity.evaluatedAt=iso(NOW+1);}],
    ];
    for(const [label,mutate] of cases) {
      const forged=structuredClone(row);mutate(forged);
      assert.equal(fill(forged).trades.length,0,label);
    }
  });
}

test('a valid frozen signal can cross a minute during serialization while its real quote is still fresh',()=>{
  const evaluatedAt=T0+59998,writeAt=T0+60002,row=evaluate(input('external_breakout','bsc',evaluatedAt));
  const before=structuredClone(row),next=fill(row,writeAt);
  assert.equal(next.trades.length,1);assert.equal(next.trades[0].atMs,writeAt);
  assert.equal(next.trades[0].entryEvidence.structureValidation.version,VERSION);assert.deepEqual(row,before);
  assert.equal(fill(row,evaluatedAt+5001).trades.length,0,'expired latest quote cannot borrow the frozen evaluation clock');
});

test('Solana raw source quote identities remain case-sensitive at the final writer',()=>{
  const row=evaluate(input('external_breakout','sol'));
  const forged=structuredClone(row);mutateQuotes(forged,q=>q.forEach(x=>{x.address=SOL_CA.toLowerCase();}));
  assert.equal(fill(forged).trades.length,0);
  assert.equal(fill(row).trades.length,1);
});

test('persisted old positions lacking entry reconstruction metadata keep their original exit policy and buy history',()=>{
  const main=fill(evaluate(input())),key=`bsc:${CA}`,position=main.positions[key];
  delete position.entryEvidence.structureValidation;delete main.trades[0].entryEvidence.structureValidation;
  delete position.entryEvidence.opportunity.evaluatedAt;delete main.trades[0].entryEvidence.opportunity.evaluatedAt;
  assert.equal(validatePaperStrategyAccount(main),true);
  const priorBuy=structuredClone(main.trades[0]),now=NOW+3*MINUTE;
  const rows=Array.from({length:30},(_,i)=>({time:T0+(i-27)*MINUTE,open:1.04,high:1.05,low:1.03,close:1.04,volume:100}));
  [.99,.98,.96].forEach((close,i)=>{rows[27+i]={...rows[27+i],open:close+.01,high:close+.015,low:close-.01,close,volume:i===2?200:100};});
  const mark={chain:'bsc',address:CA,status:'ok',price:.96,observedAt:iso(now),
    structureChart:{...opportunityChart(rows,'ok',now),chain:'bsc',address:CA}};
  const closed=advancePaperStrategyAccount(main,{...modes,marks:[mark],nowMs:now,enabled:false});
  assert.equal(closed.trades.length,2);assert.equal(closed.trades[1].side,'sell');
  assert.deepEqual(closed.trades[0],priorBuy);assert.equal(validatePaperStrategyAccount(closed),true);
});
