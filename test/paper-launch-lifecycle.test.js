import test from 'node:test';
import assert from 'node:assert/strict';
import {strictFlapConfigurationTokenEvent} from './fixtures/paper-pool-event.js';
import {PAPER_FLAP_LIFECYCLE,launchLifecycle} from '../src/paper-launch-lifecycle.js';
import {buildPoolFirstThreeWire} from '../src/paper-pool-signal.js';
const now=Date.parse('2026-10-09T12:00:00Z'),iso=n=>new Date(n).toISOString();
const fixture=()=>strictFlapConfigurationTokenEvent({blockTimestamp:iso(now-3000),observedAt:iso(now-1000)});
function lifecycle(e,action='disabled') {
  const a=e.featureActivationProof,tx='0x'+'e'.repeat(64),logIndex=7;
  return {type:PAPER_FLAP_LIFECYCLE,observedAt:iso(now),lifecycle:{version:1,action,
    quoteAddress:e.mode.quoteAsset,quoteName:'Test',quoteSymbol:e.mode.quoteSymbol,
    activationEventKey:`flap-quote:56:${tx}:${logIndex}`,transactionHash:tx,blockHash:'0x'+'f'.repeat(64),
    blockNumber:e.blockNumber+1,transactionIndex:0,logIndex,occurredAt:iso(now-500),
    proofType:action==='disabled'?'verified_disable':'verified_configuration_change',requiredConfirmations:3,monitorOnly:true,
    ...(action==='reconfigured'?{previousConfiguration:a.before,configuration:a.after,configurationLog:a.configurationLog}:{})}};
}
const wire=(events)=>buildPoolFirstThreeWire({events,nowMs:now}).signals;
test('canonical disable and newer configuration veto still-fresh old-generation tokens without TG',()=>{
  const e=fixture();assert.equal(wire([e]).length,1);
  for(const action of ['disabled','reconfigured']){
    const row=lifecycle(e,action);assert.ok(launchLifecycle(row));
    assert.equal(wire([e,row]).length,0);
    row.lifecycle.monitorOnly=false;assert.equal(wire([e,row]).length,1,'invalid lifecycle cannot veto');
  }
});
test('undo cancels its orphaned disable, not a canonical replacement at a different block hash',()=>{
  const e=fixture(),disabled=lifecycle(e),restored=structuredClone(disabled);
  Object.assign(restored.lifecycle,{action:'restored',proofType:'verified_disable_orphaned',
    targetActivationEventKey:e.featureTokenProof.activationEventKey});
  assert.ok(launchLifecycle(restored));assert.equal(wire([e,disabled,restored]).length,1);
  const replacement=structuredClone(disabled);replacement.lifecycle.blockHash='0x'+'a'.repeat(64);
  assert.equal(wire([e,disabled,restored,replacement]).length,0);
});
test('a reverted activation cannot leave its own token admissible',()=>{
  const e=fixture(),a=e.featureActivationProof,row=lifecycle(e);
  Object.assign(row.lifecycle,{action:'reverted',proofType:'verified_configuration_change_orphaned',
    activationEventKey:e.featureTokenProof.activationEventKey,transactionHash:a.transactionHash,
    blockHash:a.blockHash,blockNumber:a.blockNumber,transactionIndex:a.transactionIndex,logIndex:a.logIndex,
    targetActivationEventKey:null});
  assert.ok(launchLifecycle(row));assert.equal(wire([e,row]).length,0);
});
