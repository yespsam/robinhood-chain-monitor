import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPaperLaunchEvidenceWriter,LAUNCH_EVIDENCE_FILE} from '../src/paper-launch-evidence.js';
import {createPaperEvidenceLoader} from '../src/paper-strategy-evidence.js';
import {buildPoolFirstThreeWire} from '../src/paper-pool-signal.js';
import {strictFlapTrackedPoolTokenEvent} from './fixtures/paper-pool-event.js';
import {launchEventDigest} from '../src/launch-event-identity.js';

const now=Date.parse('2026-10-09T12:00:00Z');
const fixture=()=>strictFlapTrackedPoolTokenEvent({blockTimestamp:new Date(now-4000).toISOString(),observedAt:new Date(now-1000).toISOString()});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'launch-evidence-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const ownership=e=>({schema:'paper_flap_canonical_v1',version:1,source:'bsc-launchpad-monitor',status:'ready',
  windows:{[e.featureGenerationKey]:{generationKey:e.featureGenerationKey,quoteAddress:e.mode.quoteAsset,active:true,
    slots:[{eventKey:e.eventKey,ordinal:e.featureTokenOrdinal,tokenAddress:e.tokens[0].token,
      ...Object.fromEntries(['transactionHash','blockHash','blockNumber','transactionIndex','logIndex'].map(k=>[k,e[k]])),
      proofDigest:launchEventDigest(e)}]}}});

test('canonical launch research remains available when the notification outbox exceeds its read budget',async t=>{
  const dir=await temp(t),record=createPaperLaunchEvidenceWriter(dir,{now:()=>now}),e=fixture();
  const huge=await fs.open(path.join(dir,'alert-outbox.json'),'w');await huge.truncate(17*1024*1024);await huge.close();
  await record(e);
  await fs.writeFile(path.join(dir,'paper-flap-canonical-state.json'),JSON.stringify(ownership(e)));
  const evidence=await createPaperEvidenceLoader(dir)();
  assert.equal(evidence.launchSourceHealth.mainOutbox.status,'unavailable_or_oversized');
  assert.equal(evidence.launchSourceHealth.flapProjection.status,'available');
  const wire=buildPoolFirstThreeWire({events:evidence.events,nowMs:now});
  assert.equal(wire.signals.length,1);assert.equal(wire.signals[0].address,e.tokens[0].token);
});

test('Flap orphan/missing/updating ownership cannot be resurrected from the compact notification feed',async t=>{
  const dir=await temp(t),record=createPaperLaunchEvidenceWriter(dir,{now:()=>now}),e=fixture(),load=createPaperEvidenceLoader(dir);
  await record(e);
  const count=async()=>buildPoolFirstThreeWire({events:(await load()).events,nowMs:now}).signals.length;
  assert.equal(await count(),0);
  const file=path.join(dir,'paper-flap-canonical-state.json');
  await fs.writeFile(file,JSON.stringify(ownership(e)));assert.equal(await count(),1);
  for(const change of [s=>s.status='updating',s=>s.windows={},
    s=>s.windows[e.featureGenerationKey].active=false,
    s=>s.windows[e.featureGenerationKey].slots[0].proofDigest='forged']){
    const state=ownership(e);change(state);await fs.writeFile(file,JSON.stringify(state));assert.equal(await count(),0);
  }
});

test('projection capacity coverage gap remains visible through retries until the entry window expires',async t=>{
  const dir=await temp(t),e=fixture();let clock=now;
  const record=createPaperLaunchEvidenceWriter(dir,{now:()=>clock}),file=path.join(dir,LAUNCH_EVIDENCE_FILE);
  await record(e);const state=JSON.parse(await fs.readFile(file,'utf8'));
  state.events=Array.from({length:257},()=>e);await fs.writeFile(file,JSON.stringify(state));
  await record(e);const clipped=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(clipped.coverage.complete,false);assert.equal(clipped.coverage.dropped,1);
  clock+=1000;await record(e);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).coverage.complete,false);
  clock+=120001;await record(e);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).coverage.complete,true);
});

test('concurrent producers/retries cannot lose an event or refresh its event time',async t=>{
  const dir=await temp(t),record=createPaperLaunchEvidenceWriter(dir,{now:()=>now}),one=fixture();
  const two=JSON.parse(JSON.stringify(one).replaceAll(one.tokens[0].token,'0x'+'6'.repeat(40)));
  await Promise.all([record(one),record(two),record(one)]);
  const state=JSON.parse(await fs.readFile(path.join(dir,LAUNCH_EVIDENCE_FILE),'utf8'));
  assert.equal(state.events.length,2);assert.equal(state.events[0].observedAt,one.observedAt);
  assert.equal(buildPoolFirstThreeWire({events:state.events,nowMs:now}).signals.length,0,'conflicting rank must not become last-write-wins');
});

test('generic platform announcements and unsafe forged token proofs never enter the narrow projection',async t=>{
  const dir=await temp(t),record=createPaperLaunchEvidenceWriter(dir,{now:()=>now});
  assert.equal(await record({type:'platform_capability_update',platform:{id:'flap'},text:'new template'}),false);
  const e=fixture();e.featureTokenProof.canonical=false;assert.equal(await record(e),false);
  await assert.rejects(fs.stat(path.join(dir,LAUNCH_EVIDENCE_FILE)),{code:'ENOENT'});
});

test('canonical Four producer rows can bypass a missing notification outbox without loading orphan history',async t=>{
  const dir=await temp(t),row={event:{eventKey:'canonical-placeholder'}};
  await fs.writeFile(path.join(dir,'four-registry-state.json'),JSON.stringify({updatedAt:new Date(now).toISOString(),
    processedEvents:{a:row},outbox:[],orphanedDeliveredEvents:{orphan:{event:{eventKey:'orphan'}}}}));
  const evidence=await createPaperEvidenceLoader(dir)();
  assert.deepEqual(evidence.events,[row]);
  assert.equal(buildPoolFirstThreeWire({events:evidence.events,nowMs:now}).signals.length,0,'loading is not validation');
});
