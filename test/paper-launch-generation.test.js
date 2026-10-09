import test from 'node:test';
import assert from 'node:assert/strict';
import {fourPoolEvents} from './fixtures/four-pool-event.js';
import {strictFlapConfigurationTokenEvent,strictFlapTrackedPoolTokenEvent} from './fixtures/paper-pool-event.js';
import {buildPoolFirstThreeWire,validPoolSignal,poolEntryAllowed} from '../src/paper-pool-signal.js';
import {isStrictFlapTrackedPoolTokenUpdate} from '../src/source-controls.js';

const NOW=Date.parse('2026-10-09T12:00:00Z'),iso=x=>new Date(x).toISOString();
const flap=()=>strictFlapConfigurationTokenEvent({blockTimestamp:iso(NOW-2000),observedAt:iso(NOW)});

test('real Four producer first three reach the paper adapter without a fabricated DEX pair',async t=>{
  const fixture=await fourPoolEvents(t,{nowMs:NOW,count:4});
  const wire=buildPoolFirstThreeWire({events:fixture.events,nowMs:NOW});
  assert.equal(wire.signals.length,3);
  assert.deepEqual(wire.signals.map(s=>s.pool.ordinal),[1,2,3]);
  for(const s of wire.signals){
    assert.equal(s.pool.platform,'fourmeme');assert.equal(s.pool.poolAddress,null);
    assert.equal(validPoolSignal(s,s,NOW),true);assert.equal(s.poolEvent.automaticExecution,false);
    assert.match(s.text,/不代表安全/);
    assert.equal(poolEntryAllowed(s,{trades:[{side:'buy',chain:'bsc',address:s.address,entryEvidence:{opportunity:{event:s}}}]},NOW),false);
  }
  assert.equal(buildPoolFirstThreeWire({events:fixture.events,nowMs:NOW+120001}).signals.length,0);
});

test('Four identity, ordinal and nested activation proof mutations fail closed',async t=>{
  const {tokenEvents}=await fourPoolEvents(t,{nowMs:NOW});
  for(const mutate of [e=>e.featureTokenOrdinal=4,e=>e.featureTokenProof.priorTokens=[],
    e=>e.featureTokenProof.activationEvent.transactionHash='0x'+'f'.repeat(64),e=>e.featureGenerationKey+='forged',
    e=>e.token.address='0x'+'a'.repeat(40),e=>e.featureTokenProof.presetBinding.preset.id='9']){
    const e=structuredClone(tokenEvents[1]);mutate(e);
    assert.equal(buildPoolFirstThreeWire({events:[e],nowMs:NOW}).signals.length,0,mutate.toString());
  }
});

test('verified Flap configuration changes have their own three slots; repeats of identical configuration cannot reset them',()=>{
  const e=flap();assert.equal(isStrictFlapTrackedPoolTokenUpdate(e),true);
  const first=buildPoolFirstThreeWire({events:[e],nowMs:NOW}).signals[0];assert.ok(first);
  const account={trades:[{side:'buy',chain:'bsc',address:first.address,entryEvidence:{opportunity:{event:first}}}]};
  const duplicate=JSON.parse(JSON.stringify(e).replaceAll(e.tokens[0].token,'0x'+'a'.repeat(40)));
  assert.equal(isStrictFlapTrackedPoolTokenUpdate(duplicate),true);
  assert.equal(buildPoolFirstThreeWire({events:[duplicate],account,nowMs:NOW}).signals.length,0,'same configuration rank stays consumed');
  duplicate.featureActivationProof.after.defaultCurve+=1;
  assert.equal(isStrictFlapTrackedPoolTokenUpdate(duplicate),false,'configuration must match the producer raw log');
  const changed=strictFlapConfigurationTokenEvent({blockTimestamp:iso(NOW-2000),observedAt:iso(NOW),
    configurationAfter:{defaultCurve:34}});
  const next=JSON.parse(JSON.stringify(changed).replaceAll(changed.tokens[0].token,'0x'+'b'.repeat(40)));
  assert.equal(buildPoolFirstThreeWire({events:[next],account,nowMs:NOW}).signals.length,1,'a different verified mechanism is independent');
  // The legacy quote lifetime constraint remains for unproven reactivations.
  const legacy=strictFlapTrackedPoolTokenEvent({blockTimestamp:iso(NOW-2000),observedAt:iso(NOW)});
  assert.equal(buildPoolFirstThreeWire({events:[legacy],nowMs:NOW}).signals.length,1);
});
