import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {keccak256,toUtf8Bytes} from 'ethers';
import {fourPoolEvents} from './fixtures/four-pool-event.js';
import {strictFlapTrackedPoolTokenEvent} from './fixtures/paper-pool-event.js';
import {isStrictFlapTrackedPoolTokenUpdate,isStrictFourRegistryTrackedTokenUpdate} from '../src/source-controls.js';
import {loadPaperEvidence} from '../src/paper-strategy-evidence.js';
import {buildPoolFirstThreeWire} from '../src/paper-pool-signal.js';
import {poolEventProofIdentity} from '../src/launch-event-identity.js';

const NOW=Date.parse('2026-10-09T12:00:00Z'),iso=n=>new Date(n).toISOString();
const flap=()=>strictFlapTrackedPoolTokenEvent({blockTimestamp:iso(NOW-4000),observedAt:iso(NOW-1000)});
const signals=events=>buildPoolFirstThreeWire({events,nowMs:NOW}).signals;
const load=(state,entries={})=>loadPaperEvidence('/offline-projection',async file=>
  path.basename(file)==='four-registry-state.json'?state:path.basename(file)==='alert-outbox.json'?{events:entries}:null);
async function four(t){
  const fixture=await fourPoolEvents(t,{nowMs:NOW,count:1});
  const state=JSON.parse(await fs.readFile(path.join(fixture.dataDir,'four-registry-state.json'),'utf8'));
  return {...fixture,state,event:fixture.tokenEvents[0]};
}

test('one pool ordinal quarantines all immutable proof, pool and safety payload conflicts regardless of input order',()=>{
  const first=flap();
  const variants=[
    JSON.parse(JSON.stringify(first).replaceAll(first.transactionHash,'0x'+'aa'.repeat(32))),
    JSON.parse(JSON.stringify(first).replaceAll(first.pools[0].pool,'0x'+'bb'.repeat(20))),
    {...structuredClone(first),security:{...first.security,reasons:['a different safety verdict reason']}},
    {...structuredClone(first),blockTimestamp:iso(NOW-5000)},
  ];
  for(const other of variants){
    assert.equal(isStrictFlapTrackedPoolTokenUpdate(other),true);
    assert.notEqual(poolEventProofIdentity(first),poolEventProofIdentity(other));
    assert.equal(signals([first,other]).length,0);assert.equal(signals([other,first]).length,0);
  }
});

test('pool retry clocks, notification fields and object key ordering do not create a false proof conflict or renew verification',()=>{
  const first=flap(),retry=Object.fromEntries(Object.entries(structuredClone(first)).reverse());
  retry.observedAt=iso(NOW);retry.alertQueuedAt=iso(NOW);
  retry.canonicalSignalId='notification-id';retry.canonicalSignalIds=['notification-id'];
  assert.equal(isStrictFlapTrackedPoolTokenUpdate(retry),true);
  assert.equal(poolEventProofIdentity(first),poolEventProofIdentity(retry));
  for(const events of [[first,retry],[retry,first]]){
    const ready=signals(events);assert.equal(ready.length,1);
    assert.equal(ready[0].poolEvent.observedAt,first.observedAt);
  }
});

test('Four projection requires exact current producer ownership and works without a notification outbox',async t=>{
  const {state,event}=await four(t);
  const direct=await load(state);assert.equal(signals(direct.events).length,1);
  const projected=await load(state,{[event.eventKey]:{event,status:'delivered'}});
  assert.equal(signals(projected.events).length,1);
  for(const unavailable of [null,{}, {...state,version:0}]){
    const result=await load(unavailable,{[event.eventKey]:{event,status:'delivered'}});
    assert.equal(signals(result.events).length,0);
    assert.equal(result.launchSourceHealth.fourmeme.status,'unavailable');
  }
  const removed=structuredClone(state);delete removed.processedEvents[event.eventKey];
  assert.equal(signals((await load(removed,{[event.eventKey]:{event}})).events).length,0);
  const mismatch=structuredClone(state);mismatch.processedEvents[event.eventKey].blockHash='0x'+'a'.repeat(64);
  assert.equal(signals((await load(mismatch,{[event.eventKey]:{event}})).events).length,0);
});

test('Four retry-only clocks and their validated delivery digest do not change immutable canonical ownership',async t=>{
  const {state,event}=await four(t),retry=structuredClone(event);
  retry.observedAt=iso(NOW-500);retry.deliveryPolicy.firstObservedAt=retry.observedAt;
  const keys=['type','kind','eventKey','transactionHash','logIndex','blockNumber','blockHash','blockTimestamp',
    'sourceOccurredAt','observedAt','deliveryPolicy'];
  retry.deliveryEvidenceDigest=keccak256(toUtf8Bytes(JSON.stringify({
    ...Object.fromEntries(keys.map(key=>[key,retry[key]])),delayedRecovery:retry.delayedRecovery||null})));
  assert.equal(isStrictFourRegistryTrackedTokenUpdate(retry),true);
  assert.equal(poolEventProofIdentity(event),poolEventProofIdentity(retry));
  const evidence=await load(state,{retry:{event:retry}});
  const ready=signals(evidence.events);assert.equal(ready.length,1);
  assert.equal(ready[0].poolEvent.observedAt,retry.observedAt);
});

test('Four reorg cancellation and orphan tombstones veto all copies and remain vetoed after a fresh loader restart',async t=>{
  const {state,event}=await four(t);
  for(const field of ['fourRegistryCancellation','destinations','orphan']){
    const current=structuredClone(state),entry={event,status:'delivered'};
    if(field==='fourRegistryCancellation')entry.fourRegistryCancellation={reason:'canonical_reorg',eventId:event.eventKey,
      blockHash:event.blockHash,payloadDigest:event.payloadDigest};
    if(field==='destinations')entry.destinations={telegram:{status:'disabled',disabledReason:'four_registry_canonical_reorg'}};
    if(field==='orphan')current.orphanedDeliveredEvents['owner']={processedEvent:current.processedEvents[event.eventKey],
      recovery:{cancellationStatus:'delivered_orphaned'}};
    const copies={cancelled:entry,oldCopy:{event,status:'delivered'}};
    for(let restart=0;restart<2;restart++)assert.equal(signals((await load(current,copies)).events).length,0,field);
  }
});

test('Four queued canonical owner is admitted, but a stale main event from a different valid producer proof is not',async t=>{
  const {state,event}=await four(t),queued=structuredClone(state);
  delete queued.processedEvents[event.eventKey];
  queued.outbox.push({eventKey:event.eventKey,lifecycleKey:event.lifecycleKey,event,attempts:3,lastAttemptAt:iso(NOW)});
  assert.equal(signals((await load(queued,{[event.eventKey]:{event}})).events).length,1);
  const alternate=await fourPoolEvents(t,{nowMs:NOW,presetId:'888',count:1});
  const other=alternate.tokenEvents[0];
  const evidence=await load(state,{old:{event:other}});
  assert.ok(evidence.events.every(row=>(row.event||row).featureGenerationKey!==other.featureGenerationKey));
  assert.equal(signals(evidence.events).length,1);
});
