import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {CONFIRMED_PAPER_VERSION} from '../src/paper-confirmed-policy.js';
import { evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { ESTIMATED_COST_VERSION } from '../src/paper-estimated-cost.js';
import { repairEntryReview } from '../src/paper-loss-repair.js';
import { externalStructureMainAdmissionEnabled,reviewExternalStructureMainAdmission,EXTERNAL_STRUCTURE_MAIN_ADMISSION_VERSION } from '../src/paper-external-structure-main-admission.js';

const T0=Date.parse('2026-10-10T10:00:00Z'),NOW=T0+15000,minute=60000,iso=t=>new Date(t).toISOString();
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,opportunityReviewMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true,evidenceTierGate:true};
function candles(route) {
  let rows;
  if(route==='external_breakout')rows=Array.from({length:30},(_,i)=>{const p=i<8?.8+i*.025:1;return i===29?[1,1.035,.999,1.03,180]:[p,p+.01,p-.005,p,100];});
  if(route==='external_trend')rows=Array.from({length:30},(_,i)=>{const p=1+i*.006;return [p-.001,p+.002,p-.002,p,i===29?130:100];});
  if(route==='external_pullback') {
    rows=[...Array.from({length:15},(_,i)=>{const p=.7+i*.035;return [p-.01,p+.01,p-.02,p,100];}),
      [1.2,1.3,1.19,1.29,200],[1.29,1.3,1.15,1.16,150],[1.16,1.3,1.02,1.04,110],
      ...Array.from({length:12},()=>[1.04,1.05,1.02,1.04,100]),
      [1.04,1.05,1.015,1.03,100],[1.03,1.035,1.02,1.025,90],[1.025,1.055,1.025,1.05,160]];
    rows.slice(0,15).forEach(r=>{if(r[1]>1.05525)r[1]=1.3;});
  }
  return rows.map(([open,high,low,close,volume],i)=>({time:T0-(rows.length-i)*minute,open,high,low,close,volume}));
}
function input(route='external_breakout',chain='bsc') {
  const bars=candles(route),price=bars.at(-1).close,address=chain==='sol'?'8jY86w2GVQQ79TW8EnU9CVswUyk6x66FJnWcVADCDuwj':'0x'+'a'.repeat(40);
  const token={chain,address,symbol:'OFFLINE_TEST_ONLY',price,marketStage:'external',liquidity:60000,volume:5000,
    isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0,
    ...(chain==='sol'?{renouncedMint:true,renouncedFreezeAccount:true}:{})};
  return {...modes,token,nowMs:NOW,observedAt:iso(NOW),priceObservedAt:iso(NOW),marketStatus:'ok',requireFastQuote:true,
    compoundingCash:100,klineStatus:'ok',candles:bars,flow:{},
    quoteHistory:[-4000,0].map(d=>({...token,status:'ok',price:d?price*.998:price,observedAt:iso(NOW+d)}))};
}
const row=(route,chain)=>evaluatePaperStrategies(input(route,chain))[0];
const account=()=>({...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION});
const fill=(r,options={})=>advancePaperStrategyAccount(account(),{...modes,evaluations:[r],nowMs:NOW,...options});

test('operator environment setting is strictly default-off; ambiguous values cannot enable it',()=>{
  for(const value of [undefined,'0','false','true','yes',1,true,' 1 '])assert.equal(externalStructureMainAdmissionEnabled({PAPER_EXTERNAL_STRUCTURE_MAIN_ADMISSION:value}),false);
  assert.equal(externalStructureMainAdmissionEnabled({PAPER_EXTERNAL_STRUCTURE_MAIN_ADMISSION:'1'}),true);
  assert.throws(()=>fill(row(),{externalStructureMainAdmission:'1'}),/explicitly boolean/);
});

for(const chain of ['bsc','sol','robinhood'])for(const route of ['external_breakout','external_pullback','external_trend']) {
  test(`explicit opt-in ${chain} ${route} preserves raw proof and all ledger checks`,()=>{
    const r=row(route,chain),before=structuredClone(r);assert.equal(r.decision,'可模拟');assert.equal(r.evidence.opportunity.id,route);
    const off=fill(r);assert.equal(off.trades.length,0);assert.equal(off.cash,100);
    assert.deepEqual(fill(r,{externalStructureMainAdmission:false}),off);
    const on=fill(r,{externalStructureMainAdmission:true});assert.equal(on.trades.length,1);assert.equal(on.cash,90);
    const e=on.trades[0].entryEvidence;assert.equal(e.chaseGate.mainAllowed,false);assert.equal(e.chaseGate.tier,'shadow_only');
    assert.equal(e.externalStructureMainAdmission.version,EXTERNAL_STRUCTURE_MAIN_ADMISSION_VERSION);
    assert.equal(e.externalStructureMainAdmission.allowed,true);assert.ok(e.externalStructureMainAdmission.closedBars>=24);
    assert.equal(e.structureValidation.ready,true);assert.equal(e.costGate.ready,true);assert.equal(e.lossRepair.ready,true);
    assert.equal(validatePaperStrategyAccount(on),true);assert.deepEqual(r,before);
    assert.equal(on.execution,false);assert.equal(on.signing,false);assert.equal(on.broadcast,false);
  });
}

test('opt-in cannot turn wrong routes, unsafe data, fake proofs or stale quotes into entries',()=>{
  const original=row();assert.equal(fill(original,{externalStructureMainAdmission:true}).trades.length,1);
  const changes=[
    ['event route',r=>{r.evidence.opportunity.id='monitored_event';r.evidence.opportunity.basis='monitored_event';}],
    ['internal route',r=>{r.evidence.marketStage='internal';}],
    ['attached event',r=>{r.evidence.opportunity.event={source:'test'};}],
    ['safety blocked',r=>r.evidence.safety.blocked.push('明确不可卖')],
    ['safety missing',r=>r.evidence.safety.missing.push('可卖出检测')],
    ['audit incomplete',r=>{r.evidence.safety.auditComplete=false;}],
    ['stale market',r=>{r.evidence.marketFresh=false;}],
    ['unpriced',r=>{r.evidence.priceFresh=false;}],
    ['13-bar proof',r=>{r.evidence.recoveryEntry.candles=r.evidence.recoveryEntry.candles.slice(-13);}],
    ['gap',r=>r.evidence.recoveryEntry.candles.splice(-5,1)],
    ['synthetic',r=>{r.evidence.recoveryEntry.candles.at(-1).synthetic=true;}],
    ['no-trade',r=>{r.evidence.recoveryEntry.candles.at(-1).noTrade=true;}],
    ['string synthetic marker',r=>{r.evidence.recoveryEntry.candles.at(-1).synthetic='true';}],
    ['synthetic source',r=>{r.evidence.recoveryEntry.candles.at(-1).source='synthetic';}],
    ['no quotes',r=>{r.evidence.recoveryEntry.quotes=[];}],
    ['stale quote',r=>{r.evidence.recoveryEntry.quotes.at(-1).observedAt=iso(NOW-6000);}],
    ['wrong CA',r=>{r.evidence.recoveryEntry.address='0x'+'b'.repeat(40);}],
    ['forged support',r=>{r.evidence.entryPlan.stopPrice=r.token.price*.999;}],
    ['forged target',r=>{r.evidence.entryPlan.targetPrice*=1.05;}],
    ['serialized costs no longer covered',r=>{r.evidence.costAssumptions.buyTax=.05;r.evidence.costAssumptions.sellTax=.05;}],
  ];
  for(const [label,change] of changes){const r=structuredClone(original);change(r);assert.equal(fill(r,{externalStructureMainAdmission:true}).trades.length,0,label);}
});

test('exception applies only to full original mode and cannot enlarge the risk budget',()=>{
  const r=row(),a=account(),repairReview=repairEntryReview(r,a,NOW,{estimatedFees:true});
  const context={enabled:true,account:a,nowMs:NOW,budget:10,repairReview,modes};
  assert.equal(reviewExternalStructureMainAdmission(r,context).allowed,true);
  for(const name of ['confirmedMode','continuousPaperMode','opportunityMode','opportunityReviewMode','memeExitMode','recoveryMode','lossRepairMode','estimatedFeeMode','evidenceTierGate'])
    assert.equal(reviewExternalStructureMainAdmission(r,{...context,modes:{...modes,[name]:false}}).allowed,false,name);
  for(const name of ['minimalEntryMode','diagnosticMode'])assert.equal(reviewExternalStructureMainAdmission(r,{...context,modes:{...modes,[name]:true}}).allowed,false,name);
  assert.equal(reviewExternalStructureMainAdmission(r,{...context,account:{...a,variant:'shadow'}}).allowed,false);
  assert.equal(reviewExternalStructureMainAdmission(r,{...context,budget:10.01}).allowed,false);
  assert.equal(reviewExternalStructureMainAdmission(r,{...context,account:{...a,cash:50},budget:6}).allowed,false);
  assert.equal(reviewExternalStructureMainAdmission(r,{...context,repairReview:{...repairReview,reentry:{ready:false}}}).allowed,false);
});

test('real runtime obtains structural quotes before the narrative gate; only explicit opt-in permits the final fill',async t=>{
  for(const enabled of [false,true]) {
    const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'external-main-runtime-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
    const session={schema:'yesp_atm_paper_session_v1',id:'confirmed-pvp-v2-optin-test',label:'估算费用独立模拟盘',mode:'paper',initialCash:100,
      strategyVersion:CONFIRMED_PAPER_VERSION,createdAt:iso(NOW),chain:'bsc',chains:['bsc'],costModel:ESTIMATED_COST_VERSION,
      legacy:{file:'yesp-atm-confirmed-pvp-v2-original.json',sha256:'0'.repeat(64),cash:100,realizedPnl:0,tradeCount:0}};
    await fs.writeFile(path.join(dataDir,'yesp-atm-'+session.id+'.json'),JSON.stringify({schema:'yesp_atm_runtime_v1',session,chain:'bsc',chains:['bsc'],enabled:true,account:account()}));
    const i=input();let at=NOW,quotes=0;
    const market={trending:async()=>({status:'ok',observedAt:iso(at),tokens:[i.token]}),kline:async args=>({...args,status:'ok',candles:i.candles}),
      quote:async args=>({...args,status:'ok',price:1.028+(++quotes)*.001,observedAt:iso(at)})};
    const runtime=createPaperStrategyRuntime({...modes,dataDir,session,chain:'bsc',market,now:()=>at,evidenceLoader:()=>({}),externalStructureMainAdmission:enabled});
    try {
      await runtime.runOnce();at+=5000;await runtime.runOnce();await runtime.fastOnce();
      for(let n=0;n<5&&runtime.snapshot().account.trades.length===0;n++){await runtime.refreshQuote();await runtime.fastOnce();at+=3000;}
      const state=runtime.snapshot();assert.ok(quotes>=2,'a no-narrative structural candidate still reaches real quote scheduling');
      assert.equal(state.externalStructureMainAdmission,enabled);assert.equal(state.account.trades.length,enabled?1:0,
        JSON.stringify(state.evaluations.map(e=>({reasons:e.reasons,missing:e.missing}))));
      if(enabled)assert.equal(state.account.trades[0].entryEvidence.externalStructureMainAdmission.allowed,true);
    }finally{await runtime.stop();}
  }
});
