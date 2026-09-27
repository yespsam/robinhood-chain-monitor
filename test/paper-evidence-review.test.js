import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyEntryEvidence,reviewEntryEvidence} from '../src/paper-evidence-review.js';
const NOW=Date.parse('2026-09-27T11:00:00Z'), CA=`0x${'1'.repeat(40)}`,url='https://x.com/example/status/123';
const entry=()=>({id:'buy',side:'buy',chain:'bsc',address:CA,atMs:NOW,costsUsd:.2,entryEvidence:{
  flowFresh:true,flow:{highProfitCount:0,uniqueBuyerCount:3,smartMoneyCount:3},
  flowDiagnostics:{complete:true,observedAt:NOW-1000,profileCheckedCount:0,sourceStatus:'healthy'},
  narrativeThesis:{chain:'bsc',address:CA,observedAt:NOW-5,relationship:{kind:'community_link'},
    event:{sourceUrl:url,sourceAt:NOW-10000},sources:[{url,at:NOW-10000,binding:'community_link'}]}}});
test('frozen community link is not direct endorsement; tags are not verified profit',()=>{
  assert.equal(classifyEntryEvidence(entry()).narrative,'community_link');
  assert.equal(classifyEntryEvidence(entry()).wallet,'tagged_only');
  const e=entry();e.entryEvidence.flow.highProfitCount=1;
  assert.equal(classifyEntryEvidence(e).wallet,'unknown');
  e.entryEvidence.flowDiagnostics.profileCheckedCount=1;assert.equal(classifyEntryEvidence(e).wallet,'verified_profit');
});
test('post-entry source, wrong CA, missing source and future observation do not backfill entry knowledge',()=>{
  for(const mutate of [t=>t.observedAt=NOW+1,t=>t.address=`0x${'2'.repeat(40)}`,t=>t.event.sourceAt=NOW+1,t=>t.sources=[],t=>t.sources[0].at=NOW+1]){
    const e=entry();mutate(e.entryEvidence.narrativeThesis);assert.equal(classifyEntryEvidence(e).narrative,'unverified');
  }
});
test('partial, stale, future, null and inconsistent wallet counts remain unknown rather than zero',()=>{
  for(const mutate of [e=>e.flowDiagnostics.sourceIssue='ambiguous_trade_legs',e=>e.flowDiagnostics.observedAt=NOW+1,
    e=>e.flowDiagnostics.observedAt=NOW-120001,e=>e.flow.highProfitCount=null,e=>e.flow.uniqueBuyerCount=1,e=>e.flowFresh=false]){
    const e=entry();mutate(e.entryEvidence);assert.equal(classifyEntryEvidence(e).wallet,'unknown');
  }
  const e=entry();Object.assign(e.entryEvidence.flow,{uniqueBuyerCount:0,smartMoneyCount:0});
  assert.equal(classifyEntryEvidence(e).wallet,'no_buyers');
});
test('only completed rounds are described, costs counted once; unknown costs remain null and inputs unchanged',()=>{
  const r={entry:entry(),exits:[{costsUsd:.1}],at:NOW+1000,pnl:-2},before=structuredClone(r);
  const report=reviewEntryEvidence([r,{...r,at:NOW+999999}],NOW+2000),g=report.groups[0];
  assert.equal(g.closedRounds,1);assert.equal(g.netPnlUsd,-2);assert.ok(Math.abs(g.modelCostsUsd-.3)<1e-9);
  assert.ok(Math.abs(g.grossPricePnlUsd+1.7)<1e-9);assert.deepEqual(r,before);
  delete r.exits[0].costsUsd;assert.equal(reviewEntryEvidence([r],NOW+2000).groups[0].modelCostsUsd,null);
});
test('different policy, cost and provider cohorts do not mix',()=>{
  const first={entry:entry(),exits:[{costsUsd:.1}],at:NOW+1000,pnl:-2};
  const rounds=[first];
  for(const change of [e=>e.entryPolicyVersion='new',e=>e.memeExitPolicy={version:'new_exit'},
    e=>e.costAssumptions={version:'new_cost'},e=>e.flowDiagnostics.provider='other']){
    const r=structuredClone(first);change(r.entry.entryEvidence);rounds.push(r);
  }
  assert.equal(reviewEntryEvidence(rounds,NOW+2000).groups.length,5);
});
